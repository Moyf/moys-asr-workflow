from __future__ import annotations

import contextlib
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from maw import thumbnail_cache as cache, thumbnails
from maw.thumbnail_jobs import ThumbnailJobManager


class ThumbnailProbeResponsivenessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "video.mp4"
        self.path.write_bytes(b"source")
        self.manager = ThumbnailJobManager(coordinator=mock.Mock())
        self.manager.bind(self.path, "binding")
        self.manager._start = lambda: None
        self.manager._snapshot = lambda lease: {"state": self.manager.state}
        self.info = thumbnails.VideoInfo(0, 10000, 0, 0)
        self.stack = self.enterContext(contextlib.ExitStack())
        self.stack.enter_context(mock.patch.object(cache, "_video_memo", {}))
        self.stack.enter_context(mock.patch.object(cache, "load_base", return_value=None))
        self.stack.enter_context(mock.patch.object(cache, "lookup_frames", return_value=[]))
        # Exercise the real identity/memo path without SQLite or disk latency.
        self.stack.enter_context(mock.patch.object(cache, "can_prefetch",
            side_effect=lambda path: bool(cache.identity_key(path))))
        self.addCleanup(self.manager.close)
        self.errors = []

    def start_step(self):
        def step():
            try:
                self.manager._step(thumbnails, cache)
            except thumbnails.ThumbnailCancelled:
                pass
            except BaseException as error:
                self.errors.append(error)
        self.manager.worker = threading.Thread(target=step, daemon=True)
        self.manager.worker.start()

    def blocked_probe(self, action):
        entered = threading.Event()
        release = threading.Event()
        completed = threading.Event()
        cancellations = []

        def probe(path, *, cancel=None, **kwargs):
            cancellations.append(cancel)
            entered.set()
            while not release.wait(.01):
                if cancel is not None and cancel.is_set():
                    raise thumbnails.ThumbnailCancelled("closed")
            return self.info

        # The old manager probes directly, then stalls in the cache's second,
        # uncancellable probe. The fixed manager reaches this gate outside its lock.
        self.stack.enter_context(mock.patch.object(thumbnails, "probe_video", return_value=self.info))
        self.stack.enter_context(mock.patch.object(cache, "probe_video", side_effect=probe))
        self.stack.enter_context(mock.patch.object(cache, "release_owner"))
        caller = None
        try:
            self.start_step()
            self.assertTrue(entered.wait(2), "cache probe was not reached")

            def call():
                try:
                    action()
                except BaseException as error:
                    self.errors.append(error)
                finally:
                    completed.set()

            caller = threading.Thread(target=call, daemon=True)
            caller.start()
            self.assertTrue(completed.wait(1), "manager lock held by video probe")
            self.assertIsNotNone(cancellations[0], "probe must receive active cancellation")
        finally:
            release.set()
            if caller:
                caller.join(2)
            self.manager.close()
        self.assertFalse(self.manager.worker.is_alive())
        self.assertEqual(self.errors, [])

    def test_status_responds_while_cache_probe_is_blocked(self):
        self.blocked_probe(lambda: self.manager.status("binding", client="tab"))

    def test_close_cancels_blocked_cache_probe(self):
        self.blocked_probe(self.manager.close)

    def test_same_source_is_probed_once_for_manager_and_cache(self):
        with mock.patch.object(thumbnails, "probe_video", return_value=self.info) as direct, \
             mock.patch.object(cache, "probe_video", return_value=self.info) as cached:
            try:
                self.manager._step(thumbnails, cache)
                self.manager._step(thumbnails, cache)
                self.assertEqual(direct.call_count + cached.call_count, 1)
                self.assertEqual(cache.get_video_info(self.path), self.manager.info)
            finally:
                self.manager.close()

    def test_public_probe_forwards_tools_and_cancellation(self):
        cancel = threading.Event()
        with mock.patch.object(cache, "probe_video", return_value=self.info) as probe:
            self.assertEqual(cache.get_video_info(self.path, cancel=cancel,
                ffmpeg_path="configured-tools"), self.info)
        probe.assert_called_once_with(self.path, cancel=cancel, ffmpeg_path="configured-tools")

    def test_replacement_during_probe_does_not_poison_metadata_memo(self):
        def replace(path, **kwargs):
            path.write_bytes(b"replacement source")
            return self.info

        with mock.patch.object(cache, "probe_video", side_effect=replace):
            with self.assertRaisesRegex(thumbnails.ThumbnailError, "source changed"):
                cache.get_video_info(self.path)
        self.assertEqual(cache._video_memo, {})
        replacement = thumbnails.VideoInfo(1, 20000, 0, 0)
        with mock.patch.object(cache, "probe_video", return_value=replacement) as probe:
            self.assertEqual(cache.get_video_info(self.path), replacement)
            self.assertEqual(cache.get_video_info(self.path), replacement)
        probe.assert_called_once()

    def test_stale_probe_error_cannot_poison_replacement_after_status_refresh(self):
        entered = threading.Event()
        release = threading.Event()
        replacement_probe = threading.Event()
        calls = 0

        def probe(path, *, cancel=None, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                entered.set()
                if not release.wait(2):
                    raise AssertionError("replacement was not released")
                # Simulate probe finishing just as the source is replaced;
                # cache's real post-probe identity check raises the stale error.
                return self.info
            replacement_probe.set()
            if not cancel.wait(2):
                raise AssertionError("replacement probe was not cancelled")
            raise thumbnails.ThumbnailCancelled("closed")

        with mock.patch.object(cache, "probe_video", side_effect=probe), \
             mock.patch.object(cache, "release_owner"):
            self.manager.worker = threading.Thread(target=self.manager._run, daemon=True)
            self.manager.wake.set()
            self.manager.worker.start()
            try:
                self.assertTrue(entered.wait(2))
                self.path.write_bytes(b"replacement source")
                self.manager.status("binding", client="tab")
                replacement_identity = self.manager.identity
                release.set()
                self.assertTrue(replacement_probe.wait(1),
                    f"stale probe prevented replacement work: {self.manager.state}: {self.manager.error}")
                self.assertEqual(self.manager.identity, replacement_identity)
                self.assertNotEqual(self.manager.state, "error")
                self.assertEqual(self.manager.error, "")
            finally:
                release.set()
                self.manager.close()
            self.assertFalse(self.manager.worker.is_alive())

    def test_current_probe_error_is_still_reported(self):
        with mock.patch.object(cache, "probe_video",
                               side_effect=thumbnails.ThumbnailError("current probe failed")):
            self.manager._step(thumbnails, cache)
        self.assertEqual(self.manager.state, "error")
        self.assertEqual(self.manager.error, "current probe failed")

    def test_missing_current_source_is_an_error_not_a_reprobe_loop(self):
        def remove(path, **kwargs):
            path.rename(path.with_suffix(".gone"))
            return self.info

        with mock.patch.object(cache, "probe_video", side_effect=remove):
            self.manager._step(thumbnails, cache)
        self.assertEqual(self.manager.state, "error")
        self.assertTrue(self.manager.error)

    def test_probe_cancellation_is_not_published_as_an_error(self):
        with mock.patch.object(cache, "probe_video",
                               side_effect=thumbnails.ThumbnailCancelled("cancelled")):
            with self.assertRaises(thumbnails.ThumbnailCancelled):
                self.manager._step(thumbnails, cache)
        self.assertNotEqual(self.manager.state, "error")
        self.assertEqual(self.manager.error, "")

    def test_probe_error_after_rebind_is_discarded(self):
        def rebind(path, **kwargs):
            self.manager.bind(path, "replacement-binding")
            raise thumbnails.ThumbnailError("obsolete binding probe failed")

        with mock.patch.object(cache, "probe_video", side_effect=rebind):
            self.manager._step(thumbnails, cache)
        self.assertEqual(self.manager.binding, "replacement-binding")
        self.assertNotEqual(self.manager.state, "error")
        self.assertEqual(self.manager.error, "")
        self.assertTrue(self.manager.wake.is_set())

    def test_probe_error_after_replacement_without_status_is_discarded(self):
        def replace(path, **kwargs):
            path.write_bytes(b"replacement source")
            return self.info

        with mock.patch.object(cache, "probe_video", side_effect=replace):
            self.manager._step(thumbnails, cache)
        self.assertNotEqual(self.manager.state, "error")
        self.assertEqual(self.manager.error, "")
        self.assertIsNone(self.manager.info)
        self.assertTrue(self.manager.wake.is_set())
