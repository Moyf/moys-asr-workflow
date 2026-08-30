"""Shared paths for MAW user data and frozen-application configuration.

The source tree, frozen package, and the small helper processes all need to
agree on where user-owned data lives.  Keep this module dependency-free so it
can be imported by every entry point without pulling in GUI or runtime code.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Final


APP_DATA_DIRECTORY_NAME: Final = "MAW"
EMOJI_FONT_FILE_NAME: Final = "NotoColorEmoji.ttf"
SERVER_SETTINGS_FILE_NAME: Final = "server-editor-settings.json"
SOURCE_ROOT: Final = Path(__file__).resolve().parents[1]
ENV_PATH_OVERRIDE_VARIABLE: Final = "MAW_ENV_FILE"


def default_app_data_root() -> Path:
    """Return the writable MAW user-data root for the current platform.

    ``MAW_APP_DATA_ROOT`` is intentionally kept as a process-level override
    for tests and portable deployments.  It is resolved so callers can use it
    as a stable path even when the override contains a relative component.
    """
    override = os.environ.get("MAW_APP_DATA_ROOT", "").strip()
    if override:
        return Path(override).expanduser().resolve(strict=False)
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local"))
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share"))
    return base / APP_DATA_DIRECTORY_NAME


def application_directory() -> Path:
    """Return the directory containing the frozen executable.

    Source runs intentionally use ``SOURCE_ROOT`` for configuration.  The
    executable directory only matters after PyInstaller has set ``sys.frozen``
    and is then taken from ``sys.executable`` rather than ``_MEIPASS``.
    """
    if getattr(sys, "frozen", False):
        executable = str(getattr(sys, "executable", "") or "").strip()
        if executable:
            return Path(executable).expanduser().resolve(strict=False).parent
    return SOURCE_ROOT


def default_env_path() -> Path:
    """Return the default ``.env`` path for source and frozen executions.

    Development always keeps using the repository root ``.env``.  A frozen
    application first honors a file beside its executable, which is useful for
    portable releases, and otherwise uses the shared MAW user-data directory.
    """
    override = os.environ.get(ENV_PATH_OVERRIDE_VARIABLE, "").strip()
    if override:
        return Path(override).expanduser().resolve(strict=False)
    if not getattr(sys, "frozen", False):
        return SOURCE_ROOT / ".env"
    adjacent = application_directory() / ".env"
    if adjacent.is_file():
        return adjacent
    return (default_app_data_root() / ".env").resolve(strict=False)


def default_log_directory() -> Path:
    """Return the shared directory for ordinary and startup diagnostics."""
    return default_app_data_root() / "logs"


def default_emoji_font_path() -> Path:
    """Return the shared cache path for the Linux Noto Color Emoji font."""
    return default_app_data_root() / EMOJI_FONT_FILE_NAME


def default_server_settings_path() -> Path:
    """Return the shared server-editor settings path."""
    return default_app_data_root() / SERVER_SETTINGS_FILE_NAME


def legacy_server_settings_path() -> Path:
    """Return the pre-1.5 server-editor settings path for read-only fallback."""
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local"))
    else:
        base = Path(os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share"))
    return base / "Moy" / "moys-asr-workflow" / SERVER_SETTINGS_FILE_NAME
