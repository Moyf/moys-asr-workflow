"""Optional outline-font inventory for explicit ASS/Canvas fallback selection.

Unicode cmap coverage is only a prerequisite, not a guarantee of correct shaping.
No file locations leave this module. Inventory is a process-lifetime snapshot;
restart the editor after installing/removing fonts (like the alias inventory).
"""
from __future__ import annotations

import json
import platform
from functools import lru_cache
from pathlib import Path
from typing import Any

from maw import ass_fonts

SCHEMA = "moy.asr.font_coverage.v1"
_MAX_FACES = 4096
_MAX_RANGES_PER_FACE = 8192
_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024


def fallback_families(system: str | None = None) -> list[str]:
    system = system or platform.system()
    if system == "Windows":
        return ["Microsoft YaHei", "Arial", "Segoe UI Symbol"]
    if system == "Darwin":
        return ["PingFang SC", "Arial", "Arial Unicode MS", "Apple Symbols"]
    return ["Noto Sans CJK SC", "Noto Sans", "DejaVu Sans"]


def _ranges(codepoints: Any) -> list[list[int]]:
    result: list[list[int]] = []
    for cp in sorted(set(codepoints)):
        if not 0 <= cp <= 0x10FFFF or 0xD800 <= cp <= 0xDFFF:
            continue
        if result and cp == result[-1][1] + 1:
            result[-1][1] = cp
        else:
            result.append([cp, cp])
    return result


def _face_payload(font: Any) -> dict[str, Any] | None:
    # Bitmap-only color emoji cannot be used by the current libass outline path.
    if not any(table in font for table in ("glyf", "CFF ", "CFF2")):
        return None
    # Variable font instances require additional axis matching, not merely weight.
    if "fvar" in font:
        return None
    names = ass_fonts._extract_font_names(font)
    family = ass_fonts._canonical_family_name(names.family, ass_fonts._system_ui_language_keys())
    if not family or any(c in family for c in "\\{}\r\n"):
        return None
    cmap = font.getBestCmap() or {}
    ranges = _ranges(cp for cp, glyph in cmap.items() if glyph != ".notdef")
    if not ranges or len(ranges) > _MAX_RANGES_PER_FACE:
        return None
    head = font["head"]
    os2 = font["OS/2"]
    height = int(os2.usWinAscent) + int(os2.usWinDescent)
    ratio = int(head.unitsPerEm) / height if height > 0 else 0
    if not 0 < ratio <= 4:
        return None
    return {
        "family": family,
        "names": list(dict.fromkeys(names.all_names())),
        "postscript": list(names.postscript),
        "weight": max(1, min(1000, int(os2.usWeightClass))),
        "italic": bool(int(os2.fsSelection) & 1 or int(head.macStyle) & 2),
        "ranges": ranges,
        "emRatio": ratio,
    }


def _read_faces(path: Path) -> tuple[list[dict[str, Any]], bool]:
    from fontTools.ttLib import TTCollection, TTFont

    faces: list[Any] = []
    collection = None
    result = []
    complete = True
    try:
        if path.suffix.casefold() in ass_fonts._TTC_SUFFIXES:
            collection = TTCollection(str(path), lazy=True)
            faces = list(collection.fonts)
        else:
            faces = [TTFont(str(path), lazy=True)]
        for font in faces:
            try:
                item = _face_payload(font)
                if item is not None:
                    result.append(item)
                else:
                    complete = False
            except Exception:  # malformed individual face must not hide siblings
                complete = False
    except Exception:
        complete = False
    finally:
        # TTC lazy tables share a stream. Close only AFTER processing every face.
        if collection is not None:
            collection.close()
        else:
            for font in faces:
                font.close()
    return result, complete


@lru_cache(maxsize=1)
def _cached_payload_json() -> str | None:
    try:
        import fontTools.ttLib  # noqa: F401 - fail safely even for an empty inventory

        faces = []
        seen = set()
        cmaps = []
        cmap_indices = {}
        size = 0
        complete = True
        # Keep core platform fallbacks even on hosts with thousands of fonts.
        # Only basenames influence scan priority; paths are never serialized.
        preferred = ("pingfang", "msyh", "arial", "seguisym", "applesymbols")
        paths = sorted(ass_fonts._installed_font_files(), key=lambda p: (
            0 if any(token in p.stem.casefold().replace(" ", "") for token in preferred) else 1,
            str(p).casefold(),
        ))
        for path in paths:
            items, readable = _read_faces(path)
            complete = complete and readable
            for item in items:
                ranges = item.pop("ranges")
                cmap_key = json.dumps(ranges, separators=(",", ":"))
                new_cmap = cmap_key not in cmap_indices
                item["cmap"] = cmap_indices.get(cmap_key, len(cmaps))
                encoded = json.dumps(item, ensure_ascii=False, separators=(",", ":"))
                if encoded in seen:
                    continue
                extra = len(encoded.encode("utf-8")) + 1
                if new_cmap:
                    extra += len(cmap_key) + 1
                if len(faces) >= _MAX_FACES or size + extra > _MAX_PAYLOAD_BYTES - 1024:
                    complete = False
                    continue
                if new_cmap:
                    cmap_indices[cmap_key] = len(cmaps)
                    cmaps.append(ranges)
                size += extra
                seen.add(encoded)
                faces.append(item)
        return json.dumps({"schema": SCHEMA, "faces": faces, "cmaps": cmaps,
                           "fallbacks": fallback_families(), "complete": complete},
                          ensure_ascii=False, separators=(",", ":"))
    except Exception:
        return None


def font_coverage_payload() -> dict[str, Any] | None:
    """A bounded copy, or None when unavailable; never changes normalization."""
    encoded = _cached_payload_json()
    return json.loads(encoded) if encoded is not None else None
