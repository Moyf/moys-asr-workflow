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

import os
import threading
import time
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
    preset = preset_by_id(resolved)
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
    file_values = load_env(env_path)

    base_url = payload.get("baseUrl")
    if base_url is not None:
        if not isinstance(base_url, str):
            raise ValueError("baseUrl 必须是字符串")
        updates[f"{prefix}_BASE_URL"] = base_url.strip()
    effective_base_url = updates.get(f"{prefix}_BASE_URL", file_values.get(f"{prefix}_BASE_URL", "")) or preset.base_url

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
        text = str(group.get("text") or "").strip()
        if not isinstance(source_ids, list) or len(source_ids) != 1 or not text:
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


TASK_RUNNERS: dict[str, TaskRunner] = {
    "test-connection": run_test_connection,
    "ai-bold": lambda env_path, payload, report, cancel: run_ai_text_task(
        "ai-bold", env_path, payload, report, cancel),
    "ai-translate": lambda env_path, payload, report, cancel: run_ai_text_task(
        "ai-translate", env_path, payload, report, cancel),
    "ai-emoji": lambda env_path, payload, report, cancel: run_ai_text_task(
        "ai-emoji", env_path, payload, report, cancel),
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
