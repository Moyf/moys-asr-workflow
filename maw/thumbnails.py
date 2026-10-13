"""Bounded video sampling with real, normalized source presentation times."""

from __future__ import annotations

import json
import math
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Sequence

from maw.ffmpeg import resolve_ffmpeg_tool

IMAGE_SPEC = {"width": 160, "height": 90, "encoding": "jpeg", "fit": "contain", "rotation": "auto", "sar": "display"}
MAX_BATCH_TARGETS = 16
MAX_BATCH_SPAN_MS = 30_000


class ThumbnailError(RuntimeError):
    """A media probe or thumbnail extraction failed."""


class ThumbnailCancelled(ThumbnailError):
    """A caller withdrew an extraction request."""


@dataclass(frozen=True, slots=True)
class VideoInfo:
    stream_index: int
    duration_ms: int
    start_ms: int


@dataclass(frozen=True, slots=True)
class FrameResult:
    requested_ms: int
    actual_pts_ms: int | None
    status: Literal["target", "preview", "unavailable"]
    jpeg: bytes | None


def _run(command: list[str], *, timeout_s: float, cancel: threading.Event | None = None) -> subprocess.CompletedProcess[bytes]:
    """Drain through files: FFmpeg logging must never fill a pipe and deadlock."""
    if cancel is not None and cancel.is_set():
        raise ThumbnailCancelled("thumbnail request cancelled")
    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr)
        deadline = time.monotonic() + timeout_s
        try:
            while process.poll() is None:
                if cancel is not None and cancel.is_set():
                    raise ThumbnailCancelled("thumbnail request cancelled")
                if time.monotonic() >= deadline:
                    raise ThumbnailError("thumbnail command timed out")
                time.sleep(0.025)
        finally:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)
        # Both outputs are bounded even for corrupt files or verbose decoders.
        if stdout.tell() > 8 * 1024 * 1024:
            raise ThumbnailError("thumbnail probe exceeded output budget")
        stdout.seek(0)
        stderr.seek(max(0, stderr.tell() - 8192))
        return subprocess.CompletedProcess(command, process.returncode, stdout.read(), stderr.read())


def probe_video(media_path: Path | str, *, ffprobe_path: str | None = None, cancel: threading.Event | None = None) -> VideoInfo | None:
    """Choose the first actual video stream, excluding album-cover streams."""
    tool = resolve_ffmpeg_tool("ffprobe", ffprobe_path)
    if tool is None:
        raise ThumbnailError("ffprobe is unavailable")
    path = Path(media_path).resolve()
    if not path.is_file():
        raise ThumbnailError("media file is unavailable")
    result = _run([str(tool), "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)], timeout_s=20, cancel=cancel)
    if result.returncode:
        raise ThumbnailError(result.stderr.decode("utf-8", "replace")[-500:])
    try:
        payload = json.loads(result.stdout)
        stream = next(s for s in payload["streams"] if s.get("codec_type") == "video" and not s.get("disposition", {}).get("attached_pic"))
        start = float(stream.get("start_time", payload.get("format", {}).get("start_time", 0)) or 0)
        duration_value = stream.get("duration")
        if duration_value is None or duration_value == "N/A":
            # Matroska duration tags use the absolute end PTS when timestamps
            # start above zero. Prefer the stream's DURATION tag when present.
            tag = stream.get("tags", {}).get("DURATION", "")
            if tag and len(tag.split(":")) == 3:
                hours, minutes, seconds = tag.split(":")
                duration = int(hours) * 3600 + int(minutes) * 60 + float(seconds) - max(0, start)
            else:
                duration = float(payload.get("format", {}).get("duration", 0) or 0)
        else:
            duration = float(duration_value)
        if not math.isfinite(start) or not math.isfinite(duration) or duration <= 0:
            raise ValueError("invalid video duration")
        return VideoInfo(int(stream["index"]), round(duration * 1000), round(start * 1000))
    except StopIteration:
        return None
    except (KeyError, TypeError, ValueError) as exc:
        raise ThumbnailError(f"invalid video probe result: {exc}") from exc


def base_interval_ms(duration_ms: int) -> int:
    if duration_ms <= 0:
        raise ValueError("duration_ms must be positive")
    return 2_000 if duration_ms <= 600_000 else 5_000 if duration_ms <= 3_600_000 else 10_000


def batches(requests: Sequence[int]) -> list[list[int]]:
    """Partition sorted unique source-grid targets by both count and span."""
    result: list[list[int]] = []
    for target in sorted(set(requests)):
        if not result or len(result[-1]) == MAX_BATCH_TARGETS or target - result[-1][0] > MAX_BATCH_SPAN_MS:
            result.append([])
        result[-1].append(target)
    return result


def _frame_times(media_path: Path | str, video: VideoInfo, batch: Sequence[int], *, timeout_s: float, cancel: threading.Event | None) -> list[float]:
    probe = resolve_ffmpeg_tool("ffprobe")
    if probe is None:
        raise ThumbnailError("ffprobe is unavailable")
    begin = (video.start_ms + max(0, batch[0] - 1000)) / 1000
    end = (video.start_ms + min(video.duration_ms, batch[-1] + 1000)) / 1000
    # Explicit end avoids ffprobe's relative-end-after-keyframe-seek behavior.
    result = _run([str(probe), "-v", "error", "-threads", "2", "-select_streams", str(video.stream_index), "-read_intervals", f"{begin:.6f}%{end:.6f}", "-show_entries", "frame=best_effort_timestamp_time", "-of", "json", str(media_path)], timeout_s=timeout_s, cancel=cancel)
    if result.returncode:
        raise ThumbnailError(result.stderr.decode("utf-8", "replace")[-500:])
    try:
        values = sorted(set(float(frame["best_effort_timestamp_time"]) for frame in json.loads(result.stdout).get("frames", []) if "best_effort_timestamp_time" in frame))
        return [value for value in values if math.isfinite(value) and -1 <= value * 1000 - video.start_ms < video.duration_ms]
    except (TypeError, ValueError, KeyError) as exc:
        raise ThumbnailError("invalid frame timestamps") from exc


def extract_frames(media_path: Path | str, requested_ms: Sequence[int], *, stream_index: int | None = None, cancel: threading.Event | None = None, timeout_s: float = 45, ffmpeg_path: str | None = None, info: VideoInfo | None = None) -> list[FrameResult]:
    """Batch-decode selected real frames, including VFR and held tail frames.

    The timestamp probe reads a short interval from its preceding keyframe;
    FFmpeg then encodes only selected source timestamps in one task per batch.
    No fps resampler or nominal frame-number timestamp enters the result.
    """
    video = info or probe_video(media_path, cancel=cancel)
    if video is None:
        return [FrameResult(int(t), None, "unavailable", None) for t in requested_ms]
    if stream_index is not None and stream_index != video.stream_index:
        raise ValueError("stream_index does not name the probed video stream")
    values = list(requested_ms)
    if any(not isinstance(t, int) or isinstance(t, bool) or t < 0 or t >= video.duration_ms for t in values):
        raise ValueError("thumbnail requests must lie in [0, duration_ms)")
    tool = resolve_ffmpeg_tool("ffmpeg", ffmpeg_path)
    if tool is None:
        raise ThumbnailError("ffmpeg is unavailable")
    output: dict[int, FrameResult] = {}
    for batch in batches(values):
        deadline = time.monotonic() + timeout_s
        candidates = _frame_times(media_path, video, batch, timeout_s=timeout_s, cancel=cancel)
        choices: dict[int, float] = {}
        for target in batch:
            before = [p for p in candidates if p * 1000 - video.start_ms <= target + 0.001]
            if before:
                choices[target] = before[-1]
            elif candidates and target == 0:
                choices[target] = candidates[0]
        selected = sorted(set(choices.values()))
        images: dict[float, bytes] = {}
        if selected:
            with tempfile.TemporaryDirectory(prefix="maw-thumbnails-") as temp:
                # Copy timestamps and seek relative to stream start. The filter sees source
                # PTS even when a stream starts at a nonzero or negative time.
                seek = max(0, selected[0] - video.start_ms / 1000 - 0.001)
                expression = "+".join(f"lt(abs(t-{p:.9f}),0.000001)" for p in selected)
                vf = f"select='{expression}',scale=w='trunc(min(160/iw/sar,90/ih)*iw*sar/2)*2':h='trunc(min(160/iw/sar,90/ih)*ih/2)*2',setsar=1,pad=160:90:(ow-iw)/2:(oh-ih)/2"
                command = [str(tool), "-hide_banner", "-nostdin", "-v", "error", "-threads", "2", "-filter_threads", "1", "-copyts", "-ss", f"{seek:.9f}", "-i", str(media_path), "-map", f"0:{video.stream_index}", "-an", "-sn", "-dn", "-vf", vf, "-fps_mode", "passthrough", "-q:v", "5", "-pix_fmt", "yuvj420p", "-threads", "2", "-frames:v", str(len(selected)), "-y", str(Path(temp) / "%06d.jpg")]
                result = _run(command, timeout_s=max(0.01, deadline - time.monotonic()), cancel=cancel)
                if result.returncode:
                    raise ThumbnailError(result.stderr.decode("utf-8", "replace")[-500:])
                files = sorted(Path(temp).glob("*.jpg"))
                if len(files) != len(selected):
                    raise ThumbnailError("selected source frames were not decoded")
                images = {pts: file.read_bytes() for pts, file in zip(selected, files)}
        for target in batch:
            pts = choices.get(target)
            output[target] = FrameResult(target, max(0, round(pts * 1000) - video.start_ms), "target", images[pts]) if pts in images else FrameResult(target, None, "unavailable", None)
    return [output[t] for t in values]


def make_sprite(jpegs: Sequence[bytes], *, cancel: threading.Event | None = None) -> bytes:
    """Tile up to 64 already cached JPEGs using the distributed FFmpeg."""
    if not 1 <= len(jpegs) <= 64:
        raise ValueError("sprite needs 1 to 64 frames")
    tool = resolve_ffmpeg_tool("ffmpeg")
    if tool is None:
        raise ThumbnailError("ffmpeg is unavailable")
    with tempfile.TemporaryDirectory(prefix="maw-sprite-") as temp:
        directory = Path(temp)
        for index, jpeg in enumerate(jpegs):
            (directory / f"{index:03d}.jpg").write_bytes(jpeg)
        result = _run([str(tool), "-hide_banner", "-nostdin", "-v", "error", "-threads", "2", "-filter_threads", "1", "-framerate", "1", "-i", str(directory / "%03d.jpg"), "-vf", f"tile=8x{math.ceil(len(jpegs)/8)}:nb_frames={len(jpegs)}", "-frames:v", "1", "-q:v", "5", "-pix_fmt", "yuvj420p", "-threads", "2", "-y", str(directory / "sprite.jpg")], timeout_s=20, cancel=cancel)
        if result.returncode:
            raise ThumbnailError(result.stderr.decode("utf-8", "replace")[-500:])
        return (directory / "sprite.jpg").read_bytes()
