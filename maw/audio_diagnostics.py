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


class AudioInputError(RuntimeError):
    """An empty result with a non-secret, evidence-based Launcher code."""

    def __init__(self, code: str, detail: str) -> None:
        self.code = code
        super().__init__(detail)


def is_empty_transcription_error(output: list[str]) -> bool:
    # Match final failures, never upload credentials or an earlier retry warning.
    final = "\n".join(output[-40:])
    failures = list(re.finditer(r"^(?:[\w.]+(?:Error|Exception):|错误[:：])", final, re.MULTILINE))
    if not failures:
        return False
    final = final[failures[-1].start():]
    return any(marker in final for marker in (
        "RuntimeError: ASR 返回内容为空，未生成字幕段。",
        "错误: 本地模型没有返回可用的转写文本",
        "错误: 未识别到任何内容",
    ))


def is_audio_mapping_error(output: list[str]) -> bool:
    final = "\n".join(output[-40:])
    return bool(re.search(r"Stream map ['\"]?0:a:\d+['\"]? matches no streams", final)) or (
        "CalledProcessError:" in final and "-map" in final and "0:a:" in final
    )


def _analysis_seconds(length_limit: str) -> float:
    match = re.fullmatch(r"([\d.]+)\s*([hms])?", length_limit.strip().lower())
    if not match:
        return 60.0
    try:
        seconds = float(match[1]) * {"h": 3600, "m": 60, "s": 1, None: 1}[match[2]]
    except ValueError:
        return 60.0
    return min(60.0, seconds) if math.isfinite(seconds) and seconds > 0 else 60.0


def _measure_peak(
    source: Path, track: int, executable: Path, seconds: float,
    deadline: float, cancel_event: Event | None,
) -> float | None:
    """Measure all channels without a mono downmix that could cancel audio."""
    if time.monotonic() >= deadline or (cancel_event and cancel_event.is_set()):
        return None
    process = None
    try:
        process = popen_process_tree([
            str(executable), "-nostdin", "-hide_banner", "-nostats", "-v", "info",
            "-i", str(source), "-map", f"0:a:{track}", "-t", str(seconds),
            "-vn", "-sn", "-dn", "-af",
            "astats=measure_perchannel=none:measure_overall=Peak_level+Number_of_samples:reset=0",
            "-f", "null", "-",
        ], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            **process_group_kwargs())
        track_deadline = min(deadline, time.monotonic() + 8)
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
        return peak if not math.isnan(peak) and peak <= 0 else None
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
    """Probe tracks, then at most four tracks' first 60s within a time budget.

    FFprobe has its existing 10s timeout. Signal checks share a 20s budget.
    Quiet only describes the checked interval, never the whole recording.
    """
    fallback = AudioInputError("asr_empty_result", detail + "\n[audio check] unavailable; speech/noise not determined")
    if cancel_event and cancel_event.is_set():
        return fallback
    try:
        tools = resolve_ffmpeg_tools(environment=environment, search_path=(environment or {}).get("PATH"))
        tracks = probe_audio_tracks(source, ffprobe_path=tools.ffprobe) if tools.ffprobe else None
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
    deadline = time.monotonic() + 20
    peak = _measure_peak(source, audio_track, tools.ffmpeg, seconds, deadline, cancel_event)
    context += f", checked first up to {seconds:g}s, peak_dBFS={peak}; speech/noise not determined"
    if peak is None or peak > -60:
        return AudioInputError("asr_empty_result", detail + context)
    checked = 0
    for track in tracks:
        index = track["audio_index"]
        if index == audio_track:
            continue
        if checked == 3 or time.monotonic() >= deadline or (cancel_event and cancel_event.is_set()):
            break
        checked += 1
        other = _measure_peak(source, index, tools.ffmpeg, seconds, deadline, cancel_event)
        context += f"; audio_index={index} peak_dBFS={other}"
        if other is not None and other > -45:
            return AudioInputError("asr_audio_track_mismatch", detail + context)
    return AudioInputError("asr_audio_quiet", detail + context)
