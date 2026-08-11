"""Subtitle-preview validation and duration-clamped project copies."""

from __future__ import annotations

import copy
import re
from typing import TypeAlias, TypeGuard


JsonScalar: TypeAlias = str | int | float | bool | None
JsonValue: TypeAlias = JsonScalar | list["JsonValue"] | dict[str, "JsonValue"]
JsonDict: TypeAlias = dict[str, JsonValue]
ValidationIssue: TypeAlias = tuple[str, str]
SUBTITLE_FONT_SIZE_MIN = 12
SUBTITLE_FONT_SIZE_MAX = 96
SUBTITLE_FONT_FAMILY_MAX_LENGTH = 128
SUBTITLE_FONT_FAMILIES = frozenset({"default", "yahei", "hei", "song", "sans"})
SUBTITLE_BACKGROUND_ALPHA_MIN = 0.0
SUBTITLE_BACKGROUND_ALPHA_MAX = 1.0
SUBTITLE_BACKGROUND_COLOR_PATTERN = re.compile(r"^#[0-9a-fA-F]{6}$")


def validate_preview(project: JsonDict) -> tuple[ValidationIssue, ...]:
    """Return path-qualified issues for optional preview subtitle geometry."""
    preview = project.get("preview")
    if preview is None:
        return ()
    if not isinstance(preview, dict):
        return (("$.preview", "must be an object or null"),)
    subtitle = preview.get("subtitle")
    if subtitle is None:
        return ()
    if not isinstance(subtitle, dict):
        return (("$.preview.subtitle", "must be an object or null"),)

    issues: list[ValidationIssue] = []
    values: dict[str, float] = {}
    for field in ("x", "y", "width", "height"):
        value = subtitle.get(field)
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            issues.append((f"$.preview.subtitle.{field}", "must be a number in [0, 1]"))
        elif not 0 <= float(value) <= 1:
            issues.append((f"$.preview.subtitle.{field}", "must be in [0, 1]"))
        else:
            values[field] = float(value)
    if "font_size" in subtitle:
        font_size = subtitle.get("font_size")
        if (not isinstance(font_size, (int, float)) or isinstance(font_size, bool)
                or not SUBTITLE_FONT_SIZE_MIN <= float(font_size) <= SUBTITLE_FONT_SIZE_MAX):
            issues.append(("$.preview.subtitle.font_size", "must be a number in [12, 96]"))
    if "font_family" in subtitle:
        font_family = subtitle.get("font_family")
        if not _is_valid_subtitle_font_family(font_family):
            issues.append((
                "$.preview.subtitle.font_family",
                "must be a built-in key or a non-empty font family name up to 128 characters",
            ))
    if "background_color" in subtitle:
        background_color = subtitle.get("background_color")
        if not _is_valid_subtitle_background_color(background_color):
            issues.append((
                "$.preview.subtitle.background_color",
                "must be a 6-digit hexadecimal color such as #000000",
            ))
    if "background_alpha" in subtitle:
        background_alpha = subtitle.get("background_alpha")
        if (not isinstance(background_alpha, (int, float)) or isinstance(background_alpha, bool)
                or not SUBTITLE_BACKGROUND_ALPHA_MIN <= float(background_alpha) <= SUBTITLE_BACKGROUND_ALPHA_MAX):
            issues.append(("$.preview.subtitle.background_alpha", "must be a number in [0, 1]"))
    if len(values) != 4:
        return tuple(issues)
    if values["x"] + values["width"] > 1:
        issues.append(("$.preview.subtitle", "x + width must be <= 1"))
    if values["y"] + values["height"] > 1:
        issues.append(("$.preview.subtitle", "y + height must be <= 1"))
    return tuple(issues)


def _is_valid_subtitle_font_family(value: JsonValue) -> TypeGuard[str]:
    if not isinstance(value, str) or not value or len(value) > SUBTITLE_FONT_FAMILY_MAX_LENGTH:
        return False
    if value != value.strip():
        return False
    return all(0x20 <= ord(char) != 0x7F for char in value)


def _is_valid_subtitle_background_color(value: JsonValue) -> TypeGuard[str]:
    return isinstance(value, str) and SUBTITLE_BACKGROUND_COLOR_PATTERN.fullmatch(value) is not None


def clamped_preview(project: JsonDict, duration_ms: int) -> JsonDict:
    """Return a deep copy whose validated segments are clipped to a duration."""
    preview = copy.deepcopy(project)
    duration = max(0, duration_ms)
    segments = project.get("segments")
    if not isinstance(segments, list):
        return preview
    preview_segments: list[JsonValue] = []
    for segment in segments:
        if not isinstance(segment, dict):
            continue
        segment_start = _required_int(segment, "start")
        segment_end = _required_int(segment, "end")
        if segment_end <= 0 or segment_start >= duration:
            continue
        next_segment = copy.deepcopy(segment)
        next_start = max(0, segment_start)
        next_end = min(duration, segment_end)
        next_segment["start"] = next_start
        next_segment["end"] = next_end
        items = segment.get("items")
        if isinstance(items, list):
            next_segment["items"] = _clamped_items(items, next_start, next_end)
        preview_segments.append(next_segment)
    preview["segments"] = preview_segments
    return preview


def _clamped_items(items: list[JsonValue], start: int, end: int) -> list[JsonValue]:
    result: list[JsonValue] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        item_start = _required_int(item, "start")
        item_end = _required_int(item, "end")
        if item_end < start or item_start > end:
            continue
        next_item = copy.deepcopy(item)
        next_start = max(start, item_start)
        next_end = min(end, item_end)
        next_item["start"] = next_start
        next_item["end"] = next_end
        if next_end >= next_start:
            result.append(next_item)
    return result


def _required_int(value: JsonDict, key: str) -> int:
    result = value.get(key)
    if not _is_int_ms(result):
        raise AssertionError(f"validated project field {key!r} is not an integer")
    return result


def _is_int_ms(value: JsonValue) -> TypeGuard[int]:
    return type(value) is int
