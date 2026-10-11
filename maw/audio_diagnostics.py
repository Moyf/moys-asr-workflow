"""Bounded, local audio evidence after an empty transcription.

Signal levels cannot determine whether speech is present or intelligible.
Never change the selected track or submit another recognition request here.
"""

from __future__ import annotations

import math
import re
import subprocess
import time
from collections.abc import Mapping
from pathlib import Path
from threading import Event

from maw.ffmpeg import resolve_ffmpeg_tools
from maw.gui_platform import popen_process_tree, process_group_kwargs, release_process_tree, terminate_process_tree
from maw.media import probe_audio_tracks

_DIAGNOSTIC_BUDGET_SECONDS = 6.0
_TRACK_BUDGET_SECONDS = 3.0


class AudioInputError(RuntimeError):
    """An empty result with a non-secret, evidence-based Launcher code."""

    def __init__(self, code: str, detail: str) -> None:
        self.code = code
        super().__init__(detail)


def _final_failure(output: list[str]) -> str:
    """Ignore earlier retry failures when a later exception has another cause."""
    final = "\n".join(output[-40:])
    failures = list(re.finditer(r"^(?:[\w.]+(?:Error|Exception):|错误[:：])", final, re.MULTILINE))
    return final[failures[-1].start():] if failures else final


def is_empty_transcription_error(output: list[str]) -> bool:
    return _final_failure(output).startswith((
        "RuntimeError: ASR 返回内容为空，未生成字幕段。",
        "错误: 本地模型没有返回可用的转写文本",
        "错误: 未识别到任何内容",
    ))


def is_audio_mapping_error(output: list[str]) -> bool:
    final = _final_failure(output)
    return bool(re.match(r"Stream map ['\"]?0:a:\d+['\"]? matches no streams", final)) or (
        re.match(r"(?:[\w.]+\.)?CalledProcessError:", final) is not None and "-map" in final and "0:a:" in final
    )


def _analysis_seconds(length_limit: str) -> float | None:
    """Use the ASR range, or EOF for an unrestricted run; never just the intro."""
    match = re.fullmatch(r"([\d.]+)\s*([hms])?", length_limit.strip().lower())
    if not match:
        return None
    try:
        seconds = float(match[1]) * {"h": 3600, "m": 60, "s": 1, None: 1}[match[2]]
    except ValueError:
        return None
    return seconds if math.isfinite(seconds) and seconds > 0 else None


def _measure_peak(
    source: Path, track: int, executable: Path, seconds: float | None,
    deadline: float, cancel_event: Event | None,
    *, start_seconds: float = 0,
) -> float | None:
    """Return evidence only after decoding the entire requested audio range.

    A timed-out partial scan cannot establish quiet or a track mismatch.
    Measure all channels without a mono downmix that could cancel audio.
    """
    if time.monotonic() >= deadline or (cancel_event and cancel_event.is_set()):
        return None
    process = None
    try:
        process = popen_process_tree([
            str(executable), "-nostdin", "-hide_banner", "-nostats", "-v", "info", "-xerror",
            "-threads", "1", *(["-ss", str(start_seconds)] if start_seconds else []),
            "-i", str(source), "-map", f"0:a:{track}",
            *(["-t", str(seconds)] if seconds is not None else []),
            "-vn", "-sn", "-dn", "-af",
            "astats=measure_perchannel=none:measure_overall=Peak_level+Number_of_samples:reset=0",
            "-f", "null", "-",
        ], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            **process_group_kwargs())
        track_deadline = min(deadline, time.monotonic() + _TRACK_BUDGET_SECONDS)
        while True:
            if time.monotonic() >= track_deadline or (cancel_event and cancel_event.is_set()):
                return None
            try:
                _, stderr = process.communicate(timeout=0.1)
                break
            except subprocess.TimeoutExpired:
                continue
        if process.returncode != 0:
            return None
        text = stderr.decode("utf-8", errors="replace")
        samples = re.findall(r"Number of samples:\s*([\d.]+)", text)
        peaks = re.findall(r"Peak level dB:\s*(-?inf|[-+\d.]+)", text)
        if not samples or float(samples[-1]) <= 0 or not peaks:
            return None
        peak = float(peaks[-1])
        return peak if math.isfinite(peak) or peak == -math.inf else None
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    finally:
        if process is not None:
            try:
                if process.poll() is None:
                    terminate_process_tree(process, timeout=1)
            except (OSError, subprocess.SubprocessError):
                # Diagnostics must not replace the original empty-result error.
                try:
                    process.kill()
                    process.wait(timeout=1)
                except (OSError, subprocess.SubprocessError):
                    pass
            finally:
                release_process_tree(process)


def diagnose_empty_audio(
    source: Path, audio_track: int, *, length_limit: str = "",
    environment: Mapping[str, str] | None = None, cancel_event: Event | None = None,
    detail: str = "ASR returned no usable subtitle text.",
) -> AudioInputError:
    """Probe tracks, then check the ASR range (or EOF) within a time budget.

    Probe timeout is 2s; all checks share 6s, each decode gets at most 3s.
    Termination may add up to 1s for the owned process to exit.
    Incomplete scans remain inconclusive, never extrapolate introductory silence.
    """
    fallback = AudioInputError("asr_empty_result", detail + "\n[audio check] unavailable; speech/noise not determined")
    if cancel_event and cancel_event.is_set():
        return fallback
    deadline = time.monotonic() + _DIAGNOSTIC_BUDGET_SECONDS
    try:
        tools = resolve_ffmpeg_tools(environment=environment, search_path=(environment or {}).get("PATH"))
        tracks = probe_audio_tracks(source, ffprobe_path=tools.ffprobe, timeout=2, include_duration=True) if tools.ffprobe else None
    except (OSError, ValueError):
        return fallback
    if tracks is None:
        return fallback
    context = f"\n[audio check] tracks={len(tracks)}, selected audio_index={audio_track} (zero-based)"
    if not tracks:
        return AudioInputError("audio_tracks_missing", detail + context)
    if not any(track["audio_index"] == audio_track for track in tracks):
        return AudioInputError("audio_track_invalid", detail + context)
    if tools.ffmpeg is None:
        return AudioInputError("asr_empty_result", detail + context + "; signal check unavailable")
    seconds = _analysis_seconds(length_limit)
    selected = next(track for track in tracks if track["audio_index"] == audio_track)
    duration = selected.get("media_duration_seconds")
    duration = min(duration, seconds) if duration is not None and seconds is not None else duration
    # Avoid full decoding of long recordings: a few seeked windows have fixed cost.
    sampled = duration is not None and duration > 600
    peak = None if sampled else _measure_peak(source, audio_track, tools.ffmpeg, seconds, deadline, cancel_event)
    scope = f"first up to {seconds:g}s" if seconds is not None else "entire selected track"
    context += f", requested range={scope}, scan_complete={peak is not None}, peak_dBFS={peak}; speech/noise not determined"
    if peak is None and duration is not None:
        quiet_samples = True
        window = min(3.0, duration / 3)
        starts = (0.0, (duration - window) / 2, duration - window)
        for start in starts:
            sample = _measure_peak(source, audio_track, tools.ffmpeg, window, deadline, cancel_event, start_seconds=start)
            context += f"; sample={start:g}..{start + window:g}s peak_dBFS={sample}"
            if sample is None or sample > -60:
                quiet_samples = False
                break
        if quiet_samples:
            return AudioInputError("asr_audio_sample_quiet", detail + context + "; other tracks not checked")
    if peak is None or peak > -60:
        return AudioInputError("asr_empty_result", detail + context)
    # Only call all tracks quiet when every track's full ASR range was checked.
    all_quiet = True
    incomplete = []
    for track in tracks:
        index = track["audio_index"]
        if index == audio_track:
            continue
        if time.monotonic() >= deadline or (cancel_event and cancel_event.is_set()):
            incomplete.append(index)
            continue
        other = _measure_peak(source, index, tools.ffmpeg, seconds, deadline, cancel_event)
        context += f"; audio_index={index} peak_dBFS={other}"
        if other is not None and other > -45:
            return AudioInputError("asr_audio_track_mismatch", detail + context)
        if other is None:
            incomplete.append(index)
        elif other > -60:
            all_quiet = False
    context += f"; incomplete audio_indices={incomplete}"
    if len(tracks) > 1 and all_quiet and not incomplete:
        return AudioInputError("asr_audio_all_quiet", detail + context)
    return AudioInputError("asr_audio_quiet", detail + context)
