"""Guard publication fault injection against alternate and Windows 8.3 path spellings."""

from __future__ import annotations

import ctypes
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from scripts import test_policy
from tests import test_term_extract_scan_publication as publication


class FixturePathTests(unittest.TestCase):
    def test_publication_output_fixture_is_resolved(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            spelling = Path(temp) / "alternate-spelling"
            spelling.mkdir()
            fixture_temp = SimpleNamespace(name=str(spelling / ".."), cleanup=lambda: None)
            case = publication.ScanPublicationTests()
            try:
                with mock.patch.object(publication.tempfile, "TemporaryDirectory", return_value=fixture_temp):
                    case.setUp()
                self.assertEqual(case.out, (Path(fixture_temp.name) / "out").resolve())
            finally:
                case.doCleanups()

    @unittest.skipUnless(sys.platform == "win32", "Windows 8.3 paths only")
    def test_real_short_path_fixture_reaches_publication_failure_injections(self) -> None:
        get_short_path = ctypes.WinDLL("kernel32", use_last_error=True).GetShortPathNameW
        get_short_path.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint]
        get_short_path.restype = ctypes.c_uint
        methods = (
            "test_publication_failure_rolls_back_all_existing_artifacts",
            "test_publication_keyboard_interrupt_rolls_back_partial_files",
            "test_failed_recovery_keeps_backups_and_next_invocation_recovers",
        )
        with tempfile.TemporaryDirectory(prefix="term-extract-long-fixture-name-") as temp:
            size = get_short_path(temp, None, 0)
            if not size:
                raise ctypes.WinError(ctypes.get_last_error())
            buffer = ctypes.create_unicode_buffer(size)
            length = get_short_path(temp, buffer, size)
            if not length:
                raise ctypes.WinError(ctypes.get_last_error())
            self.assertLess(length, size)
            alias = Path(buffer.value)
            canonical = Path(temp).resolve()
            if alias == Path(temp) or alias == canonical:
                self.skipTest("filesystem does not provide a Windows 8.3 path alias")
            self.assertEqual(alias.resolve(), canonical)
            self.assertTrue(alias.samefile(canonical))
            for method in methods:
                with self.subTest(method=method), tempfile.TemporaryDirectory(dir=alias) as fixture_dir:
                    case = publication.ScanPublicationTests(method)
                    fixture_temp = SimpleNamespace(name=fixture_dir, cleanup=lambda: None)
                    try:
                        # Only setUp receives the alias; production staging and filesystem operations stay real.
                        with mock.patch.object(publication.tempfile, "TemporaryDirectory", return_value=fixture_temp):
                            case.setUp()
                        getattr(case, method)()
                    finally:
                        case.doCleanups()

    def test_unchanged_short_path_api_result_is_not_counted_as_alias_coverage(self) -> None:
        def unchanged_api(path, buffer, _size):
            if buffer is None:
                return len(path) + 1
            buffer.value = path
            return len(path)

        with tempfile.TemporaryDirectory() as temp:
            spelling = Path(temp) / "alternate-spelling"
            spelling.mkdir()
            result = unittest.TestResult()
            case = type(self)("test_real_short_path_fixture_reaches_publication_failure_injections")
            guarded = type(self).test_real_short_path_fixture_reaches_publication_failure_injections
            implementation = getattr(guarded, "__wrapped__", guarded)
            with mock.patch.object(tempfile, "tempdir", str(spelling / "..")), \
                    mock.patch.object(sys, "platform", "win32"), \
                    mock.patch.object(ctypes, "WinDLL", create=True,
                                      return_value=SimpleNamespace(GetShortPathNameW=unchanged_api)):
                unittest.FunctionTestCase(lambda: implementation(case)).run(result)
            self.assertEqual(result.failures, [])
            self.assertEqual(result.errors, [])
            self.assertEqual(len(result.skipped), 1)
            self.assertEqual(result.skipped[0][1], "filesystem does not provide a Windows 8.3 path alias")

    def test_platform_skip_policy_is_exact_and_does_not_exempt_missing_capability(self) -> None:
        identity = ("test_term_extract_fixture_paths.FixturePathTests."
                    "test_real_short_path_fixture_reaches_publication_failure_injections")
        with mock.patch.object(test_policy.os, "name", "posix"):
            self.assertTrue(test_policy.allowed_platform_skip(identity, "Windows 8.3 paths only"))
            self.assertTrue(test_policy.allowed_platform_skip("tests." + identity, "Windows 8.3 paths only"))
            self.assertFalse(test_policy.allowed_platform_skip(identity, "filesystem does not provide a Windows 8.3 path alias"))
            self.assertFalse(test_policy.allowed_platform_skip(identity + "_other", "Windows 8.3 paths only"))
        with mock.patch.object(test_policy.os, "name", "nt"):
            self.assertFalse(test_policy.allowed_platform_skip(identity, "Windows 8.3 paths only"))
            self.assertFalse(test_policy.allowed_platform_skip(identity, "filesystem does not provide a Windows 8.3 path alias"))


if __name__ == "__main__":
    unittest.main()
