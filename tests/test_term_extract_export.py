"""term_extract.export：热词硬限制预检与导出行构造。"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools" / "term-extract"))

from term_extract.export import (  # noqa: E402
    build_hotwords,
    hotword_issue,
    weight_for_score,
)


class HotwordIssueTests(unittest.TestCase):
    def test_plain_chinese_word_passes(self) -> None:
        self.assertIsNone(hotword_issue("星核"))

    def test_non_ascii_over_15_chars_rejected(self) -> None:
        issue = hotword_issue("这是一个超过十五个字符的超长界面提示语")
        self.assertIsNotNone(issue)
        self.assertIn("15", str(issue))

    def test_ascii_word_count_rejected(self) -> None:
        issue = hotword_issue("one two three four five six seven eight")
        self.assertIsNotNone(issue)
        self.assertIn("7", str(issue))

    def test_model_id_passes(self) -> None:
        self.assertIsNone(hotword_issue("LJ-84"))


class BuildHotwordsTests(unittest.TestCase):
    def test_lines_follow_selection_order_and_dedupe(self) -> None:
        text, rejected = build_hotwords(
            [{"word": "星核", "score": 87}, {"word": "星核", "score": 87}, {"word": "真希", "score": 67}],
        )
        self.assertEqual(text, "星核\n真希\n")
        self.assertEqual(rejected, [])

    def test_weight_bands(self) -> None:
        text, _ = build_hotwords(
            [{"word": "星核", "score": 87}, {"word": "真希", "score": 72}, {"word": "杂项", "score": 55}],
            weight_by_score=True,
        )
        self.assertEqual(text, "星核: 5\n真希: 4\n杂项\n")

    def test_invalid_entries_reported_not_exported(self) -> None:
        text, rejected = build_hotwords([{"word": "这是一个超过十五个字符的超长界面提示语", "score": 90}])
        self.assertEqual(text, "")
        self.assertEqual(len(rejected), 1)
        self.assertEqual(rejected[0]["word"], "这是一个超过十五个字符的超长界面提示语")

    def test_quantity_limit_applies_after_valid_word_dedupe(self) -> None:
        selected = [{"word": f"term-{i}", "score": 80} for i in range(2002)]
        selected.insert(0, {"word": "这是一个超过十五个字符的超长界面提示语"})
        selected.insert(1, {"word": "term-0", "score": 80})
        text, rejected = build_hotwords(selected, weight_by_score=True)
        self.assertEqual(len(text.splitlines()), 2000)
        self.assertEqual(text.splitlines()[-1], "term-1999: 5")
        self.assertEqual(len(rejected), 3)
        self.assertIn("2000", rejected[-1]["reason"])

    def test_prototype_named_words_are_valid_distinct_entries(self) -> None:
        text, rejected = build_hotwords([{"word": w} for w in ("constructor", "toString", "__proto__")])
        self.assertEqual(text, "constructor\ntoString\n__proto__\n")
        self.assertEqual(rejected, [])

    def test_weight_for_score_bands(self) -> None:
        self.assertEqual(weight_for_score(90), 5)
        self.assertEqual(weight_for_score(80), 5)
        self.assertEqual(weight_for_score(75), 4)
        self.assertEqual(weight_for_score(70), 4)
        self.assertEqual(weight_for_score(65), 3)
        self.assertEqual(weight_for_score(60), 3)
        self.assertIsNone(weight_for_score(59))


if __name__ == "__main__":
    _ = unittest.main()
