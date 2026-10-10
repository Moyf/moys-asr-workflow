"""Exercise the runner with noisy, failing, missing and stuck real processes."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from scripts.run_check import LINE_LIMIT, SCAN_LIMIT, summarize


RUNNER = Path(__file__).resolve().parents[1] / "scripts" / "run_check.py"


class RunCheckTests(unittest.TestCase):
    def invoke(self, directory, code=None, *, timeout=10, command=None):
        command = command or [sys.executable, "-c", code]
        result = subprocess.run(
            [sys.executable, str(RUNNER), "--log-dir", directory,
             "--timeout", str(timeout), "--", *command],
            capture_output=True, text=True, encoding="utf-8", timeout=30,
        )
        records = list(Path(directory).glob("*/result.json"))
        self.assertEqual(len(records), 1)
        record = json.loads(records[0].read_text(encoding="utf-8"))
        self.assertLess(len(result.stdout), 9000)
        return result, record

    def test_huge_single_line_failure_keeps_exit_code_and_full_log(self):
        with tempfile.TemporaryDirectory() as directory:
            result, record = self.invoke(directory,
                "import sys; print('FAIL: test_big'); print('AssertionError: ' + 'x'*2000000); sys.exit(7)")
            self.assertEqual(result.returncode, 7)
            self.assertEqual(record["status"], "completed")
            self.assertIn("FAIL: test_big", result.stdout)
            self.assertIn("AssertionError", result.stdout)
            self.assertGreater(Path(record["log"]).stat().st_size, 2000000)

    def test_success_with_warning_is_not_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            result, record = self.invoke(directory, "print('Warning: expected error fixture'); print('OK ℹ 中文 😀')")
            self.assertEqual(result.returncode, 0)
            self.assertEqual(record["exit_code"], 0)
            self.assertIn("OK ℹ 中文 😀", result.stdout)

    def test_giant_final_line_keeps_terminal_error_suffix(self):
        with tempfile.TemporaryDirectory() as directory:
            for suffix in ("\n", ""):
                path = Path(directory) / "single-line.log"
                path.write_text("字" * 20000 + " ERROR: terminal failure" + suffix, encoding="utf-8")
                result = summarize(path)
                self.assertEqual(len(result["tail"]), 1)
                self.assertIn("ERROR: terminal failure", result["tail"][0])
                self.assertLessEqual(len(result["tail"][0]), LINE_LIMIT)

    def test_tail_retains_following_short_lines_after_partial_fragment(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "multiple-lines.log"
            path.write_text("x" * 20000 + " ERROR: first\nFAILED final\n", encoding="utf-8")
            result = summarize(path)
            self.assertIn("ERROR: first", result["tail"][0])
            self.assertEqual(result["tail"][-1], "FAILED final")

    def test_missing_command_is_distinct_from_test_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            result, record = self.invoke(directory, command=[str(Path(directory) / "absent-command")])
            self.assertEqual(result.returncode, 127)
            self.assertEqual(record["status"], "launch-error")

    def test_timeout_returns_124_and_stops_child_tree(self):
        with tempfile.TemporaryDirectory() as directory:
            child_pid_path = Path(directory) / "child.pid"
            code = (
                "import pathlib, subprocess, sys, time; "
                "p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)']); "
                f"pathlib.Path({str(child_pid_path)!r}).write_text(str(p.pid)); "
                "print('child started', flush=True); time.sleep(60)"
            )
            result, record = self.invoke(directory, code, timeout=2)
            self.assertEqual(result.returncode, 124)
            self.assertEqual(record["status"], "timeout")
            self.assertIsNone(record["cleanup_error"])
            self.assertTrue(child_pid_path.exists())
            pid = int(child_pid_path.read_text())
            if os.name == "nt":
                listing = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
                                         capture_output=True, timeout=10)
                self.assertNotIn(f'"{pid}"'.encode(), listing.stdout)
            else:
                # A killed orphan can briefly remain as a zombie until init reaps it.
                state = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)],
                                       capture_output=True, text=True, timeout=10).stdout.strip()
                self.assertTrue(not state or state.startswith("Z"), state)

    def test_large_log_scan_is_explicit_and_tail_retains_final_result(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "large.log"
            with path.open("wb") as log:
                log.write(b"FAIL: first\n")
                log.seek(SCAN_LIMIT + 20)
                log.write(b"\nFAILED (failures=1)\n")
            result = summarize(path)
            self.assertTrue(result["scan_limited"])
            self.assertIn("FAIL: first", result["diagnostics"])
            self.assertIn("FAILED (failures=1)", result["tail"])

    def test_many_failures_and_ansi_output_are_bounded(self):
        with tempfile.TemporaryDirectory() as directory:
            result, record = self.invoke(directory,
                "for i in range(1000): print('\\x1b[31mFAIL: test_' + str(i) + '\\x1b[0m')")
            self.assertNotIn("\x1b", result.stdout)
            self.assertEqual(len(record["diagnostics"]), 20)
            self.assertIn("FAIL: test_999", result.stdout)


if __name__ == "__main__":
    unittest.main()
