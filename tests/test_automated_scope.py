"""A file selection preserves manual ownership and exact platform exclusions."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from scripts import test_policy

ROOT = Path(__file__).resolve().parents[1]


class AutomatedScopeTests(unittest.TestCase):
    def test_manual_input_is_reported_outside_automated_scope(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "test_sample.py").write_text(
                "import unittest\nclass Case(unittest.TestCase):\n"
                "    def test_automated(self): pass\n"
                "    def test_real_mosp_keeps_only_real_take_boundaries(self): self.fail('requires private input')\n",
                encoding="utf-8", newline="\n")
            report = root / "report.json"
            command = [sys.executable, str(ROOT / "scripts/run_tests.py"), "--start-dir", str(root),
                       "--required", "--report", str(report)]
            before = subprocess.run(command, cwd=ROOT, capture_output=True, timeout=30)
            self.assertNotEqual(before.returncode, 0)
            actual = subprocess.run([*command, "--automated"], cwd=ROOT, capture_output=True, timeout=30)
            self.assertEqual(actual.returncode, 0, actual.stderr[-1000:])
            value = json.loads(report.read_text(encoding="utf-8"))
            self.assertEqual(value["run"], 1)
            self.assertEqual(len(value["selected_ids"]), 1)
            self.assertEqual(len(value["excluded"]), 1)
            self.assertTrue(value["excluded"][0]["id"].endswith("test_real_mosp_keeps_only_real_take_boundaries"))
            self.assertEqual(value["skips"], [])

    def test_missing_capability_is_still_a_required_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "test_sample.py").write_text(
                "import unittest\nclass Case(unittest.TestCase):\n"
                "    @unittest.skip('Missing real FFmpeg')\n    def test_media(self): pass\n",
                encoding="utf-8", newline="\n")
            result = subprocess.run([sys.executable, str(ROOT / "scripts/run_tests.py"), "--start-dir", str(root),
                                     "--required", "--automated"], cwd=ROOT, capture_output=True, timeout=30)
            self.assertNotEqual(result.returncode, 0)

    def test_posix_exclusion_is_exact_and_host_specific(self):
        identity = "tests.test_process_tree_posix.RealPosixGroupTests.test_exited_root_live_child_is_reclaimed"
        reason = "POSIX process groups require a POSIX host"
        with mock.patch.object(os, "name", "nt"):
            self.assertTrue(test_policy.allowed_platform_skip(identity, reason))
            self.assertFalse(test_policy.allowed_platform_skip(identity, "Missing FFmpeg"))
            self.assertFalse(test_policy.allowed_platform_skip(identity + "_new", reason))
        with mock.patch.object(os, "name", "posix"):
            self.assertFalse(test_policy.allowed_platform_skip(identity, reason))


if __name__ == "__main__":
    unittest.main()
