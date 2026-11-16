"""term_extract.score：可解释评分、忽略词与推荐线。"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools" / "term-extract"))

from term_extract.score import (  # noqa: E402
    apply_scoring,
    is_ignored,
    load_ignore_words,
    score_candidate,
)


def candidate(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "word": "星核",
        "typeGuess": "地点",
        "variants": [],
        "events": [
            {"startMs": i, "endMs": i + 1, "hits": 4, "avgConf": 0.9, "frames": [], "evidence": []}
            for i in range(0, 50_000, 10_000)
        ],
        "eventCount": 5,
        "hitCount": 40,
        "avgConf": 0.93,
        "contexts": ["前往星核"],
        "templates": [{"name": "goto", "type": "地点", "term": "星核", "source": "前往星核"}],
    }
    base.update(overrides)
    return base


class ScoringTests(unittest.TestCase):
    def test_reasons_explain_each_delta(self) -> None:
        verdict = score_candidate(candidate())
        keys = {reason["key"] for reason in verdict["reasons"]}
        self.assertIn("length_fit", keys)
        self.assertIn("event_count", keys)
        self.assertIn("hit_count", keys)
        self.assertIn("high_confidence", keys)
        self.assertIn("template_hit", keys)
        self.assertEqual(verdict["score"], 12 + 15 + 6 + 12 + 20)

    def test_ignore_word_penalty_and_flag(self) -> None:
        verdict = score_candidate(candidate(word="设置", avgConf=0.95, eventCount=9, templates=[], typeGuess=""))
        self.assertTrue(verdict["ignored"])
        self.assertLess(int(verdict["score"]), 0)
        self.assertTrue(is_ignored("保存", {"保存"}))

    def test_model_shape_bonus(self) -> None:
        verdict = score_candidate(candidate(word="LJ-84", templates=[], typeGuess="型号", eventCount=1, avgConf=0.8))
        keys = {reason["key"] for reason in verdict["reasons"]}
        self.assertIn("model_shape", keys)
        self.assertNotIn("event_count", keys)

    def test_low_confidence_penalty(self) -> None:
        verdict = score_candidate(candidate(avgConf=0.5, eventCount=9))
        keys = {reason["key"] for reason in verdict["reasons"]}
        self.assertIn("low_confidence", keys)

    def test_long_display_single_event_does_not_earn_hit_bonus(self) -> None:
        # 常驻 UI 停留 40 帧（1 个事件）不再刷满命中加分：每事件最多计 4。
        single_long_event = [{"startMs": 0, "endMs": 40_000, "hits": 40, "avgConf": 0.9, "frames": [], "evidence": []}]
        verdict = score_candidate(
            candidate(word="任务追踪", templates=[], typeGuess="", eventCount=1, hitCount=40, events=single_long_event)
        )
        keys = {reason["key"] for reason in verdict["reasons"]}
        self.assertNotIn("hit_count", keys)
        self.assertNotIn("event_count", keys)

    def test_long_sentence_gets_length_over_penalty(self) -> None:
        verdict = score_candidate(candidate(word="当时赶时间没来得及试玩游戏", avgConf=1.0))
        keys = {reason["key"] for reason in verdict["reasons"]}
        self.assertNotIn("length_fit", keys)
        self.assertIn("length_over", keys)
        # 长度惩罚 −20 抵消事件/命中/置信度/模板的加分后仍明显低于推荐线。
        self.assertEqual(verdict["score"], -20 + 15 + 6 + 12 + 20)

    def test_unexportable_word_never_recommended(self) -> None:
        scored = apply_scoring(
            [candidate(word="这个词条远远超过了热词允许的十五个字符上限", eventCount=9, avgConf=0.95)],
            min_score=-100,
        )
        self.assertFalse(scored[0]["recommended"])
        self.assertNotIn("export", scored[0])  # export 标记仍由 CLI 层附加

    def test_apply_scoring_marks_recommended_and_sorts(self) -> None:
        scored = apply_scoring(
            [candidate(word="保存", templates=[]), candidate()],
            min_score=60,
        )
        self.assertEqual(scored[0]["word"], "星核")
        self.assertTrue(scored[0]["recommended"])
        self.assertFalse(scored[1]["recommended"])

    def test_ignore_extra_file_extends_list(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as temp:
            extra = Path(temp) / "ignore-extra.txt"
            extra.write_text("# 注释\n回城\n\n传送\n", encoding="utf-8")
            words = load_ignore_words(extra)
            self.assertIn("回城", words)
            self.assertIn("传送", words)
            self.assertIn("继续", words)  # 内置仍在


if __name__ == "__main__":
    _ = unittest.main()
