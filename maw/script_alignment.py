"""Script-driven recording alignment for the take-selection MVP.

This module deliberately stops before media rendering.  It turns an ASR
project and an authoritative script into candidate source ranges, alternative
alignment paths, and the source ranges that were not selected.  All times are
copied from the source project and remain integer milliseconds.  When complete
item timestamps are available, a source segment may be split at item
boundaries during export.
"""

from __future__ import annotations

import copy
import base64
import binascii
import difflib
import math
import unicodedata
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Final


DEFAULT_MIN_SCORE: Final[float] = 0.55
DEFAULT_COMPLETE_SCORE: Final[float] = 0.78
DEFAULT_MAX_CUES_PER_CANDIDATE: Final[int] = 8
DEFAULT_MAX_CANDIDATES_PER_LINE: Final[int] = 12
DEFAULT_TOP_PATHS: Final[int] = 5
DEFAULT_ALTERNATIVE_MAX_GAP_MS: Final[int] = 10_000
DEFAULT_ALTERNATIVE_MAX_CUES: Final[int] = 8
MAX_SCRIPT_LINES: Final[int] = 500
MAX_SOURCE_CUES: Final[int] = 5000
MIN_COMPLETE_TARGET_COVERAGE: Final[float] = 0.82
MIN_COMPLETE_SOURCE_COVERAGE: Final[float] = 0.62
MIN_INCOMPLETE_TARGET_COVERAGE: Final[float] = 0.30
MIN_INCOMPLETE_SOURCE_COVERAGE: Final[float] = 0.60
MIN_SAFE_ITEM_GAP_MS: Final[int] = 120
MIN_INTERNAL_REPEAT_TEXT_LENGTH: Final[int] = 3
MIN_NEAR_REPETITION_GAP_MS: Final[int] = 250
MIN_NEAR_REPETITION_TEXT_LENGTH: Final[int] = 8
MIN_NEAR_REPETITION_PREFIX_LENGTH: Final[int] = 4
MIN_NEAR_REPETITION_PREFIX_RATIO: Final[float] = 0.35
GAP_REMOVE_OPERATION_MODES: Final[frozenset[str]] = frozenset({
    "none",
    "boundary_drag",
    "middle_drag",
    "boundary_and_middle",
})
DEFAULT_GAP_REMOVE_OPERATION_MODE: Final[str] = "boundary_drag"
GAP_PROVENANCE_SCHEMA: Final[str] = "moy.asr.gap_provenance.v1"
GAP_PROVENANCE_SOURCES: Final[tuple[str, ...]] = (
    "script_alignment",
    "audio_gate",
    "manual",
    "legacy",
)


@dataclass(frozen=True, slots=True)
class _SourceItem:
    index: int
    start: int
    end: int
    text: str
    normalized: str


@dataclass(frozen=True, slots=True)
class _SourceCue:
    ordinal: int
    id: str
    start: int
    end: int
    text: str
    normalized: str
    items: tuple[_SourceItem, ...] = ()


@dataclass(frozen=True, slots=True)
class _SourceAtom:
    cue_index: int
    item_start: int
    item_end: int
    start: int
    end: int
    text: str


def normalize_alignment_text(value: str) -> str:
    """Normalize text for matching while retaining the original source text."""

    chars: list[str] = []
    for char in unicodedata.normalize("NFKC", value).casefold():
        category = unicodedata.category(char)
        if category[0] in {"L", "M", "N"}:
            chars.append(char)
    return "".join(chars)


def align_project_to_script(
    project: Mapping[str, object],
    script_text: str,
    *,
    min_score: float = DEFAULT_MIN_SCORE,
    complete_score: float = DEFAULT_COMPLETE_SCORE,
    max_cues_per_candidate: int = DEFAULT_MAX_CUES_PER_CANDIDATE,
    max_candidates_per_line: int = DEFAULT_MAX_CANDIDATES_PER_LINE,
    top_paths: int = DEFAULT_TOP_PATHS,
    alternative_max_gap_ms: int = DEFAULT_ALTERNATIVE_MAX_GAP_MS,
    alternative_max_cues: int = DEFAULT_ALTERNATIVE_MAX_CUES,
) -> dict[str, object]:
    """Return a bounded alignment preview without modifying ``project``.

    Source subtitle segments remain the ordering unit, while complete item
    timestamps may trim a candidate at a safe word/item boundary.  This is
    important when one ASR segment contains a valid script line followed by an
    extra sentence.
    """

    if not 0 <= min_score <= 1 or not 0 <= complete_score <= 1:
        raise ValueError("alignment scores must be between 0 and 1")
    if complete_score < min_score:
        raise ValueError("complete_score must be at least min_score")
    if max_cues_per_candidate < 1:
        raise ValueError("max_cues_per_candidate must be positive")
    if max_candidates_per_line < 1 or top_paths < 1:
        raise ValueError("candidate and path limits must be positive")
    if alternative_max_gap_ms < 0 or alternative_max_cues < 0:
        raise ValueError("alternative locality limits must not be negative")

    script_lines = _script_lines(script_text)
    if not script_lines:
        raise ValueError("script is empty")
    if len(script_lines) > MAX_SCRIPT_LINES:
        raise ValueError(f"script has too many non-empty lines (maximum {MAX_SCRIPT_LINES})")

    source_cues = _source_cues(project)
    if len(source_cues) > MAX_SOURCE_CUES:
        raise ValueError(f"project has too many enabled subtitle segments (maximum {MAX_SOURCE_CUES})")
    if not source_cues:
        raise ValueError("project has no enabled subtitle segments")

    candidates_by_line: list[list[dict[str, object]]] = []
    for line_index, line in enumerate(script_lines):
        line_candidates = _candidate_windows(
            line,
            line_index,
            source_cues,
            min_score=min_score,
            complete_score=complete_score,
            max_cues_per_candidate=max_cues_per_candidate,
            max_candidates=max_candidates_per_line,
        )
        _assign_alternative_groups(
            line_candidates,
            line_index=line_index,
            max_gap_ms=alternative_max_gap_ms,
            max_cues=alternative_max_cues,
        )
        candidates_by_line.append(line_candidates)

    paths = _build_paths(candidates_by_line, top_paths=top_paths)
    default_path_id = _default_path_id(paths, candidates_by_line)
    default_path = next(path for path in paths if path["id"] == default_path_id)
    extras_by_path = {
        str(path["id"]): _extras_for_path(path, source_cues, candidates_by_line)
        for path in paths
    }
    extras = extras_by_path[default_path_id]
    warnings: list[str] = []
    if not _project_has_items(project):
        warnings.append("当前工程没有完整 items；候选和导出只能按字幕段边界处理。")
    elif any(not cue.items for cue in source_cues):
        warnings.append("部分源字幕段没有有效 items；这些段仍按字幕段边界参与对齐。")
    if any(not line_candidates for line_candidates in candidates_by_line):
        warnings.append("至少有一行文稿没有达到最低匹配度，请在应用前确认录音是否完整。")

    return {
        "version": 1,
        "scriptLines": [
            {"id": f"line-{index + 1:03d}", "text": text}
            for index, text in enumerate(script_lines)
        ],
        "sourceCues": [
            {
                "id": cue.id,
                "originalIndex": cue.ordinal,
                "start": cue.start,
                "end": cue.end,
                "text": cue.text,
                "items": [
                    {"text": item.text, "start": item.start, "end": item.end}
                    for item in cue.items
                ],
            }
            for cue in source_cues
        ],
        "candidatesByLine": candidates_by_line,
        "paths": paths,
        "defaultPathId": default_path_id,
        "defaultSelection": _selection_from_path(default_path),
        "extras": extras,
        "extrasByPath": extras_by_path,
        "sourceDurationMs": max(cue.end for cue in source_cues),
        "warnings": warnings,
        "settings": {
            "minScore": min_score,
            "completeScore": complete_score,
            "maxCuesPerCandidate": max_cues_per_candidate,
            "alternativeMaxGapMs": alternative_max_gap_ms,
            "alternativeMaxCues": alternative_max_cues,
        },
    }


def make_selection_manifest(
    alignment: Mapping[str, object],
    selected_by_line: Mapping[str, object],
    kept_extra_ids: Sequence[object] = (),
    *,
    extra_actions: Mapping[str, object] | None = None,
    candidate_actions: Mapping[str, object] | None = None,
) -> dict[str, object]:
    """Validate a UI selection and return a serializable selection manifest.

    ``extra_actions`` is intentionally separate from script-line selection. A
    source range that is clearly a failed take can default to ``discard``;
    content outside the script defaults to ``keep`` because an extra take may
    be intentional material rather than a mistake.

    ``candidate_actions`` contains explicit overrides for selected candidates.
    An incomplete candidate remains automatically disabled until its action is
    ``keep``; a complete candidate remains enabled unless its action is
    ``discard``.  The alignment classification is deliberately preserved so
    the override remains visible and auditable.
    """

    raw_lines = alignment.get("scriptLines")
    raw_candidates = alignment.get("candidatesByLine")
    if not isinstance(raw_lines, list) or not isinstance(raw_candidates, list):
        raise ValueError("alignment is missing script lines or candidates")
    if len(raw_lines) != len(raw_candidates):
        raise ValueError("alignment line/candidate counts do not match")

    candidates_by_id: dict[str, dict[str, object]] = {}
    for line_candidates in raw_candidates:
        if not isinstance(line_candidates, list):
            raise ValueError("alignment candidates must be arrays")
        for candidate in line_candidates:
            if not isinstance(candidate, dict):
                raise ValueError("alignment candidate must be an object")
            candidate_id = str(candidate.get("id") or "")
            if not candidate_id or candidate_id in candidates_by_id:
                raise ValueError("alignment candidate IDs must be unique")
            candidates_by_id[candidate_id] = candidate

    requested_candidate_actions: dict[str, str | None] = {}
    if candidate_actions is not None:
        if not isinstance(candidate_actions, Mapping):
            raise ValueError("candidateActions 必须是对象")
        for raw_id, raw_action in candidate_actions.items():
            candidate_id = str(raw_id).strip()
            if not candidate_id:
                continue
            action = str(raw_action or "").strip().lower()
            if action not in {"keep", "discard", ""}:
                raise ValueError(f"candidate {candidate_id} 的 action 无效")
            requested_candidate_actions[candidate_id] = action or None
    unknown_candidate_ids = sorted(set(requested_candidate_actions) - set(candidates_by_id))
    if unknown_candidate_ids:
        raise ValueError("unknown candidate: " + ", ".join(unknown_candidate_ids))

    selected: list[dict[str, object]] = []
    previous_end = -1
    missing_lines: list[str] = []
    for index, raw_line in enumerate(raw_lines):
        if not isinstance(raw_line, dict):
            raise ValueError("alignment script line must be an object")
        line_id = str(raw_line.get("id") or f"line-{index + 1:03d}")
        candidate_id = str(selected_by_line.get(line_id) or "").strip()
        if not candidate_id:
            missing_lines.append(line_id)
            continue
        candidate = candidates_by_id.get(candidate_id)
        if candidate is None:
            raise ValueError(f"unknown candidate selected for {line_id}: {candidate_id}")
        start_ordinal = _int_value(candidate.get("sourceStartOrdinal"))
        end_ordinal = _int_value(candidate.get("sourceEndOrdinal"))
        if start_ordinal is None or end_ordinal is None or end_ordinal <= start_ordinal:
            raise ValueError(f"candidate {candidate_id} has invalid source range")
        if start_ordinal < previous_end:
            raise ValueError("selected candidates must stay in source order and cannot overlap")
        previous_end = end_ordinal
        status = "match" if _candidate_is_complete(candidate) else "incomplete"
        selected.append({
            "lineId": line_id,
            "candidateId": candidate_id,
            "scriptText": str(raw_line.get("text") or ""),
            "sourceStart": candidate.get("start"),
            "sourceEnd": candidate.get("end"),
            "sourceStartOrdinal": start_ordinal,
            "sourceEndOrdinal": end_ordinal,
            "sourceCueIds": copy.deepcopy(candidate.get("sourceCueIds", [])),
            "sourceSlices": copy.deepcopy(candidate.get("sourceSlices", [])),
            "sourceText": candidate.get("sourceText", ""),
            "score": candidate.get("score", 0),
            "status": status,
            "manualEnabled": (
                status == "incomplete"
                and requested_candidate_actions.get(candidate_id) == "keep"
            ),
            "manualDisabled": (
                status == "match"
                and requested_candidate_actions.get(candidate_id) == "discard"
            ),
            "alternativeGroupId": candidate.get("alternativeGroupId", ""),
            "alternativeGroupSize": candidate.get("alternativeGroupSize", 1),
            "internalSkips": copy.deepcopy(candidate.get("internalSkips", [])),
        })

    selected_candidate_ids = {str(item["candidateId"]) for item in selected}
    unselected_enabled_ids = sorted(
        candidate_id
        for candidate_id, action in requested_candidate_actions.items()
        if action == "keep" and candidate_id not in selected_candidate_ids
    )
    if unselected_enabled_ids:
        raise ValueError(
            "candidate must be selected before manual enable: "
            + ", ".join(unselected_enabled_ids)
        )
    selected_by_candidate_id = {
        str(item["candidateId"]): item
        for item in selected
    }
    normalized_candidate_actions = {
        candidate_id: action
        for candidate_id, action in requested_candidate_actions.items()
        if (
            candidate_id in selected_by_candidate_id
            and (
                (
                    selected_by_candidate_id[candidate_id].get("status") == "incomplete"
                    and action == "keep"
                )
                or (
                    selected_by_candidate_id[candidate_id].get("status") == "match"
                    and action == "discard"
                )
            )
            and action is not None
        )
    }

    source_cues = _alignment_source_cues(alignment)
    all_candidates = list(candidates_by_id.values())
    actual_extras = _extras_for_selection(selected, source_cues, all_candidates)
    extra_by_id = {str(extra["id"]): extra for extra in actual_extras}
    actions: dict[str, str | None] = {}
    if extra_actions is not None:
        if not isinstance(extra_actions, Mapping):
            raise ValueError("extraActions 必须是对象")
        for raw_id, raw_action in extra_actions.items():
            extra_id = str(raw_id).strip()
            if not extra_id:
                continue
            action = str(raw_action or "").strip().lower()
            if action not in {"keep", "discard", "review", ""}:
                raise ValueError(f"extra range {extra_id} 的 action 无效")
            actions[extra_id] = action or None
    kept_ids = {str(value).strip() for value in kept_extra_ids if str(value).strip()}
    for extra_id in kept_ids:
        actions[extra_id] = "keep"
    unknown_extra_ids = sorted(set(actions) - set(extra_by_id))
    if unknown_extra_ids:
        raise ValueError("unknown extra range: " + ", ".join(unknown_extra_ids))

    for extra_id, extra in extra_by_id.items():
        action = actions.get(extra_id)
        if action is None:
            action = "discard" if extra.get("kind") == "skip-source" else "keep"
        actions[extra_id] = action
    kept_extras = [
        copy.deepcopy(extra_by_id[extra_id])
        for extra_id, action in actions.items()
        if action == "keep"
    ]
    discarded_extras = [
        extra_id for extra_id, action in actions.items()
        if action == "discard"
    ]
    unresolved_extras = [
        extra_id for extra_id, action in actions.items()
        if action == "review"
    ]
    incomplete_lines = [
        str(item["lineId"])
        for item in selected
        if item.get("status") == "incomplete"
    ]
    manually_enabled_candidate_ids = [
        str(item["candidateId"])
        for item in selected
        if item.get("manualEnabled") is True
    ]
    manually_enabled_line_ids = [
        str(item["lineId"])
        for item in selected
        if item.get("manualEnabled") is True
    ]
    manually_disabled_candidate_ids = [
        str(item["candidateId"])
        for item in selected
        if item.get("manualDisabled") is True
    ]
    manually_disabled_line_ids = [
        str(item["lineId"])
        for item in selected
        if item.get("manualDisabled") is True
    ]
    blocked_incomplete_lines = [
        line_id for line_id in incomplete_lines
        if line_id not in manually_enabled_line_ids
    ]
    keep_ranges: list[dict[str, object]] = []
    for item in selected:
        keep_ranges.append({
            "id": item["candidateId"],
            "kind": "script",
            "start": item["sourceStart"],
            "end": item["sourceEnd"],
            "sourceCueIds": item["sourceCueIds"],
            "sourceSlices": copy.deepcopy(
                _source_slices_without_internal_skips(item, source_cues)
            ),
        })
    keep_ranges.extend(
        {
            "id": str(extra["id"]),
            "kind": extra.get("kind", "extra"),
            "start": extra.get("start"),
            "end": extra.get("end"),
            "sourceCueIds": copy.deepcopy(extra.get("sourceCueIds", [])),
            "sourceSlices": copy.deepcopy(extra.get("sourceSlices", [])),
        }
        for extra in kept_extras
    )
    keep_ranges.sort(key=lambda item: (_int_value(item.get("start")) or 0, _int_value(item.get("end")) or 0))
    return {
        "version": 1,
        "defaultPathId": alignment.get("defaultPathId", ""),
        "selected": selected,
        "missingLineIds": missing_lines,
        "incompleteLineIds": incomplete_lines,
        "blockedIncompleteLineIds": blocked_incomplete_lines,
        "manuallyEnabledCandidateIds": manually_enabled_candidate_ids,
        "manuallyEnabledLineIds": manually_enabled_line_ids,
        "manuallyDisabledCandidateIds": manually_disabled_candidate_ids,
        "manuallyDisabledLineIds": manually_disabled_line_ids,
        "candidateActions": normalized_candidate_actions,
        "extraRanges": copy.deepcopy(actual_extras),
        "extraActions": actions,
        "keptExtras": kept_extras,
        "discardedExtraIds": discarded_extras,
        "unresolvedExtraIds": unresolved_extras,
        "keepRanges": keep_ranges,
        "readyForMediaTrim": not missing_lines and not blocked_incomplete_lines and not unresolved_extras and bool(selected),
    }


def _provenance_time(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        numeric = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(numeric):
        return None
    return max(0, int(round(numeric)))


def _provenance_id(value: object, source: str, index: int, used: set[str]) -> str:
    requested = value.strip()[:160] if isinstance(value, str) else ""
    base = requested or f"{source}-{index + 1:03d}"
    result = base
    suffix = 2
    while result in used:
        result = f"{base}-{suffix}"
        suffix += 1
    used.add(result)
    return result


def _normalize_provenance_ranges(
    raw_ranges: object,
    source: str,
    *,
    sort: bool = False,
) -> list[dict[str, object]]:
    if not isinstance(raw_ranges, list) or source not in GAP_PROVENANCE_SOURCES:
        return []
    used: set[str] = set()
    result: list[dict[str, object]] = []
    for index, raw_range in enumerate(raw_ranges):
        if not isinstance(raw_range, Mapping):
            continue
        start = _provenance_time(raw_range.get("start"))
        end = _provenance_time(raw_range.get("end"))
        if start is None or end is None or end <= start:
            continue
        normalized: dict[str, object] = {
            "id": _provenance_id(raw_range.get("id"), source, index, used),
            "source": source,
            "start": start,
            "end": end,
            "removed": raw_range.get("removed") is not False
            if source in {"manual", "legacy"} else True,
        }
        if source == "manual" and raw_range.get("operation") == "move":
            base_start = _provenance_time(raw_range.get("base_start"))
            base_end = _provenance_time(raw_range.get("base_end"))
            raw_targets = raw_range.get("target_ranges")
            if isinstance(raw_targets, list):
                targets = _normalize_gap_entries(raw_targets)
            else:
                target_start = _provenance_time(raw_range.get("target_start"))
                target_end = _provenance_time(raw_range.get("target_end"))
                targets = (
                    [{"start": target_start, "end": target_end, "removed": True}]
                    if target_start is not None and target_end is not None and target_end > target_start
                    else []
                )
            if base_start is not None and base_end is not None and base_end > base_start and targets:
                normalized.update({
                    "operation": "move",
                    "base_start": base_start,
                    "base_end": base_end,
                })
                if len(targets) == 1:
                    normalized["target_start"] = targets[0]["start"]
                    normalized["target_end"] = targets[0]["end"]
                else:
                    normalized["target_ranges"] = [
                        {"start": target["start"], "end": target["end"]}
                        for target in targets
                    ]
        elif source == "manual" and raw_range.get("operation") == "boundary_resize":
            edge = raw_range.get("edge")
            base = _provenance_time(raw_range.get("base"))
            boundary = _provenance_time(raw_range.get("boundary"))
            cleared_ranges = _normalize_gap_entries(raw_range.get("cleared_ranges"))
            if edge in {"start", "end"} and base is not None and boundary is not None:
                normalized.update({
                    "operation": "boundary_resize",
                    "edge": edge,
                    "base": base,
                    "boundary": boundary,
                })
                if cleared_ranges:
                    normalized["cleared_ranges"] = [
                        {"start": item["start"], "end": item["end"]}
                        for item in cleared_ranges
                    ]
        result.append(normalized)
    if sort:
        result.sort(key=lambda item: (int(item["start"]), int(item["end"]), str(item["id"])))
    return result


def _normalize_gap_entries(raw_gaps: object) -> list[dict[str, object]]:
    if not isinstance(raw_gaps, list):
        return []
    result: list[dict[str, object]] = []
    for item in raw_gaps:
        if not isinstance(item, Mapping):
            continue
        start = _provenance_time(item.get("start"))
        end = _provenance_time(item.get("end"))
        if start is not None and end is not None and end > start:
            result.append({"start": start, "end": end, "removed": item.get("removed") is not False})
    return result


def _coalesce_gap_states(gaps: Sequence[Mapping[str, object]]) -> list[dict[str, object]]:
    ordered = sorted(
        (
            {"start": int(item["start"]), "end": int(item["end"]), "removed": item.get("removed") is not False}
            for item in gaps
            if _provenance_time(item.get("start")) is not None
            and _provenance_time(item.get("end")) is not None
            and int(item["end"]) > int(item["start"])
        ),
        key=lambda item: (int(item["start"]), int(item["end"])),
    )
    result: list[dict[str, object]] = []
    for gap in ordered:
        if not result:
            result.append(gap)
            continue
        previous = result[-1]
        if gap["start"] <= previous["end"] and gap["removed"] == previous["removed"]:
            previous["end"] = max(int(previous["end"]), int(gap["end"]))
            continue
        start = max(int(gap["start"]), int(previous["end"]))
        if int(gap["end"]) > start:
            result.append({**gap, "start": start})
    return result


def _apply_gap_state_range(
    gaps: Sequence[Mapping[str, object]],
    start_value: object,
    end_value: object,
    removed: bool,
    *,
    preserve_uncovered: bool = False,
) -> list[dict[str, object]]:
    source = _coalesce_gap_states(gaps)
    try:
        start_numeric = min(float(start_value), float(end_value))
        end_numeric = max(float(start_value), float(end_value))
    except (TypeError, ValueError, OverflowError):
        return source
    start = _provenance_time(start_numeric)
    end = _provenance_time(end_numeric)
    if start is None or end is None or end <= start:
        return source
    next_gaps: list[dict[str, object]] = []
    for gap in source:
        gap_start = int(gap["start"])
        gap_end = int(gap["end"])
        if gap_end <= start or gap_start >= end:
            next_gaps.append(dict(gap))
            continue
        if gap_start < start:
            next_gaps.append({**gap, "end": start})
        if not removed and not preserve_uncovered:
            next_gaps.append({
                "start": max(gap_start, start),
                "end": min(gap_end, end),
                "removed": False,
            })
        if gap_end > end:
            next_gaps.append({**gap, "start": end})
    if removed or preserve_uncovered:
        next_gaps.append({"start": start, "end": end, "removed": removed})
    return _coalesce_gap_states(next_gaps)


def _clear_gap_state_range(
    gaps: Sequence[Mapping[str, object]],
    start_value: object,
    end_value: object,
    removed: bool | None = None,
) -> list[dict[str, object]]:
    source = _coalesce_gap_states(gaps)
    start = _provenance_time(start_value)
    end = _provenance_time(end_value)
    if start is None or end is None or end <= start:
        return source
    result: list[dict[str, object]] = []
    for gap in source:
        gap_start = int(gap["start"])
        gap_end = int(gap["end"])
        if gap_end <= start or gap_start >= end or (
            removed is not None and (gap.get("removed") is not False) != removed
        ):
            result.append(dict(gap))
            continue
        if gap_start < start:
            result.append({**gap, "end": start})
        if gap_end > end:
            result.append({**gap, "start": end})
    return _coalesce_gap_states(result)


def _normalize_gap_provenance(
    value: object,
    fallback_gaps: object = None,
) -> dict[str, object]:
    has_value = isinstance(value, Mapping)
    source = value if has_value else {}
    raw_sources = source.get("sources") if isinstance(source.get("sources"), Mapping) else {}
    # Provenance was introduced after the editor had already used the audio
    # gate for every persisted Gap. Migrate enabled legacy ranges into that
    # source so a later scan or shrink replaces them. A legacy restoration is
    # retained as a manual override to preserve the existing playback result.
    legacy = _normalize_provenance_ranges(
        source.get("legacy") if has_value else _normalize_gap_entries(fallback_gaps),
        "legacy",
    )
    legacy_audio_gaps = [item for item in legacy if item["removed"] is not False]
    legacy_manual_overrides = [item for item in legacy if item["removed"] is False]
    raw_audio_gaps = raw_sources.get("audio_gate")
    raw_manual_overrides = source.get("manual_overrides")
    return {
        "schema": GAP_PROVENANCE_SCHEMA,
        "sources": {
            "script_alignment": _normalize_provenance_ranges(
                raw_sources.get("script_alignment"), "script_alignment", sort=True,
            ),
            "audio_gate": _normalize_provenance_ranges(
                [
                    *(raw_audio_gaps if isinstance(raw_audio_gaps, list) else []),
                    *legacy_audio_gaps,
                ],
                "audio_gate",
                sort=True,
            ),
        },
        "manual_overrides": _normalize_provenance_ranges(
            [
                *legacy_manual_overrides,
                *(raw_manual_overrides if isinstance(raw_manual_overrides, list) else []),
            ],
            "manual",
        ),
        "legacy": [],
    }


def _gap_ranges_from_provenance(value: Mapping[str, object]) -> list[dict[str, object]]:
    sources = value.get("sources") if isinstance(value.get("sources"), Mapping) else {}
    result: list[dict[str, object]] = []
    for source_name in ("script_alignment", "audio_gate"):
        ranges = sources.get(source_name, [])
        if isinstance(ranges, list):
            for item in ranges:
                result = _apply_gap_state_range(result, item["start"], item["end"], True)
    for key in ("legacy", "manual_overrides"):
        ranges = value.get(key, [])
        if isinstance(ranges, list):
            for item in ranges:
                removed = item.get("removed") is not False
                if item.get("operation") == "move":
                    result = _clear_gap_state_range(
                        result, item["base_start"], item["base_end"], removed,
                    )
                    raw_targets = item.get("target_ranges")
                    targets = raw_targets if isinstance(raw_targets, list) else [{
                        "start": item.get("target_start"),
                        "end": item.get("target_end"),
                    }]
                    for target in targets:
                        if isinstance(target, Mapping):
                            result = _apply_gap_state_range(
                                result,
                                target.get("start"),
                                target.get("end"),
                                removed,
                                preserve_uncovered=not removed,
                            )
                elif item.get("operation") == "boundary_resize":
                    cleared_ranges = item.get("cleared_ranges")
                    if isinstance(cleared_ranges, list):
                        for cleared in cleared_ranges:
                            if isinstance(cleared, Mapping):
                                result = _clear_gap_state_range(
                                    result, cleared.get("start"), cleared.get("end"),
                                )
                    base = item["base"]
                    boundary = item["boundary"]
                    edge = item["edge"]
                    if (edge == "start" and int(boundary) > int(base)) or (
                        edge == "end" and int(boundary) < int(base)
                    ):
                        result = _clear_gap_state_range(
                            result,
                            min(int(base), int(boundary)),
                            max(int(base), int(boundary)),
                        )
                    else:
                        result = _apply_gap_state_range(
                            result,
                            boundary if edge == "start" else base,
                            base if edge == "start" else boundary,
                            removed,
                            preserve_uncovered=not removed,
                        )
                else:
                    result = _apply_gap_state_range(
                        result,
                        item["start"],
                        item["end"],
                        removed,
                        preserve_uncovered=not removed,
                    )
    return _coalesce_gap_states(result)


def _decorate_gap_ranges(
    gaps: Sequence[Mapping[str, object]],
    provenance: Mapping[str, object],
) -> list[dict[str, object]]:
    final_gaps = _coalesce_gap_states(gaps)
    sources = provenance.get("sources") if isinstance(provenance.get("sources"), Mapping) else {}
    records: list[Mapping[str, object]] = []
    for source_name in ("script_alignment", "audio_gate"):
        ranges = sources.get(source_name, [])
        if isinstance(ranges, list):
            records.extend(item for item in ranges if isinstance(item, Mapping))
    for key in ("manual_overrides", "legacy"):
        ranges = provenance.get(key, [])
        if isinstance(ranges, list):
            records.extend(item for item in ranges if isinstance(item, Mapping))

    decorated: list[dict[str, object]] = []
    for gap in final_gaps:
        start = int(gap["start"])
        end = int(gap["end"])
        boundaries = {start, end}
        for record in records:
            record_start = int(record["start"])
            record_end = int(record["end"])
            if record_end > start and record_start < end:
                boundaries.add(max(start, record_start))
                boundaries.add(min(end, record_end))
        points = sorted(boundaries)
        for left, right in zip(points, points[1:]):
            if right <= left:
                continue
            origins = [
                source_name for source_name in GAP_PROVENANCE_SOURCES
                if any(
                    record.get("source") == source_name
                    and int(record["start"]) < right
                    and int(record["end"]) > left
                    for record in records
                )
            ]
            base_origins = [source_name for source_name in origins if source_name != "manual"]
            source = (
                base_origins[0] if len(base_origins) == 1
                else "manual" if not base_origins and "manual" in origins
                else None
            )
            decorated.append({
                **gap,
                "start": left,
                "end": right,
                "source": source,
                "origins": origins,
            })
    return decorated


def _replace_provenance_source(
    value: object,
    source: str,
    ranges: object,
    fallback_gaps: object = None,
) -> dict[str, object]:
    result = _normalize_gap_provenance(value, fallback_gaps)
    if source in {"script_alignment", "audio_gate"}:
        result["sources"][source] = _normalize_provenance_ranges(ranges, source, sort=True)
    return result


def apply_alignment_to_project(
    project: Mapping[str, object],
    alignment: Mapping[str, object],
    selection: Mapping[str, object],
    *,
    detect_audio_gaps: bool = True,
    minimum_gap_ms: int = 500,
    threshold_db: float = -24,
    hysteresis_db: float = 2,
    lead_in_ms: int = 40,
    lead_out_ms: int = 80,
    gap_remove_override: Mapping[str, object] | None = None,
) -> dict[str, object]:
    """Create a MAWE-compatible project from one alignment selection.

    The source project is copied.  Selected complete candidates, manually
    enabled incomplete candidates, and explicitly kept extras remain enabled;
    selected complete candidates with a manual ``discard`` action and every
    other source cue are disabled.  When a kept range only covers part of a
    cue with valid items, that cue is split into item-aligned
    enabled/disabled segments.  The complement of those kept ranges, plus
    optional waveform-detected silence, is written as ``gap_remove.gaps``.
    """

    output = copy.deepcopy(dict(project))
    raw_segments = output.get("segments")
    if not isinstance(raw_segments, list):
        raise ValueError("project segments must be an array")
    source_cues = _alignment_source_cues(alignment)
    kept_intervals_by_cue = _kept_intervals_by_cue(selection, source_cues)
    kept_intervals = [
        interval
        for intervals in kept_intervals_by_cue.values()
        for interval in intervals
    ]
    if source_cues:
        source_start = min(cue.start for cue in source_cues)
        source_end = max(cue.end for cue in source_cues)
    else:
        source_start = 0
        source_end = 0
    removed_ranges = _complement_ranges(source_start, source_end, kept_intervals)
    script_alignment_ranges = [
        {"start": start, "end": end}
        for start, end in removed_ranges
    ]
    audio_gap_ranges: list[dict[str, int]] = []
    waveform = output.get("waveform")
    if detect_audio_gaps and isinstance(waveform, Mapping):
        audio_gap_ranges = detect_waveform_gaps(
            waveform,
            minimum_ms=minimum_gap_ms,
            threshold_db=threshold_db,
            hysteresis_db=hysteresis_db,
            lead_in_ms=lead_in_ms,
            lead_out_ms=lead_out_ms,
        )
        removed_ranges = _merge_ranges(
            [*removed_ranges, *[(item["start"], item["end"]) for item in audio_gap_ranges]]
        )

    output["segments"] = _apply_kept_intervals_to_segments(
        raw_segments,
        source_cues,
        kept_intervals_by_cue,
        removed_ranges,
    )
    _refresh_main_binding_offsets(output)

    existing_gap = output.get("gap_remove")
    existing_gaps = existing_gap.get("gaps", []) if isinstance(existing_gap, Mapping) else []
    existing_provenance = _normalize_gap_provenance(
        existing_gap.get("provenance") if isinstance(existing_gap, Mapping) else None,
        existing_gaps,
    )
    provenance = _replace_provenance_source(
        existing_provenance,
        "script_alignment",
        script_alignment_ranges,
    )
    if detect_audio_gaps and isinstance(waveform, Mapping):
        provenance = _replace_provenance_source(
            provenance,
            "audio_gate",
            audio_gap_ranges,
        )
    final_gaps = _decorate_gap_ranges(_gap_ranges_from_provenance(provenance), provenance)
    gap_remove = {
        "schema": "moy.asr.gap_remove.v1",
        "detector": "audio_gate",
        "minimum_ms": max(100, min(60000, int(minimum_gap_ms))),
        "threshold_db": max(-96, min(0, float(threshold_db))),
        "hysteresis_db": max(0, min(30, float(hysteresis_db))),
        "lead_in_ms": max(0, min(2000, int(lead_in_ms))),
        "lead_out_ms": max(0, min(2000, int(lead_out_ms))),
        "skip_playback": True,
        "manual_corrections": bool(provenance["manual_overrides"]),
        "operation_mode": DEFAULT_GAP_REMOVE_OPERATION_MODE,
        "disable_coverage_percent": 80,
        "disable_remaining_ms": 300,
        "gaps": final_gaps,
        "provenance": provenance,
    }
    if isinstance(existing_gap, Mapping):
        normalized_existing_gap = {
            **existing_gap,
            "gaps": _normalize_gap_entries(existing_gaps),
        }
        gap_remove = _normalize_gap_remove_override(normalized_existing_gap, gap_remove, output)
        gap_remove["provenance"] = provenance
        gap_remove["manual_corrections"] = bool(provenance["manual_overrides"])
        gap_remove["gaps"] = _decorate_gap_ranges(
            _gap_ranges_from_provenance(provenance),
            provenance,
        )
    if gap_remove_override is not None:
        gap_remove = _normalize_gap_remove_override(
            gap_remove_override,
            gap_remove,
            output,
        )
        if isinstance(gap_remove_override.get("provenance"), Mapping):
            override_provenance = _replace_provenance_source(
                gap_remove.get("provenance"),
                "script_alignment",
                script_alignment_ranges,
            )
            gap_remove["provenance"] = override_provenance
            gap_remove["gaps"] = _decorate_gap_ranges(
                _gap_ranges_from_provenance(override_provenance),
                override_provenance,
            )
    output["gap_remove"] = gap_remove
    removed_gap_count = sum(
        1
        for item in gap_remove["gaps"]
        if isinstance(item, Mapping) and item.get("removed") is not False
    )
    output["script_alignment"] = {
        "schema": "moy.asr.script_alignment.v1",
        "selected": copy.deepcopy(selection.get("selected", [])),
        "missingLineIds": copy.deepcopy(selection.get("missingLineIds", [])),
        "incompleteLineIds": copy.deepcopy(selection.get("incompleteLineIds", [])),
        "blockedIncompleteLineIds": copy.deepcopy(selection.get("blockedIncompleteLineIds", [])),
        "manuallyEnabledCandidateIds": copy.deepcopy(selection.get("manuallyEnabledCandidateIds", [])),
        "manuallyEnabledLineIds": copy.deepcopy(selection.get("manuallyEnabledLineIds", [])),
        "manuallyDisabledCandidateIds": copy.deepcopy(selection.get("manuallyDisabledCandidateIds", [])),
        "manuallyDisabledLineIds": copy.deepcopy(selection.get("manuallyDisabledLineIds", [])),
        "candidateActions": copy.deepcopy(selection.get("candidateActions", {})),
        "extraRanges": copy.deepcopy(selection.get("extraRanges", [])),
        "extraActions": copy.deepcopy(selection.get("extraActions", {})),
        "removedGapCount": removed_gap_count,
        "audioGapCount": len(audio_gap_ranges),
        "readyForMediaTrim": selection.get("readyForMediaTrim") is True,
    }
    return output


def _normalize_gap_remove_override(
    override: Mapping[str, object],
    fallback: Mapping[str, object],
    project: Mapping[str, object],
) -> dict[str, object]:
    """Validate the editable gap state sent by the standalone Align UI."""

    result = dict(fallback)
    result["schema"] = "moy.asr.gap_remove.v1"
    result["detector"] = "audio_gate"

    def bounded_int(name: str, default: int, lower: int, upper: int) -> int:
        value = override.get(name, default)
        if isinstance(value, bool):
            return default
        try:
            numeric = float(value)
        except (TypeError, ValueError):
            return default
        if not math.isfinite(numeric):
            return default
        return max(lower, min(upper, int(round(numeric))))

    def bounded_float(name: str, default: float, lower: float, upper: float) -> float:
        value = override.get(name, default)
        if isinstance(value, bool):
            return default
        try:
            numeric = float(value)
        except (TypeError, ValueError):
            return default
        if not math.isfinite(numeric):
            return default
        return max(lower, min(upper, numeric))

    result["minimum_ms"] = bounded_int(
        "minimum_ms", int(fallback.get("minimum_ms", 500)), 100, 60000,
    )
    result["threshold_db"] = bounded_float(
        "threshold_db", float(fallback.get("threshold_db", -24)), -96, 0,
    )
    result["hysteresis_db"] = bounded_float(
        "hysteresis_db", float(fallback.get("hysteresis_db", 2)), 0, 30,
    )
    result["lead_in_ms"] = bounded_int(
        "lead_in_ms", int(fallback.get("lead_in_ms", 40)), 0, 2000,
    )
    result["lead_out_ms"] = bounded_int(
        "lead_out_ms", int(fallback.get("lead_out_ms", 80)), 0, 2000,
    )
    result["disable_coverage_percent"] = bounded_float(
        "disable_coverage_percent",
        float(fallback.get("disable_coverage_percent", 80)),
        0,
        100,
    )
    result["disable_remaining_ms"] = bounded_int(
        "disable_remaining_ms", int(fallback.get("disable_remaining_ms", 300)), 0, 60000,
    )
    result["skip_playback"] = override.get(
        "skip_playback", fallback.get("skip_playback", True),
    ) is not False
    result["manual_corrections"] = override.get(
        "manual_corrections", fallback.get("manual_corrections", False),
    ) is True
    operation_mode = override.get(
        "operation_mode", fallback.get("operation_mode", DEFAULT_GAP_REMOVE_OPERATION_MODE),
    )
    result["operation_mode"] = (
        operation_mode
        if isinstance(operation_mode, str) and operation_mode in GAP_REMOVE_OPERATION_MODES
        else DEFAULT_GAP_REMOVE_OPERATION_MODE
    )

    waveform = project.get("waveform")
    duration_value = waveform.get("duration_ms") if isinstance(waveform, Mapping) else None
    duration_ms: int | None = None
    if not isinstance(duration_value, bool):
        try:
            numeric_duration = float(duration_value)
        except (TypeError, ValueError):
            numeric_duration = 0
        if math.isfinite(numeric_duration) and numeric_duration > 0:
            duration_ms = int(round(numeric_duration))

    raw_gaps = override.get("gaps", fallback.get("gaps", []))
    if not isinstance(raw_gaps, list):
        raise ValueError("gapRemove.gaps 必须是数组")
    gaps: list[dict[str, object]] = []
    for item in raw_gaps:
        if not isinstance(item, Mapping):
            raise ValueError("gapRemove.gaps 中的项目必须是对象")
        if isinstance(item.get("start"), bool) or isinstance(item.get("end"), bool):
            raise ValueError("gapRemove.gaps 的时间必须是数字")
        try:
            start = int(round(float(item.get("start"))))
            end = int(round(float(item.get("end"))))
        except (TypeError, ValueError, OverflowError):
            raise ValueError("gapRemove.gaps 的时间必须是有限数字") from None
        if not math.isfinite(float(start)) or not math.isfinite(float(end)):
            raise ValueError("gapRemove.gaps 的时间必须是有限数字")
        start = max(0, start)
        end = max(0, end)
        if duration_ms is not None:
            start = min(duration_ms, start)
            end = min(duration_ms, end)
        if end > start:
            gaps.append({"start": start, "end": end, "removed": item.get("removed") is not False})
    gaps.sort(key=lambda item: (int(item["start"]), int(item["end"])))
    coalesced: list[dict[str, object]] = []
    for gap in gaps:
        if not coalesced:
            coalesced.append(gap)
            continue
        previous = coalesced[-1]
        if gap["start"] <= previous["end"] and gap["removed"] == previous["removed"]:
            previous["end"] = max(int(previous["end"]), int(gap["end"]))
            continue
        start = max(int(gap["start"]), int(previous["end"]))
        if int(gap["end"]) > start:
            coalesced.append({**gap, "start": start})
    has_provenance = isinstance(override.get("provenance"), Mapping)
    provenance = _normalize_gap_provenance(
        override.get("provenance") if has_provenance else None,
        coalesced,
    )
    result["provenance"] = provenance
    result["manual_corrections"] = result["manual_corrections"] or bool(provenance["manual_overrides"])
    result["gaps"] = _decorate_gap_ranges(
        _gap_ranges_from_provenance(provenance),
        provenance,
    )
    return result


def detect_waveform_gaps(
    waveform: Mapping[str, object],
    *,
    minimum_ms: int = 500,
    threshold_db: float = -24,
    hysteresis_db: float = 2,
    lead_in_ms: int = 40,
    lead_out_ms: int = 80,
) -> list[dict[str, int]]:
    """Mirror MAWE's audio-gate detector for an embedded waveform payload."""

    if waveform.get("schema") != "moy.asr.waveform.v1" or waveform.get("encoding") != "i8-minmax-base64":
        return []
    peaks_per_second = waveform.get("peaks_per_second")
    duration_ms = waveform.get("duration_ms")
    data = waveform.get("data")
    if type(peaks_per_second) is not int or peaks_per_second <= 0 or type(duration_ms) is not int or duration_ms <= 0:
        return []
    if not isinstance(data, str):
        return []
    try:
        encoded = base64.b64decode(data, validate=True)
    except (ValueError, binascii.Error):
        return []
    sample_count = min(len(encoded) // 2, max(0, (duration_ms * peaks_per_second + 999) // 1000))
    open_threshold = max(-96.0, min(0.0, float(threshold_db)))
    close_threshold = open_threshold - max(0.0, min(30.0, float(hysteresis_db)))
    minimum = max(0, int(minimum_ms))
    lead_in = max(0, int(lead_in_ms))
    lead_out = max(0, int(lead_out_ms))

    def time_at(index: int) -> int:
        return min(duration_ms, round(index * 1000 / peaks_per_second))

    def level_db(index: int) -> float:
        low = encoded[index * 2]
        high = encoded[index * 2 + 1]
        low = low - 256 if low >= 128 else low
        high = high - 256 if high >= 128 else high
        magnitude = min(127, max(abs(low), abs(high)))
        if magnitude <= 0:
            return float("-inf")
        import math
        return 20 * math.log10(magnitude / 127)

    gate_open = False
    found_audio = False
    silence_start: int | None = None
    gaps: list[dict[str, int]] = []
    for index in range(sample_count):
        level = level_db(index)
        if gate_open:
            if level < close_threshold:
                gate_open = False
                silence_start = time_at(index)
            continue
        if level < open_threshold:
            continue
        if found_audio and silence_start is not None:
            gap_start = min(duration_ms, silence_start + lead_in)
            gap_end = time_at(index) - lead_out
            if gap_end - gap_start >= minimum:
                gaps.append({"start": gap_start, "end": gap_end})
        found_audio = True
        gate_open = True
        silence_start = None
    return gaps


def _script_lines(script_text: str) -> list[str]:
    return [line.strip() for line in script_text.replace("\r\n", "\n").replace("\r", "\n").split("\n") if line.strip()]


def _source_cues(project: Mapping[str, object]) -> list[_SourceCue]:
    raw_segments = project.get("segments")
    if not isinstance(raw_segments, list):
        raise ValueError("project segments must be an array")
    cues: list[_SourceCue] = []
    for ordinal, raw_segment in enumerate(raw_segments):
        if not isinstance(raw_segment, dict) or raw_segment.get("disabled") is True:
            continue
        text = raw_segment.get("text")
        start = _int_value(raw_segment.get("start"))
        end = _int_value(raw_segment.get("end"))
        if not isinstance(text, str) or not text.strip() or start is None or end is None or end <= start:
            continue
        segment_id = str(raw_segment.get("id") or f"main-{ordinal + 1:03d}")
        cues.append(_SourceCue(
            ordinal,
            segment_id,
            start,
            end,
            text,
            normalize_alignment_text(text),
            _parse_source_items(raw_segment.get("items"), start, end),
        ))
    return cues


def _candidate_windows(
    script_line: str,
    line_index: int,
    source_cues: Sequence[_SourceCue],
    *,
    min_score: float,
    complete_score: float,
    max_cues_per_candidate: int,
    max_candidates: int,
) -> list[dict[str, object]]:
    script_normalized = normalize_alignment_text(script_line)
    if not script_normalized:
        return []

    # A source cue sequence is a possible recording attempt, not a Take by
    # itself.  Keep at most the best attempt for each start cue.  The old
    # implementation retained several neighbouring end points for every
    # start, which turned common words such as "Linux" and "客户端" into a
    # large number of false candidates.
    by_start: dict[int, list[dict[str, object]]] = {}
    for start in range(len(source_cues)):
        combined: list[str] = []
        for end in range(start, min(len(source_cues), start + max_cues_per_candidate)):
            combined.append(source_cues[end].normalized)
            source_normalized = "".join(combined)
            if not source_normalized:
                continue
            variants = [(source_normalized, _full_source_slices(source_cues, start, end))]
            variants.extend(
                (variant_normalized, variant_slices)
                for variant_normalized, variant_slices in _anchored_item_variants(
                    script_normalized,
                    source_cues,
                    start,
                    end,
                )
            )
            seen_variants: set[tuple[object, ...]] = set()
            for variant_normalized, source_slices in variants:
                variant_key = (
                    variant_normalized,
                    tuple(
                        (
                            int(item.get("sourceCueIndex") or 0),
                            int(item.get("itemStart") or 0),
                            int(item.get("itemEnd") or 0),
                        )
                        for item in source_slices
                    ),
                )
                if variant_key in seen_variants:
                    continue
                seen_variants.add(variant_key)
                metrics = _alignment_metrics(script_normalized, variant_normalized)
                status = _candidate_status(
                    metrics,
                    target_length=len(script_normalized),
                    min_score=min_score,
                    complete_score=complete_score,
                )
                if status is None or not source_slices:
                    continue
                slice_start = min(int(item["sourceCueIndex"]) for item in source_slices)
                slice_end = max(int(item["sourceCueIndex"]) for item in source_slices) + 1
                candidate = {
                    "id": "",
                    "lineId": f"line-{line_index + 1:03d}",
                    "sourceStartOrdinal": slice_start,
                    "sourceEndOrdinal": slice_end,
                    "start": source_slices[0]["start"],
                    "end": source_slices[-1]["end"],
                    "sourceCueIds": [
                        source_cues[index].id
                        for index in range(slice_start, slice_end)
                    ],
                    "sourceSlices": copy.deepcopy(source_slices),
                    "sourceText": " / ".join(
                        str(item.get("sourceText") or "")
                        for item in source_slices
                    ),
                    "score": round(metrics["score"], 4),
                    # A complete take may contain small ASR substitutions or
                    # insertions, but it must cover the whole line and must not be
                    # a suffix of a neighbouring line.  Partial candidates are
                    # retained only when their text starts at the script prefix;
                    # a shared keyword in the middle is not an incomplete take.
                    "status": status,
                    "spanCues": slice_end - slice_start,
                    "targetCoverage": round(metrics["target_coverage"], 4),
                    "sourceCoverage": round(metrics["source_coverage"], 4),
                    "leadingExtra": metrics["leading_extra"],
                    "trailingExtra": metrics["trailing_extra"],
                    "prefixMatch": metrics["prefix_match"],
                    "suffixMatch": metrics["suffix_match"],
                }
                candidate["internalSkips"] = _detect_internal_repetitions(
                    script_normalized,
                    candidate,
                    source_cues,
                )
                by_start.setdefault(slice_start, []).append(candidate)

    candidates: list[dict[str, object]] = []
    for start, group in by_start.items():
        group.sort(key=_candidate_rank, reverse=True)
        candidates.append(group[0])

    # Two windows that overlap are normally the same attempted utterance with
    # a different guessed boundary.  Keep the stronger one.  Independent
    # retries such as #1 and #5 do not overlap and therefore remain as
    # alternatives.
    ranked = sorted(candidates, key=_candidate_rank, reverse=True)
    non_overlapping: list[dict[str, object]] = []
    for candidate in ranked:
        start = int(candidate["sourceStartOrdinal"])
        end = int(candidate["sourceEndOrdinal"])
        if any(
            start < int(other["sourceEndOrdinal"])
            and end > int(other["sourceStartOrdinal"])
            for other in non_overlapping
        ):
            continue
        non_overlapping.append(candidate)
    candidates = sorted(
        non_overlapping[:max_candidates],
        key=lambda candidate: (
            int(candidate["sourceStartOrdinal"]),
            int(candidate["sourceEndOrdinal"]),
        ),
    )
    candidates.sort(key=lambda candidate: (
        int(candidate["sourceStartOrdinal"]),
        int(candidate["sourceEndOrdinal"]),
        -float(candidate["score"]),
    ))
    for rank, candidate in enumerate(candidates, 1):
        candidate["id"] = f"candidate-{line_index + 1:03d}-{rank:02d}"
    return candidates


def _assign_alternative_groups(
    candidates: Sequence[dict[str, object]],
    *,
    line_index: int,
    max_gap_ms: int,
    max_cues: int,
) -> None:
    """Mark candidates that belong to the same local recording attempt.

    A text match can occur much later in the recording, or inside another
    script line's take.  It remains useful as a candidate, but it must not be
    treated as an Alternative for every other match of the same text.  The
    group is broken when either the time gap or the number of intervening
    source cues exceeds the configured locality limit.
    """

    ordered = sorted(
        candidates,
        key=lambda candidate: (
            _required_int(candidate.get("sourceStartOrdinal"), "candidate source start"),
            _required_int(candidate.get("sourceEndOrdinal"), "candidate source end"),
        ),
    )
    groups: dict[str, list[dict[str, object]]] = {}
    previous: Mapping[str, object] | None = None
    group_index = 0
    for candidate in ordered:
        if previous is None:
            group_index = 1
        else:
            previous_end_ordinal = _required_int(
                previous.get("sourceEndOrdinal"),
                "candidate source end",
            )
            candidate_start_ordinal = _required_int(
                candidate.get("sourceStartOrdinal"),
                "candidate source start",
            )
            previous_end = _required_int(previous.get("end"), "candidate end")
            candidate_start = _required_int(candidate.get("start"), "candidate start")
            skipped_cues = max(0, candidate_start_ordinal - previous_end_ordinal)
            gap_ms = max(0, candidate_start - previous_end)
            if gap_ms > max_gap_ms or skipped_cues > max_cues:
                group_index += 1
        group_id = f"line-{line_index + 1:03d}-group-{group_index:02d}"
        candidate["alternativeGroupId"] = group_id
        groups.setdefault(group_id, []).append(candidate)
        previous = candidate

    for group_id, members in groups.items():
        for candidate in members:
            candidate["alternativeGroupSize"] = len(members)


def _detect_internal_repetitions(
    script_normalized: str,
    candidate: Mapping[str, object],
    source_cues: Sequence[_SourceCue],
) -> list[dict[str, object]]:
    """Find an obvious repeated or restarted source cue inside one take.

    A repeated cue is different from an Alternative: it is part of the same
    source window, but the script contains that phrase only once.  Keep the
    detector deliberately conservative for the MVP: it only removes adjacent
    full cues with either identical normalized text or a long shared prefix,
    and requires a visible pause before the later restart.  The later
    occurrence is kept because that is normally the completed continuation.
    """

    if candidate.get("status") not in {"match", "incomplete", "complete"}:
        return []
    source_slices = _source_slices_for_record(candidate, source_cues)
    cue_indices: list[int] = []
    for source_range in source_slices:
        cue_index = _int_value(source_range.get("sourceCueIndex"))
        if cue_index is None or cue_index < 0 or cue_index >= len(source_cues):
            continue
        cue = source_cues[cue_index]
        if cue.items:
            item_start = _int_value(source_range.get("itemStart"))
            item_end = _int_value(source_range.get("itemEnd"))
            if item_start != 0 or item_end != len(cue.items):
                continue
        if (
            _int_value(source_range.get("start")) != cue.start
            or _int_value(source_range.get("end")) != cue.end
        ):
            continue
        if not cue_indices or cue_indices[-1] != cue_index:
            cue_indices.append(cue_index)
    if len(cue_indices) < 2:
        return []

    result: list[dict[str, object]] = []
    for left_index in _repetition_left_indices(cue_indices, source_cues):
        right_index = left_index + 1
        left = source_cues[left_index]
        if (
            left.normalized == source_cues[right_index].normalized
            and script_normalized.count(left.normalized) >= 2
        ):
            continue
        source_range = _source_slice(source_cues[left_index], left_index)
        if source_range is None:
            continue
        result.append({
            "kind": "skip-source",
            "reasonCode": "repetition",
            "sourceSlices": [source_range],
            "sourceText": left.text,
        })
    return result


def _common_prefix_length(left: str, right: str) -> int:
    length = 0
    for left_char, right_char in zip(left, right):
        if left_char != right_char:
            break
        length += 1
    return length


def _is_repetition_pair(left: _SourceCue, right: _SourceCue) -> bool:
    """Return whether the later cue looks like a restarted version of the first."""

    if not left.normalized or not right.normalized:
        return False
    gap_ms = right.start - left.end
    if left.normalized == right.normalized:
        return (
            len(left.normalized) >= MIN_INTERNAL_REPEAT_TEXT_LENGTH
            and gap_ms >= MIN_SAFE_ITEM_GAP_MS
        )
    if gap_ms < MIN_NEAR_REPETITION_GAP_MS:
        return False
    shortest = min(len(left.normalized), len(right.normalized))
    if shortest < MIN_NEAR_REPETITION_TEXT_LENGTH:
        return False
    prefix_length = _common_prefix_length(left.normalized, right.normalized)
    minimum_prefix = max(
        MIN_NEAR_REPETITION_PREFIX_LENGTH,
        int(shortest * MIN_NEAR_REPETITION_PREFIX_RATIO + 0.999999),
    )
    return (
        prefix_length >= minimum_prefix
        and len(left.normalized) - prefix_length >= 2
        and len(right.normalized) - prefix_length >= 2
    )


def _repetition_left_indices(
    cue_indices: Sequence[int],
    source_cues: Sequence[_SourceCue],
) -> list[int]:
    return [
        left_index
        for left_index, right_index in zip(cue_indices, cue_indices[1:])
        if right_index == left_index + 1
        and _is_repetition_pair(source_cues[left_index], source_cues[right_index])
    ]


def _parse_source_items(
    raw_items: object,
    segment_start: int,
    segment_end: int,
) -> tuple[_SourceItem, ...]:
    if not isinstance(raw_items, list) or not raw_items:
        return ()
    items: list[_SourceItem] = []
    previous_end = segment_start
    for index, raw_item in enumerate(raw_items):
        if not isinstance(raw_item, Mapping):
            return ()
        text = raw_item.get("text")
        start = _int_value(raw_item.get("start"))
        end = _int_value(raw_item.get("end"))
        if (
            not isinstance(text, str)
            or start is None
            or end is None
            or end <= start
            or start < segment_start
            or end > segment_end
            or start < previous_end
        ):
            return ()
        items.append(_SourceItem(index, start, end, text, normalize_alignment_text(text)))
        previous_end = end
    return tuple(items)


def _source_slice(
    cue: _SourceCue,
    cue_index: int,
    item_start: int = 0,
    item_end: int | None = None,
) -> dict[str, object] | None:
    if cue.items:
        last_item = len(cue.items) if item_end is None else item_end
        if item_start < 0 or last_item > len(cue.items) or last_item <= item_start:
            return None
        items = cue.items[item_start:last_item]
        is_full = item_start == 0 and last_item == len(cue.items)
        return {
            "sourceCueIndex": cue_index,
            "sourceCueId": cue.id,
            "start": cue.start if is_full else items[0].start,
            "end": cue.end if is_full else items[-1].end,
            "itemStart": item_start,
            "itemEnd": last_item,
            "sourceText": "".join(item.text for item in items),
        }
    if item_start != 0 or item_end not in (None, 0):
        return None
    return {
        "sourceCueIndex": cue_index,
        "sourceCueId": cue.id,
        "start": cue.start,
        "end": cue.end,
        "sourceText": cue.text,
    }


def _full_source_slices(
    source_cues: Sequence[_SourceCue],
    start: int,
    end: int,
) -> list[dict[str, object]]:
    slices: list[dict[str, object]] = []
    for cue_index in range(start, end + 1):
        source_range = _source_slice(source_cues[cue_index], cue_index)
        if source_range is not None:
            slices.append(source_range)
    return slices


def _anchored_item_variants(
    script_normalized: str,
    source_cues: Sequence[_SourceCue],
    start: int,
    end: int,
) -> list[tuple[str, list[dict[str, object]]]]:
    """Return exact item-boundary prefix/suffix trims for one cue window.

    A target that is an exact prefix or suffix of a larger ASR segment is safe
    to trim only when the match ends at an item boundary with a clear pause.
    We intentionally do not accept arbitrary middle substrings here: that
    would turn shared words into false takes again.
    """

    if any(not source_cues[index].items for index in range(start, end + 1)):
        return []
    refs = [
        (cue_index, item.index, item)
        for cue_index in range(start, end + 1)
        for item in source_cues[cue_index].items
    ]
    source_normalized = "".join(item.normalized for _cue_index, _item_index, item in refs)
    if not source_normalized or not script_normalized:
        return []
    variants: list[tuple[str, list[dict[str, object]]]] = []
    if source_normalized.startswith(script_normalized):
        item_end = _prefix_item_boundary(refs, len(script_normalized))
        if item_end is not None and _has_item_split_gap(refs, item_end):
            slices = _slices_from_item_refs(source_cues, refs, 0, item_end)
            if slices:
                variants.append((script_normalized, slices))
    if source_normalized.endswith(script_normalized):
        item_start = _suffix_item_boundary(refs, len(script_normalized))
        if item_start is not None and _has_item_split_gap(refs, item_start):
            slices = _slices_from_item_refs(source_cues, refs, item_start, len(refs))
            if slices:
                variants.append((script_normalized, slices))
    return variants


def _has_item_split_gap(
    refs: Sequence[tuple[int, int, _SourceItem]],
    boundary: int,
) -> bool:
    if boundary <= 0 or boundary >= len(refs):
        return False
    previous = refs[boundary - 1][2]
    following = refs[boundary][2]
    return following.start - previous.end >= MIN_SAFE_ITEM_GAP_MS


def _prefix_item_boundary(
    refs: Sequence[tuple[int, int, _SourceItem]],
    target_length: int,
) -> int | None:
    matched = 0
    for index, (_cue_index, _item_index, item) in enumerate(refs):
        matched += len(item.normalized)
        if matched == target_length:
            end = index + 1
            while end < len(refs) and not refs[end][2].normalized:
                end += 1
            return end
        if matched > target_length:
            return None
    return None


def _suffix_item_boundary(
    refs: Sequence[tuple[int, int, _SourceItem]],
    target_length: int,
) -> int | None:
    matched = 0
    for index in range(len(refs) - 1, -1, -1):
        matched += len(refs[index][2].normalized)
        if matched == target_length:
            start = index
            while start > 0 and not refs[start - 1][2].normalized:
                start -= 1
            return start
        if matched > target_length:
            return None
    return None


def _slices_from_item_refs(
    source_cues: Sequence[_SourceCue],
    refs: Sequence[tuple[int, int, _SourceItem]],
    start: int,
    end: int,
) -> list[dict[str, object]]:
    if start < 0 or end > len(refs) or end <= start:
        return []
    slices: list[dict[str, object]] = []
    current_cue_index = refs[start][0]
    first_item_index = refs[start][1]
    previous_item_index = first_item_index
    for index in range(start + 1, end):
        cue_index, item_index, _item = refs[index]
        if cue_index != current_cue_index or item_index != previous_item_index + 1:
            source_range = _source_slice(
                source_cues[current_cue_index],
                current_cue_index,
                first_item_index,
                previous_item_index + 1,
            )
            if source_range is not None:
                slices.append(source_range)
            current_cue_index = cue_index
            first_item_index = item_index
        previous_item_index = item_index
    source_range = _source_slice(
        source_cues[current_cue_index],
        current_cue_index,
        first_item_index,
        previous_item_index + 1,
    )
    if source_range is not None:
        slices.append(source_range)
    return slices


def _alignment_metrics(target: str, source: str) -> dict[str, float | int]:
    """Return structural text-match metrics for one contiguous source window.

    ``SequenceMatcher.ratio`` alone is deliberately insufficient here: a
    window containing a neighbouring line can score well when it shares a
    product name or a repeated noun.  Coverage and boundary metrics make the
    candidate represent the whole utterance instead of an arbitrary keyword
    overlap.
    """

    matcher = difflib.SequenceMatcher(None, target, source, autojunk=False)
    blocks = [block for block in matcher.get_matching_blocks() if block.size]
    matched_target = sum(block.size for block in blocks)
    matched_source = sum(block.size for block in blocks)
    first = blocks[0] if blocks else None
    last = blocks[-1] if blocks else None
    leading_extra = int(first.b) if first is not None else len(source)
    trailing_extra = (
        len(source) - int(last.b + last.size)
        if last is not None else len(source)
    )
    prefix_match = max(
        (int(block.size) for block in blocks if block.a == 0),
        default=0,
    )
    suffix_match = max(
        (
            int(block.size)
            for block in blocks
            if block.a + block.size == len(target)
        ),
        default=0,
    )
    return {
        "score": matcher.ratio(),
        "target_coverage": matched_target / max(1, len(target)),
        "source_coverage": matched_source / max(1, len(source)),
        "leading_extra": leading_extra,
        "trailing_extra": trailing_extra,
        "prefix_match": prefix_match,
        "suffix_match": suffix_match,
    }


def _boundary_extra_limit(target_length: int) -> int:
    # A single filler word may be harmless, but a whole neighbouring cue is
    # not.  Keep this tight because the source is already segmented by ASR.
    return max(1, min(3, (max(1, target_length) + 12) // 13))


def _candidate_status(
    metrics: Mapping[str, float | int],
    *,
    target_length: int,
    min_score: float,
    complete_score: float,
) -> str | None:
    score = float(metrics["score"])
    target_coverage = float(metrics["target_coverage"])
    source_coverage = float(metrics["source_coverage"])
    leading_extra = int(metrics["leading_extra"])
    trailing_extra = int(metrics["trailing_extra"])
    prefix_match = int(metrics["prefix_match"])
    suffix_match = int(metrics["suffix_match"])

    if score < min_score:
        return None
    boundary_limit = _boundary_extra_limit(target_length)
    complete_boundary = leading_extra <= boundary_limit and trailing_extra <= boundary_limit
    if (
        score >= complete_score
        and target_coverage >= MIN_COMPLETE_TARGET_COVERAGE
        and source_coverage >= MIN_COMPLETE_SOURCE_COVERAGE
        and complete_boundary
    ):
        return "match"

    # Incomplete is anchored to either edge of the target, not an arbitrary
    # fuzzy hit in the middle.  A failed take may stop early (prefix) or start
    # late (suffix), so accept either edge while still bounding source text on
    # both sides to avoid absorbing a neighbouring sentence.
    prefix_anchored = prefix_match >= 3 and leading_extra <= boundary_limit
    suffix_anchored = suffix_match >= 3 and trailing_extra <= boundary_limit
    if (
        target_coverage >= MIN_INCOMPLETE_TARGET_COVERAGE
        and source_coverage >= MIN_INCOMPLETE_SOURCE_COVERAGE
        and (prefix_anchored or suffix_anchored)
        and leading_extra <= boundary_limit
        and trailing_extra <= boundary_limit
    ):
        return "incomplete"
    return None


def _candidate_rank(candidate: Mapping[str, object]) -> tuple[float | int, ...]:
    return (
        1 if candidate.get("status") == "match" else 0,
        float(candidate.get("score") or 0),
        float(candidate.get("targetCoverage") or 0),
        float(candidate.get("sourceCoverage") or 0),
        -int(candidate.get("leadingExtra") or 0),
        -int(candidate.get("trailingExtra") or 0),
        -int(candidate.get("spanCues") or 0),
    )


def _build_paths(candidates_by_line: Sequence[Sequence[dict[str, object]]], *, top_paths: int) -> list[dict[str, object]]:
    states: list[dict[str, object]] = [{"score": 0.0, "lastEnd": 0, "choices": []}]
    for line_candidates in candidates_by_line:
        expanded: list[dict[str, object]] = []
        for state in states:
            choices = list(state["choices"])
            for candidate in line_candidates:
                start = int(candidate["sourceStartOrdinal"])
                if start < int(state["lastEnd"]):
                    continue
                skipped = start - int(state["lastEnd"])
                expanded.append({
                    "score": float(state["score"]) + float(candidate["score"]) - skipped * 0.08,
                    "lastEnd": int(candidate["sourceEndOrdinal"]),
                    "choices": [*choices, candidate["id"]],
                })
            expanded.append({
                "score": float(state["score"]) - 0.8,
                "lastEnd": int(state["lastEnd"]),
                "choices": [*choices, None],
            })
        states = _prune_states(expanded, max(top_paths * 8, top_paths))

    candidates_by_id = {
        str(candidate["id"]): candidate
        for line_candidates in candidates_by_line
        for candidate in line_candidates
    }
    paths: list[dict[str, object]] = []
    for index, state in enumerate(sorted(states, key=lambda item: float(item["score"]), reverse=True)[:top_paths], 1):
        choices = [
            candidates_by_id[str(candidate_id)] if candidate_id else None
            for candidate_id in state["choices"]
        ]
        complete = bool(choices) and all(
            isinstance(candidate, dict) and _candidate_is_complete(candidate)
            for candidate in choices
        )
        path_id = f"path-{index:02d}"
        paths.append({
            "id": path_id,
            "score": round(float(state["score"]), 4),
            "complete": complete,
            "endSourceOrdinal": int(state["lastEnd"]),
            "startSourceOrdinals": [
                int(candidate["sourceStartOrdinal"]) if candidate else -1
                for candidate in choices
            ],
            "choices": [
                {"lineId": f"line-{line_index + 1:03d}", "candidateId": candidate["id"] if candidate else None}
                for line_index, candidate in enumerate(choices)
            ],
            "candidateIds": [candidate["id"] for candidate in choices if candidate],
        })
    if not paths:
        raise ValueError("unable to build an alignment path")
    return paths


def _prune_states(states: Sequence[dict[str, object]], limit: int) -> list[dict[str, object]]:
    unique: dict[tuple[object, ...], dict[str, object]] = {}
    for state in states:
        key = (int(state["lastEnd"]), *state["choices"])
        previous = unique.get(key)
        if previous is None or float(state["score"]) > float(previous["score"]):
            unique[key] = state
    ordered = sorted(unique.values(), key=lambda item: float(item["score"]), reverse=True)
    return ordered[:limit]


def _default_path_id(
    paths: Sequence[Mapping[str, object]],
    candidates_by_line: Sequence[Sequence[Mapping[str, object]]] = (),
) -> str:
    complete = [path for path in paths if path.get("complete") is True]
    pool = complete or list(paths)
    candidates_by_id = {
        str(candidate.get("id") or ""): candidate
        for line_candidates in candidates_by_line
        for candidate in line_candidates
    }

    def group_support(path: Mapping[str, object]) -> int:
        raw_ids = path.get("candidateIds")
        if not isinstance(raw_ids, list):
            return 0
        return sum(
            min(
                3,
                max(
                    1,
                    _int_value(
                        candidates_by_id.get(str(candidate_id), {}).get(
                            "alternativeGroupSize"
                        )
                    ) or 1,
                ),
            )
            for candidate_id in raw_ids
        )

    selected = max(
        pool,
        key=lambda path: (
            group_support(path),
            # Compare later script lines first. This keeps a later take for a
            # given line from being overridden by an earlier-line tie-break.
            tuple(
                int(value)
                for value in reversed(path.get("startSourceOrdinals", []))
                if type(value) is int
            ),
            int(path.get("endSourceOrdinal") or 0),
            float(path.get("score") or 0),
        ),
    )
    return str(selected["id"])


def _selection_from_path(path: Mapping[str, object]) -> dict[str, str]:
    choices = path.get("choices")
    if not isinstance(choices, list):
        return {}
    return {
        str(choice["lineId"]): str(choice["candidateId"])
        for choice in choices
        if isinstance(choice, dict) and choice.get("candidateId")
    }


def _extras_for_path(
    path: Mapping[str, object],
    source_cues: Sequence[_SourceCue],
    candidates_by_line: Sequence[Sequence[Mapping[str, object]]],
) -> list[dict[str, object]]:
    choices = path.get("choices")
    if not isinstance(choices, list):
        return []
    all_candidates = [candidate for line in candidates_by_line for candidate in line]
    candidates_by_id = {str(candidate.get("id") or ""): candidate for candidate in all_candidates}
    selected = [
        candidates_by_id[str(choice.get("candidateId"))]
        for choice in choices
        if isinstance(choice, Mapping)
        and choice.get("candidateId")
        and str(choice.get("candidateId")) in candidates_by_id
    ]
    return _extras_for_selection(selected, source_cues, all_candidates)


def _selected_alternative_groups(
    selected: Sequence[Mapping[str, object]],
) -> dict[str, str]:
    groups: dict[str, str] = {}
    for candidate in selected:
        line_id = str(candidate.get("lineId") or "")
        group_id = str(candidate.get("alternativeGroupId") or "")
        if line_id and group_id:
            groups[line_id] = group_id
    return groups


def _selection_candidate_id(record: Mapping[str, object]) -> str:
    """Return a candidate id from either a raw candidate or a selection row."""

    return str(record.get("candidateId") or record.get("id") or "").strip()


def _candidate_gap_classification(
    candidate: Mapping[str, object],
    selected_groups: Mapping[str, str],
) -> tuple[str, str]:
    if not _candidate_is_complete(candidate):
        return "skip-source", "incomplete"
    candidate_group = str(candidate.get("alternativeGroupId") or "")
    if not candidate_group:
        # Alignments generated before locality groups existed retain the old
        # complete-candidate behavior.
        return "skip-source", "alternative"
    line_id = str(candidate.get("lineId") or "")
    if selected_groups.get(line_id) == candidate_group:
        return "skip-source", "alternative"
    return "extra", "distant-match"


def _extras_for_selection(
    selected: Sequence[Mapping[str, object]],
    source_cues: Sequence[_SourceCue],
    all_candidates: Sequence[Mapping[str, object]],
) -> list[dict[str, object]]:
    if any(
        _record_has_partial_source_slice(candidate, source_cues)
        or _record_has_internal_skips(candidate)
        for candidate in selected
    ):
        return _extras_for_selection_with_slices(selected, source_cues, all_candidates)

    selected_ids = {
        candidate_id
        for candidate in selected
        if (candidate_id := _selection_candidate_id(candidate))
    }
    selected_groups = _selected_alternative_groups(selected)
    selected_candidates = [
        candidate for candidate in all_candidates
        if str(candidate.get("id") or "") in selected_ids
    ]
    selected_ranges = sorted(
        (
            _required_int(candidate.get("sourceStartOrdinal"), "candidate source start"),
            _required_int(candidate.get("sourceEndOrdinal"), "candidate source end"),
        )
        for candidate in selected
    )
    extras: list[dict[str, object]] = []
    cursor = 0
    extra_index = 1
    for start, end in selected_ranges:
        if start > cursor:
            gap_kind = "leading" if cursor == 0 else "interstitial"
            gap_ranges = _classify_gap(
                cursor,
                start,
                source_cues,
                all_candidates,
                selected_ids,
                selected_groups,
            )
            for gap_range in gap_ranges:
                for review_range in _promote_incomplete_retry_ranges(
                    gap_range,
                    source_cues,
                    selected_candidates,
                ):
                    payloads = _range_payloads(extra_index, review_range, source_cues, gap_kind)
                    extras.extend(payloads)
                    extra_index += len(payloads)
        cursor = max(cursor, end)
    if cursor < len(source_cues):
        gap_ranges = _classify_gap(
            cursor,
            len(source_cues),
            source_cues,
            all_candidates,
            selected_ids,
            selected_groups,
        )
        for gap_range in gap_ranges:
            for review_range in _promote_incomplete_retry_ranges(
                gap_range,
                source_cues,
                selected_candidates,
            ):
                payloads = _range_payloads(extra_index, review_range, source_cues, "trailing")
                extras.extend(payloads)
                extra_index += len(payloads)
    return extras


def _source_slices_for_record(
    record: Mapping[str, object],
    source_cues: Sequence[_SourceCue],
) -> list[dict[str, object]]:
    raw_slices = record.get("sourceSlices")
    slices: list[dict[str, object]] = []
    if isinstance(raw_slices, list) and raw_slices:
        cue_indices_by_id = {cue.id: index for index, cue in enumerate(source_cues)}
        for raw_slice in raw_slices:
            if not isinstance(raw_slice, Mapping):
                continue
            cue_index = _int_value(raw_slice.get("sourceCueIndex"))
            if cue_index is None:
                cue_index = cue_indices_by_id.get(str(raw_slice.get("sourceCueId") or ""))
            if cue_index is None or cue_index < 0 or cue_index >= len(source_cues):
                continue
            cue = source_cues[cue_index]
            item_start = _int_value(raw_slice.get("itemStart"))
            item_end = _int_value(raw_slice.get("itemEnd"))
            if cue.items:
                source_range = _source_slice(
                    cue,
                    cue_index,
                    0 if item_start is None else item_start,
                    len(cue.items) if item_end is None else item_end,
                )
            else:
                source_range = _source_slice(cue, cue_index)
            if source_range is not None:
                slices.append(source_range)
        if slices:
            return slices

    start = _int_value(record.get("sourceStartOrdinal"))
    end = _int_value(record.get("sourceEndOrdinal"))
    if start is None or end is None or start < 0 or end > len(source_cues) or end <= start:
        return []
    return _full_source_slices(source_cues, start, end - 1)


def _record_has_partial_source_slice(
    record: Mapping[str, object],
    source_cues: Sequence[_SourceCue],
) -> bool:
    for source_range in _source_slices_for_record(record, source_cues):
        cue_index = _int_value(source_range.get("sourceCueIndex"))
        if cue_index is None or cue_index < 0 or cue_index >= len(source_cues):
            continue
        cue = source_cues[cue_index]
        if cue.items:
            item_start = _int_value(source_range.get("itemStart"))
            item_end = _int_value(source_range.get("itemEnd"))
            if item_start != 0 or item_end != len(cue.items):
                return True
        if (
            _int_value(source_range.get("start")) != cue.start
            or _int_value(source_range.get("end")) != cue.end
        ):
            return True
    return False


def _record_has_internal_skips(record: Mapping[str, object]) -> bool:
    raw_skips = record.get("internalSkips")
    return isinstance(raw_skips, list) and any(
        isinstance(item, Mapping) for item in raw_skips
    )


def _source_slices_without_internal_skips(
    record: Mapping[str, object],
    source_cues: Sequence[_SourceCue],
) -> list[dict[str, object]]:
    source_slices = _source_slices_for_record(record, source_cues)
    if not _record_has_internal_skips(record):
        return source_slices
    atoms, atom_positions = _source_atoms(source_cues)
    kept_positions = _atom_positions_for_record(record, source_cues, atom_positions)
    raw_skips = record.get("internalSkips")
    if isinstance(raw_skips, list):
        for raw_skip in raw_skips:
            if isinstance(raw_skip, Mapping):
                kept_positions.difference_update(
                    _atom_positions_for_record(raw_skip, source_cues, atom_positions)
                )
    return _slices_from_atom_positions(sorted(kept_positions), atoms, source_cues)


def _source_atoms(
    source_cues: Sequence[_SourceCue],
) -> tuple[list[_SourceAtom], dict[tuple[int, int], int]]:
    atoms: list[_SourceAtom] = []
    positions: dict[tuple[int, int], int] = {}
    for cue_index, cue in enumerate(source_cues):
        if cue.items:
            for item in cue.items:
                positions[(cue_index, item.index)] = len(atoms)
                atoms.append(_SourceAtom(
                    cue_index,
                    item.index,
                    item.index + 1,
                    item.start,
                    item.end,
                    item.text,
                ))
        else:
            positions[(cue_index, 0)] = len(atoms)
            atoms.append(_SourceAtom(cue_index, 0, 0, cue.start, cue.end, cue.text))
    return atoms, positions


def _atom_positions_for_record(
    record: Mapping[str, object],
    source_cues: Sequence[_SourceCue],
    atom_positions: Mapping[tuple[int, int], int],
) -> set[int]:
    result: set[int] = set()
    for source_range in _source_slices_for_record(record, source_cues):
        cue_index = _int_value(source_range.get("sourceCueIndex"))
        if cue_index is None or cue_index < 0 or cue_index >= len(source_cues):
            continue
        cue = source_cues[cue_index]
        if cue.items:
            item_start = _int_value(source_range.get("itemStart"))
            item_end = _int_value(source_range.get("itemEnd"))
            if item_start is None or item_end is None:
                continue
            for item_index in range(item_start, item_end):
                position = atom_positions.get((cue_index, item_index))
                if position is not None:
                    result.add(position)
        else:
            position = atom_positions.get((cue_index, 0))
            if position is not None:
                result.add(position)
    return result


def _slices_from_atom_positions(
    positions: Sequence[int],
    atoms: Sequence[_SourceAtom],
    source_cues: Sequence[_SourceCue],
) -> list[dict[str, object]]:
    ordered = sorted(set(positions))
    if not ordered:
        return []
    slices: list[dict[str, object]] = []
    group_start = 0
    for index in range(1, len(ordered) + 1):
        if index < len(ordered) and ordered[index] == ordered[index - 1] + 1:
            continue
        group = [atoms[position] for position in ordered[group_start:index]]
        sub_start = 0
        for sub_index in range(1, len(group) + 1):
            same_cue = (
                sub_index < len(group)
                and group[sub_index].cue_index == group[sub_index - 1].cue_index
                and group[sub_index].item_start == group[sub_index - 1].item_end
            )
            if same_cue:
                continue
            first = group[sub_start]
            last = group[sub_index - 1]
            source_range = _source_slice(
                source_cues[first.cue_index],
                first.cue_index,
                first.item_start,
                last.item_end if source_cues[first.cue_index].items else None,
            )
            if source_range is not None:
                slices.append(source_range)
            sub_start = sub_index
        group_start = index
    return slices


def _extras_for_selection_with_slices(
    selected: Sequence[Mapping[str, object]],
    source_cues: Sequence[_SourceCue],
    all_candidates: Sequence[Mapping[str, object]],
) -> list[dict[str, object]]:
    """Classify unselected item ranges when a selected take trims a cue.

    The older ordinal-only classifier cannot see the tail of a selected source
    cue.  Treating item timestamps as the atomic source units lets us keep the
    existing failed-take evidence while exposing the remaining text as an
    ordinary Extra.
    """

    atoms, atom_positions = _source_atoms(source_cues)
    selected_ids = {
        candidate_id
        for candidate in selected
        if (candidate_id := _selection_candidate_id(candidate))
    }
    selected_groups = _selected_alternative_groups(selected)
    selected_candidates = [
        candidate for candidate in all_candidates
        if str(candidate.get("id") or "") in selected_ids
    ]
    selected_positions: set[int] = set()
    for candidate in selected:
        selected_positions.update(
            _atom_positions_for_record(candidate, source_cues, atom_positions)
        )
    selected_all_positions = set(selected_positions)
    internal_skip_ranges: list[tuple[Mapping[str, object], Mapping[str, object], set[int]]] = []
    internal_skip_positions: set[int] = set()
    for candidate in selected:
        raw_skips = candidate.get("internalSkips")
        if not isinstance(raw_skips, list):
            continue
        for raw_skip in raw_skips:
            if not isinstance(raw_skip, Mapping):
                continue
            positions = _atom_positions_for_record(raw_skip, source_cues, atom_positions)
            positions &= selected_all_positions
            positions -= internal_skip_positions
            if not positions:
                continue
            internal_skip_ranges.append((candidate, raw_skip, positions))
            internal_skip_positions.update(positions)
            selected_positions.difference_update(positions)

    candidate_positions: list[tuple[Mapping[str, object], set[int]]] = []
    for candidate in all_candidates:
        if str(candidate.get("id") or "") in selected_ids:
            continue
        positions = _atom_positions_for_record(candidate, source_cues, atom_positions)
        if not positions or positions & selected_all_positions:
            continue
        candidate_positions.append((candidate, positions))

    # As with the ordinal classifier, a broad candidate is only evidence when
    # it is not enclosing a narrower complete take for the same script line.
    candidate_positions = [
        (candidate, positions)
        for candidate, positions in candidate_positions
        if not any(
            other is not candidate
            and str(other.get("lineId") or "") == str(candidate.get("lineId") or "")
            and _candidate_is_complete(other)
            and other_positions <= positions
            for other, other_positions in candidate_positions
        )
    ]
    candidate_positions.sort(
        key=lambda item: (
            min(item[1]),
            0 if _candidate_is_complete(item[0]) else 1,
            -float(item[0].get("score") or 0),
            -len(item[1]),
        )
    )
    skip_ranges: list[tuple[Mapping[str, object], set[int]]] = []
    occupied = set(selected_all_positions)
    for candidate, positions in candidate_positions:
        if positions & occupied:
            continue
        skip_ranges.append((candidate, positions))
        occupied.update(positions)

    category_positions = selected_positions or selected_all_positions
    selected_min = min(category_positions) if category_positions else None
    selected_max = max(category_positions) if category_positions else None

    def position_category(position: int) -> str:
        if selected_min is None or position < selected_min:
            return "leading"
        if position > selected_max:
            return "trailing"
        return "interstitial"

    result: list[tuple[int, dict[str, object]]] = []
    for skip_index, (owner, raw_skip, positions) in enumerate(internal_skip_ranges, 1):
        result.append((
            min(positions),
            {
                "id": f"{owner.get('id') or 'selected'}--internal-{skip_index:03d}",
                "kind": "skip-source",
                "sourceSlices": _source_slices_for_record(raw_skip, source_cues),
                "candidate": owner,
                "reasonCode": str(raw_skip.get("reasonCode") or "repetition"),
                "category": position_category(min(positions)),
            },
        ))
    for candidate, positions in skip_ranges:
        start_position = min(positions)
        kind, reason_code = _candidate_gap_classification(candidate, selected_groups)
        result.append((
            start_position,
            {
                "kind": kind,
                "sourceSlices": _source_slices_for_record(candidate, source_cues),
                "candidate": candidate,
                "reasonCode": reason_code,
                "category": position_category(start_position),
            },
        ))

    extra_positions = [
        position
        for position in range(len(atoms))
        if position not in occupied
    ]
    group_start = 0
    for index in range(1, len(extra_positions) + 1):
        if index < len(extra_positions) and extra_positions[index] == extra_positions[index - 1] + 1:
            continue
        group = extra_positions[group_start:index]
        start_position = group[0]
        result.append((
            start_position,
            {
                "kind": "extra",
                "sourceSlices": _slices_from_atom_positions(group, atoms, source_cues),
                "category": position_category(start_position),
            },
        ))
        group_start = index

    extras: list[dict[str, object]] = []
    extra_index = 1
    for _position, gap_range in sorted(result, key=lambda item: item[0]):
        for repetition_range in _split_near_repetition_extra_range(
            gap_range,
            source_cues,
        ):
            for review_range in _promote_incomplete_retry_ranges(
                repetition_range,
                source_cues,
                selected_candidates,
            ):
                payloads = _range_payloads(
                    extra_index,
                    review_range,
                    source_cues,
                    str(gap_range["category"]),
                )
                extras.extend(payloads)
                extra_index += len(payloads)
    return extras


def _classify_gap(
    start: int,
    end: int,
    source_cues: Sequence[_SourceCue],
    all_candidates: Sequence[Mapping[str, object]],
    selected_ids: set[str],
    selected_groups: Mapping[str, str],
) -> list[dict[str, object]]:
    """Split one unselected source gap into failed takes and true extras.

    Candidate windows are deliberately used only as evidence for
    ``skip-source``.  Any source cue not covered by a plausible candidate is
    an ``extra`` and therefore requires an explicit user decision.
    """

    candidates = [
        candidate for candidate in all_candidates
        if str(candidate.get("id") or "") not in selected_ids
        and _int_value(candidate.get("sourceStartOrdinal")) is not None
        and _int_value(candidate.get("sourceEndOrdinal")) is not None
        and int(candidate["sourceStartOrdinal"]) >= start
        and int(candidate["sourceEndOrdinal"]) <= end
    ]
    # A broad, low-quality window such as ``嗯 + 完整句子`` often contains a
    # narrower complete candidate.  Treat the narrower complete take as the
    # source block and leave the prefix available for ``extra`` instead of
    # misclassifying the whole window as one failed take.
    candidates = [
        candidate for candidate in candidates
        if not any(
            other is not candidate
            and str(other.get("lineId") or "") == str(candidate.get("lineId") or "")
            and _candidate_is_complete(other)
            and int(other["sourceStartOrdinal"]) >= int(candidate["sourceStartOrdinal"])
            and int(other["sourceEndOrdinal"]) <= int(candidate["sourceEndOrdinal"])
            for other in candidates
        )
    ]
    ranked = sorted(
        candidates,
        key=lambda candidate: (
            _int_value(candidate.get("sourceStartOrdinal")) or 0,
            0 if _candidate_is_complete(candidate) else 1,
            -float(candidate.get("score") or 0),
            -int(candidate.get("spanCues") or 0),
        ),
    )
    selected_gap_candidates: list[Mapping[str, object]] = []
    for candidate in ranked:
        candidate_start = int(candidate["sourceStartOrdinal"])
        candidate_end = int(candidate["sourceEndOrdinal"])
        if any(
            candidate_start < int(other["sourceEndOrdinal"])
            and candidate_end > int(other["sourceStartOrdinal"])
            for other in selected_gap_candidates
        ):
            continue
        selected_gap_candidates.append(candidate)
    selected_gap_candidates.sort(key=lambda candidate: int(candidate["sourceStartOrdinal"]))

    result: list[dict[str, object]] = []
    cursor = start
    for candidate in selected_gap_candidates:
        candidate_start = int(candidate["sourceStartOrdinal"])
        candidate_end = int(candidate["sourceEndOrdinal"])
        if candidate_start > cursor:
            result.extend(_split_near_repetition_extra_range(
                {"kind": "extra", "start": cursor, "end": candidate_start},
                source_cues,
            ))
        kind, reason_code = _candidate_gap_classification(candidate, selected_groups)
        result.append({
            "kind": kind,
            "start": candidate_start,
            "end": candidate_end,
            "sourceSlices": _source_slices_for_record(candidate, source_cues),
            "candidate": candidate,
            "reasonCode": reason_code,
        })
        cursor = candidate_end
    if cursor < end:
        result.extend(_split_near_repetition_extra_range(
            {"kind": "extra", "start": cursor, "end": end},
            source_cues,
        ))
    if not result and end > start:
        result.extend(_split_near_repetition_extra_range(
            {"kind": "extra", "start": start, "end": end},
            source_cues,
        ))
    return result


def _source_slices_for_range(
    gap_range: Mapping[str, object],
    source_cues: Sequence[_SourceCue],
) -> list[dict[str, object]]:
    raw_slices = gap_range.get("sourceSlices")
    if isinstance(raw_slices, list) and raw_slices:
        return _source_slices_for_record({"sourceSlices": raw_slices}, source_cues)
    start = _required_int(gap_range.get("start"), "gap start")
    end = _required_int(gap_range.get("end"), "gap end")
    return _source_slices_for_record({
        "sourceStartOrdinal": start,
        "sourceEndOrdinal": end,
    }, source_cues)


def _split_near_repetition_extra_range(
    gap_range: Mapping[str, object],
    source_cues: Sequence[_SourceCue],
) -> list[dict[str, object]]:
    """Split an unclaimed source range at obvious near-repetition restarts."""

    if (
        str(gap_range.get("kind") or "extra") != "extra"
        or str(gap_range.get("reasonCode") or "extra") != "extra"
    ):
        return [dict(gap_range)]
    slices = _source_slices_for_range(gap_range, source_cues)
    if len(slices) < 2:
        return [dict(gap_range)]

    cue_indices: list[int] = []
    for source_range in slices:
        cue_index = _int_value(source_range.get("sourceCueIndex"))
        if cue_index is None or cue_index < 0 or cue_index >= len(source_cues):
            return [dict(gap_range)]
        cue = source_cues[cue_index]
        if cue.items:
            if (
                _int_value(source_range.get("itemStart")) != 0
                or _int_value(source_range.get("itemEnd")) != len(cue.items)
            ):
                return [dict(gap_range)]
        elif (
            _int_value(source_range.get("start")) != cue.start
            or _int_value(source_range.get("end")) != cue.end
        ):
            return [dict(gap_range)]
        cue_indices.append(cue_index)

    repeated_left_indices = set(_repetition_left_indices(cue_indices, source_cues))
    if not repeated_left_indices:
        return [dict(gap_range)]

    def base_piece() -> dict[str, object]:
        piece = dict(gap_range)
        for key in ("id", "start", "end", "sourceSlices", "candidate"):
            piece.pop(key, None)
        return piece

    pieces: list[dict[str, object]] = []
    extra_slices: list[dict[str, object]] = []

    def flush_extra() -> None:
        if not extra_slices:
            return
        piece = base_piece()
        piece["kind"] = "extra"
        piece["sourceSlices"] = list(extra_slices)
        pieces.append(piece)
        extra_slices.clear()

    for cue_index, source_range in zip(cue_indices, slices):
        if cue_index in repeated_left_indices:
            flush_extra()
            piece = base_piece()
            piece["kind"] = "skip-source"
            piece["reasonCode"] = "repetition"
            piece["sourceSlices"] = [source_range]
            pieces.append(piece)
        else:
            extra_slices.append(source_range)
    flush_extra()
    return pieces


def _looks_like_incomplete_retry(
    source_slice: Mapping[str, object],
    selected_candidates: Sequence[Mapping[str, object]],
) -> bool:
    """Detect a short failed attempt immediately before a complete re-take.

    This is intentionally narrower than normal fuzzy matching.  It only
    promotes an otherwise-true Extra when a complete selected candidate starts
    within the next few source cues, the source text begins like that candidate,
    and the range is not a much longer independent sentence.
    """
    cue_index = _int_value(source_slice.get("sourceCueIndex"))
    source_end = _int_value(source_slice.get("end"))
    source_text = normalize_alignment_text(str(source_slice.get("sourceText") or ""))
    if cue_index is None or not source_text or len(source_text) < 3:
        return False
    for candidate in selected_candidates:
        if not _candidate_is_complete(candidate):
            continue
        candidate_start_ordinal = _int_value(candidate.get("sourceStartOrdinal"))
        candidate_start = _int_value(candidate.get("start"))
        target_text = normalize_alignment_text(str(candidate.get("sourceText") or ""))
        if (
            candidate_start_ordinal is None
            or candidate_start_ordinal <= cue_index
            or candidate_start_ordinal - cue_index > 3
            or not target_text
            or len(source_text) > len(target_text) + 8
        ):
            continue
        if (
            source_end is not None
            and candidate_start is not None
            and candidate_start - source_end > DEFAULT_ALTERNATIVE_MAX_GAP_MS
        ):
            continue
        metrics = _alignment_metrics(target_text, source_text)
        if (
            float(metrics["score"]) >= 0.40
            and float(metrics["source_coverage"]) >= 0.55
            and int(metrics["prefix_match"]) >= 3
        ):
            return True
    return False


def _promote_incomplete_retry_ranges(
    gap_range: Mapping[str, object],
    source_cues: Sequence[_SourceCue],
    selected_candidates: Sequence[Mapping[str, object]],
) -> list[dict[str, object]]:
    """Turn obvious pre-retake Extras into default-discard skip-source ranges."""
    if str(gap_range.get("kind") or "extra") != "extra":
        return [dict(gap_range)]
    slices = _source_slices_for_range(gap_range, source_cues)
    if len(slices) <= 1:
        if slices and _looks_like_incomplete_retry(slices[0], selected_candidates):
            return [{
                **gap_range,
                "kind": "skip-source",
                "reasonCode": "incomplete",
                "sourceSlices": [slices[0]],
            }]
        return [dict(gap_range)]
    promoted: list[dict[str, object]] = []
    for source_slice in slices:
        promoted.append({
            **gap_range,
            "kind": "skip-source" if _looks_like_incomplete_retry(source_slice, selected_candidates) else "extra",
            "reasonCode": "incomplete" if _looks_like_incomplete_retry(source_slice, selected_candidates) else gap_range.get("reasonCode", "extra"),
            "sourceSlices": [source_slice],
        })
    return promoted


def _range_payloads(
    index: int,
    gap_range: Mapping[str, object],
    source_cues: Sequence[_SourceCue],
    position: str,
) -> list[dict[str, object]]:
    """Build review ranges, keeping each true Extra at source-slice granularity."""
    if str(gap_range.get("kind") or "extra") != "extra":
        return [_range_payload(index, gap_range, source_cues, position)]
    slices = _source_slices_for_range(gap_range, source_cues)
    if len(slices) <= 1:
        return [_range_payload(index, gap_range, source_cues, position)]
    return [
        _range_payload(
            index + slice_index,
            {**gap_range, "sourceSlices": [source_slice]},
            source_cues,
            position,
        )
        for slice_index, source_slice in enumerate(slices)
    ]


def _range_payload(
    index: int,
    gap_range: Mapping[str, object],
    source_cues: Sequence[_SourceCue],
    position: str,
) -> dict[str, object]:
    slices = _source_slices_for_range(gap_range, source_cues)
    if not slices:
        raise ValueError("alignment range cannot be empty")
    kind = str(gap_range.get("kind") or "extra")
    candidate = gap_range.get("candidate")
    candidate_id = str(candidate.get("id") or "") if isinstance(candidate, Mapping) else ""
    if kind == "skip-source":
        explicit_id = str(gap_range.get("id") or "")
        range_id = explicit_id or (
            f"skip-source-{candidate_id}" if candidate_id else f"skip-source-{index:03d}"
        )
        default_action = "discard"
        reason_code = str(gap_range.get("reasonCode") or "failed-take")
    else:
        range_start = _required_int(slices[0].get("start"), "gap start")
        range_end = _required_int(slices[-1].get("end"), "gap end")
        range_id = f"extra-{range_start:010d}-{range_end:010d}"
        default_action = "keep"
        reason_code = str(gap_range.get("reasonCode") or "extra")
    source_cue_ids: list[str] = []
    for source_range in slices:
        source_cue_id = str(source_range.get("sourceCueId") or "")
        if source_cue_id and source_cue_id not in source_cue_ids:
            source_cue_ids.append(source_cue_id)
    source_start_ordinal = min(
        _required_int(source_range.get("sourceCueIndex"), "gap source cue index")
        for source_range in slices
    )
    source_end_ordinal = max(
        _required_int(source_range.get("sourceCueIndex"), "gap source cue index")
        for source_range in slices
    ) + 1
    return {
        "id": range_id,
        "kind": kind,
        "category": position,
        "reasonCode": reason_code,
        "relatedCandidateId": candidate_id,
        "relatedLineId": candidate.get("lineId", "") if isinstance(candidate, Mapping) else "",
        "start": slices[0]["start"],
        "end": slices[-1]["end"],
        "sourceCueIds": source_cue_ids,
        "sourceSlices": copy.deepcopy(slices),
        "sourceText": " / ".join(str(source_range.get("sourceText") or "") for source_range in slices),
        "sourceStartOrdinal": source_start_ordinal,
        "sourceEndOrdinal": source_end_ordinal,
        "defaultAction": default_action,
        "requiresDecision": False,
    }


def _alignment_source_cues(alignment: Mapping[str, object]) -> list[_SourceCue]:
    raw_cues = alignment.get("sourceCues")
    if not isinstance(raw_cues, list):
        raise ValueError("alignment is missing source cues")
    cues: list[_SourceCue] = []
    for index, raw_cue in enumerate(raw_cues):
        if not isinstance(raw_cue, Mapping):
            raise ValueError("alignment source cue must be an object")
        start = _required_int(raw_cue.get("start"), "source cue start")
        end = _required_int(raw_cue.get("end"), "source cue end")
        if end <= start:
            raise ValueError("alignment source cue has invalid range")
        text = str(raw_cue.get("text") or "")
        cues.append(_SourceCue(
            index,
            str(raw_cue.get("id") or f"cue-{index + 1:03d}"),
            start,
            end,
            text,
            normalize_alignment_text(text),
            _parse_source_items(raw_cue.get("items"), start, end),
        ))
    return cues


def _kept_intervals_by_cue(
    selection: Mapping[str, object],
    source_cues: Sequence[_SourceCue],
) -> dict[int, list[tuple[int, int]]]:
    intervals_by_cue: dict[int, list[tuple[int, int]]] = {}

    def add_record(record: Mapping[str, object]) -> None:
        for source_range in _source_slices_without_internal_skips(record, source_cues):
            cue_index = _int_value(source_range.get("sourceCueIndex"))
            start = _int_value(source_range.get("start"))
            end = _int_value(source_range.get("end"))
            if (
                cue_index is None
                or cue_index < 0
                or cue_index >= len(source_cues)
                or start is None
                or end is None
                or end <= start
            ):
                continue
            cue = source_cues[cue_index]
            intervals_by_cue.setdefault(cue_index, []).append((
                max(cue.start, start),
                min(cue.end, end),
            ))

    selected = selection.get("selected")
    if isinstance(selected, list):
        for item in selected:
            if (
                isinstance(item, Mapping)
                and (
                    (
                        item.get("status") == "match"
                        and item.get("manualDisabled") is not True
                    )
                    or item.get("manualEnabled") is True
                )
            ):
                add_record(item)
    kept_extras = selection.get("keptExtras")
    if isinstance(kept_extras, list):
        for extra in kept_extras:
            if isinstance(extra, Mapping):
                add_record(extra)
    return {
        cue_index: _merge_ranges(intervals)
        for cue_index, intervals in intervals_by_cue.items()
        if any(end > start for start, end in intervals)
    }


def _intervals_cover_range(
    intervals: Sequence[tuple[int, int]],
    start: int,
    end: int,
) -> bool:
    return any(
        interval_start <= start and end <= interval_end
        for interval_start, interval_end in _merge_ranges(intervals)
    )


def _apply_kept_intervals_to_segments(
    raw_segments: Sequence[object],
    source_cues: Sequence[_SourceCue],
    kept_intervals_by_cue: Mapping[int, Sequence[tuple[int, int]]],
    removed_ranges: Sequence[tuple[int, int]],
) -> list[object]:
    source_index_by_id = {cue.id: index for index, cue in enumerate(source_cues)}
    used_ids = {
        str(segment.get("id"))
        for segment in raw_segments
        if isinstance(segment, Mapping) and isinstance(segment.get("id"), str)
    }
    output: list[object] = []
    output_source_ordinals: list[int] = []
    for ordinal, raw_segment in enumerate(raw_segments):
        if not isinstance(raw_segment, dict):
            output.append(raw_segment)
            output_source_ordinals.append(ordinal)
            continue
        segment_id = str(raw_segment.get("id") or f"main-{ordinal + 1:03d}")
        source_index = source_index_by_id.get(segment_id)
        if source_index is None:
            start = _int_value(raw_segment.get("start"))
            end = _int_value(raw_segment.get("end"))
            if start is not None and end is not None and _contains_range(removed_ranges, start, end):
                raw_segment["disabled"] = True
            output.append(raw_segment)
            output_source_ordinals.append(ordinal)
            continue

        cue = source_cues[source_index]
        kept_intervals = list(kept_intervals_by_cue.get(source_index, ()))
        if not kept_intervals:
            raw_segment["disabled"] = True
            output.append(raw_segment)
            output_source_ordinals.append(ordinal)
            continue
        if _intervals_cover_range(kept_intervals, cue.start, cue.end):
            output.append(raw_segment)
            output_source_ordinals.append(ordinal)
            continue

        pieces = _split_segment_by_item_intervals(
            raw_segment,
            cue,
            kept_intervals,
            used_ids,
        )
        if pieces:
            output.extend(pieces)
            output_source_ordinals.extend([ordinal] * len(pieces))
        else:
            # A partial range should only be produced from valid items.  Keep
            # the cue visible rather than silently throwing away audio if a
            # legacy project does not provide enough item information.
            output.append(raw_segment)
            output_source_ordinals.append(ordinal)
    _remap_split_visual_references(output, output_source_ordinals)
    return output


def _remap_split_visual_references(
    segments: Sequence[object],
    source_ordinals: Sequence[int],
) -> None:
    first_output_by_source: dict[int, int] = {}
    for output_index, source_ordinal in enumerate(source_ordinals):
        first_output_by_source.setdefault(source_ordinal, output_index)

    for output_index, (segment, source_ordinal) in enumerate(zip(segments, source_ordinals, strict=True)):
        if not isinstance(segment, dict):
            continue
        first_output = first_output_by_source[source_ordinal]
        for head_field, ref_field in (("sticker", "sticker_ref"), ("color", "color_ref")):
            head = segment.get(head_field)
            if output_index != first_output and isinstance(head, Mapping):
                segment.pop(head_field, None)
                segment[ref_field] = {
                    "name": str(head.get("name") or ""),
                    "headIdx": first_output,
                }
                continue
            reference = segment.get(ref_field)
            if not isinstance(reference, dict):
                continue
            old_head_index = _int_value(reference.get("headIdx"))
            if old_head_index in first_output_by_source:
                reference["headIdx"] = first_output_by_source[old_head_index]


def _refresh_main_binding_offsets(project: Mapping[str, object]) -> None:
    raw_segments = project.get("segments")
    raw_multi = project.get("multi_subtitle")
    if not isinstance(raw_segments, list) or not isinstance(raw_multi, Mapping):
        return
    main_by_id = {
        str(segment.get("id")): segment
        for segment in raw_segments
        if isinstance(segment, Mapping) and isinstance(segment.get("id"), str)
    }
    raw_tracks = raw_multi.get("tracks")
    raw_bindings = raw_multi.get("bindings")
    if not isinstance(raw_tracks, list) or not isinstance(raw_bindings, list):
        return
    tracks_by_id = {
        str(track.get("id")): track
        for track in raw_tracks
        if isinstance(track, Mapping) and isinstance(track.get("id"), str)
    }
    for binding in raw_bindings:
        if not isinstance(binding, dict):
            continue
        main_ids = binding.get("main_segment_ids")
        extension_ids = binding.get("extension_segment_ids")
        track = tracks_by_id.get(str(binding.get("track_id") or ""))
        if (
            not isinstance(main_ids, list)
            or len(main_ids) != 1
            or not isinstance(extension_ids, list)
            or len(extension_ids) != 1
            or not isinstance(track, Mapping)
        ):
            continue
        main = main_by_id.get(str(main_ids[0]))
        extension_segments = track.get("segments")
        if not isinstance(main, Mapping) or not isinstance(extension_segments, list):
            continue
        extension = next((
            item for item in extension_segments
            if isinstance(item, Mapping) and item.get("id") == extension_ids[0]
        ), None)
        if not isinstance(extension, Mapping):
            continue
        main_start = _int_value(main.get("start"))
        main_end = _int_value(main.get("end"))
        extension_start = _int_value(extension.get("start"))
        extension_end = _int_value(extension.get("end"))
        if None not in {main_start, main_end, extension_start, extension_end}:
            binding["start_offset_ms"] = int(extension_start) - int(main_start)
            binding["end_offset_ms"] = int(extension_end) - int(main_end)


def _split_segment_by_item_intervals(
    raw_segment: Mapping[str, object],
    cue: _SourceCue,
    kept_intervals: Sequence[tuple[int, int]],
    used_ids: set[str],
) -> list[dict[str, object]]:
    raw_items = raw_segment.get("items")
    if not isinstance(raw_items, list) or len(raw_items) != len(cue.items) or not cue.items:
        return []
    runs: list[tuple[bool, int, int]] = []
    run_start = 0
    current_keep: bool | None = None
    for item_index, item in enumerate(cue.items):
        keep = any(
            start <= item.start and item.end <= end
            for start, end in kept_intervals
        )
        if current_keep is None:
            current_keep = keep
        else:
            previous_item = cue.items[item_index - 1]
            uncovered_boundary = (
                item.start > previous_item.end
                and not any(
                    start <= previous_item.end and item.start <= end
                    for start, end in kept_intervals
                )
            )
            if keep != current_keep or uncovered_boundary:
                runs.append((current_keep, run_start, item_index))
                run_start = item_index
                current_keep = keep
    if current_keep is None:
        return []
    runs.append((current_keep, run_start, len(cue.items)))

    base_id = str(raw_segment.get("id") or "")
    if not base_id:
        base_id = f"main-{cue.ordinal + 1:03d}"
    pieces: list[dict[str, object]] = []
    for run_index, (keep, start, end) in enumerate(runs):
        piece = copy.deepcopy(dict(raw_segment))
        item_values = [dict(item) for item in raw_items[start:end] if isinstance(item, Mapping)]
        if len(item_values) != end - start:
            return []
        piece["start"] = cue.items[start].start
        piece["end"] = cue.items[end - 1].end
        piece["text"] = "".join(str(item.get("text") or "") for item in item_values)
        piece["items"] = item_values
        if keep:
            piece.pop("disabled", None)
        else:
            piece["disabled"] = True
        if run_index == 0:
            piece["id"] = str(raw_segment.get("id") or base_id)
        else:
            suffix = run_index + 1
            candidate_id = f"{base_id}--align-{suffix:03d}"
            while candidate_id in used_ids:
                suffix += 1
                candidate_id = f"{base_id}--align-{suffix:03d}"
            piece["id"] = candidate_id
            used_ids.add(candidate_id)
        pieces.append(piece)
    return pieces


def _candidate_is_complete(candidate: Mapping[str, object]) -> bool:
    return candidate.get("status") in {"match", "complete"} or candidate.get("complete") is True


def _complement_ranges(
    start: int,
    end: int,
    kept_intervals: Sequence[tuple[int, int]],
) -> list[tuple[int, int]]:
    if end <= start:
        return []
    cursor = start
    result: list[tuple[int, int]] = []
    for kept_start, kept_end in _merge_ranges(kept_intervals):
        if kept_end <= start or kept_start >= end:
            continue
        kept_start = max(start, kept_start)
        kept_end = min(end, kept_end)
        if kept_start > cursor:
            result.append((cursor, kept_start))
        cursor = max(cursor, kept_end)
    if cursor < end:
        result.append((cursor, end))
    return result


def _merge_ranges(ranges: Sequence[tuple[int, int]]) -> list[tuple[int, int]]:
    ordered = sorted(
        (int(start), int(end)) for start, end in ranges if int(end) > int(start)
    )
    merged: list[tuple[int, int]] = []
    for start, end in ordered:
        if not merged or start > merged[-1][1]:
            merged.append((start, end))
        else:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
    return merged


def _contains_range(ranges: Sequence[tuple[int, int]], start: int, end: int) -> bool:
    return any(range_start <= start and end <= range_end for range_start, range_end in ranges)


def _project_has_items(project: Mapping[str, object]) -> bool:
    raw_segments = project.get("segments")
    if not isinstance(raw_segments, list):
        return False
    return any(
        isinstance(segment, dict)
        and isinstance(segment.get("items"), list)
        and bool(segment.get("items"))
        for segment in raw_segments
    )


def _int_value(value: object) -> int | None:
    return value if type(value) is int else None


def _required_int(value: object, label: str) -> int:
    parsed = _int_value(value)
    if parsed is None:
        raise ValueError(f"{label} must be an integer")
    return parsed


__all__ = [
    "apply_alignment_to_project",
    "align_project_to_script",
    "detect_waveform_gaps",
    "make_selection_manifest",
    "normalize_alignment_text",
]
