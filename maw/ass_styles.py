"""Shared user-level ASS/SRT subtitle style storage.

The Launcher and the localhost editor deliberately use the same small JSON
document.  Keeping the document independent from a project means a style can
be selected before a project is opened and can be reused by FFmpeg burn-in.
"""

from __future__ import annotations

import copy
import json
import math
import os
import platform
import re
import tempfile
import uuid
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Final

from maw.app_paths import default_app_data_root


ASS_STYLE_LIBRARY_SCHEMA: Final = "moy.asr.ass_styles.v1"
ASS_STYLE_LIBRARY_FILE_NAME: Final = "ass-styles.json"
# 三个内置样式 + 62 个自定义样式。新增第三个内置副字幕样式后，上限必须
# 覆盖旧版满员库（2 内置 + 62 自定义）归一化后的总数，否则截断会静默
# 丢弃用户的自定义样式。
MAX_STYLE_COUNT: Final = 65
MAX_PROFILE_COUNT: Final = 64
MAX_NAME_LENGTH: Final = 80
MAX_FONT_NAME_LENGTH: Final = 128
MAX_ANIMATION_TEXT_LENGTH: Final = 512
_ID_RE = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
_HEX_COLOR_RE = re.compile(r"^#[0-9a-f]{6}$", re.IGNORECASE)


def default_ass_styles_path() -> Path:
    """Return the shared, writable style-library path for the current user."""

    return default_app_data_root() / ASS_STYLE_LIBRARY_FILE_NAME


def _copy(value: Mapping[str, object]) -> dict[str, object]:
    return copy.deepcopy(dict(value))


def _text(value: object, fallback: str = "", *, limit: int = MAX_NAME_LENGTH) -> str:
    result = str(value or "")
    result = re.sub(r"[\x00-\x1f\x7f]", " ", result)
    result = re.sub(r"\s+", " ", result).strip()
    if "," in result:
        result = result.replace(",", " ")
        result = re.sub(r"\s+", " ", result).strip()
    return (result[:limit] or fallback).strip()


def _font_name(value: object, fallback: str = "Arial") -> str:
    return _text(value, fallback, limit=MAX_FONT_NAME_LENGTH)


def _animation_text(value: object, fallback: str = "") -> str:
    """Normalize free-form ASS override tags without deleting argument commas."""

    result = str(value or "")
    result = re.sub(r"[\x00-\x1f\x7f]", " ", result)
    result = result.replace("{", "").replace("}", "")
    result = re.sub(r"\s+", " ", result).strip()
    return (result[:MAX_ANIMATION_TEXT_LENGTH] or fallback).strip()


def _color(value: object, fallback: str = "#ffffff") -> str:
    candidate = str(value or "").strip().lower()
    return candidate if _HEX_COLOR_RE.fullmatch(candidate) else fallback


def _number(
    value: object,
    fallback: int | float,
    minimum: int | float,
    maximum: int | float,
    *,
    integer: bool = True,
) -> int | float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        numeric = float(fallback)
    if not math.isfinite(numeric):
        numeric = float(fallback)
    numeric = min(maximum, max(minimum, numeric))
    return int(round(numeric)) if integer else numeric


def _bool(value: object, fallback: bool = False) -> bool:
    return value if isinstance(value, bool) else fallback


def _default_ass_font_name() -> str:
    """ASS 默认字体按操作系统选择：Arial 缺少合适的中文形，容易发虚。"""

    system = platform.system()
    if system == "Windows":
        return "Microsoft YaHei"
    if system == "Darwin":
        return "PingFang SC"
    return "Noto Sans CJK SC"


def _id(value: object, fallback: str = "") -> str:
    candidate = str(value or "").strip().lower()
    return candidate if _ID_RE.fullmatch(candidate) else fallback


def _new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def _style_defaults(style_id: str, name: str) -> dict[str, object]:
    return {
        "id": style_id,
        "name": name,
        "builtin": True,
        "fontName": "Arial",
        "fontSize": 18,
        "primaryColor": "#ffffff",
        "secondaryColor": "#ffffff",
        "outlineColor": "#000000",
        "backColor": "#000000",
        "bold": False,
        "italic": False,
        "underline": False,
        "strikeOut": False,
        "scaleX": 100,
        "scaleY": 100,
        "spacing": 0,
        "angle": 0,
        "borderStyle": 1,
        "outline": 2,
        "shadow": 0,
        "alignment": 2,
        "marginL": 10,
        "marginR": 10,
        "marginV": 40,
        "encoding": 1,
    }


DEFAULT_SRT_STYLE: Final[dict[str, object]] = _style_defaults("default", "SRT 默认")
# ASS 默认样式：字体按操作系统选择、默认加粗，字号按 1080p 参考基准 72，
# 垂直边距放宽到 80。
DEFAULT_ASS_STYLE: Final[dict[str, object]] = {
    **_style_defaults("ass", "ASS 默认样式"),
    "fontName": _default_ass_font_name(),
    "bold": True,
    "fontSize": 72,
    "marginV": 80,
}
# ASS 副字幕默认样式：多重字幕的副语言轨在 ASS 导出与预览中共用一个样式
# （副字幕不支持颜色分组）；默认沿用 CSS 预览的副字幕黄色，字号约主样式
# 的 75%，垂直边距按「主边距 80 + 1.2 × 主字号 72」固化在主字幕上方。
DEFAULT_ASS_EXTENSION_STYLE: Final[dict[str, object]] = {
    **_style_defaults("ass-extension", "ASS 副字幕样式"),
    "fontName": _default_ass_font_name(),
    "bold": True,
    "primaryColor": "#ffd34d",
    "fontSize": 54,
    "marginV": 166,
}


def _animation_defaults() -> dict[str, object]:
    return {
        "fad": {"enabled": False, "inMs": 250, "outMs": 250},
        # These fields are intentionally part of v1 so newer clients can add
        # tags without changing the on-disk shape.  The first UI exposes fad.
        "fade": {
            "enabled": False,
            "alpha1": 0,
            "alpha2": 255,
            "alpha3": 0,
            "t1": 0,
            "t2": 250,
            "t3": 750,
            "t4": 1000,
        },
        "move": {
            "enabled": False,
            "x1": 0,
            "y1": 0,
            "x2": 0,
            "y2": 0,
            "t1": 0,
            "t2": 1000,
        },
        "t": {
            "enabled": False,
            "startMs": 0,
            "endMs": 1000,
            "accel": 1,
            "tags": "",
        },
    }


DEFAULT_ASS_PROFILE: Final[dict[str, object]] = {
    "id": "ass",
    "name": "ASS 输出方案",
    "builtin": True,
    "styleId": "ass",
    "animations": _animation_defaults(),
}

# 内置条目的旧默认名：归一化时改名到当前默认，用户自定义过的名字不动。
_LEGACY_BUILTIN_NAMES: Final[dict[tuple[str, str], str]] = {
    ("style", "ass"): "ASS",
    ("profile", "ass"): "ASS",
}


def _normalize_style(raw: object, fallback: Mapping[str, object], *, style_id: str) -> dict[str, object]:
    source = raw if isinstance(raw, Mapping) else {}
    base = _copy(fallback)
    base.update({
        "id": style_id,
        "name": _text(source.get("name"), str(fallback.get("name") or "样式")),
        "builtin": bool(fallback.get("builtin", False)),
        "fontName": _font_name(source.get("fontName"), str(fallback.get("fontName") or "Arial")),
        "fontSize": _number(source.get("fontSize"), fallback.get("fontSize", 18), 1, 512),
        "primaryColor": _color(source.get("primaryColor"), str(fallback.get("primaryColor") or "#ffffff")),
        "secondaryColor": _color(source.get("secondaryColor"), str(fallback.get("secondaryColor") or "#ffffff")),
        "outlineColor": _color(source.get("outlineColor"), str(fallback.get("outlineColor") or "#000000")),
        "backColor": _color(source.get("backColor"), str(fallback.get("backColor") or "#000000")),
        "bold": _bool(source.get("bold"), bool(fallback.get("bold", False))),
        "italic": _bool(source.get("italic"), bool(fallback.get("italic", False))),
        "underline": _bool(source.get("underline"), bool(fallback.get("underline", False))),
        "strikeOut": _bool(source.get("strikeOut"), bool(fallback.get("strikeOut", False))),
        "scaleX": _number(source.get("scaleX"), fallback.get("scaleX", 100), 0, 1000),
        "scaleY": _number(source.get("scaleY"), fallback.get("scaleY", 100), 0, 1000),
        "spacing": _number(source.get("spacing"), fallback.get("spacing", 0), -100, 100),
        "angle": _number(source.get("angle"), fallback.get("angle", 0), -360, 360),
        "borderStyle": _number(source.get("borderStyle"), fallback.get("borderStyle", 1), 1, 4),
        "outline": _number(source.get("outline"), fallback.get("outline", 2), 0, 100),
        "shadow": _number(source.get("shadow"), fallback.get("shadow", 0), 0, 100),
        "alignment": _number(source.get("alignment"), fallback.get("alignment", 2), 1, 9),
        "marginL": _number(source.get("marginL"), fallback.get("marginL", 10), 0, 9999),
        "marginR": _number(source.get("marginR"), fallback.get("marginR", 10), 0, 9999),
        "marginV": _number(source.get("marginV"), fallback.get("marginV", 40), 0, 9999),
        "encoding": _number(source.get("encoding"), fallback.get("encoding", 1), 0, 255),
    })
    return base


def _normalize_animation(raw: object) -> dict[str, object]:
    source = raw if isinstance(raw, Mapping) else {}
    defaults = _animation_defaults()
    fad = source.get("fad") if isinstance(source.get("fad"), Mapping) else {}
    fade = source.get("fade") if isinstance(source.get("fade"), Mapping) else {}
    move = source.get("move") if isinstance(source.get("move"), Mapping) else {}
    transform = source.get("t") if isinstance(source.get("t"), Mapping) else {}
    defaults["fad"] = {
        "enabled": _bool(fad.get("enabled"), False),
        "inMs": _number(fad.get("inMs"), 250, 0, 60000),
        "outMs": _number(fad.get("outMs"), 250, 0, 60000),
    }
    fade_t1 = _number(fade.get("t1"), 0, 0, 60000)
    fade_t2 = max(fade_t1, _number(fade.get("t2"), 250, 0, 60000))
    fade_t3 = max(fade_t2, _number(fade.get("t3"), 750, 0, 60000))
    fade_t4 = max(fade_t3, _number(fade.get("t4"), 1000, 0, 60000))
    defaults["fade"] = {
        "enabled": _bool(fade.get("enabled"), False),
        "alpha1": _number(fade.get("alpha1"), 0, 0, 255),
        "alpha2": _number(fade.get("alpha2"), 255, 0, 255),
        "alpha3": _number(fade.get("alpha3"), 0, 0, 255),
        "t1": fade_t1,
        "t2": fade_t2,
        "t3": fade_t3,
        "t4": fade_t4,
    }
    move_t1 = _number(move.get("t1"), 0, 0, 60000)
    move_t2 = max(move_t1, _number(move.get("t2"), 1000, 0, 60000))
    defaults["move"] = {
        "enabled": _bool(move.get("enabled"), False),
        "x1": _number(move.get("x1"), 0, -65535, 65535),
        "y1": _number(move.get("y1"), 0, -65535, 65535),
        "x2": _number(move.get("x2"), 0, -65535, 65535),
        "y2": _number(move.get("y2"), 0, -65535, 65535),
        "t1": move_t1,
        "t2": move_t2,
    }
    transform_start = _number(transform.get("startMs"), 0, 0, 60000)
    transform_end = max(transform_start, _number(transform.get("endMs"), 1000, 0, 60000))
    defaults["t"] = {
        "enabled": _bool(transform.get("enabled"), False),
        "startMs": transform_start,
        "endMs": transform_end,
        "accel": _number(transform.get("accel"), 1, 0.01, 100, integer=False),
        "tags": _animation_text(transform.get("tags")),
    }
    return defaults


def _normalize_profile(raw: object, fallback: Mapping[str, object], *, profile_id: str) -> dict[str, object]:
    source = raw if isinstance(raw, Mapping) else {}
    profile = _copy(fallback)
    style_id = _id(source.get("styleId"), str(fallback.get("styleId") or "ass"))
    profile.update({
        "id": profile_id,
        "name": _text(source.get("name"), str(fallback.get("name") or "ASS")),
        "builtin": bool(fallback.get("builtin", False)),
        "styleId": style_id or "ass",
        "animations": _normalize_animation(source.get("animations")),
    })
    return profile


def default_ass_style_library() -> dict[str, object]:
    """Return a fresh v1 library containing the protected built-ins."""

    return {
        "schema": ASS_STYLE_LIBRARY_SCHEMA,
        "version": 1,
        "styles": [
            _copy(DEFAULT_SRT_STYLE),
            _copy(DEFAULT_ASS_STYLE),
            _copy(DEFAULT_ASS_EXTENSION_STYLE),
        ],
        "assProfiles": [_copy(DEFAULT_ASS_PROFILE)],
        "assignments": {
            "srtBurnStyleId": "default",
            "assExportProfileId": "ass",
            "assExtensionStyleId": "ass-extension",
        },
    }


def normalize_ass_style_library(payload: object) -> dict[str, object]:
    """Repair untrusted persisted data while preserving valid user entries."""

    source = payload if isinstance(payload, Mapping) else {}
    result = default_ass_style_library()
    builtin_styles: Final[dict[str, dict[str, object]]] = {
        "default": DEFAULT_SRT_STYLE,
        "ass": DEFAULT_ASS_STYLE,
        "ass-extension": DEFAULT_ASS_EXTENSION_STYLE,
    }
    style_map: dict[str, dict[str, object]] = {
        "default": _copy(DEFAULT_SRT_STYLE),
        "ass": _copy(DEFAULT_ASS_STYLE),
        "ass-extension": _copy(DEFAULT_ASS_EXTENSION_STYLE),
    }
    raw_styles = source.get("styles")
    if isinstance(raw_styles, Sequence) and not isinstance(raw_styles, (str, bytes, bytearray)):
        for raw in raw_styles:
            if not isinstance(raw, Mapping):
                continue
            style_id = _id(raw.get("id"))
            if not style_id:
                continue
            fallback = style_map.get(style_id, {**DEFAULT_ASS_STYLE, "id": style_id, "name": "自定义样式", "builtin": False})
            normalized = _normalize_style(raw, fallback, style_id=style_id)
            if style_id not in builtin_styles:
                normalized["builtin"] = False
            style_map[style_id] = normalized
    # 内置条目若仍使用旧默认名，迁移到当前默认名；用户自定义过的名字不动。
    for entry in (*style_map.values(),):
        legacy = _LEGACY_BUILTIN_NAMES.get(("style", str(entry.get("id"))))
        if legacy and entry.get("name") == legacy:
            default_entry = builtin_styles.get(str(entry.get("id")))
            if default_entry:
                entry["name"] = default_entry["name"]
    styles = [style_map["default"], style_map["ass"], style_map["ass-extension"]]
    styles.extend(style for style_id, style in style_map.items() if style_id not in builtin_styles)
    result["styles"] = styles[:MAX_STYLE_COUNT]

    profile_map: dict[str, dict[str, object]] = {"ass": _copy(DEFAULT_ASS_PROFILE)}
    raw_profiles = source.get("assProfiles")
    if isinstance(raw_profiles, Sequence) and not isinstance(raw_profiles, (str, bytes, bytearray)):
        for raw in raw_profiles:
            if not isinstance(raw, Mapping):
                continue
            profile_id = _id(raw.get("id"))
            if not profile_id:
                continue
            fallback = profile_map.get(profile_id, {**DEFAULT_ASS_PROFILE, "id": profile_id, "name": "自定义 ASS", "builtin": False})
            normalized = _normalize_profile(raw, fallback, profile_id=profile_id)
            if profile_id != "ass":
                normalized["builtin"] = False
            profile_map[profile_id] = normalized
    for entry in profile_map.values():
        legacy = _LEGACY_BUILTIN_NAMES.get(("profile", str(entry.get("id"))))
        if legacy and entry.get("name") == legacy:
            entry["name"] = DEFAULT_ASS_PROFILE["name"]
    style_ids = {str(style.get("id")) for style in result["styles"] if isinstance(style, Mapping)}
    profiles = []
    for profile in list(profile_map.values())[:MAX_PROFILE_COUNT]:
        if profile["styleId"] not in style_ids:
            profile["styleId"] = "ass"
        profiles.append(profile)
    result["assProfiles"] = profiles or [_copy(DEFAULT_ASS_PROFILE)]
    assignments = source.get("assignments") if isinstance(source.get("assignments"), Mapping) else {}
    style_assignment = _id(assignments.get("srtBurnStyleId"), "default")
    profile_assignment = _id(assignments.get("assExportProfileId"), "ass")
    extension_assignment = _id(assignments.get("assExtensionStyleId"), "ass-extension")
    if style_assignment not in style_ids:
        style_assignment = "default"
    profile_ids = {str(profile.get("id")) for profile in result["assProfiles"] if isinstance(profile, Mapping)}
    if profile_assignment not in profile_ids:
        profile_assignment = "ass"
    if extension_assignment not in style_ids:
        extension_assignment = "ass-extension"
    result["assignments"] = {
        "srtBurnStyleId": style_assignment,
        "assExportProfileId": profile_assignment,
        "assExtensionStyleId": extension_assignment,
    }
    return result


def load_ass_style_library(path: Path | None = None) -> dict[str, object]:
    """Load and normalize the shared library; malformed data falls back safely."""

    target = path or default_ass_styles_path()
    try:
        payload = json.loads(target.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, UnicodeDecodeError, json.JSONDecodeError):
        return default_ass_style_library()
    return normalize_ass_style_library(payload)


def save_ass_style_library(payload: object, path: Path | None = None) -> dict[str, object]:
    """Normalize and atomically save a user-level library, returning its value."""

    normalized = normalize_ass_style_library(payload)
    target = path or default_ass_styles_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(
        prefix=f".{target.stem}.", suffix=".tmp", dir=target.parent,
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as output:
            json.dump(normalized, output, ensure_ascii=False, indent=2)
            output.write("\n")
        os.replace(temporary_name, target)
    except Exception:
        # Keep the temporary file for post-mortem recovery, matching the
        # server-settings persistence contract.
        raise
    return normalized


def find_ass_style(library: Mapping[str, object], style_id: object) -> dict[str, object]:
    target = _id(style_id, "default")
    styles = library.get("styles")
    if isinstance(styles, Sequence) and not isinstance(styles, (str, bytes, bytearray)):
        for style in styles:
            if isinstance(style, Mapping) and style.get("id") == target:
                return _copy(style)
    return _copy(DEFAULT_SRT_STYLE if target == "default" else DEFAULT_ASS_STYLE)


def find_ass_profile(library: Mapping[str, object], profile_id: object) -> dict[str, object]:
    target = _id(profile_id, "ass")
    profiles = library.get("assProfiles")
    if isinstance(profiles, Sequence) and not isinstance(profiles, (str, bytes, bytearray)):
        for profile in profiles:
            if isinstance(profile, Mapping) and profile.get("id") == target:
                return _copy(profile)
    return _copy(DEFAULT_ASS_PROFILE)


def ass_color(value: object, fallback: str = "#ffffff") -> str:
    """Convert a CSS hex colour into ASS's ``&HAABBGGRR`` notation."""

    color = _color(value, fallback)
    return f"&H00{color[5:7]}{color[3:5]}{color[1:3]}".upper()


def ass_style_line(style: Mapping[str, object], *, name: str = "Default") -> str:
    """Serialize one normalized style as a ``Style:`` line."""

    normalized = _normalize_style(style, DEFAULT_ASS_STYLE, style_id=_id(style.get("id"), "ass"))
    def bool_value(key: str) -> int:
        return -1 if normalized.get(key) else 0
    values = [
        name,
        normalized["fontName"],
        normalized["fontSize"],
        ass_color(normalized["primaryColor"]),
        ass_color(normalized["secondaryColor"]),
        ass_color(normalized["outlineColor"]),
        ass_color(normalized["backColor"]),
        bool_value("bold"),
        bool_value("italic"),
        bool_value("underline"),
        bool_value("strikeOut"),
        normalized["scaleX"],
        normalized["scaleY"],
        normalized["spacing"],
        normalized["angle"],
        normalized["borderStyle"],
        normalized["outline"],
        normalized["shadow"],
        normalized["alignment"],
        normalized["marginL"],
        normalized["marginR"],
        normalized["marginV"],
        normalized["encoding"],
    ]
    return "Style: " + ",".join(str(value) for value in values)


def ass_style_force_style(style: Mapping[str, object]) -> str:
    """Serialize style fields accepted by FFmpeg's ``force_style`` option."""

    normalized = _normalize_style(style, DEFAULT_SRT_STYLE, style_id="default")
    values = [
        ("FontName", normalized["fontName"]),
        ("FontSize", normalized["fontSize"]),
        ("PrimaryColour", ass_color(normalized["primaryColor"])),
        ("SecondaryColour", ass_color(normalized["secondaryColor"])),
        ("OutlineColour", ass_color(normalized["outlineColor"])),
        ("BackColour", ass_color(normalized["backColor"])),
        ("Bold", -1 if normalized["bold"] else 0),
        ("Italic", -1 if normalized["italic"] else 0),
        ("Underline", -1 if normalized["underline"] else 0),
        ("StrikeOut", -1 if normalized["strikeOut"] else 0),
        ("ScaleX", normalized["scaleX"]),
        ("ScaleY", normalized["scaleY"]),
        ("Spacing", normalized["spacing"]),
        ("Angle", normalized["angle"]),
        ("BorderStyle", normalized["borderStyle"]),
        ("Outline", normalized["outline"]),
        ("Shadow", normalized["shadow"]),
        ("Alignment", normalized["alignment"]),
        ("MarginL", normalized["marginL"]),
        ("MarginR", normalized["marginR"]),
        ("MarginV", normalized["marginV"]),
    ]
    return ",".join(f"{key}={value}" for key, value in values)
