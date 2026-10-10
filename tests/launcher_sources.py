"""Launcher 前端源码的测试辅助。

launcher.js 已拆分为 launcher-scripts.txt 清单内的多个 classic 模块；
源码级断言应针对按清单原序拼接的全集进行（顺序与拆分前的单体一致）。
"""

from __future__ import annotations

from pathlib import Path


def launcher_scripts(root: Path) -> list[str]:
    """Return launcher module paths in manifest order."""
    lines = (root / "web" / "launcher-scripts.txt").read_text(encoding="utf-8").split("\n")
    return [line.split("#", 1)[0].strip() for line in lines if line.split("#", 1)[0].strip()]


def launcher_sources_text(root: Path) -> str:
    """Join all launcher module sources in manifest order for source-level assertions."""
    return "\n".join((root / "web" / path).read_text(encoding="utf-8") for path in launcher_scripts(root))


def launcher_sources_dedented(root: Path) -> str:
    """Join launcher sources with per-line leading whitespace stripped (indentation-agnostic assertions)."""
    return "\n".join(line.lstrip() for line in launcher_sources_text(root).split("\n"))
