from __future__ import annotations

import unittest

from generate_subtitle_qwen_api import (
    is_cjk_dominant,
    split_segments_auto,
    split_words_to_segments_western,
)
from maw.project import validate_project


def _words(pairs):
    return [{"text": t, "start": s, "end": e} for t, s, e in pairs]


class WesternSplitTests(unittest.TestCase):
    def test_western_splits_complete_sentences_like_real_data(self) -> None:
        # 真实语料（merge 后）：旧逻辑输出 "The editing process. Now" + ", don't get me wrong,"
        items = _words([
            ("The", 3870, 3930), (" editing", 4050, 4350), (" process.", 4470, 4950),
            (" Now,", 5130, 5370), (" don't", 5550, 5670), (" get", 5730, 5790),
            (" me", 5910, 5970), (" wrong,", 6030, 6270), (" I", 6390, 6450),
            (" really", 6510, 6810), (" enjoy", 6870, 7170), (" it.", 7230, 7530),
        ])

        segments = split_words_to_segments_western(items, gap_split_ms=1500)

        self.assertEqual(len(segments), 2)
        self.assertEqual(segments[0]["text"], "The editing process.")
        self.assertEqual(segments[1]["text"], " Now, don't get me wrong, I really enjoy it.")
        self.assertEqual(segments[0]["items"][-1]["text"], " process.")

    def test_western_merges_short_sentences(self) -> None:
        items = _words([
            (" I", 0, 100), (" said", 100, 200), (" so.", 200, 300),
            (" Yes.", 400, 500),
            (" And", 600, 700), (" then", 700, 800), (" we", 800, 900), (" went", 900, 1000), (" home.", 1000, 1100),
            (" Ok.", 1200, 1300),
        ])

        segments = split_words_to_segments_western(items, gap_split_ms=1500)

        # " Yes."（1 词）并入前句；末尾 " Ok."（1 词）并入前句
        self.assertEqual([s["text"] for s in segments],
                         [" I said so. Yes.", " And then we went home. Ok."])

    def test_western_overflow_prefers_weak_punct_cut(self) -> None:
        words = [f" w{i}" for i in range(16)]
        words[7] = " w7,"
        items = _words([(w, i * 100, i * 100 + 90) for i, w in enumerate(words)])

        segments = split_words_to_segments_western(items, max_words=13, gap_split_ms=99999)

        self.assertEqual(len(segments[0]["items"]), 8)  # 在第 8 词的逗号处断
        self.assertTrue(segments[0]["text"].rstrip().endswith(","))

    def test_western_overflow_hard_cut_without_weak_punct(self) -> None:
        items = _words([(f" w{i}", i * 100, i * 100 + 90) for i in range(15)])

        segments = split_words_to_segments_western(items, max_words=13, gap_split_ms=99999)

        self.assertEqual(len(segments[0]["items"]), 13)
        self.assertEqual(len(segments[1]["items"]), 2)

    def test_western_sentence_end_tolerates_trailing_quote(self) -> None:
        items = _words([
            (" He", 0, 100), (" said", 100, 200), (' "stop."', 200, 300),
            (" Next", 400, 500), (" one", 500, 600), (" comes.", 600, 700),
        ])

        segments = split_words_to_segments_western(items, gap_split_ms=1500)

        self.assertEqual(segments[0]["text"], ' He said "stop."')
        self.assertEqual(segments[1]["text"], " Next one comes.")


class CjkDominantTests(unittest.TestCase):
    def test_cjk_dominant_detection(self) -> None:
        self.assertTrue(is_cjk_dominant(_words([("今", 0, 1), ("天", 1, 2)])))
        self.assertFalse(is_cjk_dominant(_words([(" hello", 0, 1), (" world", 1, 2)])))
        self.assertTrue(is_cjk_dominant(_words([
            ("今", 0, 1), ("天", 1, 2), ("是", 2, 3), (" Monday", 3, 4),
        ])))


class AutoTrackTests(unittest.TestCase):
    def test_auto_picks_western_for_english_group(self) -> None:
        items = _words([
            ("The", 0, 60), (" editing", 60, 180), (" process.", 180, 300),
            (" Now,", 400, 500), (" it", 500, 600), (" works.", 600, 700),
        ])

        segments = split_segments_auto(items, max_len=21, min_len=5, gap_split_ms=1500)

        self.assertEqual(segments[0]["text"], "The editing process.")
        self.assertEqual(segments[1]["text"], " Now, it works.")

    def test_auto_picks_cjk_for_chinese_group(self) -> None:
        items = _words([
            ("今", 0, 300), ("天", 300, 600), ("天", 600, 900), ("气", 900, 1200),
            ("很", 1200, 1500), ("好", 1500, 1800), ("。", 1800, 1900),
            ("明", 2400, 2700), ("天", 2700, 3000), ("我", 3000, 3300), ("们", 3300, 3600),
            ("再", 3600, 3900), ("见", 3900, 4200), ("。", 4200, 4300),
        ])

        segments = split_segments_auto(items, max_len=21, min_len=5, gap_split_ms=1500)

        texts = [s["text"] for s in segments]
        self.assertEqual(texts, ["今天天气很好。", "明天我们再见。"])

    def test_auto_classifies_per_silence_group_for_mixed_content(self) -> None:
        # 中文静音组 + 英文静音组：各自走自己的切句逻辑
        items = _words([
            ("今", 0, 300), ("天", 300, 600), ("。", 600, 700),
            (" hello", 2700, 3000), (" world.", 3000, 3400), (" OK.", 3500, 3800),
        ])

        segments = split_segments_auto(items, max_len=21, min_len=5, gap_split_ms=1500)

        self.assertEqual(len(segments), 2)
        self.assertEqual(segments[0]["text"], "今天。")
        self.assertEqual(segments[1]["text"], " hello world. OK.")

    def test_auto_output_passes_project_validation(self) -> None:
        items = _words([
            ("The", 0, 60), (" editing", 60, 180), (" process.", 180, 300),
            (" It", 400, 500), (" really", 500, 650), (" works.", 650, 800),
        ])
        segments = split_segments_auto(items, max_len=21, min_len=5, gap_split_ms=1500)

        result = validate_project({"segments": segments})
        self.assertTrue(result.ok, msg=str([e.to_json() for e in result.errors]))


if __name__ == "__main__":
    unittest.main()
