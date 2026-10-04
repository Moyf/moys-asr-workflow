from __future__ import annotations

import errno
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from maw.file_errors import IntermediateFileError, file_error_code
from maw.postprocess_io import _atomic_write
from maw.postprocess_pipeline import _copy_atomic, _create_run_directory


class FileErrorTests(unittest.TestCase):
    def test_os_codes_and_child_tracebacks_identify_long_paths(self):
        windows = OSError("localized OS message")
        windows.winerror = 206
        for error in (windows, OSError(errno.ENAMETOOLONG, "long"),
                      "OSError: [WinError 206] 文件名或扩展名太长", "[Errno 36] File name too long"):
            with self.subTest(error=error):
                self.assertEqual(file_error_code(error), "file_path_too_long")

    def test_other_os_failures_are_not_reported_as_long_paths(self):
        for code in (errno.ENOENT, errno.EACCES, errno.ENOSPC, errno.EINVAL):
            error = OSError(code, "failure")
            self.assertEqual(file_error_code(error), "")
            wrapped = IntermediateFileError(error)
            self.assertEqual(file_error_code(wrapped), "intermediate_file_failed")
            self.assertNotIn("缩短原文件名", str(wrapped))
        self.assertEqual(file_error_code(RuntimeError("LLM HTTP 401")), "")

    def test_wrapped_cause_is_preserved_and_cycles_terminate(self):
        cause = OSError(errno.ENAMETOOLONG, "long")
        wrapped = IntermediateFileError(cause)
        outer = RuntimeError("step failed")
        outer.__cause__ = wrapped
        wrapped.__cause__ = cause
        cause.__context__ = outer
        self.assertEqual(file_error_code(outer), "intermediate_path_too_long")
        self.assertIn("重新选择文件", str(wrapped))

    def test_atomic_write_and_copy_use_short_names_and_preserve_outputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            destination = root / ("x" * 240 + ".srt")
            source = root / "source.srt"
            source.write_text("source", encoding="utf-8")
            real_mkstemp = tempfile.mkstemp
            names = []

            def record(**kwargs):
                fd, name = real_mkstemp(**kwargs)
                names.append(Path(name))
                self.assertEqual(Path(name).parent, root)
                self.assertLess(len(Path(name).name), 32)
                return fd, name

            with mock.patch("tempfile.mkstemp", side_effect=record):
                _atomic_write(destination, "subtitle\n")
                self.assertEqual(destination.read_bytes(), b"\xef\xbb\xbfsubtitle\n")
                _copy_atomic(source, destination)
            self.assertEqual(destination.read_text(encoding="utf-8"), "source")
            self.assertTrue(all(not path.exists() for path in names))

    def test_failed_replace_preserves_existing_file_and_cleans_tmp(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "clip.mosp"
            path.write_text("old", encoding="utf-8")
            failure = PermissionError(errno.EACCES, "access denied")
            with mock.patch("maw.postprocess_io.os.replace", side_effect=failure):
                with self.assertRaises(IntermediateFileError) as caught:
                    _atomic_write(path, "new")
            self.assertIs(caught.exception.__cause__, failure)
            self.assertEqual(path.read_text(encoding="utf-8"), "old")
            self.assertEqual(list(Path(directory).glob("*.tmp")), [])

    def test_cleanup_failure_does_not_hide_write_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "clip.mosp"
            failure = OSError(errno.ENOSPC, "disk full")
            with (mock.patch("maw.postprocess_io.os.replace", side_effect=failure),
                  mock.patch.object(Path, "unlink", side_effect=PermissionError("cleanup denied"))):
                with self.assertRaises(IntermediateFileError) as caught:
                    _atomic_write(path, "new")
            self.assertIs(caught.exception.__cause__, failure)

    def test_workspace_creation_failure_has_intermediate_context(self):
        with (mock.patch("maw.output_naming.subfolder_prefs", return_value=(True, True)),
              mock.patch.object(Path, "mkdir", side_effect=OSError(errno.ENAMETOOLONG, "long"))):
            with self.assertRaises(IntermediateFileError) as caught:
                _create_run_directory(Path("clip.mp4"), lang="en")
        self.assertEqual(file_error_code(caught.exception), "intermediate_path_too_long")


if __name__ == "__main__":
    unittest.main()
