"""LocalLogSink 单元测试：行格式、按天滚动、脱敏、失败静默、保留策略。"""

from __future__ import annotations

import os
import sys
import tempfile
import time
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

from maw.local_log import LocalLogSink, _log_path_for, default_log_directory, format_log_line


def _now(year: int = 2026, month: int = 8, day: int = 29, hour: int = 14, minute: int = 32, second: int = 1) -> datetime:
    return datetime(year, month, day, hour, minute, second, 123456)


class LogLineFormattingTests(unittest.TestCase):
    def test_log_event_renders_timestamp_and_message(self) -> None:
        line = format_log_line({"type": "log", "message": "转写开始"}, now=_now())
        self.assertEqual(line, "14:32:01.123 [log] 转写开始")

    def test_error_event_renders_code_and_detail(self) -> None:
        line = format_log_line({"type": "error", "code": "transcription_failed", "detail": "出错了"}, now=_now())
        self.assertEqual(line, "14:32:01.123 [error:transcription_failed] 出错了")

    def test_error_event_without_code_uses_placeholder(self) -> None:
        line = format_log_line({"type": "error", "detail": "boom"}, now=_now())
        self.assertEqual(line, "14:32:01.123 [error:?] boom")

    def test_postprocess_stream_is_skipped(self) -> None:
        line = format_log_line({"type": "postprocess_stream", "kind": "text", "text": "token"}, now=_now())
        self.assertEqual(line, "")

    def test_done_event_expands_result_paths(self) -> None:
        line = format_log_line(
            {"type": "done", "result": {"srtPath": "D:/out.srt", "jsonPath": "D:/out.json"}}, now=_now()
        )
        self.assertIn("srtPath=D:/out.srt", line)
        self.assertIn("jsonPath=D:/out.json", line)

    def test_progress_event_uses_message(self) -> None:
        line = format_log_line({"type": "modelProgress", "message": "正在下载模型"}, now=_now())
        self.assertEqual(line, "14:32:01.123 [modelProgress] 正在下载模型")

    def test_secret_key_is_masked(self) -> None:
        line = format_log_line({"type": "log", "message": "auth=sk-abc12345defxyz"}, now=_now())
        self.assertIn("sk-***", line)
        self.assertNotIn("sk-abc12345defxyz", line)

    def test_sensitive_keys_are_dropped_from_structured_payload(self) -> None:
        line = format_log_line({"type": "batch_item", "id": "1", "apiKey": "sk-x"}, now=_now())
        self.assertNotIn("apiKey", line)


class LocalLogSinkTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.directory = Path(self._tmp.name)

    def test_appends_lines_to_daily_file(self) -> None:
        sink = LocalLogSink(directory=self.directory, now=lambda: _now())
        sink.append({"type": "log", "message": "hello"})
        sink.append({"type": "error", "code": "x", "detail": "boom"})

        path = _log_path_for(self.directory, _now())
        self.assertTrue(path.exists())
        lines = path.read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(lines), 2)
        self.assertIn("hello", lines[0])

    def test_skips_postprocess_stream_entirely(self) -> None:
        sink = LocalLogSink(directory=self.directory, now=lambda: _now())
        sink.append({"type": "postprocess_stream", "kind": "text", "text": "tok"})
        sink.append({"type": "log", "message": "after"})

        path = _log_path_for(self.directory, _now())
        lines = path.read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(lines), 1)
        self.assertIn("after", lines[0])
        self.assertNotIn("tok", lines[0])

    def test_rolls_over_to_new_file_next_day(self) -> None:
        current = {"time": _now(day=29, hour=23, minute=59, second=59)}
        sink = LocalLogSink(directory=self.directory, now=lambda: current["time"])
        sink.append({"type": "log", "message": "a"})
        current["time"] = _now(day=30, hour=0, minute=0, second=1)
        sink.append({"type": "log", "message": "b"})

        day1 = _log_path_for(self.directory, _now(day=29))
        day2 = _log_path_for(self.directory, _now(day=30))
        self.assertTrue(day1.exists())
        self.assertTrue(day2.exists())
        self.assertEqual(len(day1.read_text(encoding="utf-8").splitlines()), 1)
        self.assertEqual(len(day2.read_text(encoding="utf-8").splitlines()), 1)

    def test_write_failure_is_silent(self) -> None:
        # directory 指向普通文件会让 mkdir 抛 OSError，append 必须静默。
        blocker = self.directory / "blocker.txt"
        blocker.write_text("x", encoding="utf-8")
        sink = LocalLogSink(directory=blocker, now=lambda: _now())
        sink.append({"type": "log", "message": "hi"})  # 不应抛异常

    def test_close_stops_writing(self) -> None:
        sink = LocalLogSink(directory=self.directory, now=lambda: _now())
        sink.append({"type": "log", "message": "one"})
        sink.close()
        sink.append({"type": "log", "message": "two"})

        path = _log_path_for(self.directory, _now())
        self.assertEqual(len(path.read_text(encoding="utf-8").splitlines()), 1)

    def test_sweep_removes_old_files_on_first_write(self) -> None:
        old = _log_path_for(self.directory, _now(day=1))
        old.parent.mkdir(parents=True, exist_ok=True)
        old.write_text("old", encoding="utf-8")
        old_mtime = time.time() - 30 * 24 * 3600
        os.utime(old, (old_mtime, old_mtime))

        sink = LocalLogSink(directory=self.directory, now=lambda: _now())
        sink.append({"type": "log", "message": "new"})

        self.assertFalse(old.exists())

    def test_sweep_keeps_recent_files(self) -> None:
        recent = _log_path_for(self.directory, _now(day=22))
        recent.parent.mkdir(parents=True, exist_ok=True)
        recent.write_text("recent", encoding="utf-8")

        sink = LocalLogSink(directory=self.directory, now=lambda: _now())
        sink.append({"type": "log", "message": "new"})

        self.assertTrue(recent.exists())

    def test_sweep_runs_only_once_per_day(self) -> None:
        sink = LocalLogSink(directory=self.directory, now=lambda: _now())
        with patch("maw.local_log.Path.glob") as glob_mock:
            sink.append({"type": "log", "message": "one"})
            sink.append({"type": "log", "message": "two"})
        self.assertEqual(glob_mock.call_count, 1)


@unittest.skipUnless(sys.platform == "win32", "LOCALAPPDATA 变量仅为 Windows 语义")
class DefaultLogDirectoryTests(unittest.TestCase):
    def test_uses_localappdata_namespace(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict(os.environ, {"LOCALAPPDATA": tmp}, clear=False):
                result = default_log_directory()
        self.assertEqual(result, Path(tmp) / "Moy" / "MAW" / "logs")


if __name__ == "__main__":
    unittest.main()