from __future__ import annotations

import multiprocessing
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from maw.thumbnail_jobs import ThumbnailCoordinator, ThumbnailJobManager, plan_targets, source_key


def _lease_process(database, source, ready):
    coordinator = ThumbnailCoordinator(Path(database))
    coordinator.lease('child', source, playing=True)
    ready.set()


class ThumbnailCoordinatorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root / 'coord.sqlite3'
        self.coordinator = ThumbnailCoordinator(self.path)

    def test_cross_process_pause_and_expired_lease_resume(self):
        ready = multiprocessing.Event()
        process = multiprocessing.Process(target=_lease_process, args=(str(self.path), 'video', ready))
        process.start()
        self.assertTrue(ready.wait(5))
        process.join(5)
        self.assertEqual(process.exitcode, 0)
        self.assertTrue(self.coordinator.paused('video'))
        self.assertFalse(self.coordinator.paused('other'))
        with self.coordinator._db() as db:
            db.execute('UPDATE leases SET expires=?', (time.time()-1,))
        self.assertFalse(self.coordinator.paused('video'))

    def test_foreground_priority_and_duplicate_claim(self):
        self.coordinator.lease('view', 'video', visible=True)
        self.assertTrue(self.coordinator.paused('video', background=True))
        self.assertFalse(self.coordinator.paused('video'))
        self.assertEqual(self.coordinator.claim('video', ['frame'], 'launcher'), ['frame'])
        other = ThumbnailCoordinator(self.path)
        self.assertEqual(other.claim('video', ['frame'], 'editor'), [])
        self.assertTrue(other.busy('frame'))
        self.coordinator.finish('launcher')
        self.assertEqual(other.claim('video', ['frame'], 'editor'), ['frame'])
        self.coordinator.release('view')
        self.assertFalse(self.coordinator.paused('video', background=True))

    def test_build_base_reports_pause_and_resume_once(self):
        from maw import thumbnail_cache
        from maw.thumbnail_jobs import build_base
        source = self.root / "video.mp4"
        source.write_bytes(b"source")
        messages = []
        def build(path, **kwargs):
            kwargs["before_batch"]([0])
            return {"state": "ready"}
        with mock.patch.object(self.coordinator, "paused", side_effect=[True, True, False]), mock.patch("maw.thumbnail_jobs.time.sleep"), mock.patch.object(thumbnail_cache, "load_or_build_base", side_effect=build):
            result = build_base(source, coordinator=self.coordinator, progress=messages.append)
        self.assertEqual(result["state"], "ready")
        self.assertEqual(messages, [
            "[thumbnails] 同源播放或可见画面需求优先，基础画面生成已暂停",
            "[thumbnails] 同源优先需求已释放，继续生成基础画面",
        ])

    def test_claim_batch_and_lease_limits(self):
        self.assertEqual(len(self.coordinator.claim('v', [str(i) for i in range(100)], 'o')), 16)
        for index in range(64):
            self.coordinator.lease(str(index), 'v')
        with self.assertRaises(RuntimeError):
            self.coordinator.lease('overflow', 'v')
        self.coordinator.lease('0', 'v', playing=True)

    def test_keyframe_pass_resumes_with_fresh_cancellation_and_configured_tools(self):
        from maw import thumbnail_cache, thumbnails
        from maw.thumbnail_jobs import build_base
        source = self.root / "resume.mp4"
        source.write_bytes(b"source")
        paused = threading.Event()
        attempts = []
        result = object()

        def extract(path, **kwargs):
            self.assertEqual(kwargs["ffmpeg_path"], "configured-tools")
            self.assertGreater(kwargs["timeout_s"], 0)
            self.assertLessEqual(kwargs["timeout_s"], 2)
            attempts.append(kwargs["cancel"])
            self.assertFalse(kwargs["cancel"].is_set())
            if len(attempts) == 1:
                paused.set()
                self.assertTrue(kwargs["cancel"].wait(1), "playback interrupts the active pass")
                paused.clear()
                raise thumbnails.ThumbnailCancelled("playback")
            self.assertIsNot(attempts[0], kwargs["cancel"])
            return result

        with mock.patch.object(self.coordinator, "paused", side_effect=lambda *_a, **_k: paused.is_set()), \
             mock.patch.object(thumbnail_cache, "load_or_build_base", side_effect=lambda _p, **kw: kw["keyframe_extract"]()), \
             mock.patch.object(thumbnails, "extract_keyframes", side_effect=extract):
            self.assertIs(build_base(source, coordinator=self.coordinator, exact=False,
                ffmpeg_path="configured-tools", timeout_s=2), result)
        self.assertEqual(len(attempts), 2)

    def test_keyframe_retry_stops_when_source_changes(self):
        from maw import thumbnail_cache, thumbnails
        from maw.thumbnail_jobs import build_base
        source = self.root / "replace.mp4"
        source.write_bytes(b"source")

        def extract(path, **kwargs):
            source.write_bytes(b"replacement source")
            self.assertTrue(kwargs["cancel"].wait(1))
            raise thumbnails.ThumbnailCancelled("source changed")

        with mock.patch.object(thumbnail_cache, "load_or_build_base", side_effect=lambda _p, **kw: kw["keyframe_extract"]()), \
             mock.patch.object(thumbnails, "extract_keyframes", side_effect=extract) as decode:
            with self.assertRaisesRegex(OSError, "source changed"):
                build_base(source, coordinator=self.coordinator, exact=False)
        self.assertEqual(decode.call_count, 1)

    def test_keyframe_retry_stops_at_original_deadline(self):
        from maw import thumbnail_cache, thumbnails
        from maw.thumbnail_jobs import build_base
        source = self.root / "deadline.mp4"
        source.write_bytes(b"source")

        with mock.patch("maw.thumbnail_jobs.time.monotonic", return_value=100) as clock:
            def extract(path, **kwargs):
                clock.return_value = 102
                raise thumbnails.ThumbnailCancelled("playback")

            with mock.patch.object(self.coordinator, "paused", return_value=False), \
                 mock.patch.object(thumbnail_cache, "load_or_build_base", side_effect=lambda _p, **kw: kw["keyframe_extract"]()), \
                 mock.patch.object(thumbnails, "extract_keyframes", side_effect=extract) as decode:
                with self.assertRaisesRegex(TimeoutError, "timed out"):
                    build_base(source, coordinator=self.coordinator, exact=False, timeout_s=1)
            self.assertEqual(decode.call_count, 1)

    def test_source_replacement_changes_identity(self):
        path = self.root / 'media.mp4'
        path.write_bytes(b'old')
        old = source_key(path)
        path.write_bytes(b'new-longer')
        self.assertNotEqual(source_key(path), old)


class ThumbnailDemandTests(unittest.TestCase):
    def test_source_zero_union_end_excluded_and_priority(self):
        targets = plan_targets([{'start_ms': 1750, 'end_ms': 4000},
                                {'start_ms': 2500, 'end_ms': 6000}], 1000, 6000, [3500])
        self.assertEqual(targets[0], 3500)
        self.assertEqual(len(targets), len(set(targets)))
        self.assertIn(1000, targets)
        self.assertNotIn(6000, targets)
        self.assertTrue(all(point < 6000 for point in targets))

    def test_malicious_density_and_ranges_rejected(self):
        for ranges, interval in (([{'start_ms': 0, 'end_ms': 7200000}], 250),
                                 ([{'start_ms': True, 'end_ms': 5}], 1000),
                                 ([{}]*33, 1000), ([], 123)):
            with self.assertRaises(ValueError):
                plan_targets(ranges, interval, 7200000)

    def test_client_nonce_is_idempotent_and_stale_view_cannot_resume_playback(self):
        with tempfile.TemporaryDirectory() as temp:
            coord = ThumbnailCoordinator(Path(temp)/'jobs.sqlite3')
            manager = ThumbnailJobManager(coordinator=coord)
            path = Path(temp)/'media.mp4'
            path.write_bytes(b"media")
            manager.bind(path, 'binding')
            manager.info = SimpleNamespace(stream_index=0, duration_ms=10000)
            manager.identity = source_key(path)
            manager._start = lambda: None
            manager._snapshot = lambda lease: dict(manager.leases[lease], lease=lease)
            base = {'binding':'binding', 'client_id':'tab', 'view':5, 'interval_ms':1000,
                    'ranges':[{'start_ms':0,'end_ms':5000}], 'playing':True, 'visible':True}
            first = manager.demand(base)
            second = manager.demand(dict(base, view=4, playing=False))
            self.assertEqual(first['lease'], second['lease'])
            self.assertTrue(second['playing'])
            self.assertEqual(second['view'], 5)
            self.assertTrue(coord.paused(manager.identity))
            current = manager.demand(dict(base, view=6, playing=False))
            self.assertFalse(current['playing'])
            manager.release('binding', first['lease'])
            self.assertFalse(coord.paused(manager.identity, background=True))
            manager.close()

    def test_binding_change_cancels_old_work_and_clears_lease(self):
        with tempfile.TemporaryDirectory() as temp:
            coord = ThumbnailCoordinator(Path(temp)/'jobs.sqlite3')
            manager = ThumbnailJobManager(coordinator=coord)
            manager.bind(None, 'old')
            old_event = manager.active_cancel
            with manager.lock:
                manager._lease(None, 'client')
            manager.bind(None, 'new')
            self.assertTrue(old_event.is_set())
            self.assertEqual(manager.leases, {})
            with self.assertRaises(ValueError):
                manager.status('old')
            manager.close()


    def test_background_packs_fresh_frames_when_cache_admission_refuses(self):
        from maw import thumbnail_cache, thumbnails
        from maw.thumbnail_jobs import coordinated_extract
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)/"video.mp4"
            path.write_bytes(b"source")
            coord = ThumbnailCoordinator(Path(temp)/"jobs.sqlite3")
            fresh = thumbnails.FrameResult(0,0,"target",b"jpeg")
            with mock.patch.object(thumbnail_cache,"lookup_frames",return_value=[None]), \
                 mock.patch.object(thumbnail_cache,"sample_key",return_value="frame-key"), \
                 mock.patch.object(thumbnail_cache,"register_frames",return_value=[]), \
                 mock.patch.object(thumbnail_cache,"get_or_extract_frames",side_effect=AssertionError("fresh frame lost")), \
                 mock.patch.object(thumbnails,"extract_frames",return_value=[fresh]) as decode:
                result = coordinated_extract(path,[0],coordinator=coord,background=True)
            self.assertEqual(result,[fresh])
            decode.assert_called_once()

    def test_release_before_lease_adoption_blocks_late_requests(self):
        manager = ThumbnailJobManager()
        manager.bind(None, "binding")
        manager._start = lambda: None
        manager._snapshot = lambda lease: {"lease":lease}
        first = manager.status("binding",client="tab",view=3)
        manager.release("binding", "", client="tab", view=3)
        self.assertNotIn(first["lease"],manager.leases)
        for view in (0, 2, 3):
            with self.assertRaises(ValueError):
                manager.status("binding",client="tab",view=view)
        self.assertTrue(manager.status("binding",client="tab",view=4)["lease"])
        manager.close()

    def test_playback_cancels_sprite_and_resumes_same_block(self):
        from maw import thumbnails
        from maw.thumbnail_jobs import coordinated_pack
        import threading
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)/"media.mp4"
            path.write_bytes(b"source")
            coord = ThumbnailCoordinator(Path(temp)/"jobs.sqlite3")
            started = threading.Event()
            attempts = []
            result = []
            def tile(jpegs, **kwargs):
                attempts.append(jpegs)
                if len(attempts) == 1:
                    started.set()
                    self.assertTrue(kwargs["cancel"].wait(2))
                    raise thumbnails.ThumbnailCancelled("playing")
                return b"sprite"
            def wait(_targets):
                deadline = time.monotonic()+3
                while coord.paused(source_key(path), background=True):
                    if time.monotonic() > deadline:
                        raise TimeoutError("lease did not release")
                    time.sleep(.01)
            with mock.patch.object(thumbnails, "make_sprite", side_effect=tile):
                worker = threading.Thread(target=lambda: result.append(coordinated_pack(path,[b"frame"],
                    coordinator=coord,before_batch=wait)))
                worker.start()
                self.assertTrue(started.wait(2))
                coord.lease("playing",source_key(path),playing=True)
                time.sleep(.15)
                self.assertTrue(worker.is_alive())
                coord.release("playing")
                worker.join(3)
                self.assertFalse(worker.is_alive())
            self.assertEqual(result,[b"sprite"])
            self.assertEqual(attempts,[[b"frame"],[b"frame"]])


if __name__ == '__main__':
    unittest.main()
