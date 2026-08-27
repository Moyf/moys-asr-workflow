"""User-managed MOSS runtime for the Launcher local ASR feature.

MOSS Transcribe-Diarize needs Transformers 5.x while the QwenASR / FunASR
runtime pins Transformers 4.x, so the two can never share a venv.  MAW
installs MOSS into its own ``local-runtime-moss`` environment (Python 3.12)
sibling to the regular ``local-runtime``; the Hugging Face / ModelScope model
caches stay shared with the other engines.

# TODO: moss 迁移至 embedded Python + frozen txt（移除 uv）
"""

from __future__ import annotations

import os
import time
from collections.abc import Callable
from pathlib import Path
from threading import Event
from typing import Final

# Shared runtime plumbing lives in ``maw.local_runtime``; MOSS only carries its
# own constants, paths, install / verify steps and status judgement here.
# ``maw.local_runtime`` imports this module lazily (see ``_moss_runtime``
# there), so a module-level import in the other direction stays cycle-free.
from maw.local_runtime import (
    LocalRuntimeError,
    LocalRuntimeStatus,
    OTHER_TORCH_REQUIREMENTS,
    PYTORCH_INDEX,
    WINDOWS_TORCH_REQUIREMENTS,
    _check_cancel,
    _find_uv,
    _read_manifest,
    _run_process,
    _runtime_env,
    _uv_line,
    _write_manifest,
    default_app_data_root,
    model_cache_environment,
    resolve_model_cache_root,
)


MOSS_RUNTIME_VERSION: Final = "1"
MOSS_PYTHON_VERSION: Final = "3.12"
MOSS_RUNTIME_ROOT_NAME: Final = "local-runtime-moss"
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
    "from moss_transcribe_diarize import parse_transcript; import transformers, torch, torchaudio; print('MAW_LOCAL_RUNTIME_READY')"
)

RuntimeEvent = Callable[[str, int, str], None]


def default_runtime_root() -> Path:
    """Resolve the MOSS runtime root (``MAW_LOCAL_RUNTIME_ROOT`` + ``-moss``, or ``local-runtime-moss``)."""

    override = os.environ.get("MAW_LOCAL_RUNTIME_ROOT", "").strip()
    if override:
        base = Path(override).expanduser().resolve(strict=False)
        return base.with_name(f"{base.name}-moss")
    return default_app_data_root() / MOSS_RUNTIME_ROOT_NAME


def runtime_python_path(root: str | Path | None = None) -> Path:
    target = Path(root) if root is not None else default_runtime_root()
    relative = Path("Scripts") / "python.exe" if os.name == "nt" else Path("bin") / "python"
    return target / relative


def managed_runtime_status(model_cache_root: str | Path | None = None) -> LocalRuntimeStatus:
    """Return the MOSS runtime status with the same contract as the main runtime."""

    root = default_runtime_root()
    python = runtime_python_path(root)
    model_cache = resolve_model_cache_root(model_cache_root)
    manifest_path = root / "runtime.json"
    if not root.exists():
        return LocalRuntimeStatus(
            "missing",
            False,
            str(root),
            "",
            str(model_cache),
            "本地运行环境尚未安装。",
            runtime_version=MOSS_RUNTIME_VERSION,
        )
    if not python.exists():
        return LocalRuntimeStatus(
            "broken",
            False,
            str(root),
            str(python),
            str(model_cache),
            "本地运行环境不完整，请点击“修复运行环境”。",
            runtime_version=MOSS_RUNTIME_VERSION,
        )
    manifest = _read_manifest(manifest_path)
    if manifest.get("status") != "ready" or manifest.get("runtimeVersion") != MOSS_RUNTIME_VERSION:
        return LocalRuntimeStatus(
            "broken",
            False,
            str(root),
            str(python),
            str(model_cache),
            "本地运行环境需要修复，请点击“修复运行环境”。",
            str(manifest.get("runtimeVersion") or MOSS_RUNTIME_VERSION),
        )
    if not _moss_package_dirs_present(root):
        return LocalRuntimeStatus(
            "broken",
            False,
            str(root),
            str(python),
            str(model_cache),
            "本地运行环境依赖不完整，请点击“修复运行环境”。",
            runtime_version=MOSS_RUNTIME_VERSION,
        )
    return LocalRuntimeStatus(
        "ready",
        True,
        str(root),
        str(python),
        str(model_cache),
        "本地运行环境已就绪。",
        runtime_version=MOSS_RUNTIME_VERSION,
    )


def install_local_runtime(
    *,
    on_event: RuntimeEvent | None = None,
    cancel_event: Event | None = None,
    repair: bool = False,
    model_cache_root: str | Path | None = None,
) -> LocalRuntimeStatus:
    """Create or repair the MOSS environment and verify its packages."""

    emit = on_event or (lambda _message, _percent, _stage: None)
    cancel = cancel_event or Event()
    root = default_runtime_root()
    root.parent.mkdir(parents=True, exist_ok=True)
    uv = _find_uv()
    if uv is None:
        raise LocalRuntimeError(
            "未找到本地运行环境安装器 uv。请使用官方 Windows 打包版，或在开发环境中确保 uv 已加入 PATH。"
        )

    current = managed_runtime_status(model_cache_root)
    if current.ready and not repair:
        emit("本地运行环境已经安装完成。", 100, "ready")
        return current

    _check_cancel(cancel)
    emit("正在准备 MOSS Python 3.12 运行环境……", 5, "bootstrap")
    python = runtime_python_path(root)
    venv_args = [str(uv), "venv", "--python", MOSS_PYTHON_VERSION, "--allow-existing"]
    if root.exists() and not python.exists():
        venv_args.append("--clear")
    venv_args.extend(["--prompt", "MAW-local", str(root)])
    _run_process(venv_args, env=_runtime_env(model_cache_root), cancel=cancel, on_line=_uv_line(emit, 10, "bootstrap"))
    _check_cancel(cancel)
    if not python.exists():
        raise LocalRuntimeError(f"Python 运行环境创建失败：未找到 {python}")

    emit("正在安装 MOSS 本地依赖（Transformers 5.x、Torch）……", 25, "dependencies")
    requirements = (
        *MOSS_REQUIREMENTS,
        *(WINDOWS_TORCH_REQUIREMENTS if os.name == "nt" else OTHER_TORCH_REQUIREMENTS),
    )
    install_args = [
        str(uv),
        "pip",
        "install",
        "--python",
        str(python),
        "--upgrade",
        "--index-url",
        "https://pypi.org/simple",
        "--extra-index-url",
        PYTORCH_INDEX,
        *requirements,
    ]
    _run_process(install_args, env=_runtime_env(model_cache_root), cancel=cancel, on_line=_dependency_line(emit))
    _check_cancel(cancel)

    emit("正在验证本地模型运行时……", 90, "verify")
    verify_args = [str(python), "-c", MOSS_VERIFY_IMPORT]
    _run_process(verify_args, env=_runtime_env(model_cache_root), cancel=cancel, on_line=lambda line: emit(line, 94, "verify"))
    _check_cancel(cancel)
    _write_manifest(
        root,
        {
            "status": "ready",
            "runtimeVersion": MOSS_RUNTIME_VERSION,
            "pythonVersion": MOSS_PYTHON_VERSION,
            "installedAt": int(time.time()),
        },
    )
    cache_environment = model_cache_environment(model_cache_root)
    for path in (resolve_model_cache_root(model_cache_root), Path(cache_environment["HF_HUB_CACHE"]), Path(cache_environment["MODELSCOPE_CACHE"])):
        path.mkdir(parents=True, exist_ok=True)
    emit("MOSS 本地运行环境已安装完成。现在可以下载模型。", 100, "ready")
    return managed_runtime_status(model_cache_root)


def _dependency_line(emit: RuntimeEvent) -> Callable[[str], None]:
    """Turn uv's package log into a coarse but honest install progress signal."""

    markers = {"av", "librosa", "moss", "numba", "safetensors", "torch", "torchaudio", "transformers"}
    seen: set[str] = set()

    def report(line: str) -> None:
        text = line.strip()
        if not text:
            return
        folded = text.casefold()
        seen.update(marker for marker in markers if marker in folded)
        emit(text, min(85, 30 + len(seen) * 8), "dependencies")

    return report


def _moss_package_dirs_present(root: Path) -> bool:
    site_packages = root / "Lib" / "site-packages" if os.name == "nt" else root / "lib"
    if os.name != "nt":
        candidates = list(site_packages.glob("python*/site-packages"))
        site_packages = candidates[0] if candidates else site_packages
    return all((site_packages / name).exists() for name in MOSS_PACKAGE_DIRS)


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