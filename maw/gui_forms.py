# pyright: reportAny=false, reportUnusedCallResult=false

from __future__ import annotations

import tkinter as tk
from collections.abc import Callable
from tkinter import ttk


FormFrame = ttk.Frame | ttk.LabelFrame


def labelframe(parent: ttk.Frame, key: str, row: int, widgets: dict[str, tk.Widget]) -> ttk.LabelFrame:
    frame = ttk.LabelFrame(parent, padding=10)
    frame.grid(row=row, column=0, sticky="ew", pady=4)
    frame.columnconfigure(1, weight=1)
    widgets[key] = frame
    return frame


def path_row(frame: FormFrame, row: int, label_key: str, var: tk.StringVar, command: Callable[[], None], widgets: dict[str, tk.Widget]) -> None:
    entry(frame, row, label_key, var, widgets)
    button = ttk.Button(frame, command=command)
    button.grid(row=row, column=2, sticky="ew", padx=(6, 0), pady=3)
    widgets[f"{label_key}_browse"] = button


def entry(frame: FormFrame, row: int, label_key: str, var: tk.StringVar, widgets: dict[str, tk.Widget], *, show: str | None = None) -> ttk.Entry:
    label(frame, row, label_key, widgets)
    field = ttk.Entry(frame, textvariable=var, show=show or "")
    field.grid(row=row, column=1, sticky="ew", pady=3)
    return field


def label(frame: FormFrame, row: int, key: str, widgets: dict[str, tk.Widget]) -> ttk.Label:
    field_label = ttk.Label(frame)
    field_label.grid(row=row, column=0, sticky="w", pady=3)
    widgets[key] = field_label
    return field_label


def combo(frame: FormFrame, row: int, label_key: str, var: tk.StringVar, values: list[str], widgets: dict[str, tk.Widget]) -> ttk.Combobox:
    label(frame, row, label_key, widgets)
    field = ttk.Combobox(frame, textvariable=var, values=values, state="readonly")
    field.grid(row=row, column=1, sticky="ew", pady=3)
    return field
