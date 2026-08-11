# pyright: reportAny=false, reportAttributeAccessIssue=false, reportUnknownMemberType=false, reportUnknownVariableType=false

from __future__ import annotations

import os
import signal
import subprocess
import sys
from pathlib import Path
from typing import Any


def asset_path(relative: str) -> Path:
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[1]))
    return base / relative


def startupinfo() -> subprocess.STARTUPINFO | None:
    if sys.platform != "win32":
        return None
    startup = subprocess.STARTUPINFO()
    startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    return startup


def creationflags() -> int:
    return subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0


def process_group_kwargs() -> dict[str, object]:
    """Start a child in an independently terminable process group."""
    flags = creationflags()
    kwargs: dict[str, object] = {
        "startupinfo": startupinfo(),
        "creationflags": flags,
    }
    if sys.platform == "win32":
        kwargs["creationflags"] = flags | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True
    return kwargs


def popen_process_tree(*args: Any, **kwargs: Any) -> subprocess.Popen[Any]:
    """Start a child and register a Windows job for descendant cleanup."""
    process = subprocess.Popen(*args, **kwargs)
    _register_process_job(process)
    return process


def _register_process_job(process: subprocess.Popen[Any]) -> None:
    """Put a Windows child in a killable job when the platform supports it."""
    if sys.platform != "win32" or getattr(process, "_maw_job_handle", None):
        return

    process_handle = getattr(process, "_handle", None)
    if process_handle is None:
        # Test doubles and non-standard Popen implementations do not expose a
        # native process handle.  The taskkill fallback still handles them.
        return

    import ctypes
    from ctypes import wintypes

    class BasicLimitInformation(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_longlong),
            ("PerJobUserTimeLimit", ctypes.c_longlong),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class IoCounters(ctypes.Structure):
        _fields_ = [
            ("ReadOperationCount", ctypes.c_ulonglong),
            ("WriteOperationCount", ctypes.c_ulonglong),
            ("OtherOperationCount", ctypes.c_ulonglong),
            ("ReadTransferCount", ctypes.c_ulonglong),
            ("WriteTransferCount", ctypes.c_ulonglong),
            ("OtherTransferCount", ctypes.c_ulonglong),
        ]

    class ExtendedLimitInformation(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", BasicLimitInformation),
            ("IoInfo", IoCounters),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    try:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        create_job = kernel32.CreateJobObjectW
        create_job.argtypes = (wintypes.LPVOID, wintypes.LPCWSTR)
        create_job.restype = wintypes.HANDLE
        job = create_job(None, None)
        if not job:
            return

        info = ExtendedLimitInformation()
        # Kill descendants automatically if the MAW-side handle is released
        # after cancellation or shutdown.
        info.BasicLimitInformation.LimitFlags = 0x2000  # KILL_ON_JOB_CLOSE
        set_info = kernel32.SetInformationJobObject
        set_info.argtypes = (wintypes.HANDLE, wintypes.INT, wintypes.LPVOID, wintypes.DWORD)
        set_info.restype = wintypes.BOOL
        if not set_info(job, 9, ctypes.byref(info), ctypes.sizeof(info)):
            kernel32.CloseHandle(job)
            return

        assign = kernel32.AssignProcessToJobObject
        assign.argtypes = (wintypes.HANDLE, wintypes.HANDLE)
        assign.restype = wintypes.BOOL
        if not assign(job, process_handle):
            kernel32.CloseHandle(job)
            return
        setattr(process, "_maw_job_handle", job)
    except (AttributeError, OSError, TypeError, ValueError):
        # CREATE_NEW_PROCESS_GROUP plus taskkill /T remains the portable
        # Windows fallback when a job cannot be created or assigned.
        return


def _terminate_registered_job(process: subprocess.Popen[Any]) -> bool:
    """Terminate and release a registered Windows job, if any."""
    job = getattr(process, "_maw_job_handle", None)
    if not job or sys.platform != "win32":
        return False
    import ctypes
    from ctypes import wintypes

    try:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        terminate_job = kernel32.TerminateJobObject
        terminate_job.argtypes = (wintypes.HANDLE, wintypes.UINT)
        terminate_job.restype = wintypes.BOOL
        terminated = bool(terminate_job(job, 1))
        return terminated
    except (AttributeError, OSError, TypeError, ValueError):
        return False
    finally:
        release_process_tree(process)


def release_process_tree(process: subprocess.Popen[Any]) -> None:
    """Release a completed child job without terminating a live process."""
    job = getattr(process, "_maw_job_handle", None)
    if not job or sys.platform != "win32":
        return
    setattr(process, "_maw_job_handle", None)
    import ctypes

    try:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CloseHandle(job)
    except (AttributeError, OSError, TypeError, ValueError):
        return


def _taskkill_process_tree(pid: int) -> bool:
    try:
        result = subprocess.run(
            ["taskkill", "/PID", str(pid), "/T", "/F"],
            capture_output=True,
            text=True,
            check=False,
            startupinfo=startupinfo(),
            creationflags=creationflags(),
        )
    except OSError:
        return False
    return result.returncode == 0


def terminate_process_tree(process: subprocess.Popen[Any], *, timeout: float = 5.0) -> None:
    """Terminate a MAW-owned process and descendants, then reap the root."""
    running = process.poll() is None
    pid = getattr(process, "pid", None)
    if not isinstance(pid, int):
        _terminate_registered_job(process)
        if running:
            process.terminate()
        process.wait(timeout=timeout)
        return

    if sys.platform == "win32":
        terminated = _taskkill_process_tree(pid) if running else False
        job_terminated = _terminate_registered_job(process)
        if not terminated and not job_terminated and process.poll() is None:
            process.terminate()
    else:
        if running:
            try:
                os.killpg(pid, signal.SIGTERM)
            except (OSError, ProcessLookupError):
                if process.poll() is None:
                    process.terminate()

    try:
        process.wait(timeout=timeout)
        return
    except subprocess.TimeoutExpired:
        pass

    if sys.platform == "win32":
        _taskkill_process_tree(pid)
    else:
        try:
            os.killpg(pid, signal.SIGKILL)
        except (OSError, ProcessLookupError):
            pass
    if process.poll() is None:
        process.kill()
    process.wait(timeout=timeout)


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
