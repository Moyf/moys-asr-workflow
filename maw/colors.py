"""字幕颜色调色板：分组着色（color / color_ref）的唯一权威定义。

颜色独立于 speaker 存在：1~5 手动标记、speaker 自动取色、拆分继承
都从这份调色板取值。编辑器与波形显示由 edit.py / serve.py 渲染时
注入为 ``window.ASR_EDITOR_PALETTE``；JSON_SCHEMA.md 第四节的色值表
与这里保持同步。

红/蓝/紫沿用以绿色为锚的配色，黄色默认值为 #f9ca1f。色值最终
以 HEX 落盘；已有工程存储的色值快照不随默认调色板迁移。
"""

from __future__ import annotations

COLOR_PALETTE: tuple[tuple[str, str], ...] = (
    ("yellow", "#f9ca1f"),
    ("green", "#66bb6a"),
    ("red", "#f07f6f"),
    ("purple", "#bf89e6"),
    ("blue", "#61a7fa"),
)

COLOR_PALETTE_ALL: tuple[tuple[str, str], ...] = (
    *COLOR_PALETTE,
    ("orange", "#f2a65a"),
    ("cyan", "#49c5c1"),
    ("magenta", "#d675b9"),
    ("gray", "#969fab"),
)

COLOR_NAMES: frozenset[str] = frozenset(name for name, _ in COLOR_PALETTE_ALL)
