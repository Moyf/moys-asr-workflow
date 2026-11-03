"""User-level subtitle processing presets, independent of project files."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

from maw.app_paths import default_app_data_root

SCHEMA = "moy.asr.text_processing_presets.v1"
MAX_BYTES = 512 * 1024


def validate_library(value: object) -> dict:
    if not isinstance(value, dict) or value.get("schema") != SCHEMA:
        raise ValueError("不支持的预设库格式")
    presets = value.get("presets")
    if not isinstance(presets, list) or len(presets) > 100:
        raise ValueError("预设列表无效")
    ids = set()
    for preset in presets:
        if not isinstance(preset, dict):
            raise ValueError("预设格式无效")
        identifier, name = preset.get("id"), preset.get("name")
        if (not isinstance(identifier, str) or not identifier or len(identifier) > 160
                or identifier in ids or not isinstance(name, str) or not name.strip() or len(name) > 160):
            raise ValueError("预设名称或标识无效")
        ids.add(identifier)
        if preset.get("scope") not in ("all", "selected"):
            raise ValueError("预设范围无效")
        operations = preset.get("operations")
        if not isinstance(operations, dict):
            raise ValueError("预设操作无效")
        for key in ("trim", "capitalize", "convertChineseNumbers", "stripMarkdown"):
            if key in operations and not isinstance(operations[key], bool):
                raise ValueError("预设操作格式无效")
        for key in ("left", "right"):
            if key in operations and not isinstance(operations[key], str):
                raise ValueError("预设字符格式无效")
        wraps = operations.get("wraps", [])
        if (not isinstance(wraps, list) or len(wraps) > 100
                or any(not isinstance(wrap, dict) or any(not isinstance(wrap.get(key), str)
                       for key in ("id", "left", "right")) for wrap in wraps)):
            raise ValueError("预设包裹字符格式无效")
        rules = preset.get("rules")
        if not isinstance(rules, list) or len(rules) > 100:
            raise ValueError("预设规则无效")
        for rule in rules:
            if (not isinstance(rule, dict) or not isinstance(rule.get("find"), str)
                    or not isinstance(rule.get("replace"), str)
                    or any(not isinstance(rule.get(key), bool) for key in ("enabled", "regex", "caseSensitive"))):
                raise ValueError("替换规则格式无效")
    return {"schema": SCHEMA, "presets": presets}


def load_library(path: Path | None = None) -> dict:
    target = path or default_app_data_root() / "text-processing-presets.json"
    try:
        content = target.read_bytes()
    except FileNotFoundError:
        return {"schema": SCHEMA, "presets": []}
    if len(content) > MAX_BYTES:
        raise ValueError("预设库过大")
    return validate_library(json.loads(content.decode("utf-8")))


def save_library(value: object, path: Path | None = None) -> dict:
    library = validate_library(value)
    data = json.dumps(library, ensure_ascii=False, indent=2) + "\n"
    if len(data.encode("utf-8")) > MAX_BYTES:
        raise ValueError("预设库过大")
    target = path or default_app_data_root() / "text-processing-presets.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".text-presets-", suffix=".tmp", dir=target.parent)
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as output:
        output.write(data)
    os.replace(temporary, target)
    return library
