"""Shared Qwen-Audio hotword parsing and validation helpers."""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass


QWEN_AUDIO_HOTWORD_WEIGHTS = frozenset({1, 2, 3, 4, 5, 50})
QWEN_AUDIO_MAX_HOTWORDS = 2000
QWEN_AUDIO_MAX_SUPER_HOTWORDS = 50
QWEN_AUDIO_MAX_MIXED_HOTWORD_CHARS = 15
QWEN_AUDIO_MAX_ASCII_HOTWORD_WORDS = 7


@dataclass(frozen=True, slots=True)
class QwenAudioHotword:
    text: str
    weight: int


@dataclass(frozen=True, slots=True)
class QwenAudioHotwordIssue:
    index: int
    text: str
    code: str


def split_qwen_audio_hotwords(value: str) -> list[str]:
    """把 Launcher 的换行/逗号/分号分隔热词转换成单项列表。"""
    return [
        word.strip()
        for word in re.split(r"[\r\n,，;；]+", value)
        if word.strip()
    ]


def parse_qwen_audio_hotword(value: str, default_weight: int | str = 5) -> tuple[QwenAudioHotword | None, str | None]:
    """解析单个热词，可选使用英文或中文冒号覆盖全局权重。"""
    text = value.strip()
    if not text:
        return None, "empty"
    try:
        fallback_weight = int(default_weight)
    except (TypeError, ValueError):
        fallback_weight = 5

    match = re.fullmatch(r"(.+?)\s*[:：]\s*([0-9]+)\s*", text)
    if match:
        text = match.group(1).strip()
        weight = int(match.group(2))
        if weight not in QWEN_AUDIO_HOTWORD_WEIGHTS:
            return None, "invalid_weight"
    else:
        weight = fallback_weight

    if not text:
        return None, "empty"
    if any(ord(char) > 127 for char in text):
        if len(text) > QWEN_AUDIO_MAX_MIXED_HOTWORD_CHARS:
            return None, "text_too_long"
    elif len(text.split()) > QWEN_AUDIO_MAX_ASCII_HOTWORD_WORDS:
        return None, "too_many_ascii_words"
    return QwenAudioHotword(text=text, weight=weight), None


def parse_qwen_audio_hotwords(
    hotwords: Iterable[str],
    default_weight: int | str = 5,
) -> tuple[list[QwenAudioHotword], list[QwenAudioHotwordIssue]]:
    """解析、去重并过滤不符合 Qwen-Audio 规则的热词。"""
    parsed: dict[str, tuple[int, QwenAudioHotword]] = {}
    issues: list[QwenAudioHotwordIssue] = []
    for index, raw in enumerate(hotwords, start=1):
        entry, code = parse_qwen_audio_hotword(str(raw), default_weight)
        if code:
            if str(raw).strip():
                issues.append(QwenAudioHotwordIssue(index=index, text=str(raw).strip(), code=code))
            continue
        assert entry is not None
        parsed[entry.text] = (index, entry)

    entries: list[QwenAudioHotword] = []
    super_count = 0
    for index, entry in sorted(parsed.values(), key=lambda value: value[0]):
        if len(entries) >= QWEN_AUDIO_MAX_HOTWORDS:
            issues.append(QwenAudioHotwordIssue(index=index, text=entry.text, code="too_many"))
            continue
        if entry.weight == 50 and super_count >= QWEN_AUDIO_MAX_SUPER_HOTWORDS:
            issues.append(QwenAudioHotwordIssue(index=index, text=entry.text, code="too_many_super"))
            continue
        entries.append(entry)
        if entry.weight == 50:
            super_count += 1
    return entries, issues
