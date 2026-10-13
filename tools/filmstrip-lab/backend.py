"""Issue 229 experiment only: bounded, rebuildable FFmpeg sprite sidecars."""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import threading
import time
import uuid

from maw.ffmpeg import resolve_ffmpeg_tools
from maw.waveform import media_signature

VERSION = "filmstrip-lab-v2"
MAX_BYTES = 8 * 1024 * 1024
MAX_FRAMES = 240
CACHE_BUDGET = 128 * 1024 * 1024
TIMEOUT = 90


class Cancelled(RuntimeError):
    pass


def probe(path: Path) -> dict:
    tools = resolve_ffmpeg_tools()
    if not tools.ffprobe:
        raise RuntimeError("FFprobe missing")
    result = subprocess.run(
        [str(tools.ffprobe), "-v", "error", "-show_streams", "-show_format",
         "-of", "json", str(path)], capture_output=True, timeout=20, check=True,
    )
    data = json.loads(result.stdout)
    duration = float(data["format"].get("duration", 0))
    if not math.isfinite(duration) or not 0 < duration <= 86400:
        raise ValueError("Only finite media durations up to 24 hours")
    videos = []
    for stream in data["streams"]:
        if stream["codec_type"] == "video" and not stream.get("disposition", {}).get("attached_pic"):
            videos.append({key: stream.get(key) for key in
                           ("index", "codec_name", "width", "height", "avg_frame_rate",
                            "r_frame_rate", "tags", "side_data_list")})
    return {"name": path.name, "duration": duration, "videos": videos,
            "audio": any(s["codec_type"] == "audio" for s in data["streams"])}


def parameters(info: dict, mode: str, start: float = 0, span: float = 30,
               count: int = 100, stream: int = 0) -> dict:
    if mode not in ("fixed", "adaptive", "window"):
        raise ValueError("Unknown mode")
    if isinstance(stream, bool) or not isinstance(stream, int):
        raise ValueError("Invalid stream")
    if stream not in [s["index"] for s in info["videos"]]:
        raise ValueError("Video stream is not authorized")
    if isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= MAX_FRAMES:
        raise ValueError("Frame budget must be 1..240")
    if not all(math.isfinite(x) for x in (start, span)) or start < 0 or span <= 0:
        raise ValueError("Invalid window")
    if mode != "window":
        start, span = 0, info["duration"]
    else:
        if start >= info["duration"]:
            raise ValueError("Window starts after media")
        span = min(span, info["duration"] - start)
        count = min(count, 32)
    if mode == "adaptive":
        count = min(count, max(1, math.ceil(span / 15)))
    # Sample at midpoint to avoid asking a decoder for the EOF frame.
    return {"mode": mode, "start": round(start, 3), "span": round(span, 3),
            "count": count, "stream": stream, "width": 160, "height": 90,
            "columns": min(10, count)}


def identity(path: Path, config: dict) -> dict:
    tools = resolve_ffmpeg_tools()
    return {"version": VERSION, "source": media_signature(path),
            "mtime_ns": path.stat().st_mtime_ns,
            # The path hash distinguishes same-name/size/mtime files, without exposing paths.
            "path_hash": hashlib.sha256(os.fsencode(path.resolve())).hexdigest(),
            "tool_mtime": tools.ffmpeg.stat().st_mtime_ns if tools.ffmpeg else None,
            "config": config}


def cache_key(path: Path, config: dict) -> str:
    return hashlib.sha256(json.dumps(identity(path, config), sort_keys=True).encode()).hexdigest()


def process_metrics(process) -> dict:
    """Windows process CPU and peak working set; unavailable fields stay null."""
    result = {"cpu_seconds": None, "peak_working_set_bytes": None}
    if os.name != "nt":
        return result
    import ctypes
    from ctypes import wintypes
    class Counters(ctypes.Structure):
        _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [
            (name, ctypes.c_size_t) for name in ("PeakWorkingSetSize", "WorkingSetSize",
            "QuotaPeakPagedPoolUsage", "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage",
            "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage")]
    memory = Counters()
    memory.cb = ctypes.sizeof(memory)
    handle = wintypes.HANDLE(int(process._handle))
    if ctypes.windll.psapi.GetProcessMemoryInfo(handle, ctypes.byref(memory), memory.cb):
        result["peak_working_set_bytes"] = memory.PeakWorkingSetSize
    times = [wintypes.FILETIME() for _ in range(4)]
    if ctypes.windll.kernel32.GetProcessTimes(handle, *(ctypes.byref(t) for t in times)):
        result["cpu_seconds"] = sum((t.dwHighDateTime << 32) + t.dwLowDateTime for t in times[2:]) / 10000000
    return result


def generate(path: Path, info: dict, cache: Path, mode: str = "fixed",
             start: float = 0, span: float = 30, count: int = 100,
             stream: int = 0, cancel: threading.Event | None = None) -> dict:
    began = time.perf_counter()
    cancel = cancel or threading.Event()
    config = parameters(info, mode, start, span, count, stream)
    signature = identity(path, config)
    key = cache_key(path, config)
    final = cache / key
    if cancel.is_set():
        raise Cancelled("Superseded")
    try:
        manifest = json.loads((final / "manifest.json").read_text(encoding="utf-8"))
        image = final / "sprite.jpg"
        if (manifest["identity"] == signature and 0 < image.stat().st_size <= MAX_BYTES
                and hashlib.sha256(image.read_bytes()).hexdigest() == manifest["sha256"]):
            return {**manifest, "hit": True, "elapsed": time.perf_counter() - began}
    except (OSError, KeyError, ValueError, TypeError):
        pass
    tools = resolve_ffmpeg_tools()
    if not tools.ffmpeg:
        raise RuntimeError("FFmpeg missing; browser route remains available")
    cache.mkdir(parents=True, exist_ok=True)
    used = sum(p.stat().st_size for p in cache.rglob("*") if p.is_file())
    if used + MAX_BYTES * 2 > CACHE_BUDGET:
        raise ValueError("128 MiB experiment cache budget full; choose a fresh cache directory")
    staging = cache / ("pending-" + uuid.uuid4().hex)
    staging.mkdir()
    n, cols = config["count"], config["columns"]
    dt = config["span"] / n
    # Sequential fps is deliberately compared with a visible-window extraction.
    # fps resamples presentation timestamps; it is not a keyframe selector.
    filters = (
        f"fps={n / config['span']:.12f}:start_time=0,"
        "scale=160:90:force_original_aspect_ratio=decrease,"
        "pad=160:90:(ow-iw)/2:(oh-ih)/2,setsar=1,"
        f"tile={cols}x{math.ceil(n / cols)}:nb_frames={n}:padding=0:margin=0"
    )
    command = [
        str(tools.ffmpeg), "-hide_banner", "-nostdin", "-y", "-loglevel", "error",
        "-threads", "2", "-ss", str(config["start"]), "-i", str(path),
        "-t", str(config["span"]), "-map", f"0:{stream}", "-an", "-sn",
        "-vf", filters, "-frames:v", "1", "-q:v", "5", "-threads", "2",
        "-fs", str(MAX_BYTES), str(staging / "sprite.jpg"),
    ]
    process = None
    metrics = {"cpu_seconds": 0.0, "peak_working_set_bytes": 0}
    def run(command):
        nonlocal process
        with (staging / "ffmpeg.log").open("ab") as log:
            process = subprocess.Popen(command, stdout=log, stderr=log)
            while process.poll() is None:
                if cancel.wait(0.025) or time.perf_counter() - began > TIMEOUT:
                    process.kill()
                    process.wait(timeout=5)
                    raise Cancelled("Superseded") if cancel.is_set() else TimeoutError("90s budget")
            if process.returncode:
                raise RuntimeError("FFmpeg extraction failed; inspect local staging log")
            sample = process_metrics(process)
            if sample["cpu_seconds"] is None:
                metrics["cpu_seconds"] = None
            elif metrics["cpu_seconds"] is not None:
                metrics["cpu_seconds"] += sample["cpu_seconds"]
            if sample["peak_working_set_bytes"] is not None:
                metrics["peak_working_set_bytes"] = max(
                    metrics["peak_working_set_bytes"], sample["peak_working_set_bytes"])
        if cancel.is_set():
            raise Cancelled("Superseded")
    try:
        if mode == "window" and config["span"] > 120:
            # Wide visible windows: sparse input-side seek instead of silently
            # clipping the source range or decoding every intervening frame.
            for i in range(n):
                target = config["start"] + (i + 0.5) * dt
                run([str(tools.ffmpeg), "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
                     "-threads", "2", "-ss", str(target), "-i", str(path), "-map", f"0:{stream}",
                     "-an", "-sn", "-vf", "scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2,setsar=1",
                     "-frames:v", "1", "-q:v", "5", "-threads", "2", "-fs", "262144",
                     str(staging / f"frame-{i:03d}.jpg")])
            run([str(tools.ffmpeg), "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
                 "-i", str(staging / "frame-%03d.jpg"), "-vf",
                 f"tile={cols}x{math.ceil(n / cols)}:nb_frames={n}",
                 "-frames:v", "1", "-q:v", "5", "-threads", "2", "-fs", str(MAX_BYTES),
                 str(staging / "sprite.jpg")])
        else:
            run(command)
        image = staging / "sprite.jpg"
        if not image.is_file() or not 0 < image.stat().st_size < MAX_BYTES:
            raise ValueError("Sprite missing or exceeded byte budget")
        if cancel.is_set() or identity(path, config) != signature:
            raise Cancelled("Source changed or request superseded")
        manifest = {
            "key": key, "identity": signature, "config": config, "bytes": image.stat().st_size,
            "sha256": hashlib.sha256(image.read_bytes()).hexdigest(),
            "times": [round((config["start"] + (i + 0.5) * dt) * 1000) for i in range(n)],
            "precision": "nominal sampling midpoint; navigation only, not decoded frame PTS",
            "extract_seconds": time.perf_counter() - began,
            **metrics,
        }
        (staging / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n",
        )
        # Atomic directory rename publishes the complete image+manifest pair.
        # Keep invalid/aborted staging for diagnostics in ignored .artifacts.
        if final.exists():
            final.rename(cache / ("invalid-" + uuid.uuid4().hex))
        staging.rename(final)
        return {**manifest, "hit": False, "elapsed": time.perf_counter() - began}
    finally:
        if process is not None and process.poll() is None:
            process.kill()
            process.wait(timeout=5)
