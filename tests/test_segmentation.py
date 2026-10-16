from __future__ import annotations

import io
import unittest
from contextlib import redirect_stdout
from unittest import mock

import generate_subtitle_qwen_api as qwen
from generate_subtitle_qwen_api import (
    _split_long_group,
    is_cjk_dominant,
    split_segments_auto,
    split_words_to_segments,
    split_words_to_segments_western,
)
from maw.project import validate_project


def _words(pairs):
    return [{"text": t, "start": s, "end": e} for t, s, e in pairs]


class CjkWordBoundaryTests(unittest.TestCase):
    @staticmethod
    def items(texts):
        return _words([(text, i * 100, i * 100 + 90) for i, text in enumerate(texts)])

    def test_weather_example_uses_word_boundary_with_character_items(self) -> None:
        items = self.items("今天天气真好啊")
        segments = split_words_to_segments(items, max_len=5, gap_split_ms=0)
        self.assertEqual([s["text"] for s in segments], ["今天天气", "真好啊"])
        self.assertEqual([i for s in segments for i in s["items"]], items)
        self.assertEqual([(s["start"], s["end"]) for s in segments], [(0, 390), (400, 690)])

    def test_weather_example_also_works_in_natural_qwen_audio_mode(self) -> None:
        segments = split_segments_auto(
            self.items("今天天气真好啊"), max_len=5, min_len=5,
            gap_split_ms=0, natural_cjk=True, split_mode="continuous",
        )
        self.assertEqual([s["text"] for s in segments], ["今天天气", "真好啊"])

    def test_uses_common_boundary_instead_of_rounding_up_inside_word(self) -> None:
        items = self.items(["今天", "天气真", "好啊"])
        # jieba 的 4 字边界落在第二个 item 内；凑到 item 末尾会切成 天气真|好。
        with mock.patch("jieba.cut", return_value=iter(["今天", "天气", "真好", "啊"])):
            groups = _split_long_group(items, 5, set())
        self.assertEqual(["".join(i["text"] for i in g) for g in groups], ["今天", "天气真好啊"])
        self.assertEqual([i for g in groups for i in g], items)

    def test_rounding_up_cannot_overflow_limit(self) -> None:
        items = self.items(["今天", "天气真好", "啊"])
        with mock.patch("jieba.cut", return_value=iter(["今天天气", "真好", "啊"])):
            groups = _split_long_group(items, 5, set())
        self.assertEqual(groups, [items[:1], items[1:]])
        self.assertTrue(all(sum(len(i["text"]) for i in g) <= 5 for g in groups))

    def test_no_common_boundary_falls_back_before_limit(self) -> None:
        items = self.items(["甲乙丙", "丁戊己", "庚辛壬"])
        with mock.patch("jieba.cut", return_value=iter(["甲乙丙丁戊己庚辛壬"])):
            groups = _split_long_group(items, 5, set())
        self.assertEqual(groups, [[i] for i in items])

    def test_oversized_item_is_kept_alone_with_metadata(self) -> None:
        items = self.items(["甲乙", "独立超长词项", "丙丁"])
        items[1]["speaker"] = "speaker_1"
        items[1]["confidence"] = 0.9
        groups = _split_long_group(items, 5, set())
        self.assertEqual(groups, [[i] for i in items])
        self.assertIs(groups[1][0], items[1])

    def test_weak_punctuation_still_takes_precedence(self) -> None:
        items = self.items(["甲、", "乙", "丙", "丁", "戊", "己"])
        with mock.patch("jieba.cut", return_value=iter([i["text"] for i in items])):
            groups = _split_long_group(items, 5, {"、"})
        self.assertEqual(groups, [items[:1], items[1:]])

    def test_missing_jieba_still_preserves_limit_and_items(self) -> None:
        items = self.items(["甲乙丙", "丁戊己", "庚辛"])
        with mock.patch.dict("sys.modules", {"jieba": None}):
            groups = _split_long_group(items, 5, set())
        self.assertEqual(groups, [items[:1], items[1:]])

    def test_long_input_tokenizes_once_without_recursion(self) -> None:
        items = self.items(["好"] * 1200)
        with mock.patch("jieba.cut", return_value=iter(["好"] * len(items))) as cut:
            groups = _split_long_group(items, 1, set())
        self.assertEqual(len(groups), len(items))
        self.assertEqual([i for g in groups for i in g], items)
        cut.assert_called_once()

    def test_limit_is_inclusive_and_short_inputs_skip_tokenization(self) -> None:
        items = self.items("今天天气")
        with mock.patch("jieba.cut") as cut:
            self.assertEqual(_split_long_group(items, 4, set()), [items])
            self.assertEqual(_split_long_group([], 4, set()), [])
        cut.assert_not_called()


class CjkNaturalLimitTests(unittest.TestCase):
    def setUp(self) -> None:
        self.previous_punctuation = "".join(qwen._EXTRA_STRONG_PUNCT)
        qwen.configure_extra_strong_punct("，。？！；,.")

    def tearDown(self) -> None:
        qwen.configure_extra_strong_punct(self.previous_punctuation)

    @staticmethod
    def items(text, widths=(1,)):
        items, position, index = [], 0, 0
        while position < len(text):
            end = position + widths[index % len(widths)]
            piece = text[position:end]
            items.append({"text": piece, "start": position * 100, "end": (position + len(piece)) * 100,
                          "speaker": "S01", "confidence": 0.9})
            position += len(piece)
            index += 1
        return items

    def split(self, text, maximum=12, widths=(1,), natural=False):
        items = self.items(text, widths)
        with redirect_stdout(io.StringIO()):
            segments = split_segments_auto(
                items, max_len=maximum, min_len=1, gap_split_ms=600,
                natural_cjk=natural, split_mode="continuous",
            )
        self.assertEqual("".join(s["text"] for s in segments), text)
        self.assertEqual([i for s in segments for i in s["items"]], items)
        for segment in segments:
            self.assertEqual((segment["start"], segment["end"]),
                             (segment["items"][0]["start"], segment["items"][-1]["end"]))
        return [s["text"] for s in segments]

    def test_numeric_expressions_survive_both_cutting_stages_and_item_granularities(self) -> None:
        for expression in ("1.25倍", "50%", "16:9", "00:30", "1920×1080", "1999元",
                           "128GB", "20MB", "1.9.0", "1,000元", "3.5公斤", "2小时", "30秒钟", "60fps"):
            for widths in ((1,), (2, 3, 4)):
                for maximum in (10, 12, 18):
                    with self.subTest(expression=expression, widths=widths, maximum=maximum):
                        texts = self.split("请把参数设置成" + expression + "然后确认保存", maximum, widths)
                        self.assertTrue(any(expression in text for text in texts), texts)

    def test_natural_qwen_audio_mode_protects_numbers_and_units(self) -> None:
        for expression in ("1.25倍", "16:9", "1999元", "1920×1080"):
            with self.subTest(expression=expression):
                texts = self.split("这里设置成" + expression + "之后再继续检查", natural=True)
                self.assertTrue(any(expression in text for text in texts), texts)

    def test_punctuation_inside_coarse_item_cannot_cut_a_protected_expression(self) -> None:
        for pieces in (["完成。19", "99元继续"], ["完成。3.", "14元继续"],
                       ["完成。1999", "元继续"], ["完成。Open", "AI继续"]):
            for minimum in (1, 5):
                for natural in (False, True):
                    with self.subTest(pieces=pieces, minimum=minimum, natural=natural):
                        items = CjkWordBoundaryTests.items(pieces)
                        items[0]["speaker"] = "S01"
                        items[1]["confidence"] = 0.9
                        segments = split_words_to_segments(
                            items, max_len=18, min_len=minimum,
                            natural_target_len=13 if natural else None,
                        )
                        self.assertEqual([s["text"] for s in segments], ["".join(pieces)])
                        self.assertEqual([i for s in segments for i in s["items"]], items)
                        self.assertEqual((segments[0]["start"], segments[0]["end"]),
                                         (items[0]["start"], items[-1]["end"]))

    def test_legal_punctuation_cut_before_coarse_number_is_preserved(self) -> None:
        items = CjkWordBoundaryTests.items(["第一句。", "完成。19", "99元继续"])
        for natural in (False, True):
            with self.subTest(natural=natural):
                segments = split_words_to_segments(
                    items, max_len=18, min_len=1,
                    natural_target_len=13 if natural else None,
                )
                self.assertEqual([s["text"] for s in segments], ["第一句。", "完成。1999元继续"])
                self.assertEqual([i for s in segments for i in s["items"]], items)

    def test_coarse_protected_block_overflow_preserves_items_and_warns(self) -> None:
        items = CjkWordBoundaryTests.items(["完成。123456", "78901234567890元"])
        for natural in (False, True):
            with self.subTest(natural=natural), redirect_stdout(io.StringIO()) as output:
                segments = split_words_to_segments(
                    items, max_len=8, min_len=1,
                    natural_target_len=8 if natural else None,
                )
                self.assertEqual([s["text"] for s in segments], ["完成。12345678901234567890元"])
                self.assertEqual([i for s in segments for i in s["items"]], items)
                self.assertIn("超过单句上限 8 字", output.getvalue())

    def test_long_pause_still_splits_coarse_number_items(self) -> None:
        items = CjkWordBoundaryTests.items(["完成。19", "99元继续"])
        items[1].update(start=2000, end=2450)
        for natural in (False, True):
            with self.subTest(natural=natural):
                segments = split_words_to_segments(
                    items, max_len=18, min_len=1, gap_split_ms=1000,
                    natural_target_len=13 if natural else None,
                )
                self.assertEqual([s["text"] for s in segments], ["完成。19", "99元继续"])
                self.assertEqual([i for s in segments for i in s["items"]], items)

    def test_real_sentence_punctuation_still_splits_after_decimal(self) -> None:
        self.assertEqual(self.split("速度是1.25倍。下一步！", 30), ["速度是1.25倍。", "下一步！"])

    def test_explicit_punctuation_and_newlines_remain_boundaries(self) -> None:
        qwen.configure_extra_strong_punct("~")
        self.assertEqual(self.split("速度1.25倍~然后继续\n处理", 30), ["速度1.25倍~", "然后继续\n", "处理"])
        self.assertEqual(self.split("等待3\n分钟后继续", 30), ["等待3\n", "分钟后继续"])

    def test_weak_numeric_colon_is_not_a_split_point(self) -> None:
        qwen.configure_extra_strong_punct("")
        texts = self.split("我们把画面比例改成16:9然后继续处理", 12)
        self.assertTrue(any("16:9" in text for text in texts), texts)
        self.assertTrue(all(len(text) <= 12 for text in texts), texts)

    def test_oversized_number_is_preserved_with_explicit_warning(self) -> None:
        items = self.items("编号12345678901234567890元结束")
        output = io.StringIO()
        with redirect_stdout(output):
            segments = split_words_to_segments(items, 5, min_len=1, gap_split_ms=0)
        self.assertTrue(any(s["text"] == "12345678901234567890元" for s in segments))
        self.assertIn("超过单句上限 5 字", output.getvalue())
        self.assertEqual([i for s in segments for i in s["items"]], items)

    def test_pause_is_authoritative_even_inside_a_number(self) -> None:
        items = self.items("速度1.25倍继续")
        for item in items[4:]:
            item["start"] += 1000
            item["end"] += 1000
        texts = [s["text"] for s in split_words_to_segments(items, 20, min_len=1, gap_split_ms=600)]
        self.assertEqual(texts, ["速度1.", "25倍继续"])

    def test_avoid_hanging_negation_and_isolated_editing_tail(self) -> None:
        for text in (
            "我不是说这个方法完全没有用而是觉得它不太适合现在的情况",
            "如果你之前已经保存过工程那么这一次就可以直接继续编辑",
        ):
            with self.subTest(text=text):
                texts = self.split(text)
                joined = "｜".join(texts)
                self.assertNotIn("没有｜用", joined)
                self.assertNotIn("继续｜编辑", joined)
                self.assertGreaterEqual(len(texts[-1]), 4, joined)
                self.assertTrue(all(len(t) <= 12 for t in texts), joined)

    def test_rebalance_the_short_tail_instead_of_exceeding_limit(self) -> None:
        texts = self.split("我们把所有需要修改的地方检查完以后就可以开始导出了", 18)
        self.assertGreaterEqual(len(texts[-1]), 5, texts)
        self.assertFalse(any(t.endswith("就") for t in texts[:-1]), texts)
        self.assertTrue(all(len(t) <= 18 for t in texts), texts)

    def test_keep_a_sound_existing_cut_after_export_button(self) -> None:
        self.assertEqual(self.split("确认没有问题以后点击右上角的导出按钮选择你需要的字幕格式", 18),
                         ["确认没有问题以后点击右上角的导出按钮", "选择你需要的字幕格式"])

    def test_resolution_does_not_consume_the_following_frame_rate_label(self) -> None:
        texts = self.split("这段视频的分辨率是1920×1080帧率是每秒60帧", 10)
        self.assertTrue(any("1920×1080" in text for text in texts), texts)
        self.assertTrue(all(len(text) <= 10 for text in texts), texts)

    def test_soft_rebalance_keeps_verb_complements_and_introductions_together(self) -> None:
        cases = (
            ("把播放速度调到1.25倍音量降低到原来的50%听起来会舒服一点", "听｜起来"),
            ("我们从南京市长江大桥出发沿着江边一直走到了附近的咖啡馆", "走到｜了"),
            ("如果你之前已经保存过工程那么这一次就可以直接继续编辑", "｜那么这一次｜"),
            ("这段视频的分辨率是1920×1080帧率是每秒60帧导出时要保持一致", "帧｜率"),
        )
        for text, bad_cut in cases:
            with self.subTest(text=text):
                self.assertNotIn(bad_cut, "｜".join(self.split(text)))

    def test_tight_limit_falls_back_without_text_loss_or_extra_overflow(self) -> None:
        texts = self.split("我不是说这个方法完全没有用", 3)
        self.assertTrue(all(len(text) <= 3 for text in texts), texts)

    def test_default_enumeration_stays_together_when_a_legal_cut_exists(self) -> None:
        text = "这个、那个都不错我们可以再考虑一下"
        for natural in (False, True):
            with self.subTest(natural=natural):
                texts = self.split(text, 12, natural=natural)
                self.assertTrue(any("这个、那个" in part for part in texts), texts)

    def test_weak_candidates_follow_shared_configuration_without_hidden_symbols(self) -> None:
        qwen.configure_extra_strong_punct("")
        self.assertEqual(qwen._weak_punct_set(), set())
        for symbol in ("、", "：", ":", ";", "—", "–", "~"):
            with self.subTest(symbol=symbol):
                items = self.items("甲乙" + symbol + "丙丁戊己庚辛")
                qwen.configure_extra_strong_punct(symbol)
                self.assertEqual(qwen._weak_punct_set(), {symbol})
                self.assertEqual([s["text"] for s in split_words_to_segments(items, 20, min_len=1, gap_split_ms=0)],
                                 ["甲乙" + symbol, "丙丁戊己庚辛"])
        qwen.configure_extra_strong_punct("")
        self.assertEqual(self.split("甲乙、丙丁：戊己", 20), ["甲乙、丙丁：戊己"])

    def test_western_overflow_has_no_separate_weak_punctuation_list(self) -> None:
        for symbol in ("、", "：", ":", ";", "—", "–", "~", ","):
            items = CjkWordBoundaryTests.items([" one", " two" + symbol, " three", " four", " five"])
            with self.subTest(symbol=symbol):
                qwen.configure_extra_strong_punct("")
                self.assertEqual([len(g) for g in qwen._split_long_western(items, 4)], [4, 1])
                qwen.configure_extra_strong_punct(symbol)
                self.assertEqual([len(g) for g in qwen._split_long_western(items, 4)], [2, 3])

    def test_explicit_semicolon_default_splits_and_is_strippable(self) -> None:
        qwen.configure_extra_strong_punct(qwen._DEFAULT_EXTRA_STRONG_PUNCT)
        self.assertEqual(self.split("第一句话;第二句话", 20), ["第一句话;", "第二句话"])
        self.assertIn(";", qwen._DEFAULT_STRIP_TAIL_PUNCT)


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

    def test_western_does_not_merge_short_sentence_past_word_limit(self) -> None:
        items = _words([
            (" One", 0, 100),
            (" step.", 100, 200),
            (" Again.", 400, 500),
        ])

        segments = split_words_to_segments_western(
            items, max_words=2, min_words=2, gap_split_ms=800,
        )

        self.assertEqual([s["text"] for s in segments], [" One step.", " Again."])

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

    def test_auto_word_mode_uses_configured_word_limit(self) -> None:
        items = _words([(f" w{i}", i * 100, i * 100 + 90) for i in range(6)])

        segments = split_segments_auto(
            items,
            max_len=100,
            min_len=1,
            max_words=4,
            min_words=1,
            gap_split_ms=99999,
            split_mode="word",
        )

        self.assertEqual([len(segment["items"]) for segment in segments], [4, 2])

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

    def test_cjk_does_not_merge_short_sentences_past_character_limit(self) -> None:
        items = _words([
            ("哎", 0, 100), ("呀", 100, 200), ("！", 200, 300),
            ("这", 900, 1000), ("咋", 1000, 1100), ("办", 1100, 1200), ("？", 1200, 1300),
        ])

        segments = split_segments_auto(
            items,
            max_len=6,
            min_len=5,
            gap_split_ms=800,
            split_mode="continuous",
        )

        self.assertEqual([s["text"] for s in segments], ["哎呀！", "这咋办？"])

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
