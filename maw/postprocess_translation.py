"""Editable source/translation tracks shared by toolbox and automatic processing."""

from __future__ import annotations

import copy

from maw.project import normalize_project
from maw.project_preview import JsonDict
from maw.project_tracks import get_main_track, get_track, project_tracks


def _unique_id(base: str, reserved: set[str]) -> str:
    identifier = base[:150]
    suffix = 2
    while identifier in reserved:
        identifier = f"{base[:150]}-{suffix}"
        suffix += 1
    reserved.add(identifier)
    return identifier


def attach_translation_project(source_project: JsonDict, translated_project: JsonDict, *, target: str) -> JsonDict:
    """Replace the active secondary track atomically and retain every other track."""
    combined = normalize_project(source_project)
    translated_project = normalize_project(translated_project)
    main = get_main_track(combined)
    source_segments = main["segments"]
    translated_segments = get_main_track(translated_project)["segments"]
    if len(source_segments) != len(translated_segments):
        raise ValueError("翻译结果未保持原字幕段数，无法生成主副字幕工程。")
    for index, (source, translated) in enumerate(zip(source_segments, translated_segments, strict=True), 1):
        if any(source.get(field) != translated.get(field) for field in ("id", "start", "end")):
            raise ValueError(f"第 {index} 条翻译结果未保持原字幕时间范围或稳定 ID。")
        if not str(translated.get("text") or "").strip() and str(source.get("text") or "").strip():
            raise ValueError(f"第 {index} 条翻译结果为空。")
    if "markers" in translated_project:
        combined["markers"] = copy.deepcopy(translated_project["markers"])
    bilingual = combined.setdefault("bilingual", {})
    track = get_track(combined, str(bilingual.get("active_track_id") or ""))
    if track is None:
        track_ids = {item["id"] for item in project_tracks(combined)}
        track = {"id": _unique_id(f"translation-{target}", track_ids), "role": "secondary",
                 "name": "", "enabled": True, "segments": []}
        combined["tracks"].append(track)
    track_id = track["id"]
    bilingual.update({"display_mode": "both", "active_track_id": track_id})
    track.update({"language": target, "enabled": True,
                  "split_mode": "continuous" if target == "zh" else "word",
                  "source_name": f"translation-{target}.srt"})
    if track.get("name") in (None, "", "中文翻译", "英文翻译"):
        track["name"] = "中文翻译" if target == "zh" else "英文翻译"

    bindings = combined.setdefault("bindings", [])
    previous = {binding["source"]["segment_id"]: binding for binding in bindings
                if binding["source"]["track_id"] == main["id"] and binding["target"]["track_id"] == track_id}
    previous_cues = {segment["id"]: segment for segment in track["segments"]}
    bindings[:] = [binding for binding in bindings if binding["target"]["track_id"] != track_id]
    cue_ids = {segment["id"] for other in project_tracks(combined) if other is not track
               for segment in other["segments"]}
    binding_ids = {binding["id"] for binding in bindings}
    extension_segments = []
    for index, (source, translated) in enumerate(zip(source_segments, translated_segments, strict=True), 1):
        if translated["text"].strip() and translated["text"].strip() == source["text"].strip():
            continue
        old_binding = previous.get(source["id"])
        old_target = old_binding["target"]["segment_id"] if old_binding is not None else None
        extension = copy.deepcopy(previous_cues.get(old_target, {}))
        extension.update(copy.deepcopy(translated))
        if "items" not in translated:
            extension.pop("items", None)
        extension["id"] = _unique_id(old_target or f"{track_id}-segment-{index:03d}", cue_ids)
        extension_segments.append(extension)
        binding = copy.deepcopy(old_binding) if old_binding is not None else {}
        binding.update({"id": _unique_id(str(binding.get("id") or f"translation-binding-{index:03d}"), binding_ids),
                        "source": {**binding.get("source", {}), "track_id": main["id"], "segment_id": source["id"]},
                        "target": {**binding.get("target", {}), "track_id": track_id, "segment_id": extension["id"]},
                        "start_offset_ms": extension["start"] - source["start"],
                        "end_offset_ms": extension["end"] - source["end"]})
        bindings.append(binding)
    track["segments"] = extension_segments
    return normalize_project(combined)
