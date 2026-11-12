# pyright: reportAny=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownParameterType=false

"""编辑器内 AI 辅助后端：与 Launcher 共享的 LLM 设置与后台任务注册表。

HTTP 形状留在 serve.py；本模块拥有：

- 供应商设置读写：与 ``maw.postprocess_llm.PRESETS`` 同源的 ``.env``
  配置（``MAW_POSTPROCESS_*``），编辑器与 Launcher 工具箱改的是同一份；
  api_key 只保存、只回传掩码，绝不进入日志或返回值原文。
- 后台任务注册表：queued → running（→ delta）→ done / error 状态机、
  单工作线程、取消事件与历史修剪，供编辑器进度 UI 轮询。
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import threading
import time
import unicodedata
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from maw.gui_config import load_env, masked_secret, save_env
from maw.postprocess_llm import (
    DEFAULT_REASONING_MODE,
    PRESETS,
    LlmClientError,
    LlmSettings,
    is_custom_slot,
    normalize_reasoning_mode,
    postprocess_api_key_required,
    preset_by_id,
    test_llm_connection,
)

LAST_PROVIDER_ENV_KEY = "MAW_POSTPROCESS_LAST_PROVIDER"
# 任务历史：编辑器只在任务进行中与结束后短时间内读取；超出保留量的旧任务
# 直接丢弃，避免长时间运行的编辑器会话累积无界内存。
MAX_TASK_HISTORY = 40
TASK_TTL_SECONDS = 3600.0
TASK_STATUS_QUEUED = "queued"
TASK_STATUS_RUNNING = "running"
TASK_STATUS_DELTA = "delta"
TASK_STATUS_DONE = "done"
TASK_STATUS_ERROR = "error"
TASK_STATUS_CANCELLED = "cancelled"

# runner(env_path, payload, report, cancel) -> dict；report(stage, percent)
# 更新进度文案与百分比（percent=None 表示不定进度），cancel() 查询取消状态。
TaskRunner = Callable[[Path, Mapping[str, Any], Callable[[str, int | None], None], Callable[[], bool]], dict[str, Any]]


def provider_env_prefix(provider_id: str) -> str:
    return preset_by_id(provider_id).env_prefix


def _provider_values(env_path: Path, provider_id: str) -> dict[str, str]:
    # 与 Launcher 的 _postprocess_values / postprocess_pipeline._llm_values
    # 保持同一优先级：进程环境变量优先，其次 .env 文件，最后预设默认值。
    prefix = provider_env_prefix(provider_id)
    values = load_env(env_path)
    api_key = os.environ.get(f"{prefix}_API_KEY") or values.get(f"{prefix}_API_KEY", "")
    if provider_id == "qwen" and not api_key:
        api_key = os.environ.get("DASHSCOPE_API_KEY") or values.get("DASHSCOPE_API_KEY", "")
    return {
        "apiKey": api_key,
        "baseUrl": os.environ.get(f"{prefix}_BASE_URL") or values.get(f"{prefix}_BASE_URL", "") or preset_by_id(provider_id).base_url,
        "model": os.environ.get(f"{prefix}_MODEL") or values.get(f"{prefix}_MODEL", "") or preset_by_id(provider_id).model,
        "reasoningMode": os.environ.get(f"{prefix}_REASONING_MODE") or values.get(f"{prefix}_REASONING_MODE", "") or DEFAULT_REASONING_MODE,
    }


def provider_payloads(env_path: Path) -> list[dict[str, Any]]:
    """供应商列表 + 各槽位配置状态；与 Launcher 工具箱读同一份 .env。"""
    file_values = load_env(env_path)
    selected = file_values.get(LAST_PROVIDER_ENV_KEY, "deepseek")
    payloads: list[dict[str, Any]] = []
    for preset in PRESETS:
        values = _provider_values(env_path, preset.id)
        payloads.append({
            "id": preset.id,
            "label": preset.label,
            "baseUrl": values["baseUrl"],
            "model": values["model"],
            "reasoningMode": normalize_reasoning_mode(values["reasoningMode"]),
            "maskedApiKey": masked_secret(values["apiKey"]),
            "hasApiKey": bool(values["apiKey"]),
            "apiKeyRequired": postprocess_api_key_required(preset.id, values["baseUrl"]),
            "custom": is_custom_slot(preset.id),
            "selected": selected == preset.id,
        })
    return payloads


def read_settings(env_path: Path) -> dict[str, Any]:
    """当前选中供应商的生效设置；api_key 只以掩码出现。"""
    file_values = load_env(env_path)
    provider_id = file_values.get(LAST_PROVIDER_ENV_KEY, "deepseek")
    values = _provider_values(env_path, provider_id)
    return {
        "ok": True,
        "providerId": provider_id,
        "providers": provider_payloads(env_path),
        "baseUrl": values["baseUrl"],
        "model": values["model"],
        "reasoningMode": normalize_reasoning_mode(values["reasoningMode"]),
        "maskedApiKey": masked_secret(values["apiKey"]),
        "hasApiKey": bool(values["apiKey"]),
        "apiKeyRequired": postprocess_api_key_required(provider_id, values["baseUrl"]),
    }


def resolve_llm_settings(env_path: Path, provider_id: str | None = None) -> LlmSettings:
    """把选中（或指定）供应商的 .env 值变成一次 LLM 调用的设置。"""
    values = load_env(env_path)
    resolved = provider_id or values.get(LAST_PROVIDER_ENV_KEY, "deepseek")
    preset_by_id(resolved)  # 校验 provider 存在
    current = _provider_values(env_path, resolved)
    return LlmSettings(
        provider_id=resolved,
        api_key=current["apiKey"],
        base_url=current["baseUrl"],
        model=current["model"],
        reasoning_mode=normalize_reasoning_mode(current["reasoningMode"]),
    )


def write_settings(env_path: Path, payload: Mapping[str, Any]) -> dict[str, Any]:
    """校验并保存 AI 设置；返回保存后的读取视图（key 只以掩码回传）。"""
    provider_id = str(payload.get("providerId") or "").strip()
    preset = preset_by_id(provider_id)
    if preset.id != provider_id:
        raise ValueError("未知的 AI 供应商")
    updates: dict[str, str] = {LAST_PROVIDER_ENV_KEY: provider_id}
    prefix = preset.env_prefix

    base_url = payload.get("baseUrl")
    if base_url is not None:
        if not isinstance(base_url, str):
            raise ValueError("baseUrl 必须是字符串")
        updates[f"{prefix}_BASE_URL"] = base_url.strip()

    model = payload.get("model")
    if model is not None:
        if not isinstance(model, str):
            raise ValueError("model 必须是字符串")
        updates[f"{prefix}_MODEL"] = model.strip()

    if "reasoningMode" in payload:
        updates[f"{prefix}_REASONING_MODE"] = normalize_reasoning_mode(payload.get("reasoningMode"))

    api_key = payload.get("apiKey")
    if api_key is not None:
        if not isinstance(api_key, str):
            raise ValueError("apiKey 必须是字符串")
        trimmed = api_key.strip()
        if trimmed:
            updates[f"{prefix}_API_KEY"] = trimmed
    if payload.get("clearApiKey") is True:
        updates[f"{prefix}_API_KEY"] = ""

    save_env(env_path, updates)
    return read_settings(env_path)


def run_test_connection(
    env_path: Path,
    payload: Mapping[str, Any],
    report: Callable[[str, int | None], None],
    cancel: Callable[[], bool],
) -> dict[str, Any]:
    """测试当前（或 payload 指定）供应商的 LLM 连通性。"""
    report("connecting", 10)
    provider_id = str(payload.get("providerId") or "").strip() or None
    settings = resolve_llm_settings(env_path, provider_id)
    if not settings.model:
        raise LlmClientError("该供应商还没有配置模型，请先在设置中填写模型。")
    if not settings.api_key and postprocess_api_key_required(settings.provider_id, settings.base_url):
        raise LlmClientError("该供应商缺少 API Key，请先在设置中填写并保存。")
    report("waiting_provider", 40)
    test_llm_connection(settings)
    report("done", 100)
    return {
        "providerId": settings.provider_id,
        "model": settings.model,
        "reasoningMode": settings.reasoning_mode,
    }


def list_models(env_path: Path, provider_id: str | None = None) -> list[str]:
    """拉取供应商的可用模型列表（OpenAI 兼容 /models）。"""
    from maw.postprocess_llm import list_llm_models

    settings = resolve_llm_settings(env_path, provider_id)
    if not settings.base_url:
        raise LlmClientError("该供应商还没有配置 API URL，请先在设置中填写。")
    if not settings.api_key and postprocess_api_key_required(settings.provider_id, settings.base_url):
        raise LlmClientError("该供应商缺少 API Key，请先在设置中填写并保存。")
    return list_llm_models(settings)


# 文本任务共用 complete_subtitle_groups 的 JSON 协议：输入 cues（id+text），
# 输出 groups（source_ids→text）。前端在提交时附带选中字幕快照，回写前
# 逐条核对文本未变，避免任务期间的人工编辑被静默覆盖。
TEXT_TASK_MAX_CUES = 80
TEXT_TASK_LANGS = ("zh", "en")

# 预设系统提示词：zh/en 两套，前端按选中字幕的检测语言选择；用户在编辑器
# 里自定义的提示词整段替换预设（customPrompt）。
AI_TEXT_TASK_PROMPTS: dict[str, dict[str, str]] = {
    "ai-bold": {
        "zh": (
            "你是字幕排版助手。为下面每条字幕中最核心的关键词或短语添加「**」强调标记（Markdown 粗体）。规则：\n"
            "- 每条字幕只强调 1~2 处，不要整句加粗；\n"
            "- 保留原文语言、标点、空格，不增删任何文字；\n"
            "- 已有 **标记** 的片段保持原样，不要嵌套或重复包裹；\n"
            "- 输出 JSON：{\"groups\": [{\"source_ids\": [\"<原字幕id>\"], \"text\": \"<处理后的完整文本>\"}]}，"
            "每条字幕一个 group，source_ids 原样回传。"
        ),
        "en": (
            "You are a subtitle typesetting assistant. Add \"**\" emphasis markers (Markdown bold) around "
            "the most important keyword or phrase in each subtitle line. Rules:\n"
            "- Emphasize only 1-2 core words or phrases per line; never bold the entire line;\n"
            "- Preserve the original language, punctuation and spacing; never add or remove words;\n"
            "- Leave existing **bold** spans untouched; never nest or double-wrap;\n"
            "- Output JSON: {\"groups\": [{\"source_ids\": [\"<original cue id>\"], \"text\": \"<full processed text>\"}]} "
            "- one group per cue, echoing source_ids unchanged."
        ),
    },
    "ai-translate": {
        "zh": (
            "你是专业字幕翻译。把每条字幕翻译成自然的简体中文口语，用作双语字幕的副字幕轨。规则：\n"
            "- 译文简洁、口语化，符合中文字幕习惯，避免书面腔；\n"
            "- 保留专有名词与数字；不合并、不拆分字幕条数；\n"
            "- 输出 JSON：{\"groups\": [{\"source_ids\": [\"<原字幕id>\"], \"text\": \"<译文>\"}]}，"
            "每条字幕一个 group，source_ids 原样回传。"
        ),
        "en": (
            "You are a professional subtitle translator. Translate each subtitle into natural spoken English "
            "for a secondary subtitle track. Rules:\n"
            "- Keep the translation concise and conversational, in the style of English subtitles;\n"
            "- Preserve proper nouns and numbers; never merge or split cues;\n"
            "- Output JSON: {\"groups\": [{\"source_ids\": [\"<original cue id>\"], \"text\": \"<translation>\"}]} "
            "- one group per cue, echoing source_ids unchanged."
        ),
    },
    "ai-emoji": {
        "zh": (
            "你是字幕润色助手。给每条字幕开头添加一个贴切的 emoji 表情。规则：\n"
            "- 只在文本最前面加一个 emoji，其后接一个空格；不要在句中或句尾添加；\n"
            "- emoji 需与该句语义或情绪匹配；没有合适选择时保持原文不加；\n"
            "- 不修改原文的任何其他字符；\n"
            "- 输出 JSON：{\"groups\": [{\"source_ids\": [\"<原字幕id>\"], \"text\": \"<处理后的完整文本>\"}]}，"
            "每条字幕一个 group，source_ids 原样回传。"
        ),
        "en": (
            "You are a subtitle polishing assistant. Prepend one fitting emoji to each subtitle line. Rules:\n"
            "- Add exactly one emoji at the very start followed by a single space; never inside or at the end;\n"
            "- Match the emoji to the line's meaning or mood; leave the line unchanged if no emoji fits;\n"
            "- Do not modify any other characters;\n"
            "- Output JSON: {\"groups\": [{\"source_ids\": [\"<original cue id>\"], \"text\": \"<full processed text>\"}]} "
            "- one group per cue, echoing source_ids unchanged."
        ),
    },
    # 拆句建议：LLM 在合适断点插入恰好一个「⎪」标记；结构操作（真正拆分）
    # 仍由前端走 split 核心 API，LLM 只建议位置。
    "ai-suggest-split": {
        "zh": (
            "你是字幕断句助手。在每条字幕文本中合适的断句位置插入恰好一个「⎪」标记（U+23AA），"
            "把文本分成语气自然的两段。规则：\n"
            "- 只插入一个「⎪」，不要添加、删除或修改任何其他字符；\n"
            "- 断点优先选在标点、连词或语义停顿处；两段长度尽量均衡；\n"
            "- 已经很短（不足 6 个字）或语义不可分的字幕保持原文不加标记；\n"
            "- 输出 JSON：{\"groups\": [{\"source_ids\": [\"<原字幕id>\"], \"text\": \"<插入标记后的完整文本>\"}]}，"
            "每条字幕一个 group，source_ids 原样回传。"
        ),
        "en": (
            "You are a subtitle segmentation assistant. Insert exactly one \"⎪\" marker (U+23AA) at the most "
            "natural break point in each subtitle line, splitting it into two balanced halves. Rules:\n"
            "- Insert exactly one \"⎪\"; never add, remove or modify any other character;\n"
            "- Prefer punctuation, conjunctions or semantic pauses; keep the halves balanced;\n"
            "- Leave very short lines (fewer than 6 words) or inseparable lines unchanged;\n"
            "- Output JSON: {\"groups\": [{\"source_ids\": [\"<original cue id>\"], \"text\": \"<full text with the marker>\"}]} "
            "- one group per cue, echoing source_ids unchanged."
        ),
    },
    # 智能合并：前端先用既有合并命令同步合并，LLM 只负责修合并缝
    # （补空格/清重复标点）；parts 上下文由 runner 拼进提示词。
    "ai-smart-merge": {
        "zh": (
            "你是字幕合并助手。下面几条字幕已被合并成一条，合并文本可能缺少词间空格或在拼接处有重复标点。"
            "请输出合并后的最终文本。规则：\n"
            "- 仅在原始字幕的拼接处调整空格；句内的任何文字、空格和标点均逐字符保留；\n"
            "- 清理拼接处重复的标点或连接符；不要改动任何词语本身；\n"
            "- 保留 MASS 样式符号；无法确定拼接处时，保持合并后的文本原样；\n"
            "- 输出 JSON：{\"groups\": [{\"source_ids\": [\"<合并后字幕id>\"], \"text\": \"<最终文本>\"}]}，只输出一个 group。"
        ),
        "en": (
            "You are a subtitle merging assistant. Several subtitle lines were merged into one; the merged text "
            "may be missing inter-word spaces or have duplicated punctuation at the seams. Output the final text. Rules:\n"
            "- Adjust spacing only at the joins between original subtitles; preserve every character, space and punctuation mark inside each subtitle;\n"
            "- Clean duplicated punctuation or connectors at the seams; never change any word itself;\n"
            "- Preserve MASS style markers; if the seams are uncertain, return the merged text unchanged;\n"
            "- Output JSON: {\"groups\": [{\"source_ids\": [\"<merged cue id>\"], \"text\": \"<final text>\"}]} "
            "- exactly one group."
        ),
    },
}


def normalize_task_cues(payload_cues: object) -> list[dict[str, str]]:
    """校验并规整任务负载里的字幕快照：[{id, text}]，丢弃空文本与非法项。"""
    if not isinstance(payload_cues, list):
        raise AiTaskError("任务负载缺少字幕快照（cues）")
    cues: list[dict[str, str]] = []
    for item in payload_cues:
        if not isinstance(item, dict):
            continue
        cue_id = str(item.get("id") or "").strip()
        text = str(item.get("text") or "")
        if cue_id and text.strip():
            cues.append({"id": cue_id, "text": text})
    return cues


def collect_group_texts(response: Mapping[str, Any], cues: list[dict[str, str]]) -> dict[str, str]:
    """把 LLM groups 输出整理成 id→text；只接受单源 group，未知 id 丢弃。"""
    known_ids = {cue["id"] for cue in cues}
    texts: dict[str, str] = {}
    groups = response.get("groups")
    if not isinstance(groups, list):
        return texts
    for group in groups:
        if not isinstance(group, dict):
            continue
        source_ids = group.get("source_ids")
        text = str(group.get("text") or "")
        if not isinstance(source_ids, list) or len(source_ids) != 1 or not text.strip():
            continue
        cue_id = str(source_ids[0])
        if cue_id in known_ids:
            texts[cue_id] = text
    return texts


def run_ai_text_task(
    kind: str,
    env_path: Path,
    payload: Mapping[str, Any],
    report: Callable[[str, int | None], None],
    cancel: Callable[[], bool],
) -> dict[str, Any]:
    """加粗 / 翻译 / Emoji 三类文本任务的共用 runner。

    走 postprocess_llm.complete_subtitle_groups 的同一 JSON 协议；结果只回传
    id→text 映射，字幕结构仍由前端经既有编辑命令写回（可撤销）。
    """
    from maw.postprocess_llm import complete_subtitle_groups

    prompts = AI_TEXT_TASK_PROMPTS[kind]
    cues = normalize_task_cues(payload.get("cues"))
    if not cues:
        raise AiTaskError("没有可处理的字幕文本")
    if len(cues) > TEXT_TASK_MAX_CUES:
        raise AiTaskError(f"一次最多处理 {TEXT_TASK_MAX_CUES} 条字幕，请分批选择。")
    report("connecting", 10)
    settings = resolve_llm_settings(env_path, payload.get("providerId") or None)
    if not settings.model:
        raise LlmClientError("该供应商还没有配置模型，请先在设置中填写模型。")
    if not settings.api_key and postprocess_api_key_required(settings.provider_id, settings.base_url):
        raise LlmClientError("该供应商缺少 API Key，请先在设置中填写并保存。")
    lang = payload.get("lang")
    prompt = str(payload.get("customPrompt") or "").strip() or prompts[
        lang if lang in TEXT_TASK_LANGS else "zh"
    ]
    report("waiting_provider", 30)
    response = complete_subtitle_groups(settings, prompt, cues, is_cancelled=cancel)
    texts = collect_group_texts(response, cues)
    if not texts:
        raise LlmClientError("模型没有返回可用的逐条结果，请重试或调整提示词。")
    report("done", 100)
    return {"texts": texts}


def _merge_polish_pattern(original: str, parts: list[str]) -> str | None:
    """Only locate seams when the exact parts reproduce a uniform whitespace join.

    The frontend can also fold MASS wrappers during merging. Without its symbol
    rule and fold offsets, those seams cannot safely be reconstructed here.
    """
    if len(parts) < 2 or any(not part.strip() for part in parts):
        return None
    added = len(original) - sum(map(len, parts))
    joins = len(parts) - 1
    if added < 0 or added % joins:
        return None
    width = added // joins
    separator = original[len(parts[0]):len(parts[0]) + width]
    if (separator and not separator.isspace()) or separator.join(parts) != original:
        return None

    regions: list[tuple[int, int, str]] = []
    offset = 0
    for left, right in zip(parts, parts[1:]):
        boundary = offset + len(left)
        start = offset + len(left.rstrip())
        end = boundary + width + len(right) - len(right.lstrip())
        replacement = r"\s*"
        # MASS control characters are syntax, even when Unicode calls them
        # punctuation. Leave them byte-for-byte intact; only the core folds them.
        char = original[start - 1] if start > offset else ""
        if (
            char and end < boundary + width + len(right)
            and original[end] == char
            and unicodedata.category(char).startswith("P")
            and char not in "*_+-~/%!<>{}"
        ):
            left_count = right_count = 0
            while start > offset and original[start - 1] == char:
                start -= 1
                left_count += 1
            right_end = boundary + width + len(right)
            while end < right_end and original[end] == char:
                end += 1
                right_count += 1
            # Preserve the longer original run (e.g. an ellipsis), while allowing
            # the duplicate contributed by the other subtitle to be removed.
            minimum = max(left_count, right_count)
            maximum = left_count + right_count
            escaped = re.escape(char)
            unchanged_runs = re.escape(char * left_count) + r"\s*" + re.escape(char * right_count)
            collapsed_run = rf"\s*{escaped}{{{minimum},{maximum - 1}}}\s*"
            replacement = rf"(?:{unchanged_runs}|{collapsed_run})"
        if regions and start < regions[-1][1]:
            return None  # A punctuation-only part gives overlapping seams.
        regions.append((start, end, replacement))
        offset = boundary + width

    pattern = ""
    cursor = 0
    for start, end, replacement in regions:
        pattern += re.escape(original[cursor:start]) + replacement
        cursor = end
    return pattern + re.escape(original[cursor:])


def _merge_polish_preserves_text(original: str, result: str, parts: list[str]) -> bool:
    """Keep every character outside proven seams, including sentence spacing."""
    if result == original:
        return True
    pattern = _merge_polish_pattern(original, parts)
    return pattern is not None and re.fullmatch(pattern, result) is not None


def run_ai_smart_merge(
    env_path: Path,
    payload: Mapping[str, Any],
    report: Callable[[str, int | None], None],
    cancel: Callable[[], bool],
) -> dict[str, Any]:
    """智能合并的润色 runner：输入合并后文本与原始分句，输出缝合结果。

    合并结构操作由前端既有合并命令完成（同步、可撤销）；这里只回传
    合并缝的最终文本，前端按快照核对后写回。
    """
    from maw.postprocess_llm import complete_subtitle_groups

    merged_id = str(payload.get("mergedId") or "").strip()
    merged_text = str(payload.get("mergedText") or "")
    parts = [str(part) for part in payload.get("parts") or [] if str(part).strip()]
    if not merged_id or not merged_text.strip():
        raise AiTaskError("缺少合并后的字幕信息")
    if len(parts) < 2:
        raise AiTaskError("智能合并至少需要两条原始字幕")
    if len(parts) > TEXT_TASK_MAX_CUES:
        raise AiTaskError(f"一次最多合并 {TEXT_TASK_MAX_CUES} 条字幕。")
    report("connecting", 10)
    settings = resolve_llm_settings(env_path, payload.get("providerId") or None)
    if not settings.model:
        raise LlmClientError("该供应商还没有配置模型，请先在设置中填写模型。")
    if not settings.api_key and postprocess_api_key_required(settings.provider_id, settings.base_url):
        raise LlmClientError("该供应商缺少 API Key，请先在设置中填写并保存。")
    lang = payload.get("lang")
    base_prompt = AI_TEXT_TASK_PROMPTS["ai-smart-merge"][lang if lang in TEXT_TASK_LANGS else "zh"]
    listing = "\n".join(f"{index}. {part}" for index, part in enumerate(parts, 1))
    if lang == "en":
        context_block = f"Original subtitles in order:\n{listing}\n\nMerged text:\n{merged_text}"
    else:
        context_block = f"原始字幕依次为：\n{listing}\n\n合并后的文本：\n{merged_text}"
    prompt = f"{base_prompt}\n\n{context_block}"
    report("waiting_provider", 30)
    response = complete_subtitle_groups(
        settings, prompt, [{"id": merged_id, "text": merged_text}], is_cancelled=cancel,
    )
    texts = collect_group_texts(response, [{"id": merged_id, "text": merged_text}])
    polished = texts.get(merged_id, "")
    if not polished.strip():
        raise LlmClientError("模型没有返回合并结果，请重试。")
    if not _merge_polish_preserves_text(merged_text, polished, parts):
        raise LlmClientError("AI 合并结果无法确认仅修改了合并缝，已保留普通合并结果。")
    report("done", 100)
    return {"texts": {merged_id: polished}}


def normalize_alignment_cues(payload_cues: object) -> list[dict[str, Any]]:
    """时间码任务的字幕快照：[{id, text, start, end}]，毫秒整数。"""
    if not isinstance(payload_cues, list):
        raise AiTaskError("任务负载缺少字幕快照（cues）")
    cues: list[dict[str, Any]] = []
    for item in payload_cues:
        if not isinstance(item, dict):
            continue
        cue_id = str(item.get("id") or "").strip()
        text = str(item.get("text") or "")
        start = item.get("start")
        end = item.get("end")
        if not cue_id or not text.strip():
            continue
        if type(start) is not int or type(end) is not int or end <= start:
            raise AiTaskError(f"字幕时间范围无效：{text[:32]}")
        cues.append({"id": cue_id, "text": text, "start": start, "end": end})
    if not cues:
        raise AiTaskError("没有可对齐的字幕")
    if len(cues) > TEXT_TASK_MAX_CUES:
        raise AiTaskError(f"一次最多对齐 {TEXT_TASK_MAX_CUES} 条字幕，请分批选择。")
    return cues


def run_timecode_alignment(
    env_path: Path,
    payload: Mapping[str, Any],
    report: Callable[[str, int | None], None],
    cancel: Callable[[], bool],
) -> dict[str, Any]:
    """时间码→字词 runner：转发独立本地模型运行环境子进程执行。

    对齐依赖（torch / qwen_asr）只存在于独立运行环境，发布版编辑器
    serve 进程不引入；本函数只做临时工程准备、进度转发与结果抽取。
    mediaPath 由 serve.py 从当前工程绑定注入（不接受前端任意路径）；
    serve.py 注入的 ffmpegPath 此处不消费，运行环境自行解析 ffmpeg。
    结果按 cue id 回传 items，前端核对快照后写回。
    """
    from maw.alignment_models import QWEN_FORCED_ALIGNER_MODEL_ID, normalize_alignment_model_id
    from maw.local_runtime import LocalRuntimeCancelled, LocalRuntimeError, run_timestamp_alignment_in_runtime
    from maw.postprocess_io import import_project

    cues = normalize_alignment_cues(payload.get("cues"))
    media_path = Path(str(payload.get("mediaPath") or "").strip())
    if not media_path.is_file():
        raise AiTaskError("当前工程的媒体文件不可用，无法对齐。")
    report("loading_model", 15)
    language = str(payload.get("lang") or "")
    model_id = normalize_alignment_model_id(str(payload.get("modelId") or QWEN_FORCED_ALIGNER_MODEL_ID))
    total = len(cues)
    progress_state = {"events": 0}

    def on_event(message: str) -> None:
        progress_state["events"] += 1
        percent = 20 + int(70 * progress_state["events"] / max(1, total))
        report(f"对齐中 {min(progress_state['events'], total)}/{total}", percent)

    items_by_id: dict[str, list[dict[str, Any]]] = {}
    warnings: list[str] = []
    aligned = failed = 0
    try:
        # 经 import_project 迁移为 v2 形状再落盘：cue id 原样保留，语言写进
        # 主轨（v2 工程顶层没有 language 字段，worker 只认轨上的语言）。
        # 校验失败是 ValueError 家族，统一映射为带前缀的 AiTaskError。
        project = import_project({"segments": [dict(cue) for cue in cues], "language": language})
        for track in project.get("tracks", []):
            if track.get("role") == "main":
                track["language"] = language
                break
        with tempfile.TemporaryDirectory(prefix="maw-editor-align-") as temp_dir:
            project_path = Path(temp_dir) / "alignment-input.mosp"
            project_path.write_text(json.dumps(project, ensure_ascii=False), encoding="utf-8")
            worker_result = run_timestamp_alignment_in_runtime(
                project_path=project_path,
                media_path=media_path,
                model_id=model_id,
                output_mode="json",
                alignment_mode="fill",
                on_event=on_event,
                cancel_event=_CancelProbe(cancel),
            )
            artifact = worker_result.get("artifact") if isinstance(worker_result, Mapping) else None
            worker_report = worker_result.get("report") if isinstance(worker_result, Mapping) else None
            if not isinstance(artifact, Mapping):
                raise AiTaskError("时间码对齐失败：运行环境没有返回结果文件。")
            if isinstance(worker_report, Mapping):
                aligned = int(worker_report.get("alignedSegments") or 0)
                failed = int(worker_report.get("failedSegments") or 0)
                raw_warnings = worker_report.get("warnings")
                if isinstance(raw_warnings, list):
                    warnings = [str(item) for item in raw_warnings]
            output_path = Path(str(artifact.get("projectPath") or ""))
            if not output_path.is_file():
                raise AiTaskError("时间码对齐失败：运行环境没有生成对齐后的工程文件。")
            output_project = json.loads(output_path.read_text(encoding="utf-8"))
            if not isinstance(output_project, dict):
                raise AiTaskError("时间码对齐失败：结果工程形状异常。")
            segments: list[Any] = []
            for track in output_project.get("tracks", []):
                if not isinstance(track, dict) or track.get("role") != "main":
                    continue
                segments = track.get("segments") or []
                break
            for segment in segments:
                if not isinstance(segment, Mapping):
                    continue
                cue_id = str(segment.get("id") or "")
                items = segment.get("items")
                if not cue_id or not isinstance(items, list) or not items:
                    continue
                items_by_id[cue_id] = [
                    {"text": str(item.get("text")), "start": int(item.get("start")), "end": int(item.get("end"))}
                    for item in items
                    if isinstance(item, dict) and item.get("text") and type(item.get("start")) is int
                ]
    except LocalRuntimeCancelled as error:
        raise AiTaskError(f"时间码对齐已取消：{error}") from error
    except (LocalRuntimeError, ValueError, OSError) as error:
        raise AiTaskError(f"时间码对齐失败：{error}") from error
    if not items_by_id:
        summary = "；".join(warnings[:3]) or "没有字幕成功对齐"
        raise AiTaskError(f"时间码对齐失败：{summary}")
    report("done", 100)
    return {
        "items": items_by_id,
        "aligned": aligned,
        "failed": failed,
        "warnings": warnings[:5],
    }


class _CancelProbe:
    """run_timestamp_alignment_in_runtime(cancel_event) 需要有 is_set() 的取消事件。"""

    def __init__(self, is_cancelled: Callable[[], bool]) -> None:
        self._is_cancelled = is_cancelled

    def is_set(self) -> bool:
        return bool(self._is_cancelled())


TASK_RUNNERS: dict[str, TaskRunner] = {
    "test-connection": run_test_connection,
    "ai-bold": lambda env_path, payload, report, cancel: run_ai_text_task(
        "ai-bold", env_path, payload, report, cancel),
    "ai-translate": lambda env_path, payload, report, cancel: run_ai_text_task(
        "ai-translate", env_path, payload, report, cancel),
    "ai-emoji": lambda env_path, payload, report, cancel: run_ai_text_task(
        "ai-emoji", env_path, payload, report, cancel),
    "ai-suggest-split": lambda env_path, payload, report, cancel: run_ai_text_task(
        "ai-suggest-split", env_path, payload, report, cancel),
    "ai-smart-merge": run_ai_smart_merge,
    "ai-timecode-items": run_timecode_alignment,
}


class AiTaskError(RuntimeError):
    """任务提交或执行的本地错误；message 面向编辑器提示展示。"""


@dataclass
class AiTask:
    id: str
    kind: str
    status: str
    stage: str = ""
    percent: int = 0
    result: dict[str, Any] | None = None
    error: str = ""
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    # payload 只在工作线程使用，不进 snapshot：避免把请求原文（可能含
    # 临时字段）回传给轮询接口。
    payload: dict[str, Any] = field(default_factory=dict)

    def snapshot(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind,
            "status": self.status,
            "stage": self.stage,
            "percent": self.percent,
            "result": self.result,
            "error": self.error,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }


class AiTaskManager:
    """单工作线程后台任务注册表。

    submit 立即返回任务快照；runner 在工作线程里执行，进度经 report 写回，
    前端轮询 snapshot 拿状态。done/error/cancelled 的任务保留在历史里供
    查询，超过保留量或 TTL 后修剪。
    """

    def __init__(
        self,
        env_path: Path,
        *,
        runners: Mapping[str, TaskRunner] | None = None,
        history_limit: int = MAX_TASK_HISTORY,
        ttl_seconds: float = TASK_TTL_SECONDS,
    ) -> None:
        self.env_path = env_path
        self.runners = dict(runners if runners is not None else TASK_RUNNERS)
        self.history_limit = history_limit
        self.ttl_seconds = ttl_seconds
        self._lock = threading.Lock()
        self._tasks: dict[str, AiTask] = {}
        self._order: list[str] = []
        self._cancel_events: dict[str, threading.Event] = {}
        self._wake = threading.Event()
        self._queue: list[str] = []
        self._worker = threading.Thread(target=self._work, name="maw-editor-ai", daemon=True)
        self._worker.start()

    def submit(self, kind: str, payload: Mapping[str, Any] | None = None) -> dict[str, Any]:
        runner = self.runners.get(kind)
        if runner is None:
            raise AiTaskError(f"未知的 AI 任务类型：{kind}")
        task = AiTask(id=uuid.uuid4().hex, kind=kind, status=TASK_STATUS_QUEUED, payload=dict(payload or {}))
        event = threading.Event()
        with self._lock:
            self._prune()
            self._tasks[task.id] = task
            self._order.append(task.id)
            self._cancel_events[task.id] = event
            self._queue.append(task.id)
        self._wake.set()
        return task.snapshot()

    def snapshot(self, task_id: str | None = None) -> dict[str, Any]:
        with self._lock:
            self._prune()
            if task_id is not None:
                task = self._tasks.get(task_id)
                if task is None:
                    raise AiTaskError("AI 任务不存在或已过期")
                return task.snapshot()
            return {
                "ok": True,
                "tasks": [self._tasks[task_id].snapshot() for task_id in self._order if task_id in self._tasks],
            }

    def cancel(self, task_id: str) -> bool:
        with self._lock:
            event = self._cancel_events.get(task_id)
            task = self._tasks.get(task_id)
            if event is None or task is None:
                return False
            if task.status in {TASK_STATUS_DONE, TASK_STATUS_ERROR, TASK_STATUS_CANCELLED}:
                return False
            event.set()
            task.status = TASK_STATUS_CANCELLED
            task.stage = "cancelled"
            task.updated_at = time.time()
            return True

    def _prune(self) -> None:
        now = time.time()
        alive: list[str] = []
        for task_id in self._order:
            task = self._tasks.get(task_id)
            if task is None:
                continue
            finished = task.status in {TASK_STATUS_DONE, TASK_STATUS_ERROR, TASK_STATUS_CANCELLED}
            if finished and now - task.updated_at > self.ttl_seconds:
                self._tasks.pop(task_id, None)
                self._cancel_events.pop(task_id, None)
                continue
            alive.append(task_id)
        overflow = len(alive) - self.history_limit
        if overflow > 0:
            for task_id in alive[:overflow]:
                task = self._tasks.get(task_id)
                if task is not None and task.status not in {TASK_STATUS_QUEUED, TASK_STATUS_RUNNING, TASK_STATUS_DELTA}:
                    self._tasks.pop(task_id, None)
                    self._cancel_events.pop(task_id, None)
            alive = [task_id for task_id in alive if task_id in self._tasks]
        self._order = alive

    def _work(self) -> None:
        while True:
            self._wake.wait()
            while True:
                with self._lock:
                    task_id = self._queue.pop(0) if self._queue else None
                    if task_id is None:
                        self._wake.clear()
                        if self._queue:
                            # clear 与 submit 竞争时可能丢唤醒：清空后立即复查。
                            continue
                if task_id is None:
                    break
                self._run_one(task_id)

    def _run_one(self, task_id: str) -> None:
        with self._lock:
            task = self._tasks.get(task_id)
            event = self._cancel_events.get(task_id)
            runner = self.runners.get(task.kind) if task else None
        if task is None or event is None or runner is None:
            return
        if event.is_set():
            return
        with self._lock:
            task.status = TASK_STATUS_RUNNING
            task.stage = "starting"
            task.updated_at = time.time()

        def report(stage: str, percent: int | None = None) -> None:
            with self._lock:
                if task.status == TASK_STATUS_CANCELLED:
                    return
                task.status = TASK_STATUS_RUNNING
                task.stage = stage
                if percent is not None:
                    task.percent = max(0, min(100, int(percent)))
                task.updated_at = time.time()

        try:
            result = runner(self.env_path, task.payload, report, event.is_set)
        except LlmClientError as error:
            with self._lock:
                if task.status != TASK_STATUS_CANCELLED:
                    task.status = TASK_STATUS_ERROR
                    task.error = str(error)
                    task.updated_at = time.time()
            return
        except Exception as error:  # noqa: BLE001 - 后台任务把一切失败转成 error 态
            with self._lock:
                if task.status != TASK_STATUS_CANCELLED:
                    task.status = TASK_STATUS_ERROR
                    task.error = f"{type(error).__name__}: {error}"
                    task.updated_at = time.time()
            return
        if event.is_set():
            return
        with self._lock:
            task.status = TASK_STATUS_DONE
            task.stage = "done"
            task.percent = 100
            task.result = result
            task.updated_at = time.time()
            self._prune()

    # 测试辅助：等待队列排空。
    def wait_until_idle(self, timeout: float = 10.0) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self._lock:
                if not self._queue and all(
                    task.status not in {TASK_STATUS_QUEUED, TASK_STATUS_RUNNING, TASK_STATUS_DELTA}
                    for task in self._tasks.values()
                ):
                    return True
            time.sleep(0.01)
        return False
