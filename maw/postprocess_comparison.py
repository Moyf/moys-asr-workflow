"""Offline HTML from validated before/after project snapshots."""

from __future__ import annotations

import json
import difflib
from collections.abc import Mapping, Sequence
from pathlib import Path

from maw.postprocess_ai_cleanup_items import cleaned_srt_segments, item_text_spans


def comparison_data(before: Mapping[str, object], after: Mapping[str, object], operation: str, decisions: Sequence[Mapping[str, object]] = ()) -> dict[str, object]:
    source = [s for s in cleaned_srt_segments(before, before.get("segments", [])) if isinstance(s, Mapping) and not s.get("disabled")]
    output = [s for s in cleaned_srt_segments(after, after.get("segments", [])) if isinstance(s, Mapping) and not s.get("disabled")]
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
        original = next((s for s in before.get("segments", []) if isinstance(s, Mapping) and s.get("id") == segment.get("id")), segment)
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
    return {"schema": "maw.ai-comparison.v1", "operation": operation, "before": "\n".join(str(s.get("text") or "") for s in source), "after": "\n".join(str(s.get("text") or "") for s in output), "rows": rows}


def render_comparison(data: Mapping[str, object]) -> str:
    template = Path(__file__).resolve().parents[1] / "web" / "shared" / "templates" / "ai-comparison.html"
    encoded = json.dumps(data, ensure_ascii=False).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    return template.read_text(encoding="utf-8").replace("{{DATA}}", encoded)
