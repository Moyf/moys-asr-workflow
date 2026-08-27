from __future__ import annotations

import os
import unittest
from unittest import mock

from maw import console


class ConsoleTests(unittest.TestCase):
    def test_configure_utf8_environment_sets_process_and_child_values(self) -> None:
        environment: dict[str, str] = {
            "PYTHONUTF8": "0",
            "PYTHONIOENCODING": "gbk",
        }

        console.configure_utf8_environment(environment)

        self.assertEqual(environment["PYTHONUTF8"], "1")
        self.assertEqual(environment["PYTHONIOENCODING"], "utf-8:replace")

    def test_configure_utf8_stdio_reconfigures_existing_streams(self) -> None:
        stdout = mock.Mock()
        stderr = mock.Mock()

        with mock.patch.dict(os.environ, {"PYTHONUTF8": "0", "PYTHONIOENCODING": "gbk"}, clear=True), \
                mock.patch.object(console.sys, "stdout", stdout), \
                mock.patch.object(console.sys, "stderr", stderr):
            console.configure_utf8_stdio()
            self.assertEqual(os.environ["PYTHONUTF8"], "1")
            self.assertEqual(os.environ["PYTHONIOENCODING"], "utf-8:replace")
        expected = {
            "encoding": "utf-8",
            "errors": "replace",
            "line_buffering": True,
            "write_through": True,
        }
        stdout.reconfigure.assert_called_once_with(**expected)
        stderr.reconfigure.assert_called_once_with(**expected)

    def test_configure_utf8_stdio_tolerates_streams_without_reconfigure(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=False), \
                mock.patch.object(console.sys, "stdout", None), \
                mock.patch.object(console.sys, "stderr", None):
            console.configure_utf8_stdio()


if __name__ == "__main__":
    unittest.main()
