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

from maw.local_log import (
    LocalLogSink,
    TeeWriter,
    _log_path_for,
    default_log_directory,
    format_log_line,
    install_stdio_tee,
)


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

    def test_unencodable_text_is_replaced_without_affecting_caller(self) -> None:
        sink = LocalLogSink(directory=self.directory, now=lambda: _now())
        sink.write_text("bad" + chr(0xDCFF))

        path = _log_path_for(self.directory, _now())
        self.assertIn("bad", path.read_text(encoding="utf-8"))

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


class _RecordingStream:
    def __init__(self) -> None:
        self.chunks: list[str] = []
        self.flushes = 0

    @property
    def encoding(self) -> str:
        return "utf-8"

    def write(self, text: str) -> int:
        self.chunks.append(text)
        return len(text)

    def flush(self) -> None:
        self.flushes += 1

    def isatty(self) -> bool:
        return False

    def fileno(self) -> int:
        return 1


class WriteTextTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.sink = LocalLogSink(directory=Path(self._tmp.name), now=lambda: _now())

    def test_write_text_renders_label_and_message(self) -> None:
        self.sink.write_text("hello", label="stdout")
        lines = _log_path_for(Path(self._tmp.name), _now()).read_text(encoding="utf-8").splitlines()
        self.assertEqual(lines, ["14:32:01.123 [stdout] hello"])

    def test_write_text_masks_secret_keys(self) -> None:
        self.sink.write_text("auth=sk-abc12345defxyz", label="stderr")
        lines = _log_path_for(Path(self._tmp.name), _now()).read_text(encoding="utf-8").splitlines()
        self.assertIn("sk-***", lines[0])
        self.assertNotIn("sk-abc12345defxyz", lines[0])


class TeeWriterTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.sink = LocalLogSink(directory=Path(self._tmp.name), now=lambda: _now())
        self.stream = _RecordingStream()
        self.writer = TeeWriter(self.sink, self.stream, label="stdout")

    def _logged_lines(self) -> list[str]:
        path = _log_path_for(Path(self._tmp.name), _now())
        return path.read_text(encoding="utf-8").splitlines() if path.exists() else []

    def test_full_line_goes_to_sink_and_original_stream(self) -> None:
        self.writer.write("hello\n")
        lines = self._logged_lines()
        self.assertEqual(lines, ["14:32:01.123 [stdout] hello"])
        self.assertEqual(self.stream.chunks, ["hello\n"])

    def test_split_writes_accumulate_until_newline(self) -> None:
        self.writer.write("hel")
        self.writer.write("lo\n")
        lines = self._logged_lines()
        self.assertEqual(lines, ["14:32:01.123 [stdout] hello"])
        self.assertEqual("".join(self.stream.chunks), "hello\n")

    def test_flush_writes_trailing_text_without_newline(self) -> None:
        self.writer.write("tail")
        self.assertEqual(self._logged_lines(), [])
        self.writer.flush()
        self.assertEqual(self._logged_lines(), ["14:32:01.123 [stdout] tail"])
        self.assertEqual(self.stream.flushes, 1)

    def test_no_original_stream_does_not_crash(self) -> None:
        writer = TeeWriter(self.sink, None, label="stderr")
        writer.write("panic\n")
        self.assertEqual(self._logged_lines(), ["14:32:01.123 [stderr] panic"])

    def test_multi_line_single_write(self) -> None:
        self.writer.write("a\nb\n")
        self.assertEqual(self._logged_lines(), ["14:32:01.123 [stdout] a", "14:32:01.123 [stdout] b"])


class InstallStdioTeeTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self._original_stdout = sys.stdout
        self._original_stderr = sys.stderr
        self.addCleanup(self._restore_streams)
        self.sink = LocalLogSink(directory=Path(self._tmp.name), now=lambda: _now())

    def _restore_streams(self) -> None:
        sys.stdout = self._original_stdout
        sys.stderr = self._original_stderr

    def test_routes_print_output_to_sink(self) -> None:
        install_stdio_tee(self.sink)
        print("hello tee", flush=True)
        path = _log_path_for(Path(self._tmp.name), _now())
        lines = path.read_text(encoding="utf-8").splitlines()
        self.assertTrue(any("hello tee" in line for line in lines))

    def test_install_is_idempotent(self) -> None:
        install_stdio_tee(self.sink)
        first_stdout = sys.stdout
        install_stdio_tee(self.sink)
        self.assertIs(sys.stdout, first_stdout)


class DefaultLogDirectoryOverrideTests(unittest.TestCase):
    def test_maw_app_data_root_overrides_base_directory(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            override_root = Path(tmp) / "app-data"
            with patch.dict(os.environ, {"MAW_APP_DATA_ROOT": str(override_root)}, clear=False):
                result = default_log_directory()
        # default_log_directory 会对覆盖路径 resolve，Windows 短路径（8.3）也会被展开。
        self.assertEqual(result, override_root.resolve(strict=False) / "logs")

    def test_blank_override_falls_back_to_platform_directory(self) -> None:
        with patch.dict(os.environ, {"MAW_APP_DATA_ROOT": "   "}, clear=False):
            result = default_log_directory()
        self.assertEqual(result.name, "logs")
        self.assertIn("MAW", result.parts)


if __name__ == "__main__":
    unittest.main()
