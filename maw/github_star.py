"""Query or star MAW using the user's existing GitHub CLI authentication."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from concurrent.futures import Future
from pathlib import Path
from threading import Lock
from typing import Literal

from maw.gui_platform import creationflags, restore_host_library_path

_STAR_ENDPOINT = "user/starred/Moyf/moys-asr-workflow"
_MACOS_GH_DIRECTORIES = ("/opt/homebrew/bin", "/usr/local/bin")
_StarMethod = Literal["GET", "PUT"]
_in_flight: dict[_StarMethod, Future[int | None]] = {}
_in_flight_lock = Lock()


def _find_gh() -> str | None:
    # In particular, do not pick up a Windows executable from the working directory.
    name = "gh.exe" if os.name == "nt" else "gh"
    directories = os.get_exec_path()
    if sys.platform == "darwin":
        # Finder launches can have a minimal PATH without Homebrew.
        directories = [*directories, *_MACOS_GH_DIRECTORIES]
    for directory in map(Path, dict.fromkeys(directories)):
        if directory.is_absolute():
            candidate = str(directory / name)
            if shutil.which(candidate) == candidate:
                return candidate
    return None


def _star_response(method: _StarMethod) -> int | None:
    # Share only overlapping calls in this process, never a completed result.
    with _in_flight_lock:
        pending = _in_flight.get(method)
        leader = pending is None
        if pending is None:
            pending = _in_flight[method] = Future()

    if not leader:
        return pending.result()

    try:
        status = _run_star_request(method)
    except BaseException as error:
        with _in_flight_lock:
            del _in_flight[method]
            pending.set_exception(error)
        raise
    with _in_flight_lock:
        del _in_flight[method]
        pending.set_result(status)
    return status


def _run_star_request(method: _StarMethod) -> int | None:
    try:
        gh = _find_gh()
        if gh is None:
            return None
        env = restore_host_library_path(os.environ.copy())
        env["GH_PROMPT_DISABLED"] = "1"
        result = subprocess.run(
            [gh, "api", "--hostname", "github.com", "--method", method,
             "--include", "--silent", _STAR_ENDPOINT],
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=8,
            creationflags=creationflags(),
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None

    # gh prints the HTTP status before headers. Never infer it from error text.
    status = re.match(rb"HTTP/\d(?:\.\d)? (\d{3})(?:[ \r\n]|$)", result.stdout)
    if status is None:
        return None
    code = int(status[1])
    if code == 204 and result.returncode == 0:
        return code
    if code == 404 and result.returncode == 1 and method == "GET":
        return code
    return None


def check_maw_starred() -> bool | None:
    """Return None when the authenticated Star status cannot be determined."""
    status = _star_response("GET")
    return None if status is None else status == 204


def star_maw() -> bool:
    """Star the fixed MAW repo; callers must require an explicit user action."""
    return _star_response("PUT") == 204
