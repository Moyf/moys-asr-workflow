# pyright: reportAny=false, reportExplicitAny=false, reportMissingTypeArgument=false, reportOptionalSubscript=false, reportReturnType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUnusedCallResult=false

"""Compact, streaming waveform peak extraction for the subtitle editor.

The browser UI consumes a small min/max envelope instead of decoded PCM.  The
format deliberately uses only JSON-compatible values so it can travel with an
editor project and later be reused by a desktop shell.
"""

from __future__ import annotations

import base64
import math
import struct
import subprocess
import sys
from array import array
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from maw.ffmpeg import resolve_ffmpeg_tool


WAVEFORM_SCHEMA = "moy.asr.waveform.v1"
WAVEFORM_ENCODING = "i8-minmax-base64"
DEFAULT_PEAKS_PER_SECOND = 100
WaveformProgressCallback = Callable[[str], None]


class WaveformError(RuntimeError):
    """Raised when a media file cannot be converted to waveform peaks."""


@dataclass(frozen=True, slots=True)
class EmbeddedWaveformResult:
    project: dict[str, Any]
    error: Exception | None = None


def media_signature(media_path: Path) -> dict[str, int | str]:
    """Return a browser-compatible signature used to invalidate stale peaks."""
    stat = media_path.stat()
    return {
        "name": media_path.name,
        "size": stat.st_size,
        "modified_ms": stat.st_mtime_ns // 1_000_000,
    }


def _is_positive_number(value: Any) -> bool:
    """True for a real int/float count. bool is rejected despite being an int."""
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
        and value > 0
    )


def waveform_peaks_per_second(payload: Any) -> float:
    """Return the authoritative bin rate (peaks per second of audio).

    ``peaks_per_second`` is a display-friendly approximation.  For caches
    derived from ``.ReaPeaks`` the real rate is ``sample_rate / division``,
    which is fractional for most sample rates (16 kHz with ``div=53`` is
    301.8868, not 302).  Any geometry that maps a peak index to a timestamp
    must use this function, otherwise the rounding error scales the whole time
    axis and the drift grows linearly with the media length.
    """
    if not isinstance(payload, dict):
        return 0.0
    sample_rate = payload.get("sample_rate")
    division = payload.get("division")
    has_sample_rate = sample_rate is not None
    has_division = division is not None
    if has_sample_rate != has_division:
        return 0.0
    if has_sample_rate:
        if (
            _is_positive_number(sample_rate)
            and isinstance(division, int)
            and not isinstance(division, bool)
            and division > 0
        ):
            return sample_rate / division
        return 0.0
    peaks_per_second = payload.get("peaks_per_second")
    return float(peaks_per_second) if _is_positive_number(peaks_per_second) else 0.0


def is_waveform_payload(value: Any) -> bool:
    """Check the cheap structural invariants of a cached waveform payload."""
    if not isinstance(value, dict):
        return False
    if value.get("schema") != WAVEFORM_SCHEMA:
        return False
    if value.get("encoding") != WAVEFORM_ENCODING:
        return False
    if not isinstance(value.get("data"), str):
        return False
    peak_count = value.get("peak_count")
    peaks_per_second = value.get("peaks_per_second")
    duration_ms = value.get("duration_ms")
    if not (
        isinstance(peak_count, int)
        and not isinstance(peak_count, bool)
        and peak_count >= 0
        and _is_positive_number(peaks_per_second)
        and isinstance(duration_ms, int)
        and not isinstance(duration_ms, bool)
        and duration_ms >= 0
    ):
        return False
    # The exact-rate pair is optional (older payloads only carry the rounded
    # peaks_per_second), but when present it must be usable as a ratio.
    sample_rate = value.get("sample_rate")
    division = value.get("division")
    if sample_rate is None and division is None:
        return True
    return (
        _is_positive_number(sample_rate)
        and isinstance(division, int)
        and not isinstance(division, bool)
        and division > 0
    )


def audio_track_from_payloads(*payloads: Any) -> int:
    """Return the first valid logical audio-track number from cache payloads."""
    for payload in payloads:
        if not isinstance(payload, dict):
            continue
        value = payload.get("audio_track")
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            return value
    return 0


def waveform_matches_media(
    value: Any,
    media_path: Path,
    *,
    audio_track: int | None = None,
) -> bool:
    """Return true when a valid payload was derived from this exact file."""
    if not is_waveform_payload(value):
        return False
    if audio_track is not None and audio_track_from_payloads(value) != audio_track:
        return False
    return value.get("source") == media_signature(media_path)


def parse_ffmpeg_wav_header(header: bytes) -> tuple[int, int, int] | None:
    """Return (channels, sample_rate, data_offset) from an FFmpeg WAV pipe."""
    if len(header) < 12 or header[:4] != b"RIFF" or header[8:12] != b"WAVE":
        return None
    channels = 0
    sample_rate = 0
    offset = 12
    while offset + 8 <= len(header):
        chunk_id = header[offset : offset + 4]
        size = struct.unpack_from("<I", header, offset + 4)[0]
        if chunk_id == b"fmt ":
            if offset + 16 > len(header):
                return None
            channels = struct.unpack_from("<H", header, offset + 10)[0]
            sample_rate = struct.unpack_from("<I", header, offset + 12)[0]
        elif chunk_id == b"data":
            if channels <= 0 or sample_rate <= 0:
                return None
            return channels, sample_rate, offset + 8
        offset += 8 + size + (size & 1)
    return None


def _quantize_sample(value: int) -> int:
    scaled = round(value * 127 / 32768)
    return max(-127, min(127, scaled))


def _append_bucket(output: bytearray, samples: array) -> None:
    if not samples:
        return
    low = _quantize_sample(min(samples))
    high = _quantize_sample(max(samples))
    output.extend((low & 0xFF, high & 0xFF))


def extract_waveform(
    media_path: Path,
    *,
    peaks_per_second: int = DEFAULT_PEAKS_PER_SECOND,
    pcm_sample_rate: int | None = None,
    preserve_channels: bool = True,
    ffmpeg_bin: str | None = None,
    audio_track: int = 0,
) -> dict[str, Any]:
    """Stream a low-rate PCM envelope without retaining decoded audio.

    At the default 100 peaks/second, three hours of audio produces about
    2.9 MiB of base64 data while extraction memory remains effectively flat.
    The legacy mono path remains available for comparisons.
    """
    media_path = Path(media_path).resolve()
    if not media_path.is_file():
        raise WaveformError(f"媒体文件不存在: {media_path}")
    if not isinstance(audio_track, int) or isinstance(audio_track, bool) or audio_track < 0:
        raise ValueError("audio_track must be a non-negative integer")
    if peaks_per_second <= 0:
        raise ValueError("peaks_per_second must be positive")
    if pcm_sample_rate is None:
        pcm_sample_rate = peaks_per_second * 10
    if pcm_sample_rate < peaks_per_second:
        raise ValueError("pcm_sample_rate must be >= peaks_per_second")

    ffmpeg = resolve_ffmpeg_tool(
        "ffmpeg",
        ffmpeg_bin,
        allow_missing_explicit=bool(ffmpeg_bin),
    )
    if not ffmpeg:
        raise WaveformError("找不到 ffmpeg，无法预生成波形")

    command = [
        ffmpeg,
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(media_path),
        "-map",
        f"0:a:{audio_track}",
        "-vn",
    ]
    if preserve_channels:
        command.extend(
            ("-ar", str(pcm_sample_rate), "-acodec", "pcm_s16le", "-f", "wav", "pipe:1")
        )
    else:
        command.extend(
            ("-ac", "1", "-ar", str(pcm_sample_rate), "-f", "s16le", "pipe:1")
        )
    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except OSError as exc:
        raise WaveformError(f"无法启动 ffmpeg: {exc}") from exc

    assert process.stdout is not None
    assert process.stderr is not None
    if preserve_channels:
        header = process.stdout.read(4096)
        parsed = parse_ffmpeg_wav_header(header)
        if parsed is None:
            if process.poll() is None:
                process.kill()
            process.wait()
            stderr = process.stderr.read().decode("utf-8", errors="replace").strip()
            process.stdout.close()
            process.stderr.close()
            raise WaveformError(stderr or "FFmpeg 返回的 WAV 头无法解析")
        channels, sample_rate, data_offset = parsed
        first_chunk = header[data_offset:]
    else:
        channels, sample_rate = 1, pcm_sample_rate
        first_chunk = b""
    bucket_frames = max(1, round(sample_rate / peaks_per_second))
    bucket_samples = bucket_frames * channels
    actual_peaks_per_second = round(sample_rate / bucket_frames)
    frame_bytes = channels * 2
    encoded = bytearray()
    byte_carry = b""
    sample_carry = array("h")
    total_frames = 0

    chunk = first_chunk
    while True:
        if not chunk:
            chunk = process.stdout.read(64 * 1024)
        if not chunk:
            break
        raw = byte_carry + chunk
        complete_bytes = len(raw) - (len(raw) % frame_bytes)
        byte_carry = raw[complete_bytes:]
        values = array("h")
        values.frombytes(raw[:complete_bytes])
        if sys.byteorder != "little":
            values.byteswap()
        total_frames += len(values) // channels
        if sample_carry:
            sample_carry.extend(values)
            values = sample_carry
        complete_length = (len(values) // bucket_samples) * bucket_samples
        for offset in range(0, complete_length, bucket_samples):
            _append_bucket(encoded, values[offset : offset + bucket_samples])
        sample_carry = array("h", values[complete_length:])
        chunk = b""

    if sample_carry:
        _append_bucket(encoded, sample_carry)

    stderr = process.stderr.read().decode("utf-8", errors="replace").strip()
    process.stdout.close()
    process.stderr.close()
    return_code = process.wait()
    if return_code != 0:
        raise WaveformError(stderr or f"ffmpeg 退出码 {return_code}")
    if byte_carry:
        raise WaveformError("ffmpeg 返回了不完整的 PCM 数据")

    peak_count = len(encoded) // 2
    duration_ms = round(total_frames * 1000 / sample_rate)
    return {
        "schema": WAVEFORM_SCHEMA,
        "encoding": WAVEFORM_ENCODING,
        "peaks_per_second": actual_peaks_per_second,
        # bin i covers [i * division / sample_rate, (i + 1) * ...): the exact
        # pair, so consumers never have to rely on the rounded rate above.
        "sample_rate": sample_rate,
        "division": bucket_frames,
        "peak_count": peak_count,
        "duration_ms": duration_ms,
        "data": base64.b64encode(encoded).decode("ascii"),
        "audio_track": audio_track,
        "source": media_signature(media_path),
    }


def embed_waveform(
    project: dict[str, Any],
    media_path: Path,
    *,
    peaks_per_second: int = DEFAULT_PEAKS_PER_SECOND,
    ffmpeg_bin: str | None = None,
    audio_track: int = 0,
) -> EmbeddedWaveformResult:
    """Return a project copy with embedded peaks, or the original project on failure."""
    try:
        payload = extract_waveform(
            media_path,
            peaks_per_second=peaks_per_second,
            ffmpeg_bin=ffmpeg_bin,
            audio_track=audio_track,
        )
    except Exception as exc:  # noqa: BLE001
        return EmbeddedWaveformResult(project=project, error=exc)
    embedded = dict(project)
    embedded["waveform"] = payload
    return EmbeddedWaveformResult(project=embedded)


def load_or_extract_waveform(
    existing: Any,
    media_path: Path,
    *,
    peaks_per_second: int = DEFAULT_PEAKS_PER_SECOND,
    ffmpeg_bin: str | None = None,
    audio_track: int = 0,
    default_audio_track: int | None = None,
    on_progress: WaveformProgressCallback | None = None,
) -> tuple[dict[str, Any], bool]:
    """Return cached peaks when valid, otherwise extract a fresh payload."""
    if not isinstance(audio_track, int) or isinstance(audio_track, bool) or audio_track < 0:
        raise ValueError("audio_track must be a non-negative integer")
    if (
        waveform_matches_media(existing, media_path, audio_track=audio_track)
        and existing["peaks_per_second"] == peaks_per_second
    ):
        return existing, False
    # 内核成功时自研波形只在 .quapeaks 的自研层里、没有 .mopeaks：去内联工程
    # 的冷启动不认这一层，就会白白重抽一遍 FFmpeg、再落一份内容重复的回退档。
    # 函数内导入与下面的 mopeaks 同理，避免顶层互导成环。
    from maw import quapeaks as maw_quapeaks

    container_payload = maw_quapeaks.load_self_wave_payload(
        media_path,
        audio_track=audio_track,
        default_audio_track=default_audio_track,
        peaks_per_second=peaks_per_second,
    )
    if (
        container_payload is not None
        and audio_track_from_payloads(container_payload) == audio_track
    ):
        return container_payload, False
    # 函数内导入：maw.mopeaks 在模块级借用本文件的载荷契约，顶层互导会成环。
    from maw import mopeaks

    sidecar_hit = mopeaks.load_mopeaks_hit(
        media_path,
        audio_track=audio_track,
        default_audio_track=default_audio_track,
    )
    if (
        sidecar_hit is not None
        and sidecar_hit.kind == "exact"
        and waveform_matches_media(
            sidecar_hit.payload,
            media_path,
            audio_track=audio_track,
        )
        and sidecar_hit.payload["peaks_per_second"] == peaks_per_second
    ):
        return sidecar_hit.payload, False
    fallback = (
        sidecar_hit.payload
        if sidecar_hit is not None
        and sidecar_hit.kind == "default_fallback"
        and sidecar_hit.payload["peaks_per_second"] == peaks_per_second
        else None
    )
    if fallback is None and container_payload is not None:
        fallback = container_payload
    if on_progress is not None:
        on_progress("generating")
    try:
        payload = extract_waveform(
            media_path,
            peaks_per_second=peaks_per_second,
            ffmpeg_bin=ffmpeg_bin,
            audio_track=audio_track,
        )
    except WaveformError:
        if fallback is not None:
            return fallback, False
        raise
    try:
        mopeaks.save_mopeaks(
            payload,
            media_path,
            audio_track=audio_track,
            default_audio_track=default_audio_track,
        )
    except OSError:
        # A read-only media folder must not prevent HTML generation.
        pass
    return payload, True
