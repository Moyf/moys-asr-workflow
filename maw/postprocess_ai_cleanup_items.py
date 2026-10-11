"""Source-indexed cleanup plans. Text and millisecond ranges remain local."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence


def collapse_echo(text: str) -> str:
    """Collapse adjacent repeated phrases for coverage comparison only."""
    # Keep numeric punctuation and word boundaries for the coverage guard.
    value = text
    pattern = re.compile(r"(.{2,40}?)\1+")
    for _ in range(3):
        updated = pattern.sub(r"\1", value)
        if updated == value:
            break
        value = updated
    return value


def remaining_text(text: str, items: Sequence[Mapping[str, object]], deleted: Sequence[int]) -> str:
    if not deleted:
        return text
    spans = item_text_spans(text, items)
    if spans is None:
        return text
    removed = set(deleted)
    return "".join(char for offset, char in enumerate(text) if not any(
        start <= offset < end for index, (start, end) in enumerate(spans) if index in removed
    )).strip()


def item_text_spans(text: str, items: Sequence[Mapping[str, object]]) -> list[tuple[int, int]] | None:
    """Locate complete source items, preserving punctuation between items."""
    spans: list[tuple[int, int]] = []
    cursor = 0
    for item in items:
        value = str(item.get("text") or "")
        if not value:
            return None
        start = text.find(value, cursor)
        if start < 0 or any(char.isalnum() for char in text[cursor:start]):
            return None
        cursor = start + len(value)
        spans.append((start, cursor))
    return None if any(char.isalnum() for char in text[cursor:]) else spans


def item_ranges(items: Sequence[Mapping[str, object]], deleted: Sequence[int]) -> list[dict[str, int]]:
    ranges: list[dict[str, int]] = []
    previous = -2
    for index in sorted(set(deleted)):
        item = items[index]
        start, end = int(item["start"]), int(item["end"])
        if end <= start:
            continue
        if ranges and index == previous + 1:
            ranges[-1]["end"] = end
        else:
            ranges.append({"start": start, "end": end})
        previous = index
    return ranges


def scoped_item_ranges(segment: Mapping[str, object], deleted: Sequence[int]) -> list[dict[str, object]]:
    """Bind cuts to exact original item indices for preview and safe reopening."""
    items = segment["items"]
    ranges = item_ranges(items, deleted)
    for entry in ranges:
        indexes = [i for i in deleted if entry["start"] <= items[i]["start"] and items[i]["end"] <= entry["end"]]
        first, last = min(indexes), max(indexes) + 1
        entry["cleanup_scope"] = {"segment_id": str(segment["id"]), "item_start": first, "item_end": last, "text": "".join(str(item["text"]) for item in items[first:last])}
    return ranges


def active_deleted_items(project: Mapping[str, object], items: Sequence[Mapping[str, object]], *, segment: Mapping[str, object] | None = None) -> list[int]:
    """Return source item indices covered by active AI-owned cuts."""
    gap_remove = project.get("gap_remove")
    if not isinstance(gap_remove, Mapping):
        return []
    provenance = gap_remove.get("provenance")
    sources = provenance.get("sources") if isinstance(provenance, Mapping) else None
    ai_ranges = sources.get("ai_cleanup") if isinstance(sources, Mapping) else None
    if not isinstance(ai_ranges, list) or not ai_ranges:
        return []
    verified = []
    for entry in ai_ranges:
        if not isinstance(entry, Mapping) or type(entry.get("start")) is not int or type(entry.get("end")) is not int:
            continue
        scope = entry.get("cleanup_scope")
        if scope is not None:
            if not isinstance(scope, Mapping) or segment is None or scope.get("segment_id") != segment.get("id"):
                continue
            first, last = scope.get("item_start"), scope.get("item_end")
            if type(first) is not int or type(last) is not int or not 0 <= first < last <= len(items):
                continue
            selected = items[first:last]
            if entry.get("start") != selected[0].get("start") or entry.get("end") != selected[-1].get("end") or scope.get("text") != "".join(str(i.get("text") or "") for i in selected):
                continue
        verified.append(entry)
    ai_ranges = verified
    active = [gap for gap in gap_remove.get("gaps", []) if isinstance(gap, Mapping) and gap.get("removed", True)]
    deleted = []
    for index, item in enumerate(items):
        start, end = item.get("start"), item.get("end")
        if type(start) is not int or type(end) is not int or end <= start:
            continue
        if any(int(r["start"]) <= start and end <= int(r["end"]) for r in ai_ranges) and any(
            int(g["start"]) <= start and end <= int(g["end"]) for g in active
        ):
            deleted.append(index)
    return deleted


def cleaned_srt_segments(project: Mapping[str, object], segments: Sequence[object]) -> list[object]:
    """Derive clean text; only active AI-owned gaps remove words.

    Manual restoration is respected. Audio-gate gaps never change wording.
    """
    result: list[object] = []
    for segment in segments:
        if not isinstance(segment, Mapping) or segment.get("disabled") or not isinstance(segment.get("items"), list):
            result.append(segment)
            continue
        items = segment["items"]
        if not all(isinstance(item, Mapping) for item in items):
            result.append(segment)
            continue
        deleted = active_deleted_items(project, items, segment=segment)
        text = remaining_text(str(segment.get("text") or ""), items, deleted)
        if text:
            result.append({**segment, "text": text})
    return result
