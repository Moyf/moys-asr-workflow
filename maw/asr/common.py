"""Shared media extraction, CLI formatting, and SRT output."""

from __future__ import annotations

import argparse
import os
import re as _re
import subprocess
from pathlib import Path
from maw.console import configure_utf8_stdio
from maw.ffmpeg import resolve_ffmpeg_tool


FFMPEG_MISSING_MESSAGE = (
    "找不到 FFmpeg，请下载完整版 MAW（MAW-lite 不包含 FFmpeg）；"
    "如果要继续使用 MAW-lite，请安装 FFmpeg，并确保 ffmpeg 与 ffprobe 已加入 PATH。"
)


def configure_console_output() -> None:
    """Backward-compatible alias for the shared UTF-8 console setup."""
    configure_utf8_stdio()


def _run_media_tool(cmd: list[str], **kwargs):
    try:
        return subprocess.run(cmd, **kwargs)
    except FileNotFoundError as exc:
        executable = Path(str(cmd[0])).stem.lower() if cmd else ""
        if executable in {"ffmpeg", "ffprobe"}:
            raise RuntimeError(FFMPEG_MISSING_MESSAGE) from exc
        raise


def _resolve_media_tool(
    tool: str,
    configured_path: str | os.PathLike[str] | None = None,
) -> str:
    resolved = resolve_ffmpeg_tool(
        tool,
        configured_path,
        allow_missing_explicit=bool(configured_path),
    )
    if resolved is None:
        raise RuntimeError(FFMPEG_MISSING_MESSAGE)
    return str(resolved)


def extract_audio(
    video_path: str,
    output_path: str,
    duration_limit: float | None = None,
    *,
    ffmpeg_path: str | os.PathLike[str] | None = None,
    audio_track: int = 0,
) -> None:
    if not isinstance(audio_track, int) or isinstance(audio_track, bool) or audio_track < 0:
        raise ValueError("audio_track must be a non-negative integer")
    cmd = [
        _resolve_media_tool("ffmpeg", ffmpeg_path),
        "-i",
        video_path,
        "-map",
        f"0:a:{audio_track}",
    ]
    if duration_limit is not None:
        cmd.extend(["-t", str(duration_limit)])
    cmd.extend([
        "-vn", "-acodec", "pcm_s16le",
        "-ar", "16000", "-ac", "1",
        "-y", output_path,
    ])
    print(f"[ffmpeg] 正在提取音频: {video_path}")
    _run_media_tool(cmd, check=True, capture_output=True)
    print("[ffmpeg] 音频提取完成")


def get_duration_sec(
    filepath: str,
    *,
    ffprobe_path: str | os.PathLike[str] | None = None,
) -> float:
    cmd = [
        _resolve_media_tool("ffprobe", ffprobe_path), "-v", "quiet",
        "-show_entries", "format=duration",
        "-of", "csv=p=0", filepath,
    ]
    out = _run_media_tool(cmd, check=True, capture_output=True, text=True)
    return float(out.stdout.strip())


def parse_duration(value: str) -> float:
    """解析时长字符串，支持 h/m/s 后缀。"""
    value = value.strip().lower()
    m = _re.fullmatch(r'([\d.]+)\s*(h|m|s)?', value)
    if not m:
        raise argparse.ArgumentTypeError(f"无法解析时长: '{value}'，示例: 10m, 20s, 1h, 90")
    num = float(m.group(1))
    unit = m.group(2)
    if unit == 'h':
        return num * 3600
    elif unit == 'm':
        return num * 60
    return num


def format_timestamp(ms: int) -> str:
    h = ms // 3_600_000
    ms %= 3_600_000
    m = ms // 60_000
    ms %= 60_000
    s = ms // 1_000
    ms %= 1_000
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def generate_srt(segments: list[dict]) -> str:
    lines = []
    for i, seg in enumerate(segments, 1):
        start = format_timestamp(seg["start"])
        end = format_timestamp(seg["end"])
        text = seg["text"].strip()
        lines.append(f"{i}\n{start} --> {end}\n{text}\n")
    return "\n".join(lines)
