# pyright: reportImplicitOverride=false

"""Validated FFmpeg media operations for the Launcher toolbox."""

from __future__ import annotations

import json
import os
import re
import subprocess
from dataclasses import dataclass
from threading import Event
from pathlib import Path
from typing import Callable, Final, Mapping

from maw.gui_platform import creationflags, release_process_tree, startupinfo, terminate_process_tree


ALLOWED_DIRECTIVES: Final = frozenset({"ffconcat", "file", "inpoint", "outpoint", "duration"})
VIDEO_EXTENSIONS: Final = frozenset({".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".ts", ".m4v"})
MEDIA_EXTENSIONS: Final = frozenset((*VIDEO_EXTENSIONS, ".mp3", ".wav", ".m4a", ".flac", ".aac", ".ogg"))
SUBTITLE_EXTENSIONS: Final = frozenset({".srt", ".ass", ".ssa"})


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


@dataclass(frozen=True, slots=True)
class BurnSubtitleResult:
    source_media_path: Path
    media_path: Path
    subtitle_path: Path


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
        "stream=index,codec_name,channels,sample_rate:stream_tags=language,title:stream_disposition=default",
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
                title=str(tags.get("title") or "").strip(),
                default=bool(_integer_or_none(disposition.get("default")) or 0),
            )
        )
    return tuple(tracks)


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
    output = _available_media_output(media, suffix="subtitled", extension=".mp4")
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
        "-vf",
        _subtitle_filter(subtitle),
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-map_metadata",
        "0",
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
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
            cwd=subtitle.parent,
            cancel_event=cancel_event,
            on_process=on_process,
            on_progress=on_progress,
        )
        _replace_media_output(temporary, output)
    except (MediaToolError, OSError):
        temporary.unlink(missing_ok=True)
        raise
    return BurnSubtitleResult(source_media_path=media, media_path=output, subtitle_path=subtitle)


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
    candidate = media.with_name(f"{media.stem}.{suffix}{output_extension}")
    counter = 2
    while candidate.exists():
        candidate = media.with_name(f"{media.stem}.{suffix}-{counter}{output_extension}")
        counter += 1
    return candidate.resolve()


def _validated_media_path(
    path: Path,
    *,
    extensions: frozenset[str] = MEDIA_EXTENSIONS,
    label: str = "media",
) -> Path:
    resolved = path.expanduser().resolve()
    if not resolved.is_file():
        raise MediaToolError(f"{label} must be an existing file")
    if resolved.suffix.lower() not in extensions:
        raise MediaToolError(f"unsupported {label} extension: {resolved.suffix or '(none)'}")
    return resolved


def _integer_or_none(value: object) -> int | None:
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return None


def _escape_filter_value(value: str) -> str:
    escaped = value
    for character in ("\\", "'", ":", ",", ";", "[", "]", "="):
        escaped = escaped.replace(character, f"\\{character}")
    return escaped


def _subtitle_filter(subtitle: Path) -> str:
    filename = _escape_filter_value(subtitle.name)
    if subtitle.suffix.lower() in {".ass", ".ssa"}:
        return f"ass=filename='{filename}'"
    force_style = "Fontname=Arial,FontSize=18,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=40"
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
