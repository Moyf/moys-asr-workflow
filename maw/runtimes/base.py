"""Shared plumbing for user-managed runtimes (local ASR / OCR / moss).

The Launcher installs optional inference dependencies into separate Python
environments under the user's app-data directory instead of growing the
frozen MAW package.  Every managed runtime shares the same lifecycle:

    [Windows 打包] embedded Python 解压 -> get-pip ->
        pip install --target -r frozen txt（引导资产随包分发）
    [unix 打包]   宿主 python3 -m venv -> venv 内 pip 直装同一份 frozen txt
        （不内嵌解释器，产物不携带 unix 用不到的引导资产）
    [源码模式]    零下载 —— 检测开发环境的 uv，直接
        ``uv pip install -r frozen txt --target <site-packages>``，
        自检/worker 复用 MAW 自己的解释器。

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

from maw.app_paths import default_app_data_root
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
from maw.runtimes import freezer

GET_PIP_SCRIPT: Final = "get-pip.py"

# 源码模式对开发环境的硬性要求（uv 用于托管依赖冻结与 --target 安装）。
UV_MISSING_WARNING: Final = (
    "未检测到 uv。源码模式安装/修复运行环境需要它——"
    'Windows PowerShell 执行 powershell -c "irm https://astral.sh/uv/install.ps1 | iex"；'
    "macOS / Linux 执行 curl -LsSf https://astral.sh/uv/install.sh | sh；"
    "安装后重启 MAW 再重试。"
)

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
      迁移期的手写列表，之后删除）/ requirements_in（主清单用 uv pip
      compile 冻结的 in 文件；None 则 uv export extra）/ requirements_in_args
      （compile 附加参数，如 moss 的 pytorch cu130 index）/
      extra_index_url / cuda_fallback_packages
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
    # 主清单声明源：非 None 时用 uv pip compile <in>（moss——与 local 的
    # Transformers 互斥而独立声明）；None 时用 uv export --extra requirements_key
    # （依赖声明于 pyproject optional-dependencies）。CPU 变体的冻结配方
    # 由 maw/runtimes/freezer.py 按本字段与 cuda_fallback_packages 推导。
    requirements_in: str | None = None
    requirements_in_args: tuple[str, ...] = ()
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


def _build_dir() -> Path:
    """源码模式的冻结清单目录（<repo>/build；gitignored，首次安装自动补齐）。"""
    return Path(__file__).resolve().parents[2] / "build"


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
        # unix 打包版走宿主 python3 的 venv（root/bin/python）；Windows 打包版
        # 用 bundle 内嵌解释器（root/python/python.exe）；源码模式沿用 embedded
        # 布局约定（仅作占位路径，实际解释器由 :meth:`interpreter` 决定）。
        if _uses_host_venv():
            return target / "bin" / "python"
        # python 可执行文件相对布局（win 内嵌流 python/python.exe；unix venv
        # python/bin/python）。用 sys.platform 而非 os.name：mock 友好且对
        # pathlib 无副作用（见 default_app_data_root 注释）。
        relative = Path("python") / "python.exe" if sys.platform == "win32" else Path("python") / "bin" / "python"
        return target / relative

    def interpreter(self, root: str | Path | None = None) -> Path:
        """实际执行自检 / worker 的解释器。

        打包版 = 托管环境内的解释器（Windows 内嵌 Python / unix 宿主 venv）；
        源码模式 = MAW 自己的开发环境解释器（依赖通过 ``--target site-packages``
        + PYTHONPATH 接入），因此源码模式不需要下载任何 bootstrap 资产。
        """
        if not getattr(sys, "frozen", False):
            return Path(sys.executable).resolve()
        return self.python_path(root)

    def site_packages(self, root: str | Path | None = None) -> Path:
        target = self.resolve_root(root) if root is None else Path(root)
        if _uses_host_venv():
            # venv 的 site-packages 按 python 版本分目录（lib/python3.x/site-packages）。
            candidates = sorted(target.glob("lib/python*/site-packages"))
            return candidates[0] if candidates else target / "lib" / "site-packages"
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

    def requirements_path(self, *, cpu: bool = False) -> Path:
        """frozen requirements txt（打包版随包分发；源码模式在 build/ 下，由 CI 生成）。

        传 ``cpu=True`` 时返回 `requirements-{key}-cpu.txt`：构建期由
        ``maw.runtimes.freezer`` 从声明源（uv export 直接依赖 / in 文件）
        剥离 GPU 参数后原生冻结的 CPU 清单，带 CPU wheel 真实哈希，供无
        NVIDIA GPU 的机器一次性安装 CPU Torch（与 cu130 清单并列打包，
        运行时不再做文本转换）。
        """
        bundle_name = self.spec.requirements_bundle_name
        if cpu:
            bundle_name = bundle_name[: -len(".txt")] + "-cpu.txt"
        if getattr(sys, "frozen", False):
            path = asset_path(f"{self.spec.bundle_dir}/{bundle_name}")
        else:
            path = _build_dir() / bundle_name
        if not path.is_file():
            kind = "CPU 版依赖清单" if cpu else "依赖清单"
            raise self._error(
                f"{self.spec.message_prefix}{kind}缺失：" + str(path) + "。"
                "打包版应随包分发；源码模式在「安装/修复」时会用 uv 按构建"
                "管线同源逻辑自动补齐（见 maw/runtimes/freezer.py），"
                + (
                    "请检查该命令的输出来定位失败原因后重试"
                    if cpu
                    else "或手动执行对应命令生成"
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
        python = self.interpreter(root)
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
            model_cache_path=str(model_cache),
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
        """Create or repair the managed runtime environment.

        Windows 打包版：bootstrap embedded Python -> pip -> verify -> manifest；
        unix 打包版：宿主 python3 建 venv -> venv 内 pip 直装同一份 frozen 清单；
        源码模式：uv --target 接入开发解释器（无解压 / get-pip 步骤）。
        """
        emit = on_event or (lambda _message, _percent, _stage: None)
        cancel = cancel_event or Event()
        spec = self.spec

        root = self.resolve_root(runtime_root)
        if root.exists() and not root.is_dir():
            raise self._error(f"{spec.message_prefix}路径不能是一个文件：{root}")
        root.parent.mkdir(parents=True, exist_ok=True)

        # 引导策略按运行形态分叉：打包版（Windows）依赖随包分发的 bootstrap
        # 资产；打包版（unix）用宿主 python3 建 venv，无需任何 bundle 资产；
        # 源码模式零下载，复用开发环境现成的 uv 与解释器。
        frozen = bool(getattr(sys, "frozen", False))
        host_venv = _uses_host_venv()
        embed_zip: Path | None = None
        get_pip: Path | None = None
        uv_executable: Path | None = None
        if not frozen:
            found_uv = shutil.which("uv")
            uv_executable = Path(found_uv) if found_uv else None
            if uv_executable is None:
                # 先发进度事件（Launcher 日志可见），再以可操作文案中断安装。
                emit(f"[警告] {UV_MISSING_WARNING}", 5, "bootstrap")
                raise self._error(
                    f"源码模式安装{spec.feature_label}需要 uv。" + UV_MISSING_WARNING
                )
        elif not host_venv:
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
        python = self.interpreter(root)
        if root.exists() and not python.exists() and any(root.iterdir()) and not repair:
            raise self._error(f"{spec.message_prefix}目录已存在但不完整，请更换路径或手动清理后重试。")
        # 安装开始即写入 installing 状态，避免安装过程中被判定为"需要修复"。
        write_runtime_manifest(
            root,
            status=STATUS_INSTALLING,
            runtime_version=spec.runtime_version,
            python_version=spec.python_version,
        )

        emit(f"正在准备{spec.feature_label}运行环境……", 5, "bootstrap")
        if frozen and host_venv:
            self._prepare_host_venv(
                root,
                python,
                repair=repair,
                emit=emit,
                cancel=cancel,
                model_cache_root=model_cache_root,
            )
            _may_cancel(cancel, spec)
        elif frozen:
            python_dir = root / "python"
            if repair or not self.python_path(root).exists():
                if python_dir.exists():
                    shutil.rmtree(python_dir)
                _extract_embed_python(embed_zip, python_dir)
            _may_cancel(cancel, spec)

            emit("正在安装 pip……", 12, "bootstrap")
            self.run(
                _get_pip_command(self.python_path(root), get_pip),
                env=self.environment(root, model_cache_root),
                cancel=cancel,
                on_line=_bootstrap_line(emit, 15),
            )
            _may_cancel(cancel, spec)
        if frozen and not python.exists():
            raise self._error(f"{spec.message_prefix}Python 环境创建失败：未找到 {python}")

        emit(spec.requirements_emit, 25, "dependencies")
        # CUDA 兜底判定需先于清单获取：决定补齐/读取哪份 frozen txt。
        # 无 NVIDIA GPU（非 darwin）时直接使用构建期冻结的 CPU 版清单
        # （requirements-{key}-cpu.txt，原生 CPU wheel 版本与哈希，不附加
        # cu130 index），一次性安装 CPU Torch，避免先下载完整 cu130 wheel
        # 与 nvidia-* 依赖再覆盖（PR review 3862518679）。
        needs_cpu_fallback = sys.platform != "darwin" and spec.cuda_fallback_packages and not _has_cuda()
        if not frozen:
            # 全新 clone 的 build/ 下没有清单；源码模式已具备 uv，按构建管线
            # 同款命令自动补齐，实现首次安装零手工步骤。
            self._ensure_frozen_requirements(
                uv_executable,
                cpu=needs_cpu_fallback,
                emit=emit,
                cancel=cancel,
            )
        requirements_file = self.requirements_path()
        site_packages = self.site_packages(root)
        fastest_index = pick_fastest_mirror()
        requirements_arg = requirements_file
        extra_index = spec.extra_index_url
        if needs_cpu_fallback:
            emit("未检测到 NVIDIA CUDA，改用 CPU 版 Torch……", 25, "dependencies")
            requirements_arg = self.requirements_path(cpu=True)
            extra_index = None
        # 安装方式三分支：unix 打包版 venv 直装（venv 自带 pip，无需 --target）；
        # Windows 打包版 pip --target 定向安装；源码模式 uv 接入开发解释器。
        if frozen and host_venv:
            install_command = _venv_pip_install_command(
                python,
                index_url=fastest_index,
                extra_index_url=extra_index,
                requirements_file=requirements_arg,
            )
        elif frozen:
            install_command = _pip_install_command(
                self.python_path(root),
                site_packages,
                requirements_arg,
                index_url=fastest_index,
                extra_index_url=extra_index,
            )
        else:
            install_command = _uv_install_command(
                uv_executable,
                python,
                site_packages,
                requirements_arg,
                index_url=fastest_index,
                extra_index_url=extra_index,
            )
        self.run(
            install_command,
            env=self.environment(root, model_cache_root),
            cancel=cancel,
            on_line=_dependency_line(emit, requirements_arg),
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

    def _prepare_host_venv(
        self,
        root: Path,
        python: Path,
        *,
        repair: bool,
        emit: RuntimeEvent,
        cancel: Event,
        model_cache_root: str | Path | None,
    ) -> None:
        """unix 打包版：用宿主 python3 创建 venv（bundle 不携带内嵌资产）。"""
        spec = self.spec
        host = shutil.which("python3")
        if host is None:
            raise self._error(
                f"未找到宿主 python3。{spec.message_prefix}依赖系统安装的 Python 3.11+"
                "（unix 平台不再内嵌解释器）；请安装后重试。"
            )
        probe = subprocess.run(
            [host, "-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )
        if probe.returncode != 0:
            raise self._error(f"宿主 python3 版本过低：{spec.message_prefix}需要 Python 3.11+。")
        emit(f"正在创建 {spec.feature_label} Python 虚拟环境（宿主 python3）……", 5, "bootstrap")
        venv_args = [host, "-m", "venv"]
        if repair:
            # 修复时重建：root 已在安装开始写 installing manifest 时创建，
            # 不能在初次安装因 root 已存在而 --clear（会清掉 installing 状态）。
            venv_args.append("--clear")
        venv_args.append(str(root))
        self.run(
            venv_args,
            env=self.environment(root, model_cache_root),
            cancel=cancel,
            on_line=_bootstrap_line(emit, 10),
        )

    def _ensure_frozen_requirements(
        self,
        uv_executable: Path | None,
        *,
        cpu: bool,
        emit: RuntimeEvent,
        cancel: Event,
    ) -> None:
        """源码模式：缺 frozen 清单时用开发环境的 uv 自动补齐（幂等）。

        全新 clone 的 ``build/`` 是 gitignored 的 CI 产物，初始为空。既然源码
        安装已约定必须具备 uv，这里委托 ``maw.runtimes.freezer`` 执行与三
        条构建管线（build-windows.ps1 / build-appimage.sh / release.yml）
        完全同源的冻结逻辑，使首次安装零手工步骤；清单已存在则直接返回。
        """
        if uv_executable is None:
            # 理论上不可达：install() 门槛已保证 uv 存在；防御时给出同款警告。
            emit(f"[警告] {UV_MISSING_WARNING}", 22, "bootstrap")
            raise self._error(UV_MISSING_WARNING)
        # 清单已可用（打包版随包分发 / 此前已生成）则直接跳过：requirements_path
        # 才是权威判定，避免对 build/ 目录的偶然状态敏感（干净 checkout 的
        # build/ 为空，但在线用户无需任何冻结步骤）。
        try:
            self.requirements_path(cpu=cpu)
            return
        except self.spec.error_class:
            pass

        def run(command: list[str]) -> int:
            return self.run(
                command,
                env=self.environment(),
                cancel=cancel,
                on_line=_bootstrap_line(emit, 23),
                cwd=_build_dir().parent,
            )

        def notify(message: str) -> None:
            emit(message, 22, "bootstrap")

        try:
            freezer.ensure_frozen(
                uv_executable,
                self.spec,
                cpu=cpu,
                build_dir=_build_dir(),
                run=run,
                emit=notify,
            )
        except self.spec.error_class as error:
            raise self._error(f"自动生成依赖清单失败：{error}") from error
        if cpu and not self.spec.cuda_fallback_packages:
            # 该 runtime 无 CPU 变体（ocr 无 CUDA 组件）；交回上层用
            # requirements_path 的缺失报错给出明确指引，而不是装错清单。
            return
        # 重试读取；仍缺失说明命令未产出文件，让 requirements_path 报最终
        # 缺失错误（含目标路径，便于排查）。
        try:
            self.requirements_path(cpu=cpu)
        except self.spec.error_class as verify_error:
            raise self._error(f"自动生成依赖清单后仍未找到文件：{verify_error}") from verify_error

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


def _uses_host_venv() -> bool:
    """打包形态的平台差异：unix 打包版用宿主 python3 创建的 venv。

    仅在 ``sys.frozen``（官方打包版）且非 Windows 时成立；源码模式依赖开发
    环境自己的 uv 与解释器，托管目录布局与 Windows 打包版一致（扁平
    site-packages）。
    """
    return bool(getattr(sys, "frozen", False)) and sys.platform != "win32"


def _find_bootstrap_asset(filename: str) -> Path | None:
    """在 bundle / exe 邻目录里找安装资产（embedded zip、get-pip.py）。

    仅打包版安装流程使用；源码模式走 uv（见 :meth:`ManagedRuntime.install`）。
    """
    candidates: list[Path] = [
        asset_path(f"bootstrap/{filename}"),
        Path(sys.executable).resolve().parent / "bootstrap" / filename,
    ]
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


def _uv_install_command(
    uv_executable: Path | None,
    interpreter: Path,
    target_dir: Path,
    requirements_file: Path | None,
    *,
    index_url: str = "https://pypi.org/simple",
    extra_index_url: str | None = None,
) -> list[str]:
    """Build the source-mode install command: reuse the dev interpreter, no downloads.

    ``uv`` 自带锁定解析与并行下载；``--python`` 指向 MAW 自己的 venv 解释器，
    依赖经 ``--target site-packages`` 与打包版保持同一目录布局，因此
    status / verify / worker 启动逻辑在两种模式下完全一致。
    """
    if uv_executable is None:
        raise ManagedRuntimeError("源码模式安装需要 uv（https://docs.astral.sh/uv/）。")
    command = [
        str(uv_executable),
        "pip",
        "install",
        "--python",
        str(interpreter),
        "--target",
        str(target_dir),
        # 镜像快照可能缺少某个锁定的精确版本（如 torch 生态传递依赖）；
        # 与 moss 清单冻结管线一致采用聚合索引策略，避免 first-index-wins 误杀。
        "--index-strategy",
        "unsafe-best-match",
        "--index-url",
        index_url,
    ]
    if extra_index_url:
        command.extend(["--extra-index-url", extra_index_url])
    if requirements_file is not None:
        command.extend(["-r", str(requirements_file)])
    return command


def _venv_pip_install_command(
    python_exe: Path,
    *,
    index_url: str = "https://pypi.org/simple",
    extra_index_url: str | None = None,
    requirements_file: Path | None = None,
) -> list[str]:
    """Build the pip install command inside a host venv（无 --target，直装 venv）。"""
    command = [
        str(python_exe), "-m", "pip", "install", "--upgrade",
        "--index-url", index_url,
    ]
    if extra_index_url:
        command.extend(["--extra-index-url", extra_index_url])
    if requirements_file is not None:
        command.extend(["-r", str(requirements_file)])
    return command


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