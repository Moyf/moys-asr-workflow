"""Native, local review of two immutable script-match snapshots."""

from __future__ import annotations

import copy
import json
import os
import tempfile
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path

from maw.postprocess import _reconcile_items
from maw.postprocess_match import ScriptMatchTrace, _cue_range, preserve_match_cleanup_scopes
from maw.project import normalize_project
from maw.project_io import rebase_project_media, strip_inline_caches
from maw.project_mutations import fresh_segment_id, replace_main_segments
from maw.project_preview import JsonDict
from maw.project_tracks import get_main_track, get_tracks_by_role, iter_segments


@dataclass(frozen=True, slots=True)
class ReviewGroup:
    start: int
    end: int
    before: tuple[int, ...]
    after: tuple[int, ...]


def group_cues(before: list[JsonDict], after: list[JsonDict]) -> list[ReviewGroup]:
    """Group connected, overlapping ranges; touching boundaries stay separate.

    A reference keeps its head and followers in the same selectable group.
    This also covers any intervening cues, so all groups remain disjoint.
    """
    intervals: list[tuple[int, int, int, int]] = []
    for side, cues in enumerate((before, after)):
        group_ranges = {}
        for index, cue in enumerate(cues):
            start, end = _cue_range(cue)
            intervals.append((start, end, side, index))
            for field in ("color_group_id", "sticker_group_id"):
                if group_id := cue.get(field):
                    first, last = group_ranges.get((field, group_id), (start, end))
                    group_ranges[field, group_id] = (min(first, start), max(last, end))
        intervals.extend((left, right, side, -1) for left, right in group_ranges.values())
    intervals.sort()
    groups: list[ReviewGroup] = []
    start = end = -1
    sides: tuple[list[int], list[int]] = ([], [])
    for left, right, side, index in intervals:
        if left >= end:
            if end >= 0:
                groups.append(ReviewGroup(start, end, tuple(sides[0]), tuple(sides[1])))
            start, end, sides = left, right, ([], [])
        end = max(end, right)
        if index >= 0:
            sides[side].append(index)
    if end >= 0:
        groups.append(ReviewGroup(start, end, tuple(sides[0]), tuple(sides[1])))
    return groups


class ScriptMatchReview:
    def __init__(
        self, before: JsonDict, after: JsonDict, trace: ScriptMatchTrace,
        source: Path, script: Path, warnings: tuple[str, ...], mode: str,
        *, media: Path | None = None, lang: str = "zh",
    ) -> None:
        self.source = source.resolve()
        self.script = script.resolve()
        self.warnings = warnings
        self.mode = mode
        self.lang = lang
        self._source_project = before
        self._project = after
        self._media = media if not str(after.get("media") or "").strip() else None
        self._before = get_main_track(before)["segments"]
        before_ids = {cue["id"] for cue in self._before}
        self._had_overlay = bool(get_tracks_by_role(before, "overlay"))
        moved = [cue for track in get_tracks_by_role(after, "overlay") for cue in track["segments"] if cue["id"] in before_ids]
        self._moved_ids = {cue["id"] for cue in moved}
        self._after = sorted([*get_main_track(after)["segments"], *moved], key=_cue_range)
        self._trace = trace
        self._groups = group_cues(self._before, self._after)

    @staticmethod
    def _display(cues: list[JsonDict], indexes: tuple[int, ...]) -> list[JsonDict]:
        return [
            {"index": index, "start": cues[index]["start"], "end": cues[index]["end"],
             "text": cues[index]["text"], "disabled": cues[index].get("disabled") is True}
            for index in indexes
        ]

    def data(self) -> dict[str, object]:
        rows = []
        for index, group in enumerate(self._groups):
            before = self._display(self._before, group.before)
            after = self._display(self._after, group.after)
            before_ranges = [_cue_range(self._before[i]) for i in group.before]
            after_ranges = [_cue_range(self._after[i]) for i in group.after]
            issues = sorted({self._trace.issues[key] for key in before_ranges if key in self._trace.issues})
            if any(self._after[i]["id"] in self._moved_ids for i in group.after):
                issues.append("overlay")
            if any(key in self._trace.estimated for key in before_ranges):
                issues.append("estimated")
            if before_ranges != after_ranges:
                issues.append("timing")
            changed = "overlay" in issues or before_ranges != after_ranges or any(
                (left["text"], left["disabled"]) != (right["text"], right["disabled"])
                for left, right in zip(before, after)
            )
            if not changed and any(self._before[i] != self._after[j] for i, j in zip(group.before, group.after)):
                issues.append("attributes")
                changed = True
            rows.append({
                "id": index, "start": group.start, "end": group.end,
                "before": before, "after": after, "changed": changed, "issues": issues,
                "candidates": [self._trace.candidates[key] for key in
                               sorted(set(before_ranges + after_ranges)) if key in self._trace.candidates],
            })
        return {
            "source": self.source.name, "script": self.script.name, "warnings": self.warnings,
            "mode": self.mode, "lang": self.lang, "groups": rows,
            "beforeCount": len(self._before), "afterCount": len(self._after),
            "coverage": self._trace.coverage,
        }

    def adjusted(self, payload: Mapping[str, object]) -> JsonDict:
        """Accept decisions and text only; paths, times and other fields stay native."""
        raw_restore = payload.get("restore")
        raw_edits = payload.get("edits")
        if not isinstance(raw_restore, list) or not isinstance(raw_edits, list):
            raise ValueError("Invalid review decisions.")
        restore: set[int] = set()
        for index in raw_restore:
            if type(index) is not int or not 0 <= index < len(self._groups):
                raise ValueError("Invalid review group.")
            restore.add(index)
        edits: dict[tuple[int, int], str] = {}
        for edit in raw_edits:
            if not isinstance(edit, list) or len(edit) != 3:
                raise ValueError("Invalid subtitle edit.")
            side, index, text = edit
            if type(side) is not int or side not in (0, 1) or type(index) is not int or not isinstance(text, str):
                raise ValueError("Invalid subtitle edit.")
            edits[(side, index)] = text

        originals = (self._before, self._after)
        decision: list[tuple[int, int]] = []
        for index, group in enumerate(self._groups):
            if index in restore:
                decision.extend((0, i) for i in group.before)
            else:
                decision.extend((1, i) for i in group.after)
        if edits.keys() - set(decision):
            raise ValueError("An edit no longer belongs to the current result.")
        project = copy.deepcopy(self._project)
        segments = []
        moved = []
        # Prefer original identifiers when mixing snapshots. The matcher can
        # assign a generated ID that already exists on a restored source cue.
        used = {self._before[index]["id"] for side, index in decision if side == 0
                and isinstance(self._before[index].get("id"), str)}
        reserved = used | {cue["id"] for cue in iter_segments(project)}
        for side, index in decision:
            segment = copy.deepcopy(originals[side][index])
            stable_id = segment.get("id")
            if side == 1 and isinstance(stable_id, str) and stable_id in used:
                if any(binding["source"]["segment_id"] == stable_id for binding in project["bindings"]):
                    raise ValueError("恢复的字幕与保留结果使用相同的绑定身份，请重新选择分组。")
                segment["id"] = fresh_segment_id(f"review-{index + 1}", reserved)
            text = edits.get((side, index))
            if text is not None and text != segment["text"]:
                items = _reconcile_items(str(segment["text"]), segment.get("items"), text)
                segment["text"] = text
                if items is None:
                    segment.pop("items", None)
                else:
                    segment["items"] = [*items]
            if side == 1 and stable_id in self._moved_ids:
                moved.append(segment)
            else:
                segments.append(segment)
        if self._moved_ids:
            overlay, = get_tracks_by_role(project, "overlay")
            old = [cue for cue in overlay["segments"] if cue["id"] not in self._moved_ids]
            overlay["segments"] = sorted([*old, *moved], key=_cue_range)
            if not overlay["segments"] and not self._had_overlay:
                project["tracks"].remove(overlay)
        replace_main_segments(project, sorted(segments, key=_cue_range))
        project = normalize_project(project)
        preserve_match_cleanup_scopes(self._source_project, project)
        return project

    def write(self, project: JsonDict, target: Path) -> Path:
        if not target.suffix:
            target = target.with_suffix(".mosp")
        target = target.resolve()
        if target.suffix.lower() != ".mosp" or target in (self.source, self.script):
            raise ValueError("请选择一个不同于原工程的新 .mosp 文件。" if self.lang != "en" else "Choose a new .mosp file, not the source.")
        portable = rebase_project_media(strip_inline_caches(project), target, media_path=self._media, source_project_path=self.source)
        text = json.dumps(portable, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
        # Stage beside the target so no partial project is ever published. A
        # hard link fails atomically if the target already exists on POSIX;
        # Windows rename already has the no-replace semantics we need.
        with tempfile.TemporaryDirectory(prefix=".maw-review-", dir=target.parent) as folder:
            staged = Path(folder) / "project.mosp"
            staged.write_text(text, encoding="utf-8", newline="\n")
            if os.name == "nt":
                staged.rename(target)
            else:
                os.link(staged, target)
        return target


class ScriptMatchReviewApi:
    """The child window can submit review decisions, never a filesystem path."""

    def __init__(self, review: ScriptMatchReview, picker: Callable[[], Path | None]) -> None:
        self._review = review
        self._picker = picker

    def review_data(self) -> dict[str, object]:
        return self._review.data()

    def export_review(self, payload: Mapping[str, object]) -> dict[str, object]:
        try:
            if not isinstance(payload, Mapping):
                raise ValueError("Invalid review decisions.")
            project = self._review.adjusted(payload)
            target = self._picker()
            if target is None:
                return {"ok": False, "cancelled": True}
            return {"ok": True, "path": str(self._review.write(project, target))}
        except FileExistsError:
            detail = "文件已存在，请另选文件名。" if self._review.lang != "en" else "File already exists. Choose a new name."
            return {"ok": False, "error": detail}
        except (OSError, ValueError) as error:
            return {"ok": False, "error": str(error)}
