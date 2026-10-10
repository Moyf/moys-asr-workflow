"""Lightweight release identity and immutable error context (no GUI imports)."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from pathlib import Path
import tomllib


# Updated by scripts/sync_launcher_version.py from project.version.
BUNDLED_APP_VERSION = "1.8.0-beta.1"


def app_version(root: Path | None = None) -> str:
    try:
        project = tomllib.loads(((root or Path(__file__).resolve().parents[1]) / "pyproject.toml").read_text(encoding="utf-8"))
        version = project.get("project", {}).get("version")
        return version if isinstance(version, str) and version.strip() else BUNDLED_APP_VERSION
    except (OSError, ValueError, TypeError, AttributeError):
        return BUNDLED_APP_VERSION


def error_context(existing: object = None, *, now: datetime | None = None) -> dict[str, str]:
    """Capture once; preserve valid context when an error crosses a boundary."""
    source = existing if isinstance(existing, Mapping) else {}
    version = source.get("version")
    occurred_at = source.get("occurredAt")
    try:
        if not isinstance(occurred_at, str) or datetime.fromisoformat(occurred_at).utcoffset() is None:
            occurred_at = None
    except ValueError:
        occurred_at = None
    if occurred_at is None:
        try:
            stamp = now or datetime.now().astimezone()
            if stamp.utcoffset() is None:
                stamp = stamp.astimezone()
            occurred_at = stamp.isoformat(timespec="seconds")
        except (OSError, ValueError, OverflowError):
            occurred_at = "unknown"
    return {
        "version": version if isinstance(version, str) and version.strip() else app_version(),
        "occurredAt": occurred_at,
    }


def context_label(context: Mapping[str, str]) -> str:
    return f"MAW v{context['version']} | {context['occurredAt']}"
