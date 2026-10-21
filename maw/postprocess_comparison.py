"""Offline HTML from validated before/after project snapshots."""

from __future__ import annotations

import json
import difflib
from collections.abc import Mapping, Sequence
from pathlib import Path

from maw.project_tracks import get_main_track, get_tracks_by_role
from maw.project import normalize_project
from maw.postprocess_ai_cleanup_items import cleaned_srt_segments, item_text_spans


def comparison_data(before: Mapping[str, object], after: Mapping[str, object], operation: str, decisions: Sequence[Mapping[str, object]] = (), *, translation: Mapping[str, object] | None = None, line_order: str = "", download_name: str = "译文.核对后.mosp") -> dict[str, object]:
    before, after = normalize_project(dict(before)), normalize_project(dict(after))
    translation = normalize_project(dict(translation)) if translation is not None else None
    source = [s for s in cleaned_srt_segments(before, get_main_track(before)["segments"]) if isinstance(s, Mapping) and not s.get("disabled")]
    display_after = translation if translation is not None else after
    output = [s for s in cleaned_srt_segments(display_after, get_main_track(display_after)["segments"]) if isinstance(s, Mapping) and not s.get("disabled")]
    annotations = {str(row["id"]): row for row in decisions}
    markers = after.get("markers", {})
    review_markers = [m for m in markers.get("items", []) if isinstance(m, Mapping) and isinstance(m.get("review"), Mapping) and m["review"].get("status") == "pending"] if isinstance(markers, Mapping) else []
    rows = []
    for index, segment in enumerate(source):
        clip_id = str(segment.get("id") or f"s{index + 1}")
        annotation = annotations.get(clip_id, {})
        matches = [s for s in output if int(s["start"]) < int(segment["end"]) and int(s["end"]) > int(segment["start"])]
        text = str(segment.get("text") or "")
        cleaned = "\n".join(str(s.get("text") or "") for s in matches)
        review = annotation.get("decision") == "review"
        reasons = [str(m["review"].get("reason") or "") for m in review_markers if int(m.get("start", 0)) < int(segment["end"]) and int(m.get("end", m.get("start", 0) + 1)) > int(segment["start"])]
        review = review or bool(reasons)
        decision = str(annotation.get("decision") or ("review" if review else "changed" if text != cleaned else "keep"))
        original = next((s for s in get_main_track(before)["segments"] if isinstance(s, Mapping) and s.get("id") == segment.get("id")), segment)
        parts = [{"text": text, "deleted": not cleaned}]
        spans = item_text_spans(text, segment.get("items", [])) if decision == "edit" and original.get("text") == text else None
        if spans:
            mask = {offset for item_index in annotation.get("deleteItems", []) for offset in range(*spans[item_index])}
            parts = []
            for offset, char in enumerate(text):
                deleted = offset in mask
                if parts and parts[-1]["deleted"] == deleted:
                    parts[-1]["text"] += char
                else:
                    parts.append({"text": char, "deleted": deleted})
        elif text != cleaned and cleaned:
            parts = [
                {"text": text[start:end], "deleted": tag in {"delete", "replace"}}
                for tag, start, end, _, _ in difflib.SequenceMatcher(None, text, cleaned, autojunk=False).get_opcodes()
                if end > start
            ]
        rows.append({"id": clip_id, "start": segment["start"], "end": segment["end"], "before": text, "after": cleaned, "parts": parts, "decision": decision, "review": review, "reason": str(annotation.get("reason") or "\n".join(reasons))})
    result = {"schema": "maw.ai-comparison.v1", "operation": operation, "before": "\n".join(str(s.get("text") or "") for s in source), "after": "\n".join(str(s.get("text") or "") for s in output), "rows": rows}

    if operation.startswith(("translate_en", "translate_zh")):
        from maw.postprocess_translation_review import translation_review
        # Two-file rendering can infer single/backfill output. Stacked output
        # requires the validated intermediate translation, never split by newline.
        # Persisted dual-track input needs the validated translation snapshot;
        # without it, keep the generic comparison rather than infer a track.
        if translation is not None or (not operation.endswith("-bilingual") and not get_tracks_by_role(after, "extension")):
            result["translationReview"] = translation_review(before, translation or after, after, operation, line_order, download_name)
    all_markers = markers.get("items", []) if isinstance(markers, Mapping) else []
    for row in rows:
        row["notes"] = [str(m.get("note") or "") for m in all_markers if isinstance(m, Mapping)
                        and isinstance(m.get("ai"), Mapping) and m["ai"].get("task") != "ai_cleanup"
                        and type(m.get("start")) is int and type(m.get("end")) is int
                        and m["start"] < row["end"] and m["end"] > row["start"]]
    return result


def render_comparison(data: Mapping[str, object]) -> str:
    template = Path(__file__).resolve().parents[1] / "web" / "shared" / "templates" / "ai-comparison.html"
    encoded = json.dumps(data, ensure_ascii=False).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    return template.read_text(encoding="utf-8").replace("{{REVIEW_SCRIPT}}", template.with_name("ai-translation-review.js").read_text(encoding="utf-8")).replace("{{DATA}}", encoded)
