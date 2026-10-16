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
from maw.gui_platform import creationflags, startupinfo

IMAGE_SPEC = {"width": 160, "height": 90, "encoding": "jpeg", "fit": "contain", "rotation": "auto", "sar": "display"}
MAX_BATCH_TARGETS = 16
MAX_BATCH_SPAN_MS = 30_000
MAX_KEYFRAME_CELLS = 4000


class ThumbnailError(RuntimeError):
    """A media probe or thumbnail extraction failed."""


class ThumbnailCancelled(ThumbnailError):
    """A caller withdrew an extraction request."""


@dataclass(frozen=True, slots=True)
class VideoInfo:
    stream_index: int
    duration_ms: int
    start_ms: int
    video_start_ms: int = 0


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
        # 冻结版是无控制台的 GUI 进程：子进程不加 CREATE_NO_WINDOW 时每次
        # 启动 ffmpeg/ffprobe 都会闪一个新控制台窗口（滚动补帧时表现为无限弹窗）。
        process = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=stdout,
            stderr=stderr,
            startupinfo=startupinfo(),
            creationflags=creationflags(),
        )
        deadline = time.monotonic() + timeout_s
        try:
            while process.poll() is None:
                if stdout.tell() > 8 * 1024 * 1024 or stderr.tell() > 8 * 1024 * 1024:
                    raise ThumbnailError("thumbnail command exceeded output budget")
                if cancel is not None and cancel.is_set():
                    raise ThumbnailCancelled("thumbnail request cancelled")
                if time.monotonic() >= deadline:
                    raise ThumbnailError("thumbnail command timed out")
                time.sleep(0.025)
        finally:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)
        if cancel is not None and cancel.is_set():
            raise ThumbnailCancelled("thumbnail request cancelled")
        # Both outputs are bounded even for corrupt files or verbose decoders.
        if stdout.tell() > 8 * 1024 * 1024:
            raise ThumbnailError("thumbnail probe exceeded output budget")
        stdout.seek(0)
        stderr.seek(max(0, stderr.tell() - 8192))
        return subprocess.CompletedProcess(command, process.returncode, stdout.read(), stderr.read())


def probe_video(media_path: Path | str, *, ffprobe_path: str | None = None, ffmpeg_path: str | None = None, cancel: threading.Event | None = None) -> VideoInfo | None:
    """Choose the first actual video stream, excluding album-cover streams."""
    tool = resolve_ffmpeg_tool("ffprobe", ffprobe_path or ffmpeg_path)
    if tool is None:
        raise ThumbnailError("ffprobe is unavailable")
    path = Path(media_path).resolve()
    if not path.is_file():
        raise ThumbnailError("media file is unavailable")
    command = [str(tool), "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)]
    result = _run(command, timeout_s=20, cancel=cancel)
    if result.returncode:
        raise ThumbnailError(result.stderr.decode("utf-8", "replace")[-500:])
    try:
        try:
            payload = json.loads(result.stdout)
        except ValueError:
            # One observed transient short read through the temp-file drain turned
            # a healthy library into a truncated JSON payload; a fresh probe is far
            # cheaper than skipping the whole thumbnail stage for that media.
            result = _run(command, timeout_s=20, cancel=cancel)
            if result.returncode:
                raise ThumbnailError(result.stderr.decode("utf-8", "replace")[-500:])
            payload = json.loads(result.stdout)
        stream = next(s for s in payload["streams"] if s.get("codec_type") == "video" and not s.get("disposition", {}).get("attached_pic"))
        def number(value):
            try:
                result = float(value)
                return result if math.isfinite(result) else None
            except (TypeError, ValueError):
                return None

        format_info = payload.get("format", {})
        stream_start = number(stream.get("start_time"))
        origin = number(format_info.get("start_time"))
        if origin is None:
            origin = stream_start if stream_start is not None else 0
        if stream_start is None:
            stream_start = origin

        def stream_end(row):
            start = number(row.get("start_time"))
            start = origin if start is None else start
            duration = number(row.get("duration"))
            if duration is not None and duration > 0:
                return start + duration
            # Matroska DURATION tags represent absolute end timestamps.
            tag = row.get("tags", {}).get("DURATION", "")
            if isinstance(tag, str) and len(tag.split(":")) == 3:
                hours, minutes, seconds = tag.split(":")
                return int(hours) * 3600 + int(minutes) * 60 + float(seconds)
            return None

        ends = [end for row in payload["streams"] if row.get("codec_type") in ("video", "audio") and not row.get("disposition", {}).get("attached_pic") and (end := stream_end(row)) is not None]
        duration = max((end - origin for end in ends), default=0)
        format_duration = number(format_info.get("duration"))
        if format_duration is not None and format_duration > 0:
            # Some nonzero-start containers report their absolute end in this
            # field; MPEG-TS can instead report the true span. Known stream
            # ends disambiguate those forms while preserving existing offsets.
            if origin > 0 and ends and abs(format_duration-max(ends)) <= .01:
                format_duration -= origin
            duration = max(duration, format_duration)
        if not math.isfinite(duration) or duration <= 0:
            raise ValueError("invalid video duration")
        return VideoInfo(int(stream["index"]), round(duration * 1000), round(origin * 1000), max(0, round((stream_start-origin) * 1000)))
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


def _packet_times(media_path: Path | str, video: VideoInfo, begin_s: float, end_s: float, *, timeout_s: float, cancel: threading.Event | None, ffmpeg_path: str | None = None) -> tuple[list[float], list[float]]:
    """Presentation times plus the keyframe-only subset of one interval.

    Packet timestamps carry the same presentation PTS as decoded frames
    (verified against -show_frames on real fixtures) without decoding a single
    frame; 4K AV1 probes drop from seconds to milliseconds. Keyframe flags
    feed the fast keyframe-only base tier.
    """
    probe = resolve_ffmpeg_tool("ffprobe", ffmpeg_path)
    if probe is None:
        raise ThumbnailError("ffprobe is unavailable")
    # Explicit end avoids ffprobe's relative-end-after-keyframe-seek behavior.
    command = [str(probe), "-v", "error", "-select_streams", str(video.stream_index), "-read_intervals", f"{begin_s:.6f}%{end_s:.6f}", "-show_entries", "packet=pts_time,dts_time,flags", "-of", "json", str(media_path)]
    result = _run(command, timeout_s=timeout_s, cancel=cancel)
    if result.returncode:
        raise ThumbnailError(result.stderr.decode("utf-8", "replace")[-500:])
    try:
        try:
            payload = json.loads(result.stdout)
        except ValueError:
            # The same transient short read seen in probe_video can empty or
            # truncate the packet payload; a fresh scan is cheaper than failing
            # the whole batch chain.
            result = _run(command, timeout_s=timeout_s, cancel=cancel)
            if result.returncode:
                raise ThumbnailError(result.stderr.decode("utf-8", "replace")[-500:])
            payload = json.loads(result.stdout)
        values, keyframes = set(), set()
        for packet in payload.get("packets", []):
            stamp = packet.get("pts_time", packet.get("dts_time"))
            if stamp is None:
                continue
            value = float(stamp)
            if not math.isfinite(value):
                continue
            values.add(value)
            if "K" in packet.get("flags", ""):
                keyframes.add(value)

        def window(items: set[float]) -> list[float]:
            return [value for value in sorted(items) if -1 <= value * 1000 - video.start_ms < video.duration_ms]

        return window(values), window(keyframes)
    except (TypeError, ValueError, KeyError) as exc:
        raise ThumbnailError("invalid frame timestamps") from exc


def _frame_times(media_path: Path | str, video: VideoInfo, batch: Sequence[int], *, timeout_s: float, cancel: threading.Event | None, ffmpeg_path: str | None = None) -> list[float]:
    begin = (video.start_ms + max(0, batch[0] - 1000)) / 1000
    end = (video.start_ms + min(video.duration_ms, batch[-1] + 1000)) / 1000
    return _packet_times(media_path, video, begin, end, timeout_s=timeout_s, cancel=cancel, ffmpeg_path=ffmpeg_path)[0]


def extract_frames(media_path: Path | str, requested_ms: Sequence[int], *, stream_index: int | None = None, cancel: threading.Event | None = None, timeout_s: float = 45, ffmpeg_path: str | None = None, info: VideoInfo | None = None, threads: int = 2) -> list[FrameResult]:
    """Batch-decode selected real frames, including VFR and held tail frames.

    The timestamp probe reads a short packet-PTS interval from its preceding
    keyframe without decoding; FFmpeg then encodes only selected source
    timestamps in one task per batch. No fps resampler or nominal frame-number
    timestamp enters the result. ``threads`` bounds the decode task and should
    stay small for interactive callers; background builds may raise it.
    """
    video = info or probe_video(media_path, cancel=cancel, ffmpeg_path=ffmpeg_path)
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
    source_stat = Path(media_path).stat()
    source_identity = (source_stat.st_size, source_stat.st_mtime_ns)
    output: dict[int, FrameResult] = {}
    for batch in batches(values):
        deadline = time.monotonic() + timeout_s
        candidates = _frame_times(media_path, video, batch, timeout_s=timeout_s, cancel=cancel, ffmpeg_path=ffmpeg_path)
        choices: dict[int, float] = {}
        for target in batch:
            before = [p for p in candidates if p * 1000 - video.start_ms <= target + 0.001]
            if before:
                choices[target] = before[-1]
        selected = sorted(set(choices.values()))
        images: dict[float, bytes] = {}
        if selected:
            with tempfile.TemporaryDirectory(prefix="maw-thumbnails-") as temp:
                # Copy timestamps and seek relative to the source format start. The filter sees source
                # PTS even when a stream starts at a nonzero or negative time.
                seek = max(0, selected[0] - video.start_ms / 1000 - 0.001)
                expression = "+".join(f"lt(abs(t-{p:.9f}),0.000001)" for p in selected)
                vf = f"select='{expression}',scale=w='trunc(min(160/iw/sar,90/ih)*iw*sar/2)*2':h='trunc(min(160/iw/sar,90/ih)*ih/2)*2',setsar=1,pad=160:90:(ow-iw)/2:(oh-ih)/2"
                command = [str(tool), "-hide_banner", "-nostdin", "-v", "error", "-threads", str(threads), "-filter_threads", "1", "-copyts", "-ss", f"{seek:.9f}", "-i", str(media_path), "-map", f"0:{video.stream_index}", "-an", "-sn", "-dn", "-vf", vf, "-fps_mode", "passthrough", "-q:v", "5", "-pix_fmt", "yuvj420p", "-threads", str(threads), "-frames:v", str(len(selected)), "-y", str(Path(temp) / "%06d.jpg")]
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
    final_stat = Path(media_path).stat()
    if (final_stat.st_size, final_stat.st_mtime_ns) != source_identity:
        raise ThumbnailError("source changed during thumbnail extraction")
    return [output[t] for t in values]


def extract_keyframes(media_path: Path | str, *, stream_index: int | None = None, cancel: threading.Event | None = None, timeout_s: float = 600, ffmpeg_path: str | None = None, info: VideoInfo | None = None, threads: int = 2, max_cells: int = 4000) -> list[FrameResult]:
    """Decode only keyframes in one full-file pass and stamp their real PTS.

    Keyframes decode independently, so a whole film costs a small fraction of
    the exact-grid pass. Frames land on their own presentation timestamps; the
    cache holds them onto display grids at render time. Dense sources are
    decimated to ``max_cells`` during planning, before any FFmpeg work.
    """
    video = info or probe_video(media_path, cancel=cancel, ffmpeg_path=ffmpeg_path)
    if video is None:
        return []
    if stream_index is not None and stream_index != video.stream_index:
        raise ValueError("stream_index does not name the probed video stream")
    tool = resolve_ffmpeg_tool("ffmpeg", ffmpeg_path)
    if tool is None:
        raise ThumbnailError("ffmpeg is unavailable")
    source_stat = Path(media_path).stat()
    source_identity = (source_stat.st_size, source_stat.st_mtime_ns)
    begin_s, end_s = video.start_ms / 1000, (video.start_ms + video.duration_ms) / 1000
    deadline = time.monotonic() + timeout_s

    def remaining():
        if cancel is not None and cancel.is_set():
            raise ThumbnailCancelled("thumbnail request cancelled")
        seconds = deadline - time.monotonic()
        if seconds <= 0:
            raise ThumbnailError("keyframe extraction timed out")
        return seconds

    keyframe_times: set[float] = set()
    chunk_s = 300.0
    # Under heavy load the ffprobe drain has been observed to silently drop
    # packets from an otherwise valid JSON payload. Two unioned passes make a
    # dropped landmark require two independent losses in the same window.
    for _pass in range(2):
        position = begin_s
        while position < end_s:
            _, keyframes = _packet_times(media_path, video, position, min(position + chunk_s, end_s), timeout_s=remaining(), cancel=cancel, ffmpeg_path=ffmpeg_path)
            keyframe_times.update(keyframes)
            position += chunk_s
    stamps = sorted(keyframe_times)
    if not stamps:
        return []
    stride = 1
    if len(stamps) > max_cells:
        stride = math.ceil(len(stamps) / max_cells)
        stamps = stamps[::stride]
    with tempfile.TemporaryDirectory(prefix="maw-keyframes-") as temp:
        decimate = f"select='not(mod(n\\,{stride}))'," if stride > 1 else ""
        vf = decimate + "scale=w='trunc(min(160/iw/sar,90/ih)*iw*sar/2)*2':h='trunc(min(160/iw/sar,90/ih)*ih/2)*2',setsar=1,pad=160:90:(ow-iw)/2:(oh-ih)/2"
        command = [str(tool), "-hide_banner", "-nostdin", "-v", "error", "-skip_frame", "nokey", "-threads", str(threads), "-filter_threads", "1", "-i", str(media_path), "-map", f"0:{video.stream_index}", "-an", "-sn", "-dn", "-vf", vf, "-fps_mode", "passthrough", "-q:v", "5", "-pix_fmt", "yuvj420p", "-y", str(Path(temp) / "%06d.jpg")]
        result = _run(command, timeout_s=remaining(), cancel=cancel)
        if result.returncode:
            raise ThumbnailError(result.stderr.decode("utf-8", "replace")[-500:])
        files = sorted(Path(temp).glob("*.jpg"))
        if len(files) != len(stamps):
            raise ThumbnailError("keyframe decode did not match the packet scan")
        frames = []
        for stamp, file in zip(stamps, files):
            pts = max(0, round(stamp * 1000) - video.start_ms)
            frames.append(FrameResult(pts, pts, "preview", file.read_bytes()))
    if (Path(media_path).stat().st_size, Path(media_path).stat().st_mtime_ns) != source_identity:
        raise ThumbnailError("source changed during thumbnail extraction")
    return frames


def make_sprite(jpegs: Sequence[bytes], *, cancel: threading.Event | None = None, ffmpeg_path: str | None = None, timeout_s: float = 20) -> bytes:
    """Tile up to 64 already cached JPEGs using the distributed FFmpeg."""
    if not 1 <= len(jpegs) <= 64:
        raise ValueError("sprite needs 1 to 64 frames")
    tool = resolve_ffmpeg_tool("ffmpeg", ffmpeg_path)
    if tool is None:
        raise ThumbnailError("ffmpeg is unavailable")
    with tempfile.TemporaryDirectory(prefix="maw-sprite-") as temp:
        directory = Path(temp)
        for index, jpeg in enumerate(jpegs):
            (directory / f"{index:03d}.jpg").write_bytes(jpeg)
        result = _run([str(tool), "-hide_banner", "-nostdin", "-v", "error", "-threads", "2", "-filter_threads", "1", "-framerate", "1", "-i", str(directory / "%03d.jpg"), "-vf", f"tile=8x{math.ceil(len(jpegs)/8)}:nb_frames={len(jpegs)}", "-frames:v", "1", "-q:v", "5", "-pix_fmt", "yuvj420p", "-threads", "2", "-y", str(directory / "sprite.jpg")], timeout_s=timeout_s, cancel=cancel)
        if result.returncode:
            raise ThumbnailError(result.stderr.decode("utf-8", "replace")[-500:])
        return (directory / "sprite.jpg").read_bytes()
