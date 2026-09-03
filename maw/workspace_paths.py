"""MAW 自动生成文件的统一目录规则。"""

from __future__ import annotations

import re
from pathlib import Path


WORKSPACE_SUFFIX = " - MAW工作文件"
ORIGINAL_ARTIFACTS_DIRNAME = "原始工程与字幕"
FINISHED_DIRNAME = "成片"
CACHE_DIRNAME = "缓存与备份"
_INVALID_COMPONENT_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
_WINDOWS_RESERVED_STEMS = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{index}" for index in range(1, 10)),
    *(f"LPT{index}" for index in range(1, 10)),
}


def sanitize_component(value: object, fallback: str = "视频") -> str:
    """生成可在 macOS、Windows 与 Linux 使用的目录或文件主名。"""

    raw = str(value or "").strip()
    sanitized = _INVALID_COMPONENT_CHARS.sub("_", raw).strip(" .")
    if sanitized in {"", ".", ".."}:
        sanitized = _INVALID_COMPONENT_CHARS.sub("_", fallback).strip(" .") or "视频"
    if sanitized.split(".", 1)[0].upper() in _WINDOWS_RESERVED_STEMS:
        sanitized += "_"
    return sanitized[:160]


def find_workspace_root(path: Path | str) -> Path | None:
    """从工作目录内任意文件反查最外层 MAW 工作目录。"""

    candidate = Path(path).expanduser().resolve(strict=False)
    current = candidate if candidate.name.endswith(WORKSPACE_SUFFIX) or candidate.is_dir() else candidate.parent
    for directory in (current, *current.parents):
        if directory.name.endswith(WORKSPACE_SUFFIX):
            return directory
    return None


def workspace_root(media_path: Path | str) -> Path:
    """返回媒体对应的“视频名 - MAW工作文件”目录。"""

    media = Path(media_path).expanduser().resolve(strict=False)
    existing = find_workspace_root(media)
    if existing is not None:
        return existing
    stem = sanitize_component(media.stem, "视频")
    return media.parent / f"{stem}{WORKSPACE_SUFFIX}"


def original_artifacts_directory(media_path: Path | str) -> Path:
    return workspace_root(media_path) / ORIGINAL_ARTIFACTS_DIRNAME


def finished_directory(media_path: Path | str) -> Path:
    return workspace_root(media_path) / FINISHED_DIRNAME


def cache_directory(media_path: Path | str) -> Path:
    return workspace_root(media_path) / CACHE_DIRNAME


def ensure_workspace_layout(media_path: Path | str) -> Path:
    """创建完整工作目录并返回根目录。"""

    root = workspace_root(media_path)
    for directory in (
        root / ORIGINAL_ARTIFACTS_DIRNAME,
        root / FINISHED_DIRNAME,
        root / CACHE_DIRNAME,
    ):
        directory.mkdir(parents=True, exist_ok=True)
    return root


def waveform_cache_path(media_path: Path | str) -> Path:
    media = Path(media_path).expanduser().resolve(strict=False)
    return cache_directory(media) / f"{sanitize_component(media.name, '媒体')}.waveform.json"


def reapeaks_cache_path(media_path: Path | str) -> Path:
    media = Path(media_path).expanduser().resolve(strict=False)
    return cache_directory(media) / f"{sanitize_component(media.name, '媒体')}.ReaPeaks"
