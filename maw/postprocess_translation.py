"""Editable source/translation tracks shared by toolbox and automatic processing."""

from __future__ import annotations

import copy

from maw.project import normalize_project
from maw.project_preview import JsonDict


def attach_translation_project(source_project: JsonDict, translated_project: JsonDict, *, target: str) -> JsonDict:
    """Replace the editor's fixed secondary track after validating every cue."""
    source_segments = source_project.get("segments")
    translated_segments = translated_project.get("segments")
    if not isinstance(source_segments, list) or not isinstance(translated_segments, list):
        raise ValueError("翻译前后的工程缺少有效字幕段。")
    if len(source_segments) != len(translated_segments):
        raise ValueError("翻译结果未保持原字幕段数，无法生成主副字幕工程。")

    for index, (source, translated) in enumerate(zip(source_segments, translated_segments, strict=True), 1):
        if not isinstance(source, dict) or not isinstance(translated, dict):
            raise ValueError(f"第 {index} 条翻译结果不是有效字幕段。")
        if (
            source.get("start") != translated.get("start")
            or source.get("end") != translated.get("end")
            or source.get("id") != translated.get("id")
        ):
            raise ValueError(f"第 {index} 条翻译结果未保持原字幕时间范围或稳定 ID。")
        source_text = source.get("text")
        translated_text = translated.get("text")
        if not isinstance(source_text, str) or not isinstance(translated_text, str):
            raise ValueError(f"第 {index} 条翻译结果为空。")
        if not translated_text.strip() and source_text.strip():
            raise ValueError(f"第 {index} 条翻译结果为空。")

    combined = copy.deepcopy(source_project)
    if "markers" in translated_project:
        combined["markers"] = copy.deepcopy(translated_project["markers"])
    combined.pop("extensionSegments", None)
    multi = combined.get("multi_subtitle")
    if not isinstance(multi, dict):
        multi = {}
        combined["multi_subtitle"] = multi
    multi["schema"] = str(multi.get("schema") or "moy.asr.multi_subtitle.v1")
    multi["enabled"] = True
    multi["display_mode"] = "both"
    tracks = multi.get("tracks")
    if not isinstance(tracks, list):
        tracks = []
        multi["tracks"] = tracks
    bindings = multi.get("bindings")
    if not isinstance(bindings, list):
        bindings = []
        multi["bindings"] = bindings

    # The editor previews and exports tracks[0]. Reuse that track's identity
    # and presentation settings; never append a new translation behind it.
    track = tracks[0] if tracks else {"id": f"translation-{target}", "role": "extension"}
    track_id = str(track["id"])
    track["language"] = target
    if track.get("name") in (None, "中文翻译", "英文翻译"):
        track["name"] = "中文翻译" if target == "zh" else "英文翻译"
    track["split_mode"] = "continuous" if target == "zh" else "word"
    track["source_name"] = f"translation-{target}.srt"

    extension_segments: list[dict[str, object]] = []
    extension_bindings: list[tuple[int, dict[str, object], dict[str, object]]] = []
    for index, (source, translated) in enumerate(zip(source_segments, translated_segments, strict=True), 1):
        assert isinstance(source, dict)
        assert isinstance(translated, dict)
        source_text = source.get("text")
        translated_text = translated.get("text")
        if (
            isinstance(source_text, str)
            and isinstance(translated_text, str)
            and translated_text.strip()
            and translated_text.strip() == source_text.strip()
        ):
            # 目标语言预过滤保留的句子：译文与主字幕相同，副轨再放一份只会
            # 造成重复显示，跳过该句的副轨段与绑定（空↔空字幕保持原有占位行为）。
            continue
        extension_segment: dict[str, object] = {
            "id": f"{track_id}-segment-{index:03d}",
            "start": translated["start"],
            "end": translated["end"],
            "text": translated["text"],
        }
        if translated.get("disabled") is True:
            extension_segment["disabled"] = True
        extension_segments.append(extension_segment)
        extension_bindings.append((index, source, extension_segment))

    # Assign a fresh list, including when the new result is shorter or empty.
    track["segments"] = extension_segments
    if tracks:
        tracks[0] = track
    else:
        tracks.append(track)

    old_bindings = {str(binding["main_segment_ids"][0]): binding
                    for binding in bindings if binding.get("track_id") == track_id}
    bindings = [binding for binding in bindings if binding.get("track_id") != track_id]
    multi["bindings"] = bindings

    used_main_ids = {
        str(main_id)
        for binding in bindings
        if isinstance(binding, dict)
        for main_id in (binding.get("main_segment_ids") or [])
    }
    used_binding_ids = {str(binding.get("id")) for binding in bindings if isinstance(binding, dict) and binding.get("id")}
    for index, source, extension in extension_bindings:
        main_id = str(source["id"])
        if main_id in used_main_ids:
            continue
        previous = old_bindings.get(main_id)
        binding = copy.deepcopy(previous) if previous is not None else {}
        binding_id = str(binding.get("id") or f"translation-binding-{index:03d}")
        binding_suffix = 2
        while binding_id in used_binding_ids:
            binding_id = f"translation-binding-{index:03d}-{binding_suffix}"
            binding_suffix += 1
        used_binding_ids.add(binding_id)
        binding.update({
            "id": binding_id,
            "track_id": track_id,
            "main_segment_ids": [main_id],
            "extension_segment_ids": [extension["id"]],
            "start_offset_ms": int(extension["start"]) - int(source["start"]),
            "end_offset_ms": int(extension["end"]) - int(source["end"]),
        })
        bindings.append(binding)
        used_main_ids.add(main_id)

    return normalize_project(combined)
