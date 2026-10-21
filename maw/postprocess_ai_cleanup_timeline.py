"""Strict text-editing draft -> source-indexed decisions. No guessed timecodes."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence

from maw.postprocess_ai_cleanup_items import item_text_spans
from maw.postprocess_draft import draft_lines


def escape_source_text(text: str) -> str:
    """Keep source syntax literal; only inserted unescaped markers edit it."""
    return text.replace("\\", "\\\\").replace("~", "\\~").replace("%", "\\%").replace("\n", "\\n").replace("\r", "\\r")


def _marked_source(body: str) -> tuple[str, set[int]]:
    output: list[str] = []
    mask: set[int] = set()
    cutting = False
    cut_start = 0
    cursor = 0
    escapes = {"\\": "\\", "~": "~", "%": "%", "n": "\n", "r": "\r"}
    while cursor < len(body):
        if body[cursor] == "\\" and cursor + 1 < len(body) and body[cursor + 1] in escapes:
            char = escapes[body[cursor + 1]]
            cursor += 2
        elif body.startswith("~~", cursor):
            if cutting and len(output) == cut_start:
                raise ValueError("划删标记必须配对且非空")
            cutting = not cutting
            cut_start = len(output)
            cursor += 2
            continue
        else:
            char = body[cursor]
            cursor += 1
        if cutting:
            mask.add(len(output))
        output.append(char)
    if cutting:
        raise ValueError("划删标记必须配对且非空")
    return "".join(output), mask


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
        output.append(escape_source_text(char))
    if cutting:
        output.append("~~")
    return f"[{clip_id}] {''.join(output)}"


def parse_timeline(text: str, rows: Sequence[Mapping[str, str]], items_by_id: Mapping[str, Sequence[Mapping[str, object]]]) -> dict[str, object]:
    """Every target appears once, in order. Missing lines never mean deletion."""
    lines = draft_lines(text)
    targets = [row for row in rows if row.get("contextOnly") != "true"]
    readonly_ids = {row["id"] for row in rows if row.get("contextOnly") == "true"}
    # Some models echo the supplied context. It is never an editable target,
    # so discard only rows explicitly identified as read-only in this request.
    # Missing/duplicate targets, unknown IDs and extra prose remain errors.
    lines = [line for line in lines if not (
        (match := re.fullmatch(r"\[(c\d+)\] ?(.*)", line)) and match[1] in readonly_ids
    )]
    if len(lines) != len(targets):
        expected = [row["id"] for row in targets]
        actual = [match[1] for line in lines if (match := re.match(r"\[(c\d+)\]", line))]
        missing = [clip_id for clip_id in expected if clip_id not in actual]
        extra = [clip_id for clip_id in actual if clip_id not in expected]
        detail = f"应输出 {len(targets)} 行，实际 {len(lines)} 行"
        if missing:
            detail += "；缺少 ID：" + "、".join(missing)
        if extra:
            detail += "；额外或只读 ID：" + "、".join(extra)
        raise ValueError(f"编辑稿必须完整输出每个目标行；不能省略行或添加说明（{detail}）")
    decisions = []
    for line, row in zip(lines, targets):
        match = re.fullmatch(r"\[(c\d+)\] ?(.*)", line)
        if match is None or match[1] != row["id"]:
            raise ValueError("编辑稿 id 必须唯一并保持原始顺序")
        body = match[2]
        note = ""
        review = False
        annotation = re.search(r"\s*(?<!\\)%{1,2}(待确认|待核查|删除|删减)[：:](.*?)(?<!\\)%{1,2}\s*$", body)
        if annotation:
            note = annotation[2].strip()
            review = annotation[1] in {"待确认", "待核查"}
            if not note:
                raise ValueError("待确认或删除注释需要具体原因")
            body = body[:annotation.start()]
        original, mask = _marked_source(body)
        if original != row["asrText"]:
            raise ValueError(f"{row['id']} 改写了原文；只能插入划删或行尾注释")
        items = items_by_id[row["id"]]
        spans = item_text_spans(original, items)
        if spans is None:
            raise ValueError(f"{row['id']} 词项与原文无法对齐")
        deleted = []
        unsafe_cut = ""
        for index, (start, end) in enumerate(spans):
            # A word token can own a leading/trailing separator. Marking the
            # complete word is sufficient; whitespace has no separate speech
            # timing. All non-whitespace characters must still be selected.
            content = {offset for offset in range(start, end) if not original[offset].isspace()}
            overlap = mask.intersection(content)
            if overlap and overlap != content:
                unsafe_cut = f"划删切开了词项 {str(items[index]['text'])[:120]!r}，没有词项内部时间码；保留整行待回听"
                break
            if overlap:
                deleted.append(index)
        if unsafe_cut:
            # Source identity has already been verified. Reject the cut, not
            # the recording: retain this entire row and expose the unsafe
            # boundary as a review marker, including any other cuts in it.
            decisions.append({"id": row["id"], "decision": "review", "scriptLine": row.get("scriptLine", ""), "reason": unsafe_cut + (f"；模型说明：{note}" if note else "")})
            continue
        if mask and not deleted:
            raise ValueError("不能仅划删无时间来源的标点")
        timed_chars = {offset for index in deleted for offset in range(*spans[index])}
        if len(deleted) < len(items) and any(not original[offset].isspace() for offset in mask - timed_chars):
            raise ValueError("局部划删只能覆盖完整词项；不要扩到词项之外的标点")
        decision = "review" if review else "discard" if len(deleted) == len(items) else "edit" if deleted else "keep"
        result: dict[str, object] = {"id": row["id"], "decision": decision, "scriptLine": row.get("scriptLine", ""), "reason": note}
        if decision in {"discard", "edit"}:
            result["evidence"] = "".join(str(items[index]["text"]) for index in deleted)
        if decision == "edit":
            result["deleteItems"] = deleted
        decisions.append(result)
    return {"decisions": decisions}
