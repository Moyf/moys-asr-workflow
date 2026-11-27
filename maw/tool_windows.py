"""Native Launcher windows for the maintained local comparison tools.

The pages in ``tools/`` stay fully usable offline; this module only packages
already-validated inputs into a preload payload and hands them to the same
page inside a pywebview child window. No filesystem access is exposed to the
page beyond the data passed in.
"""

from __future__ import annotations

import base64
from collections.abc import Sequence
from pathlib import Path

from maw.postprocess_io import PostprocessFileError, read_project
from maw.project import ProjectValidationFailed

_COMPARE_EXTENSIONS = frozenset({".srt", ".mosp", ".json"})
_PROJECT_EXTENSIONS = frozenset({".mosp", ".json"})
_MAX_TRANSCRIPT_FILES = 10


def _skipped_note(names: list[str], lang: str) -> str:
    if not names:
        return ""
    joined = "、".join(names)
    return f"已跳过：{joined}" if lang != "en" else f"Skipped: {joined}"


def transcript_compare_payload(paths: Sequence[Path], *, lang: str = "zh") -> dict[str, object]:
    """Raw subtitle bytes for tools/compare.html; the page owns decoding."""
    files: list[dict[str, str]] = []
    skipped: list[str] = []
    limit_reached = False
    for path in paths:
        if len(files) >= _MAX_TRANSCRIPT_FILES:
            limit_reached = True
            break
        if path.suffix.lower() not in _COMPARE_EXTENSIONS:
            skipped.append(path.name)
            continue
        try:
            if not path.is_file():
                skipped.append(path.name)
                continue
            raw = path.read_bytes()
        except OSError:
            skipped.append(path.name)
            continue
        files.append({"name": path.name, "bytes": base64.b64encode(raw).decode("ascii")})
    notes = [_skipped_note(skipped, lang)]
    if limit_reached:
        notes.append(
            f"Only the first {_MAX_TRANSCRIPT_FILES} files were loaded."
            if lang == "en"
            else f"最多加载 {_MAX_TRANSCRIPT_FILES} 个文件，已跳过其余文件。"
        )
    return {"files": files, "warning": " ".join(filter(None, notes))}


def timestamp_compare_payload(paths: Sequence[Path], *, lang: str = "zh") -> dict[str, object]:
    """Validated project objects for tools/timestamp-compare.html.

    SRT carries no word timings and is skipped with a note; the page's own
    file picker still accepts SRT for manual additions.
    """
    files: list[dict[str, object]] = []
    skipped: list[str] = []
    for path in paths:
        if len(files) >= 2:
            break
        if path.suffix.lower() not in _PROJECT_EXTENSIONS:
            skipped.append(f"{path.name}（SRT）" if lang != "en" else f"{path.name} (SRT)")
            continue
        try:
            project = read_project(path)
        except (OSError, ValueError, PostprocessFileError, ProjectValidationFailed):
            skipped.append(path.name)
            continue
        files.append({"name": path.name, "project": project})
    return {"files": files, "warning": _skipped_note(skipped, lang)}


class ComparisonPreloadApi:
    """The child window may read its preload data, nothing else."""

    def __init__(self, payload: dict[str, object]) -> None:
        self._payload = payload

    def compare_preload(self) -> dict[str, object]:
        return self._payload


def open_comparison_window(root: Path, *, page: Path, title: str, payload: dict[str, object]) -> None:
    import webview

    if not page.is_file():
        raise OSError(f"comparison tool page is missing: {page.name}")
    window = webview.create_window(
        title,
        url=page.resolve().as_uri(),
        js_api=ComparisonPreloadApi(payload),
        width=1240,
        height=830,
        min_size=(480, 520),
        background_color="#1c1c20",
        text_select=True,
    )
    if window is None:
        raise RuntimeError("could not open the comparison window.")
