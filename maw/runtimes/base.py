"""Shared plumbing for user-managed runtimes (local ASR / OCR / moss).

The Launcher installs optional inference dependencies into separate Python
environments under the user's app-data directory instead of growing the
frozen MAW package.  Every managed runtime shares the same lifecycle:

    embedded Python 解压 -> get-pip -> pip install --target -r frozen txt
    ->（可选）CUDA 兜底 -> import 自检 -> runtime.json manifest

``RuntimeSpec`` 声明式描述单个 Runtime（frozen txt 名 / 镜像 / verify 命令 /
关键包目录等）；``ManagedRuntime`` 把生命周期实现一次，local / ocr / moss
各自只提供一份 spec。``maw.runtimes`` 导出 LOCAL / OCR / MOSS 现成实例。
"""

from __future__ import annotations

import json
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

from maw.gui_platform import (
    asset_path,
    popen_process_tree,
    process_group_kwargs,
    release_process_tree,
    terminate_process_tree,
)
from maw.runtime_manifest import (
    STATUS_INSTALLING,
    STATUS_READY,
    read_runtime_manifest,
    write_runtime_manifest,
)
from maw.runtime_mirror_picker import pick_fastest_mirror

GET_PIP_SCRIPT: Final = "get-pip.py"

RuntimeEvent = Callable[[str, int, str], None]
RuntimeLine = Callable[[str], None]


class ManagedRuntimeError(RuntimeError):
    """Raised when a managed runtime cannot be installed or used."""


class RuntimeCancelled(ManagedRuntimeError):
    """Raised when the user cancels runtime work or MAW closes."""


@dataclass(frozen=True, slots=True)
class RuntimeSpec:
    """声明式描述一个托管 Runtime 的差异点。

    ``ManagedRuntime`` 只依赖本 spec 实现安装 / 状态 / 路径生命周期；
    新 Runtime（如迁移中的 moss）只需提供一份 spec。

    字段按用途分组：
    - 身份：key / runtime_version / python_version
    - 安装资产与依赖：embed_python_zip / requirements_key（frozen txt 的
      pyproject extra 名）/ requirements_bundle_name / requirements（moss
      迁移期的手写列表，之后删除）/ extra_index_url / cuda_fallback_packages
    - 进度与文案：requirements_emit / ready_emit_done / missing_detail /
      ready_detail / message_prefix / feature_label / fix_action_label
    - 布局：dir_name（app-data 下目录名）/ root_env（覆盖环境变量）/
      bundle_dir（打包版资产目录）
    - 验证与运行：verify_command（python -c 自检）/ package_dirs（site-
      packages 关键包目录）/ worker_module
    - 扩展：model_id / model_id_label（OCR 用）/ has_model_cache（local 用）
    - 异常：error_class / cancelled_class / cancelled_message
    - 迁移标记：install_uv（moss 尚未迁 embedded，占用后删除）
    """

    key: str
    runtime_version: str
    python_version: str
    embed_python_zip: str
    requirements_emit: str
    requirements_key: str
    requirements_bundle_name: str
    verify_command: str
    package_dirs: tuple[str, ...]
    worker_module: str
    message_prefix: str
    feature_label: str
    missing_detail: str
    ready_detail: str
    fix_action_label: str
    ready_emit_done: str
    dir_name: str
    root_env: str
    bundle_dir: str
    # 依赖与模型（可选）
    requirements: tuple[str, ...] | None = None
    extra_index_url: str | None = None
    cuda_fallback_packages: tuple[str, ...] = ()
    model_id: str | None = None
    model_id_label: str | None = None
    has_model_cache: bool = False
    # 异常
    error_class: type[ManagedRuntimeError] = ManagedRuntimeError
    cancelled_class: type[RuntimeCancelled] = RuntimeCancelled
    cancelled_message: str = "运行环境操作已取消。"


@dataclass(frozen=True, slots=True)
class RuntimeStatus:
    """Runtime 无关的状态视图；``to_payload`` 按字段存在性导出 Launcher 负载。"""

    status: str
    ready: bool
    path: str
    python_path: str
    detail: str
    runtime_version: str
    model_cache_path: str = ""
    model_id: str | None = None
    model_label: str | None = None

    def to_payload(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "status": self.status,
            "ready": self.ready,
            "path": self.path,
            "pythonPath": self.python_path,
            "detail": self.detail,
            "runtimeVersion": self.runtime_version,
        }
        if self.model_cache_path:
            payload["modelCachePath"] = self.model_cache_path
        if self.model_id:
            payload["modelId"] = self.model_id
            payload["modelLabel"] = self.model_label or self.model_id
            payload["modelInstalled"] = self.ready
            payload["modelPath"] = self.path
        return payload


# ---------------------------------------------------------------------------
# 目录助手（模型缓存对全部 Runtime 通用；默认 app-data 根对全部 Runtime 通用）
# ---------------------------------------------------------------------------


def default_app_data_root() -> Path:
    override = os.environ.get("MAW_APP_DATA_ROOT", "").strip()
    if override:
        return Path(override).expanduser().resolve(strict=False)
    if os.name == "nt":
        return Path(os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local")) / "MAW"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "MAW"
    return Path(os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share")) / "MAW"


def resolve_model_cache_root(configured: str | Path | None = None) -> Path:
    """Resolve an explicit cache root, then the process-level override."""
    override = str(configured or "").strip() or os.environ.get("MAW_MODEL_CACHE_ROOT", "").strip()
    if override:
        return Path(override).expanduser().resolve(strict=False)
    return default_app_data_root() / "model-cache"


def default_model_cache_root() -> Path:
    return resolve_model_cache_root()


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


# ---------------------------------------------------------------------------
# ManagedRuntime：一个 Runtime 的完整生命周期
# ---------------------------------------------------------------------------


class ManagedRuntime:
    """One runtime lifecycle built on a :class:`RuntimeSpec`."""

    def __init__(self, spec: RuntimeSpec) -> None:
        self.spec = spec

    # -- 路径 -----------------------------------------------------------------

    def resolve_root(self, configured: str | Path | None = None) -> Path:
        """显式配置 -> 进程级环境变量 -> 默认 app-data 目录。"""
        override = str(configured or "").strip() or os.environ.get(self.spec.root_env, "").strip()
        if override:
            return Path(override).expanduser().resolve(strict=False)
        return default_app_data_root() / self.spec.dir_name

    def python_path(self, root: str | Path | None = None) -> Path:
        target = self.resolve_root(root) if root is None else Path(root)
        relative = Path("python") / "python.exe" if os.name == "nt" else Path("python") / "bin" / "python"
        return target / relative

    def site_packages(self, root: str | Path | None = None) -> Path:
        target = self.resolve_root(root) if root is None else Path(root)
        return target / "site-packages"

    def package_dirs_ok(self, root: str | Path | None = None) -> bool:
        """site-packages 里关键包目录是否齐全（spec.package_dirs）。"""
        site = self.site_packages(root)
        return all((site / name).exists() for name in self.spec.package_dirs)

    def bundle_root(self) -> Path:
        """打包版 = bundle 内 runtime 目录；源码模式 = 仓库根。"""
        if getattr(sys, "frozen", False):
            return asset_path(self.spec.bundle_dir)
        return Path(__file__).resolve().parents[2]

    def bundle_path(self, relative: str) -> Path:
        """bundle 内 worker / 数据文件路径（源码模式映射回仓库根）。"""
        if getattr(sys, "frozen", False):
            return asset_path(f"{self.spec.bundle_dir}/{relative}")
        return Path(__file__).resolve().parents[2] / relative

    def requirements_path(self) -> Path:
        """frozen requirements txt（打包版随包分发；源码模式在 build/ 下，由 CI uv export 生成）。"""
        if getattr(sys, "frozen", False):
            path = asset_path(f"{self.spec.bundle_dir}/{self.spec.requirements_bundle_name}")
        else:
            path = Path(__file__).resolve().parents[2] / "build" / self.spec.requirements_bundle_name
        if not path.is_file():
            raise self._error(
                f"{self.spec.message_prefix}依赖清单缺失：" + str(path) + "。"
                "打包版应随包分发；源码运行请先运行 "
                + (
                    "uv pip compile moss-requirements.in -p 3.11 "
                    "--extra-index-url https://download.pytorch.org/whl/cu130 "
                    "--index-strategy unsafe-best-match "
                    f"-o build/{self.spec.requirements_bundle_name}"
                    if self.spec.key == "moss"
                    else (
                        f"uv export --frozen --extra {self.spec.requirements_key} --no-dev "
                        f"--format requirements-txt -o build/{self.spec.requirements_bundle_name}"
                    )
                )
            )
        return path

    # -- 状态 -----------------------------------------------------------------

    def status(
        self,
        *,
        runtime_root: str | Path | None = None,
        model_cache_root: str | Path | None = None,
    ) -> RuntimeStatus:
        """missing / broken / installing / ready，复用 runtime.json manifest。"""
        root = self.resolve_root(runtime_root)
        python = self.python_path(root)
        model_cache = resolve_model_cache_root(model_cache_root) if self.spec.has_model_cache else ""
        if not root.exists():
            return self._status("missing", False, root, "", self.spec.missing_detail, model_cache=model_cache)
        if not python.exists():
            return self._status(
                "broken",
                False,
                root,
                python,
                f"{self.spec.message_prefix}不完整，请点击“{self.spec.fix_action_label}”。",
                model_cache=model_cache,
            )
        manifest = read_runtime_manifest(root)
        if manifest.installing:
            return self._status(
                "installing",
                False,
                root,
                python,
                f"{self.spec.message_prefix}正在安装中，请稍候。",
                manifest.runtime_version or self.spec.runtime_version,
                model_cache=model_cache,
            )
        if not manifest.is_ready_for(self.spec.runtime_version):
            return self._status(
                "broken",
                False,
                root,
                python,
                f"{self.spec.message_prefix}需要修复，请点击“{self.spec.fix_action_label}”。",
                manifest.runtime_version or self.spec.runtime_version,
                model_cache=model_cache,
            )
        if not self.package_dirs_ok(root):
            return self._status(
                "broken",
                False,
                root,
                python,
                f"{self.spec.message_prefix}依赖不完整，请点击“{self.spec.fix_action_label}”。",
                model_cache=model_cache,
            )
        return self._status("ready", True, root, python, self.spec.ready_detail, model_cache=model_cache)

    def _status(
        self,
        status: str,
        ready: bool,
        root: Path,
        python: Path | str,
        detail: str,
        runtime_version: str | None = None,
        *,
        model_cache: str = "",
    ) -> RuntimeStatus:
        return RuntimeStatus(
            status=status,
            ready=ready,
            path=str(root),
            python_path=str(python),
            detail=detail,
            runtime_version=runtime_version or self.spec.runtime_version,
            model_cache_path=model_cache,
            model_id=self.spec.model_id,
            model_label=self.spec.model_id_label,
        )

    # -- 安装 -----------------------------------------------------------------

    def install(
        self,
        *,
        on_event: RuntimeEvent | None = None,
        cancel_event: Event | None = None,
        repair: bool = False,
        runtime_root: str | Path | None = None,
        model_cache_root: str | Path | None = None,
    ) -> RuntimeStatus:
        """Create or repair the runtime: embedded Python -> pip -> verify -> manifest."""
        emit = on_event or (lambda _message, _percent, _stage: None)
        cancel = cancel_event or Event()
        spec = self.spec

        root = self.resolve_root(runtime_root)
        if root.exists() and not root.is_dir():
            raise self._error(f"{spec.message_prefix}路径不能是一个文件：{root}")
        root.parent.mkdir(parents=True, exist_ok=True)

        embed_zip = _find_bootstrap_asset(spec.embed_python_zip)
        get_pip = _find_bootstrap_asset(GET_PIP_SCRIPT)
        if embed_zip is None or get_pip is None:
            raise self._error(
                f"未找到{spec.feature_label}安装资产（embedded Python 或 get-pip.py）。"
                "请使用官方打包版。"
            )

        if self.status(runtime_root=runtime_root, model_cache_root=model_cache_root).ready and not repair:
            emit(spec.ready_emit_done, 100, "ready")
            return self.status(runtime_root=runtime_root, model_cache_root=model_cache_root)

        _may_cancel(cancel, spec)
        python = self.python_path(root)
        if root.exists() and not python.exists() and any(root.iterdir()) and not repair:
            raise self._error(f"{spec.message_prefix}目录已存在但不完整，请更换路径或手动清理后重试。")
        # 安装开始即写入 installing 状态，避免安装过程中被判定为"需要修复"。
        write_runtime_manifest(
            root,
            status=STATUS_INSTALLING,
            runtime_version=spec.runtime_version,
            python_version=spec.python_version,
        )

        emit(f"正在解压嵌入式 {spec.feature_label} Python 运行环境……", 5, "bootstrap")
        python_dir = root / "python"
        if repair or not python.exists():
            if python_dir.exists():
                shutil.rmtree(python_dir)
            _extract_embed_python(embed_zip, python_dir)
        _may_cancel(cancel, spec)
        if not python.exists():
            raise self._error(f"{spec.message_prefix}解压失败：未找到 {python}")

        emit("正在安装 pip……", 12, "bootstrap")
        self.run(
            _get_pip_command(python, get_pip),
            env=self.environment(root, model_cache_root),
            cancel=cancel,
            on_line=_bootstrap_line(emit, 15),
        )
        _may_cancel(cancel, spec)

        emit(spec.requirements_emit, 25, "dependencies")
        requirements_file = self.requirements_path()
        site_packages = self.site_packages(root)
        fastest_index = pick_fastest_mirror()
        self.run(
            _pip_install_command(
                python,
                site_packages,
                requirements_file,
                index_url=fastest_index,
                extra_index_url=spec.extra_index_url,
            ),
            env=self.environment(root, model_cache_root),
            cancel=cancel,
            on_line=_dependency_line(emit, requirements_file),
        )
        _may_cancel(cancel, spec)

        if sys.platform != "darwin" and spec.cuda_fallback_packages and not _has_cuda():
            emit("未检测到 NVIDIA CUDA，切换 Torch 为 CPU 版……", 88, "cuda-fallback")
            cpu_command = _pip_install_command(
                python,
                site_packages,
                None,
                index_url=fastest_index,
                packages=list(spec.cuda_fallback_packages),
            )
            self.run(
                cpu_command,
                env=self.environment(root, model_cache_root),
                cancel=cancel,
                on_line=lambda line: emit(line, 89, "cuda-fallback"),
            )
            _may_cancel(cancel, spec)

        emit(f"正在验证{spec.feature_label}运行时……", 90, "verify")
        verify_command = [str(python), "-c", spec.verify_command]
        self.run(
            verify_command,
            env=self.environment(root, model_cache_root),
            cancel=cancel,
            on_line=lambda line: emit(line, 94, "verify"),
        )
        _may_cancel(cancel, spec)

        extra = {"modelId": spec.model_id} if spec.model_id else None
        write_runtime_manifest(
            root,
            status=STATUS_READY,
            runtime_version=spec.runtime_version,
            python_version=spec.python_version,
            extra=extra,
        )
        if spec.has_model_cache:
            cache_environment = model_cache_environment(model_cache_root)
            for path in (
                resolve_model_cache_root(model_cache_root),
                Path(cache_environment["HF_HUB_CACHE"]),
                Path(cache_environment["MODELSCOPE_CACHE"]),
            ):
                path.mkdir(parents=True, exist_ok=True)
        emit(spec.ready_emit_done, 100, "ready")
        return self.status(runtime_root=runtime_root, model_cache_root=model_cache_root)

    # -- 进程与环境 -----------------------------------------------------------

    def environment(
        self,
        runtime_root: str | Path | None = None,
        model_cache_root: str | Path | None = None,
    ) -> dict[str, str]:
        """Runtime 子进程环境：UTF-8 固定项 + 模型缓存变量 + site-packages PYTHONPATH。"""
        env = dict(os.environ)
        env["PYTHONUNBUFFERED"] = "1"
        env["PYTHONUTF8"] = "1"
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONNOUSERSITE"] = "1"
        if self.spec.has_model_cache:
            env.update(model_cache_environment(model_cache_root))
        if runtime_root is not None:
            env["PYTHONPATH"] = str(self.site_packages(runtime_root))
        return env

    def run(
        self,
        command: list[str],
        *,
        env: Mapping[str, str],
        cancel: Event | None = None,
        on_line: RuntimeLine | None = None,
        cwd: Path | None = None,
    ) -> int:
        """在 runtime 上下文里跑一个可取消子进程树，异常映射到 spec 错误类。"""
        return _run_process(
            command,
            env=env,
            cancel=cancel or Event(),
            on_line=on_line or (lambda _line: None),
            cwd=str(cwd if cwd is not None else self.bundle_root()),
            error_class=self.spec.error_class,
            cancelled_class=self.spec.cancelled_class,
            cancelled_message=self.spec.cancelled_message,
            message_prefix=self.spec.message_prefix,
        )

    def _error(self, message: str) -> ManagedRuntimeError:
        return self.spec.error_class(message)


# ---------------------------------------------------------------------------
# 共享内部工具
# ---------------------------------------------------------------------------


def _find_bootstrap_asset(filename: str) -> Path | None:
    """在 bundle / exe 邻目录 / 源码 build/ 里找安装资产（embedded zip、get-pip.py）。"""
    candidates: list[Path] = [
        asset_path(f"bootstrap/{filename}"),
        Path(sys.executable).resolve().parent / "bootstrap" / filename,
    ]
    if not getattr(sys, "frozen", False):
        candidates.append(Path(__file__).resolve().parents[2] / "build" / filename)
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    return None


def _extract_embed_python(zip_path: Path, target_dir: Path) -> None:
    """解压 embedded Python 并打开 site + target 支持（改 python*._pth）。"""
    target_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as archive:
        archive.extractall(target_dir)
    pth_files = sorted(target_dir.glob("python*._pth"))
    if not pth_files:
        return
    pth_path = pth_files[0]
    text = pth_path.read_text(encoding="utf-8")
    text = text.replace("#import site", "import site")
    # 嵌入版 Python 的 _pth 控制 sys.path 且忽略 PYTHONPATH；把 pip --target
    # 安装目录 ../site-packages 加进去。
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


def _bootstrap_line(emit: RuntimeEvent, percent: int) -> RuntimeLine:
    def report(line: str) -> None:
        text = line.strip()
        if text:
            emit(text, percent, "bootstrap")

    return report


def _dependency_line(emit: RuntimeEvent, requirements_file: Path) -> RuntimeLine:
    """把 pip 的包日志翻译成粗略但诚实的安装进度信号。"""
    markers = _requirement_package_names(requirements_file)
    seen: set[str] = set()

    def report(line: str) -> None:
        text = line.strip()
        if not text:
            return
        folded = text.casefold()
        seen.update(marker for marker in markers if marker in folded)
        emit(text, min(85, 30 + len(seen) * 8), "dependencies")

    return report


def _run_process(
    command: list[str],
    *,
    env: Mapping[str, str],
    cancel: Event,
    on_line: RuntimeLine,
    cwd: str,
    error_class: type[ManagedRuntimeError],
    cancelled_class: type[RuntimeCancelled],
    cancelled_message: str,
    message_prefix: str,
) -> int:
    """运行子进程树，支持取消；失败时优先提取 JSON error 行（OCR worker 协议）。"""
    try:
        process = popen_process_tree(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=dict(env),
            cwd=cwd,
            **process_group_kwargs(),
        )
    except OSError as error:
        raise error_class(f"无法启动{message_prefix}命令：{error}") from error

    output: list[str] = []
    lines: queue.Queue[str | None] = queue.Queue()
    reader = threading.Thread(
        target=_read_process_lines,
        args=(process.stdout, lines),
        name="maw-runtime-output",
        daemon=True,
    )
    reader.start()
    while True:
        if cancel.is_set():
            terminate_process_tree(process)
            raise cancelled_class(cancelled_message)
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
                raise error_class(str(message.get("detail") or f"{message_prefix}命令失败"))
        detail = "\n".join(output[-8:])
        raise error_class(f"{message_prefix}命令失败（退出码 {return_code}）。{detail}")
    return return_code


def _read_process_lines(stdout: TextIO | None, lines: queue.Queue[str | None]) -> None:
    try:
        if stdout is not None:
            for line in stdout:
                lines.put(line)
    finally:
        lines.put(None)


def _may_cancel(cancel: Event, spec: RuntimeSpec) -> None:
    if cancel.is_set():
        raise spec.cancelled_class(spec.cancelled_message)