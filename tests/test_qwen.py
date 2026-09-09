from __future__ import annotations

import io
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

from generate_subtitle_qwen_api import (
    build_interpolated_items,
    build_segments_from_api_sentences,
    configure_extra_strong_punct,
    extract_audio,
    get_duration_sec,
    main,
    parse_transcription_result,
    repair_nonpositive_duration_segments,
    split_coarse_segment,
    split_coarse_segments,
    split_words_to_segments,
    split_words_to_segments_western,
)
from maw.project import normalize_project


class QwenCliExitContractTests(unittest.TestCase):
    def test_missing_input_exits_nonzero(self) -> None:
        """缺失输入文件属于调用方错误，必须以非零退出码失败。"""
        with redirect_stderr(io.StringIO()), \
             mock.patch("sys.argv", ["generate_subtitle_qwen_api.py", "does-not-exist.mp3"]):
            with self.assertRaises(SystemExit) as raised:
                main()
        self.assertEqual(raised.exception.code, 1)

    def test_empty_transcription_exits_with_distinct_code(self) -> None:
        """未识别到任何内容（空结果）应以可区分的非零退出码失败，而非成功。"""
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as tmp:
            media = Path(tmp) / "silent.mp3"
            media.write_bytes(b"x")
            with redirect_stdout(io.StringIO()), \
                 redirect_stderr(io.StringIO()), \
                 mock.patch("sys.argv", ["generate_subtitle_qwen_api.py", str(media)]):
                with mock.patch("generate_subtitle_qwen_api.get_duration_sec", return_value=1.0):
                    with mock.patch("generate_subtitle_qwen_api.transcribe", return_value={}):
                        with self.assertRaises(SystemExit) as raised:
                            main()
        self.assertEqual(raised.exception.code, 2)


class QwenMediaExtractionTests(unittest.TestCase):
    def test_missing_ffmpeg_tools_report_the_full_package_hint(self) -> None:
        with mock.patch(
            "generate_subtitle_qwen_api.subprocess.run",
            side_effect=FileNotFoundError(2, "系统找不到指定的文件"),
        ):
            with self.assertRaisesRegex(RuntimeError, "找不到 FFmpeg，请下载完整版 MAW"):
                get_duration_sec("input.mp4")

    def test_video_extraction_can_limit_duration_in_the_first_ffmpeg_pass(self) -> None:
        with mock.patch("generate_subtitle_qwen_api.subprocess.run") as run:
            extract_audio("input.mp4", "output.wav", duration_limit=120, ffmpeg_path="ffmpeg")

        # FFmpeg 经统一解析器解析，可能是绝对路径；按可执行名断言。
        command = run.call_args.args[0]
        self.assertEqual(Path(command[0]).stem.lower(), "ffmpeg")
        # 多音轨支持：第一遍 ffmpeg 始终 -map 选中的音轨（默认第一条）。
        self.assertEqual(command[1:7], ["-i", "input.mp4", "-map", "0:a:0", "-t", "120"])
        self.assertEqual(command[-1], "output.wav")


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

    def test_repair_preserves_single_speaker_and_optional_items_shape(self) -> None:
        repaired = repair_nonpositive_duration_segments([
            {"start": 0, "end": 0, "text": "嗯", "speaker": "S01"},
            {"start": 0, "end": 1000, "text": "继续", "speaker": "S01"},
        ])

        self.assertEqual(repaired, [{
            "start": 0,
            "end": 1000,
            "text": "嗯继续",
            "speaker": "S01",
        }])

    def test_repair_drops_conflicting_speakers_and_invalid_items(self) -> None:
        repaired = repair_nonpositive_duration_segments([
            {
                "start": 0,
                "end": 0,
                "text": "嗯",
                "speaker": "S01",
                "items": [{"text": "嗯", "start": 0, "end": 0, "speaker": "S01"}],
            },
            {"start": 0, "end": 1000, "text": "继续", "speaker": "S02"},
        ])

        self.assertNotIn("speaker", repaired[0])
        self.assertNotIn("items", repaired[0])


class QwenCliOutputNamingTests(unittest.TestCase):
    """CLI 默认命名开关（--no-model-tag）、MAW_STAT 与 debug-raw 落盘分支。

    统一用 mock 打掉转写与媒体时长，避免依赖真实 .env / FFmpeg。
    """

    MODEL = "qwen3-asr-flash-filetrans"
    MEDIA_NAME = "20-走廊.mp3"

    def _run(self, extra_args, *, duration=1000.0):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            media = root / self.MEDIA_NAME
            media.write_bytes(b"media")
            result = {"text": "测试", "language": "zh", "items": []}
            args = [str(media), "--model", self.MODEL, *extra_args]
            values = [1000.0, 1123.0]

            def fake_perf():
                return values.pop(0) if values else 0.0

            stdout = io.StringIO()
            stderr = io.StringIO()
            with mock.patch("sys.argv", ["generate_subtitle_qwen_api.py", *args]), \
                 mock.patch("generate_subtitle_qwen_api.get_duration_sec", return_value=duration), \
                 mock.patch("generate_subtitle_qwen_api.transcribe", return_value=result), \
                 mock.patch("generate_subtitle_qwen_api.time.perf_counter", side_effect=fake_perf), \
                 redirect_stdout(stdout), redirect_stderr(stderr):
                main()
                names = sorted(path.name for path in root.glob("*.srt"))
            return names, stdout.getvalue(), stderr.getvalue()

    @staticmethod
    def _stat_line(stdout):
        for line in stdout.splitlines():
            if line.startswith("MAW_STAT rtf="):
                return line
        return None

    def test_default_name_has_no_speed_segment(self) -> None:
        import re as _re

        names, stdout, _ = self._run([])

        self.assertEqual(len(names), 1)
        self.assertIsNotNone(
            _re.fullmatch(r"\[\d{10}\]20-走廊\.qwen3-asr-api\.srt", names[0])
        )
        self.assertNotRegex(names[0], r"\.\d+x\.srt$")
        self.assertEqual(self._stat_line(stdout), "MAW_STAT rtf=0.123")

    def test_no_model_tag_omits_model_segment(self) -> None:
        import re as _re

        names, stdout, _ = self._run(["--no-model-tag"])

        self.assertEqual(len(names), 1)
        self.assertIsNotNone(_re.fullmatch(r"\[\d{10}\]20-走廊\.srt", names[0]))

    def test_explicit_output_keeps_exact_name_and_stat(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as tmp_dir:
            output = Path(tmp_dir) / "out.srt"
            media_dir = Path(tmp_dir) / "media"
            media_dir.mkdir()
            # 便于 _run 使用与输出不同目录，验证显式输出不注入任何段
            (media_dir / self.MEDIA_NAME).write_bytes(b"x")

            # 重新手动执行（_run 固定把输入放同 root）
            result = {"text": "测试", "language": "zh", "items": [], "_raw_response": {"ok": True}}
            stdout = io.StringIO()
            stderr = io.StringIO()
            values = [1000.0, 1123.0]

            def fake_perf():
                return values.pop(0) if values else 0.0

            with mock.patch(
                "sys.argv",
                ["generate_subtitle_qwen_api.py", str(media_dir / self.MEDIA_NAME), "--model", self.MODEL, "--debug-raw", "-o", str(output)],
            ), mock.patch("generate_subtitle_qwen_api.get_duration_sec", return_value=1000.0), \
                 mock.patch("generate_subtitle_qwen_api.transcribe", return_value=result), \
                 mock.patch("generate_subtitle_qwen_api.time.perf_counter", side_effect=fake_perf), \
                 redirect_stdout(stdout), redirect_stderr(stderr):
                main()

            self.assertTrue(output.exists())
            self.assertTrue(output.with_suffix(".asr-response.json").exists())
            self.assertFalse((Path(tmp_dir) / "media" / "_maw").exists())
            self.assertEqual(self._stat_line(stdout.getvalue()), "MAW_STAT rtf=0.123")

    def test_debug_raw_default_writes_into_maw_dir(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            media = root / self.MEDIA_NAME
            media.write_bytes(b"media")
            result = {"text": "测试", "language": "zh", "items": [], "_raw_response": {"utterances": []}}
            stdout = io.StringIO()
            stderr = io.StringIO()
            values = [1000.0, 1123.0]

            def fake_perf():
                return values.pop(0) if values else 0.0

            with mock.patch(
                "sys.argv",
                ["generate_subtitle_qwen_api.py", str(media), "--model", self.MODEL, "--debug-raw"],
            ), mock.patch("generate_subtitle_qwen_api.get_duration_sec", return_value=1000.0), \
                 mock.patch("generate_subtitle_qwen_api.transcribe", return_value=result), \
                 mock.patch("generate_subtitle_qwen_api.time.perf_counter", side_effect=fake_perf), \
                 mock.patch("maw.output_naming.subfolder_prefs", return_value=(False, False)), \
                 redirect_stdout(stdout), redirect_stderr(stderr):
                main()

            maw_dir = root / "_maw"
            raw_files = sorted(maw_dir.glob("*.asr-response.json")) if maw_dir.exists() else []
            self.assertEqual(len(raw_files), 1)
            self.assertIn("20-走廊.qwen3-asr-api.asr-response.json", raw_files[0].name)
            self.assertEqual(self._stat_line(stdout.getvalue()), "MAW_STAT rtf=0.123")


def _word(char: str, punctuation: str = "", start: int = 0, duration: int = 400) -> dict:
    """构造 filetrans 的词级条目（text + punctuation + 毫秒时间码）。"""
    return {
        "text": char,
        "punctuation": punctuation,
        "begin_time": start,
        "end_time": start + duration,
    }


class QwenInterpolatedItemsTests(unittest.TestCase):
    def test_splits_at_punctuation_and_interpolates_proportionally(self) -> None:
        items = build_interpolated_items("你好，世界。", 1000, 5000, max_piece_len=20)
        self.assertEqual([item["text"] for item in items], ["你好，", "世界。"])
        self.assertEqual(items[0]["start"], 1000)
        self.assertEqual(items[-1]["end"], 5000)
        # 3 字 : 3 字 → 时间中点对半。
        self.assertEqual(items[0]["end"], items[1]["start"])
        self.assertEqual(items[1]["start"], 3000)

    def test_hardcuts_punctless_text_longer_than_max_piece(self) -> None:
        items = build_interpolated_items("一二三四五", 0, 500, max_piece_len=2)
        self.assertEqual([item["text"] for item in items], ["一二", "三四", "五"])
        self.assertEqual(
            [item["start"] for item in items],
            [0, items[0]["end"], items[1]["end"]],
        )
        self.assertEqual(items[-1]["end"], 500)

    def test_empty_text_and_degenerate_range(self) -> None:
        self.assertEqual(build_interpolated_items("", 0, 100, max_piece_len=20), [])
        single = build_interpolated_items("文本", 800, 800, max_piece_len=20)
        self.assertEqual(len(single), 1)
        self.assertEqual(single[0]["start"], 800)
        self.assertEqual(single[0]["end"], 801)


class QwenCoarseSplitTests(unittest.TestCase):
    def test_short_segment_passes_through_untouched(self) -> None:
        segment = {"start": 0, "end": 1000, "text": "前进", "items": [{"text": "前进", "start": 0, "end": 1000}]}
        pieces = split_coarse_segment(segment, max_len=20, min_len=5, gap_split_ms=500, split_mode="continuous")
        self.assertEqual(len(pieces), 1)
        self.assertIs(pieces[0], segment)

    def test_itemless_overlong_segment_splits_at_punctuation(self) -> None:
        text = "这一段我感觉我的大脑被嗯嗯，基本圆满了，现在只差你的嘴了"
        segment = {"start": 1000, "end": 11000, "text": text}
        pieces = split_coarse_segment(segment, max_len=20, min_len=5, gap_split_ms=0, split_mode="continuous")
        self.assertGreater(len(pieces), 1)
        self.assertEqual("".join(piece["text"] for piece in pieces), text)
        for piece in pieces:
            self.assertLessEqual(len(piece["text"]), 20)
            self.assertNotIn("items", piece)
        self.assertEqual(pieces[0]["start"], 1000)
        self.assertEqual(pieces[-1]["end"], 11000)
        for prev, nxt in zip(pieces, pieces[1:]):
            self.assertLessEqual(prev["end"], nxt["start"])

    def test_segment_with_word_items_splits_precisely(self) -> None:
        items = [
            {"text": "这一段我感觉我的大脑被嗯嗯，", "start": 1000, "end": 6000},
            {"text": "基本圆满了，", "start": 6000, "end": 8000},
            {"text": "现在只差你的嘴了", "start": 8000, "end": 11000},
        ]
        segment = {"start": 1000, "end": 11000, "text": "".join(it["text"] for it in items), "items": items}
        pieces = split_coarse_segment(segment, max_len=20, min_len=5, gap_split_ms=0, split_mode="continuous")
        self.assertGreater(len(pieces), 1)
        self.assertEqual("".join(piece["text"] for piece in pieces), segment["text"])
        # 词级精度保留：拆出的段必须继续携带 items。
        for piece in pieces:
            self.assertIn("items", piece)

    def test_speaker_propagates_to_all_pieces(self) -> None:
        segment = {
            "start": 0,
            "end": 9000,
            "text": "这一段我感觉我的大脑被嗯嗯，基本圆满了，现在只差你的嘴了",
            "speaker": "SP1",
        }
        pieces = split_coarse_segment(segment, max_len=20, min_len=5, gap_split_ms=0, split_mode="continuous")
        self.assertGreater(len(pieces), 1)
        self.assertTrue(all(piece.get("speaker") == "SP1" for piece in pieces))

    def test_word_mode_counts_words_instead_of_characters(self) -> None:
        # 30 个西文字符 ≈ 5 个单词，按字符数早已超限，但按词数并不超长。
        segment = {"start": 0, "end": 3000, "text": "one two three four five"}
        pieces = split_coarse_segment(segment, max_len=5, min_len=1, gap_split_ms=0, max_words=13, split_mode="word")
        self.assertEqual(len(pieces), 1)


class QwenMixedDemotionTests(unittest.TestCase):
    """回归：部分句子缺词级时间码时，整份结果降级为句级，但超长段仍要拆分。"""

    LONG_WITH_PUNCT = "这一段我感觉我的大脑被嗯嗯，基本圆满了，现在只差你的嘴了"
    FALLBACK_TEXT = "我觉得我的大脑没有办法很好的消化刚才经历的这一切，它太混沌了"

    def _response(self) -> dict:
        words = []
        cursor = 0
        for char in self.LONG_WITH_PUNCT:
            punctuation = ""
            if char in "，。":
                punctuation = char
                words.append(_word("", punctuation=punctuation, start=cursor))
            else:
                words.append(_word(char, start=cursor))
            cursor += 400
        return {
            "language": "zh",
            "transcripts": [{
                "text": self.LONG_WITH_PUNCT + self.FALLBACK_TEXT,
                "sentences": [
                    {
                        "begin_time": 0,
                        "end_time": cursor,
                        "text": self.LONG_WITH_PUNCT,
                        "words": words,
                    },
                    {
                        "begin_time": cursor,
                        "end_time": cursor + 6000,
                        "text": self.FALLBACK_TEXT,
                        "words": [],
                    },
                ],
            }],
        }

    def test_parse_marks_segment_granularity_and_keeps_items_on_valid_sentence(self) -> None:
        parsed = parse_transcription_result(self._response())
        self.assertEqual(parsed["timestamp_granularity"], "segment")
        self.assertEqual(len(parsed["segments"]), 2)
        self.assertIn("items", parsed["segments"][0])
        self.assertNotIn("items", parsed["segments"][1])

    def test_coarse_split_still_enforces_max_len(self) -> None:
        parsed = parse_transcription_result(self._response())
        segments = split_coarse_segments(
            parsed["segments"],
            max_len=20,
            min_len=5,
            gap_split_ms=500,
            split_mode="continuous",
        )
        for segment in segments:
            self.assertLessEqual(len(segment["text"]), 20)
        self.assertGreater(len(segments), 2)
        # 词级句子拆出带 items 的段，句级句子拆出不带 items 的段。
        self.assertTrue(any("items" in segment for segment in segments))
        self.assertTrue(any("items" not in segment for segment in segments))


class QwenApiSentenceFallbackSplitTests(unittest.TestCase):
    def test_itemless_overlong_api_sentence_splits_within_boundary(self) -> None:
        long_text = "这一段我感觉我的大脑被嗯嗯，基本圆满了，现在只差你的嘴了"
        sentences = [
            {"start": 0, "end": 9000, "text": long_text},
            {"start": 9000, "end": 10000, "text": "前进"},
        ]
        segments = build_segments_from_api_sentences(
            sentences,
            max_len=20,
            min_len=5,
            gap_split_ms=500,
            split_mode="continuous",
        )
        # 超长句拆分且不越出句边界；短句保持整句一条。
        long_pieces = [segment for segment in segments if segment["text"] != "前进"]
        self.assertGreater(len(long_pieces), 1)
        self.assertEqual("".join(piece["text"] for piece in long_pieces), long_text)
        for piece in long_pieces:
            self.assertGreaterEqual(piece["start"], 0)
            self.assertLessEqual(piece["end"], 9000)
        self.assertIn("前进", [segment["text"] for segment in segments])


class QwenExtraStrongPunctTests(unittest.TestCase):
    def setUp(self) -> None:
        configure_extra_strong_punct("")

    def tearDown(self) -> None:
        configure_extra_strong_punct("")

    def test_extra_punct_breaks_cjk_groups(self) -> None:
        items = [
            {"text": "今", "start": 0, "end": 100},
            {"text": "天", "start": 100, "end": 200},
            {"text": "天", "start": 200, "end": 300},
            {"text": "气~", "start": 300, "end": 400},
            {"text": "真", "start": 400, "end": 500},
            {"text": "的", "start": 500, "end": 600},
            {"text": "不", "start": 600, "end": 700},
            {"text": "错", "start": 700, "end": 800},
            {"text": "呀", "start": 800, "end": 900},
        ]
        configure_extra_strong_punct("~")
        segments = split_words_to_segments(items, max_len=20, min_len=5, gap_split_ms=0)
        self.assertEqual([segment["text"] for segment in segments], ["今天天气~", "真的不错呀"])

    def test_extra_punct_breaks_western_groups(self) -> None:
        items = [
            {"text": "Hello", "start": 0, "end": 100},
            {"text": "~", "start": 100, "end": 150},
            {"text": "world", "start": 150, "end": 300},
            {"text": "great", "start": 300, "end": 400},
        ]
        configure_extra_strong_punct("~")
        segments = split_words_to_segments_western(items, max_words=13, min_words=1, gap_split_ms=0)
        self.assertEqual([segment["text"] for segment in segments], ["Hello~", "worldgreat"])

    def test_default_punct_set_does_not_break_on_tilde(self) -> None:
        items = [
            {"text": "你", "start": 0, "end": 100},
            {"text": "好~", "start": 100, "end": 200},
            {"text": "世", "start": 200, "end": 300},
            {"text": "界", "start": 300, "end": 400},
        ]
        segments = split_words_to_segments(items, max_len=20, min_len=5, gap_split_ms=0)
        self.assertEqual(len(segments), 1)


if __name__ == "__main__":
    unittest.main()
