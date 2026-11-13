# pyright: reportAny=false, reportAttributeAccessIssue=false, reportUnknownMemberType=false, reportUnknownVariableType=false

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


def asset_path(relative: str) -> Path:
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[1]))
    return base / relative


def startupinfo() -> Any | None:
    if sys.platform != "win32":
        return None
    startup_info_type = getattr(subprocess, "STARTUPINFO", None)
    if startup_info_type is None:
        return None
    startup = startup_info_type()
    startup.dwFlags |= getattr(subprocess, "STARTF_USESHOWWINDOW", 0)
    return startup


def creationflags() -> int:
    if sys.platform != "win32":
        return 0
    return int(getattr(subprocess, "CREATE_NO_WINDOW", 0))


def restore_host_library_path(env: dict[str, str]) -> dict[str, str]:
    """让非冻结子进程用回宿主的动态库搜索路径。

    AppImage / PyInstaller 引导会把 ``LD_LIBRARY_PATH`` 指向包内 ``_internal``，
    其中的 libexpat / libssl / libcrypto 等动态库比宿主系统更旧。宿主 CPython 的
    ``pyexpat`` / ``_ssl`` / ``_hashlib`` 扩展模块会因缺少新符号或版本节点而导入
    失败，进而让 ``python3 -m venv`` 内的 ensurepip、pip 的 HTTPS 下载以及托管
    runtime（OCR / 本地 ASR）的 worker 全部启动失败。冻结进程自身仍需要该变量定位
    包内 Qt 等库，因此只在打包版 Linux 上还原为 AppImage 记录的
    ``LD_LIBRARY_PATH_ORIG``（不存在则直接移除）。
    """
    if sys.platform != "linux" or not getattr(sys, "frozen", False):
        return env
    original = env.get("LD_LIBRARY_PATH_ORIG")
    if original is not None:
        env["LD_LIBRARY_PATH"] = original
    else:
        env.pop("LD_LIBRARY_PATH", None)
    return env


def process_group_kwargs() -> dict[str, object]:
    """Start a child in an independently terminable process group."""
    flags = creationflags()
    kwargs: dict[str, object] = {
        "startupinfo": startupinfo(),
        "creationflags": flags,
    }
    if sys.platform == "win32":
        kwargs["creationflags"] = flags | int(getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0))
    else:
        kwargs["start_new_session"] = True
    return kwargs


def popen_process_tree(*args: Any, **kwargs: Any) -> subprocess.Popen[Any]:
    """Start a child and remember only process groups created by this call."""
    process = subprocess.Popen(*args, **kwargs)
    if sys.platform != "win32" and (
        kwargs.get("start_new_session") is True or kwargs.get("process_group") == 0
    ):
        # setsid()/setpgid(0, 0) makes this newly created child's PID its PGID.
        # Do not query/guess the group later: the root may already have exited,
        # and a plain Popen may belong to the parent's (foreign) process group.
        pid = getattr(process, "pid", None)
        if isinstance(pid, int) and not isinstance(pid, bool) and pid > 0:
            setattr(process, "_maw_process_group_id", pid)
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
            # taskkill 输出走 ANSI 代码页（如 zh-CN 的 GBK）；默认 UTF-8 模式
            # 解码会抛 UnicodeDecodeError 打断 reader 线程。
            encoding="mbcs",
            errors="replace",
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
    if sys.platform != "win32":
        group = getattr(process, "_maw_process_group_id", None)
        if isinstance(group, int) and not isinstance(group, bool) and group > 0:
            _terminate_posix_group(process, group, timeout)
        else:
            # A process started without an explicitly owned group may be
            # reaped/terminated, but its PID must never be guessed as a PGID.
            if running:
                process.terminate()
            try:
                process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=timeout)
        return
    if not isinstance(pid, int):
        _terminate_registered_job(process)
        if running:
            process.terminate()
        process.wait(timeout=timeout)
        return

    terminated = _taskkill_process_tree(pid) if running else False
    job_terminated = _terminate_registered_job(process)
    if not terminated and not job_terminated and process.poll() is None:
        process.terminate()

    try:
        process.wait(timeout=timeout)
        return
    except subprocess.TimeoutExpired:
        pass

    _taskkill_process_tree(pid)
    if process.poll() is None:
        process.kill()
    process.wait(timeout=timeout)


def _posix_group_alive(group: int) -> bool:
    """Probe an owned group; Linux zombie-only groups cannot hold pipes open."""
    try:
        os.killpg(group, 0)
    except ProcessLookupError:
        return False
    except OSError:
        return True  # Permission/transient errors are not proof of an exit.
    proc = Path("/proc")
    if sys.platform != "linux" or not proc.is_dir():
        return True
    uncertain = False
    try:
        for entry in proc.iterdir():
            if not entry.name.isdecimal():
                continue
            try:
                fields = (entry / "stat").read_text().rsplit(")", 1)[1].split()
                if int(fields[2]) == group and fields[0] != "Z":
                    return True
            except FileNotFoundError:
                continue  # Process disappeared during the snapshot.
            except (OSError, ValueError, IndexError):
                uncertain = True
    except OSError:
        return True
    return uncertain


def _terminate_posix_group(process: subprocess.Popen[Any], group: int, timeout: float) -> None:
    """Reclaim descendants even if their root exited or they ignore SIGTERM."""
    try:
        os.killpg(group, signal.SIGTERM)
    except OSError:
        if process.poll() is None:
            process.terminate()
    deadline = time.monotonic() + max(0.0, timeout)
    while _posix_group_alive(group):
        # Reap the root during the grace period, but never use its exit as
        # proof that the rest of the independently owned group is gone.
        process.poll()
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            try:
                os.killpg(group, signal.SIGKILL)
            except OSError:
                pass
            break
        time.sleep(min(0.05, remaining))
    # Do not wait for the entire group after SIGKILL: unreaped orphan zombies
    # can keep a PGID observable indefinitely. Reap only the owned root with a
    # bound; the caller's reader join separately waits for inherited pipe EOF.
    if process.poll() is None:
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=timeout)
    else:
        process.wait(timeout=timeout)
    setattr(process, "_maw_process_group_id", None)


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
