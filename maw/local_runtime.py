"""User-managed runtime for the Launcher local ASR feature.

The regular MAW package intentionally stays small.  When a user enables local
ASR, this module creates a separate Python environment under the user's local
application data directory and installs the optional inference dependencies
there.  Model caches live in a sibling directory so the runtime can be
repaired without redownloading model weights.
"""

from __future__ import annotations

import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import zipfile
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from threading import Event
from typing import Final, TextIO

from maw.gui_platform import asset_path, popen_process_tree, process_group_kwargs, release_process_tree, terminate_process_tree
from maw.runtime_manifest import STATUS_INSTALLING, STATUS_READY, read_runtime_manifest, write_runtime_manifest
from maw.runtime_mirror_picker import pick_fastest_mirror


RUNTIME_VERSION: Final = "5"
PYTHON_VERSION: Final = "3.11"
PYTORCH_INDEX: Final = "https://download.pytorch.org/whl/cu130"
EMBED_PYTHON_ZIP: Final = "python-3.11.9-embed-amd64.zip"
GET_PIP_SCRIPT: Final = "get-pip.py"


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
    relative = Path("python") / "python.exe" if os.name == "nt" else Path("python") / "bin" / "python"
    return target / relative


def managed_runtime_status(model_cache_root: str | Path | None = None) -> LocalRuntimeStatus:
    root = default_runtime_root()
    python = runtime_python_path(root)
    model_cache = resolve_model_cache_root(model_cache_root)
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
    manifest = read_runtime_manifest(root)
    if manifest.installing:
        return LocalRuntimeStatus(
            "installing",
            False,
            str(root),
            str(python),
            str(model_cache),
            "本地运行环境正在安装中，请稍候。",
            manifest.runtime_version or RUNTIME_VERSION,
        )
    if not manifest.is_ready_for(RUNTIME_VERSION):
        return LocalRuntimeStatus(
            "broken",
            False,
            str(root),
            str(python),
            str(model_cache),
            "本地运行环境需要修复，请点击“修复运行环境”。",
            manifest.runtime_version or RUNTIME_VERSION,
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
    # 安装开始即写入 installing 状态，避免安装过程中被判定为"需要修复"。
    write_runtime_manifest(root, status=STATUS_INSTALLING, runtime_version=RUNTIME_VERSION, python_version=PYTHON_VERSION)

    embed_zip = _find_bootstrap_asset(EMBED_PYTHON_ZIP)
    get_pip = _find_bootstrap_asset(GET_PIP_SCRIPT)
    if embed_zip is None or get_pip is None:
        raise LocalRuntimeError(
            "未找到本地运行环境安装资产（embedded Python 或 get-pip.py）。"
            "请使用官方 Windows 打包版。"
        )

    current = managed_runtime_status(model_cache_root)
    if current.ready and not repair:
        emit("本地运行环境已经安装完成。", 100, "ready")
        return current

    _check_cancel(cancel)
    emit("正在解压嵌入式 Python 运行环境……", 5, "bootstrap")
    python_dir = root / "python"
    python = runtime_python_path(root)
    if repair or not python.exists():
        if python_dir.exists():
            shutil.rmtree(python_dir)
        _extract_embed_python(embed_zip, python_dir)
    _check_cancel(cancel)
    if not python.exists():
        raise LocalRuntimeError(f"Python 运行环境解压失败：未找到 {python}")

    emit("正在安装 pip……", 12, "bootstrap")
    _run_process(
        _get_pip_command(python, get_pip),
        env=_runtime_env(model_cache_root, root),
        cancel=cancel,
        on_line=_bootstrap_line(emit, 15, "bootstrap"),
    )
    _check_cancel(cancel)

    emit("正在安装本地 ASR 依赖（Torch、FunASR、QwenASR）……", 25, "dependencies")
    requirements_file = _runtime_requirements_path()
    site_packages = root / "site-packages"
    fastest_index = pick_fastest_mirror()
    install_args = _pip_install_command(
        python,
        site_packages,
        requirements_file,
        index_url=fastest_index,
        extra_index_url=PYTORCH_INDEX,
    )
    _run_process(
        install_args,
        env=_runtime_env(model_cache_root, root),
        cancel=cancel,
        on_line=_dependency_line(emit, requirements_file),
    )
    _check_cancel(cancel)

    if sys.platform != "darwin" and not _has_cuda():
        emit("未检测到 NVIDIA CUDA，切换 Torch 为 CPU 版……", 88, "cuda-fallback")
        cpu_args = _pip_install_command(
            python,
            site_packages,
            None,
            index_url=fastest_index,
            packages=["torch==2.13.0", "torchaudio==2.11.0"],
        )
        _run_process(
            cpu_args,
            env=_runtime_env(model_cache_root, root),
            cancel=cancel,
            on_line=lambda line: emit(line, 89, "cuda-fallback"),
        )
        _check_cancel(cancel)

    emit("正在验证本地模型运行时……", 90, "verify")
    verify_args = [
        str(python),
        "-c",
        "from funasr import AutoModel; from qwen_asr import Qwen3ASRModel; import jieba, torch, torchaudio; print('MAW_LOCAL_RUNTIME_READY')",
    ]
    _run_process(verify_args, env=_runtime_env(model_cache_root, root), cancel=cancel, on_line=lambda line: emit(line, 94, "verify"))
    _check_cancel(cancel)
    write_runtime_manifest(root, status=STATUS_READY, runtime_version=RUNTIME_VERSION, python_version=PYTHON_VERSION)
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


def _find_bootstrap_asset(filename: str) -> Path | None:
    """Find a bootstrap asset (embedded Python zip, get-pip.py) in the bundle."""
    candidates: list[Path] = [
        asset_path(f"bootstrap/{filename}"),
        Path(sys.executable).resolve().parent / "bootstrap" / filename,
    ]
    # Dev mode: also check build/ directory where assets are staged.
    if not getattr(sys, "frozen", False):
        candidates.append(Path(__file__).resolve().parents[1] / "build" / filename)
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    return None


def _extract_embed_python(zip_path: Path, target_dir: Path) -> None:
    """Extract the embedded Python distribution and enable site + target packages."""
    target_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as archive:
        archive.extractall(target_dir)
    pth_path = target_dir / "python311._pth"
    if pth_path.is_file():
        text = pth_path.read_text(encoding="utf-8")
        text = text.replace("#import site", "import site")
        # The _pth file controls sys.path and overrides PYTHONPATH.
        # Add ../site-packages so the embedded Python finds pip --target installs.
        if "../site-packages" not in text:
            text = text.rstrip() + "\n../site-packages\n"
        pth_path.write_text(text, encoding="utf-8", newline="\n")


def _get_pip_command(python_exe: Path, get_pip_path: Path) -> list[str]:
    """Build the command to bootstrap pip into an embedded Python."""
    return [str(python_exe), str(get_pip_path)]


def _pip_install_command(
    python_exe: Path,
    target_dir: Path,
    requirements_file: Path | None,
    *,
    index_url: str = "https://pypi.org/simple",
    extra_index_url: str | None = None,
    packages: list[str] | None = None,
) -> list[str]:
    """Build a pip install --target command for the managed runtime."""
    command = [
        str(python_exe), "-m", "pip", "install", "--upgrade",
        "--target", str(target_dir),
        "--index-url", index_url,
    ]
    if extra_index_url:
        command.extend(["--extra-index-url", extra_index_url])
    if requirements_file is not None:
        command.extend(["-r", str(requirements_file)])
    if packages:
        command.extend(packages)
    return command


def _runtime_bundle_path(relative: str) -> Path:
    if getattr(sys, "frozen", False):
        return asset_path(f"local-runtime/{relative}")
    return Path(__file__).resolve().parents[1] / relative


def _runtime_requirements_path() -> Path:
    """Resolve the frozen requirements.txt for the managed local ASR runtime."""
    if getattr(sys, "frozen", False):
        path = asset_path("local-runtime/requirements-local.txt")
    else:
        path = Path(__file__).resolve().parents[1] / "build" / "requirements-local.txt"
    if not path.is_file():
        raise LocalRuntimeError(
            "本地运行环境依赖清单缺失：" + str(path) + "。"
            "打包版应随包分发；源码运行请先运行 "
            "uv export --frozen --extra local --no-dev --format requirements-txt -o build/requirements-local.txt"
        )
    return path


def _requirement_package_names(path: Path) -> set[str]:
    """Extract lowercased package names from a frozen requirements.txt for progress tracking."""
    names: set[str] = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        match = re.match(r"^([A-Za-z0-9_.-]+)", line)
        if match:
            names.add(match.group(1).casefold())
    return names


def _has_cuda() -> bool:
    """Detect NVIDIA CUDA availability via nvidia-smi."""
    nvidia_smi = shutil.which("nvidia-smi")
    if nvidia_smi is None:
        return False
    try:
        result = subprocess.run(
            [nvidia_smi, "--query-gpu=name", "--format=csv,noheader"],
            capture_output=True,
            timeout=10,
        )
        return result.returncode == 0
    except (subprocess.TimeoutExpired, OSError):
        return False


def _bootstrap_line(emit: RuntimeEvent, percent: int, stage: str) -> Callable[[str], None]:
    def report(line: str) -> None:
        text = line.strip()
        if text:
            emit(text, percent, stage)

    return report


def _dependency_line(emit: RuntimeEvent, requirements_file: Path) -> Callable[[str], None]:
    """Turn uv's package log into a coarse but honest install progress signal."""
    markers = _requirement_package_names(requirements_file)
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


def _runtime_package_dirs_present(root: Path) -> bool:
    site_packages = root / "site-packages"
    return all((site_packages / name).exists() for name in ("funasr", "qwen_asr", "jieba", "torch", "torchaudio", "reapeaks"))


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
