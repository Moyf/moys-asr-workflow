"""Two actual processes must not recover or publish each other's transaction."""

from __future__ import annotations

import contextlib
import io
import multiprocessing
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools" / "term-extract"))
from term_extract import __main__ as cli  # noqa: E402
from tests.compact_assertions import CompactContainerAssertions  # noqa: E402


def hold_pipeline(video, out, ready, release):
    def staged(*args, **kwargs):
        # An unfinished transaction must be left alone by the competing CLI.
        (Path(out) / cli.PUBLICATION_MARKER).write_text('pending transaction', encoding='utf-8')
        ready.set()
        if not release.wait(20):
            raise TimeoutError('parent did not release pipeline')
        (Path(out) / cli.PUBLICATION_MARKER).unlink()
        return 0

    args = cli.build_parser().parse_args([video, '--out', out, '--no-ai'])
    with mock.patch.object(cli, '_run_staged_pipeline', side_effect=staged):
        raise SystemExit(cli.run_pipeline(args))


class OutputLockTests(CompactContainerAssertions, unittest.TestCase):
    def test_competing_cli_cannot_recover_active_transaction_and_exit_releases_lock(self):
        with tempfile.TemporaryDirectory() as folder:
            video = Path(folder) / 'fake.mp4'
            video.write_bytes(b'fake')
            out = Path(folder) / 'out'
            ctx = multiprocessing.get_context('spawn')
            ready, release = ctx.Event(), ctx.Event()
            process = ctx.Process(target=hold_pipeline, args=(str(video), str(out), ready, release))
            process.start()
            try:
                self.assertTrue(ready.wait(15))
                args = cli.build_parser().parse_args([str(video), '--out', str(out), '--no-ai'])
                output = io.StringIO()
                with contextlib.redirect_stderr(output), mock.patch.object(cli, '_recover_publication') as recover:
                    self.assertEqual(cli.run_pipeline(args), 1)
                    recover.assert_not_called()
                self.assertIn('输出目录正在被另一任务使用', output.getvalue())
                self.assertEqual((out / cli.PUBLICATION_MARKER).read_text(encoding='utf-8'), 'pending transaction')
                # A distinct directory is independent.
                other = cli.build_parser().parse_args([str(video), '--out', str(Path(folder) / 'other')])
                with mock.patch.object(cli, '_run_staged_pipeline', return_value=0):
                    self.assertEqual(cli.run_pipeline(other), 0)
            finally:
                release.set()
                process.join(15)
                if process.is_alive():
                    process.terminate()
                    process.join(5)
            self.assertEqual(process.exitcode, 0)
            with mock.patch.object(cli, '_run_staged_pipeline', return_value=0):
                self.assertEqual(cli.run_pipeline(args), 0)

    def test_killed_process_releases_lock_and_next_cli_recovers(self):
        with tempfile.TemporaryDirectory() as folder:
            video = Path(folder) / 'fake.mp4'
            video.write_bytes(b'fake')
            out = Path(folder) / 'out'
            ctx = multiprocessing.get_context('spawn')
            ready, release = ctx.Event(), ctx.Event()
            process = ctx.Process(target=hold_pipeline, args=(str(video), str(out), ready, release))
            process.start()
            try:
                self.assertTrue(ready.wait(15))
            finally:
                process.terminate()
                process.join(10)
            args = cli.build_parser().parse_args([str(video), '--out', str(out)])
            with mock.patch.object(cli, '_recover_publication') as recover, \
                    mock.patch.object(cli, '_run_staged_pipeline', return_value=0):
                self.assertEqual(cli.run_pipeline(args), 0)
                recover.assert_called_once_with(out)
