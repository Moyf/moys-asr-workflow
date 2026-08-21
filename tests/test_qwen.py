from __future__ import annotations

import io
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

from generate_subtitle_qwen_api import (
    extract_audio,
    main,
    repair_nonpositive_duration_segments,
    split_words_to_segments,
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
    def test_video_extraction_can_limit_duration_in_the_first_ffmpeg_pass(self) -> None:
        with mock.patch("generate_subtitle_qwen_api.subprocess.run") as run:
            extract_audio("input.mp4", "output.wav", duration_limit=120)

        command = run.call_args.args[0]
        self.assertEqual(command[:4], ["ffmpeg", "-i", "input.mp4", "-t"])
        self.assertEqual(command[4], "120")
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


if __name__ == "__main__":
    unittest.main()
