"""Exercise source and frozen-dispatch ASR routes without network or models."""

from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PROVIDERS = ("qwen", "soniox", "doubao", "bcut", "tencent", "openai", "local")


class AsrEntrypointTests(unittest.TestCase):
    def assert_help(self, command: list[str]) -> None:
        result = subprocess.run(
            [sys.executable, *command, "--help"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=30,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr[-2000:])
        self.assertIn("usage:", result.stdout.lower())
        self.assertIn("--audio-track", result.stdout)

    def test_source_modules_accept_provider_arguments(self) -> None:
        for provider in PROVIDERS:
            with self.subTest(provider=provider):
                self.assert_help(["-m", f"maw.asr.{provider}"])

    def test_internal_transcription_handlers_accept_provider_arguments(self) -> None:
        for provider in PROVIDERS:
            with self.subTest(provider=provider):
                handler = "_run_internal_transcribe" + ("" if provider == "qwen" else f"_{provider}")
                # The GUI parser owns --help; exercise its transcription handler
                # directly in a fresh interpreter, as the frozen branch does.
                driver = (
                    "import sys; import maw_gui; "
                    f"raise SystemExit(maw_gui.{handler}(sys.argv[1:]))"
                )
                self.assert_help(["-c", driver])


if __name__ == "__main__":
    unittest.main()
