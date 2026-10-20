"""Source-indexed cleanup plans. Text and millisecond ranges remain local."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from maw.postprocess_ai_cleanup_safety import english_hesitation_only, protected_information_loss_reason, safe_echo_phrase


def collapse_echo(text: str) -> str:
    """Collapse adjacent repeated phrases for coverage comparison only."""
    # Keep numeric punctuation and word boundaries for the coverage guard.
    value = text
    pattern = re.compile(r"(.{2,40}?)\1+")
    for _ in range(3):
        updated = pattern.sub(lambda match: match[1] if safe_echo_phrase(match[1]) or protected_information_loss_reason(match[0], match[1]) is None else match[0], value)
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
    for index, item in enumerate(items):
        value = str(item.get("text") or "")
        # ASR word tokens can own the spaces at a cue's edges, while the
        # editable source is stripped. Only remove whitespace absent at those
        # edges; internal spaces and all spoken characters still match exactly.
        if index == 0 and text and not text[0].isspace():
            value = value.lstrip()
        if index == len(items) - 1 and text and not text[-1].isspace():
            value = value.rstrip()
        if not value:
            return None
        start = text.find(value, cursor)
        if start < 0 or any(char.isalnum() for char in text[cursor:start]):
            return None
        cursor = start + len(value)
        spans.append((start, cursor))
    return None if any(char.isalnum() for char in text[cursor:]) else spans


def english_hesitation_removal(text: str, items: Sequence[Mapping[str, object]], deleted: Sequence[int]) -> bool:
    """Prove each continuous cut is a complete hesitation in the source."""
    spans = item_text_spans(text, items)
    indexes = sorted(set(deleted))
    if spans is None or not indexes:
        return False
    runs: list[list[int]] = []
    for index in indexes:
        if runs and index == runs[-1][-1] + 1:
            runs[-1].append(index)
        else:
            runs.append([index])
    for run in runs:
        start, end = spans[run[0]][0], spans[run[-1]][1]
        # Items may split an English word. Neither those cuts nor unrelated
        # fragments joined across retained words prove a hesitation sound.
        value = text[start:end]
        left = start + len(value) - len(value.lstrip())
        right = end - (len(value) - len(value.rstrip()))
        if (left and re.match(r"[A-Za-z0-9_]", text[left - 1])) or (
            right < len(text) and re.match(r"[A-Za-z0-9_]", text[right - 1]) and re.match(r"[A-Za-z0-9_]", text[right])
        ):
            return False
        if not english_hesitation_only(value):
            return False
    return True


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


def verified_scope_indices(entry: Mapping[str, object], segment: Mapping[str, object]) -> range:
    """Verify a scope against source words even when its audio is restored."""
    scope = entry.get("cleanup_scope")
    items = segment.get("items")
    if not isinstance(scope, Mapping) or not isinstance(items, list) or scope.get("segment_id") != segment.get("id"):
        return range(0)
    first, last = scope.get("item_start"), scope.get("item_end")
    if type(first) is not int or type(last) is not int or not 0 <= first < last <= len(items):
        return range(0)
    selected = items[first:last]
    if not all(isinstance(item, Mapping) for item in selected):
        return range(0)
    if type(entry.get("start")) is not int or type(entry.get("end")) is not int or entry["end"] <= entry["start"]:
        return range(0)
    if entry["start"] != selected[0].get("start") or entry["end"] != selected[-1].get("end") or scope.get("text") != "".join(str(i.get("text") or "") for i in selected):
        return range(0)
    return range(first, last)


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
        if segment is None or not verified_scope_indices(entry, segment):
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
