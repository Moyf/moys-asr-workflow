"""Shared media-path resolution for MAW project loading."""

from __future__ import annotations

import os
import re
import struct
import subprocess
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any

from maw.ffmpeg import resolve_ffmpeg_tool
from maw.workspace_paths import cache_directory


class MediaStatus(str, Enum):
    SUCCESS = "success"
    MISSING = "missing"
    UNSUPPORTED = "unsupported"
    CONVERSION_NEEDED = "conversion_needed"
    CONFLICT = "conflict"


VIDEO_EXTENSIONS = frozenset({
    ".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".ts", ".m4v",
})
AUDIO_EXTENSIONS = frozenset({
    ".wav", ".mp3", ".m4a", ".aac", ".ogg", ".flac", ".opus",
})
MEDIA_EXTENSIONS = VIDEO_EXTENSIONS | AUDIO_EXTENSIONS
CONVERSION_EXTENSIONS = frozenset({".flv"})


def read_bwf_time_reference(path: Path) -> dict[str, int] | None:
    """Read the BWF bext media origin from a WAV file.

    The time_reference field is the sample position of the first sample on
    the source timeline. It is deliberately kept as sample units here; the
    editor converts it to its fixed 60 fps OTIO rate. Non-BWF WAV files and
    malformed or unreadable files return None so media loading remains
    optional metadata enrichment.
    """

    if path.suffix.lower() != ".wav":
        return None
    try:
        with path.open("rb") as stream:
            header = stream.read(12)
            if (
                len(header) != 12
                or header[0:4] not in {b"RIFF", b"RF64"}
                or header[8:12] != b"WAVE"
            ):
                return None

            sample_rate: int | None = None
            time_reference: int | None = None
            while True:
                chunk_header = stream.read(8)
                if len(chunk_header) != 8:
                    break
                chunk_id = chunk_header[0:4]
                chunk_size = struct.unpack("<I", chunk_header[4:8])[0]
                payload_size = min(chunk_size, 346 if chunk_id == b"bext" else 8)
                payload = stream.read(payload_size)
                if len(payload) != payload_size:
                    break
                if chunk_size > payload_size:
                    stream.seek(chunk_size - payload_size, os.SEEK_CUR)
                if chunk_size % 2:
                    stream.seek(1, os.SEEK_CUR)

                if chunk_id == b"fmt " and chunk_size >= 8:
                    sample_rate = struct.unpack("<I", payload[4:8])[0]
                elif chunk_id == b"bext" and chunk_size >= 346:
                    low, high = struct.unpack("<II", payload[338:346])
                    time_reference = low | (high << 32)

                if sample_rate and time_reference is not None:
                    return {
                        "sample_rate": sample_rate,
                        "time_reference_samples": time_reference,
                    }
    except (OSError, struct.error, ValueError):
        return None
    return None


@dataclass(frozen=True, slots=True)
class MediaResolution:
    status: MediaStatus
    project_path: Path
    requested_path: Path | None = None
    resolved_path: Path | None = None
    candidates: tuple[Path, ...] = ()
    message: str = ""

    @property
    def loadable(self) -> bool:
        return self.resolved_path is not None and self.status in {
            MediaStatus.SUCCESS,
            MediaStatus.CONVERSION_NEEDED,
        }

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status.value,
            "projectPath": str(self.project_path),
            "requestedPath": str(self.requested_path) if self.requested_path else "",
            "resolvedPath": str(self.resolved_path) if self.resolved_path else "",
            "candidates": [str(path) for path in self.candidates],
            "message": self.message,
        }


class MediaResolutionError(ValueError):
    def __init__(self, resolution: MediaResolution) -> None:
        self.resolution = resolution
        super().__init__(resolution.message or resolution.status.value)


class MediaConversionError(ValueError):
    """The source media was found, but could not be prepared for browser playback."""


def find_ffmpeg(configured_path: str | os.PathLike[str] | None = None) -> Path | None:
    """Find FFmpeg through the shared application-wide resolver."""
    return resolve_ffmpeg_tool("ffmpeg", configured_path)


def _conversion_output_path(source: Path, cache_dir: Path | None = None) -> Path:
    """Return the persistent playback file for a source.

    Production conversions live in the source media's MAW cache directory.
    ``cache_dir`` remains available for isolated tests and callers that
    explicitly want a separate cache root.
    """

    if cache_dir is None:
        cache_dir = cache_directory(source)
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir / f"{source.stem}.mp4"


def _conversion_temp_path(output: Path, attempt: int) -> Path:
    return output.with_name(f"{output.stem}.part-{attempt}{output.suffix}")


def _is_conversion_temp_file(path: Path, output: Path) -> bool:
    if path.suffix.lower() != output.suffix.lower():
        return False
    if path.name in {_conversion_temp_path(output, 0).name, _conversion_temp_path(output, 1).name}:
        return True
    legacy = re.fullmatch(rf"{re.escape(output.stem)}\.part-\d+-\d+-\d+{re.escape(output.suffix)}", path.name, re.IGNORECASE)
    return legacy is not None


def _cleanup_conversion_temp_files(output: Path) -> None:
    try:
        entries = tuple(output.parent.iterdir())
    except OSError:
        return
    for path in entries:
        if path.is_file() and _is_conversion_temp_file(path, output):
            try:
                path.unlink()
            except OSError:
                pass


def _valid_media_file(path: Path) -> bool:
    try:
        return path.is_file() and path.stat().st_size > 0
    except OSError:
        return False


def _paired_mp4(path: Path) -> Path | None:
    if path.suffix.lower() != ".flv":
        return None
    candidate = path.with_suffix(".mp4")
    return candidate.resolve() if _valid_media_file(candidate) else None


def convert_media_for_browser(
    source: Path,
    *,
    ffmpeg_path: str | os.PathLike[str] | None = None,
    cache_dir: Path | None = None,
) -> Path:
    """Remux/transcode a browser-incompatible source into a cached MP4."""

    source = source.expanduser().resolve()
    if source.suffix.lower() not in CONVERSION_EXTENSIONS:
        return source
    if cache_dir is None:
        legacy_output = source.with_suffix(".mp4")
        _cleanup_conversion_temp_files(legacy_output)
        if _valid_media_file(legacy_output):
            return legacy_output
    output = _conversion_output_path(source, cache_dir)
    _cleanup_conversion_temp_files(output)
    if _valid_media_file(output):
        return output

    executable = find_ffmpeg(ffmpeg_path)
    if executable is None:
        raise MediaConversionError(
            "检测到 FLV 媒体，但找不到 FFmpeg；请配置 FFMPEG_PATH 或将 ffmpeg 加入 PATH"
        )

    commands = (
        [
            str(executable), "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
            "-i", str(source), "-map", "0:v:0?", "-map", "0:a:0?", "-c", "copy",
            "-movflags", "+faststart", str(output),
        ],
        [
            str(executable), "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
            "-i", str(source), "-map", "0:v:0?", "-map", "0:a:0?", "-c:v", "libx264",
            "-preset", "ultrafast", "-c:a", "aac", "-movflags", "+faststart", str(output),
        ],
    )
    errors: list[str] = []
    for attempt, command in enumerate(commands):
        temporary = _conversion_temp_path(output, attempt)
        command = [*command[:-1], str(temporary)]
        try:
            result = subprocess.run(
                command, capture_output=True, text=True, encoding="utf-8", errors="replace",
            )
        except OSError as error:
            temporary.unlink(missing_ok=True)
            raise MediaConversionError(f"启动 FFmpeg 失败：{error}") from error

        if _valid_media_file(output):
            temporary.unlink(missing_ok=True)
            return output

        if result.returncode == 0 and _valid_media_file(temporary):
            # os.replace is atomic on the same volume and also tolerates a
            # same-name result created by a concurrent conversion.
            try:
                os.replace(temporary, output)
                return output
            except OSError as error:
                if _valid_media_file(output):
                    temporary.unlink(missing_ok=True)
                    return output
                temporary.unlink(missing_ok=True)
                errors.append(f"替换转换缓存失败：{error}")
                continue

        temporary.unlink(missing_ok=True)
        detail = (result.stderr or result.stdout or "FFmpeg 未生成可播放文件").strip()
        errors.append(f"FFmpeg 退出码 {result.returncode}：{detail[-1000:]}")
    raise MediaConversionError(
        f"FFmpeg 无法将 {source.name} 转换为浏览器可播放的 MP4：{errors[-1]}"
    )


def _path_from_value(value: str, base_dir: Path, *, cwd_relative: bool = False) -> Path:
    path = Path(value).expanduser()
    if path.is_absolute():
        return path.resolve()
    return (Path.cwd() if cwd_relative else base_dir / path).resolve()


def _media_stem(value: str) -> str:
    stem = Path(value).stem
    lowered = stem.lower()
    for tag in (
        ".qwen3-asr.", ".qwen3-asr-api.", ".funasr.", ".glm-asr.",
        ".paraformer.", ".sensevoice.", ".nano.",
    ):
        index = lowered.find(tag)
        if index >= 0:
            return lowered[:index]
    return lowered


def _classify_existing(
    project_path: Path,
    path: Path,
    *,
    requested_path: Path | None = None,
) -> MediaResolution:
    suffix = path.suffix.lower()
    if suffix not in MEDIA_EXTENSIONS:
        return MediaResolution(
            MediaStatus.UNSUPPORTED,
            project_path,
            requested_path=requested_path or path,
            message=f"不支持的媒体格式：{path.suffix or '无扩展名'}",
        )
    status = MediaStatus.CONVERSION_NEEDED if suffix in CONVERSION_EXTENSIONS else MediaStatus.SUCCESS
    message = "flv 无法预览，将会自动转换成 mp4 格式" if status is MediaStatus.CONVERSION_NEEDED else ""
    return MediaResolution(
        status,
        project_path,
        requested_path=requested_path or path,
        resolved_path=path,
        message=message,
    )


def _same_name_candidates(project_path: Path, data: dict[str, Any]) -> tuple[Path, ...]:
    raw_media = data.get("media")
    source_name = Path(str(raw_media)).name if isinstance(raw_media, str) and raw_media.strip() else project_path.name
    expected_stem = _media_stem(source_name)
    if not expected_stem:
        return ()
    try:
        entries = project_path.parent.iterdir()
    except OSError:
        return ()
    candidates = [
        path.resolve()
        for path in entries
        if path.is_file()
        and path.suffix.lower() in MEDIA_EXTENSIONS
        and _media_stem(path.name) == expected_stem
    ]
    return tuple(sorted(candidates, key=lambda path: path.name.casefold()))


def resolve_project_media(
    project_path: Path,
    data: dict[str, Any],
    explicit_media: str | None = None,
) -> MediaResolution:
    """Resolve explicit/project media, then one exact same-stem local fallback."""

    project_path = project_path.expanduser().resolve()
    base_dir = project_path.parent

    if explicit_media:
        requested = _path_from_value(explicit_media, base_dir, cwd_relative=True)
        if not requested.is_file():
            return MediaResolution(
                MediaStatus.MISSING,
                project_path,
                requested_path=requested,
                message=f"找不到指定媒体文件：{requested}",
            )
        paired = _paired_mp4(requested)
        return _classify_existing(project_path, paired or requested, requested_path=requested)

    raw_media = data.get("media")
    requested: Path | None = None
    if isinstance(raw_media, str) and raw_media.strip():
        requested = _path_from_value(raw_media.strip(), base_dir)
        if requested.is_file():
            paired = _paired_mp4(requested)
            return _classify_existing(project_path, paired or requested, requested_path=requested)

    candidates = _same_name_candidates(project_path, data)
    if requested and requested.suffix.lower() == ".flv":
        mp4_candidates = tuple(path for path in candidates if path.suffix.lower() == ".mp4")
        if len(mp4_candidates) == 1:
            return _classify_existing(project_path, mp4_candidates[0], requested_path=requested)
    if any(path.suffix.lower() == ".flv" for path in candidates):
        mp4_candidates = tuple(path for path in candidates if path.suffix.lower() == ".mp4")
        if len(mp4_candidates) == 1:
            return _classify_existing(project_path, mp4_candidates[0], requested_path=requested)
    if len(candidates) == 1:
        return _classify_existing(project_path, candidates[0], requested_path=requested)
    if len(candidates) > 1:
        return MediaResolution(
            MediaStatus.CONFLICT,
            project_path,
            requested_path=requested,
            candidates=candidates,
            message="工程目录存在多个同名媒体文件，请手动指定一个",
        )
    return MediaResolution(
        MediaStatus.MISSING,
        project_path,
        requested_path=requested,
        message="找不到工程关联媒体文件，请手动指定媒体",
    )
