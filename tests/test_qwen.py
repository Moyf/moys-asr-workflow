from __future__ import annotations

import io
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

from generate_subtitle_qwen_api import (
    extract_audio,
    get_duration_sec,
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
        self.assertEqual(command[1:5], ["-i", "input.mp4", "-t", "120"])
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


if __name__ == "__main__":
    unittest.main()
