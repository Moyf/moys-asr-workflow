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


DWMWA_USE_IMMERSIVE_DARK_MODE = 20  # Windows 10 20H1+ / Windows 11
DWMWA_USE_IMMERSIVE_DARK_MODE_LEGACY = 19  # Windows 10 1809-1909


def apply_dark_title_bar(window_title: str) -> bool:
    """Best effort: switch a top-level window's native title bar to dark mode (Windows only)."""
    if sys.platform != "win32":
        return False
    import ctypes
    from ctypes import wintypes

    try:
        find_window = ctypes.windll.user32.FindWindowW
        find_window.restype = wintypes.HWND
        hwnd = find_window(None, window_title)
        if not hwnd:
            return False
        enabled = wintypes.BOOL(True)
        for attribute in (DWMWA_USE_IMMERSIVE_DARK_MODE, DWMWA_USE_IMMERSIVE_DARK_MODE_LEGACY):
            result = ctypes.windll.dwmapi.DwmSetWindowAttribute(
                wintypes.HWND(hwnd),
                wintypes.DWORD(attribute),
                ctypes.byref(enabled),
                wintypes.DWORD(ctypes.sizeof(enabled)),
            )
            if result == 0:  # S_OK
                return True
        return False
    except (AttributeError, OSError):
        return False
