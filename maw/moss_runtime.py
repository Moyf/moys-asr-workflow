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

from pathlib import Path
from threading import Event
from typing import Final

from maw.local_runtime import LocalRuntimeStatus, _from_runtime_status
from maw.runtimes import MOSS
from maw.runtimes.base import RuntimeEvent
from maw.runtimes.moss_spec import MOSS_PYTHON_VERSION, MOSS_RUNTIME_VERSION

MOSS_RUNTIME_ROOT_NAME: Final = "local-runtime-moss"
# 兼容导出的依赖常量：实际安装依赖的唯一真源是仓库根
# 「moss-requirements.in」经 CI 冻结的 requirements-moss.txt，
# 此列表仅作记录，不再参与安装流程。
MOSS_REQUIREMENTS: Final[tuple[str, ...]] = (
    "av>=14.0",
    "librosa>=0.11.0",
    "numba>=0.61.0",
    "packaging>=24.0",
    "safetensors>=0.6.2",
    "soundfile>=0.12",
    "soxr>=0.5",
    "transformers>=5.6.0,<6.0.0",
    "moss-transcribe-diarize @ https://github.com/OpenMOSS/MOSS-Transcribe-Diarize/archive/e607537b1b870475e7898969d40b864de8b691b6.zip",
)
MOSS_PACKAGE_DIRS: Final[tuple[str, ...]] = ("moss_transcribe_diarize", "transformers", "torch", "torchaudio")
MOSS_VERIFY_IMPORT: Final = (
    "from moss_transcribe_diarize import parse_transcript; "
    "import transformers, torch, torchaudio; print('MAW_LOCAL_RUNTIME_READY')"
)


def default_runtime_root() -> Path:
    """MOSS runtime 根目录（「MAW_MOSS_RUNTIME_ROOT」覆盖 / 默认 local-runtime-moss）。"""
    return MOSS.resolve_root()


def runtime_python_path(root: str | Path | None = None) -> Path:
    target = Path(root) if root is not None else MOSS.resolve_root()
    return MOSS.python_path(target)


def managed_runtime_status(model_cache_root: str | Path | None = None) -> LocalRuntimeStatus:
    """与主 runtime 同一契约（LocalRuntimeStatus）的 MOSS 状态。"""
    return _from_runtime_status(MOSS.status(model_cache_root=model_cache_root))


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
            model_cache_root=model_cache_root,
        )
    )


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
    "runtime_python_path",
]
