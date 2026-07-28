from __future__ import annotations

import unittest

from generate_subtitle_qwen_api import (
    repair_nonpositive_duration_segments,
    split_words_to_segments,
)
from maw.project import normalize_project


class QwenTimestampRepairTests(unittest.TestCase):
    def test_isolated_zero_duration_item_merges_into_next_segment(self) -> None:
        items = [
            {"text": "正常。", "start": 0, "end": 1000},
            {"text": "嗯！", "start": 1000, "end": 1000},
            {"text": "继续。", "start": 1000, "end": 2000},
        ]

        split = split_words_to_segments(items, max_len=20, min_len=1, gap_split_ms=1000)
        repaired = repair_nonpositive_duration_segments(split)

        self.assertEqual([(segment["start"], segment["end"]) for segment in repaired], [(0, 1000), (1000, 2000)])
        self.assertEqual(repaired[1]["text"], "嗯！继续。")
        normalize_project({"segments": repaired})

    def test_trailing_zero_duration_segment_merges_into_previous(self) -> None:
        segments = [
            {
                "start": 0,
                "end": 1000,
                "text": "前句",
                "items": [{"text": "前句", "start": 0, "end": 1000}],
            },
            {
                "start": 1200,
                "end": 1200,
                "text": "尾字",
                "items": [{"text": "尾字", "start": 1200, "end": 1200}],
            },
        ]

        repaired = repair_nonpositive_duration_segments(segments)

        self.assertEqual(len(repaired), 1)
        self.assertEqual((repaired[0]["start"], repaired[0]["end"]), (0, 1200))
        self.assertEqual(repaired[0]["text"], "前句尾字")
        normalize_project({"segments": repaired})

    def test_all_zero_duration_segments_keep_text_and_gain_minimum_duration(self) -> None:
        segments = [
            {"start": 500, "end": 500, "text": "啊", "items": [{"text": "啊", "start": 500, "end": 500}]},
            {"start": 500, "end": 500, "text": "。", "items": [{"text": "。", "start": 500, "end": 500}]},
        ]

        repaired = repair_nonpositive_duration_segments(segments)

        self.assertEqual(repaired[0]["text"], "啊。")
        self.assertEqual((repaired[0]["start"], repaired[0]["end"]), (500, 501))
        normalize_project({"segments": repaired})


if __name__ == "__main__":
    unittest.main()
