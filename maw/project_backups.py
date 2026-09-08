"""Timestamped snapshots scoped to a server-bound project."""

from datetime import datetime
import json
import os
from pathlib import Path
import re
import tempfile

from send2trash import send2trash

from maw.project_io import strip_inline_caches


def backup_directory(project: Path) -> Path:
    parent = project.parent
    root = parent if parent.name.endswith("_maw") else parent / "_maw"
    return root / "backups"


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
        key=lambda p: (p.stat().st_mtime_ns, p.name),
    )
    for old in versions[:-limit]:
        send2trash(str(old))
    return target
