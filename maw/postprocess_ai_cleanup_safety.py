"""Conservative, local information-coverage guards for whole-cue deletion."""

from __future__ import annotations

import difflib
import re
import unicodedata
from collections import Counter


_NUMBERS = re.compile(r"\d+(?:\.\d+)?(?:%|‰)?|[零〇一二两三四五六七八九十百千万亿]+")
_CONDITIONS = re.compile(
    "不能|不可|不必|不再|没有|无需|并非|不是|只有|除非|如果|至少|至多|最多|最少|"
    r"可能|大概|通常|一般|部分|必须|需要|仅|只|约|不|没|未|无|"
    r"\b(?:not|never|no|without|only|unless|if|at least|at most|may|might|must|should)\b"
)
# 纯感叹/拟声词在任何位置都没有命题内容，可整体作为口水词移除；
# 「吧呢呀」是语气助词，只在整段独立成句时无内容，不进入句中删除白名单
# （「走吧」删「吧」会改变句义）。
PURE_INTERJECTIONS = "哎啊呃嗯哦噢唉诶欸唔哟"
_TONE_PARTICLES = "吧呢呀"
WHOLE_UTTERANCE_INTERJECTIONS = PURE_INTERJECTIONS + "呀"
_FILLER_ONLY = re.compile(f"[{PURE_INTERJECTIONS}{_TONE_PARTICLES}]+")
_RESTART_STRIP_CHARS = PURE_INTERJECTIONS + _TONE_PARTICLES
_NEGATIONS = re.compile(r"不|没|未|无|除非|\b(?:not|never|no|without|unless)\b", re.I)


def english_hesitation_only(text: str) -> bool:
    """Recognize only isolated hesitation sounds, never English content words."""
    return re.fullmatch(r"(?:u+h+|u+m+|h+m+)(?:[\s,.!?;:…]+(?:u+h+|u+m+|h+m+))*[\s,.!?;:…]*", text.strip(), re.I) is not None


def safe_echo_phrase(text: str) -> bool:
    """Literal repeated positive qualifiers can restart; numbers/negation cannot."""
    value = unicodedata.normalize("NFKC", text).lower()
    return not (_NUMBERS.search(value) or _NEGATIONS.search(value))


def protected_information_loss_reason(source: str, replacement: str) -> str | None:
    """Check facts before any repeated-speech normalization shortcut."""
    source = unicodedata.normalize("NFKC", source).lower()
    replacement = unicodedata.normalize("NFKC", replacement).lower()
    if Counter(_NUMBERS.findall(source)) != Counter(_NUMBERS.findall(replacement)):
        return "备用片段的数字或比例不同，需要确认信息覆盖"
    if Counter(_CONDITIONS.findall(source)) != Counter(_CONDITIONS.findall(replacement)):
        return "备用片段的否定或限定条件不同，需要确认信息覆盖"
    return None


def information_loss_reason(source: str, replacement: str) -> str | None:
    """Similarity is evidence of another take, never proof that it covers facts.

    Only harmless filler deletions are locally provable. Paraphrases with lost
    source wording stay available for human review rather than being guessed
    equivalent; the later readthrough also checks semantic continuity.
    """
    source = unicodedata.normalize("NFKC", source).lower()
    replacement = unicodedata.normalize("NFKC", replacement).lower()
    original = "".join(char for char in source if char.isalnum())
    alternate = "".join(char for char in replacement if char.isalnum())
    protected = protected_information_loss_reason(source, replacement)
    if protected:
        return protected
    if original and original in alternate:
        return None
    matcher = difflib.SequenceMatcher(None, original, alternate, autojunk=False)
    for operation, start, end, alt_start, alt_end in matcher.get_opcodes():
        if operation not in {"delete", "replace"}:
            continue
        missing = original[start:end]
        # A one-character grammatical homophone at the same aligned boundary
        # is comparison evidence only. Source words are never corrected here.
        if operation == "replace" and len(missing) == 1 and missing in "的得地" and alternate[alt_start:alt_end] in "的得地" and alt_end - alt_start == 1:
            continue
        if missing and not _FILLER_ONLY.fullmatch(missing):
            return f"备用片段未能字面覆盖原段信息「{missing[:40]}」，需要复核"
    return None


def local_information_loss_reason(
    removed: str, retained: str, before: str, after: str, script_line: str,
) -> str | None:
    """Prove only filler and adjacent literal restart fragments locally."""
    def normalize(value: str) -> str:
        return "".join(char for char in unicodedata.normalize("NFKC", value).lower() if char.isalnum())

    normalized_removed = unicodedata.normalize("NFKC", removed).lower()
    if _NUMBERS.search(normalized_removed):
        return "局部内容包含数字或比例，需要人工确认"
    adjacent_literal = bool(removed) and (after.startswith(removed) or before.endswith(removed))
    if _CONDITIONS.search(normalized_removed) and not (adjacent_literal and safe_echo_phrase(removed)):
        return "局部内容包含否定或限定条件，需要人工确认"
    lost = normalize(removed)
    # Filler can surround an aborted restart, but never hide substantive words.
    restart = lost.strip(_RESTART_STRIP_CHARS)
    if restart and not (normalize(after).startswith(restart) or normalize(before).endswith(restart)):
        return "缺少可本地验证的相邻口吃或重复证据"
    manuscript = normalize(script_line)
    if manuscript and manuscript not in normalize(retained):
        return "局部移除后不能字面覆盖对应文稿内容，需要复核"
    return None
