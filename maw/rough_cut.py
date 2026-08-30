"""安全地把文稿粗剪决定渲染为本地 MP4 与匹配 SRT。"""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any


MAX_ROUGH_CUT_INTERVALS = 20_000
MAX_ROUGH_CUT_SRT_BYTES = 16 * 1024 * 1024
_INVALID_OUTPUT_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
_WINDOWS_RESERVED_STEMS = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{index}" for index in range(1, 10)),
    *(f"LPT{index}" for index in range(1, 10)),
}


class RoughCutError(ValueError):
    """粗剪请求或 FFmpeg 渲染失败。"""


@dataclass(frozen=True, slots=True)
class MediaStreams:
    duration_ms: int
    has_video: bool
    has_audio: bool


@dataclass(frozen=True, slots=True)
class RoughCutResult:
    video_path: Path
    srt_path: Path
    source_duration_ms: int
    output_duration_ms: int


def sanitize_output_stem(value: str, fallback: str) -> str:
    raw = Path(str(value or "").strip()).stem.strip() if str(value or "").strip() else ""
    sanitized = _INVALID_OUTPUT_CHARS.sub("_", raw).strip(" .")
    if sanitized in {"", ".", ".."}:
        sanitized = _INVALID_OUTPUT_CHARS.sub("_", fallback).strip(" .")
    if sanitized in {"", ".", ".."}:
        sanitized = "maw-rough-cut"
    if sanitized.split(".", 1)[0].upper() in _WINDOWS_RESERVED_STEMS:
        sanitized += "_"
    return sanitized[:160]


def normalize_intervals(values: Any, duration_ms: int) -> list[tuple[int, int]]:
    if not isinstance(values, list) or not values:
        raise RoughCutError("粗剪后没有可保留的视频区间")
    if len(values) > MAX_ROUGH_CUT_INTERVALS:
        raise RoughCutError("粗剪区间数量超过上限")
    normalized: list[tuple[int, int]] = []
    previous_end = 0
    for index, value in enumerate(values):
        if not isinstance(value, dict):
            raise RoughCutError(f"第 {index + 1} 个粗剪区间格式不正确")
        start = value.get("start")
        end = value.get("end")
        if type(start) is not int or type(end) is not int:
            raise RoughCutError(f"第 {index + 1} 个粗剪区间必须使用整数毫秒")
        if start < 0 or end <= start or end > duration_ms:
            raise RoughCutError(f"第 {index + 1} 个粗剪区间超出媒体范围")
        if normalized and start < previous_end:
            raise RoughCutError("粗剪保留区间必须按时间排序且不能重叠")
        normalized.append((start, end))
        previous_end = end
    return normalized


def probe_media_streams(ffprobe: Path, source: Path) -> MediaStreams:
    command = [
        str(ffprobe), "-v", "error", "-show_entries", "format=duration:stream=codec_type",
        "-of", "json", str(source),
    ]
    result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "ffprobe 读取失败").strip().splitlines()[-1]
        raise RoughCutError(f"无法读取源媒体：{detail}")
    try:
        payload = json.loads(result.stdout)
        duration_ms = round(float(payload["format"]["duration"]) * 1000)
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        raise RoughCutError("源媒体没有可用时长") from error
    stream_types = {
        stream.get("codec_type") for stream in payload.get("streams", [])
        if isinstance(stream, dict)
    }
    return MediaStreams(
        duration_ms=max(1, duration_ms),
        has_video="video" in stream_types,
        has_audio="audio" in stream_types,
    )


def build_filter_script(
    intervals: list[tuple[int, int]],
    *,
    source_duration_ms: int,
    has_audio: bool,
) -> str:
    lines: list[str] = []
    for index, (start_ms, end_ms) in enumerate(intervals):
        start = start_ms / 1000
        end = end_ms / 1000
        video_label = "vout" if len(intervals) == 1 else f"v{index}"
        lines.append(
            f"[0:v:0]trim=start={start:.3f}:end={end:.3f},"
            f"setpts=PTS-STARTPTS[{video_label}]"
        )
        if has_audio:
            filters = [
                f"[0:a:0]atrim=start={start:.3f}:end={end:.3f}",
                "asetpts=PTS-STARTPTS",
            ]
            duration = (end_ms - start_ms) / 1000
            fade = min(0.01, duration / 4)
            if start_ms > 0 and fade > 0:
                filters.append(f"afade=t=in:st=0:d={fade:.3f}")
            if end_ms < source_duration_ms and fade > 0:
                filters.append(f"afade=t=out:st={max(0, duration - fade):.3f}:d={fade:.3f}")
            audio_label = "aout" if len(intervals) == 1 else f"a{index}"
            lines.append(",".join(filters) + f"[{audio_label}]")
    if len(intervals) > 1:
        inputs = "".join(
            f"[v{index}]" + (f"[a{index}]" if has_audio else "")
            for index in range(len(intervals))
        )
        lines.append(
            f"{inputs}concat=n={len(intervals)}:v=1:a={1 if has_audio else 0}"
            f"[vout]{'[aout]' if has_audio else ''}"
        )
    return ";\n".join(lines) + "\n"


def _next_output_paths(directory: Path, stem: str) -> tuple[Path, Path]:
    index = 1
    while True:
        suffix = "" if index == 1 else f"-{index}"
        video = directory / f"{stem}{suffix}.mp4"
        srt = directory / f"{stem}{suffix}.srt"
        if not video.exists() and not srt.exists():
            return video, srt
        index += 1


def render_rough_cut(
    *,
    source: Path,
    project_directory: Path,
    output_name: str,
    fallback_stem: str,
    intervals: Any,
    srt_text: str,
    ffmpeg: Path,
    ffprobe: Path,
) -> RoughCutResult:
    if not source.is_file():
        raise RoughCutError("当前工程没有可读取的源媒体")
    if not project_directory.is_dir():
        raise RoughCutError("当前工程目录不可用")
    if not isinstance(srt_text, str):
        raise RoughCutError("粗剪字幕格式不正确")
    if len(srt_text.encode("utf-8")) > MAX_ROUGH_CUT_SRT_BYTES:
        raise RoughCutError("粗剪字幕超过 16 MB 上限")
    streams = probe_media_streams(ffprobe, source)
    if not streams.has_video:
        raise RoughCutError("第一版文稿粗剪只支持视频媒体")
    kept = normalize_intervals(intervals, streams.duration_ms)
    output_duration_ms = sum(end - start for start, end in kept)
    stem = sanitize_output_stem(output_name, f"{fallback_stem}_rough-cut")
    video_path, srt_path = _next_output_paths(project_directory, stem)

    handles: list[Path] = []
    try:
        video_fd, video_temp_name = tempfile.mkstemp(
            prefix=f".{stem}.", suffix=".tmp.mp4", dir=project_directory,
        )
        os.close(video_fd)
        video_temp = Path(video_temp_name)
        video_temp.unlink(missing_ok=True)
        handles.append(video_temp)
        srt_fd, srt_temp_name = tempfile.mkstemp(
            prefix=f".{stem}.", suffix=".tmp.srt", dir=project_directory,
        )
        os.close(srt_fd)
        srt_temp = Path(srt_temp_name)
        handles.append(srt_temp)
        filter_fd, filter_temp_name = tempfile.mkstemp(
            prefix=f".{stem}.", suffix=".filter.txt", dir=project_directory,
        )
        os.close(filter_fd)
        filter_temp = Path(filter_temp_name)
        handles.append(filter_temp)

        filter_temp.write_text(
            build_filter_script(
                kept,
                source_duration_ms=streams.duration_ms,
                has_audio=streams.has_audio,
            ),
            encoding="utf-8",
            newline="\n",
        )
        srt_temp.write_text(srt_text.rstrip("\n") + "\n", encoding="utf-8", newline="\n")
        command = [
            str(ffmpeg), "-hide_banner", "-nostdin", "-y", "-i", str(source),
            "-filter_complex_script", str(filter_temp),
            "-map", "[vout]",
        ]
        if streams.has_audio:
            command.extend(["-map", "[aout]"])
        command.extend([
            "-map_metadata", "0", "-c:v", "libx264", "-preset", "veryfast",
            "-crf", "20", "-pix_fmt", "yuv420p",
        ])
        if streams.has_audio:
            command.extend(["-c:a", "aac", "-b:a", "192k"])
        command.extend(["-movflags", "+faststart", str(video_temp)])
        result = subprocess.run(
            command, capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        if result.returncode != 0 or not video_temp.is_file():
            details = (result.stderr or result.stdout or "FFmpeg 未生成输出").strip().splitlines()
            raise RoughCutError("FFmpeg 粗剪失败：" + " | ".join(details[-4:]))
        video_committed = False
        try:
            os.replace(video_temp, video_path)
            video_committed = True
            os.replace(srt_temp, srt_path)
        except OSError:
            # 两个文件是同一次导出；第二步失败时撤回刚生成的视频，避免留下半套产物。
            if video_committed:
                video_path.unlink(missing_ok=True)
            raise
    finally:
        for handle in handles:
            handle.unlink(missing_ok=True)

    return RoughCutResult(
        video_path=video_path,
        srt_path=srt_path,
        source_duration_ms=streams.duration_ms,
        output_duration_ms=output_duration_ms,
    )
