# pyright: reportAny=false, reportAttributeAccessIssue=false, reportPrivateUsage=false, reportUnknownMemberType=false, reportUnknownVariableType=false

from __future__ import annotations

import subprocess
import tkinter as tk
import webbrowser
from pathlib import Path
from typing import Protocol
from tkinter import ttk

from maw.gui_platform import creationflags, startupinfo
from maw.gui_workflow import build_serve_command


class ServerOwner(Protocol):
    server_process: subprocess.Popen[str] | None
    server_button: ttk.Button
    status_var: tk.StringVar
    root: tk.Tk

    def _t(self, key: str) -> str: ...


def start_editor_server(owner: ServerOwner, json_path: Path, media_text: str, port: int) -> None:
    media = Path(media_text).expanduser() if media_text.strip() else None
    if media and not media.exists():
        media = None
    command = build_serve_command(json_path, media, port)
    command.append("--no-open")
    owner.server_process = subprocess.Popen(
        command,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        text=True,
        cwd=str(Path(__file__).resolve().parents[1]),
        startupinfo=startupinfo(),
        creationflags=creationflags(),
    )
    url = f"http://127.0.0.1:{port}/"
    owner.server_button.configure(text=owner._t("server_stop"))
    owner.status_var.set(owner._t("server_running").format(url=url))
    owner.root.after(700, lambda: webbrowser.open(url))


def poll_editor_server(owner: ServerOwner) -> None:
    if owner.server_process and owner.server_process.poll() is not None:
        owner.server_process = None
        owner.server_button.configure(text=owner._t("server_start"))
        if owner.status_var.get().startswith(owner._t("server_running").split(":", 1)[0]):
            owner.status_var.set(owner._t("server_failed"))


def stop_editor_server(owner: ServerOwner) -> None:
    process = owner.server_process
    owner.server_process = None
    if process and process.poll() is None:
        process.terminate()
        try:
            _ = process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            _ = process.wait(timeout=5)
    owner.server_button.configure(text=owner._t("server_start"))
    owner.status_var.set(owner._t("server_stopped"))
