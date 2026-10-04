"""Second, deletion-monotone pass over the proposed spoken-word transcript."""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence

from maw.postprocess_llm import LlmClientError, MAX_RESPONSE_ATTEMPTS


READTHROUGH_BATCH_SIZE = 80
READTHROUGH_CONTEXT_CLIPS = 3


def readthrough_prompt(notes: str = "") -> str:
    return (
        "这是 AI 口播整理的第二道工序：剪后通读与信息损失审计，不重新剪辑。\n"
        "输入是按录音顺序排列的原始字幕；proposed=discard 的文字拟被删除，其余文字拟保留。"
        "跳过拟删除文字，把保留文字依次连起来读。检查主语、指代、背景、所以/但是等承接、"
        "方法步骤、数字、限定条件与因果是否仍成立。对每段拟删除内容核对：独有信息是否在"
        "alternativeText 或其他保留文字中完整覆盖？病句不等于无效内容，不能因相似而丢失步骤。\n"
        "只输出明确需要复核的少量项：不安全的删除应恢复并复核；保留段如因剪辑形成"
        "悬空指代或断裂也可标复核。拿不准删除是否安全应复核。不得提出新删除、改写、"
        "翻译、重排或补写内容，不设目标时长或删减比例。\n"
        "contextOnly 为字符串 true 的记录只读，不得输出其复核项。"
        "alternativeText 是替代版本的原文引用，不是新增字幕。\n"
        '只输出严格 JSON：{"reviews": [{"id": "c001", "reason": "复核：具体理由"}]}。'
        "无问题返回 reviews 空数组；每个 id 只能出现一次，必须来自当前非只读输入。"
        "reason 使用 操作：原因 格式，不添加 [AI] 前缀。"
        + (f"\n本次用户补充说明（在上述边界内参考）：\n{notes.strip()}" if notes.strip() else "")
    )


def readthrough_batches(rows: Sequence[dict[str, str]]) -> list[list[dict[str, str]]]:
    """Partition once, with context from actual surviving neighbors at each join."""
    batches: list[list[dict[str, str]]] = []
    for start in range(0, len(rows), READTHROUGH_BATCH_SIZE):
        end = start + READTHROUGH_BATCH_SIZE
        before = [row for row in rows[:start] if row["proposed"] != "discard"][-READTHROUGH_CONTEXT_CLIPS:]
        after = [row for row in rows[end:] if row["proposed"] != "discard"][:READTHROUGH_CONTEXT_CLIPS]
        batches.append([
            *[{**row, "contextOnly": "true"} for row in before],
            *[dict(row) for row in rows[start:end]],
            *[{**row, "contextOnly": "true"} for row in after],
        ])
    return batches


def _review_error(value: object, targets: set[str]) -> str | None:
    if not isinstance(value, dict) or not isinstance(value.get("reviews"), list):
        return "响应必须包含 reviews 数组"
    if set(value) != {"reviews"}:
        return "复查响应只能包含 reviews，不能添加新裁决"
    seen: set[str] = set()
    for item in value["reviews"]:
        if not isinstance(item, dict) or set(item) != {"id", "reason"}:
            return "复核项只能包含 id 与 reason"
        clip_id = item["id"]
        if not isinstance(clip_id, str) or clip_id not in targets or clip_id in seen:
            return "复核 id 必须唯一且属于当前非只读输入"
        seen.add(clip_id)
        if not isinstance(item["reason"], str) or not item["reason"].strip():
            return "复核理由必须是非空字符串"
    return None


def review_decisions(
    complete: Callable[[str, list[dict[str, str]]], Mapping[str, object]],
    rows: Sequence[dict[str, str]],
    *,
    notes: str = "",
    on_status: Callable[[str], None] | None = None,
) -> dict[str, str]:
    """Return review flags only; failed validation writes no partial artifact."""
    reasons: dict[str, str] = {}
    prompt = readthrough_prompt(notes)
    for payload in readthrough_batches(rows):
        if on_status:
            on_status("toolbox_status_ai_cleanup_review")
        targets = {row["id"] for row in payload if row.get("contextOnly") != "true"}
        error = ""
        for _attempt in range(MAX_RESPONSE_ATTEMPTS):
            retry = f"\n上次复查响应未通过校验：{error}。按原协议完整重试，只返回 reviews。" if error else ""
            response = complete(prompt + retry, payload)
            error = _review_error(response, targets)
            if error is None:
                reasons.update({item["id"]: item["reason"].strip() for item in response["reviews"]})
                break
        else:
            raise LlmClientError(f"AI 剪后复查在重试后仍未通过协议校验：{error}", category="protocol", operation="ai_cleanup")
    return reasons
