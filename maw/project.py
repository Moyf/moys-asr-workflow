"""Strict MAW project JSON boundary shared by CLI and local server."""

from __future__ import annotations

import math
from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP
from typing import Final, TypeGuard, final

from maw.project_preview import JsonDict, JsonValue, clamped_preview
from maw.language import LANGUAGE_SOURCES, SPLIT_MODES, TIMESTAMP_GRANULARITIES

# Python 3.11 has no typing.override; basedpyright's override marker is therefore
# disabled for this compatibility module.
# pyright: reportImplicitOverride=false

MIN_SEGMENT_DURATION_MS = 100
PROJECT_SCHEMA: Final = "moy.asr.project.v2"
TIMELINE_TIMEBASE_UNITS = frozenset({"milliseconds", "frames"})
MIN_TIMELINE_FPS = 1.0
MAX_TIMELINE_FPS = 240.0


def repair_segment_durations(
    segments: list[JsonValue],
    min_ms: int = MIN_SEGMENT_DURATION_MS,
    *,
    preserve_zero: bool = False,
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
                was_zero = preserve_zero and item_end == item_start
                if item_start < previous_item_end:
                    item_start = previous_item_end
                    fixed += 1
                if item_end < item_start or (item_end == item_start and not was_zero):
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


def repair_item_timing_ranges(
    segments: list[JsonValue],
    min_ms: int = MIN_SEGMENT_DURATION_MS,
    *,
    preserve_zero: bool = False,
) -> int:
    """Repair only word/item ranges, preserving the enclosing segment ranges."""
    floor = max(1, int(min_ms))
    fixed = 0
    for segment in segments:
        if not isinstance(segment, dict):
            continue
        segment_start = segment.get("start")
        previous_item_end = segment_start if type(segment_start) is int else 0
        items = segment.get("items")
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            item_start = item.get("start")
            item_end = item.get("end")
            if type(item_start) is not int:
                item_start = previous_item_end
                fixed += 1
            if type(item_end) is not int:
                item_end = item_start
                fixed += 1
            was_zero = preserve_zero and item_end == item_start
            if item_start < previous_item_end:
                item_start = previous_item_end
                fixed += 1
            if item_end < item_start or (item_end == item_start and not was_zero):
                item_end = item_start + floor
                fixed += 1
            item["start"] = item_start
            item["end"] = item_end
            previous_item_end = item_end
    return fixed


def repair_project_timing_ranges(
    project: JsonValue,
    *,
    repair_segment_ranges: bool = True,
    preserve_zero: bool = True,
) -> int:
    """Repair main and multi-subtitle track timings before strict validation.

    The browser and older clients can carry a locally edited project whose
    word timestamps overlap by a rounded millisecond.  Apply the same repair
    sweep to every subtitle track so the server save boundary is defensive as
    well, while leaving valid short timings untouched.
    """
    if not isinstance(project, dict):
        return 0
    if project.get("schema") == PROJECT_SCHEMA:
        repair = repair_segment_durations if repair_segment_ranges else repair_item_timing_ranges
        tracks = project.get("tracks")
        if not isinstance(tracks, list):
            return 0
        return sum(repair(track["segments"], preserve_zero=preserve_zero)
                   for track in tracks if isinstance(track, dict)
                   and isinstance(track.get("segments"), list))
    main_segments = project.get("segments")
    repair = repair_segment_durations if repair_segment_ranges else repair_item_timing_ranges
    fixed = repair(main_segments, preserve_zero=preserve_zero) if isinstance(main_segments, list) else 0
    overlay = project.get("overlay_track")
    if isinstance(overlay, dict):
        overlay_segments = overlay.get("segments")
        if isinstance(overlay_segments, list):
            fixed += repair(overlay_segments, preserve_zero=preserve_zero)
    multi = project.get("multi_subtitle")
    if not isinstance(multi, dict):
        return fixed
    tracks = multi.get("tracks")
    if not isinstance(tracks, list):
        return fixed
    for track in tracks:
        if isinstance(track, dict):
            segments = track.get("segments")
            if isinstance(segments, list):
                fixed += repair(segments, preserve_zero=preserve_zero)
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
    # Import lazily: the boundary reuses the primitive timing/media validators
    # in this module without maintaining a second runtime project shape.
    from maw.project_tracks import migrate_project_tracks

    try:
        return migrate_project_tracks(project)
    except ProjectValidationFailed as error:
        errors.extend(error.errors)
        return {}


def _validate_timebase(project: JsonDict, errors: list[ProjectValidationError]) -> None:
    """Validate the optional parallel frame timeline without breaking legacy files."""
    if "timebase" not in project:
        return
    timebase = project.get("timebase")
    if not isinstance(timebase, dict):
        errors.append(ProjectValidationError("$.timebase", "must be an object"))
        return
    unit = timebase.get("unit")
    if "fps_source" in timebase and timebase["fps_source"] not in ("auto", "user"):
        errors.append(ProjectValidationError("$.timebase.fps_source", "must be auto or user"))
    if not isinstance(unit, str) or unit not in TIMELINE_TIMEBASE_UNITS:
        errors.append(ProjectValidationError("$.timebase.unit", "must be milliseconds or frames"))
    fps = timebase.get("fps")
    if type(fps) not in (int, float) or not math.isfinite(float(fps)):
        errors.append(ProjectValidationError("$.timebase.fps", "must be a finite number"))
    elif not MIN_TIMELINE_FPS <= float(fps) <= MAX_TIMELINE_FPS:
        errors.append(
            ProjectValidationError(
                "$.timebase.fps",
                f"must be between {MIN_TIMELINE_FPS:g} and {MAX_TIMELINE_FPS:g}",
            )
        )


def _validate_media_metadata(project: JsonDict, errors: list[ProjectValidationError]) -> None:
    """Validate optional source-media metadata without affecting legacy files."""
    if "media_metadata" not in project:
        return
    metadata = project.get("media_metadata")
    if not isinstance(metadata, dict):
        errors.append(ProjectValidationError("$.media_metadata", "must be an object"))
        return
    has_video_width = "video_width" in metadata
    has_video_height = "video_height" in metadata
    if has_video_width != has_video_height:
        missing = "video_height" if has_video_width else "video_width"
        errors.append(
            ProjectValidationError(
                f"$.media_metadata.{missing}",
                "must be provided together with the other video dimension",
            )
        )
    for field in ("video_width", "video_height"):
        if field not in metadata:
            continue
        value = metadata.get(field)
        if type(value) is not int or value <= 0:
            errors.append(
                ProjectValidationError(
                    f"$.media_metadata.{field}",
                    "must be a positive integer",
                )
            )
    if "video_fps" in metadata:
        fps = metadata.get("video_fps")
        if type(fps) not in (int, float) or not math.isfinite(float(fps)):
            errors.append(ProjectValidationError("$.media_metadata.video_fps", "must be a finite number"))
        elif not MIN_TIMELINE_FPS <= float(fps) <= MAX_TIMELINE_FPS:
            errors.append(
                ProjectValidationError(
                    "$.media_metadata.video_fps",
                    f"must be between {MIN_TIMELINE_FPS:g} and {MAX_TIMELINE_FPS:g}",
                )
            )
    if "video_fps_ratio" in metadata:
        ratio = metadata.get("video_fps_ratio")
        if not isinstance(ratio, str) or not ratio.strip():
            errors.append(
                ProjectValidationError(
                    "$.media_metadata.video_fps_ratio",
                    "must be a non-empty string",
                )
            )
    if "selected_audio_track" in metadata:
        selected_audio_track = metadata.get("selected_audio_track")
        if type(selected_audio_track) is not int or selected_audio_track < 0:
            errors.append(
                ProjectValidationError(
                    "$.media_metadata.selected_audio_track",
                    "must be a non-negative integer",
                )
            )
    if "audio_tracks" in metadata:
        audio_tracks = metadata.get("audio_tracks")
        if not isinstance(audio_tracks, list):
            errors.append(ProjectValidationError("$.media_metadata.audio_tracks", "must be an array"))
            return
        for index, track in enumerate(audio_tracks):
            path = f"$.media_metadata.audio_tracks[{index}]"
            if not isinstance(track, dict):
                errors.append(ProjectValidationError(path, "must be an object"))
                continue
            stream_index = track.get("stream_index")
            if type(stream_index) is not int or stream_index < 0:
                errors.append(ProjectValidationError(f"{path}.stream_index", "must be a non-negative integer"))
            audio_index = track.get("audio_index")
            if audio_index is not None and (type(audio_index) is not int or audio_index < 0):
                errors.append(ProjectValidationError(f"{path}.audio_index", "must be a non-negative integer"))
            for field in ("codec", "language", "title"):
                if field in track and not isinstance(track[field], str):
                    errors.append(ProjectValidationError(f"{path}.{field}", "must be a string"))
            for field in ("channels", "sample_rate"):
                value = track.get(field)
                if value is not None and (type(value) is not int or value <= 0):
                    errors.append(ProjectValidationError(f"{path}.{field}", "must be a positive integer or null"))
            if "default" in track and not isinstance(track["default"], bool):
                errors.append(ProjectValidationError(f"{path}.default", "must be a boolean"))


def _validate_transcription_metadata(
    project: JsonDict,
    errors: list[ProjectValidationError],
) -> None:
    """Validate optional ASR metadata without changing legacy project values."""
    for field in ("language", "language_source", "split_mode", "timestamp_granularity", "timed_text_edit_view"):
        if field in project and not isinstance(project[field], str):
            errors.append(ProjectValidationError(f"$.{field}", "must be a string"))
    language_source = project.get("language_source")
    if isinstance(language_source, str) and language_source not in LANGUAGE_SOURCES:
        errors.append(ProjectValidationError("$.language_source", "must be detected, hint, inferred, or unknown"))
    split_mode = project.get("split_mode")
    if "timed_text_edit_view" in project and project["timed_text_edit_view"] not in ("rows", "single"):
        errors.append(ProjectValidationError("$.timed_text_edit_view", "must be rows or single"))
    if isinstance(split_mode, str) and split_mode not in SPLIT_MODES:
        errors.append(ProjectValidationError("$.split_mode", "must be continuous or word"))
    timestamp_granularity = project.get("timestamp_granularity")
    if isinstance(timestamp_granularity, str) and timestamp_granularity not in TIMESTAMP_GRANULARITIES:
        errors.append(ProjectValidationError("$.timestamp_granularity", "must be char, word, segment, or unknown"))


def _validate_frame_pair(
    value: JsonDict,
    path: str,
    errors: list[ProjectValidationError],
) -> None:
    """Validate optional frame projections while keeping millisecond fields required."""
    has_start = "start_frame" in value
    has_end = "end_frame" in value
    if not has_start and not has_end:
        return
    if has_start != has_end:
        errors.append(ProjectValidationError(path, "start_frame and end_frame must be provided together"))
        return
    start = value.get("start_frame")
    end = value.get("end_frame")
    if type(start) is not int:
        errors.append(ProjectValidationError(f"{path}.start_frame", "must be a non-negative integer"))
    elif start < 0:
        errors.append(ProjectValidationError(f"{path}.start_frame", "must be non-negative"))
    if type(end) is not int:
        errors.append(ProjectValidationError(f"{path}.end_frame", "must be a non-negative integer"))
    elif end < 0:
        errors.append(ProjectValidationError(f"{path}.end_frame", "must be non-negative"))
    if type(start) is int and type(end) is int and end <= start:
        errors.append(ProjectValidationError(f"{path}.end_frame", "must be greater than start_frame"))


def _validate_ass_override(segment: JsonDict, path: str, errors: list[ProjectValidationError]) -> None:
    if "assOverride" not in segment:
        return
    value = segment["assOverride"]
    field = f"{path}.assOverride"
    if not isinstance(value, dict):
        errors.append(ProjectValidationError(field, "must be an object"))
        return
    normalized: JsonDict = {}
    if "an" in value:
        errors.append(ProjectValidationError(f"{field}.an", "not supported; use global style alignment"))
    if "scale" in value:
        scale = value["scale"]
        try:
            finite_scale = type(scale) in (int, float) and math.isfinite(scale)
        except OverflowError:
            finite_scale = False
        if not finite_scale or not 0.1 <= scale <= 5:
            errors.append(ProjectValidationError(f"{field}.scale", "must be a finite number from 0.1 to 5"))
        else:
            # Match JavaScript Number.toFixed(2), including exact binary ties.
            normalized_scale = float(Decimal(scale).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))
            if normalized_scale != 1:
                normalized["scale"] = normalized_scale
    if "pos" in value:
        pos = value["pos"]
        if not isinstance(pos, dict):
            errors.append(ProjectValidationError(f"{field}.pos", "must be an object with finite numeric x/y"))
        else:
            for axis in ("x", "y"):
                coordinate = pos.get(axis)
                try:
                    finite = type(coordinate) in (int, float) and math.isfinite(coordinate)
                except OverflowError:
                    finite = False
                if not finite:
                    errors.append(ProjectValidationError(f"{field}.pos.{axis}", "must be a finite number"))
            normalized["pos"] = {axis: pos.get(axis) for axis in ("x", "y")}
    if normalized:
        segment["assOverride"] = normalized
    else:
        segment.pop("assOverride", None)


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
    _validate_frame_pair(segment, path, errors)
    _validate_ass_override(segment, path, errors)
    if segment.get("speaker") is not None and (not isinstance(segment["speaker"], str) or not segment["speaker"].strip()):
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
    _validate_frame_pair(item, path, errors)
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


def _validate_head_refs(
    segments: list[JsonValue],
    errors: list[ProjectValidationError],
    *,
    path_prefix: str = "$.segments",
) -> None:
    for index, segment in enumerate(segments):
        if not isinstance(segment, dict):
            continue
        path = f"{path_prefix}[{index}]"
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
