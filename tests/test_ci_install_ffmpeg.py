import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from scripts import ci_install_ffmpeg as installer
from tests.compact_assertions import CompactContainerAssertions


class InstallFfmpegTests(CompactContainerAssertions, unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.run = mock.patch.object(installer, 'run').start()
        self.sleep = mock.patch.object(installer.time, 'sleep').start()
        self.addCleanup(mock.patch.stopall)

    def binaries(self):
        directory = self.root / 'lib/ffmpeg/tools/ffmpeg/bin'
        directory.mkdir(parents=True, exist_ok=True)
        (directory / 'ffmpeg.exe').touch()
        (directory / 'ffprobe.exe').touch()
        return directory

    def result(self, code=0, output=''):
        log = self.root / 'install.log'
        log.write_text(output)
        return code, {'status': 'completed', 'cleanup_error': None, 'log': str(log),
                      'diagnostics': [], 'tail': []}

    def test_success_uses_real_binary_directory_without_retry(self):
        directory = self.binaries()
        self.run.return_value = self.result()
        self.assertEqual(installer.install(self.root), directory)
        self.assertEqual(self.run.call_count, 1)
        self.sleep.assert_not_called()

    def test_zero_exit_504_without_binaries_retries_then_succeeds(self):
        def run(*args, **kwargs):
            if self.run.call_count == 1:
                return self.result(0, 'Response status: 504 (Gateway Timeout)')
            self.binaries()
            return self.result()
        self.run.side_effect = run
        self.assertEqual(installer.install(self.root), self.binaries())
        self.assertEqual(self.run.call_count, 2)
        self.sleep.assert_called_once_with(5)

    def test_exhausted_transient_failure_does_not_publish_path(self):
        self.run.return_value = self.result(1, 'HTTP 503')
        path = self.root / 'github-path'
        with mock.patch.dict(os.environ, {'ChocolateyInstall': str(self.root), 'GITHUB_PATH': str(path)}):
            with self.assertRaises(RuntimeError):
                installer.main()
        self.assertEqual(self.run.call_count, 3)
        self.assertEqual(self.sleep.call_count, 2)
        self.assertFalse(path.exists())

    def test_permanent_error_not_retried_even_with_existing_binaries(self):
        self.binaries()
        self.run.return_value = self.result(1, 'invalid package signature')
        with self.assertRaises(RuntimeError):
            installer.install(self.root)
        self.assertEqual(self.run.call_count, 1)

    def test_success_exit_without_pair_fails(self):
        directory = self.binaries()
        (directory / 'ffprobe.exe').unlink()
        self.run.return_value = self.result()
        with self.assertRaises(RuntimeError):
            installer.install(self.root)
        self.sleep.assert_not_called()

    def test_timeout_does_not_start_another_installer(self):
        code, result = self.result(124)
        result['status'] = 'timeout'
        self.run.return_value = code, result
        with self.assertRaises(RuntimeError):
            installer.install(self.root)
        self.assertEqual(self.run.call_count, 1)
        self.assertEqual(self.run.call_args.args[1], 180)
        self.sleep.assert_not_called()

    def test_cleanup_failure_is_not_retried(self):
        code, result = self.result(1, 'HTTP 504')
        result['cleanup_error'] = 'process still running'
        self.run.return_value = code, result
        with self.assertRaises(RuntimeError):
            installer.install(self.root)
        self.sleep.assert_not_called()

    def test_main_publishes_verified_directory(self):
        directory = self.binaries()
        self.run.return_value = self.result()
        path = self.root / 'github-path'
        with mock.patch.dict(os.environ, {'ChocolateyInstall': str(self.root), 'GITHUB_PATH': str(path)}):
            installer.main()
        self.assertEqual(path.read_text(), str(directory) + '\n')

    def test_action_keeps_real_capability_gate(self):
        text = (Path(__file__).resolve().parents[1] / '.github/actions/test-environment/action.yml').read_text()
        self.assertIn('python scripts/ci_install_ffmpeg.py', text)
        for required in ('ffmpeg -version', 'ffprobe -version', 'libx264', 'libwebp', ' ass +V->V'):
            self.assertIn(required, text)
        self.assertNotIn('continue-on-error', text)
