"""内置忽略词与可解释规则评分（SPEC §3.4）。

规则评分只管召回：每个候选的加减分理由完整保留，语义判断交给 AI 筛选
与 HTML 人工确认两道关。
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Final

from maw.postprocess_ocr import normalize

from .export import hotword_issue

IGNORE_WORDS: Final[frozenset[str]] = frozenset(
    {
        "继续", "设置", "保存", "取消", "确认", "退出", "返回", "关闭",
        "任务完成", "任务失败", "加载中", "请稍候", "按任意键继续", "开始游戏",
        "继续游戏", "新的游戏", "读取存档", "保存游戏", "是否保存", "想要保存更改吗",
        "更改未保存", "确定", "应用", "下一步", "上一步", "返回游戏", "选项",
        "音量", "画质", "分辨率", "全屏", "字幕", "语言", "难度", "登录", "注册",
        "continue", "settings", "save", "cancel", "ok", "yes", "no", "exit", "quit",
        "apply", "close", "back", "start", "loading", "press any key",
    }
)
IGNORE_EXTRA_FILENAME: Final[str] = "ignore-extra.txt"

LENGTH_FIT_MIN: Final[int] = 2
LENGTH_FIT_MAX: Final[int] = 12
LENGTH_OVER_LIMIT: Final[int] = 12
EVENT_COUNT_BONUS_THRESHOLD: Final[int] = 3
HIT_COUNT_BONUS_THRESHOLD: Final[int] = 12
MAX_SCORED_HITS_PER_EVENT: Final[int] = 4
HIGH_CONFIDENCE: Final[float] = 0.85
LOW_CONFIDENCE: Final[float] = 0.6

_LETTER_AND_DIGIT: Final[re.Pattern[str]] = re.compile(r"^(?=.*[A-Za-z])(?=.*\d).+$")

SCORE_LENGTH_FIT: Final[int] = 12
SCORE_EVENT_COUNT: Final[int] = 15
SCORE_HIT_COUNT: Final[int] = 6
SCORE_HIGH_CONFIDENCE: Final[int] = 12
SCORE_TEMPLATE_HIT: Final[int] = 20
SCORE_MODEL_SHAPE: Final[int] = 8
SCORE_IGNORE_WORD: Final[int] = -60
SCORE_LOW_CONFIDENCE: Final[int] = -15
SCORE_LENGTH_OVER: Final[int] = -20


def load_ignore_words(extra_path: Path | None = None) -> frozenset[str]:
    """内置忽略词 + sidecar 追加清单（每行一个词，# 注释与空行忽略）。"""

    words = set(IGNORE_WORDS)
    if extra_path is not None and extra_path.is_file():
        for line in extra_path.read_text(encoding="utf-8").splitlines():
            entry = line.strip()
            if entry and not entry.startswith("#"):
                words.add(entry)
    return frozenset(words)


def is_ignored(word: str, ignore_words: frozenset[str]) -> bool:
    key = normalize(word)
    return word.strip().lower() in ignore_words or key in {normalize(item) for item in ignore_words}


def score_candidate(
    candidate: Mapping[str, object],
    ignore_words: frozenset[str] = IGNORE_WORDS,
) -> dict[str, object]:
    """为候选计算可解释评分；返回总分、理由列表与忽略标记。"""

    word = str(candidate.get("word") or "")
    event_count = int(candidate.get("eventCount") or 0)
    avg_conf = float(candidate.get("avgConf") or 0.0)
    templates = list(candidate.get("templates") or [])

    reasons: list[dict[str, object]] = []

    def add(key: str, delta: int, detail: str) -> None:
        reasons.append({"key": key, "delta": delta, "detail": detail})

    if LENGTH_FIT_MIN <= len(word) <= LENGTH_FIT_MAX:
        add("length_fit", SCORE_LENGTH_FIT, "长度适合名称或术语")
    if len(word) > LENGTH_OVER_LIMIT:
        add(
            "length_over",
            SCORE_LENGTH_OVER,
            f"长度超过 {LENGTH_OVER_LIMIT} 字，疑似整句字幕或 UI 文案而非术语",
        )
    if event_count >= EVENT_COUNT_BONUS_THRESHOLD:
        add("event_count", SCORE_EVENT_COUNT, f"独立显示事件 ≥ {EVENT_COUNT_BONUS_THRESHOLD} 次（共 {event_count} 次）")
    # 有效命中口径：每事件最多计 4 帧。事件已按时间窗聚合，单事件的高帧数
    # 只说明采样密度或常驻时长，不代表文本更常出现；只有多次独立显示才值得加分。
    events = list(candidate.get("events") or [])
    scored_hits = sum(
        min(int(event.get("hits") or 0), MAX_SCORED_HITS_PER_EVENT) for event in events
    )
    if scored_hits >= HIT_COUNT_BONUS_THRESHOLD:
        add(
            "hit_count",
            SCORE_HIT_COUNT,
            f"有效命中 ≥ {HIT_COUNT_BONUS_THRESHOLD} 次（原始 {int(candidate.get('hitCount') or 0)} 帧，每事件最多计 {MAX_SCORED_HITS_PER_EVENT}）",
        )
    if avg_conf >= HIGH_CONFIDENCE:
        add("high_confidence", SCORE_HIGH_CONFIDENCE, f"OCR 平均置信度 ≥ {HIGH_CONFIDENCE}（{avg_conf:.2f}）")
    if templates:
        names = "、".join(str(item.get("name")) for item in templates[:3])
        add("template_hit", SCORE_TEMPLATE_HIT, f"命中专名上下文模板（{names}）")
    if _LETTER_AND_DIGIT.match(word):
        add("model_shape", SCORE_MODEL_SHAPE, "字母与数字组合的型号词形")
    if avg_conf < LOW_CONFIDENCE:
        add("low_confidence", SCORE_LOW_CONFIDENCE, f"OCR 平均置信度偏低（{avg_conf:.2f}）")
    ignored = is_ignored(word, ignore_words)
    if ignored:
        add("ignore_word", SCORE_IGNORE_WORD, "命中常见 UI 忽略词清单")

    score = sum(int(reason["delta"]) for reason in reasons)  # type: ignore[arg-type]
    return {"score": score, "reasons": reasons, "ignored": ignored}


def apply_scoring(
    candidates: Sequence[Mapping[str, object]],
    *,
    min_score: int,
    ignore_words: frozenset[str] = IGNORE_WORDS,
) -> list[dict[str, object]]:
    """给每个候选附上评分、理由、推荐与导出预检标记。"""

    scored: list[dict[str, object]] = []
    for candidate in candidates:
        verdict = score_candidate(candidate, ignore_words)
        word = str(candidate.get("word") or "")
        # 推荐项必须可直接导出：命中热词硬限制（如非 ASCII > 15 字符、ASCII > 7 词）
        # 的候选不进入推荐，避免「勾选推荐项」勾进无法使用的词。
        recommendable = not verdict["ignored"] and hotword_issue(word) is None
        scored.append(
            {
                **candidate,
                "score": verdict["score"],
                "reasons": verdict["reasons"],
                "recommended": recommendable and int(verdict["score"]) >= min_score,
            }
        )
    scored.sort(key=lambda item: (-int(item["score"]), str(item["word"])))  # type: ignore[arg-type]
    return scored
