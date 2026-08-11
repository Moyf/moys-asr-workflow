"""Synchronize the packaged Launcher version with project metadata."""

from __future__ import annotations

import argparse
import re
import sys
import tomllib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PYPROJECT = ROOT / "pyproject.toml"


def _targets() -> tuple[tuple[str, Path, str, str], ...]:
    return (
        (
            "Launcher HTML",
            ROOT / "web" / "launcher" / "index.html",
            r'(id="appVersion">v)[^<]+(</span>)',
            r'id="appVersion">v([^<]+)</span>',
        ),
        (
            "Launcher mock API",
            ROOT / "web" / "launcher" / "launcher.js",
            r'(appVersion:\s*")[^"]+(")',
            r'appVersion:\s*"([^"]+)"',
        ),
        (
            "bundled GUI fallback",
            ROOT / "maw" / "gui_web.py",
            r'(BUNDLED_APP_VERSION\s*=\s*")[^"]+(")',
            r'BUNDLED_APP_VERSION\s*=\s*"([^"]+)"',
        ),
    )


def _project_version() -> str:
    data = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))
    project = data.get("project")
    version = project.get("version") if isinstance(project, dict) else None
    if not isinstance(version, str) or not version.strip():
        raise ValueError("pyproject.toml does not declare project.version")
    return version.strip()


def _sync(version: str) -> None:
    for label, path, update_pattern, _ in _targets():
        text = path.read_text(encoding="utf-8")
        updated, count = re.subn(
            update_pattern,
            lambda match: f"{match.group(1)}{version}{match.group(2)}",
            text,
            count=1,
        )
        if count != 1:
            raise ValueError(f"{label} version marker was not found exactly once: {path}")
        if updated != text:
            path.write_bytes(updated.encode("utf-8"))


def _check(version: str) -> None:
    for label, path, _, check_pattern in _targets():
        match = re.search(check_pattern, path.read_text(encoding="utf-8"))
        if not match:
            raise ValueError(f"{label} version marker was not found: {path}")
        actual = match.group(1)
        if actual != version:
            raise ValueError(f"{label} is {actual}, expected {version}: {path}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_mutually_exclusive_group(required=True)
    actions.add_argument("--check", action="store_true", help="verify all Launcher version markers")
    actions.add_argument("--write", action="store_true", help="update all Launcher version markers")
    args = parser.parse_args()

    try:
        version = _project_version()
        if args.write:
            _sync(version)
        _check(version)
    except (OSError, ValueError, tomllib.TOMLDecodeError) as exc:
        print(f"Launcher version check failed: {exc}", file=sys.stderr)
        return 1

    action = "synchronized and verified" if args.write else "verified"
    print(f"Launcher version {action}: v{version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
