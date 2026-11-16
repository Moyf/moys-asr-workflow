import hashlib
from http.client import IncompleteRead
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock
from zipfile import ZipFile

from scripts import ci_windows_ffmpeg as installer
from tests.compact_assertions import CompactContainerAssertions


ROOT = Path(__file__).resolve().parents[1]
RELEASE_SHA256 = installer.SHA256


class WindowsFfmpegTests(CompactContainerAssertions, unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.cache = self.root / 'cache'
        self.cache.mkdir()
        self.archive = self.cache / installer.ARCHIVE
        with ZipFile(self.archive, 'w') as package:
            for name in ('ffmpeg.exe', 'ffprobe.exe'):
                package.writestr(f'ffmpeg-{installer.VERSION}-essentials_build/bin/{name}', name)
        self.content = self.archive.read_bytes()
        self.hash_patch = mock.patch.object(installer, 'SHA256', hashlib.sha256(self.content).hexdigest())
        self.hash_patch.start()
        self.addCleanup(self.hash_patch.stop)

    def test_cache_hit_is_verified_and_installed_without_network(self):
        with mock.patch.object(installer, 'download') as download, mock.patch.object(installer.subprocess, 'run') as run:
            result = installer.install(self.cache, self.root / 'bin')
        download.assert_not_called()
        self.assertEqual((result / 'ffmpeg.exe').read_text(), 'ffmpeg.exe')
        self.assertEqual((result / 'ffprobe.exe').read_text(), 'ffprobe.exe')
        self.assertEqual(run.call_count, 2)

    def test_cache_miss_downloads_and_verifies(self):
        self.archive.unlink()
        with mock.patch.object(installer, 'download', side_effect=lambda url, path: path.write_bytes(self.content)) as download:
            self.assertEqual(installer.prepare_archive(self.cache), self.archive)
        download.assert_called_once()
        self.assertEqual(self.archive.read_bytes(), self.content)

    def test_corrupt_cache_is_replaced_and_bad_primary_falls_back(self):
        self.archive.write_bytes(b'corrupt')
        def download(url, path):
            path.write_bytes(b'wrong' if url == installer.URLS[0] else self.content)
        with mock.patch.object(installer, 'download', side_effect=download) as fetch, mock.patch.object(installer.time, 'sleep'):
            self.assertEqual(installer.prepare_archive(self.cache), self.archive)
        self.assertEqual(fetch.call_count, installer.ATTEMPTS + 1)
        self.assertEqual(self.archive.read_bytes(), self.content)
        self.assertFalse((self.cache / (installer.ARCHIVE + '.part')).exists())

    def test_download_failure_is_bounded_and_does_not_publish(self):
        self.archive.unlink()
        path_file = self.root / 'github-path'
        with mock.patch.dict(os.environ, {'RUNNER_TEMP': str(self.root), 'GITHUB_PATH': str(path_file)}), \
                mock.patch.object(installer, 'download', side_effect=OSError('offline')) as fetch, \
                mock.patch.object(installer.time, 'sleep'):
            with self.assertRaises(RuntimeError):
                installer.main()
        self.assertEqual(fetch.call_count, len(installer.URLS) * installer.ATTEMPTS)
        self.assertFalse(path_file.exists())

    def test_incomplete_response_is_retried_and_partial_removed(self):
        self.archive.unlink()
        def download(url, path):
            path.write_bytes(b'partial')
            raise IncompleteRead(b'partial')
        with mock.patch.object(installer, 'download', side_effect=download) as fetch, mock.patch.object(installer.time, 'sleep'):
            with self.assertRaises(RuntimeError):
                installer.prepare_archive(self.cache)
        self.assertEqual(fetch.call_count, len(installer.URLS) * installer.ATTEMPTS)
        self.assertFalse((self.cache / (installer.ARCHIVE + '.part')).exists())

    def test_download_process_has_wall_clock_limit_and_timeout_tries_fallback(self):
        with mock.patch.object(installer.subprocess, 'run') as run:
            installer.download(installer.URLS[0], self.root / 'partial')
        self.assertEqual(run.call_args.kwargs['timeout'], 120)
        self.archive.unlink()
        def download(url, path):
            if url == installer.URLS[0]:
                path.write_bytes(b'partial')
                raise subprocess.TimeoutExpired('download', 120)
            path.write_bytes(self.content)
        with mock.patch.object(installer, 'download', side_effect=download) as fetch, mock.patch.object(installer.time, 'sleep'):
            self.assertEqual(installer.prepare_archive(self.cache), self.archive)
        self.assertEqual(fetch.call_count, installer.ATTEMPTS + 1)

    def test_missing_binary_and_process_failure_do_not_publish_path(self):
        path_file = self.root / 'github-path'
        with mock.patch.dict(os.environ, {'RUNNER_TEMP': str(self.root), 'GITHUB_PATH': str(path_file)}), \
                mock.patch.object(installer, 'prepare_archive', return_value=self.archive):
            with ZipFile(self.archive, 'w') as package:
                package.writestr(f'ffmpeg-{installer.VERSION}-essentials_build/bin/ffmpeg.exe', 'x')
            with self.assertRaises(KeyError):
                installer.main()
            self.archive.write_bytes(self.content)
            with mock.patch.object(installer.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, 'ffmpeg')):
                with self.assertRaises(subprocess.CalledProcessError):
                    installer.main()
        self.assertFalse(path_file.exists())

    def test_workflows_keep_pinned_release_and_capability_gates(self):
        release = (ROOT / '.github/workflows/release.yml').read_text(encoding='utf-8')
        preview = (ROOT / '.github/workflows/pr-release-windows.yml').read_text(encoding='utf-8')
        setup = (ROOT / '.github/actions/test-environment/action.yml').read_text(encoding='utf-8')
        action = (ROOT / '.github/actions/windows-ffmpeg/action.yml').read_text(encoding='utf-8')
        self.assertIn(f"$FfmpegVersion = '{installer.VERSION}'", release)
        self.assertIn(RELEASE_SHA256, release)
        for url in installer.URLS:
            self.assertIn(url.replace(installer.VERSION, '$FfmpegVersion'), release)
        for workflow in (release, preview, setup):
            self.assertIn('uses: ./.github/actions/windows-ffmpeg', workflow)
        for required in ('ffmpeg -version', 'ffprobe -version', 'libx264', 'libwebp', ' ass +V->V'):
            self.assertIn(required, setup)
        self.assertIn('actions/cache/restore@v4', action)
        self.assertIn('actions/cache/save@v4', action)
        self.assertIn('runner.os', action)
        self.assertIn('runner.arch', action)
        self.assertIn('hashFiles', action)
        self.assertIn('scripts/run_check.py --timeout 840', action)
        self.assertNotIn('restore-keys', action)


if __name__ == '__main__':
    unittest.main()
