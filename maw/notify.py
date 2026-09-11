# pyright: reportAny=false

"""Launcher 的系统通知（尽力而为，失败静默）。

任务完成后由前端决定是否提醒，并调用这里的平台实现发送原生通知：
- Windows：隐藏窗口运行 PowerShell，用 NotifyIcon 气泡提示（无需注册 AppUserModelID）；
- macOS：osascript display notification；
- Linux：notify-send（libnotify）。

通知只影响桌面提示，任何失败都不得影响转写主流程，因此本模块不抛异常。
"""

from __future__ import annotations

import base64
import shutil
import subprocess
import sys
from typing import Final

_WINDOWS_CREATE_NO_WINDOW: Final = 0x08000000
# Windows 气泡提示的文本上限较小，超出会被系统截断；这里主动收紧并去掉换行。
_MAX_TITLE_CHARS: Final = 64
_MAX_MESSAGE_CHARS: Final = 240


def send_system_notification(title: str, message: str) -> bool:
    """Send one native desktop notification; return whether a process was started."""
    clean_title = _normalize(title, _MAX_TITLE_CHARS)
    clean_message = _normalize(message, _MAX_MESSAGE_CHARS)
    if not clean_title and not clean_message:
        return False
    try:
        if sys.platform == "darwin":
            return _notify_macos(clean_title, clean_message)
        if sys.platform == "win32":
            return _notify_windows(clean_title, clean_message)
        return _notify_linux(clean_title, clean_message)
    except (OSError, subprocess.SubprocessError, ValueError):
        return False


def _normalize(value: str, limit: int) -> str:
    text = " ".join(str(value or "").split())
    if len(text) > limit:
        return text[: limit - 1].rstrip() + "…"
    return text


def _spawn(command: list[str]) -> bool:
    if not command:
        return False
    kwargs: dict[str, object] = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
    }
    if sys.platform == "win32":
        kwargs["creationflags"] = _WINDOWS_CREATE_NO_WINDOW
    else:
        kwargs["start_new_session"] = True
    try:
        _ = subprocess.Popen(command, **kwargs)  # noqa: S603 - fixed executables, escaped arguments
    except OSError:
        return False
    return True


def _notify_macos(title: str, message: str) -> bool:
    def escape(value: str) -> str:
        return value.replace("\\", "\\\\").replace('"', '\\"')

    script = f'display notification "{escape(message)}" with title "{escape(title)}"'
    return _spawn(["osascript", "-e", script])


def _powershell_command(script: str) -> list[str]:
    executable = shutil.which("powershell") or shutil.which("pwsh")
    if not executable:
        return []
    encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    return [
        executable,
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-EncodedCommand",
        encoded,
    ]


def _ps_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _notify_windows(title: str, message: str) -> bool:
    script = "".join(
        (
            "Add-Type -AssemblyName System.Windows.Forms;",
            "Add-Type -AssemblyName System.Drawing;",
            "$n = New-Object System.Windows.Forms.NotifyIcon;",
            "$n.Icon = [System.Drawing.SystemIcons]::Information;",
            "$n.Visible = $true;",
            f"$n.BalloonTipTitle = {_ps_quote(title)};",
            f"$n.BalloonTipText = {_ps_quote(message)};",
            "$n.ShowBalloonTip(8000);",
            # 进程必须存活到气泡显示完毕，否则提示会被立即移除。
            "Start-Sleep -Milliseconds 9000;",
            "$n.Dispose()",
        )
    )
    return _spawn(_powershell_command(script))


def _notify_linux(title: str, message: str) -> bool:
    executable = shutil.which("notify-send")
    if not executable:
        return False
    return _spawn([executable, "--app-name=MAW", title, message])
