# pyright: reportImplicitOverride=false

"""Validated ffconcat media rebuild for the Launcher toolbox."""

from __future__ import annotations

import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from maw.gui_platform import creationflags, startupinfo


ALLOWED_DIRECTIVES: Final = frozenset({"ffconcat", "file", "inpoint", "outpoint", "duration"})


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


def _resolve_file_directive(base: Path, raw_value: str) -> Path:
    value = raw_value.strip()
    if value.startswith("'") and value.endswith("'"):
        value = value[1:-1].replace("'\\''", "'")
    candidate = Path(value)
    if not candidate.is_absolute():
        candidate = base / candidate
    return candidate.expanduser().resolve()


def _available_media_output(media: Path) -> Path:
    candidate = media.with_name(f"{media.stem}.gap-removed{media.suffix}")
    counter = 2
    while candidate.exists():
        candidate = media.with_name(f"{media.stem}.gap-removed-{counter}{media.suffix}")
        counter += 1
    return candidate.resolve()
