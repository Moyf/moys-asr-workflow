# pyright: reportAny=false, reportImplicitOverride=false

"""Subtitle post-processing file boundaries and artifact naming."""

from __future__ import annotations

import json
import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path

from maw.output_naming import OPERATION_NAMES, is_translation_operation, operation_suffix
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
    overlay_segments: list[JsonValue] = []
    previous_start = 0
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
        if start < previous_start or end <= start:
            raise PostprocessFileError(source, f"cue {cue_index} has overlapping or invalid timing")
        cue = {"start": start, "end": end, "text": "\n".join(lines[timing_index + 1 :]).strip()}
        if _fits_track(segments, start, end):
            segments.append(cue)
        elif _fits_track(overlay_segments, start, end):
            overlay_segments.append(cue)
        else:
            raise PostprocessFileError(source, f"cue {cue_index} cannot fit into the main and overlay tracks")
        previous_start = start
    project: JsonDict = {"segments": segments}
    if overlay_segments:
        project["overlay_track"] = {"enabled": True, "segments": overlay_segments}
    return normalize_project(project)


def _fits_track(segments: list[JsonValue], start: int, end: int) -> bool:
    """Return whether a positive cue range fits without overlapping a track."""
    return all(
        not isinstance(segment, dict)
        or end <= int(segment.get("start", 0))
        or start >= int(segment.get("end", 0))
        for segment in segments
    )


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
    main_segments = project.get("segments")
    if not isinstance(main_segments, list):
        return ""
    blocks: list[str] = []
    for output_index, segment in enumerate(_srt_segments(project, main_segments), 1):
        if not isinstance(segment, dict):
            continue
        if segment.get("disabled") is True:
            continue
        start = segment.get("start")
        end = segment.get("end")
        text = segment.get("text")
        if type(start) is int and type(end) is int and isinstance(text, str) and text.strip():
            safe_text = re.sub(r"\r?\n\s*\r?\n+", "\n", text.strip())
            blocks.append(f"{output_index}\n{_format_srt_time(start)} --> {_format_srt_time(end)}\n{safe_text}\n")
    return "\n".join(blocks)


def _srt_segments(project: JsonDict, main_segments: list[JsonValue]) -> list[JsonValue]:
    """Return enabled main and overlay cues ordered by start time and track."""
    overlay_segments: list[JsonValue] = []
    overlay = project.get("overlay_track")
    if isinstance(overlay, dict) and overlay.get("enabled") is True:
        raw_overlay_segments = overlay.get("segments")
        if isinstance(raw_overlay_segments, list):
            overlay_segments = raw_overlay_segments
    cues = [
        (segment, track_index, segment_index)
        for track_index, track_segments in enumerate((main_segments, overlay_segments))
        for segment_index, segment in enumerate(track_segments)
        if isinstance(segment, dict)
        and segment.get("disabled") is not True
        and type(segment.get("start")) is int
        and type(segment.get("end")) is int
        and isinstance(segment.get("text"), str)
        and segment["text"].strip()
    ]
    cues.sort(key=lambda cue: (cue[0]["start"], cue[1], cue[2]))
    return [cue[0] for cue in cues]


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


def _available_output(source: Path, operation: str, suffix: str, *, output_directory: Path | None = None, lang: str | None = None) -> Path:
    safe_operation = _operation_file_token(operation, lang=lang)
    directory = output_directory or source.parent
    candidate = directory / f"{source.stem}.{safe_operation}{suffix}"
    counter = 2
    while candidate.exists():
        candidate = directory / f"{source.stem}.{safe_operation}-{counter}{suffix}"
        counter += 1
    return candidate.resolve()


def _operation_file_token(operation: str, *, lang: str | None = None) -> str:
    """Return the safe filename segment for an artifact operation.

    Operations listed in the naming contract and translation artifacts
    (``translate-{target}`` with optional ``-bilingual``/``-combined`` marker;
    both hyphen and underscore bases are recognized) get their localized display
    name. In the zh UI the marker is localized too, keeping the dot separator
    (``翻译为中文.双语合一``); the en UI keeps the pre-change byte output
    (``translate-zh-bilingual`` / legacy ``translate-zh`` for underscore bases).
    Operations that fall outside both groups keep the legacy ASCII cleaning so
    unrelated names do not change shape.
    """
    if operation in OPERATION_NAMES:
        display = operation_suffix(operation, lang=lang).lstrip(".")
        return re.sub(r"[^\w-]+", "-", display, flags=re.UNICODE).strip("-") or "processed"
    if is_translation_operation(operation):
        display = operation_suffix(operation, lang=lang).lstrip(".")
        # zh 界面翻译段以点分隔本地化标记（翻译为中文.双语合一），点必须保留；
        # en 界面 / 未知 target 的 display 即 legacy 清洗后的 operation，
        # 结果与改动前逐字节一致。
        return re.sub(r"[^\w.-]+", "-", display, flags=re.UNICODE).strip(".-") or "processed"
    return re.sub(r"[^a-z0-9-]+", "-", operation.lower()).strip("-") or "processed"


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
