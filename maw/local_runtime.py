"""User-managed runtime for the Launcher local ASR feature.

The regular MAW package intentionally stays small.  When a user enables local
ASR, this module creates a separate Python environment under the user's local
application data directory and installs the optional inference dependencies
there.  Model caches live in a sibling directory so the runtime can be
repaired without redownloading model weights.
"""

from __future__ import annotations

import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from threading import Event
from typing import Final, TextIO

from maw.gui_platform import asset_path, popen_process_tree, process_group_kwargs, release_process_tree, terminate_process_tree


RUNTIME_VERSION: Final = "3"
PYTHON_VERSION: Final = "3.11"
PYTORCH_INDEX: Final = "https://download.pytorch.org/whl/cu130"
GENERAL_REQUIREMENTS: Final[tuple[str, ...]] = (
    "accelerate>=1.12",
    "funasr>=1.3.29",
    "hf-xet>=1.5",
    "jieba>=0.42",
    "qwen-asr>=0.0.6",
    "requests>=2.28",
)
WINDOWS_TORCH_REQUIREMENTS: Final[tuple[str, ...]] = (
    "torch==2.13.0+cu130",
    "torchaudio==2.11.0+cu130",
)
OTHER_TORCH_REQUIREMENTS: Final[tuple[str, ...]] = (
    "torch>=2.13.0",
    "torchaudio>=2.11.0",
)


RuntimeEvent = Callable[[str, int, str], None]


class LocalRuntimeError(RuntimeError):
    """Raised when the managed local ASR runtime cannot be installed."""


class LocalRuntimeCancelled(LocalRuntimeError):
    """Raised when the user closes MAW or cancels runtime installation."""


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


def default_app_data_root() -> Path:
    override = os.environ.get("MAW_APP_DATA_ROOT", "").strip()
    if override:
        return Path(override).expanduser().resolve(strict=False)
    if os.name == "nt":
        return Path(os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local")) / "MAW"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "MAW"
    return Path(os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share")) / "MAW"


def default_runtime_root() -> Path:
    override = os.environ.get("MAW_LOCAL_RUNTIME_ROOT", "").strip()
    if override:
        return Path(override).expanduser().resolve(strict=False)
    return default_app_data_root() / "local-runtime"


def default_model_cache_root() -> Path:
    return resolve_model_cache_root()


def resolve_model_cache_root(configured: str | Path | None = None) -> Path:
    """Resolve an explicit cache root, then the process-level override."""
    override = str(configured or "").strip() or os.environ.get("MAW_MODEL_CACHE_ROOT", "").strip()
    if override:
        return Path(override).expanduser().resolve(strict=False)
    return default_app_data_root() / "model-cache"


def model_cache_environment(model_cache_root: str | Path | None = None) -> dict[str, str]:
    """Return cache variables shared by model preparation and inference."""
    root = resolve_model_cache_root(model_cache_root)
    huggingface = root / "huggingface"
    modelscope = root / "modelscope"
    return {
        "MAW_MODEL_CACHE_ROOT": str(root),
        "HF_HOME": str(huggingface),
        "HF_HUB_CACHE": str(huggingface / "hub"),
        "HUGGINGFACE_HUB_CACHE": str(huggingface / "hub"),
        "MODELSCOPE_CACHE": str(modelscope),
        "MODELSCOPE_HOME": str(modelscope),
    }


def runtime_python_path(root: Path | None = None) -> Path:
    target = root or default_runtime_root()
    relative = Path("Scripts") / "python.exe" if os.name == "nt" else Path("bin") / "python"
    return target / relative


def managed_runtime_status(model_cache_root: str | Path | None = None) -> LocalRuntimeStatus:
    root = default_runtime_root()
    python = runtime_python_path(root)
    model_cache = resolve_model_cache_root(model_cache_root)
    manifest_path = root / "runtime.json"
    if not root.exists():
        return LocalRuntimeStatus("missing", False, str(root), "", str(model_cache), "本地运行环境尚未安装。")
    if not python.exists():
        return LocalRuntimeStatus(
            "broken",
            False,
            str(root),
            str(python),
            str(model_cache),
            "本地运行环境不完整，请点击“修复运行环境”。",
        )
    manifest = _read_manifest(manifest_path)
    if manifest.get("status") != "ready" or manifest.get("runtimeVersion") != RUNTIME_VERSION:
        return LocalRuntimeStatus(
            "broken",
            False,
            str(root),
            str(python),
            str(model_cache),
            "本地运行环境需要修复，请点击“修复运行环境”。",
            str(manifest.get("runtimeVersion") or RUNTIME_VERSION),
        )
    if not _runtime_package_dirs_present(root):
        return LocalRuntimeStatus(
            "broken",
            False,
            str(root),
            str(python),
            str(model_cache),
            "本地运行环境依赖不完整，请点击“修复运行环境”。",
        )
    return LocalRuntimeStatus(
        "ready",
        True,
        str(root),
        str(python),
        str(model_cache),
        "本地运行环境已就绪。",
    )


def managed_runtime_python() -> str:
    status = managed_runtime_status()
    return status.python_path if status.ready else ""


def install_local_runtime(
    *,
    on_event: RuntimeEvent | None = None,
    cancel_event: Event | None = None,
    repair: bool = False,
    model_cache_root: str | Path | None = None,
) -> LocalRuntimeStatus:
    """Create or repair the user-managed runtime and verify all adapters."""
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
    emit("正在准备 Python 运行环境……", 5, "bootstrap")
    python = runtime_python_path(root)
    venv_args = [str(uv), "venv", "--python", PYTHON_VERSION, "--allow-existing"]
    if root.exists() and not python.exists():
        venv_args.append("--clear")
    venv_args.extend(["--prompt", "MAW-local", str(root)])
    _run_process(venv_args, env=_runtime_env(model_cache_root), cancel=cancel, on_line=_uv_line(emit, 10, "bootstrap"))
    _check_cancel(cancel)
    if not python.exists():
        raise LocalRuntimeError(f"Python 运行环境创建失败：未找到 {python}")

    emit("正在安装本地 ASR 依赖（Torch、FunASR、QwenASR）……", 25, "dependencies")
    requirements = (
        *GENERAL_REQUIREMENTS,
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
    _run_process(
        install_args,
        env=_runtime_env(model_cache_root),
        cancel=cancel,
        on_line=_dependency_line(emit),
    )
    _check_cancel(cancel)

    emit("正在验证本地模型运行时……", 90, "verify")
    verify_args = [
        str(python),
        "-c",
        "from funasr import AutoModel; from qwen_asr import Qwen3ASRModel; import jieba, torch, torchaudio; print('MAW_LOCAL_RUNTIME_READY')",
    ]
    _run_process(verify_args, env=_runtime_env(model_cache_root), cancel=cancel, on_line=lambda line: emit(line, 94, "verify"))
    _check_cancel(cancel)
    _write_manifest(root, {"status": "ready", "runtimeVersion": RUNTIME_VERSION, "pythonVersion": PYTHON_VERSION, "installedAt": int(time.time())})
    cache_environment = model_cache_environment(model_cache_root)
    for path in (resolve_model_cache_root(model_cache_root), Path(cache_environment["HF_HUB_CACHE"]), Path(cache_environment["MODELSCOPE_CACHE"])):
        path.mkdir(parents=True, exist_ok=True)
    emit("本地运行环境已安装完成。现在可以下载模型。", 100, "ready")
    return managed_runtime_status(model_cache_root)


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
    """Run the model loader in the managed environment, not inside MAW.exe."""
    status = managed_runtime_status(model_cache_root)
    if not status.ready:
        raise LocalRuntimeError("本地模型运行时尚未安装，请先安装本地模型支持。")
    helper = _runtime_bundle_path("maw/local_runtime_worker.py")
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
        env=_runtime_env(model_cache_root),
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
    """Run source-mode model preparation in a killable child process.

    Source-mode development environments have the optional packages installed
    in MAW's own venv rather than in ``local-runtime``.  Keeping the loader in
    a child process makes cancellation work the same way in both modes and
    ensures preparation uses the same MAW model-cache variables as inference.
    """
    helper = _runtime_bundle_path("maw/local_runtime_worker.py")
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


def _runtime_env(model_cache_root: str | Path | None = None) -> dict[str, str]:
    env = dict(os.environ)
    env.update(model_cache_environment(model_cache_root))
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    return env


def _find_uv() -> Path | None:
    candidates: list[Path] = []
    configured = os.environ.get("MAW_UV_PATH", "").strip()
    if configured:
        candidates.append(Path(configured).expanduser())
    candidates.extend([
        asset_path("bootstrap/uv.exe"),
        asset_path("bootstrap/uv"),
        Path(sys.executable).resolve().parent / "bootstrap" / "uv.exe",
        Path(sys.executable).resolve().parent / "bootstrap" / "uv",
    ])
    found = shutil.which("uv")
    if found:
        candidates.append(Path(found))
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    return None


def _runtime_bundle_path(relative: str) -> Path:
    if getattr(sys, "frozen", False):
        return asset_path(f"local-runtime/{relative}")
    return Path(__file__).resolve().parents[1] / relative


def _uv_line(emit: RuntimeEvent, percent: int, stage: str) -> Callable[[str], None]:
    def report(line: str) -> None:
        text = line.strip()
        if text:
            emit(text, percent, stage)

    return report


def _dependency_line(emit: RuntimeEvent) -> Callable[[str], None]:
    """Turn uv's package log into a coarse but honest install progress signal."""
    markers = {
        "accelerate", "funasr", "hf-xet", "jieba", "qwen-asr", "requests", "torch", "torchaudio",
    }
    seen: set[str] = set()

    def report(line: str) -> None:
        text = line.strip()
        if not text:
            return
        folded = text.casefold()
        seen.update(marker for marker in markers if marker in folded)
        percent = min(85, 30 + len(seen) * 8)
        emit(text, percent, "dependencies")

    return report


def _run_process(
    command: list[str],
    *,
    env: Mapping[str, str],
    cancel: Event,
    on_line: Callable[[str], None],
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
            cwd=str(_runtime_bundle_path(".")),
            **process_group_kwargs(),
        )
    except OSError as error:
        raise LocalRuntimeError(f"无法启动本地运行环境命令：{error}") from error

    output: list[str] = []
    lines: queue.Queue[str | None] = queue.Queue()
    reader = threading.Thread(
        target=_read_process_lines,
        args=(process.stdout, lines),
        name="maw-local-runtime-output",
        daemon=True,
    )
    reader.start()
    while True:
        if cancel.is_set():
            terminate_process_tree(process)
            raise LocalRuntimeCancelled("本地运行环境安装已取消。")
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
        detail = "\n".join(output[-8:])
        raise LocalRuntimeError(f"本地运行环境命令失败（退出码 {return_code}）。{detail}")
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
        raise LocalRuntimeCancelled("本地运行环境安装已取消。")


def _read_manifest(path: Path) -> dict[str, object]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return dict(value) if isinstance(value, Mapping) else {}


def _runtime_package_dirs_present(root: Path) -> bool:
    site_packages = root / "Lib" / "site-packages" if os.name == "nt" else root / "lib"
    if os.name != "nt":
        candidates = list(site_packages.glob("python*/site-packages"))
        site_packages = candidates[0] if candidates else site_packages
    return all((site_packages / name).exists() for name in ("funasr", "qwen_asr", "jieba", "torch", "torchaudio"))


def _write_manifest(root: Path, values: Mapping[str, object]) -> None:
    root.mkdir(parents=True, exist_ok=True)
    target = root / "runtime.json"
    temporary = root / "runtime.json.tmp"
    temporary.write_text(json.dumps(dict(values), ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    temporary.replace(target)


__all__ = [
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
