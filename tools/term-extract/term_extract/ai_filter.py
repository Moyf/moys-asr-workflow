"""AI 语义筛选：判断候选是否为需要在字幕中准确保留的游戏专名。

复用工具箱 AI 处理的 LLM 客户端（maw.postprocess_llm）；协议校验失败重试
一次，仍失败抛 TermAiFilterError，由 CLI 写记录文件并以非零码退出——
绝不静默产出未经语义筛选的推荐。
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable, Mapping, Sequence
from typing import Final

from maw.postprocess_llm import (
    LlmClientError,
    LlmSettings,
    PRESETS,
    _request_completion,
    preset_by_id,
)

AI_TERM_TYPES: Final[tuple[str, ...]] = (
    "人物", "地名", "技能", "道具", "型号", "缩写", "其他专名", "非术语",
)
AI_BATCH_SIZE: Final[int] = 30
AI_ENV_API_KEY: Final[str] = "MAW_TERMS_LLM_API_KEY"

AI_TERMS_JSON_SCHEMA: Final[dict[str, object]] = {
    "type": "object",
    "properties": {
        "terms": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "word": {"type": "string"},
                    "verdict": {"type": "string", "enum": ["keep", "reject"]},
                    "type": {"type": "string", "enum": list(AI_TERM_TYPES)},
                    "reason": {"type": "string"},
                },
                "required": ["word", "verdict", "type", "reason"],
            },
        }
    },
    "required": ["terms"],
}

SYSTEM_PROMPT: Final[str] = """你是游戏字幕的术语审核员。输入是从游戏录像画面 OCR 提取的候选词列表，\
每个候选附带变体写法、出现频次、置信度与上下文样例。

判断每个候选是否为需要在字幕中准确保留的游戏专有名词，包括：人物名、地名、\
原创机制名、技能名称、道具名、特殊型号（如 LJ-84）与缩写。

必须排除：普通形容词与动词、常见界面词（继续/设置/保存等）、完整对白句子、\
语气词、以及明显的 OCR 错字（如「星孩」若上下文明确是「星核」）。无法确定时判 reject 并在 reason 说明歧义。

只输出 JSON：{"terms": [{"word": 原样返回输入词, "verdict": "keep" 或 "reject", \
"type": 人物/地名/技能/道具/型号/缩写/其他专名/非术语 之一, "reason": 不超过 60 字的中文理由}]}。\
每个输入词必须恰好出现一次，不得增删改写词本身。"""

Complete = Callable[[str, list[dict[str, object]]], str]


class TermAiFilterError(RuntimeError):
    """AI 筛选协议失败（重试后仍不合规）。"""


def build_settings(
    *,
    preset_id: str | None = None,
    base_url: str | None = None,
    model: str | None = None,
    api_key: str | None = None,
    reasoning_mode: str = "off",
) -> LlmSettings:
    """从 CLI 参数与环境变量组装 LLM 连接（约定与工具箱 AI 处理一致）。"""

    preset = preset_by_id(preset_id) if preset_id else None
    if preset is None and not (base_url and model):
        raise ValueError(
            "AI 筛选需要 LLM 连接：用 --llm-preset 选择预设，或 --llm-base-url/--llm-model 指定；"
            "API Key 用 --llm-api-key 或环境变量 MAW_TERMS_LLM_API_KEY 提供。"
            "本次只想先看提取效果时，加 --no-ai 跳过 AI 筛选。"
        )
    resolved_base = base_url or (preset.base_url if preset else "")
    resolved_model = model or (preset.model if preset else "")
    resolved_key = api_key or os.environ.get(AI_ENV_API_KEY) or (
        os.environ.get(f"{preset.env_prefix}_API_KEY") if preset else ""
    )
    if not resolved_key:
        raise ValueError("AI 筛选缺少 API Key（--llm-api-key 或环境变量 MAW_TERMS_LLM_API_KEY）。")
    return LlmSettings(
        provider_id=preset.id if preset else "custom",
        api_key=resolved_key,
        base_url=resolved_base,
        model=resolved_model,
        reasoning_mode=reasoning_mode,
    )


def filter_candidates(
    candidates: Sequence[Mapping[str, object]],
    settings: LlmSettings,
    *,
    complete: Complete | None = None,
    batch_size: int = AI_BATCH_SIZE,
    on_status: Callable[[str], None] | None = None,
) -> dict[str, dict[str, str]]:
    """逐批请求语义判定；返回 词 → {verdict, type, reason}。"""

    transport = complete or _default_transport(settings)
    if isinstance(batch_size, bool) or not isinstance(batch_size, int) or batch_size <= 0:
        raise ValueError("AI 筛选 batch_size 必须是正整数")
    verdicts: dict[str, dict[str, str]] = {}
    batch_start = 0
    while batch_start < len(candidates):
        batch = list(candidates[batch_start : batch_start + batch_size])
        batch_start += batch_size
        if on_status is not None:
            on_status(f"AI 筛选 {batch_start - len(batch) + 1}-{batch_start} / {len(candidates)}")
        rows = [_candidate_row(candidate) for candidate in batch]
        last_error = "响应不是有效的 JSON。"
        for attempt in range(2):
            system = SYSTEM_PROMPT if not attempt else (
                f"{SYSTEM_PROMPT}\n\n上一次回复违反协议：{last_error}\n请严格按要求重新输出完整 JSON。"
            )
            content = transport(system, rows)
            try:
                parsed = _parse_verdicts(content, [str(row["word"]) for row in rows])
            except _ProtocolError as error:
                last_error = str(error)
                continue
            verdicts.update(parsed)
            last_error = ""
            break
        if last_error:
            raise TermAiFilterError(f"AI 筛选协议失败（已重试一次）：{last_error}")
    return verdicts


def _candidate_row(candidate: Mapping[str, object]) -> dict[str, object]:
    return {
        "word": str(candidate.get("word") or ""),
        "variants": [str(item.get("text")) for item in candidate.get("variants") or []],
        "typeGuess": str(candidate.get("typeGuess") or ""),
        "eventCount": int(candidate.get("eventCount") or 0),
        "hitCount": int(candidate.get("hitCount") or 0),
        "avgConf": float(candidate.get("avgConf") or 0.0),
        "contexts": list(candidate.get("contexts") or []),
    }


def _default_transport(settings: LlmSettings) -> Complete:
    def transport(system_prompt: str, rows: list[dict[str, object]]) -> str:
        body = _request_completion(
            settings,
            system_prompt,
            rows,  # type: ignore[arg-type]
            on_delta=None,
            use_json_format=True,
            response_json_schema=AI_TERMS_JSON_SCHEMA,
        )
        content = body.get("content")
        if not isinstance(content, str) or not content.strip():
            raise LlmClientError(
                "LLM 返回了空内容", category="protocol", operation="terms_ai_filter"
            )
        return content

    return transport


class _ProtocolError(Exception):
    """可重试的协议违规。"""


def _parse_verdicts(content: str, expected_words: Sequence[str]) -> dict[str, dict[str, str]]:
    try:
        payload = json.loads(_strip_json_fence(content))
    except json.JSONDecodeError as error:
        raise _ProtocolError(f"JSON 语法错误：{error.msg}") from error
    if isinstance(payload, list):
        terms = payload
    elif isinstance(payload, dict):
        terms = payload.get("terms")
    else:
        raise _ProtocolError("顶层必须是数组或 {terms: [...]} 对象")
    if not isinstance(terms, list):
        raise _ProtocolError("缺少 terms 数组")
    verdicts: dict[str, dict[str, str]] = {}
    for item in terms:
        if not isinstance(item, dict):
            raise _ProtocolError("terms 中存在非对象条目")
        word = str(item.get("word") or "").strip()
        verdict = str(item.get("verdict") or "")
        term_type = str(item.get("type") or "")
        reason = str(item.get("reason") or "")[:120]
        if not word:
            raise _ProtocolError("存在 word 为空的条目")
        if word in verdicts:
            raise _ProtocolError(f"「{word}」重复出现；每个输入词必须恰好返回一次")
        if verdict not in {"keep", "reject"}:
            raise _ProtocolError(f"「{word}」的 verdict 不是 keep/reject")
        if term_type not in AI_TERM_TYPES:
            raise _ProtocolError(f"「{word}」的 type 不在允许枚举内")
        verdicts[word] = {"verdict": verdict, "type": term_type, "reason": reason}
    expected = [word for word in expected_words if word]
    if sorted(verdicts) != sorted(expected):
        missing = [word for word in expected if word not in verdicts]
        extra = [word for word in verdicts if word not in expected]
        raise _ProtocolError(
            f"输入词与输出不一致（缺少 {missing[:3]}，多出 {extra[:3]}）"
        )
    return verdicts


def _strip_json_fence(text: str) -> str:
    """剥掉 Markdown 代码围栏与思考块，取第一个 JSON 值的原文。"""

    stripped = text.strip()
    if stripped.startswith("```"):
        lines = stripped.splitlines()
        lines = [line for line in lines if not line.strip().startswith("```")]
        stripped = "\n".join(lines).strip()
    for opener, closer in (("[", "]"), ("{", "}")):
        start = stripped.find(opener)
        end = stripped.rfind(closer)
        if start != -1 and end > start:
            return stripped[start : end + 1]
    return stripped


def available_presets() -> tuple[str, ...]:
    return tuple(preset.id for preset in PRESETS)
