# pyright: reportAny=false, reportExplicitAny=false, reportMissingTypeArgument=false, reportOptionalSubscript=false, reportReturnType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUnusedCallResult=false

"""Compact, streaming waveform peak extraction for the subtitle editor.

The browser UI consumes a small min/max envelope instead of decoded PCM.  The
format deliberately uses only JSON-compatible values so it can travel with an
editor project and later be reused by a desktop shell.
"""

from __future__ import annotations

import base64
import json
import subprocess
import sys
from array import array
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from maw.ffmpeg import resolve_ffmpeg_tool


WAVEFORM_SCHEMA = "moy.asr.waveform.v1"
WAVEFORM_ENCODING = "i8-minmax-base64"
DEFAULT_PEAKS_PER_SECOND = 100


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
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0


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
    if (
        isinstance(sample_rate, (int, float))
        and not isinstance(sample_rate, bool)
        and isinstance(division, int)
        and not isinstance(division, bool)
        and sample_rate > 0
        and division > 0
    ):
        return sample_rate / division
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


def waveform_matches_media(value: Any, media_path: Path) -> bool:
    """Return true when a valid payload was derived from this exact file."""
    if not is_waveform_payload(value):
        return False
    return value.get("source") == media_signature(media_path)


def waveform_sidecar_path(media_path: Path) -> Path:
    """Return the portable sidecar path used for media-derived waveforms."""
    media_path = Path(media_path)
    return media_path.with_suffix(".waveform.json")


def load_waveform_sidecar(media_path: Path) -> dict[str, Any] | None:
    """Read a valid-looking waveform sidecar, ignoring missing/corrupt files."""
    try:
        value = json.loads(waveform_sidecar_path(media_path).read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    return value if is_waveform_payload(value) else None


def save_waveform_sidecar(payload: dict[str, Any], media_path: Path) -> Path:
    """Persist a waveform payload beside its source media for future reuse."""
    sidecar = waveform_sidecar_path(media_path)
    # write_bytes() keeps the sidecar LF-only on Windows as well.
    sidecar.write_bytes((json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    return sidecar


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
    ffmpeg_bin: str | None = None,
) -> dict[str, Any]:
    """Stream a mono PCM envelope from FFmpeg without retaining decoded audio.

    At the default 100 peaks/second, three hours of audio produces about
    2.9 MiB of base64 data while extraction memory remains effectively flat.
    """
    media_path = Path(media_path).resolve()
    if not media_path.is_file():
        raise WaveformError(f"媒体文件不存在: {media_path}")
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

    bucket_samples = max(1, round(pcm_sample_rate / peaks_per_second))
    actual_peaks_per_second = round(pcm_sample_rate / bucket_samples)
    command = [
        ffmpeg,
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(media_path),
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        str(pcm_sample_rate),
        "-f",
        "s16le",
        "pipe:1",
    ]
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
    encoded = bytearray()
    byte_carry = b""
    sample_carry = array("h")
    total_samples = 0

    while True:
        chunk = process.stdout.read(64 * 1024)
        if not chunk:
            break
        raw = byte_carry + chunk
        even_length = len(raw) - (len(raw) % 2)
        byte_carry = raw[even_length:]
        values = array("h")
        values.frombytes(raw[:even_length])
        if sys.byteorder != "little":
            values.byteswap()
        total_samples += len(values)
        if sample_carry:
            sample_carry.extend(values)
            values = sample_carry
        complete_length = (len(values) // bucket_samples) * bucket_samples
        for offset in range(0, complete_length, bucket_samples):
            _append_bucket(encoded, values[offset : offset + bucket_samples])
        sample_carry = array("h", values[complete_length:])

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
    duration_ms = round(total_samples * 1000 / pcm_sample_rate)
    return {
        "schema": WAVEFORM_SCHEMA,
        "encoding": WAVEFORM_ENCODING,
        "peaks_per_second": actual_peaks_per_second,
        # bin i covers [i * division / sample_rate, (i + 1) * ...): the exact
        # pair, so consumers never have to rely on the rounded rate above.
        "sample_rate": pcm_sample_rate,
        "division": bucket_samples,
        "peak_count": peak_count,
        "duration_ms": duration_ms,
        "data": base64.b64encode(encoded).decode("ascii"),
        "source": media_signature(media_path),
    }


def embed_waveform(
    project: dict[str, Any],
    media_path: Path,
    *,
    peaks_per_second: int = DEFAULT_PEAKS_PER_SECOND,
    ffmpeg_bin: str | None = None,
) -> EmbeddedWaveformResult:
    """Return a project copy with embedded peaks, or the original project on failure."""
    try:
        payload = extract_waveform(
            media_path,
            peaks_per_second=peaks_per_second,
            ffmpeg_bin=ffmpeg_bin,
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
) -> tuple[dict[str, Any], bool]:
    """Return cached peaks when valid, otherwise extract a fresh payload."""
    if (
        waveform_matches_media(existing, media_path)
        and existing["peaks_per_second"] == peaks_per_second
    ):
        return existing, False
    sidecar = load_waveform_sidecar(media_path)
    if (
        waveform_matches_media(sidecar, media_path)
        and sidecar["peaks_per_second"] == peaks_per_second
    ):
        return sidecar, False
    payload = extract_waveform(
        media_path,
        peaks_per_second=peaks_per_second,
        ffmpeg_bin=ffmpeg_bin,
    )
    try:
        save_waveform_sidecar(payload, media_path)
    except OSError:
        # A read-only media folder must not prevent HTML generation.
        pass
    return payload, True
