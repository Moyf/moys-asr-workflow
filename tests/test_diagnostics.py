from __future__ import annotations

import io
import tempfile
import unittest
from datetime import datetime, timezone, timedelta
from pathlib import Path
from unittest import mock

from maw.diagnostics import BUNDLED_APP_VERSION, app_version, error_context, context_label
from maw.local_log import LocalLogSink
import maw_gui


class ErrorContextTests(unittest.TestCase):
    def test_version_uses_release_metadata_and_tolerates_missing_or_invalid_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.assertEqual(app_version(root), BUNDLED_APP_VERSION)
            target = root / "pyproject.toml"
            target.write_text('[project]\nversion = "9.2.0-beta.3"', encoding="utf-8")
            self.assertEqual(app_version(root), "9.2.0-beta.3")
            target.write_bytes(b"\xff")
            self.assertEqual(app_version(root), BUNDLED_APP_VERSION)

    def test_context_survives_later_boundaries_and_midnight(self):
        original = {"version": "1.2.3", "occurredAt": "2026-10-03T23:59:59+08:00"}
        later = datetime(2026, 10, 4, tzinfo=timezone(timedelta(hours=8)))
        self.assertEqual(error_context(original, now=later), original)
        with tempfile.TemporaryDirectory() as directory:
            sink = LocalLogSink(directory=Path(directory), now=lambda: later)
            sink.append({"type": "error", "code": "failed", "detail": "TOKEN=test-secret", "errorContext": original})
            content = (Path(directory) / "maw-2026-10-04.log").read_text(encoding="utf-8")
            self.assertIn("00:00:00.000 [error:failed]", content)
            self.assertNotIn("MAW v", content)
            self.assertNotIn("test-secret", content)

    def test_startup_log_and_message_share_context(self):
        context = {"version": "1.2.3", "occurredAt": "2026-10-03T23:59:59+08:00"}
        error = RuntimeError("TOKEN=test-secret")
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "startup.log"
            with mock.patch.object(maw_gui, "_startup_error_log_path", return_value=target):
                self.assertEqual(maw_gui._write_startup_error_log(error, context=context), target)
            content = target.read_text(encoding="utf-8")
            self.assertIn(context_label(context), content)
            self.assertNotIn("test-secret", content)
            self.assertIn("版本：1.2.3\n发生时间：2026-10-03 23:59:59+08:00", maw_gui._startup_error_message(error, target, context=context))

    def test_broken_stderr_does_not_replace_original_transcription_exception(self):
        error = UnicodeEncodeError("gbk", "아", 0, 1, "illegal multibyte sequence")
        with mock.patch.object(maw_gui, "main", side_effect=error), mock.patch("builtins.print", side_effect=OSError):
            with self.assertRaises(UnicodeEncodeError) as raised:
                maw_gui.run_entrypoint(["--transcribe"])
        self.assertIs(raised.exception, error)

    def test_child_context_can_be_written_to_strict_gbk_stream(self):
        stream = io.TextIOWrapper(io.BytesIO(), encoding="gbk", errors="strict")
        error = RuntimeError("original failure")
        with mock.patch.object(maw_gui, "main", side_effect=error), mock.patch.object(maw_gui.sys, "stderr", stream):
            with self.assertRaises(RuntimeError):
                maw_gui.run_entrypoint(["--transcribe"])
        stream.flush()
        self.assertIn(b"MAW v", stream.buffer.getvalue())

    def test_emit_sends_exact_context_written_to_log(self):
        from maw.gui_web import LauncherApi, _error_result

        api = object.__new__(LauncherApi)
        api._log_sink = mock.Mock()
        api.pump = mock.Mock()
        event = {"type": "error", "code": "transcription_failed", "detail": "failure"}
        api._emit(event)
        logged = api._log_sink.append.call_args.args[0]
        self.assertEqual(api.pump.enqueue.call_args.args[0], logged)
        self.assertNotIn("errorContext", event)
        self.assertEqual(_error_result("", "failed", context=logged["errorContext"])["errorContext"], logged["errorContext"])

    def test_invalid_timestamp_falls_back_to_aware_time(self):
        for value in ("invalid", "2026-10-04", None):
            context = error_context({"occurredAt": value})
            self.assertIsNotNone(datetime.fromisoformat(context["occurredAt"]).utcoffset())

    def test_startup_diagnostic_failure_does_not_replace_original_error(self):
        error = RuntimeError("original startup failure")
        with mock.patch.object(maw_gui, "main", side_effect=error), mock.patch.object(maw_gui.sys, "platform", "win32"), mock.patch.object(maw_gui, "_startup_error_log_path", side_effect=OSError("unavailable")), mock.patch.object(maw_gui, "_show_unknown_startup_hint"):
            with self.assertRaises(RuntimeError) as raised:
                maw_gui.run_entrypoint([])
        self.assertIs(raised.exception, error)

    def test_explicit_timezone_is_preserved(self):
        now = datetime(2026, 10, 4, 0, 1, tzinfo=timezone(timedelta(hours=-7)))
        self.assertEqual(error_context(now=now)["occurredAt"], "2026-10-04T00:01:00-07:00")
