"""Strict text-editing draft -> source-indexed decisions. No guessed timecodes."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence

from maw.postprocess_ai_cleanup_items import item_text_spans


def draft_line(clip_id: str, text: str, deleted: Sequence[int] = (), items: Sequence[Mapping[str, object]] = ()) -> str:
    spans = item_text_spans(text, items) if deleted else []
    removed = set(deleted)
    mask = {offset for index, (start, end) in enumerate(spans or []) if index in removed for offset in range(start, end)}
    output = []
    cutting = False
    for offset, char in enumerate(text):
        if (offset in mask) != cutting:
            output.append("~~")
            cutting = not cutting
        output.append(char)
    if cutting:
        output.append("~~")
    return f"[{clip_id}] {''.join(output)}"


def parse_timeline(text: str, rows: Sequence[Mapping[str, str]], items_by_id: Mapping[str, Sequence[Mapping[str, object]]]) -> dict[str, object]:
    """Every target appears once, in order. Missing lines never mean deletion."""
    lines = text.strip().splitlines()
    if lines and lines[0].startswith("```") and lines[-1] == "```":
        lines = lines[1:-1]
    targets = [row for row in rows if row.get("contextOnly") != "true"]
    lines = [line for line in lines if line.strip()]
    if len(lines) != len(targets):
        raise ValueError("编辑稿必须完整输出每个目标行；不能省略行或添加说明")
    decisions = []
    for line, row in zip(lines, targets):
        match = re.fullmatch(r"\[(c\d+)\] ?(.*)", line)
        if match is None or match[1] != row["id"]:
            raise ValueError("编辑稿 id 必须唯一并保持原始顺序")
        body = match[2]
        note = ""
        review = False
        annotation = re.search(r"\s*%{1,2}(待确认|待核查|删除|删减)[：:](.*?)%{1,2}\s*$", body)
        if annotation:
            note = annotation[2].strip()
            review = annotation[1] in {"待确认", "待核查"}
            if not note:
                raise ValueError("待确认或删除注释需要具体原因")
            body = body[:annotation.start()]
        pieces = body.split("~~")
        if len(pieces) % 2 == 0 or any(not pieces[index] for index in range(1, len(pieces), 2)):
            raise ValueError("划删标记必须配对且非空")
        original = "".join(pieces)
        if original != row["asrText"]:
            raise ValueError(f"{row['id']} 改写了原文；只能插入划删或行尾注释")
        mask: set[int] = set()
        cursor = 0
        for index, piece in enumerate(pieces):
            if index % 2:
                mask.update(range(cursor, cursor + len(piece)))
            cursor += len(piece)
        items = items_by_id[row["id"]]
        spans = item_text_spans(original, items)
        if spans is None:
            raise ValueError("词项与原文无法对齐")
        deleted = []
        for index, (start, end) in enumerate(spans):
            overlap = mask.intersection(range(start, end))
            if overlap and len(overlap) != end - start:
                raise ValueError(f"{row['id']} 划删切开了多字 item；必须删除完整词项")
            if overlap:
                deleted.append(index)
        if mask and not deleted:
            raise ValueError("不能仅划删无时间来源的标点")
        timed_chars = {offset for index in deleted for offset in range(*spans[index])}
        if len(deleted) < len(items) and mask - timed_chars:
            raise ValueError("局部划删只能覆盖完整词项；不要扩到词项之外的标点")
        decision = "review" if review else "discard" if len(deleted) == len(items) else "edit" if deleted else "keep"
        result: dict[str, object] = {"id": row["id"], "decision": decision, "scriptLine": row.get("scriptLine", ""), "reason": note}
        if decision in {"discard", "edit"}:
            result["evidence"] = "".join(str(items[index]["text"]) for index in deleted)
        if decision == "edit":
            result["deleteItems"] = deleted
        decisions.append(result)
    return {"decisions": decisions}
