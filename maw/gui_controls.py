from __future__ import annotations

import tkinter as tk
from pathlib import Path
from tkinter import filedialog

from maw.gui_workflow import default_srt_path


def choose_media(media_var: tk.StringVar, output_var: tk.StringVar, title: str) -> None:
    chosen = filedialog.askopenfilename(title=title)
    if chosen:
        media_var.set(chosen)
        if not output_var.get().strip():
            output_var.set(str(default_srt_path(Path(chosen))))


def choose_output(media_var: tk.StringVar, output_var: tk.StringVar, title: str) -> None:
    initial = output_var.get().strip() or str(default_srt_path(Path(media_var.get() or "output.mp3")))
    chosen = filedialog.asksaveasfilename(title=title, initialfile=Path(initial).name, defaultextension=".srt")
    if chosen:
        output_var.set(chosen)


def choose_json(json_var: tk.StringVar, title: str) -> None:
    chosen = filedialog.askopenfilename(title=title, filetypes=(("JSON", "*.json"), ("All", "*.*")))
    if chosen:
        json_var.set(chosen)
