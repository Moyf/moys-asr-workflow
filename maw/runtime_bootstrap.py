"""托管 Runtime 共用的跨平台 Python 引导资产与解压逻辑。"""

from __future__ import annotations

import hashlib
import os
import platform
import shutil
import stat
import tarfile
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Final, Literal


ArchiveFormat = Literal["zip", "tar.gz"]


class RuntimeBootstrapError(RuntimeError):
    """引导平台不受支持或归档不安全、不完整。"""


@dataclass(frozen=True, slots=True)
class BootstrapAsset:
    """可重复下载并校验的单个构建资产。"""

    filename: str
    url: str
    sha256: str


@dataclass(frozen=True, slots=True)
class PythonBootstrap:
    """一个受支持平台的 Python 引导契约。"""

    key: str
    asset: BootstrapAsset
    archive_format: ArchiveFormat
    archive_root: str
    python_relative_path: str


GET_PIP_ASSET: Final = BootstrapAsset(
    filename="get-pip.py",
    url=(
        "https://raw.githubusercontent.com/pypa/get-pip/"
        "f6f644156f23dfe9acc06e7b9ca75eee311f2e37/public/get-pip.py"
    ),
    sha256="fb24e693bab954209a063d90953621412ccad4a500905a726286e038f508ddf6",
)

_BOOTSTRAPS: Final[dict[str, PythonBootstrap]] = {
    "windows-x86_64": PythonBootstrap(
        key="windows-x86_64",
        asset=BootstrapAsset(
            filename="python-3.11.9-embed-amd64.zip",
            url="https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip",
            sha256="009d6bf7e3b2ddca3d784fa09f90fe54336d5b60f0e0f305c37f400bf83cfd3b",
        ),
        archive_format="zip",
        archive_root="",
        python_relative_path="python.exe",
    ),
    "macos-arm64": PythonBootstrap(
        key="macos-arm64",
        asset=BootstrapAsset(
            filename=(
                "cpython-3.11.16+20260825-aarch64-apple-darwin-"
                "install_only_stripped.tar.gz"
            ),
            url=(
                "https://github.com/astral-sh/python-build-standalone/releases/download/"
                "20260825/cpython-3.11.16%2B20260825-aarch64-apple-darwin-"
                "install_only_stripped.tar.gz"
            ),
            sha256="a84adc050a29e0c7387c885ff13e6ac4b0027f9e841359e200d647313dbb5b03",
        ),
        archive_format="tar.gz",
        archive_root="python",
        python_relative_path="bin/python",
    ),
    "linux-x86_64": PythonBootstrap(
        key="linux-x86_64",
        asset=BootstrapAsset(
            filename=(
                "cpython-3.11.16+20260825-x86_64-unknown-linux-gnu-"
                "install_only_stripped.tar.gz"
            ),
            url=(
                "https://github.com/astral-sh/python-build-standalone/releases/download/"
                "20260825/cpython-3.11.16%2B20260825-x86_64-unknown-linux-gnu-"
                "install_only_stripped.tar.gz"
            ),
            sha256="232f75c9dd6733b41a8101b5076b2a248360722dedded5688f4ac7d5931d8eac",
        ),
        archive_format="tar.gz",
        archive_root="python",
        python_relative_path="bin/python",
    ),
}


def supported_bootstrap_keys() -> tuple[str, ...]:
    """返回发布管线明确支持的平台键。"""
    return tuple(_BOOTSTRAPS)


def bootstrap_for_key(key: str) -> PythonBootstrap:
    """按发布平台键取固定引导契约。"""
    try:
        return _BOOTSTRAPS[key]
    except KeyError as error:
        raise RuntimeBootstrapError(
            f"不支持的 Python 引导平台：{key}（可选：{', '.join(_BOOTSTRAPS)}）"
        ) from error


def current_bootstrap_key(*, system: str | None = None, machine: str | None = None) -> str:
    """把当前系统与架构规范化为发布平台键。"""
    system_name = (system or platform.system()).strip().casefold()
    machine_name = (machine or platform.machine()).strip().casefold().replace("-", "_")
    if machine_name in {"amd64", "x64"}:
        machine_name = "x86_64"
    elif machine_name == "aarch64":
        machine_name = "arm64"

    if system_name in {"windows", "win32"} and machine_name == "x86_64":
        return "windows-x86_64"
    if system_name in {"darwin", "macos"} and machine_name == "arm64":
        return "macos-arm64"
    if system_name == "linux" and machine_name == "x86_64":
        return "linux-x86_64"
    raise RuntimeBootstrapError(
        f"当前平台没有可用的 Python 引导包：{system_name}/{machine_name}"
    )


def current_python_bootstrap() -> PythonBootstrap:
    """取当前运行平台的 Python 引导契约。"""
    return bootstrap_for_key(current_bootstrap_key())


def asset_matches(path: Path, asset: BootstrapAsset) -> bool:
    """流式校验引导资产，避免损坏文件进入构建或安装流程。"""
    if not path.is_file():
        return False
    digest = hashlib.sha256()
    try:
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError:
        return False
    return digest.hexdigest() == asset.sha256


def extract_python_bootstrap(
    archive_path: Path,
    target_dir: Path,
    bootstrap: PythonBootstrap | None = None,
) -> Path:
    """安全解压平台 Python，返回可执行文件路径。"""
    selected = bootstrap or current_python_bootstrap()
    target_dir.parent.mkdir(parents=True, exist_ok=True)
    if target_dir.exists():
        raise RuntimeBootstrapError(f"Python 引导目标已存在：{target_dir}")

    try:
        if selected.archive_format == "zip":
            _extract_zip_safely(archive_path, target_dir)
            _enable_embedded_site(target_dir)
        elif selected.archive_format == "tar.gz":
            _extract_tar_safely(archive_path, target_dir, selected.archive_root)
        else:  # pragma: no cover - Literal + fixed registry guard this branch
            raise RuntimeBootstrapError(f"不支持的 Python 归档格式：{selected.archive_format}")

        python = target_dir / selected.python_relative_path
        if not python.is_file():
            raise RuntimeBootstrapError(f"Python 引导包缺少入口：{python}")
        if os.name != "nt":
            python.chmod(python.stat().st_mode | stat.S_IXUSR)
        return python
    except Exception:
        if target_dir.exists():
            shutil.rmtree(target_dir)
        raise


def _safe_archive_name(name: str) -> PurePosixPath:
    normalized = PurePosixPath(name.replace("\\", "/"))
    if normalized.is_absolute() or not normalized.parts or ".." in normalized.parts:
        raise RuntimeBootstrapError(f"Python 引导归档包含越界路径：{name}")
    if normalized.parts[0].endswith(":"):
        raise RuntimeBootstrapError(f"Python 引导归档包含绝对路径：{name}")
    return normalized


def _safe_link_name(name: str) -> PurePosixPath:
    """链接允许合法的 ``..``，最终是否越界由解析后路径判断。"""
    normalized = PurePosixPath(name.replace("\\", "/"))
    if normalized.is_absolute() or not normalized.parts:
        raise RuntimeBootstrapError(f"Python 引导归档包含绝对链接：{name}")
    if normalized.parts[0].endswith(":"):
        raise RuntimeBootstrapError(f"Python 引导归档包含绝对链接：{name}")
    return normalized


def _extract_zip_safely(archive_path: Path, target_dir: Path) -> None:
    try:
        with zipfile.ZipFile(archive_path) as archive:
            for item in archive.infolist():
                _safe_archive_name(item.filename)
            target_dir.mkdir(parents=True, exist_ok=False)
            archive.extractall(target_dir)
            for item in archive.infolist():
                mode = (item.external_attr >> 16) & 0o777
                extracted = target_dir.joinpath(*_safe_archive_name(item.filename).parts)
                if mode and extracted.exists() and not extracted.is_symlink():
                    extracted.chmod(mode)
    except (OSError, zipfile.BadZipFile) as error:
        raise RuntimeBootstrapError(f"Python ZIP 解压失败：{error}") from error


def _extract_tar_safely(archive_path: Path, target_dir: Path, archive_root: str) -> None:
    with tempfile.TemporaryDirectory(prefix="maw-python-bootstrap-") as temp_name:
        temp_root = Path(temp_name).resolve()
        try:
            with tarfile.open(archive_path, mode="r:gz") as archive:
                members = archive.getmembers()
                for member in members:
                    if not (
                        member.isfile()
                        or member.isdir()
                        or member.issym()
                        or member.islnk()
                    ):
                        raise RuntimeBootstrapError(
                            f"Python 引导归档包含不支持的特殊文件：{member.name}"
                        )
                    member_path = _safe_archive_name(member.name)
                    destination = (temp_root / Path(*member_path.parts)).resolve(strict=False)
                    if destination != temp_root and temp_root not in destination.parents:
                        raise RuntimeBootstrapError(
                            f"Python 引导归档包含越界路径：{member.name}"
                        )
                    if member.issym() or member.islnk():
                        link_name = _safe_link_name(member.linkname)
                        link_base = destination.parent if member.issym() else temp_root
                        link_target = (link_base / Path(*link_name.parts)).resolve(strict=False)
                        if link_target != temp_root and temp_root not in link_target.parents:
                            raise RuntimeBootstrapError(
                                f"Python 引导归档包含越界链接：{member.name}"
                            )
                archive.extractall(temp_root)
        except (OSError, tarfile.TarError) as error:
            raise RuntimeBootstrapError(f"Python tar 解压失败：{error}") from error

        source = temp_root.joinpath(*_safe_archive_name(archive_root).parts)
        if not source.is_dir():
            raise RuntimeBootstrapError(f"Python 引导归档缺少根目录：{archive_root}")
        shutil.copytree(source, target_dir, symlinks=True)


def _enable_embedded_site(target_dir: Path) -> None:
    pth_files = sorted(target_dir.glob("python*._pth"))
    if not pth_files:
        return
    pth_path = pth_files[0]
    text = pth_path.read_text(encoding="utf-8")
    text = text.replace("#import site", "import site")
    if "../site-packages" not in text:
        text = text.rstrip() + "\n../site-packages\n"
    pth_path.write_text(text, encoding="utf-8", newline="\n")


__all__ = [
    "BootstrapAsset",
    "GET_PIP_ASSET",
    "PythonBootstrap",
    "RuntimeBootstrapError",
    "asset_matches",
    "bootstrap_for_key",
    "current_bootstrap_key",
    "current_python_bootstrap",
    "extract_python_bootstrap",
    "supported_bootstrap_keys",
]
