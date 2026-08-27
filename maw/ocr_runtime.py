"""User-managed optional runtime for the Launcher OCR feature.

OCR is intentionally kept out of the regular MAW package.  The Launcher can
install this small CPU runtime on demand, while the frozen application only
ships the pure-Python worker and its data files.
"""

from __future__ import annotations

import json
import os
import queue
import shutil
import subprocess
import sys
import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from threading import Event
from typing import Final, TextIO

from maw.gui_platform import (
    asset_path,
    popen_process_tree,
    process_group_kwargs,
    release_process_tree,
    terminate_process_tree,
)
from maw.local_runtime import (
    _extract_embed_python,
    _find_bootstrap_asset,
    _get_pip_command,
    _pip_install_command,
    _requirement_package_names,
)
from maw.runtime_manifest import (
    STATUS_INSTALLING,
    STATUS_READY,
    read_runtime_manifest,
    write_runtime_manifest,
)
from maw.runtime_mirror_picker import pick_fastest_mirror
from maw.postprocess_ocr import OcrDedupRequest


OCR_RUNTIME_VERSION: Final = "3"
OCR_PYTHON_VERSION: Final = "3.11"
OCR_MODEL_ID: Final = "pp-ocrv6-tiny"
OCR_MODEL_LABEL: Final = "PP-OCRv6 tiny（CPU）"
OCR_SMALL_MODEL_ID: Final = "pp-ocrv6-small"
OCR_SMALL_MODEL_LABEL: Final = "PP-OCRv6 small（CPU）"
OCR_MODEL_IDS: Final[tuple[str, ...]] = (OCR_MODEL_ID, OCR_SMALL_MODEL_ID)
OCR_MODEL_TYPES: Final[dict[str, str]] = {
    OCR_MODEL_ID: "tiny",
    OCR_SMALL_MODEL_ID: "small",
}
OCR_MODEL_LABELS: Final[dict[str, str]] = {
    OCR_MODEL_ID: OCR_MODEL_LABEL,
    OCR_SMALL_MODEL_ID: OCR_SMALL_MODEL_LABEL,
}
# OCR 依赖清单由 pyproject ocr extra 经 CI uv export 冻结（build/requirements-ocr.txt），
# frozen 后随包分发于 asset_path("ocr-runtime/requirements-ocr.txt")。


RuntimeEvent = Callable[[str, int, str], None]
RuntimeLine = Callable[[str], None]
OcrStatus = Callable[[str, Mapping[str, int]], None]


class OcrRuntimeError(RuntimeError):
    """Raised when the managed OCR runtime cannot be installed or used."""


class OcrRuntimeCancelled(OcrRuntimeError):
    """Raised when the user cancels OCR runtime work."""


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
    """Resolve the settings value, process override, or default app-data path."""

    override = str(configured or "").strip() or os.environ.get("MAW_OCR_RUNTIME_ROOT", "").strip()
    if override:
        return Path(override).expanduser().resolve(strict=False)
    return _default_app_data_root() / "ocr-runtime"


def ocr_runtime_python_path(root: str | Path | None = None) -> Path:
    target = resolve_ocr_runtime_root(root)
    relative = Path("python") / "python.exe" if os.name == "nt" else Path("python") / "bin" / "python"
    return target / relative


def managed_ocr_runtime_status(root: str | Path | None = None) -> OcrRuntimeStatus:
    target = resolve_ocr_runtime_root(root)
    python = ocr_runtime_python_path(target)
    if not target.exists():
        return OcrRuntimeStatus("missing", False, str(target), "", "OCR 支持尚未安装。")
    if not target.is_dir() or not python.exists():
        return OcrRuntimeStatus(
            "broken",
            False,
            str(target),
            str(python),
            "OCR 运行环境不完整，请点击“修复 OCR 支持”。",
        )
    manifest = read_runtime_manifest(target)
    if manifest.installing:
        return OcrRuntimeStatus(
            "installing",
            False,
            str(target),
            str(python),
            "OCR 运行环境正在安装中，请稍候。",
            manifest.runtime_version or OCR_RUNTIME_VERSION,
        )
    if not manifest.is_ready_for(OCR_RUNTIME_VERSION):
        return OcrRuntimeStatus(
            "broken",
            False,
            str(target),
            str(python),
            "OCR 运行环境需要修复，请点击“修复 OCR 支持”。",
            manifest.runtime_version or OCR_RUNTIME_VERSION,
        )
    if not _ocr_package_dirs_present(target):
        return OcrRuntimeStatus(
            "broken",
            False,
            str(target),
            str(python),
            "OCR 运行环境依赖不完整，请点击“修复 OCR 支持”。",
        )
    return OcrRuntimeStatus(
        "ready",
        True,
        str(target),
        str(python),
        "OCR 模型已安装，可以在工具箱中使用。",
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


def install_ocr_runtime(
    *,
    on_event: RuntimeEvent | None = None,
    cancel_event: Event | None = None,
    repair: bool = False,
    runtime_root: str | Path | None = None,
) -> OcrRuntimeStatus:
    """Create or repair the optional OCR environment and verify its packages."""

    emit = on_event or (lambda _message, _percent, _stage: None)
    cancel = cancel_event or Event()
    root = resolve_ocr_runtime_root(runtime_root)
    if root.exists() and not root.is_dir():
        raise OcrRuntimeError(f"OCR 运行环境路径不能是一个文件：{root}")
    root.parent.mkdir(parents=True, exist_ok=True)

    embed_zip = _find_bootstrap_asset("python-3.11.9-embed-amd64.zip")
    get_pip = _find_bootstrap_asset("get-pip.py")
    if embed_zip is None or get_pip is None:
        raise OcrRuntimeError(
            "未找到 OCR 运行环境安装资产（embedded Python 或 get-pip.py）。"
            "请使用官方打包版。"
        )

    current = managed_ocr_runtime_status(root)
    if current.ready and not repair:
        emit("OCR 支持已经安装完成。", 100, "ready")
        return current
    _check_cancel(cancel)
    python = ocr_runtime_python_path(root)
    if root.exists() and not python.exists() and any(root.iterdir()):
        raise OcrRuntimeError("OCR 运行环境目录已存在但不完整，请更换路径或手动清理后重试。")
    # 安装开始即写入 installing 状态，避免安装过程中被判定为"需要修复"。
    write_runtime_manifest(root, status=STATUS_INSTALLING, runtime_version=OCR_RUNTIME_VERSION, python_version=OCR_PYTHON_VERSION)

    emit("正在解压嵌入式 OCR Python 运行环境……", 5, "bootstrap")
    python_dir = root / "python"
    if repair or not python.exists():
        if python_dir.exists():
            shutil.rmtree(python_dir)
        _extract_embed_python(embed_zip, python_dir)
    _check_cancel(cancel)
    if not python.exists():
        raise OcrRuntimeError(f"OCR Python 运行环境解压失败：未找到 {python}")

    emit("正在安装 pip……", 12, "bootstrap")
    _run_process(
        _get_pip_command(python, get_pip),
        env=_runtime_env(root),
        cancel=cancel,
        on_line=_bootstrap_line(emit, 15, "bootstrap"),
        cwd=_runtime_bundle_root(),
    )
    _check_cancel(cancel)

    emit("正在安装 OCR 模型和依赖……", 25, "dependencies")
    requirements_file = _ocr_requirements_path()
    site_packages = root / "site-packages"
    install_args = _pip_install_command(
        python, site_packages, requirements_file,
        index_url=pick_fastest_mirror(),
    )
    _run_process(
        install_args,
        env=_runtime_env(root),
        cancel=cancel,
        on_line=_dependency_line(emit, requirements_file),
        cwd=_runtime_bundle_root(),
    )
    _check_cancel(cancel)

    emit("正在验证 OCR 模型运行时……", 90, "verify")
    verify_args = [
        str(python),
        "-c",
        "from rapidocr import RapidOCR; import numpy, onnxruntime; from PIL import Image; print('MAW_OCR_RUNTIME_READY')",
    ]
    _run_process(
        verify_args,
        env=_runtime_env(root),
        cancel=cancel,
        on_line=lambda line: emit(line, 94, "verify"),
        cwd=_runtime_bundle_root(),
    )
    _check_cancel(cancel)
    write_runtime_manifest(
        root,
        status=STATUS_READY,
        runtime_version=OCR_RUNTIME_VERSION,
        python_version=OCR_PYTHON_VERSION,
        extra={"modelId": OCR_MODEL_ID},
    )
    emit("OCR 支持安装完成，现在可以在工具箱中选择 OCR 模型。", 100, "ready")
    return managed_ocr_runtime_status(root)


def run_ocr_in_runtime(
    request: OcrDedupRequest,
    *,
    ffmpeg_path: Path,
    runtime_root: str | Path | None = None,
    model_id: str = OCR_MODEL_ID,
    on_status: OcrStatus | None = None,
    cancel_event: Event | None = None,
) -> dict[str, object]:
    """Run the OCR worker in the managed environment and return its artifact."""

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


def _default_app_data_root() -> Path:
    override = os.environ.get("MAW_APP_DATA_ROOT", "").strip()
    if override:
        return Path(override).expanduser().resolve(strict=False)
    if os.name == "nt":
        return Path(os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local")) / "MAW"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "MAW"
    return Path(os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share")) / "MAW"


def _runtime_env(runtime_root: Path | None = None) -> dict[str, str]:
    env = dict(os.environ)
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
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


def _ocr_requirements_path() -> Path:
    """Resolve the frozen requirements.txt for the managed OCR runtime."""
    if getattr(sys, "frozen", False):
        path = asset_path("ocr-runtime/requirements-ocr.txt")
    else:
        path = Path(__file__).resolve().parents[1] / "build" / "requirements-ocr.txt"
    if not path.is_file():
        raise OcrRuntimeError(
            "OCR 运行环境依赖清单缺失：" + str(path) + "。"
            "打包版应随包分发；源码运行请先运行 "
            "uv export --frozen --extra ocr --no-dev --format requirements-txt -o build/requirements-ocr.txt"
        )
    return path


def _bootstrap_line(emit: RuntimeEvent, percent: int, stage: str) -> RuntimeLine:
    def report(line: str) -> None:
        text = line.strip()
        if text:
            emit(text, percent, stage)

    return report


def _dependency_line(emit: RuntimeEvent, requirements_file: Path) -> RuntimeLine:
    markers = _requirement_package_names(requirements_file)
    seen: set[str] = set()

    def report(line: str) -> None:
        text = line.strip()
        if not text:
            return
        folded = text.casefold()
        seen.update(marker for marker in markers if marker in folded)
        emit(text, min(85, 30 + len(seen) * 12), "dependencies")

    return report


def _run_process(
    command: list[str],
    *,
    env: Mapping[str, str],
    cancel: Event,
    on_line: RuntimeLine,
    cwd: Path,
) -> int:
    try:
        process = popen_process_tree(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=dict(env),
            cwd=str(cwd),
            **process_group_kwargs(),
        )
    except OSError as error:
        raise OcrRuntimeError(f"无法启动 OCR 运行环境命令：{error}") from error

    output: list[str] = []
    lines: queue.Queue[str | None] = queue.Queue()
    reader = threading.Thread(
        target=_read_process_lines,
        args=(process.stdout, lines),
        name="maw-ocr-runtime-output",
        daemon=True,
    )
    reader.start()
    while True:
        if cancel.is_set():
            terminate_process_tree(process)
            raise OcrRuntimeCancelled("OCR 运行环境操作已取消。")
        try:
            raw_line = lines.get(timeout=0.1)
        except queue.Empty:
            if process.poll() is not None and not reader.is_alive():
                break
            continue
        if raw_line is None:
            break
        line = raw_line.rstrip("\r\n")
        if line:
            output.append(line)
            on_line(line)
    return_code = process.wait()
    release_process_tree(process)
    if return_code != 0:
        for line in reversed(output):
            try:
                message = json.loads(line)
            except ValueError:
                continue
            if isinstance(message, Mapping) and message.get("type") == "error":
                raise OcrRuntimeError(str(message.get("detail") or "OCR worker 运行失败"))
        detail = "\n".join(output[-8:])
        raise OcrRuntimeError(f"OCR 运行环境命令失败（退出码 {return_code}）。{detail}")
    return return_code


def _read_process_lines(stdout: TextIO | None, lines: queue.Queue[str | None]) -> None:
    try:
        if stdout is not None:
            for line in stdout:
                lines.put(line)
    finally:
        lines.put(None)


def _check_cancel(cancel: Event) -> None:
    if cancel.is_set():
        raise OcrRuntimeCancelled("OCR 运行环境操作已取消。")


def _ocr_package_dirs_present(root: Path) -> bool:
    site_packages = root / "site-packages"
    return all((site_packages / name).exists() for name in ("numpy", "onnxruntime", "PIL", "rapidocr"))


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
