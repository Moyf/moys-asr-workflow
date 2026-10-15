"""Version boundary for standalone editors; local Server rendering stays supported."""

from __future__ import annotations

import re
import sys

from maw.diagnostics import app_version


RETIREMENT_MESSAGE = (
    "MAW 2.0 起不再生成或维护 .edit.html、blank-editor.html 和在线编辑器。"
    "请使用本地应用，或 MAW.exe --server / python server-editor/serve.py 打开工程。"
    "历史 HTML 副本可继续使用，但不承诺兼容 2.0 及后续工程。"
)


def standalone_editor_supported(version: str | None = None) -> bool:
    """2.x prereleases participate in retirement; unknown builds fail closed."""
    match = re.fullmatch(r"v?(\d+)\.\d+\.\d+(?:[-+.]?[0-9A-Za-z.-]+)?", (version or app_version()).strip())
    return match is not None and int(match.group(1)) < 2


def require_standalone_editor() -> None:
    if not standalone_editor_supported():
        raise ValueError(RETIREMENT_MESSAGE)


def should_generate_standalone_editor(requested: bool) -> bool:
    """Old implicit/stored HTML requests must not fail otherwise successful ASR."""
    if not requested:
        return False
    if standalone_editor_supported():
        return True
    print(RETIREMENT_MESSAGE, file=sys.stderr)
    return False
