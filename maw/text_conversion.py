"""Local Simplified/Traditional Chinese conversion for subtitle text."""

from __future__ import annotations

from enum import StrEnum
from functools import lru_cache
from typing import Final

from maw.project_preview import JsonDict


class TextConversion(StrEnum):
    OFF = "off"
    TO_SIMPLIFIED = "to_simplified"
    TO_TRADITIONAL = "to_traditional"


TEXT_CONVERSION_MODES: Final[frozenset[str]] = frozenset(item.value for item in TextConversion)
_OPENCC_CONFIGS: Final[dict[TextConversion, str]] = {
    TextConversion.TO_SIMPLIFIED: "t2s",
    TextConversion.TO_TRADITIONAL: "s2t",
}


class TextConversionUnavailable(RuntimeError):
    """Raised when the optional conversion engine cannot be loaded."""


def normalize_text_conversion_mode(value: object) -> TextConversion:
    """Normalize untrusted plan/UI data without enabling conversion by accident."""

    if isinstance(value, TextConversion):
        return value
    try:
        return TextConversion(str(value or "").strip().lower())
    except ValueError:
        return TextConversion.OFF


def convert_text(text: str, mode: object) -> str:
    """Convert one text value with the requested OpenCC direction."""

    conversion = normalize_text_conversion_mode(mode)
    if conversion is TextConversion.OFF or not text:
        return text
    config = _OPENCC_CONFIGS[conversion]
    try:
        return _converter(config).convert(text)
    except ImportError as error:
        raise TextConversionUnavailable(
            "简繁转换需要 OpenCC 支持，请重新安装 MAW 或运行 `uv sync`。"
        ) from error


def apply_text_conversion(segments: list[JsonDict], mode: object) -> bool:
    """Convert segment text and remove stale word timings when text changes."""

    conversion = normalize_text_conversion_mode(mode)
    if conversion is TextConversion.OFF:
        return False
    changed = False
    for segment in segments:
        original = segment.get("text")
        if not isinstance(original, str):
            continue
        converted = convert_text(original, conversion)
        if converted == original:
            continue
        segment["text"] = converted
        segment.pop("items", None)
        changed = True
    return changed


@lru_cache(maxsize=2)
def _converter(config: str):
    try:
        from opencc import OpenCC
    except ImportError:
        raise
    return OpenCC(config)
