# pyright: reportImplicitOverride=false

"""Validated FFmpeg media operations for the Launcher toolbox."""

from __future__ import annotations

import json
import math
import os
import re
import subprocess
import tempfile
from contextlib import suppress
from dataclasses import dataclass
from threading import Event, Thread
from pathlib import Path
from typing import Callable, Final, Mapping

from maw.gui_platform import creationflags, release_process_tree, startupinfo, terminate_process_tree
from maw.ass_fonts import normalize_ass_text_fontnames
from maw.output_naming import media_suffix
from maw.ass_styles import DEFAULT_SRT_STYLE, ass_style_force_style, ass_style_line, find_ass_style, load_ass_style_library
from maw.ffmpeg import resolve_ffmpeg_tool
from maw.media import probe_video_fps
from maw.project_ass_export import (
    PROJECT_SUBTITLE_EXTENSIONS,
    ProjectSubtitleError,
    load_burn_project,
    render_project_ass,
)


ALLOWED_DIRECTIVES: Final = frozenset({"ffconcat", "file", "inpoint", "outpoint", "duration"})
VIDEO_EXTENSIONS: Final = frozenset({".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".ts", ".m4v"})
MEDIA_EXTENSIONS: Final = frozenset((*VIDEO_EXTENSIONS, ".mp3", ".wav", ".m4a", ".flac", ".aac", ".ogg"))
SUBTITLE_EXTENSIONS: Final = frozenset({".srt", ".ass", ".ssa"})
# 烧录额外接受 mosp/json 工程：临时导出工程的基础 ASS 后按 ASS 烧录。
BURN_SUBTITLE_EXTENSIONS: Final = frozenset((*SUBTITLE_EXTENSIONS, *PROJECT_SUBTITLE_EXTENSIONS))
X264_PRESETS: Final = frozenset({"veryfast", "fast", "medium", "slow", "veryslow"})
AUDIO_BITRATES: Final = frozenset({"96k", "128k", "160k", "192k", "224k", "256k", "320k"})
MIN_BURN_CRF: Final = 0
MAX_BURN_CRF: Final = 51
DEFAULT_BURN_CRF: Final = 21
DEFAULT_BURN_PRESET: Final = "medium"
DEFAULT_BURN_AUDIO_BITRATE: Final = "192k"
# 样式库的 SRT 烧录样式按 1080p 参考坐标系存储字号（与编辑器预览、前端 ASS
# 导出共用的参考高度一致）；烧录时按目标 PlayResY 等比换算。
ASS_REFERENCE_PLAY_RES_Y: Final = 1080
ASS_FALLBACK_PLAY_RESOLUTION: Final[tuple[int, int]] = (1920, 1080)
VIDEO_ENCODER_MODES: Final[frozenset[str]] = frozenset({"auto", "cpu", "nvenc", "amf", "qsv"})
VIDEO_ENCODER_CODECS: Final[dict[str, str]] = {
    "nvenc": "h264_nvenc",
    "amf": "h264_amf",
    "qsv": "h264_qsv",
}
AUTO_VIDEO_ENCODER_ORDER: Final[tuple[str, ...]] = ("nvenc", "amf", "qsv", "cpu")
# 绿幕画布尺寸档位：键名与 Launcher 下拉值一致，默认 4K。
GREEN_SCREEN_SIZES: Final[dict[str, tuple[int, int]]] = {
    "1080p": (1920, 1080),
    "2k": (2560, 1440),
    "4k": (3840, 2160),
}
GREEN_SCREEN_SIZE_DEFAULT: Final = "4k"


@dataclass(frozen=True, slots=True)
class FfconcatRequest:
    media_path: Path
    ffconcat_path: Path


@dataclass(frozen=True, slots=True)
class FfconcatResult:
    source_media_path: Path
    media_path: Path
    ffconcat_path: Path


@dataclass(frozen=True, slots=True)
class FfconcatError(RuntimeError):
    message: str

    def __str__(self) -> str:
        return self.message


class MediaToolError(RuntimeError):
    """A user-facing failure from FFmpeg or FFprobe."""


class MediaToolCancelled(MediaToolError):
    """The user stopped an active FFmpeg operation."""


class SubtitleFontGlyphMissingError(MediaToolError):
    """libass could not find a glyph required by the subtitle text."""


_ASS_MISSING_GLYPH_RE: Final = re.compile(
    r"fontselect:\s*failed to find any fallback(?: with glyph 0x([0-9a-f]+))?\s+for font:\s*\(([^,\r\n]+),",
    re.IGNORECASE,
)


def libass_missing_glyphs(stderr: str) -> list[tuple[str, str]]:
    """Return (glyph_suffix, family) pairs from libass font fallback warnings.

    ``glyph_suffix`` is an empty string when libass did not report a code
    point; callers format user-facing messages themselves so the burn
    pipeline and the editor's frame preview can word them differently.
    """
    results: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for match in _ASS_MISSING_GLYPH_RE.finditer(stderr):
        glyph = f" U+{int(match.group(1), 16):04X}" if match.group(1) else ""
        family = re.sub(r"[\x00-\x1f\x7f]", "", match.group(2)).strip()[:100] or "当前字体"
        pair = (glyph, family)
        if pair not in seen:
            results.append(pair)
            seen.add(pair)
    return results


@dataclass(frozen=True, slots=True)
class AudioTrack:
    audio_index: int
    stream_index: int
    codec_name: str
    channels: int | None
    sample_rate: int | None
    language: str
    title: str
    default: bool


@dataclass(frozen=True, slots=True)
class BurnSubtitleRequest:
    media_path: Path | None
    subtitle_path: Path
    green_screen: bool = False
    # 绿幕画布尺寸档位（GREEN_SCREEN_SIZES 键名），仅 green_screen 生效；
    # 空值按 GREEN_SCREEN_SIZE_DEFAULT 处理。
    green_screen_size: str = GREEN_SCREEN_SIZE_DEFAULT
    green_screen_include_audio: bool = False
    # Optional normalized style supplied by a caller; when omitted, the
    # shared user-level SRT default slot is loaded automatically.
    srt_style: Mapping[str, object] | None = None
    video_encoder: str = "auto"
    # Optional encoding overrides exposed by the toolbox UI; None keeps the
    # built-in defaults (CRF 21 / preset medium / audio 192k). CRF 与音频码率
    # 对所有编码器生效（硬件编码器映射到 cq/qp/global_quality）；preset 仅
    # libx264 支持，硬件编码器使用各自的固定预设。
    crf: int | None = None
    preset: str | None = None
    audio_bitrate: str | None = None


@dataclass(frozen=True, slots=True)
class BurnSubtitleResult:
    source_media_path: Path | None
    media_path: Path
    subtitle_path: Path
    video_encoder: str
    # 烧录前 ASS 字体名归一化的人读说明（替换 + 未找到）；无归一化时为空。
    warnings: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class ExtractAudioRequest:
    media_path: Path
    audio_index: int


@dataclass(frozen=True, slots=True)
class ExtractAudioResult:
    source_media_path: Path
    media_path: Path
    audio_track: AudioTrack


def parse_ffconcat(ffconcat_path: Path, media_path: Path) -> None:
    """Validate an ffconcat script against the configured media, raising ValueError."""
    concat = ffconcat_path.expanduser().resolve()
    media = media_path.expanduser().resolve()
    if not concat.is_file() or concat.suffix.lower() != ".ffconcat":
        raise ValueError("ffconcat must be an existing .ffconcat file")
    if not media.is_file():
        raise ValueError("configured media must be an existing file")
    try:
        lines = concat.read_text(encoding="utf-8-sig").splitlines()
    except (OSError, UnicodeError) as error:
        raise ValueError(f"cannot read ffconcat: {error}") from error
    file_count = 0
    for line_number, raw_line in enumerate(lines, 1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        directive = line.split(maxsplit=1)[0]
        if directive not in ALLOWED_DIRECTIVES:
            raise ValueError(f"ffconcat line {line_number} uses unsupported directive {directive}")
        if directive == "ffconcat":
            if line != "ffconcat version 1.0":
                raise ValueError("ffconcat header must be version 1.0")
            continue
        if directive == "file":
            candidate = _resolve_file_directive(concat.parent, line.removeprefix("file").strip())
            if candidate != media:
                raise ValueError("every ffconcat file directive must resolve to the configured media")
            file_count += 1
            continue
        value = line.split(maxsplit=1)[1] if " " in line else ""
        if not re.fullmatch(r"\d+(?:\.\d+)?", value):
            raise ValueError(f"ffconcat line {line_number} has an invalid numeric value")
    if file_count == 0:
        raise ValueError("ffconcat contains no media files")


def run_ffconcat_rebuild(
    request: FfconcatRequest,
    *,
    ffmpeg_path: Path,
) -> FfconcatResult:
    media = request.media_path.expanduser().resolve()
    concat = request.ffconcat_path.expanduser().resolve()
    parse_ffconcat(concat, media)
    output = _available_media_output(media)
    temporary = output.with_name(f"{output.stem}.part{output.suffix}")
    command = [
        str(ffmpeg_path),
        "-y",
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        str(concat),
        "-map",
        "0",
        "-c",
        "copy",
        str(temporary),
    ]
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=86_400,
            check=False,
            startupinfo=startupinfo(),
            creationflags=creationflags(),
        )
    except subprocess.TimeoutExpired as error:
        temporary.unlink(missing_ok=True)
        raise FfconcatError("ffmpeg media rebuild timed out") from error
    if completed.returncode != 0:
        temporary.unlink(missing_ok=True)
        raise FfconcatError((completed.stderr or "ffmpeg media rebuild failed").strip()[-4000:])
    if not temporary.exists():
        raise FfconcatError("ffmpeg did not produce a media file")
    if temporary.stat().st_size == 0:
        temporary.unlink(missing_ok=True)
        raise FfconcatError("ffmpeg produced an empty media file")
    os.replace(temporary, output)
    return FfconcatResult(source_media_path=media, media_path=output, ffconcat_path=concat)


def probe_audio_tracks(media_path: Path, *, ffprobe_path: Path) -> tuple[AudioTrack, ...]:
    """Return the audio streams in display order, without decoding media."""
    media = _validated_media_path(media_path)
    command = [
        str(ffprobe_path),
        "-v",
        "error",
        "-select_streams",
        "a",
        "-show_entries",
        "stream=index,codec_name,channels,sample_rate:stream_tags=language,title,name,handler_name:stream_disposition=default",
        "-of",
        "json",
        str(media),
    ]
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=300,
            check=False,
            startupinfo=startupinfo(),
            creationflags=creationflags(),
        )
    except subprocess.TimeoutExpired as error:
        raise MediaToolError("ffprobe audio-track inspection timed out") from error
    except OSError as error:
        raise MediaToolError(f"ffprobe could not start: {error}") from error
    if completed.returncode != 0:
        detail = (completed.stderr or "ffprobe audio-track inspection failed").strip()
        raise MediaToolError(detail[-4000:])
    try:
        payload = json.loads(completed.stdout or "{}")
    except json.JSONDecodeError as error:
        raise MediaToolError("ffprobe returned invalid JSON") from error
    streams = payload.get("streams") if isinstance(payload, Mapping) else None
    if not isinstance(streams, list):
        raise MediaToolError("ffprobe returned invalid audio-stream metadata")
    tracks: list[AudioTrack] = []
    for audio_index, stream in enumerate(streams):
        if not isinstance(stream, Mapping):
            raise MediaToolError("ffprobe returned invalid audio-stream metadata")
        tags = stream.get("tags") if isinstance(stream.get("tags"), Mapping) else {}
        disposition = stream.get("disposition") if isinstance(stream.get("disposition"), Mapping) else {}
        stream_index = _integer_or_none(stream.get("index"))
        if stream_index is None or stream_index < 0 or isinstance(stream.get("index"), bool):
            raise MediaToolError("ffprobe returned invalid audio-stream index")
        tracks.append(
            AudioTrack(
                audio_index=audio_index,
                stream_index=stream_index,
                codec_name=str(stream.get("codec_name") or "").strip(),
                channels=_integer_or_none(stream.get("channels")),
                sample_rate=_integer_or_none(stream.get("sample_rate")),
                language=str(tags.get("language") or "").strip(),
                title=_first_nonempty_tag(tags, "title", "name", "handler_name"),
                default=bool(_integer_or_none(disposition.get("default")) or 0),
            )
        )
    return tuple(tracks)


def normalize_video_encoder(value: object) -> str:
    mode = str(value or "").strip().lower()
    return mode if mode in VIDEO_ENCODER_MODES else "auto"


def _available_video_encoder_modes(ffmpeg_path: Path) -> frozenset[str]:
    """Return hardware encoders advertised by this FFmpeg build."""
    try:
        completed = subprocess.run(
            [str(ffmpeg_path), "-hide_banner", "-encoders"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
            check=False,
            startupinfo=startupinfo(),
            creationflags=creationflags(),
        )
    except (OSError, subprocess.TimeoutExpired):
        return frozenset()
    if completed.returncode != 0:
        return frozenset()
    output = f"{completed.stdout or ''}\n{completed.stderr or ''}"
    return frozenset(
        mode
        for mode, codec in VIDEO_ENCODER_CODECS.items()
        if re.search(rf"^\s*V\S*\s+{re.escape(codec)}\b", output, re.MULTILINE)
    )


def _video_encoder_attempts(ffmpeg_path: Path, requested: str) -> tuple[str, ...]:
    mode = normalize_video_encoder(requested)
    if mode == "cpu":
        return ("cpu",)
    available = _available_video_encoder_modes(ffmpeg_path)
    if mode != "auto":
        if mode not in available:
            codec = VIDEO_ENCODER_CODECS[mode]
            raise MediaToolError(f"当前 FFmpeg 不支持所选视频编码器：{codec}。请改用自动或 CPU 编码。")
        return (mode,)
    return tuple(candidate for candidate in AUTO_VIDEO_ENCODER_ORDER if candidate == "cpu" or candidate in available)


def _video_encoder_options(mode: str, crf: int, preset: str) -> list[str]:
    # CRF 与 libx264 的 cq/qp/global_quality 同为 0–51、越小画质越高，因此
    # 用户设置的画质值直接映射到硬件编码器；preset 仅 libx264 支持。
    if mode == "cpu":
        return ["-c:v", "libx264", "-preset", preset, "-crf", str(crf)]
    if mode == "nvenc":
        return ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", str(crf), "-b:v", "0"]
    if mode == "amf":
        return ["-c:v", "h264_amf", "-quality", "quality", "-rc", "cqp", "-qp_i", str(crf), "-qp_p", str(crf)]
    if mode == "qsv":
        return ["-c:v", "h264_qsv", "-preset", "medium", "-global_quality", str(crf)]
    raise ValueError(f"unsupported video encoder mode: {mode}")


# 编辑器整片烧录（server-editor）与工具箱压制字幕共用同一套编码器探测与参数映射。
video_encoder_attempts = _video_encoder_attempts
video_encoder_options = _video_encoder_options


def _subtitle_time_ms(value: str) -> int | None:
    match = re.fullmatch(r"\s*(\d+):(\d{2}):(\d{2})[.,](\d{1,3})\s*", value)
    if not match:
        return None
    hours, minutes, seconds, fraction = match.groups()
    if int(minutes) >= 60 or int(seconds) >= 60:
        return None
    return ((int(hours) * 60 + int(minutes)) * 60 + int(seconds)) * 1000 + int(fraction.ljust(3, "0"))


def _green_screen_size_resolution(value: object) -> tuple[int, int]:
    """Map the selected green-screen size preset to a canvas resolution.

    空值回退默认档位；未知值显式报错，避免静默生成错误尺寸的绿幕视频。
    """
    key = str(value or "").strip().lower()
    if not key:
        key = GREEN_SCREEN_SIZE_DEFAULT
    resolution = GREEN_SCREEN_SIZES.get(key)
    if resolution is None:
        options = " / ".join(f"{name}（{size[0]}×{size[1]}）" for name, size in sorted(GREEN_SCREEN_SIZES.items()))
        raise MediaToolError(f"不支持的绿幕视频尺寸：{key}（可选 {options}）")
    return resolution


def _green_screen_input(subtitle: Path, play_resolution: tuple[int, int]) -> tuple[list[str], tuple[int, int]]:
    """Make a finite green canvas from subtitle timing; no source video is needed.

    Returns the lavfi input arguments plus the canvas size: the caller reuses
    the size as the burn PlayRes so a converted SRT style lands on the same
    coordinate system as the canvas.  画布尺寸来自用户选择的尺寸档位，
    与编辑器按实际视频分辨率预览的约定一致。
    """
    try:
        contents = subtitle.read_text(encoding="utf-8-sig", errors="replace")
    except OSError as error:
        raise MediaToolError(f"无法读取字幕时间轴：{error}") from error
    ends: list[int] = []
    width, height = play_resolution
    if subtitle.suffix.lower() == ".srt":
        for match in re.finditer(r"-->\s*(\d+:\d{2}:\d{2}[.,]\d{1,3})", contents):
            end = _subtitle_time_ms(match.group(1))
            if end is not None:
                ends.append(end)
    else:
        fields = ["layer", "start", "end"]
        in_events = False
        for raw_line in contents.splitlines():
            line = raw_line.strip()
            if line.startswith("["):
                in_events = line.lower() == "[events]"
                continue
            if not in_events:
                continue
            if line.lower().startswith("format:"):
                fields = [field.strip().lower() for field in line.partition(":")[2].split(",")]
            elif line.lower().startswith("dialogue:") and "end" in fields:
                columns = line.partition(":")[2].split(",", max(0, len(fields) - 1))
                end_index = fields.index("end")
                if end_index < len(columns):
                    end = _subtitle_time_ms(columns[end_index])
                    if end is not None:
                        ends.append(end)
    if not ends or max(ends) <= 0:
        raise MediaToolError("字幕文件没有可用的结束时间，无法确定绿幕视频时长。")
    # Keep half a second after the last cue so its final frame is fully visible.
    frame_count = max(30, math.ceil(max(ends) * 30 / 1000) + 15)
    return (
        ["-f", "lavfi", "-i", f"color=c=0x00ff00:s={width}x{height}:r=30:d={frame_count / 30:.3f}"],
        (width, height),
    )


def run_burn_subtitles(
    request: BurnSubtitleRequest,
    *,
    ffmpeg_path: Path,
    ffprobe_path: Path | None = None,
    cancel_event: Event | None = None,
    on_process: Callable[[subprocess.Popen[str]], None] | None = None,
    on_progress: Callable[[Mapping[str, str]], None] | None = None,
) -> BurnSubtitleResult:
    """Render SRT/ASS subtitles or an .mosp/.json project into a new H.264 MP4.

    SRT 烧录前会转换成临时 ASS 并把样式库样式写入 Default 行；PlayRes 取视频
    实际分辨率（绿幕取所选尺寸档位的画布尺寸），使烧录样式与编辑器预览一致。
    mosp/json 工程输入会临时导出为工程自身基础样式的 ASS（编辑器非 ASS 模式
    导出分支；强调语法、字级动画等完整效果以编辑器导出为准），PlayRes 同样取
    探测到的视频分辨率。
    只有 SRT 与工程输入需要探测 PlayRes；ASS/SSA 沿用自身样式，不启动 ffprobe。
    ``ffprobe_path`` 仅用于读取视频尺寸，缺省时沿 ``ffmpeg_path`` 同目录解析，
    再回退 FFMPEG_PATH/PATH；探测失败回退 1080p 参考坐标系。
    """
    subtitle = _validated_media_path(request.subtitle_path, extensions=BURN_SUBTITLE_EXTENSIONS, label="subtitle")
    green_screen = request.green_screen is True
    include_green_audio = green_screen and request.green_screen_include_audio is True
    media = None
    if not green_screen:
        media = _validated_media_path(request.media_path or Path(""), extensions=VIDEO_EXTENSIONS, label="video")
    elif include_green_audio:
        media = _validated_media_path(
            request.media_path or Path(""), extensions=MEDIA_EXTENSIONS, label="audio/video media"
        )
    crf, preset, audio_bitrate = _burn_encoding_settings(request)
    output_source = subtitle if green_screen else media
    assert output_source is not None
    output = _available_media_output(
        output_source,
        suffix="green-screen" if green_screen else "subtitled",
        extension=".mp4",
    )
    temporary = output.with_name(f"{output.stem}.part{output.suffix}")
    requested_encoder = normalize_video_encoder(request.video_encoder)
    attempts = _video_encoder_attempts(ffmpeg_path, requested_encoder)
    green_input: list[str] = []
    play_resolution: tuple[int, int] = ASS_FALLBACK_PLAY_RESOLUTION
    if green_screen:
        play_resolution = _green_screen_size_resolution(request.green_screen_size)
        if subtitle.suffix.lower() not in PROJECT_SUBTITLE_EXTENSIONS:
            green_input, _ = _green_screen_input(subtitle, play_resolution)
    elif subtitle.suffix.lower() in {".srt", *PROJECT_SUBTITLE_EXTENSIONS}:
        # PlayRes 重写只发生在 SRT 转换与工程导出；ASS/SSA 沿用自身样式，跳过探测。
        # 探测前先看取消标记，避免取消请求时还要等一次 ffprobe。
        if cancel_event is None or not cancel_event.is_set():
            probe_tool = ffprobe_path if ffprobe_path is not None else resolve_ffmpeg_tool(
                "ffprobe", configured_path=ffmpeg_path,
            )
            play_resolution = _probe_play_resolution(media, ffprobe_path=probe_tool)
    prepared_subtitle = subtitle
    converted_subtitle: Path | None = None
    normalized_subtitle: Path | None = None
    font_warnings: list[str] = []
    last_error: MediaToolError | None = None
    try:
        if subtitle.suffix.lower() == ".srt":
            converted_subtitle = convert_srt_to_ass(
                subtitle,
                ffmpeg_path=ffmpeg_path,
                srt_style=request.srt_style,
                play_resolution=play_resolution,
                cancel_event=cancel_event,
                on_process=on_process,
                on_progress=on_progress,
            )
            prepared_subtitle = converted_subtitle
        elif subtitle.suffix.lower() in PROJECT_SUBTITLE_EXTENSIONS:
            converted_subtitle = _convert_project_to_ass(subtitle, play_resolution=play_resolution)
            prepared_subtitle = converted_subtitle
            if green_screen:
                green_input, _ = _green_screen_input(prepared_subtitle, play_resolution)
        # SRT/工程转换产物与用户原始 .ass 输入统一做字体名归一化：libass 只按
        # nameID1 匹配，样式里的排版名（如 Smiley Sans）会被静默回退。有变更
        # 时写归一化临时副本（滤镜指向副本），绝不改用户原文件；表不可用或
        # 无 Style 行时归一化原样返回，走原有文件。
        try:
            source_text = prepared_subtitle.read_text(encoding="utf-8-sig", errors="replace")
            normalized_text, font_warnings = normalize_ass_text_fontnames(source_text)
            if normalized_text != source_text:
                # 与 convert_srt_to_ass 的隐藏临时文件同风格；输入本身已是隐藏
                # 临时产物（stem 以 . 开头）时不再叠加前导点，避免 ".." 前缀。
                stem = prepared_subtitle.stem
                hidden_prefix = stem if stem.startswith(".") else f".{stem}"
                descriptor, temporary_name = tempfile.mkstemp(
                    prefix=f"{hidden_prefix}.maw-fontfix-",
                    suffix=".ass",
                    dir=prepared_subtitle.parent,
                )
                with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
                    handle.write(normalized_text)
                normalized_subtitle = Path(temporary_name)
                prepared_subtitle = normalized_subtitle
        except OSError:
            font_warnings = []
        input_command = [*green_input, "-i", str(media)] if include_green_audio and media is not None else (
            green_input if green_screen else ["-i", str(media)]
        )

        common_command = [
            str(ffmpeg_path),
            "-y",
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "warning",
            "-progress",
            "pipe:1",
            *input_command,
            "-vf",
            _subtitle_filter(prepared_subtitle),
            "-map",
            "0:v:0",
            *(["-map", "1:a?"] if include_green_audio else ([] if green_screen else ["-map", "0:a?", "-map_metadata", "0"])),
        ]
        green_duration = None
        if green_screen:
            duration_match = re.search(r":d=([0-9]+(?:\.[0-9]+)?)", green_input[-1])
            if duration_match is not None:
                green_duration = duration_match.group(1)
        for encoder in attempts:
            temporary.unlink(missing_ok=True)
            command = [
                *common_command,
                *_video_encoder_options(encoder, crf, preset),
                "-pix_fmt",
                "yuv420p",
                *(["-c:a", "aac", "-b:a", audio_bitrate] if include_green_audio else (["-an"] if green_screen else ["-c:a", "aac", "-b:a", audio_bitrate])),
                *(["-t", green_duration] if green_duration is not None else []),
                "-movflags",
                "+faststart",
                str(temporary),
            ]
            try:
                _run_ffmpeg_process(
                    command,
                    cwd=subtitle.parent,
                    cancel_event=cancel_event,
                    on_process=on_process,
                    on_progress=on_progress,
                    check_ass_glyphs=True,
                )
            except MediaToolCancelled:
                raise
            except SubtitleFontGlyphMissingError:
                raise
            except MediaToolError as error:
                last_error = error
                if requested_encoder != "auto" or encoder == "cpu":
                    raise
                continue
            _replace_media_output(temporary, output)
            return BurnSubtitleResult(
                source_media_path=media,
                media_path=output,
                subtitle_path=subtitle,
                video_encoder=encoder,
                warnings=tuple(font_warnings),
            )
        if last_error is not None:
            raise last_error
        raise MediaToolError("没有可用的视频编码器。")
    except (MediaToolError, OSError):
        temporary.unlink(missing_ok=True)
        raise
    finally:
        if converted_subtitle is not None:
            converted_subtitle.unlink(missing_ok=True)
        if normalized_subtitle is not None:
            normalized_subtitle.unlink(missing_ok=True)


def run_extract_audio(
    request: ExtractAudioRequest,
    *,
    ffmpeg_path: Path,
    ffprobe_path: Path,
    cancel_event: Event | None = None,
    on_process: Callable[[subprocess.Popen[str]], None] | None = None,
    on_progress: Callable[[Mapping[str, str]], None] | None = None,
) -> ExtractAudioResult:
    """Extract one audio stream and encode it as a new AAC/M4A file."""
    media = _validated_media_path(request.media_path)
    tracks = probe_audio_tracks(media, ffprobe_path=ffprobe_path)
    if request.audio_index < 0 or request.audio_index >= len(tracks):
        raise MediaToolError("selected audio track does not exist")
    track = tracks[request.audio_index]
    output = _available_media_output(media, suffix="audio", extension=".m4a")
    temporary = output.with_name(f"{output.stem}.part{output.suffix}")
    command = [
        str(ffmpeg_path),
        "-y",
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-progress",
        "pipe:1",
        "-i",
        str(media),
        "-map",
        f"0:{track.stream_index}",
        "-vn",
        "-map_metadata",
        "0",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
        str(temporary),
    ]
    try:
        _run_ffmpeg_process(
            command,
            cwd=media.parent,
            cancel_event=cancel_event,
            on_process=on_process,
            on_progress=on_progress,
        )
        _replace_media_output(temporary, output)
    except (MediaToolError, OSError):
        temporary.unlink(missing_ok=True)
        raise
    return ExtractAudioResult(source_media_path=media, media_path=output, audio_track=track)


def _resolve_file_directive(base: Path, raw_value: str) -> Path:
    value = raw_value.strip()
    if value.startswith("'") and value.endswith("'"):
        value = value[1:-1].replace("'\\''", "'")
    candidate = Path(value)
    if not candidate.is_absolute():
        candidate = base / candidate
    return candidate.expanduser().resolve()


def _available_media_output(media: Path, *, suffix: str = "gap-removed", extension: str | None = None) -> Path:
    output_extension = extension or media.suffix
    display_suffix = media_suffix(suffix)
    candidate = media.with_name(f"{media.stem}.{display_suffix}{output_extension}")
    counter = 2
    while candidate.exists():
        candidate = media.with_name(f"{media.stem}.{display_suffix}-{counter}{output_extension}")
        counter += 1
    return candidate.resolve()


_MEDIA_LABEL_NAMES: Final[dict[str, str]] = {
    "video": "视频文件",
    "subtitle": "字幕文件",
    "media": "媒体文件",
}


def _validated_media_path(
    path: Path,
    *,
    extensions: frozenset[str] = MEDIA_EXTENSIONS,
    label: str = "media",
) -> Path:
    resolved = path.expanduser().resolve()
    name = _MEDIA_LABEL_NAMES.get(label, "媒体文件")
    if not resolved.is_file():
        # 明确区分是视频还是字幕缺失：手动烧录里两个文件都由用户选择，
        # 自动后处理里则都来自流水线上一步，提示需要能定位到具体文件。
        raise MediaToolError(f"{name}不存在：{resolved}")
    if resolved.suffix.lower() not in extensions:
        raise MediaToolError(f"{name}格式不支持：{resolved.suffix or '(无后缀)'}")
    return resolved


def _integer_or_none(value: object) -> int | None:
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return None


def _first_nonempty_tag(tags: Mapping[object, object], *names: str) -> str:
    """Return the first non-empty stream tag, tolerating FFprobe key casing."""
    normalized = {
        str(key).strip().casefold(): value
        for key, value in tags.items()
    }
    for name in names:
        value = str(normalized.get(name.casefold()) or "").strip()
        if value:
            return value
    return ""


def _escape_filter_value(value: str) -> str:
    escaped = value
    for character in ("\\", "'", ":", ",", ";", "[", "]", "="):
        escaped = escaped.replace(character, f"\\{character}")
    return escaped


def _srt_burn_style(srt_style: Mapping[str, object] | None) -> Mapping[str, object]:
    if srt_style is not None:
        return srt_style
    library = load_ass_style_library()
    assignments = library.get("assignments")
    style_id = assignments.get("srtBurnStyleId") if isinstance(assignments, Mapping) else "default"
    return find_ass_style(library, style_id)


def _rewrite_ass_play_resolution(lines: list[str], play_resolution: tuple[int, int]) -> None:
    """Replace (or insert) the converted ASS header's PlayResX/PlayResY.

    FFmpeg 把 SRT 转成 ASS 时写死 PlayResX: 384 / PlayResY: 288；样式库字段
    按 1080p 参考坐标系存储，必须把坐标系一并归一到实际视频分辨率，否则
    libass 会在 288 高的坐标系里解释 86 的字号（视觉放大 1080/288 ≈ 3.75 倍）。
    """
    values = {
        "playresx": f"PlayResX: {play_resolution[0]}",
        "playresy": f"PlayResY: {play_resolution[1]}",
    }
    script_info_index: int | None = None
    for index, line in enumerate(lines):
        key = line.split(":", 1)[0].strip().lower()
        if key in values:
            lines[index] = values.pop(key)
        elif line.strip().lower() == "[script info]":
            script_info_index = index
    if not values:
        return
    if script_info_index is None:
        # 缺段时补写完整段头（PlayRes 属于 [Script Info]，必须位于样式段之前）。
        lines[:0] = ["[Script Info]", values["playresx"], values["playresy"]]
        return
    for name in sorted(values, reverse=True):
        lines.insert(script_info_index + 1, values[name])


def _rewrite_ass_default_style(
    ass_path: Path,
    srt_style: Mapping[str, object] | None,
    *,
    play_resolution: tuple[int, int] = ASS_FALLBACK_PLAY_RESOLUTION,
) -> None:
    try:
        content = ass_path.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeError) as error:
        raise MediaToolError(f"无法读取 FFmpeg 生成的临时 ASS 字幕：{error}") from error
    if not content.strip():
        raise MediaToolError("FFmpeg 生成了空的 ASS 字幕文件。")
    style = {**DEFAULT_SRT_STYLE, **dict(_srt_burn_style(srt_style))}
    # 与编辑器预览/前端 ASS 导出同一约定：库样式字号按 1080p 参考存储，
    # 按目标 PlayResY 等比换算；描边、边距等其余字段保持原值。
    # 前端 Math.round 是 half-up，而 Python round 是银行家舍入，半值
    # （如 540p 的 33 → 16.5）会差 1px，因此先按 half-up 取整再交给
    # _normalize_style（clamp 1..512 与前端 normalizeAssFontSize 一致）。
    style["fontSize"] = math.floor(
        float(style["fontSize"]) * play_resolution[1] / ASS_REFERENCE_PLAY_RES_Y + 0.5,
    )
    replacement = ass_style_line(style, name="Default")
    lines = content.splitlines()
    _rewrite_ass_play_resolution(lines, play_resolution)
    for index, line in enumerate(lines):
        if line.startswith("Style: Default,"):
            lines[index] = replacement
            break
    else:
        raise MediaToolError("FFmpeg 生成的 ASS 字幕缺少 Default 样式。")
    try:
        with ass_path.open("w", encoding="utf-8", newline="\n") as handle:
            handle.write("\n".join(lines) + "\n")
    except (OSError, UnicodeError) as error:
        raise MediaToolError(f"无法写入临时 ASS 字幕：{error}") from error


def _probe_play_resolution(media: Path | None, *, ffprobe_path: Path | None) -> tuple[int, int]:
    """Burn PlayRes from the video dimensions; probe failure falls back to 1080p.

    编辑器预览与前端 ASS 导出都用实际视频分辨率作 PlayRes（media_metadata 的
    video_width/height 由同一个 probe_video_fps 产出），这里复用同一探测，
    保证烧录结果与预览一致。
    """
    if media is None:
        return ASS_FALLBACK_PLAY_RESOLUTION
    metadata = probe_video_fps(media, ffprobe_path=ffprobe_path)
    width = metadata.get("video_width") if metadata else None
    height = metadata.get("video_height") if metadata else None
    if isinstance(width, int) and isinstance(height, int) and width > 0 and height > 0:
        return width, height
    return ASS_FALLBACK_PLAY_RESOLUTION


def convert_srt_to_ass(
    subtitle: Path,
    *,
    ffmpeg_path: Path,
    srt_style: Mapping[str, object] | None,
    play_resolution: tuple[int, int],
    cancel_event: Event | None = None,
    on_process: Callable[[subprocess.Popen[str]], None] | None = None,
    on_progress: Callable[[Mapping[str, str]], None] | None = None,
    run_command: Callable[..., subprocess.CompletedProcess[str]] | None = None,
) -> Path:
    """Convert SRT using the shared burn style; optionally own it in a media job."""
    try:
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{subtitle.stem}.maw-burn-",
            suffix=".ass",
            dir=subtitle.parent,
        )
        os.close(descriptor)
    except OSError as error:
        raise MediaToolError(f"无法创建临时 ASS 字幕：{error}") from error
    converted = Path(temporary_name)
    command = [
        str(ffmpeg_path),
        "-y",
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-progress",
        "pipe:1",
        "-i",
        str(subtitle),
        "-map",
        "0:0",
        "-c:s",
        "ass",
        "-f",
        "ass",
        str(converted),
    ]
    try:
        if run_command is None:
            _run_ffmpeg_process(
                command, cwd=subtitle.parent, cancel_event=cancel_event,
                on_process=on_process, on_progress=on_progress,
            )
        else:
            completed = run_command(command, cwd=subtitle.parent)
            if completed.returncode:
                raise MediaToolError(completed.stderr or "SRT 转换为 ASS 失败")
        _rewrite_ass_default_style(converted, srt_style, play_resolution=play_resolution)
    except (MediaToolError, OSError, subprocess.SubprocessError):
        converted.unlink(missing_ok=True)
        raise
    return converted


def _convert_project_to_ass(project_path: Path, *, play_resolution: tuple[int, int]) -> Path:
    """Export an .mosp/.json project to a temporary basic-style ASS for burning."""

    try:
        project, title = load_burn_project(project_path)
    except ProjectSubtitleError as error:
        raise MediaToolError(str(error)) from error
    temporary_name: str | None = None
    descriptor: int | None = None
    try:
        content = render_project_ass(project, title=title, play_resolution=play_resolution)
    except ProjectSubtitleError as error:
        raise MediaToolError(str(error)) from error
    try:
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{project_path.stem}.maw-burn-",
            suffix=".ass",
            dir=project_path.parent,
        )
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            descriptor = None
            handle.write(content)
    except OSError as error:
        if descriptor is not None:
            with suppress(OSError):
                os.close(descriptor)
        if temporary_name is not None:
            with suppress(OSError):
                Path(temporary_name).unlink(missing_ok=True)
        raise MediaToolError(f"无法创建临时 ASS 字幕：{error}") from error
    assert temporary_name is not None
    return Path(temporary_name)


def _burn_encoding_settings(request: BurnSubtitleRequest) -> tuple[int, str, str]:
    """Return validated (crf, preset, audio_bitrate), falling back to defaults."""
    crf = DEFAULT_BURN_CRF if request.crf is None else request.crf
    if not MIN_BURN_CRF <= crf <= MAX_BURN_CRF:
        raise MediaToolError(f"CRF must be an integer between {MIN_BURN_CRF} and {MAX_BURN_CRF}")
    preset = DEFAULT_BURN_PRESET if not str(request.preset or "").strip() else str(request.preset).strip()
    if preset not in X264_PRESETS:
        raise MediaToolError(f"unsupported x264 preset: {preset}")
    audio_bitrate = DEFAULT_BURN_AUDIO_BITRATE if not str(request.audio_bitrate or "").strip() else str(request.audio_bitrate).strip()
    if audio_bitrate not in AUDIO_BITRATES:
        raise MediaToolError(f"unsupported audio bitrate: {audio_bitrate}")
    return crf, preset, audio_bitrate


def _subtitle_filter(
    subtitle: Path,
    srt_style: Mapping[str, object] | None = None,
) -> str:
    filename = _escape_filter_value(subtitle.name)
    if subtitle.suffix.lower() in {".ass", ".ssa"}:
        return f"ass=filename='{filename}'"
    style = _srt_burn_style(srt_style)
    # force_style 内部的逗号/等号是 ASS 样式语法层；整个表达式还要作为
    # 单引号 filter 参数再转义一层，否则 O'Brien 这类字体会截断引号、
    # 破坏整个 -vf 滤镜链。
    force_style = _escape_filter_value(ass_style_force_style(style))
    return f"subtitles=filename='{filename}':force_style='{force_style}'"


def _run_ffmpeg_process(
    command: list[str],
    *,
    cwd: Path,
    cancel_event: Event | None,
    on_process: Callable[[subprocess.Popen[str]], None] | None,
    on_progress: Callable[[Mapping[str, str]], None] | None,
    check_ass_glyphs: bool = False,
) -> None:
    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            cwd=str(cwd),
            startupinfo=startupinfo(),
            creationflags=creationflags(),
        )
    except OSError as error:
        raise MediaToolError(f"ffmpeg could not start: {error}") from error
    if on_process is not None:
        on_process(process)
    stderr_chunks: list[str] = []

    def collect_stderr() -> None:
        if process.stderr is not None:
            stderr_chunks.extend(process.stderr)

    stderr_thread = Thread(target=collect_stderr, daemon=True)
    stderr_thread.start()
    progress: dict[str, str] = {}
    try:
        stdout = process.stdout
        while stdout is not None:
            if cancel_event is not None and cancel_event.is_set():
                terminate_process_tree(process)
                raise MediaToolCancelled("ffmpeg operation cancelled")
            line = stdout.readline()
            if line:
                key, separator, value = line.rstrip("\r\n").partition("=")
                if separator:
                    progress[key] = value
                    if key == "progress" and on_progress is not None:
                        on_progress(dict(progress))
                        progress.clear()
                continue
            if process.poll() is not None:
                break
        returncode = process.wait()
        stderr_thread.join()
    except MediaToolCancelled:
        raise
    except OSError as error:
        if process.poll() is None:
            terminate_process_tree(process)
        raise MediaToolError(f"ffmpeg failed: {error}") from error
    finally:
        if stderr_thread.is_alive():
            stderr_thread.join(timeout=5)
        release_process_tree(process)
    stderr = "".join(stderr_chunks)
    if cancel_event is not None and cancel_event.is_set():
        raise MediaToolCancelled("ffmpeg operation cancelled")
    if check_ass_glyphs:
        for glyph, family in libass_missing_glyphs(stderr):
            raise SubtitleFontGlyphMissingError(
                f"字幕字体「{family}」缺少字形{glyph}，已中止烧录以避免输出方框。"
                "请安装或更换为包含该字符的字体后重试。"
            )
    if returncode != 0:
        detail = (stderr or "ffmpeg operation failed").strip()
        raise MediaToolError(detail[-4000:])


def _replace_media_output(temporary: Path, output: Path) -> None:
    if not temporary.exists():
        raise MediaToolError("ffmpeg did not produce a media file")
    if temporary.stat().st_size == 0:
        temporary.unlink(missing_ok=True)
        raise MediaToolError("ffmpeg produced an empty media file")
    os.replace(temporary, output)
