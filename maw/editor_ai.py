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


TASK_RUNNERS: dict[str, TaskRunner] = {
    "test-connection": run_test_connection,
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
