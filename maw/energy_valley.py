"""Snap interpolated cue boundaries to the quietest nearby audio point.

Segment-only ASR engines (MOSS / FunASR coarse fallback, cloud filetrans
without word timestamps) return one text span per cue.  MAW re-splits
overlong spans by punctuation and interpolates the piece times linearly
(``build_interpolated_items``), so an interpolated cut point can land
mid-speech.  This module reads the extracted 16 kHz mono WAV and moves each
interpolated boundary to the lowest-energy frame within a small window —
the places where speakers actually pause (breath / silence valleys).
"""

from __future__ import annotations

from pathlib import Path

import soundfile as sf

try:  # numpy 随本地转写运行时（transformers / FunASR / OCR 组）安装；
    # 缺失时能量谷吸附静默降级为不生效，绝不阻断转写输出。
    import numpy as np
except ImportError:  # pragma: no cover - 取决于安装的依赖组
    np = None  # type: ignore[assignment]

FRAME_MS = 100
DEFAULT_MAX_SHIFT_MS = 400
# 只有窗口均方根出现明显低谷（谷值 ≤ 均值 × 比例）才移动切点；
# 窗口内能量平坦说明没有真实停顿，保持插值切点即可。
DEFAULT_DIP_RATIO = 0.5


def rms_envelope(audio_path: Path, frame_ms: int = FRAME_MS) -> tuple["np.ndarray", float]:
    """Return per-frame RMS values and the frame duration in seconds.

    The file is read in blocks so long media never materialises fully in
    memory; only the small envelope array is kept.
    """

    if np is None:
        raise RuntimeError("能量谷吸附需要 numpy（本地转写运行时默认携带）")
    info = sf.info(str(audio_path))
    frame_size = max(1, int(round(info.samplerate * frame_ms / 1000.0)))
    frame_seconds = frame_size / info.samplerate
    chunks: list[np.ndarray] = []
    carry = np.zeros(0, dtype=np.float32)
    for block in sf.blocks(str(audio_path), blocksize=frame_size * 64, dtype="float32", always_2d=True):
        mono = block.mean(axis=1) if block.ndim > 1 else block
        data = np.concatenate([carry, mono.astype(np.float32, copy=False)])
        usable = (data.size // frame_size) * frame_size
        if usable:
            frames = data[:usable].reshape(-1, frame_size)
            chunks.append(np.sqrt(np.mean(np.square(frames), axis=1)))
        carry = data[usable:]
    if not chunks:
        return np.zeros(0, dtype=np.float32), frame_seconds
    return np.concatenate(chunks), frame_seconds


def snap_boundaries_to_valleys(
    segments: list[dict],
    envelope: "np.ndarray",
    frame_seconds: float,
    *,
    max_shift_ms: int = DEFAULT_MAX_SHIFT_MS,
    dip_ratio: float = DEFAULT_DIP_RATIO,
) -> int:
    """Move boundaries between item-less (interpolated) cues to quiet valleys.

    Only cue pairs where both sides lack ``items`` are touched — word-timed
    cues carry real timestamps.  A boundary moves only when its window
    contains a genuine energy dip; both neighbouring cue times are updated
    to the snapped value so cues stay adjacent and monotonic.  Returns the
    number of moved boundaries.
    """

    if envelope.size == 0 or frame_seconds <= 0:
        return 0
    moved = 0
    for previous, current in zip(segments, segments[1:]):
        if previous.get("items") or current.get("items"):
            continue
        previous_start = previous.get("start")
        current_start = current.get("start")
        current_end = current.get("end")
        if not all(isinstance(value, (int, float)) and not isinstance(value, bool) for value in (previous_start, current_start, current_end)):
            continue
        boundary = float(current_start)
        lo = max(float(previous_start) + 1.0, boundary - max_shift_ms)
        hi = min(float(current_end) - 1.0, boundary + max_shift_ms)
        if hi <= lo:
            continue
        first_frame = max(0, int(lo / 1000.0 / frame_seconds))
        last_frame = min(envelope.size, max(first_frame + 1, int(hi / 1000.0 / frame_seconds) + 1))
        window = envelope[first_frame:last_frame]
        if window.size == 0:
            continue
        mean = float(window.mean())
        quiet = float(window.min())
        if mean <= 0 or quiet > mean * dip_ratio:
            continue
        valley = first_frame + int(window.argmin())
        snapped = int(round((valley + 0.5) * frame_seconds * 1000.0))
        snapped = min(max(snapped, int(lo) + 1), int(hi) - 1)
        if snapped == int(boundary):
            continue
        previous["end"] = snapped
        current["start"] = snapped
        moved += 1
    return moved


def snap_cue_boundaries(
    segments: list[dict],
    audio_path: Path | str,
    *,
    max_shift_ms: int = DEFAULT_MAX_SHIFT_MS,
    dip_ratio: float = DEFAULT_DIP_RATIO,
) -> int:
    """Read ``audio_path`` and snap interpolated boundaries; 0 when unavailable.

    Unreadable or missing audio degrades to a no-op so the transcription
    output is never blocked by the snapping pass.
    """

    try:
        envelope, frame_seconds = rms_envelope(Path(audio_path))
    except (OSError, RuntimeError, ValueError):
        return 0
    return snap_boundaries_to_valleys(
        segments,
        envelope,
        frame_seconds,
        max_shift_ms=max_shift_ms,
        dip_ratio=dip_ratio,
    )
