"""User-level editor recipes and the optional project overrides."""

from __future__ import annotations

import json
import os
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from maw.app_paths import default_app_data_root

MAX_LIBRARY_BYTES = 1024 * 1024
MAX_STEPS = 110
MAX_PRESETS = 100
MAX_STEP_TEXT = 512 * 1024
LEGACY_SCHEMA = "moy.asr.text_processing_presets.v1"
SCHEMA = "moy.asr.text_processing_presets.v2"
LIBRARY_FILENAME = "editor-processing.json"
LEGACY_FILENAME = "text-processing-presets.json"
SIMPLE_STEPS = {"trim", "capitalize", "convertChineseNumbers", "stripMarkdown"}
WRAP_IDS = {
    "emphasis", "large", "comment", "small", "italic", "strike", "underline",
    "fade", "shake", "pop", "note", "music", "bracket", "custom",
}


class ProcessingConflict(ValueError):
    def __init__(self, current: dict[str, Any]) -> None:
        super().__init__("Processing settings were updated in another editor.")
        self.current = current


def _object(value: object) -> dict:
    if not isinstance(value, dict):
        raise ValueError("Expected a processing settings object.")
    return value


def _text(value: object, limit: int = MAX_STEP_TEXT) -> str:
    if not isinstance(value, str) or len(value.encode("utf-16-le", errors="strict")) > 2 * limit:
        raise ValueError("Invalid processing text or text length.")
    return value


def _flag(value: object) -> bool:
    if type(value) is not bool:
        raise ValueError("Expected a boolean processing option.")
    return value


def normalize_steps(raw: object) -> list[dict]:
    if not isinstance(raw, list) or len(raw) > MAX_STEPS:
        raise ValueError(f"Expected at most {MAX_STEPS} processing steps.")
    steps = []
    for value in raw:
        step = _object(value)
        kind = _text(step.get("type"), 32)
        enabled = _flag(step.get("enabled", True))
        if kind in SIMPLE_STEPS:
            steps.append({"type": kind, "enabled": enabled})
        elif kind == "replace":
            find = _text(step.get("find"))
            steps.append({
                "type": kind, "enabled": enabled, "find": find, "replacement": _text(step.get("replacement")),
                "regex": _flag(step.get("regex")), "caseSensitive": _flag(step.get("caseSensitive")),
            })
        elif kind == "wrap":
            wraps = step.get("wraps")
            if not isinstance(wraps, list) or not len(wraps) <= 100:
                raise ValueError("Invalid character wrappers.")
            pairs = []
            for value in wraps:
                wrapper = _object(value)
                wrap_id = _text(wrapper.get("id"), 32)
                if wrap_id not in WRAP_IDS:
                    raise ValueError("Unknown character wrapper.")
                pair = {"id": wrap_id}
                if wrap_id == "custom" or "left" in wrapper or "right" in wrapper:
                    pair.update(left=_text(wrapper.get("left", "")), right=_text(wrapper.get("right", "")))
                pairs.append(pair)
            steps.append({"type": kind, "enabled": enabled, "wraps": pairs})
        else:
            raise ValueError("Unknown text-processing step.")
    return steps


def normalize_subtitle_join(raw: object) -> dict:
    value = _object(raw)
    gap = value.get("gapMs")
    count = value.get("shortCount")
    snap = value.get("snapDirection")
    absorb = value.get("absorbDirection")
    if type(gap) is not int or not 0 <= gap <= 10_000 or type(count) is not int or not 1 <= count <= 20:
        raise ValueError("Subtitle join value out of range.")
    if snap not in ("backward", "forward") or absorb not in ("previous", "next"):
        raise ValueError("Invalid subtitle join direction.")
    return {"gapMs": gap, "shortCount": count, "snapDirection": snap, "absorbDirection": absorb,
            "absorbShort": _flag(value.get("absorbShort"))}


def normalize_overrides(raw: object) -> dict:
    value = _object(raw)
    result = {}
    if "text" in value:
        result["text"] = normalize_steps(value["text"])
    if "join" in value:
        result["join"] = normalize_subtitle_join(value["join"])
    return result


def _legacy_steps(preset: dict) -> list[dict]:
    rules = preset.get("rules")
    ops = _object(preset.get("operations"))
    if not isinstance(rules, list) or len(rules) > 100:
        raise ValueError("替换规则格式无效")
    steps = []
    for raw_rule in rules:
        rule = _object(raw_rule)
        steps.append({"type": "replace", "find": rule.get("find"), "replacement": rule.get("replace"),
                      "enabled": _flag(rule.get("enabled")), "regex": rule.get("regex"),
                      "caseSensitive": rule.get("caseSensitive")})
    for kind in ("stripMarkdown", "trim", "capitalize", "convertChineseNumbers"):
        if _flag(ops.get(kind, False)):
            steps.append({"type": kind})
    if "left" in ops:
        _text(ops["left"])
    if "right" in ops:
        _text(ops["right"])
    wraps = ops.get("wraps", [])
    if not isinstance(wraps, list):
        raise ValueError("预设操作格式无效")
    if wraps:
        pairs = []
        for raw_wrap in wraps:
            wrap = _object(raw_wrap)
            if not isinstance(wrap.get("id"), str):
                raise ValueError("Unknown character wrapper.")
            _text(wrap.get("left"))
            _text(wrap.get("right"))
            pairs.append({**wrap, "left": ops.get("left", ""), "right": ops.get("right", "")}
                         if wrap["id"] == "custom" else
                         wrap if wrap["id"] in WRAP_IDS else {**wrap, "id": "custom"})
        pairs = [pair for pair in pairs if pair["left"] or pair["right"]]
        if pairs:
            steps.append({"type": "wrap", "wraps": pairs})
    return steps


def validate_library(raw: object) -> dict:
    value = _object(raw)
    revision = value.get("revision", 0)
    if value.get("schema") not in (SCHEMA, LEGACY_SCHEMA) or type(revision) is not int or not 0 <= revision < 2**53 - 1:
        raise ValueError("Invalid editor processing library version or revision.")
    presets = value.get("presets")
    if not isinstance(presets, list) or len(presets) > MAX_PRESETS:
        raise ValueError("Invalid editor processing preset list.")
    result = []
    ids = set()
    for raw_preset in presets:
        preset = _object(raw_preset)
        preset_id = _text(preset.get("id"), 160)
        name = _text(preset.get("name"), 160).strip()
        scope = preset.get("scope")
        steps = normalize_steps(preset["steps"] if "steps" in preset else _legacy_steps(preset))
        if not preset_id or preset_id in ids or not name or scope not in ("all", "selected"):
            raise ValueError("预设格式无效")
        ids.add(preset_id)
        result.append({"id": preset_id, "name": name, "scope": scope, "steps": steps})
    default = value.get("defaultPresetId")
    if default is not None and _text(default, 160) not in ids:
        raise ValueError("Unknown default editor processing preset.")
    library = {"schema": SCHEMA, "revision": revision, "presets": result, "defaultPresetId": default}
    if "join" in value:
        library["join"] = normalize_subtitle_join(value["join"])
    return library


def _read_library(path: Path, legacy_path: Path | None = None) -> dict:
    try:
        with path.open("rb") as source:
            raw = source.read(MAX_LIBRARY_BYTES + 1)
    except FileNotFoundError:
        if legacy_path is not None:
            return _read_library(legacy_path)
        return {"schema": SCHEMA, "revision": 0, "presets": [], "defaultPresetId": None}
    if len(raw) > MAX_LIBRARY_BYTES:
        raise ValueError("Editor processing library is too large.")
    return validate_library(json.loads(raw))


def _library_paths(path: Path | None) -> tuple[Path, Path | None]:
    if path is not None:
        return path, None
    root = default_app_data_root()
    return root / LIBRARY_FILENAME, root / LEGACY_FILENAME


def load_library(path: Path | None = None) -> dict:
    return _read_library(*_library_paths(path))


@contextmanager
def _lock_library(path: Path):
    # Keep the lock inode stable while replacing the library. The OS releases
    # the byte/file lock if an editor process exits during a write.
    with path.with_suffix(".lock").open("a+b") as handle:
        if os.name == "nt":
            import msvcrt

            deadline = time.monotonic() + 2
            while True:
                handle.seek(0)
                try:
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                except OSError:
                    if time.monotonic() >= deadline:
                        raise
                    time.sleep(0.05)
                else:
                    break
        else:
            import fcntl

            fcntl.flock(handle, fcntl.LOCK_EX)
        yield  # Closing the handle releases the lock on both platforms.


def save_library(raw: object, path: Path | None = None) -> dict:
    path, legacy_path = _library_paths(path)
    library = validate_library(raw)
    path.parent.mkdir(parents=True, exist_ok=True)
    with _lock_library(path):
        current = _read_library(path, legacy_path)
        if library["revision"] != current["revision"]:
            raise ProcessingConflict(current)
        library["revision"] += 1
        serialized = json.dumps(library, ensure_ascii=False, indent=2) + "\n"
        if len(serialized.encode("utf-8")) > MAX_LIBRARY_BYTES:
            raise ValueError("Editor processing library is too large.")
        fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".editor-processing-", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as output:
                output.write(serialized)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, path)
        finally:
            Path(temporary).unlink(missing_ok=True)
    return library
