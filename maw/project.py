"""Strict MAW project JSON boundary shared by CLI and local server."""

from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import TypeAlias


JsonScalar: TypeAlias = str | int | float | bool | None
JsonValue: TypeAlias = JsonScalar | list["JsonValue"] | dict[str, "JsonValue"]
JsonDict: TypeAlias = dict[str, JsonValue]


@dataclass(frozen=True, slots=True)
class ProjectValidationError:
    path: str
    message: str

    def to_json(self) -> JsonDict:
        return {"path": self.path, "message": self.message}


@dataclass(frozen=True, slots=True)
class ProjectValidationResult:
    ok: bool
    errors: tuple[ProjectValidationError, ...]
    project: JsonDict | None
    preview: JsonDict | None = None

    def to_json(self) -> JsonDict:
        return {
            "ok": self.ok,
            "errors": [error.to_json() for error in self.errors],
            "project": self.project,
            "preview": self.preview,
        }


class ProjectValidationFailed(ValueError):
    """Raised when a project cannot cross the strict MAW boundary."""

    def __init__(self, errors: tuple[ProjectValidationError, ...]) -> None:
        self.errors = errors
        super().__init__(str(self))

    def __str__(self) -> str:
        return "; ".join(f"{error.path}: {error.message}" for error in self.errors)


def validate_project(project: JsonValue, preview_duration_ms: int | None = None) -> ProjectValidationResult:
    """Validate and normalize one JSON-loaded MAW project without sorting or coercing."""
    errors: list[ProjectValidationError] = []
    normalized = _normalize_copy(project, errors)
    if preview_duration_ms is not None and not _is_int_ms(preview_duration_ms):
        errors.append(ProjectValidationError("$.preview_duration_ms", "must be integer milliseconds"))
    if errors:
        return ProjectValidationResult(False, tuple(errors), None, None)
    preview = _clamped_preview(normalized, preview_duration_ms) if preview_duration_ms is not None else None
    return ProjectValidationResult(True, (), normalized, preview)


def normalize_project(project: JsonValue, preview_duration_ms: int | None = None) -> JsonDict:
    """Return a normalized MAW project or raise path-qualified validation errors."""
    result = validate_project(project, preview_duration_ms=preview_duration_ms)
    if result.project is None:
        raise ProjectValidationFailed(result.errors)
    return result.project


def _normalize_copy(project: JsonValue, errors: list[ProjectValidationError]) -> JsonDict:
    if not isinstance(project, dict):
        errors.append(ProjectValidationError("$", "must be an object"))
        return {"segments": []}
    normalized = copy.deepcopy(project)
    segments = normalized.get("segments")
    if not isinstance(segments, list):
        errors.append(ProjectValidationError("$.segments", "must be an array"))
        normalized["segments"] = []
        return normalized

    previous_end: int | None = None
    for index, segment in enumerate(segments):
        path = f"$.segments[{index}]"
        if not isinstance(segment, dict):
            errors.append(ProjectValidationError(path, "must be an object"))
            continue
        _validate_segment(segment, path, previous_end, errors)
        if _valid_segment_time(segment):
            previous_end = segment["end"]
    _validate_head_refs(segments, errors)
    return normalized


def _validate_segment(
    segment: JsonDict,
    path: str,
    previous_end: int | None,
    errors: list[ProjectValidationError],
) -> None:
    start = segment.get("start")
    end = segment.get("end")
    if not _is_int_ms(start):
        errors.append(ProjectValidationError(f"{path}.start", "must be integer milliseconds"))
    if not _is_int_ms(end):
        errors.append(ProjectValidationError(f"{path}.end", "must be integer milliseconds"))
    if _is_int_ms(start) and start < 0:
        errors.append(ProjectValidationError(f"{path}.start", "must be non-negative"))
    if _is_int_ms(start) and _is_int_ms(end):
        if end <= start:
            errors.append(ProjectValidationError(f"{path}.end", "must be greater than start"))
        if previous_end is not None and start < previous_end:
            errors.append(ProjectValidationError(f"{path}.start", "must be >= previous segment end"))
    if not isinstance(segment.get("text"), str):
        errors.append(ProjectValidationError(f"{path}.text", "must be a string"))
    if "speaker" in segment and (not isinstance(segment["speaker"], str) or not segment["speaker"].strip()):
        errors.append(ProjectValidationError(f"{path}.speaker", "must be a non-empty string"))
    _validate_items(segment, path, errors)


def _validate_items(segment: JsonDict, path: str, errors: list[ProjectValidationError]) -> None:
    if "items" not in segment:
        return
    items = segment["items"]
    if not isinstance(items, list):
        errors.append(ProjectValidationError(f"{path}.items", "must be an array"))
        return
    previous_end: int | None = None
    for index, item in enumerate(items):
        item_path = f"{path}.items[{index}]"
        if not isinstance(item, dict):
            errors.append(ProjectValidationError(item_path, "must be an object"))
            continue
        _validate_item(item, item_path, segment, previous_end, errors)
        if _valid_item_time(item):
            previous_end = item["end"]


def _validate_item(
    item: JsonDict,
    path: str,
    segment: JsonDict,
    previous_end: int | None,
    errors: list[ProjectValidationError],
) -> None:
    start = item.get("start")
    end = item.get("end")
    if not isinstance(item.get("text"), str):
        errors.append(ProjectValidationError(f"{path}.text", "must be a string"))
    if not _is_int_ms(start):
        errors.append(ProjectValidationError(f"{path}.start", "must be integer milliseconds"))
    if not _is_int_ms(end):
        errors.append(ProjectValidationError(f"{path}.end", "must be integer milliseconds"))
    if not (_is_int_ms(start) and _is_int_ms(end)):
        return
    segment_start = segment.get("start")
    segment_end = segment.get("end")
    if not (_is_int_ms(segment_start) and _is_int_ms(segment_end)):
        return
    if start < segment_start or start > segment_end:
        errors.append(ProjectValidationError(f"{path}.start", "must be within segment bounds"))
    if end < start or end > segment_end:
        errors.append(ProjectValidationError(f"{path}.end", "must be within segment bounds and >= start"))
    if previous_end is not None and start < previous_end:
        errors.append(ProjectValidationError(f"{path}.start", "must be >= previous item end"))


def _validate_head_refs(segments: list[JsonValue], errors: list[ProjectValidationError]) -> None:
    for index, segment in enumerate(segments):
        if not isinstance(segment, dict):
            continue
        path = f"$.segments[{index}]"
        _validate_ref_pair(segments, index, path, "sticker", "sticker_ref", errors)
        _validate_ref_pair(segments, index, path, "color", "color_ref", errors)


def _validate_ref_pair(
    segments: list[JsonValue],
    index: int,
    path: str,
    head_field: str,
    ref_field: str,
    errors: list[ProjectValidationError],
) -> None:
    segment = segments[index]
    head = segment.get(head_field)
    ref = segment.get(ref_field)
    if head is not None and not isinstance(head, dict):
        errors.append(ProjectValidationError(f"{path}.{head_field}", "must be an object or null"))
    elif isinstance(head, dict):
        _validate_head(head, f"{path}.{head_field}", errors)
    if ref is None:
        return
    if not isinstance(ref, dict):
        errors.append(ProjectValidationError(f"{path}.{ref_field}", "must be an object or null"))
        return
    if head is not None:
        errors.append(ProjectValidationError(f"{path}.{ref_field}", "cannot be set on a head segment"))
    head_idx = ref.get("headIdx")
    if not _is_int_ms(head_idx):
        errors.append(ProjectValidationError(f"{path}.{ref_field}.headIdx", "must be an integer segment index"))
        return
    if head_idx < 0 or head_idx >= len(segments) or head_idx >= index:
        errors.append(ProjectValidationError(f"{path}.{ref_field}.headIdx", "must point to an earlier head segment"))
        return
    target = segments[head_idx]
    if not isinstance(target, dict) or not isinstance(target.get(head_field), dict):
        errors.append(ProjectValidationError(f"{path}.{ref_field}.headIdx", f"must point to a {head_field} head"))
        return
    target_name = target[head_field].get("name")
    ref_name = ref.get("name")
    if isinstance(target_name, str) and isinstance(ref_name, str) and target_name != ref_name:
        errors.append(ProjectValidationError(f"{path}.{ref_field}.name", "must match referenced head name"))


def _validate_head(head: JsonDict, path: str, errors: list[ProjectValidationError]) -> None:
    name = head.get("name")
    if "name" in head and (not isinstance(name, str) or not name.strip()):
        errors.append(ProjectValidationError(f"{path}.name", "must be a non-empty string"))
    start = head.get("start")
    end = head.get("end")
    if "start" in head and not _is_int_ms(start):
        errors.append(ProjectValidationError(f"{path}.start", "must be integer milliseconds"))
    if "end" in head and not _is_int_ms(end):
        errors.append(ProjectValidationError(f"{path}.end", "must be integer milliseconds"))
    if _is_int_ms(start) and _is_int_ms(end) and end < start:
        errors.append(ProjectValidationError(f"{path}.end", "must be >= start"))


def _clamped_preview(project: JsonDict, duration_ms: int | None) -> JsonDict:
    preview = copy.deepcopy(project)
    if duration_ms is None:
        return preview
    duration = max(0, duration_ms)
    preview_segments: list[JsonDict] = []
    for segment in project["segments"]:
        if segment["end"] <= 0 or segment["start"] >= duration:
            continue
        next_segment = copy.deepcopy(segment)
        next_segment["start"] = max(0, segment["start"])
        next_segment["end"] = min(duration, segment["end"])
        if isinstance(segment.get("items"), list):
            next_segment["items"] = _clamped_items(segment["items"], next_segment["start"], next_segment["end"])
        preview_segments.append(next_segment)
    preview["segments"] = preview_segments
    return preview


def _clamped_items(items: list[JsonDict], start: int, end: int) -> list[JsonDict]:
    result: list[JsonDict] = []
    for item in items:
        if item["end"] < start or item["start"] > end:
            continue
        next_item = copy.deepcopy(item)
        next_item["start"] = max(start, item["start"])
        next_item["end"] = min(end, item["end"])
        if next_item["end"] >= next_item["start"]:
            result.append(next_item)
    return result


def _is_int_ms(value: JsonValue) -> bool:
    return type(value) is int


def _valid_segment_time(segment: JsonDict) -> bool:
    return _is_int_ms(segment.get("start")) and _is_int_ms(segment.get("end")) and segment["end"] > segment["start"]


def _valid_item_time(item: JsonDict) -> bool:
    return _is_int_ms(item.get("start")) and _is_int_ms(item.get("end")) and item["end"] >= item["start"]
