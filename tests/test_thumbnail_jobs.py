from __future__ import annotations

import multiprocessing
import sqlite3
import tempfile
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

    def test_claim_batch_and_lease_limits(self):
        self.assertEqual(len(self.coordinator.claim('v', [str(i) for i in range(100)], 'o')), 16)
        for index in range(64):
            self.coordinator.lease(str(index), 'v')
        with self.assertRaises(RuntimeError):
            self.coordinator.lease('overflow', 'v')
        self.coordinator.lease('0', 'v', playing=True)

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
            manager.bind(Path(temp)/'media.mp4', 'binding')
            manager.info = SimpleNamespace(stream_index=0, duration_ms=10000)
            manager.identity = 'source'
            manager._start = lambda: None
            manager._snapshot = lambda lease: dict(manager.leases[lease], lease=lease)
            base = {'binding':'binding', 'client_id':'tab', 'view':5, 'interval_ms':1000,
                    'ranges':[{'start_ms':0,'end_ms':5000}], 'playing':True, 'visible':True}
            first = manager.demand(base)
            second = manager.demand(dict(base, view=4, playing=False))
            self.assertEqual(first['lease'], second['lease'])
            self.assertTrue(second['playing'])
            self.assertEqual(second['view'], 5)
            self.assertTrue(coord.paused('source'))
            current = manager.demand(dict(base, view=6, playing=False))
            self.assertFalse(current['playing'])
            manager.release('binding', first['lease'])
            self.assertFalse(coord.paused('source', background=True))
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


if __name__ == '__main__':
    unittest.main()
