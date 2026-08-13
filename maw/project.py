"""Strict MAW project JSON boundary shared by CLI and local server."""

from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import TypeGuard, final

from maw.project_preview import JsonDict, JsonValue, clamped_preview, validate_preview

# Python 3.11 has no typing.override; basedpyright's override marker is therefore
# disabled for this compatibility module.
# pyright: reportImplicitOverride=false

MIN_SEGMENT_DURATION_MS = 100
MULTI_SUBTITLE_SCHEMA = "moy.asr.multi_subtitle.v1"
MULTI_SUBTITLE_DISPLAY_MODES = frozenset({"main", "extension", "both"})
MULTI_SUBTITLE_SPLIT_MODES = frozenset({"continuous", "word"})
MAX_STABLE_ID_LENGTH = 160


def repair_segment_durations(
    segments: list[JsonValue],
    min_ms: int = MIN_SEGMENT_DURATION_MS,
) -> int:
    """Widen zero/negative segment and item ranges to at least ``min_ms`` in place.

    ASR providers occasionally emit a word whose ``end`` equals its ``start``;
    once isolated by sentence splitting it becomes a zero-length subtitle that
    is invisible on the waveform and rejected by the save validator. Only
    invalid (non-positive or inverted) ranges are widened, and the sweep keeps
    every range monotonic and non-overlapping; genuine short timings are left
    untouched. Returns the number of repaired boundaries.
    """
    floor = max(1, int(min_ms))
    fixed = 0
    previous_segment_end = 0
    for segment in segments:
        if not isinstance(segment, dict):
            continue
        start = segment.get("start")
        end = segment.get("end")
        start = start if type(start) is int else 0
        end = end if type(end) is int else start
        if start < previous_segment_end:
            start = previous_segment_end
            fixed += 1
        items = segment.get("items")
        previous_item_end = start
        if isinstance(items, list):
            for item in items:
                if not isinstance(item, dict):
                    continue
                item_start = item.get("start")
                item_end = item.get("end")
                item_start = item_start if type(item_start) is int else previous_item_end
                item_end = item_end if type(item_end) is int else item_start
                if item_start < previous_item_end:
                    item_start = previous_item_end
                    fixed += 1
                if item_end <= item_start:
                    item_end = item_start + floor
                    fixed += 1
                item["start"] = item_start
                item["end"] = item_end
                previous_item_end = item_end
            last_item = items[-1] if items else None
            if isinstance(last_item, dict):
                last_end = last_item.get("end")
                if type(last_end) is int and end < last_end:
                    end = last_end
                    fixed += 1
        if end <= start:
            end = start + floor
            fixed += 1
        segment["start"] = start
        segment["end"] = end
        previous_segment_end = end
    return fixed


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


@final
class ProjectValidationFailed(ValueError):
    """Raised when a project cannot cross the strict MAW boundary."""

    def __init__(self, errors: tuple[ProjectValidationError, ...]) -> None:
        self.errors: tuple[ProjectValidationError, ...] = errors
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
    preview = clamped_preview(normalized, preview_duration_ms) if preview_duration_ms is not None else None
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
        end = segment.get("end")
        if _valid_segment_time(segment) and _is_int_ms(end):
            previous_end = end
    _validate_head_refs(segments, errors)
    _normalize_multi_subtitle(normalized, segments, errors)
    errors.extend(ProjectValidationError(path, message) for path, message in validate_preview(normalized))
    return normalized


def _is_stable_id(value: JsonValue) -> bool:
    return (
        isinstance(value, str)
        and bool(value.strip())
        and len(value.strip()) <= MAX_STABLE_ID_LENGTH
    )


def _normalize_stable_ids(
    values: list[JsonValue],
    prefix: str,
    path_prefix: str,
    errors: list[ProjectValidationError],
) -> None:
    """Fill IDs omitted by legacy projects and validate explicit IDs.

    IDs are intentionally opaque strings. Missing IDs are the one legacy case we
    repair because old MAW projects did not have them; malformed or duplicate
    explicit IDs are reported rather than silently retargeting bindings.
    """
    reserved = {
        value.strip()
        for value in (
            item.get("id") for item in values if isinstance(item, dict)
        )
        if _is_stable_id(value)
    }
    used: set[str] = set()
    for index, item in enumerate(values):
        if not isinstance(item, dict):
            continue
        path = f"{path_prefix}[{index}].id"
        if "id" not in item:
            base = f"{prefix}-{index + 1:03d}"
            candidate = base
            suffix = 2
            while candidate in used or (candidate in reserved and candidate != base):
                candidate = f"{base}-{suffix}"
                suffix += 1
            # If the generated base itself is reserved by a later explicit ID,
            # use a deterministic suffixed value instead of creating a duplicate.
            if candidate in reserved:
                candidate = f"{base}-generated"
                suffix = 2
                while candidate in used or candidate in reserved:
                    candidate = f"{base}-generated-{suffix}"
                    suffix += 1
            item["id"] = candidate
            used.add(candidate)
            continue
        value = item.get("id")
        if not _is_stable_id(value):
            errors.append(ProjectValidationError(path, "must be a non-empty string of at most 160 characters"))
            continue
        normalized = value.strip()
        if normalized in used:
            errors.append(ProjectValidationError(path, "must be unique within its collection"))
            continue
        item["id"] = normalized
        used.add(normalized)


def _normalize_multi_subtitle(
    project: JsonDict,
    main_segments: list[JsonValue],
    errors: list[ProjectValidationError],
) -> None:
    """Validate the optional bilingual track while keeping legacy projects valid."""
    # Keep the serialized shape of legacy projects untouched. The browser
    # editor supplies the closed empty structure when it loads such a project;
    # the Python boundary must not rewrite an otherwise valid old save.
    if "multi_subtitle" not in project or project.get("multi_subtitle") is None:
        return
    _normalize_stable_ids(main_segments, "main", "$.segments", errors)
    raw = project.get("multi_subtitle")
    if not isinstance(raw, dict):
        errors.append(ProjectValidationError("$.multi_subtitle", "must be an object"))
        raw = {}
        project["multi_subtitle"] = raw

    schema = raw.get("schema")
    if schema is None:
        raw["schema"] = MULTI_SUBTITLE_SCHEMA
    elif schema != MULTI_SUBTITLE_SCHEMA:
        errors.append(ProjectValidationError("$.multi_subtitle.schema", f"must be {MULTI_SUBTITLE_SCHEMA}"))

    enabled = raw.get("enabled")
    if enabled is None:
        raw["enabled"] = False
    elif not isinstance(enabled, bool):
        errors.append(ProjectValidationError("$.multi_subtitle.enabled", "must be a boolean"))

    display_mode = raw.get("display_mode")
    if display_mode is None:
        raw["display_mode"] = "both"
    elif not isinstance(display_mode, str) or display_mode not in MULTI_SUBTITLE_DISPLAY_MODES:
        errors.append(ProjectValidationError("$.multi_subtitle.display_mode", "must be one of main, extension, both"))

    main_split_mode = raw.get("main_split_mode")
    if main_split_mode is not None and main_split_mode not in MULTI_SUBTITLE_SPLIT_MODES:
        errors.append(ProjectValidationError("$.multi_subtitle.main_split_mode", "must be continuous or word"))

    tracks = raw.get("tracks")
    if tracks is None:
        tracks = []
        raw["tracks"] = tracks
    elif not isinstance(tracks, list):
        errors.append(ProjectValidationError("$.multi_subtitle.tracks", "must be an array"))
        tracks = []
        raw["tracks"] = tracks

    _normalize_stable_ids(tracks, "extension", "$.multi_subtitle.tracks", errors)
    track_by_id: dict[str, JsonDict] = {}
    extension_ids: dict[str, set[str]] = {}
    for track_index, track in enumerate(tracks):
        path = f"$.multi_subtitle.tracks[{track_index}]"
        if not isinstance(track, dict):
            errors.append(ProjectValidationError(path, "must be an object"))
            continue
        role = track.get("role")
        if role is None:
            track["role"] = "extension"
        elif role != "extension":
            errors.append(ProjectValidationError(f"{path}.role", "must be extension"))
        for field in ("name", "language", "source_name"):
            if field in track and not isinstance(track[field], str):
                errors.append(ProjectValidationError(f"{path}.{field}", "must be a string"))
        split_mode = track.get("split_mode")
        if split_mode is None:
            track["split_mode"] = "word"
        elif split_mode not in MULTI_SUBTITLE_SPLIT_MODES:
            errors.append(ProjectValidationError(f"{path}.split_mode", "must be continuous or word"))
        raw_segments = track.get("segments")
        if raw_segments is None:
            raw_segments = []
            track["segments"] = raw_segments
        elif not isinstance(raw_segments, list):
            errors.append(ProjectValidationError(f"{path}.segments", "must be an array"))
            raw_segments = []
            track["segments"] = raw_segments
        _normalize_stable_ids(raw_segments, f"{track.get('id', 'extension')}-segment", f"{path}.segments", errors)
        track_id = track.get("id")
        if isinstance(track_id, str):
            track_by_id[track_id] = track
            extension_ids[track_id] = set()
        previous_end: int | None = None
        for segment_index, segment in enumerate(raw_segments):
            segment_path = f"{path}.segments[{segment_index}]"
            if not isinstance(segment, dict):
                errors.append(ProjectValidationError(segment_path, "must be an object"))
                continue
            # Extension SRT/mosp text has no trustworthy word-level timings.
            segment.pop("items", None)
            _validate_extension_segment(segment, segment_path, previous_end, errors)
            segment_id = segment.get("id")
            if isinstance(track_id, str) and _is_stable_id(segment_id):
                extension_ids[track_id].add(segment_id.strip())
            if _valid_segment_time(segment):
                previous_end = segment.get("end")

    main_ids = {
        segment.get("id").strip()
        for segment in main_segments
        if isinstance(segment, dict) and _is_stable_id(segment.get("id"))
    }
    bindings = raw.get("bindings")
    if bindings is None:
        bindings = []
        raw["bindings"] = bindings
    elif not isinstance(bindings, list):
        errors.append(ProjectValidationError("$.multi_subtitle.bindings", "must be an array"))
        bindings = []
        raw["bindings"] = bindings

    _normalize_stable_ids(bindings, "binding", "$.multi_subtitle.bindings", errors)
    used_main: set[str] = set()
    used_extension: set[tuple[str, str]] = set()
    for binding_index, binding in enumerate(bindings):
        path = f"$.multi_subtitle.bindings[{binding_index}]"
        if not isinstance(binding, dict):
            errors.append(ProjectValidationError(path, "must be an object"))
            continue
        track_id = binding.get("track_id")
        if track_id is None and len(track_by_id) == 1:
            track_id = next(iter(track_by_id))
            binding["track_id"] = track_id
        if not _is_stable_id(track_id):
            errors.append(ProjectValidationError(f"{path}.track_id", "must reference an extension track"))
            continue
        track_key = track_id.strip()
        binding["track_id"] = track_key
        if track_key not in track_by_id:
            errors.append(ProjectValidationError(f"{path}.track_id", "must reference an existing extension track"))
            continue
        main_ids_value = binding.get("main_segment_ids")
        extension_ids_value = binding.get("extension_segment_ids")
        if main_ids_value is None and "main_segment_id" in binding:
            main_ids_value = [binding.get("main_segment_id")]
            binding["main_segment_ids"] = main_ids_value
        if extension_ids_value is None and "extension_segment_id" in binding:
            extension_ids_value = [binding.get("extension_segment_id")]
            binding["extension_segment_ids"] = extension_ids_value
        main_id = _single_binding_id(main_ids_value, f"{path}.main_segment_ids", errors)
        extension_id = _single_binding_id(extension_ids_value, f"{path}.extension_segment_ids", errors)
        if main_id is None or extension_id is None:
            continue
        if main_id not in main_ids:
            errors.append(ProjectValidationError(f"{path}.main_segment_ids[0]", "must reference an existing main segment"))
            continue
        if extension_id not in extension_ids.get(track_key, set()):
            errors.append(ProjectValidationError(f"{path}.extension_segment_ids[0]", "must reference an existing extension segment"))
            continue
        if main_id in used_main:
            errors.append(ProjectValidationError(f"{path}.main_segment_ids[0]", "must be one-to-one in the MVP"))
        if (track_key, extension_id) in used_extension:
            errors.append(ProjectValidationError(f"{path}.extension_segment_ids[0]", "must be one-to-one in the MVP"))
        used_main.add(main_id)
        used_extension.add((track_key, extension_id))

        main = next(
            segment for segment in main_segments
            if isinstance(segment, dict) and segment.get("id") == main_id
        )
        extension = next(
            segment for segment in track_by_id[track_key].get("segments", [])
            if isinstance(segment, dict) and segment.get("id") == extension_id
        )
        if not (
            _is_int_ms(main.get("start"))
            and _is_int_ms(main.get("end"))
            and _is_int_ms(extension.get("start"))
            and _is_int_ms(extension.get("end"))
        ):
            continue
        expected_start = extension.get("start") - main.get("start")
        expected_end = extension.get("end") - main.get("end")
        for field, expected in (("start_offset_ms", expected_start), ("end_offset_ms", expected_end)):
            value = binding.get(field)
            if value is None:
                binding[field] = expected
            elif not _is_int_ms(value):
                errors.append(ProjectValidationError(f"{path}.{field}", "must be integer milliseconds"))
            elif value != expected:
                errors.append(ProjectValidationError(f"{path}.{field}", "must equal the segment time offset"))


def _single_binding_id(
    value: JsonValue,
    path: str,
    errors: list[ProjectValidationError],
) -> str | None:
    if not isinstance(value, list):
        errors.append(ProjectValidationError(path, "must be an array with exactly one ID in the MVP"))
        return None
    if len(value) != 1 or not _is_stable_id(value[0]):
        errors.append(ProjectValidationError(path, "must contain exactly one stable ID in the MVP"))
        return None
    value[0] = value[0].strip()
    return value[0]


def _validate_extension_segment(
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
        end = item.get("end")
        if _valid_item_time(item) and _is_int_ms(end):
            previous_end = end


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
    if not isinstance(segment, dict):
        return
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
    if not isinstance(target, dict):
        errors.append(ProjectValidationError(f"{path}.{ref_field}.headIdx", f"must point to a {head_field} head"))
        return
    target_head = target.get(head_field)
    if not isinstance(target_head, dict):
        errors.append(ProjectValidationError(f"{path}.{ref_field}.headIdx", f"must point to a {head_field} head"))
        return
    target_name = target_head.get("name")
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


def _is_int_ms(value: JsonValue) -> TypeGuard[int]:
    return type(value) is int


def _valid_segment_time(segment: JsonDict) -> bool:
    start = segment.get("start")
    end = segment.get("end")
    if not (_is_int_ms(start) and _is_int_ms(end)):
        return False
    return end > start


def _valid_item_time(item: JsonDict) -> bool:
    start = item.get("start")
    end = item.get("end")
    if not (_is_int_ms(start) and _is_int_ms(end)):
        return False
    return end >= start
