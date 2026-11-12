"""User-managed MOSS runtime for the Launcher local ASR feature — thin shim.

安装 / 状态 / 路径 / 依赖生命周期已与 local / ocr 统一到 ``maw.runtimes``
（规格见 ``maw/runtimes/moss_spec.py``），本模块保留 MOSS 的对外常量与
函数签名并委托 ``maw.runtimes.MOSS``。

MOSS Transcribe-Diarize 依赖 Transformers 5.x，与 QwenASR / FunASR
（funasr / Transformers 4.x 侧）不能共享一个环境，因此独立安装到
``local-runtime-moss``（Python 3.11，与 local 共用同一 embedded zip）；
模型缓存与其余引擎共用。
"""

from __future__ import annotations

import os
from pathlib import Path
from threading import Event
from typing import Final

from maw.local_runtime import LocalRuntimeStatus, _from_runtime_status
from maw.runtimes import MOSS
from maw.runtimes.base import RuntimeEvent
from maw.runtimes.moss_spec import MOSS_PYTHON_VERSION, MOSS_RUNTIME_VERSION

MOSS_RUNTIME_ROOT_NAME: Final = "local-runtime-moss"
# 兼容导出的依赖常量：实际安装依赖的唯一真源是
# 「scripts/packaging/moss-requirements.in」经 CI 冻结的 requirements-moss.txt，
# 此列表仅作记录，不再参与安装流程。
MOSS_REQUIREMENTS: Final[tuple[str, ...]] = (
    "av>=14.0",
    "librosa>=0.11.0",
    # MOSS 模型下载的 Hugging Face → ModelScope 回退需要 modelscope。
    "modelscope>=1.39",
    "numba>=0.61.0",
    "packaging>=24.0",
    "safetensors>=0.6.2",
    "soundfile>=0.12",
    "soxr>=0.5",
    "transformers>=5.6.0,<6.0.0",
    "moss-transcribe-diarize @ https://github.com/OpenMOSS/MOSS-Transcribe-Diarize/archive/e607537b1b870475e7898969d40b864de8b691b6.zip",
)
# 其余常量直接从 RuntimeSpec 派生，避免与 moss_spec 的真源漂移。
MOSS_PACKAGE_DIRS: Final[tuple[str, ...]] = MOSS.spec.package_dirs
MOSS_VERIFY_IMPORT: Final = MOSS.spec.verify_command


def _moss_root_override() -> Path | None:
    """MOSS 安装根目录的显式覆盖；``None`` 表示走默认解析。

    「MAW_MOSS_RUNTIME_ROOT」是 MOSS 独立覆盖键，优先级最高。未设置时回落
    「MAW_LOCAL_RUNTIME_ROOT」并派生 ``<值>-moss`` 同级目录：设置页的
    「安装位置」字段只维护 LOCAL 键（保存与启动回填链路见 gui_web 的
    ``save_local_settings`` / ``_sync_local_runtime_root``），回落让 MOSS
    跟随用户自定义路径，同时保持与 LOCAL 不同的目录（Transformers 5.x 与
    funasr / Transformers 4.x 互斥，不能叠装）。派生规则与 RuntimeSpec
    抽象前的旧实现一致（``eb55dde0`` 曾把该链路切到独立键造成设置失效，
    此处恢复）。返回 ``None`` 时 resolve_root 走自身的环境回退与默认目录。
    """
    own = os.environ.get("MAW_MOSS_RUNTIME_ROOT", "").strip()
    if own:
        return Path(own).expanduser()
    shared = os.environ.get("MAW_LOCAL_RUNTIME_ROOT", "").strip()
    if shared:
        base = Path(shared).expanduser().resolve(strict=False)
        return base.with_name(f"{base.name}-moss")
    return None


def default_runtime_root() -> Path:
    """MOSS runtime 根目录（显式覆盖 / LOCAL 键派生 ``-moss`` / 默认 local-runtime-moss）。"""
    return MOSS.resolve_root(_moss_root_override())


def runtime_python_path(root: str | Path | None = None) -> Path:
    target = Path(root) if root is not None else MOSS.resolve_root(_moss_root_override())
    return MOSS.python_path(target)


def managed_runtime_status(model_cache_root: str | Path | None = None) -> LocalRuntimeStatus:
    """与主 runtime 同一契约（LocalRuntimeStatus）的 MOSS 状态。"""
    return _from_runtime_status(
        MOSS.status(model_cache_root=model_cache_root, runtime_root=_moss_root_override())
    )


def install_local_runtime(
    *,
    on_event: RuntimeEvent | None = None,
    cancel_event: Event | None = None,
    repair: bool = False,
    model_cache_root: str | Path | None = None,
) -> LocalRuntimeStatus:
    """创建或修复 MOSS 环境（embedded Python + pip --target + frozen txt）。"""
    return _from_runtime_status(
        MOSS.install(
            on_event=on_event,
            cancel_event=cancel_event,
            repair=repair,
            runtime_root=_moss_root_override(),
            model_cache_root=model_cache_root,
        )
    )


def recover_local_runtime_install() -> bool:
    """清除 MOSS 安装中断后残留的 installing 标记（改写为 broken，#127）。"""
    return MOSS.mark_install_aborted()


__all__ = [
    "MOSS_PACKAGE_DIRS",
    "MOSS_PYTHON_VERSION",
    "MOSS_REQUIREMENTS",
    "MOSS_RUNTIME_ROOT_NAME",
    "MOSS_RUNTIME_VERSION",
    "MOSS_VERIFY_IMPORT",
    "default_runtime_root",
    "install_local_runtime",
    "managed_runtime_status",
    "recover_local_runtime_install",
    "runtime_python_path",
]
