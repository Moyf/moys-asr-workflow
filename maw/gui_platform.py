# pyright: reportAny=false, reportAttributeAccessIssue=false, reportUnknownMemberType=false, reportUnknownVariableType=false

from __future__ import annotations

import subprocess
import sys
import tkinter as tk
from pathlib import Path


def asset_path(relative: str) -> Path:
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[1]))
    return base / relative


def set_window_icon(root: tk.Tk) -> None:
    icon = asset_path("assets/maw.ico")
    if not icon.exists():
        return
    try:
        root.tk.call("wm", "iconbitmap", root._w, str(icon))
    except tk.TclError:
        return


def startupinfo() -> subprocess.STARTUPINFO | None:
    if sys.platform != "win32":
        return None
    startup = subprocess.STARTUPINFO()
    startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    return startup


def creationflags() -> int:
    return subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
