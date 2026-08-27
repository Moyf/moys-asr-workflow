"""User-managed optional runtime for the Launcher OCR feature — thin shim.

OCR 运行时的安装 / 状态 / 路径 / 依赖生命周期已与 local runtime 统一到
``maw.runtimes``（``maw/runtimes/base.py`` + 本 Runtime 规格
``maw/runtimes/ocr_spec.py``）。本模块保留 GUI / 打包契约所需的外部函数
签名、常量与状态类型并委托 ``maw.runtimes.OCR``；``run_ocr_in_runtime``
与模型 payload 助手不在 Runtime 生命周期抽象范围内，维持原实现。
"""

from __future__ import annotations

import json
import os
import sys
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from threading import Event

from maw.console import configure_utf8_environment
from maw.gui_platform import asset_path
from maw.postprocess_ocr import OcrDedupRequest
from maw.runtimes import OCR
from maw.runtimes.base import (
    RuntimeEvent,
    RuntimeStatus,
    _run_process,
)
from maw.runtimes.ocr_spec import (
    OCR_MODEL_ID,
    OCR_MODEL_LABEL,
    OCR_MODEL_IDS,
    OCR_MODEL_LABELS,
    OCR_MODEL_TYPES,
    OCR_RUNTIME_VERSION,
    OCR_SMALL_MODEL_ID,
    OCR_SMALL_MODEL_LABEL,
    OcrRuntimeCancelled,
    OcrRuntimeError,
)

__all__ = [
    "OCR_MODEL_ID",
    "OCR_MODEL_LABEL",
    "OCR_MODEL_IDS",
    "OCR_MODEL_TYPES",
    "OCR_SMALL_MODEL_ID",
    "OCR_SMALL_MODEL_LABEL",
    "OCR_RUNTIME_VERSION",
    "OcrRuntimeCancelled",
    "OcrRuntimeError",
    "OcrRuntimeStatus",
    "install_ocr_runtime",
    "managed_ocr_runtime_status",
    "ocr_model_payload",
    "ocr_model_type",
    "ocr_models_payload",
    "ocr_runtime_python_path",
    "resolve_ocr_runtime_root",
    "run_ocr_in_runtime",
]

OcrStatus = Callable[[str, Mapping[str, int]], None]


@dataclass(frozen=True, slots=True)
class OcrRuntimeStatus:
    status: str
    ready: bool
    path: str
    python_path: str
    detail: str
    runtime_version: str = OCR_RUNTIME_VERSION
    model_id: str = OCR_MODEL_ID
    model_label: str = OCR_MODEL_LABEL

    def to_payload(self) -> dict[str, object]:
        return {
            "status": self.status,
            "ready": self.ready,
            "path": self.path,
            "pythonPath": self.python_path,
            "detail": self.detail,
            "runtimeVersion": self.runtime_version,
            "modelId": self.model_id,
            "modelLabel": self.model_label,
            "modelInstalled": self.ready,
            "modelPath": self.path,
        }


def resolve_ocr_runtime_root(configured: str | Path | None = None) -> Path:
    """设置值 / 进程覆盖（「MAW_OCR_RUNTIME_ROOT」）/ 默认 app-data 路径。"""
    return OCR.resolve_root(configured)


def ocr_runtime_python_path(root: str | Path | None = None) -> Path:
    target = resolve_ocr_runtime_root(root)
    return OCR.python_path(target)


def managed_ocr_runtime_status(root: str | Path | None = None) -> OcrRuntimeStatus:
    """委托 ``maw.runtimes.OCR.status`` 并转换为旧契约状态类型。"""
    return _from_runtime_status(OCR.status(runtime_root=root))


def install_ocr_runtime(
    *,
    on_event: RuntimeEvent | None = None,
    cancel_event: Event | None = None,
    repair: bool = False,
    runtime_root: str | Path | None = None,
) -> OcrRuntimeStatus:
    """委托 ``maw.runtimes.OCR.install``（完整生命周期在 base）。"""
    return _from_runtime_status(
        OCR.install(
            on_event=on_event,
            cancel_event=cancel_event,
            repair=repair,
            runtime_root=runtime_root,
        )
    )


def ocr_model_type(model_id: str) -> str:
    try:
        return OCR_MODEL_TYPES[model_id]
    except KeyError as error:
        raise ValueError(f"不支持的 OCR 模型：{model_id}") from error


def ocr_model_payload(status: OcrRuntimeStatus, model_id: str | None = None) -> dict[str, object]:
    selected_model_id = model_id or status.model_id
    model_type = ocr_model_type(selected_model_id)
    return {
        "id": selected_model_id,
        "label": OCR_MODEL_LABELS[selected_model_id],
        "modelType": model_type,
        "status": "installed" if status.ready else status.status,
        "installed": status.ready,
        "path": status.path,
        "detail": status.detail,
    }


def ocr_models_payload(status: OcrRuntimeStatus) -> list[dict[str, object]]:
    return [ocr_model_payload(status, model_id) for model_id in OCR_MODEL_IDS]


def run_ocr_in_runtime(
    request: OcrDedupRequest,
    *,
    ffmpeg_path: Path,
    runtime_root: str | Path | None = None,
    model_id: str = OCR_MODEL_ID,
    on_status: OcrStatus | None = None,
    cancel_event: Event | None = None,
) -> dict[str, object]:
    """在托管环境里跑 OCR worker 并返回其产物。"""
    _ = ocr_model_type(model_id)
    status = managed_ocr_runtime_status(runtime_root)
    if not status.ready:
        raise OcrRuntimeError("OCR 模型尚未安装，请先打开设置下载安装 OCR 支持。")
    worker = _runtime_bundle_path("ocr-runtime/maw/ocr_runtime_worker.py")
    if not worker.is_file():
        raise OcrRuntimeError(f"OCR 运行时助手缺失：{worker}")
    command = [
        status.python_path,
        str(worker),
        "run",
        "--model-id",
        model_id,
        "--output-mode",
        request.output_mode.value,
        "--ffmpeg-path",
        str(ffmpeg_path),
        "--region-mode",
        request.region.mode,
        "--region-x1",
        str(request.region.x1),
        "--region-y1",
        str(request.region.y1),
        "--region-x2",
        str(request.region.x2),
        "--region-y2",
        str(request.region.y2),
        "--threshold",
        str(request.threshold),
    ]
    _append_path(command, "--project-path", request.project_path)
    _append_path(command, "--srt-path", request.srt_path)
    _append_path(command, "--video-path", request.video_path)
    _append_path(command, "--fallback-video-path", request.fallback_video_path)
    _append_path(command, "--media-path", request.media_path)
    _append_path(command, "--output-directory", request.output_directory)
    if request.report:
        command.append("--report")

    result: dict[str, object] = {}
    worker_error = ""

    def handle_line(line: str) -> None:
        nonlocal worker_error
        try:
            message = json.loads(line)
        except ValueError:
            return
        if not isinstance(message, Mapping):
            return
        message_type = message.get("type")
        if message_type == "status":
            key = str(message.get("key") or "toolbox_status_ocr_frame")
            details = message.get("details")
            if on_status is not None:
                on_status(key, details if isinstance(details, Mapping) else {})
        elif message_type == "result":
            result.update({str(key): value for key, value in message.items() if key != "type"})
        elif message_type == "error":
            worker_error = str(message.get("detail") or "OCR worker 运行失败")

    _run_process(
        command,
        env=_runtime_env(resolve_ocr_runtime_root(runtime_root)),
        cancel=cancel_event or Event(),
        on_line=handle_line,
        cwd=worker.parent.parent,
    )
    if worker_error:
        raise OcrRuntimeError(worker_error)
    if not result:
        raise OcrRuntimeError("OCR worker 没有返回处理结果。")
    return result


def _append_path(command: list[str], flag: str, value: Path | None) -> None:
    if value is not None and str(value).strip():
        command.extend([flag, str(value)])


def _runtime_env(runtime_root: Path | None = None) -> dict[str, str]:
    env = dict(os.environ)
    env["PYTHONUNBUFFERED"] = "1"
    configure_utf8_environment(env)
    env["PYTHONNOUSERSITE"] = "1"
    if runtime_root is not None:
        site_packages = runtime_root / "site-packages"
        env["PYTHONPATH"] = str(site_packages)
    return env


def _runtime_bundle_root() -> Path:
    if getattr(sys, "frozen", False):
        return asset_path("ocr-runtime")
    return Path(__file__).resolve().parents[1]


def _runtime_bundle_path(relative: str) -> Path:
    if getattr(sys, "frozen", False):
        return asset_path(relative)
    if relative == "ocr-runtime/maw/ocr_runtime_worker.py":
        return Path(__file__).with_name("ocr_runtime_worker.py")
    return _runtime_bundle_root() / relative


def _from_runtime_status(status: RuntimeStatus) -> OcrRuntimeStatus:
    return OcrRuntimeStatus(
        status=status.status,
        ready=status.ready,
        path=status.path,
        python_path=status.python_path,
        detail=status.detail,
        runtime_version=status.runtime_version,
        model_id=status.model_id or OCR_MODEL_ID,
        model_label=status.model_label or OCR_MODEL_LABEL,
    )