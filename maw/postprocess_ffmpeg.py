# pyright: reportImplicitOverride=false

"""Validated FFmpeg media operations for the Launcher toolbox."""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
from dataclasses import dataclass
from threading import Event
from pathlib import Path
from typing import Callable, Final, Mapping

from maw.gui_platform import creationflags, release_process_tree, startupinfo, terminate_process_tree
from maw.output_naming import media_suffix
from maw.ass_styles import DEFAULT_SRT_STYLE, ass_style_force_style, ass_style_line, find_ass_style, load_ass_style_library


ALLOWED_DIRECTIVES: Final = frozenset({"ffconcat", "file", "inpoint", "outpoint", "duration"})
VIDEO_EXTENSIONS: Final = frozenset({".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".ts", ".m4v"})
MEDIA_EXTENSIONS: Final = frozenset((*VIDEO_EXTENSIONS, ".mp3", ".wav", ".m4a", ".flac", ".aac", ".ogg"))
SUBTITLE_EXTENSIONS: Final = frozenset({".srt", ".ass", ".ssa"})
X264_PRESETS: Final = frozenset({"veryfast", "fast", "medium", "slow", "veryslow"})
AUDIO_BITRATES: Final = frozenset({"96k", "128k", "160k", "192k", "224k", "256k", "320k"})
MIN_BURN_CRF: Final = 0
MAX_BURN_CRF: Final = 51
DEFAULT_BURN_CRF: Final = 18
DEFAULT_BURN_PRESET: Final = "medium"
DEFAULT_BURN_AUDIO_BITRATE: Final = "192k"
VIDEO_ENCODER_MODES: Final[frozenset[str]] = frozenset({"auto", "cpu", "nvenc", "amf", "qsv"})
VIDEO_ENCODER_CODECS: Final[dict[str, str]] = {
    "nvenc": "h264_nvenc",
    "amf": "h264_amf",
    "qsv": "h264_qsv",
}
AUTO_VIDEO_ENCODER_ORDER: Final[tuple[str, ...]] = ("nvenc", "amf", "qsv", "cpu")


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
    media_path: Path
    subtitle_path: Path
    # Optional normalized style supplied by a caller; when omitted, the
    # shared user-level SRT default slot is loaded automatically.
    srt_style: Mapping[str, object] | None = None
    video_encoder: str = "auto"
    # Optional encoding overrides exposed by the toolbox UI; None keeps the
    # built-in defaults (CRF 18 / preset medium / audio 192k). CRF 与音频码率
    # 对所有编码器生效（硬件编码器映射到 cq/qp/global_quality）；preset 仅
    # libx264 支持，硬件编码器使用各自的固定预设。
    crf: int | None = None
    preset: str | None = None
    audio_bitrate: str | None = None


@dataclass(frozen=True, slots=True)
class BurnSubtitleResult:
    source_media_path: Path
    media_path: Path
    subtitle_path: Path
    video_encoder: str


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
        return ()
    tracks: list[AudioTrack] = []
    for audio_index, stream in enumerate(streams):
        if not isinstance(stream, Mapping):
            continue
        tags = stream.get("tags") if isinstance(stream.get("tags"), Mapping) else {}
        disposition = stream.get("disposition") if isinstance(stream.get("disposition"), Mapping) else {}
        stream_index = _integer_or_none(stream.get("index"))
        if stream_index is None:
            continue
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


def run_burn_subtitles(
    request: BurnSubtitleRequest,
    *,
    ffmpeg_path: Path,
    cancel_event: Event | None = None,
    on_process: Callable[[subprocess.Popen[str]], None] | None = None,
    on_progress: Callable[[Mapping[str, str]], None] | None = None,
) -> BurnSubtitleResult:
    """Render SRT/ASS subtitles into a new H.264 MP4."""
    media = _validated_media_path(request.media_path, extensions=VIDEO_EXTENSIONS, label="video")
    subtitle = _validated_media_path(request.subtitle_path, extensions=SUBTITLE_EXTENSIONS, label="subtitle")
    crf, preset, audio_bitrate = _burn_encoding_settings(request)
    output = _available_media_output(media, suffix="subtitled", extension=".mp4")
    temporary = output.with_name(f"{output.stem}.part{output.suffix}")
    requested_encoder = normalize_video_encoder(request.video_encoder)
    attempts = _video_encoder_attempts(ffmpeg_path, requested_encoder)
    prepared_subtitle = subtitle
    converted_subtitle: Path | None = None
    last_error: MediaToolError | None = None
    try:
        if subtitle.suffix.lower() == ".srt":
            converted_subtitle = _convert_srt_to_ass(
                subtitle,
                ffmpeg_path=ffmpeg_path,
                srt_style=request.srt_style,
                cancel_event=cancel_event,
                on_process=on_process,
                on_progress=on_progress,
            )
            prepared_subtitle = converted_subtitle
        common_command = [
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
            "-vf",
            _subtitle_filter(prepared_subtitle),
            "-map",
            "0:v:0",
            "-map",
            "0:a?",
            "-map_metadata",
            "0",
        ]
        for encoder in attempts:
            temporary.unlink(missing_ok=True)
            command = [
                *common_command,
                *_video_encoder_options(encoder, crf, preset),
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-b:a",
                audio_bitrate,
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
                )
            except MediaToolCancelled:
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


def _rewrite_ass_default_style(ass_path: Path, srt_style: Mapping[str, object] | None) -> None:
    try:
        content = ass_path.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeError) as error:
        raise MediaToolError(f"无法读取 FFmpeg 生成的临时 ASS 字幕：{error}") from error
    if not content.strip():
        raise MediaToolError("FFmpeg 生成了空的 ASS 字幕文件。")
    style = {**DEFAULT_SRT_STYLE, **dict(_srt_burn_style(srt_style))}
    replacement = ass_style_line(style, name="Default")
    lines = content.splitlines()
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


def _convert_srt_to_ass(
    subtitle: Path,
    *,
    ffmpeg_path: Path,
    srt_style: Mapping[str, object] | None,
    cancel_event: Event | None,
    on_process: Callable[[subprocess.Popen[str]], None] | None,
    on_progress: Callable[[Mapping[str, str]], None] | None,
) -> Path:
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
        _run_ffmpeg_process(
            command,
            cwd=subtitle.parent,
            cancel_event=cancel_event,
            on_process=on_process,
            on_progress=on_progress,
        )
        _rewrite_ass_default_style(converted, srt_style)
    except (MediaToolError, OSError):
        converted.unlink(missing_ok=True)
        raise
    return converted


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
        stderr = process.stderr.read() if process.stderr is not None else ""
        returncode = process.wait()
    except MediaToolCancelled:
        raise
    except OSError as error:
        if process.poll() is None:
            terminate_process_tree(process)
        raise MediaToolError(f"ffmpeg failed: {error}") from error
    finally:
        release_process_tree(process)
    if cancel_event is not None and cancel_event.is_set():
        raise MediaToolCancelled("ffmpeg operation cancelled")
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
