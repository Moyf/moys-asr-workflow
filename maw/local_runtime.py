"""User-managed runtime for the Launcher local ASR feature — thin shim.

安装 / 状态 / 路径 / 依赖 / 镜像选择已抽象到 ``maw.runtimes``（``RuntimeSpec``
+ ``ManagedRuntime``，见 ``maw/runtimes/base.py`` 与本 Runtime 的规格
``maw/runtimes/local_spec.py``）。本模块保留 GUI / CLI / 打包契约所需的外部
函数签名、常量与状态类型，内部全部委托 ``maw.runtimes.LOCAL``；另保留
``prepare_model_in_*`` 与少量下划线助手（worker 命令构造、进程环境），它们
不在 Runtime 生命周期抽象范围内。
"""

from __future__ import annotations

import os
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from threading import Event

from maw.runtimes import LOCAL
from maw.runtimes.base import (
    RuntimeEvent,
    RuntimeStatus,
    # 兼容 re-export：旧代码与打包脚本按模块属性引用这些内部助手。
    _extract_embed_python,  # noqa: F401
    _find_bootstrap_asset,  # noqa: F401
    _get_pip_command,  # noqa: F401
    _has_cuda,  # noqa: F401
    _pip_install_command,  # noqa: F401
    _requirement_package_names,  # noqa: F401
    _run_process,
    default_app_data_root,
    default_model_cache_root,
    model_cache_environment,
    resolve_model_cache_root,
)
from maw.runtimes.local_spec import (
    EMBED_PYTHON_ZIP,
    PYTORCH_INDEX,
    PYTHON_VERSION,
    RUNTIME_VERSION,
    LocalRuntimeCancelled,
    LocalRuntimeError,
)

__all__ = [
    "EMBED_PYTHON_ZIP",
    "PYTORCH_INDEX",
    "PYTHON_VERSION",
    "RUNTIME_VERSION",
    "LocalRuntimeCancelled",
    "LocalRuntimeError",
    "LocalRuntimeStatus",
    "default_app_data_root",
    "default_model_cache_root",
    "default_runtime_root",
    "install_local_runtime",
    "managed_runtime_python",
    "managed_runtime_status",
    "model_cache_environment",
    "resolve_model_cache_root",
    "prepare_model_in_process",
    "prepare_model_in_runtime",
    "runtime_python_path",
]


@dataclass(frozen=True, slots=True)
class LocalRuntimeStatus:
    status: str
    ready: bool
    path: str
    python_path: str
    model_cache_path: str
    detail: str
    runtime_version: str = RUNTIME_VERSION

    def to_payload(self) -> dict[str, object]:
        return {
            "status": self.status,
            "ready": self.ready,
            "path": self.path,
            "pythonPath": self.python_path,
            "modelCachePath": self.model_cache_path,
            "detail": self.detail,
            "runtimeVersion": self.runtime_version,
        }


def _is_moss_engine(engine: str) -> bool:
    return engine.strip().casefold() == "moss"


def _moss_runtime():
    """Lazily import ``maw.moss_runtime`` at call time.

    ``maw.moss_runtime`` imports this module's shared helpers at module level,
    so importing it here at load time would create a circular import.
    """

    from maw import moss_runtime  # noqa: F401

    return moss_runtime


def default_runtime_root(engine: str = "") -> Path:
    """兼容入口：runtime 根目录（「MAW_LOCAL_RUNTIME_ROOT」/ 默认 app-data；MOSS 走独立目录）。"""
    if _is_moss_engine(engine):
        return _moss_runtime().default_runtime_root()
    return LOCAL.resolve_root()


def runtime_python_path(root: Path | None = None, *, engine: str = "") -> Path:
    if _is_moss_engine(engine):
        return _moss_runtime().runtime_python_path(root)
    target = root or default_runtime_root()
    return LOCAL.python_path(target)


def managed_runtime_status(
    model_cache_root: str | Path | None = None,
    *,
    engine: str = "",
) -> LocalRuntimeStatus:
    """委托 ``maw.runtimes`` 对应实例的 status 并转换为旧契约状态类型。"""
    if _is_moss_engine(engine):
        return _moss_runtime().managed_runtime_status(model_cache_root)
    return _from_runtime_status(LOCAL.status(model_cache_root=model_cache_root))


def managed_runtime_python(engine: str = "") -> str:
    status = managed_runtime_status(engine=engine)
    return status.python_path if status.ready else ""


def install_local_runtime(
    *,
    on_event: RuntimeEvent | None = None,
    cancel_event: Event | None = None,
    repair: bool = False,
    model_cache_root: str | Path | None = None,
    engine: str = "",
) -> LocalRuntimeStatus:
    """委托 ``maw.runtimes`` 对应实例的 install（完整生命周期在 base）。"""
    if _is_moss_engine(engine):
        return _moss_runtime().install_local_runtime(
            on_event=on_event,
            cancel_event=cancel_event,
            repair=repair,
            model_cache_root=model_cache_root,
        )
    return _from_runtime_status(
        LOCAL.install(
            on_event=on_event,
            cancel_event=cancel_event,
            repair=repair,
            model_cache_root=model_cache_root,
        )
    )


def prepare_model_in_runtime(
    *,
    engine: str,
    model: str,
    model_path: str = "",
    device: str = "auto",
    forced_aligner: str = "",
    vad_model: str = "",
    punc_model: str = "",
    speaker_model: str = "",
    trust_remote_code: bool = False,
    model_cache_root: str | Path | None = None,
    on_event: Callable[[str], None] | None = None,
    cancel_event: Event | None = None,
) -> int:
    """在托管环境里跑模型加载器（不经 MAW.exe 本进程）。"""
    if _is_moss_engine(engine):
        status = _moss_runtime().managed_runtime_status(model_cache_root)
        if not status.ready:
            raise LocalRuntimeError("MOSS 运行环境尚未安装，请先安装 MOSS 本地支持。")
    else:
        status = managed_runtime_status(model_cache_root)
        if not status.ready:
            raise LocalRuntimeError("本地模型运行时尚未安装，请先安装本地模型支持。")
    helper = LOCAL.bundle_path("maw/local_runtime_worker.py")
    if not helper.exists():
        raise LocalRuntimeError(f"本地运行时助手缺失：{helper}")
    command = [str(status.python_path), str(helper), "prepare", "--engine", engine, "--model", model, "--device", device]
    if model_path:
        command.extend(["--model-path", model_path])
    if forced_aligner:
        command.extend(["--forced-aligner", forced_aligner])
    if vad_model:
        command.extend(["--vad-model", vad_model])
    if punc_model:
        command.extend(["--punc-model", punc_model])
    if speaker_model:
        command.extend(["--speaker-model", speaker_model])
    if trust_remote_code:
        command.append("--trust-remote-code")
    return _run_process(
        command,
        env=_runtime_env(model_cache_root, default_runtime_root()),
        cancel=cancel_event or Event(),
        on_line=on_event or (lambda _line: None),
    )


def prepare_model_in_process(
    *,
    engine: str,
    model: str,
    model_path: str = "",
    device: str = "auto",
    forced_aligner: str = "",
    vad_model: str = "",
    punc_model: str = "",
    speaker_model: str = "",
    trust_remote_code: bool = False,
    model_cache_root: str | Path | None = None,
    on_event: Callable[[str], None] | None = None,
    cancel_event: Event | None = None,
) -> int:
    """在可取消的子进程里做源码模式模型准备。

    源码模式开发环境的可选包装在 MAW 自己的 venv（而非 ``local-runtime``）。
    让加载器留在子进程里，取消行为与托管模式一致，且准备阶段与推理共用
    同一套 MAW 模型缓存变量。
    """
    helper = LOCAL.bundle_path("maw/local_runtime_worker.py")
    if not helper.exists():
        raise LocalRuntimeError(f"本地运行时助手缺失：{helper}")
    command = [sys.executable, str(helper), "prepare", "--engine", engine, "--model", model, "--device", device]
    if model_path:
        command.extend(["--model-path", model_path])
    if forced_aligner:
        command.extend(["--forced-aligner", forced_aligner])
    if vad_model:
        command.extend(["--vad-model", vad_model])
    if punc_model:
        command.extend(["--punc-model", punc_model])
    if speaker_model:
        command.extend(["--speaker-model", speaker_model])
    if trust_remote_code:
        command.append("--trust-remote-code")
    return _run_process(
        command,
        env=_runtime_env(model_cache_root),
        cancel=cancel_event or Event(),
        on_line=on_event or (lambda _line: None),
    )


def _runtime_env(
    model_cache_root: str | Path | None = None,
    runtime_root: Path | None = None,
) -> dict[str, str]:
    env = dict(os.environ)
    env.update(model_cache_environment(model_cache_root))
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    if runtime_root is not None:
        site_packages = runtime_root / "site-packages"
        env["PYTHONPATH"] = str(site_packages)
    return env


def _from_runtime_status(status: RuntimeStatus) -> LocalRuntimeStatus:
    return LocalRuntimeStatus(
        status=status.status,
        ready=status.ready,
        path=status.path,
        python_path=status.python_path,
        model_cache_path=status.model_cache_path,
        detail=status.detail,
        runtime_version=status.runtime_version,
    )