"""Validated, source-located AI notes shared by subtitle tasks."""

from __future__ import annotations

import copy
import hashlib
import re
import uuid
from collections.abc import Mapping, Sequence

SCHEMA = "maw.ai-annotation.v1"
STATE_FIELDS = ("start", "end", "name", "color", "note", "review")
MAX_ANNOTATIONS = 80


def marker_state(marker: Mapping[str, object]) -> dict[str, object]:
    return {field: copy.deepcopy(marker.get(field)) for field in STATE_FIELDS}


def validate_annotations(raw: object, sources: Mapping[str, Mapping[str, object]]) -> tuple[list[dict[str, object]], tuple[str, ...]]:
    if raw is None:
        return [], ()
    if not isinstance(raw, list) or len(raw) > MAX_ANNOTATIONS:
        return [], ("AI 备注格式无效或超过80条，已忽略备注；字幕结果仍按任务协议校验。",)
    accepted, warnings = [], []
    for number, entry in enumerate(raw, 1):
        ids = entry.get("source_ids") if isinstance(entry, Mapping) else None
        kind = entry.get("kind") if isinstance(entry, Mapping) else None
        message = entry.get("message") if isinstance(entry, Mapping) else None
        if (not isinstance(ids, list) or not ids or len(ids) > 40
                or any(not isinstance(i, str) or i not in sources for i in ids)
                or len(set(ids)) != len(ids) or not isinstance(kind, str) or kind not in {"note", "review"}
                or not isinstance(message, str) or not message.strip() or len(message) > 300
                or re.search(r"[\x00-\x1f\x7f]", message)):
            warnings.append(f"第{number}条 AI 备注的源ID、类型或说明无效，已忽略。")
            continue
        accepted.append({"source_ids": ids.copy(), "kind": kind, "message": message.strip()})
    return accepted, tuple(warnings)


def append_markers(existing: object, markers: Sequence[Mapping[str, object]]) -> dict[str, object]:
    """Allocate IDs without changing existing items or top-level metadata."""
    field = copy.deepcopy(dict(existing)) if isinstance(existing, Mapping) else {}
    items = field.get("items")
    items = items if isinstance(items, list) else []
    used = {m.get("id") for m in items if isinstance(m, Mapping) and isinstance(m.get("id"), str)}
    ordered = sorted(markers, key=lambda m: (int(m["start"]), str(m.get("name", ""))))
    # Generated IDs must not take an explicit ID from a later marker in time.
    reserved = {m.get("id") for m in ordered
                if isinstance(m.get("id"), str) and m["id"].strip()}
    for raw in ordered:
        marker = copy.deepcopy(dict(raw))
        marker_id = marker.get("id")
        if not isinstance(marker_id, str) or not marker_id.strip() or marker_id in used:
            number = 1
            while f"marker-{number:03d}" in used or f"marker-{number:03d}" in reserved:
                number += 1
            marker["id"] = f"marker-{number:03d}"
        used.add(marker["id"])
        items.append(marker)
    field.update({"schema": "moy.asr.markers.v1", "items": items})
    return field


def write_annotations(project: dict, sources: Mapping[str, Mapping[str, object]], annotations: Sequence[Mapping[str, object]], task: str) -> tuple[str, ...]:
    """Replace only this task's untouched notes; protect user edits and review decisions."""
    validated, warnings = [], ()
    for start in range(0, len(annotations), MAX_ANNOTATIONS):
        chunk, problems = validate_annotations(list(annotations[start:start + MAX_ANNOTATIONS]), sources)
        validated.extend(chunk)
        warnings += problems
    existing = project.get("markers")
    existing = copy.deepcopy(dict(existing)) if isinstance(existing, Mapping) else {}
    old_items = existing.get("items", [])
    retained, reusable, protected = [], {}, set()
    for marker in old_items if isinstance(old_items, list) else []:
        ai = marker.get("ai") if isinstance(marker, Mapping) else None
        if (not isinstance(ai, Mapping) or ai.get("schema") != SCHEMA or ai.get("task") != task
                or not isinstance(ai.get("key"), str) or not re.fullmatch(r"[0-9a-f]{64}", ai["key"])):
            retained.append(marker)
        elif marker_state(marker) != ai.get("generated"):
            retained.append(marker)
            protected.add(ai.get("key"))
        else:
            reusable[ai.get("key")] = marker.get("id")
    grouped = {}
    for entry in validated:
        selected = [sources[i] for i in entry["source_ids"]]
        if any(type(s.get("start")) is not int or type(s.get("end")) is not int
               or s["start"] < 0 or s["end"] <= s["start"] for s in selected):
            warnings += ("AI 备注缺少可靠源时间，未写入工程区段。",)
            continue
        # Separate non-adjacent ranges rather than claiming intervening cues.
        for source_id, source in zip(entry["source_ids"], selected, strict=True):
            stable = str(source.get("id") or source_id)
            key = hashlib.sha256(f"{task}\0{stable}\0{entry['kind']}".encode()).hexdigest()
            row = grouped.setdefault(key, {"source": source, "kind": entry["kind"], "messages": []})
            if entry["message"] not in row["messages"]:
                row["messages"].append(entry["message"])
    run_id = uuid.uuid4().hex
    new = []
    for key, entry in grouped.items():
        if key in protected:
            continue
        source, kind = entry["source"], entry["kind"]
        message = "；".join(entry["messages"])[:300].strip()
        marker = {"start": source["start"], "end": source["end"],
                  "name": re.sub(r"[\x00-\x1f\x7f]+", " ", str(source.get("text") or "AI 备注")).strip()[:20].strip(),
                  "color": "#f5a623" if kind == "review" else "#3e63dd",
                  "note": f"[AI] {'待核查' if kind == 'review' else '注'}：{message}"}
        if kind == "review":
            marker["review"] = {"status": "pending", "reason": message}
        marker["ai"] = {"schema": SCHEMA, "task": task, "run_id": run_id, "key": key, "generated": marker_state(marker)}
        if key in reusable:
            marker["id"] = reusable[key]
        new.append(marker)
    existing["items"] = retained
    if new or retained or project.get("markers") is not None:
        project["markers"] = append_markers(existing, new)
    return warnings


ANNOTATION_PROMPT = (
    '\n可选顶层 annotations 数组，默认省略；仅对需要用户理解的歧义或术语提供稀疏备注：'
    '{"source_ids":["c0001"],"kind":"note","message":"简短说明"}。kind只允许note或review。'
    'source_ids 只能引用本批输入ID，不输出时间；note 是普通注释，review 是需人工核查的疑点。'
    '不要解释每条保留决定，不要写思考过程。每条说明最多300字，本批最多80条。'
)
