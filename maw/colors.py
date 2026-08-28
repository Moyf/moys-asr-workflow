"""字幕颜色调色板：分组着色（color / color_ref）的唯一权威定义。

颜色独立于 speaker 存在：1~5 手动标记、speaker 自动取色、拆分继承
都从这份调色板取值。编辑器与波形显示由 edit.py / serve.py 渲染时
注入为 ``window.ASR_EDITOR_PALETTE``；JSON_SCHEMA.md 第四节的色值表
与这里保持同步。
"""

from __future__ import annotations

COLOR_PALETTE: tuple[tuple[str, str], ...] = (
    ("yellow", "#f1c40f"),
    ("green", "#66bb6a"),
    ("red", "#e74c3c"),
    ("purple", "#b57edc"),
    ("blue", "#168cff"),
)

COLOR_NAMES: frozenset[str] = frozenset(name for name, _ in COLOR_PALETTE)
