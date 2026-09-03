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
    output_name: str | None = None,
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
    project_path, srt_path = _available_outputs(
        base,
        operation,
        project_suffix=base.suffix if source_project_path else ".mosp",
        write_project=write_project,
        write_srt=write_srt,
        output_directory=output_directory,
        output_name=output_name,
    )
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


def normalize_output_name(value: str | None) -> str | None:
    """Return a safe artifact basename, or ``None`` for the default naming rule."""

    name = str(value or "").strip()
    if not name:
        return None
    if name in {".", ".."} or any(char in name for char in ("/", "\\", "\x00")):
        raise ValueError("输出名称只能填写文件名，不能包含路径或特殊字符。")
    if any(ord(char) < 32 for char in name):
        raise ValueError("输出名称不能包含控制字符。")
    suffix = Path(name).suffix.lower()
    if suffix in {".mosp", ".json", ".srt"}:
        name = Path(name).stem.strip()
    if not name or name in {".", ".."}:
        raise ValueError("请输入有效的输出名称。")
    return name


def _available_outputs(
    source: Path,
    operation: str,
    *,
    project_suffix: str,
    write_project: bool,
    write_srt: bool,
    output_directory: Path | None = None,
    output_name: str | None = None,
) -> tuple[Path | None, Path | None]:
    safe_operation = re.sub(r"[^a-z0-9-]+", "-", operation.lower()).strip("-") or "processed"
    directory = output_directory or source.parent
    stem = normalize_output_name(output_name) or f"{source.stem}.{safe_operation}"
    counter = 1
    while True:
        candidate_stem = stem if counter == 1 else f"{stem}-{counter}"
        project_path = (directory / f"{candidate_stem}{project_suffix}").resolve() if write_project else None
        srt_path = (directory / f"{candidate_stem}.srt").resolve() if write_srt else None
        if all(path is None or not path.exists() for path in (project_path, srt_path)):
            return project_path, srt_path
        counter += 1


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        encoding = "utf-8-sig" if path.suffix.lower() == ".srt" else "utf-8"
        with os.fdopen(descriptor, "w", encoding=encoding, newline="\n") as handle:
            _ = handle.write(text)
        os.replace(temporary_name, path)
    except (OSError, UnicodeError):
        Path(temporary_name).unlink(missing_ok=True)
        raise
