from __future__ import annotations

import base64
import sys
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from maw import notify  # noqa: E402


class SystemNotificationTests(unittest.TestCase):
    def test_empty_payload_is_ignored_without_starting_a_process(self) -> None:
        with mock.patch.object(notify.subprocess, "Popen") as popen:
            self.assertFalse(notify.send_system_notification("", "   "))

        popen.assert_not_called()

    def test_macos_uses_osascript_and_escapes_quotes_and_backslashes(self) -> None:
        with mock.patch.object(notify.sys, "platform", "darwin"), mock.patch.object(notify.subprocess, "Popen") as popen:
            sent = notify.send_system_notification('标题 "A"', 'line \\ "B"')

        self.assertTrue(sent)
        command = popen.call_args.args[0]
        self.assertEqual(command[0], "osascript")
        self.assertEqual(command[1], "-e")
        self.assertIn('display notification "line \\\\ \\"B\\"" with title "标题 \\"A\\""', command[2])

    def test_windows_runs_hidden_encoded_powershell_with_escaped_text(self) -> None:
        powershell = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
        with mock.patch.object(notify.sys, "platform", "win32"), mock.patch.object(
            notify.shutil, "which", return_value=powershell
        ), mock.patch.object(notify.subprocess, "Popen") as popen:
            sent = notify.send_system_notification("done", "file 'x'.srt")

        self.assertTrue(sent)
        command = popen.call_args.args[0]
        self.assertEqual(command[0], powershell)
        self.assertIn("-EncodedCommand", command)
        script = base64.b64decode(command[command.index("-EncodedCommand") + 1]).decode("utf-16-le")
        self.assertIn("System.Windows.Forms.NotifyIcon", script)
        self.assertIn("$n.BalloonTipTitle = 'done'", script)
        self.assertIn("$n.BalloonTipText = 'file ''x''.srt'", script)
        self.assertEqual(popen.call_args.kwargs["creationflags"], notify._WINDOWS_CREATE_NO_WINDOW)

    def test_windows_without_powershell_reports_not_sent(self) -> None:
        with mock.patch.object(notify.sys, "platform", "win32"), mock.patch.object(
            notify.shutil, "which", return_value=None
        ), mock.patch.object(notify.subprocess, "Popen") as popen:
            self.assertFalse(notify.send_system_notification("t", "m"))

        popen.assert_not_called()

    def test_linux_uses_notify_send_when_available(self) -> None:
        with mock.patch.object(notify.sys, "platform", "linux"), mock.patch.object(
            notify.shutil, "which", return_value="/usr/bin/notify-send"
        ), mock.patch.object(notify.subprocess, "Popen") as popen:
            sent = notify.send_system_notification("完成", "已生成 a.srt")

        self.assertTrue(sent)
        command = popen.call_args.args[0]
        self.assertEqual(command, ["/usr/bin/notify-send", "--app-name=MAW", "完成", "已生成 a.srt"])

    def test_linux_without_notify_send_reports_not_sent(self) -> None:
        with mock.patch.object(notify.sys, "platform", "linux"), mock.patch.object(
            notify.shutil, "which", return_value=None
        ), mock.patch.object(notify.subprocess, "Popen") as popen:
            self.assertFalse(notify.send_system_notification("t", "m"))

        popen.assert_not_called()

    def test_process_start_failure_is_swallowed(self) -> None:
        with mock.patch.object(notify.sys, "platform", "linux"), mock.patch.object(
            notify.shutil, "which", return_value="/usr/bin/notify-send"
        ), mock.patch.object(notify.subprocess, "Popen", side_effect=OSError("boom")):
            self.assertFalse(notify.send_system_notification("t", "m"))

    def test_long_and_multiline_text_is_collapsed_and_truncated(self) -> None:
        message = "\n".join(["第一行"] * 200)
        normalized = notify._normalize(message, notify._MAX_MESSAGE_CHARS)

        self.assertNotIn("\n", normalized)
        self.assertLessEqual(len(normalized), notify._MAX_MESSAGE_CHARS)
        self.assertTrue(normalized.endswith("…"))


if __name__ == "__main__":
    _ = unittest.main()
