"""Resolve the FFmpeg tools used by every MAW media entry point.

The application can run from source, from a PyInstaller bundle, or with a
user-supplied FFmpeg installation.  Keeping the lookup order here prevents a
waveform generated in-process from seeing a different binary than a CLI or a
post-processing worker launched by the same application.
"""

from __future__ import annotations

import os
import shutil
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Final


FFMPEG_PATH_ENV: Final = "FFMPEG_PATH"
MACOS_FFMPEG_CANDIDATE_DIRECTORIES: Final[tuple[str, ...]] = (
    "/opt/homebrew/bin",
    "/usr/local/bin",
)
FFMPEG_TOOL_NAMES: Final[tuple[str, ...]] = ("ffmpeg", "ffprobe")


@dataclass(frozen=True, slots=True)
class FfmpegTools:
    """The independently resolved FFmpeg and FFprobe executables."""

    ffmpeg: Path | None = None
    ffprobe: Path | None = None

    @property
    def complete(self) -> bool:
        """Whether both tools are available."""
        return self.ffmpeg is not None and self.ffprobe is not None

    @property
    def directory(self) -> Path | None:
        """Return the directory containing FFmpeg, when FFmpeg is available."""
        return self.ffmpeg.parent if self.ffmpeg is not None else None


def _tool_filename(tool: str) -> str:
    normalized = tool.strip().lower()
    if normalized not in FFMPEG_TOOL_NAMES:
        raise ValueError(f"unsupported FFmpeg tool: {tool}")
    return normalized + (".exe" if os.name == "nt" else "")


def _canonical_path(path: Path) -> Path:
    try:
        return path.expanduser().resolve()
    except OSError:
        return path.expanduser()


def _existing_file(path: Path) -> Path | None:
    try:
        return _canonical_path(path) if path.is_file() else None
    except OSError:
        return None


def _configured_tool_path(value: str | os.PathLike[str], tool: str) -> Path:
    """Map an FFmpeg setting to one executable path.

    ``FFMPEG_PATH`` historically accepted either the executable itself or its
    containing directory.  A non-existing value whose basename is ``ffmpeg``
    or ``ffprobe`` is treated as an executable too; this keeps explicit paths
    useful for callers that validate/start the process themselves.
    """
    candidate = Path(value).expanduser()
    tool_name = _tool_filename(tool)
    basename = candidate.name.lower()
    if candidate.is_dir() or basename not in {
        "ffmpeg",
        "ffmpeg.exe",
        "ffprobe",
        "ffprobe.exe",
    }:
        return candidate / tool_name
    if basename in {"ffmpeg", "ffmpeg.exe"}:
        return candidate if tool == "ffmpeg" else candidate.with_name(_tool_filename("ffprobe"))
    return candidate if tool == "ffprobe" else candidate.with_name(_tool_filename("ffmpeg"))


def _configured_candidates(value: str | os.PathLike[str]) -> tuple[Path, Path]:
    return (
        _configured_tool_path(value, "ffmpeg"),
        _configured_tool_path(value, "ffprobe"),
    )


def ffmpeg_search_path(
    path: str | None = None,
    *,
    platform: str | None = None,
    macos_directories: Sequence[str | os.PathLike[str]] = MACOS_FFMPEG_CANDIDATE_DIRECTORIES,
) -> str | None:
    """Return a PATH suitable for FFmpeg lookup and child processes."""
    current = os.environ.get("PATH", "") if path is None else path
    entries = [entry for entry in current.split(os.pathsep) if entry]
    if (sys.platform if platform is None else platform) == "darwin":
        for directory in macos_directories:
            normalized = str(directory)
            if normalized not in entries:
                entries.append(normalized)
    return os.pathsep.join(entries) or None


def bundled_ffmpeg_directories(
    *,
    executable: str | os.PathLike[str] | None = None,
    frozen: bool | None = None,
    candidates: Sequence[str | os.PathLike[str]] = (),
) -> tuple[Path, ...]:
    """Return possible ``ffmpeg/bin`` directories in a frozen/source bundle."""
    result: list[Path] = [Path(candidate).expanduser() for candidate in candidates]
    is_frozen = bool(getattr(sys, "frozen", False) if frozen is None else frozen)
    if is_frozen:
        executable_path = _canonical_path(Path(executable or sys.executable))
        result.insert(0, executable_path.parent / "ffmpeg" / "bin")

    resource_root = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[1]))
    result.append(resource_root / "ffmpeg" / "bin")

    unique: list[Path] = []
    seen: set[Path] = set()
    for directory in result:
        normalized = _canonical_path(directory)
        if normalized in seen:
            continue
        seen.add(normalized)
        unique.append(normalized)
    return tuple(unique)


def bundled_ffmpeg_directory(
    *,
    executable: str | os.PathLike[str] | None = None,
    frozen: bool | None = None,
    candidates: Sequence[str | os.PathLike[str]] = (),
) -> Path | None:
    """Return the first bundled directory containing both FFmpeg tools."""
    ffmpeg_name = _tool_filename("ffmpeg")
    ffprobe_name = _tool_filename("ffprobe")
    for directory in bundled_ffmpeg_directories(
        executable=executable,
        frozen=frozen,
        candidates=candidates,
    ):
        if _existing_file(directory / ffmpeg_name) and _existing_file(directory / ffprobe_name):
            return directory
    return None


def _environment_value(environment: Mapping[str, str] | None, key: str) -> str:
    values = os.environ if environment is None else environment
    return str(values.get(key, "") or "").strip()


def resolve_ffmpeg_tools(
    configured_path: str | os.PathLike[str] | None = None,
    *,
    environment: Mapping[str, str] | None = None,
    search_path: str | None = None,
    platform: str | None = None,
    bundled_directories: Sequence[str | os.PathLike[str]] | None = None,
    include_bundled: bool = True,
    include_macos: bool = True,
    macos_directories: Sequence[str | os.PathLike[str]] = MACOS_FFMPEG_CANDIDATE_DIRECTORIES,
    strict_config: bool = False,
) -> FfmpegTools:
    """Resolve FFmpeg and FFprobe using one shared lookup order.

    Lookup order is explicit setting, ``FFMPEG_PATH``, bundled binaries,
    macOS Homebrew locations, and finally PATH.  A configured directory may
    contain only one tool; each tool then continues through the remaining
    candidates so waveform-only operations remain usable without FFprobe.
    ``strict_config`` is used by the GUI's "save path" validation: an invalid
    explicit override must be reported instead of silently accepting PATH.
    """
    values = os.environ if environment is None else environment
    configured_value = str(configured_path or "").strip() or _environment_value(values, FFMPEG_PATH_ENV)
    configured_candidates = _configured_candidates(configured_value) if configured_value else ()

    candidates: list[tuple[Path, Path]] = []
    if configured_candidates:
        candidates.append(configured_candidates)
    if strict_config and configured_value:
        return FfmpegTools(
            ffmpeg=_existing_file(configured_candidates[0]),
            ffprobe=_existing_file(configured_candidates[1]),
        )

    if include_bundled:
        directories = (
            tuple(Path(directory).expanduser() for directory in bundled_directories)
            if bundled_directories is not None
            else bundled_ffmpeg_directories()
        )
        candidates.extend(
            (directory / _tool_filename("ffmpeg"), directory / _tool_filename("ffprobe"))
            for directory in directories
        )

    platform_value = sys.platform if platform is None else platform
    if include_macos and platform_value == "darwin":
        candidates.extend(
            (Path(directory) / _tool_filename("ffmpeg"), Path(directory) / _tool_filename("ffprobe"))
            for directory in macos_directories
        )

    lookup_path = search_path
    if lookup_path is None:
        raw_path = str(values.get("PATH", "") or "")
        lookup_path = ffmpeg_search_path(
            raw_path,
            platform=platform_value,
            macos_directories=macos_directories,
        )
        # shutil.which(..., path=None) falls back to the current process
        # environment. An explicitly empty PATH must remain empty so a
        # child-environment resolution cannot accidentally see the Launcher
        # process's PATH.
        if lookup_path is None:
            lookup_path = ""
    path_by_tool: dict[str, Path] = {}
    # An empty PATH must not make ``shutil.which`` search the current folder.
    if lookup_path:
        path_by_tool = {
            tool: Path(found).expanduser()
            for tool in FFMPEG_TOOL_NAMES
            if (found := shutil.which(tool, path=lookup_path))
        }

    resolved: dict[str, Path | None] = {tool: None for tool in FFMPEG_TOOL_NAMES}
    for ffmpeg_candidate, ffprobe_candidate in candidates:
        for tool, candidate in (
            ("ffmpeg", ffmpeg_candidate),
            ("ffprobe", ffprobe_candidate),
        ):
            if resolved[tool] is None:
                resolved[tool] = _existing_file(candidate)
    for tool in FFMPEG_TOOL_NAMES:
        if resolved[tool] is None:
            resolved[tool] = _existing_file(path_by_tool[tool]) if tool in path_by_tool else None
    return FfmpegTools(ffmpeg=resolved["ffmpeg"], ffprobe=resolved["ffprobe"])


def resolve_ffmpeg_tool(
    tool: str,
    configured_path: str | os.PathLike[str] | None = None,
    *,
    environment: Mapping[str, str] | None = None,
    search_path: str | None = None,
    platform: str | None = None,
    bundled_directories: Sequence[str | os.PathLike[str]] | None = None,
    include_bundled: bool = True,
    include_macos: bool = True,
    macos_directories: Sequence[str | os.PathLike[str]] = MACOS_FFMPEG_CANDIDATE_DIRECTORIES,
    strict_config: bool = False,
    allow_missing_explicit: bool = False,
) -> Path | None:
    """Resolve one named FFmpeg tool through :func:`resolve_ffmpeg_tools`."""
    normalized = tool.strip().lower()
    _tool_filename(normalized)
    tools = resolve_ffmpeg_tools(
        configured_path,
        environment=environment,
        search_path=search_path,
        platform=platform,
        bundled_directories=bundled_directories,
        include_bundled=include_bundled,
        include_macos=include_macos,
        macos_directories=macos_directories,
        strict_config=strict_config,
    )
    result = tools.ffmpeg if normalized == "ffmpeg" else tools.ffprobe
    if result is not None or not allow_missing_explicit:
        return result
    configured_value = str(configured_path or "").strip()
    if not configured_value:
        return result
    return _configured_tool_path(configured_value, normalized)


__all__ = [
    "FFMPEG_PATH_ENV",
    "FFMPEG_TOOL_NAMES",
    "FfmpegTools",
    "MACOS_FFMPEG_CANDIDATE_DIRECTORIES",
    "bundled_ffmpeg_directories",
    "bundled_ffmpeg_directory",
    "ffmpeg_search_path",
    "resolve_ffmpeg_tool",
    "resolve_ffmpeg_tools",
]
