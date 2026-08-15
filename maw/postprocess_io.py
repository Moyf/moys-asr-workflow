# pyright: reportAny=false, reportImplicitOverride=false

"""Subtitle post-processing file boundaries and artifact naming."""

from __future__ import annotations

import json
import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path

from maw.project import normalize_project
from maw.project_preview import JsonDict, JsonValue


@dataclass(frozen=True, slots=True)
class SubtitleArtifact:
    source_project_path: Path | None
    source_srt_path: Path | None
    project_path: Path | None
    srt_path: Path | None
    warnings: tuple[str, ...] = ()
    translated_srt_path: Path | None = None


@dataclass(frozen=True, slots=True)
class PostprocessFileError(ValueError):
    path: Path
    message: str

    def __str__(self) -> str:
        return f"{self.path}: {self.message}"


def read_project(path: Path) -> JsonDict:
    source = path.expanduser().resolve()
    if not source.is_file() or source.suffix.lower() not in {".json", ".mosp"}:
        raise PostprocessFileError(source, "project must be an existing .mosp or .json file")
    try:
        raw: JsonValue = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise PostprocessFileError(source, f"cannot read project: {error}") from error
    return normalize_project(raw)


def read_srt(path: Path) -> JsonDict:
    source = path.expanduser().resolve()
    if not source.is_file() or source.suffix.lower() != ".srt":
        raise PostprocessFileError(source, "subtitle must be an existing .srt file")
    try:
        text = source.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeError) as error:
        raise PostprocessFileError(source, f"cannot read SRT: {error}") from error
    segments: list[JsonValue] = []
    previous_end = 0
    stripped = text.strip()
    blocks = re.split(r"\r?\n\s*\r?\n", stripped) if stripped else []
    for cue_index, block in enumerate(blocks, 1):
        lines = block.splitlines()
        timing_index = next((index for index, line in enumerate(lines) if "-->" in line), -1)
        if timing_index < 0:
            raise PostprocessFileError(source, f"cue {cue_index} has no timing line")
        timing_parts = lines[timing_index].split("-->")
        if len(timing_parts) != 2:
            raise PostprocessFileError(source, f"cue {cue_index} has an invalid timestamp")
        left, right = (part.strip() for part in timing_parts)
        right_parts = right.split()
        if not right_parts:
            raise PostprocessFileError(source, f"cue {cue_index} has an invalid timestamp")
        start = _parse_srt_time(left, source, cue_index)
        end = _parse_srt_time(right_parts[0], source, cue_index)
        if start < previous_end or end <= start:
            raise PostprocessFileError(source, f"cue {cue_index} has overlapping or invalid timing")
        segments.append({"start": start, "end": end, "text": "\n".join(lines[timing_index + 1 :]).strip()})
        previous_end = end
    return normalize_project({"segments": segments})


def write_artifacts(
    project: JsonDict,
    *,
    source_project_path: Path | None,
    source_srt_path: Path | None,
    operation: str,
    write_project: bool,
    write_srt: bool,
    warnings: tuple[str, ...] = (),
    output_directory: Path | None = None,
    media_path: Path | None = None,
) -> SubtitleArtifact:
    normalized = normalize_project(project)
    raw_media = normalized.get("media")
    if media_path is not None and str(media_path).strip() and (
        not isinstance(raw_media, str) or not raw_media.strip()
    ):
        # The active media is a fallback for SRT or media-less project input;
        # never overwrite a project that already carries its own media.
        normalized["media"] = str(media_path.expanduser().resolve(strict=False))
    base = source_project_path or source_srt_path
    if base is None:
        raise PostprocessFileError(Path("."), "an input project or SRT is required")
    output_directory = output_directory.expanduser().resolve() if output_directory is not None else None
    project_path = _available_output(base, operation, base.suffix if source_project_path else ".mosp", output_directory=output_directory) if write_project else None
    srt_path = _available_output(base, operation, ".srt", output_directory=output_directory) if write_srt else None
    if project_path is not None:
        _atomic_write(project_path, json.dumps(normalized, ensure_ascii=False, indent=2) + "\n")
    if srt_path is not None:
        _atomic_write(srt_path, render_srt(normalized))
    return SubtitleArtifact(
        source_project_path=source_project_path,
        source_srt_path=source_srt_path,
        project_path=project_path,
        srt_path=srt_path,
        warnings=warnings,
    )


def render_srt(project: JsonDict) -> str:
    segments = project.get("segments")
    if not isinstance(segments, list):
        return ""
    blocks: list[str] = []
    output_index = 1
    for segment in segments:
        if not isinstance(segment, dict):
            continue
        if segment.get("disabled") is True:
            continue
        start = segment.get("start")
        end = segment.get("end")
        text = segment.get("text")
        if type(start) is int and type(end) is int and isinstance(text, str):
            safe_text = re.sub(r"\r?\n\s*\r?\n+", "\n", text.strip())
            blocks.append(f"{output_index}\n{_format_srt_time(start)} --> {_format_srt_time(end)}\n{safe_text}\n")
            output_index += 1
    return "\n".join(blocks)


def _parse_srt_time(value: str, path: Path, cue_index: int) -> int:
    match = re.fullmatch(r"(\d+):(\d{2}):(\d{2})[,.](\d{3})", value)
    if match is None:
        raise PostprocessFileError(path, f"cue {cue_index} has an invalid timestamp")
    hours, minutes, seconds, milliseconds = (int(part) for part in match.groups())
    if minutes >= 60 or seconds >= 60:
        raise PostprocessFileError(path, f"cue {cue_index} has an invalid timestamp")
    return hours * 3_600_000 + minutes * 60_000 + seconds * 1_000 + milliseconds


def _format_srt_time(milliseconds: int) -> str:
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds, millis = divmod(remainder, 1_000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{millis:03d}"


def _available_output(source: Path, operation: str, suffix: str, *, output_directory: Path | None = None) -> Path:
    safe_operation = re.sub(r"[^a-z0-9-]+", "-", operation.lower()).strip("-") or "processed"
    directory = output_directory or source.parent
    candidate = directory / f"{source.stem}.{safe_operation}{suffix}"
    counter = 2
    while candidate.exists():
        candidate = directory / f"{source.stem}.{safe_operation}-{counter}{suffix}"
        counter += 1
    return candidate.resolve()


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            _ = handle.write(text)
        os.replace(temporary_name, path)
    except (OSError, UnicodeError):
        Path(temporary_name).unlink(missing_ok=True)
        raise
