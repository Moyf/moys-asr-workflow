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
_FILLER_ONLY = re.compile("[啊呀呢吧呃嗯哦唉]+")


def information_loss_reason(source: str, replacement: str) -> str | None:
    """Similarity is evidence of another take, never proof that it covers facts.

    Only harmless filler deletions are locally provable. Paraphrases with lost
    source wording stay available for human review rather than being guessed
    equivalent; the later readthrough also checks semantic continuity.
    """
    source = unicodedata.normalize("NFKC", source).lower()
    replacement = unicodedata.normalize("NFKC", replacement).lower()
    if Counter(_NUMBERS.findall(source)) != Counter(_NUMBERS.findall(replacement)):
        return "备用片段的数字或比例不同，需要确认信息覆盖"
    if Counter(_CONDITIONS.findall(source)) != Counter(_CONDITIONS.findall(replacement)):
        return "备用片段的否定或限定条件不同，需要确认信息覆盖"
    original = "".join(char for char in source if char.isalnum())
    alternate = "".join(char for char in replacement if char.isalnum())
    matcher = difflib.SequenceMatcher(None, original, alternate, autojunk=False)
    for operation, start, end, _alt_start, _alt_end in matcher.get_opcodes():
        if operation not in {"delete", "replace"}:
            continue
        missing = original[start:end]
        if missing and not _FILLER_ONLY.fullmatch(missing):
            return f"备用片段未能字面覆盖原段信息「{missing[:40]}」，需要复核"
    return None
