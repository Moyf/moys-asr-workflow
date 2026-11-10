"""热词表导出与硬限制预检（规则与 maw.qwen_audio 完全一致）。"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Final

from maw.qwen_audio import parse_qwen_audio_hotword

HOTWORDS_FILENAME: Final[str] = "hotwords.txt"
EXPORT_ISSUE_LABELS: Final[dict[str, str]] = {
    "empty": "热词名称为空",
    "text_too_long": "含非 ASCII 字符时最多 15 个字符",
    "too_many_ascii_words": "纯 ASCII 热词最多 7 个空格分隔的单词",
    "invalid_weight": "权重只能是 1–5 或 50",
}


def hotword_issue(word: str) -> str | None:
    """返回该词作为热词的问题说明；None 表示可导出。"""

    _entry, code = parse_qwen_audio_hotword(word)
    if code is None:
        return None
    return EXPORT_ISSUE_LABELS.get(code, code)


def weight_for_score(score: int) -> int | None:
    """--weight-by-score 的分数带映射：≥80→5、70–79→4、60–69→3；其余不配权重。"""

    if score >= 80:
        return 5
    if score >= 70:
        return 4
    if score >= 60:
        return 3
    return None


def build_hotword_line(word: str, score: int | None = None, *, weight_by_score: bool = False) -> str:
    if weight_by_score and score is not None:
        weight = weight_for_score(int(score))
        if weight is not None:
            return f"{word}: {weight}"
    return word


def build_hotwords(
    selected: Sequence[Mapping[str, object]],
    *,
    weight_by_score: bool = False,
) -> tuple[str, list[dict[str, str]]]:
    """从勾选候选生成热词文本；返回 (文本, 不可导出项及原因列表)。"""

    lines: list[str] = []
    seen: set[str] = set()
    rejected: list[dict[str, str]] = []
    for candidate in selected:
        word = str(candidate.get("word") or "").strip()
        if not word:
            continue
        issue = hotword_issue(word)
        if issue is not None:
            rejected.append({"word": word, "reason": issue})
            continue
        if word in seen:
            continue
        seen.add(word)
        lines.append(build_hotword_line(word, candidate.get("score"), weight_by_score=weight_by_score))
    return "\n".join(lines) + ("\n" if lines else ""), rejected
