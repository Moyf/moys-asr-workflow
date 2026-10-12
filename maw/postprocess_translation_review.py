"""Immutable translation review packet; offline edits address stable cue IDs."""

from __future__ import annotations

import copy
import hashlib
import json
from collections.abc import Mapping


def compose_translation(source: str, translation: str, mode: str, first: bool) -> str:
    if mode != "bilingual" or not source.strip():
        return translation
    if not translation.strip() or source.strip() == translation.strip():
        return source
    return f"{translation}\n{source}" if first else f"{source}\n{translation}"


def translation_review(source: Mapping, translated: Mapping, result: Mapping, operation: str, line_order: str, filename: str) -> dict:
    mode = "bilingual" if operation.endswith("-bilingual") else "backfill" if operation.endswith("-backfill") else "single"
    first = line_order == "translation_first" or not line_order and operation.startswith("translate_zh")
    translations = {s["id"]: s for s in translated["segments"]}
    targets = {s["id"]: s for s in result["segments"]}
    if len(targets) != len(result["segments"]):
        raise ValueError("译文核对要求唯一的目标字幕ID。")
    entries = []
    for original in source["segments"]:
        target = targets.get(original["id"])
        translated_segment = translations.get(original["id"])
        if target is None and not original["text"].strip():
            continue  # The existing bilingual writer intentionally omits empty cues.
        if target is None or translated_segment is None:
            raise ValueError("译文核对缺少对应目标字幕。")
        if any(original[field] != target[field] or original[field] != translated_segment[field] for field in ("id", "start", "end")):
            raise ValueError("译文核对的源和结果ID或时间不一致。")
        text = translated_segment["text"]
        if compose_translation(original["text"], text, mode, first) != target["text"]:
            raise ValueError("译文核对结果与翻译组合格式不一致。")
        entries.append({"id": original["id"], "start": original["start"], "end": original["end"],
                        "source": original["text"], "translation": text,
                        "editable": not original.get("disabled") and bool(original["text"].strip())})
    snapshot = json.dumps({"schema": "maw.translation-review.v1", "source": copy.deepcopy(source), "result": copy.deepcopy(result),
                           "entries": entries, "mode": mode, "translationFirst": first}, ensure_ascii=False, separators=(",", ":"))
    return {"snapshot": snapshot, "sha256": hashlib.sha256(snapshot.encode("utf-8")).hexdigest(), "filename": filename}
