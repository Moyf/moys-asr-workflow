"""Launcher 侧只读的最近工程列表。

数据由编辑器服务器拥有：``server-editor/serve.py`` 把 ``recent_projects``
持久化在 ``server-editor-settings.json``。该模块会连带引入整个编辑器栈
（``edit``、波形、缩略图任务等），Launcher GUI 进程不能 import 它；这里
保持同一套宽容读取语义（按 resolve 后路径去重、name 回落文件名、上限
10 条），与 serve.py 的对齐由 ``tests/test_recent_projects.py`` 守护。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Final

from maw.app_paths import default_server_settings_path, legacy_server_settings_path

MAX_RECENT_PROJECTS: Final = 10


def read_recent_projects(path: Path) -> list[dict[str, object]]:
    """Read the recent list from one settings file; malformed input yields [].

    Entries need a string ``path``; duplicates are collapsed by resolved
    path, ``name`` falls back to the file name, and at most
    ``MAX_RECENT_PROJECTS`` entries are kept.  Missing files are marked
    with ``exists: False`` (mirroring the editor's payload).
    """
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, UnicodeError, json.JSONDecodeError):
        return []
    if not isinstance(payload, dict):
        return []
    values = payload.get("recent_projects", [])
    if not isinstance(values, list):
        return []

    projects: list[dict[str, object]] = []
    seen: set[Path] = set()
    for value in values:
        if not isinstance(value, dict) or not isinstance(value.get("path"), str):
            continue
        try:
            project_path = Path(value["path"]).expanduser().resolve()
        except OSError:
            continue
        if project_path in seen:
            continue
        seen.add(project_path)
        name = value.get("name")
        entry: dict[str, object] = {
            "path": str(project_path),
            "name": name if isinstance(name, str) and name else project_path.name,
        }
        if not project_path.is_file():
            entry["exists"] = False
        projects.append(entry)
        if len(projects) == MAX_RECENT_PROJECTS:
            break
    return projects


def load_recent_projects() -> list[dict[str, object]]:
    """Read the shared settings path, falling back to the legacy path once."""
    path = default_server_settings_path()
    if path.is_file():
        return read_recent_projects(path)
    legacy_path = legacy_server_settings_path()
    if legacy_path != path and legacy_path.is_file():
        return read_recent_projects(legacy_path)
    return []
