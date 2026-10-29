"""Immutable translation review packet; offline edits address stable cue IDs."""

from __future__ import annotations

import copy
import hashlib
import json
from collections.abc import Mapping
from maw.project_tracks import get_main_track, get_track
from maw.project import normalize_project


def compose_translation(source: str, translation: str, mode: str, first: bool) -> str:
    if mode != "bilingual" or not source.strip():
        return translation
    if not translation.strip() or source.strip() == translation.strip():
        return source
    return f"{translation}\n{source}" if first else f"{source}\n{translation}"


def translation_review(source: Mapping, translated: Mapping, result: Mapping, operation: str, line_order: str, filename: str) -> dict:
    source, translated, result = (normalize_project(dict(project)) for project in (source, translated, result))
    mode = "bilingual" if operation.endswith("-bilingual") else "backfill" if operation.endswith("-backfill") else "single"
    first = line_order == "translation_first" or not line_order and operation.startswith("translate_zh")
    translations = {s["id"]: s for s in get_main_track(translated)["segments"]}
    targets = {s["id"]: s for s in get_main_track(result)["segments"]}
    track = None
    if mode != "backfill" and result.get("bilingual", {}).get("active_track_id"):
        candidate = get_track(result, result["bilingual"]["active_track_id"])
        language = "zh" if operation.startswith("translate_zh") else "en"
        if candidate.get("language") == language and candidate.get("role") == "secondary":
            track = candidate
            mode = "tracks"
    track_segments = {s["id"]: s for s in track["segments"]} if track else {}
    # Bindings address the active extension explicitly; unchanged translations
    # may be omitted without shifting the remaining cue IDs.
    target_ids = {binding["source"]["segment_id"]: binding["target"]["segment_id"]
                  for binding in result["bindings"] if track and binding["target"]["track_id"] == track["id"]}
    if len(targets) != len(get_main_track(result)["segments"]):
        raise ValueError("译文核对要求唯一的目标字幕ID。")
    entries = []
    for original in get_main_track(source)["segments"]:
        target = targets.get(original["id"])
        translated_segment = translations.get(original["id"])
        if target is None and not original["text"].strip():
            continue  # The existing bilingual writer intentionally omits empty cues.
        if target is None or translated_segment is None:
            raise ValueError("译文核对缺少对应目标字幕。")
        if any(original[field] != target[field] or original[field] != translated_segment[field] for field in ("id", "start", "end")):
            raise ValueError("译文核对的源和结果ID或时间不一致。")
        text = translated_segment["text"]
        target_id = target_ids.get(original["id"])
        extension = track_segments.get(target_id)
        if extension is None:
            target_id = None
        if mode == "tracks":
            if target["text"] != original["text"] or (
                extension is None and text.strip() != original["text"].strip()
            ) or (extension is not None and any(extension[field] != translated_segment[field] for field in ("start", "end", "text"))):
                raise ValueError("译文核对的主副字幕映射不一致。")
        elif compose_translation(original["text"], text, mode, first) != target["text"]:
            raise ValueError("译文核对结果与翻译组合格式不一致。")
        entries.append({"id": original["id"], "start": original["start"], "end": original["end"],
                        "source": original["text"], "translation": text,
                        "editable": not original.get("disabled") and bool(original["text"].strip()) and (mode != "tracks" or extension is not None),
                        **({"targetId": target_id} if mode == "tracks" else {})})
    snapshot = json.dumps({"schema": "maw.translation-review.v1", "source": copy.deepcopy(source), "result": copy.deepcopy(result),
                           "entries": entries, "mode": mode, "translationFirst": first,
                           **({"translationTrackId": track["id"]} if track else {})}, ensure_ascii=False, separators=(",", ":"))
    return {"snapshot": snapshot, "sha256": hashlib.sha256(snapshot.encode("utf-8")).hexdigest(), "filename": filename}
