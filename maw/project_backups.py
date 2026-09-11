"""Timestamped snapshots scoped to a server-bound project."""

from datetime import datetime
import json
import os
from pathlib import Path
import re
import tempfile

from send2trash import send2trash

from maw.output_naming import BACKUP_DIR_NAMES, resolve_lang
from maw.project_io import strip_inline_caches


def _backup_root(project: Path) -> Path:
    parent = project.parent
    return parent if parent.name.endswith("_maw") else parent / "_maw"


def backup_directory(project: Path, lang: str | None = None) -> Path:
    """当前 UI 语言命名的备份目录（zh「备份」/ en「backups」），写入点。"""
    return _backup_root(project) / BACKUP_DIR_NAMES[resolve_lang(lang)]


def backup_directory_candidates(project: Path, lang: str | None = None) -> list[Path]:
    """按优先级排列的备份目录候选：当前语言命名在前，另一种语言命名兜底。

    供「打开备份文件夹」等读取端兼容用户切换界面语言前的旧目录。
    """
    language = resolve_lang(lang)
    current = BACKUP_DIR_NAMES[language]
    names = [current, *(name for name in BACKUP_DIR_NAMES.values() if name != current)]
    root = _backup_root(project)
    return [root / name for name in names]


_VERSION_NAME_RE = re.compile(r"^.+-(\d{4}-\d{2}-\d{2}_\d{6})(?:-(\d{6}))?\.mosp-bak$")


def _version_order(path: Path) -> tuple:
    """按文件名里的时间戳与同秒序号排序，避免 mtime 相同时错删较新版本。"""
    match = _VERSION_NAME_RE.fullmatch(path.name)
    if match is None:
        return ("", -1)
    sequence = int(match.group(2)) if match.group(2) else 0
    return (match.group(1), sequence)


def write_backup(project: Path, data: dict, limit: int) -> Path:
    """Publish a complete snapshot before pruning only this project's versions."""
    if type(limit) is not int or not 1 <= limit <= 1000:
        raise ValueError("最大保存版本数必须为 1–1000 的整数")
    directory = backup_directory(project)
    directory.mkdir(parents=True, exist_ok=True)
    if directory.is_symlink() or directory.resolve() != directory.absolute():
        raise ValueError("备份目录不能通过链接指向其他位置")
    stamp = datetime.now().strftime("%Y-%m-%d_%H%M%S")
    target = directory / f"{project.stem}-{stamp}.mosp-bak"
    sequence = 0
    while target.exists():
        sequence += 1
        target = directory / f"{project.stem}-{stamp}-{sequence:06d}.mosp-bak"
    fd, temporary = tempfile.mkstemp(prefix=".backup-", suffix=".tmp", dir=directory)
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as output:
        json.dump(strip_inline_caches(data), output, ensure_ascii=False, indent=2)
        output.write("\n")
    os.replace(temporary, target)
    pattern = re.compile(re.escape(project.stem) + r"-\d{4}-\d{2}-\d{2}_\d{6}(?:-\d{6})?\.mosp-bak$")
    versions = sorted(
        (p for p in directory.iterdir() if pattern.fullmatch(p.name) and p.is_file() and not p.is_symlink()),
        key=_version_order,
    )
    for old in versions[:-limit]:
        send2trash(str(old))
    return target
