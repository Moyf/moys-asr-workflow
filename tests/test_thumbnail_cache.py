from __future__ import annotations

import contextlib
import io
import json
import os
import sqlite3
import tempfile
import threading
import unittest
import zipfile
from pathlib import Path
from unittest import mock

from maw import thumbnail_cache as c
from maw.thumbnails import FrameResult, ThumbnailCancelled, ThumbnailError, VideoInfo


def jpeg(width=160, height=90, suffix=b"a"):
    return b"\xff\xd8\xff\xc0\x00\x11\x08" + height.to_bytes(2, "big") + width.to_bytes(2, "big") + b"\x03\x01\x11\x00\x02\x11\x00\x03\x11\x00\xff\xd9" + suffix


class ThumbnailCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.media = self.root / "video.mkv"
        self.media.write_bytes(b"source")
        self.video = VideoInfo(1, 40000, 5000)
        self.patches = [mock.patch.object(c, "cache_root", return_value=self.root / "app"), mock.patch.object(c, "waveform_dirs", return_value=[self.root, self.root / "_maw", self.root / "video_maw"]), mock.patch.object(c, "probe_video", return_value=self.video), mock.patch.object(c, "make_sprite", side_effect=lambda frames, **kw: jpeg(1280, ((len(frames)+7)//8)*90))]
        for patch in self.patches:
            patch.start()
        for collection in (c._video_memo, c._base_memo, c._session, c._session_assets, c._write_disabled, c._session_bases, c._session_pins, c._base_touch):
            collection.clear()
        self.calls = []

    def tearDown(self):
        for patch in reversed(self.patches):
            patch.stop()
        self.temp.cleanup()

    def extract(self, path, targets, **kwargs):
        self.calls.append(list(targets))
        return [FrameResult(t, t // 1000 * 1000, "target", jpeg(suffix=str(t//1000).encode())) for t in targets]

    def build(self, **kw):
        return c.load_or_build_base(self.media, batch_extract=self.extract, **kw)

    def test_complete_base_opaque_assets_stored_zip_and_hot_hit(self):
        manifest = self.build()
        self.assertTrue(manifest["base_complete"])
        self.assertFalse(manifest["cache_hit"])
        self.assertTrue(self.build()["cache_hit"])
        self.assertEqual(manifest["valid_count"], 20)
        with zipfile.ZipFile(c.base_path(self.media)) as archive:
            self.assertTrue(all(info.compress_type == zipfile.ZIP_STORED for info in archive.infolist()))
        self.calls.clear()
        with mock.patch.object(c, "probe_video", side_effect=AssertionError("unexpected probe")), mock.patch.object(c, "_crop_sprite", side_effect=AssertionError("unexpected crop")):
            self.assertEqual(c.load_or_build_base(self.media)["cache_revision"], manifest["cache_revision"])
            c.lookup_frames(self.media, [0, 2000])
            view = c.sample_manifest(self.media, [0, 500, 39000])
        self.assertEqual([sample["status"] for sample in view["samples"]], ["target", "preview", "preview"])
        self.assertNotIn(str(self.root), json.dumps(view))
        asset = manifest["assets"][0]["id"]
        self.assertIsNotNone(c.read_asset(self.media, asset, cache_revision=manifest["cache_revision"]))
        self.assertIsNone(c.read_asset(self.media, asset, cache_revision="wrong"))
        self.assertIsNone(c.read_asset(self.media, "../../outside"))

    def test_no_base_asset_revision_is_stable_across_status_requests(self):
        c.get_or_extract_frames(self.media, [0], extractor=self.extract)
        first = c.sample_manifest(self.media, [0])
        second = c.sample_manifest(self.media, [])
        self.assertEqual(first["cache_revision"], second["cache_revision"])
        asset = first["samples"][0]["asset"]
        self.assertIsNotNone(c.read_asset(self.media, asset, cache_revision=second["cache_revision"]))

    def test_same_millisecond_same_size_source_replacement_invalidates_all_caches(self):
        stat = self.media.stat()
        anchor = (stat.st_mtime_ns // 1_000_000) * 1_000_000
        os.utime(self.media, ns=(stat.st_atime_ns, anchor+100))
        first = self.build()
        original_key = c.identity_key(self.media)
        original_browser_ms = first["source_signature"]["modified_ms"]
        self.media.write_bytes(b"SOURCE")
        os.utime(self.media, ns=(stat.st_atime_ns, anchor+900))
        self.assertEqual(c.source_signature(self.media)["modified_ms"], original_browser_ms)
        self.assertNotEqual(c.identity_key(self.media), original_key)
        self.assertIsNone(c.load_base(self.media))
        self.assertEqual(c.lookup_frames(self.media, [0]), [None])

    def test_owner_release_keeps_other_process_asset_pin(self):
        frame = c.get_or_extract_frames(self.media, [0], extractor=self.extract)[0]
        asset = c._asset_id(frame.jpeg)
        c.protect_assets(self.media, [asset], owner="first")
        c.protect_assets(self.media, [asset], owner="second")
        c.release_assets(self.media, [asset], owner="first")
        with contextlib.closing(c._connect()) as db:
            rows = db.execute("SELECT owner FROM pins_leases WHERE asset=?", (asset,)).fetchall()
        self.assertEqual(rows, [("second",)])
        with mock.patch.object(c, "MEDIA_QUOTA_BYTES", len(frame.jpeg)+1):
            c.get_or_extract_frames(self.media, [2000], extractor=self.extract)
        self.assertIsNotNone(c.read_asset(self.media, asset))
        self.media.write_bytes(b"replacement")
        c.release_owner("second")
        with contextlib.closing(c._connect()) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM pins_leases").fetchone()[0], 0)

    def test_physical_sqlite_page_cap_and_prefetch_pressure(self):
        with mock.patch.object(c, "GLOBAL_QUOTA_BYTES", 128*1024), mock.patch.object(c, "MAX_INDEX_BYTES", 64*1024):
            with contextlib.closing(c._connect()) as db:
                self.assertLessEqual(db.execute("PRAGMA max_page_count").fetchone()[0] * db.execute("PRAGMA page_size").fetchone()[0], 192*1024)
                with self.assertRaises(sqlite3.OperationalError):
                    db.execute("INSERT INTO assets VALUES(?,?,?,?,?)", ("test", "large", bytes(256*1024), 256*1024, 0))
        self.assertTrue(c.can_prefetch(self.media))
        c._warning(c.identity_key(self.media))
        self.assertFalse(c.can_prefetch(self.media))

    def age_base(self):
        path = c.base_path(self.media)
        old = 1_600_000_000
        os.utime(path, (old, old))
        with contextlib.closing(c._connect()) as db, db:
            db.execute("UPDATE bases SET used=?", (old,))
        c._base_memo.clear()
        c._base_touch.clear()
        return path

    def test_cleanup_only_registered_inactive_sidecar_and_excludes_current_source(self):
        self.build()
        path = self.age_base()
        untouched = self.root / "unregistered.mothumbs"
        untouched.write_bytes(b"private file")
        recycled = []
        trash = self.root / "trash"
        trash.mkdir()
        def recycle(file):
            recycled.append(file)
            file.replace(trash / file.name)
        with mock.patch.object(c, "_recycle_registered_file", side_effect=recycle):
            protected = c.cleanup_registered(inactive_before=1_700_000_000, exclude_paths=c.base_candidates(self.media))
            self.assertEqual(protected["removed_count"], 0)
            cleaned = c.cleanup_registered(inactive_before=1_700_000_000)
        self.assertEqual(cleaned["removed_count"], 1)
        self.assertEqual(cleaned["errors"], [])
        # Registry paths resolve Windows 8.3 aliases before recycling.
        self.assertEqual([file.resolve() for file in recycled], [path.resolve()])
        self.assertTrue(untouched.is_file())
        with contextlib.closing(c._connect()) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM bases").fetchone()[0], 0)

    def test_cleanup_skips_unexpired_pins_and_reservations(self):
        manifest = self.build()
        path = self.age_base()
        c.protect_assets(self.media, [manifest["assets"][0]["id"]], owner="live")
        with mock.patch.object(c, "_recycle_registered_file", side_effect=AssertionError("active cache recycled")):
            self.assertEqual(c.cleanup_registered(inactive_before=1_700_000_000)["skipped_active"], 1)
        c.release_owner("live")
        with contextlib.closing(c._connect()) as db, db:
            db.execute("INSERT INTO base_reservations VALUES(?,?,?,?)", ("producer", c.identity_key(self.media), 100, 9_999_999_999))
        with mock.patch.object(c, "_recycle_registered_file", side_effect=AssertionError("producer cache recycled")):
            self.assertEqual(c.cleanup_registered(inactive_before=1_700_000_000)["skipped_active"], 1)
        self.assertTrue(path.is_file())

    def test_cleanup_does_not_recycle_replaced_file_and_base_read_refreshes_usage(self):
        self.build()
        path = self.age_base()
        self.assertIsNotNone(c.load_base(self.media))
        with mock.patch.object(c, "_recycle_registered_file", side_effect=AssertionError("recent cache recycled")):
            self.assertEqual(c.cleanup_registered(inactive_before=1_700_000_000)["removed_count"], 0)
        self.age_base()
        original_size = path.stat().st_size
        path.write_bytes(b"x" * original_size)
        os.utime(path, (1_600_000_000, 1_600_000_000))
        with mock.patch.object(c, "_recycle_registered_file", side_effect=AssertionError("user file recycled")):
            result = c.cleanup_registered(inactive_before=1_700_000_000)
        self.assertEqual(result["removed_count"], 0)
        self.assertEqual(len(result["errors"]), 1)
        self.assertTrue(path.is_file())

    def test_sidecar_budget_counts_registered_bases(self):
        manifest = self.build()
        self.assertTrue(manifest["persisted"])
        pressure = c.cache_pressure(self.media)
        self.assertLess(pressure["media_available_bytes"], c.MEDIA_QUOTA_BYTES)
        with contextlib.closing(c._connect()) as db:
            self.assertGreater(db.execute("SELECT SUM(size) FROM bases").fetchone()[0], 0)

    def test_injected_pack_hook_receives_cancel_and_bounded_deadline(self):
        cancel = threading.Event()
        seen = []
        def pack(images, *, cancel=None, timeout_s=0):
            self.assertGreater(timeout_s, 0)
            self.assertLessEqual(timeout_s, 20)
            seen.append((len(images), cancel))
            return jpeg(1280, ((len(images)+7)//8)*90)
        manifest = self.build(cancel=cancel, batch_pack=pack)
        self.assertTrue(manifest["base_complete"])
        self.assertEqual(seen, [(20, cancel)])
        c.make_sprite.assert_not_called()

    def test_failed_persistence_after_source_change_keeps_old_session_namespace(self):
        def fail(path, manifest, blobs, media_path, **kwargs):
            self.media.write_bytes(b"replacement")
            raise OSError("storage unavailable")
        with mock.patch.object(c, "_atomic_save", side_effect=fail):
            self.assertFalse(self.build()["persisted"])
        self.assertIsNone(c.load_base(self.media))
        self.assertEqual(c.lookup_frames(self.media, [0]), [None])

    def test_cancel_during_sprite_packing_reaps_and_keeps_resume_frames(self):
        cancel = threading.Event()
        def pack(frames, **kwargs):
            self.assertIs(kwargs["cancel"], cancel)
            cancel.set()
            raise ThumbnailCancelled("packing interrupted")
        with mock.patch.object(c, "make_sprite", side_effect=pack):
            with self.assertRaises(ThumbnailCancelled):
                c.load_or_build_base(self.media, cancel=cancel, batch_extract=self.extract)
        self.assertFalse(c.load_base(self.media)["base_complete"])
        self.calls.clear()
        self.assertTrue(self.build()["base_complete"])
        self.assertEqual(self.calls, [])

    def test_explicit_tool_path_reaches_probe_pack_and_cached_sprite_crop(self):
        c._video_memo.clear()
        self.build(ffmpeg_path="custom-tools")
        c.probe_video.assert_called_with(self.media, cancel=None, ffmpeg_path="custom-tools")
        self.assertEqual(c.make_sprite.call_args.kwargs["ffmpeg_path"], "custom-tools")
        c._session.clear()
        c._session_assets.clear()
        with contextlib.closing(c._connect()) as db, db:
            db.execute("DELETE FROM samples")
            db.execute("DELETE FROM assets")
        def cropped(blob, samples, **kwargs):
            self.assertEqual(kwargs["ffmpeg_path"], "custom-tools")
            return {sample["requested_ms"]: FrameResult(sample["requested_ms"], sample["actual_pts_ms"], "target", jpeg()) for sample in samples}
        with mock.patch.object(c, "_crop_sprite", side_effect=cropped):
            self.assertIsNotNone(c.get_or_extract_frames(self.media, [0], ffmpeg_path="custom-tools")[0].jpeg)

    def test_no_100_frame_cap_and_tail_count(self):
        self.video = VideoInfo(1, 260001, 0)
        c.probe_video.return_value = self.video
        manifest = self.build()
        self.assertEqual(manifest["valid_count"], 131)
        self.assertEqual([a["valid_count"] for a in manifest["assets"]], [64, 64, 3])
        self.assertTrue(all(len(batch) <= 16 and batch[-1]-batch[0] <= 30000 for batch in self.calls))
        self.assertLess(manifest["samples"][-1]["requested_ms"], self.video.duration_ms)

    def test_cancel_partial_resumes_and_preserves_existing_complete(self):
        self.build(target_interval=10000)
        original = c.base_path(self.media).read_bytes()
        cancel = threading.Event()
        def extract(path, targets, **kw):
            result = self.extract(path, targets, **kw)
            cancel.set()
            return result
        with self.assertRaises(ThumbnailCancelled):
            c.load_or_build_base(self.media, cancel=cancel, batch_extract=extract, target_interval=2000)
        self.assertEqual(c.base_path(self.media).read_bytes(), original)
        partial = c.base_path(self.media).with_name(c.base_path(self.media).name + ".partial")
        self.assertTrue(partial.is_file())
        self.calls.clear()
        manifest = self.build(target_interval=2000)
        self.assertTrue(manifest["base_complete"])
        self.assertTrue(all(t >= 32000 for batch in self.calls for t in batch))

    def test_coarse_and_partial_sprites_share_query_and_cross_session_resume(self):
        self.video = VideoInfo(1, 400000, 0)
        c.probe_video.return_value = self.video
        self.build(target_interval=10000)
        c._write_disabled.add(c.identity_key(self.media))
        cancel = threading.Event()
        def cropped(blob, samples, **kwargs):
            return {sample["requested_ms"]: FrameResult(sample["requested_ms"], sample["actual_pts_ms"], "target", jpeg(suffix=str(sample["requested_ms"]).encode())) for sample in samples}
        def progress(message):
            head = message.split()[-1].split("/")[0]
            if not head.isdigit():
                return
            if int(head) >= 64:
                cancel.set()
        with mock.patch.object(c, "_crop_sprite", side_effect=cropped):
            with self.assertRaises(ThumbnailCancelled):
                self.build(target_interval=2000, cancel=cancel, progress=progress)
        partial_path = c.base_path(self.media).with_name(c.base_path(self.media).name + ".partial")
        partial = c._load_candidate(partial_path, c.source_signature(self.media))
        self.assertFalse(partial["base_complete"])
        self.assertTrue(any(sample["requested_ms"] == 2000 for sample in partial["samples"]))
        c._session.clear()
        c._session_assets.clear()
        c._write_disabled.clear()
        view = c.sample_manifest(self.media, [0, 2000])
        self.assertTrue(view["base_complete"])
        self.assertEqual(view["target_interval"], 10000)
        self.assertEqual([sample["status"] for sample in view["samples"]], ["target", "target"])
        self.assertIsNotNone(c.lookup_frames(self.media, [2000])[0])
        for sample in view["samples"]:
            self.assertIsNotNone(c.read_asset(self.media, sample["asset"], cache_revision=view["cache_revision"]))
        self.calls.clear()
        with mock.patch.object(c, "_crop_sprite", side_effect=cropped):
            upgraded = self.build(target_interval=2000)
        self.assertTrue(upgraded["base_complete"])
        self.assertFalse(any(2000 in batch for batch in self.calls))
        self.assertIsNone(c.read_asset(self.media, view["samples"][0]["asset"], cache_revision=view["cache_revision"]))
        self.assertNotEqual(upgraded["cache_revision"], view["cache_revision"])

    def test_atomic_replace_budget_reuses_old_allocation_and_preserves_failure(self):
        manifest = self.build()
        path = c.base_path(self.media)
        blobs = {asset["id"]: c.read_asset(self.media, asset["id"]) for asset in manifest["assets"]}
        with contextlib.closing(c._connect()) as db, db:
            db.execute("DELETE FROM samples")
            db.execute("DELETE FROM assets")
        original_size = path.stat().st_size
        incoming = len(json.dumps(manifest, separators=(",", ":")).encode()) + sum(map(len, blobs.values())) + (len(blobs)+1)*200
        quota = max(original_size, incoming) + 256
        for quota_field in ("MEDIA_QUOTA_BYTES", "GLOBAL_QUOTA_BYTES"):
            with self.subTest(quota=quota_field):
                with mock.patch.object(c, quota_field, quota):
                    c._atomic_save(path, manifest, blobs, self.media)
                    last_valid = path.read_bytes()
                    with contextlib.closing(c._connect()) as db:
                        old_row = db.execute("SELECT media,size,used FROM bases WHERE path=?", (os.path.normcase(str(path.resolve())),)).fetchone()
                    with mock.patch.object(c.os, "replace", side_effect=PermissionError("busy")):
                        with self.assertRaises(PermissionError):
                            c._atomic_save(path, manifest, blobs, self.media)
                    self.assertEqual(path.read_bytes(), last_valid)
                    with contextlib.closing(c._connect()) as db:
                        self.assertEqual(db.execute("SELECT media,size,used FROM bases WHERE path=?", (os.path.normcase(str(path.resolve())),)).fetchone(), old_row)
                        self.assertEqual(db.execute("SELECT COUNT(*) FROM base_reservations").fetchone()[0], 0)

    def test_concurrent_base_reservation_cannot_spend_replace_credit_twice(self):
        manifest = self.build()
        path = c.base_path(self.media)
        with contextlib.closing(c._connect()) as db, db:
            db.execute("DELETE FROM samples")
            db.execute("DELETE FROM assets")
        old_size = path.stat().st_size
        new_size = old_size + 1000
        other = self.root / "other.mothumbs"
        admitted, release, errors = threading.Event(), threading.Event(), []
        def reserve():
            try:
                with c._base_budget(path, self.media, manifest, new_size):
                    admitted.set()
                    release.wait(3)
            except Exception as error:
                errors.append(error)
                admitted.set()
        with mock.patch.object(c, "MEDIA_QUOTA_BYTES", new_size + 256):
            thread = threading.Thread(target=reserve)
            thread.start()
            try:
                self.assertTrue(admitted.wait(2))
                self.assertEqual(errors, [])
                with self.assertRaises(OSError):
                    with c._base_budget(other, self.media, manifest, 1000):
                        self.fail("concurrent publication exceeded quota")
            finally:
                release.set()
                thread.join(3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])

    def test_cancelled_retry_preserves_sealed_partial_and_allows_added_coverage(self):
        self.video = VideoInfo(1, 400000, 0)
        c.probe_video.return_value = self.video
        def stop_after(count):
            cancel = threading.Event()
            def progress(message):
                head = message.split()[-1].split("/")[0]
                if head.isdigit() and int(head) >= count:
                    cancel.set()
            with self.assertRaises(ThumbnailCancelled):
                self.build(cancel=cancel, progress=progress)
        stop_after(64)
        path = c.base_path(self.media).with_name(c.base_path(self.media).name + ".partial")
        original = path.read_bytes()
        cancel = threading.Event()
        cancel.set()
        with self.assertRaises(ThumbnailCancelled):
            self.build(cancel=cancel)
        self.assertEqual(path.read_bytes(), original)
        self.assertEqual(c.load_base(self.media)["valid_count"], 64)
        stop_after(128)
        self.assertEqual(c.load_base(self.media)["valid_count"], 128)
        self.assertNotEqual(path.read_bytes(), original)
        # A different partial grid must not trade away the sealed earlier grid.
        existing = c.load_base(self.media)
        frame = FrameResult(250, 0, "target", jpeg())
        asset = "sprite-different-grid"
        newer = c._manifest(self.video, c.source_signature(self.media), interval=250,
            samples=[c._sample(frame, asset)], assets=[{"id":asset,"width":1280,"height":90,"valid_count":1}])
        last_valid = path.read_bytes()
        c._atomic_save(path, newer, {asset:jpeg(1280,90)}, self.media)
        self.assertEqual(path.read_bytes(), last_valid)
        self.assertEqual(c.load_base(self.media)["cache_revision"], existing["cache_revision"])

    def test_retained_partial_return_uses_only_the_persisted_sprite_layout(self):
        self.video = VideoInfo(1, 400000, 0)
        c.probe_video.return_value = self.video
        cancel = threading.Event()
        def progress(message):
            head = message.split()[-1].split("/")[0]
            if not head.isdigit():
                return
            if int(head) >= 64:
                cancel.set()
        with self.assertRaises(ThumbnailCancelled):
            self.build(cancel=cancel, progress=progress)
        retained = c.load_base(self.media)
        def unavailable(path, targets, **kwargs):
            return [FrameResult(target, None, "unavailable", None) for target in targets]
        def cropped(blob, samples, **kwargs):
            return {sample["requested_ms"]: FrameResult(sample["requested_ms"], sample["actual_pts_ms"], "target", jpeg()) for sample in samples}
        with mock.patch.object(c, "_crop_sprite", side_effect=cropped):
            partial = c.load_or_build_base(self.media, batch_extract=unavailable, target_interval=5000)
        self.assertTrue(partial["persisted"])
        self.assertFalse(partial["base_complete"])
        self.assertEqual(partial["cache_revision"], retained["cache_revision"])
        self.assertEqual(partial["valid_count"], retained["valid_count"])
        for asset in partial["assets"]:
            self.assertIsNotNone(c.read_asset(self.media, asset["id"], cache_revision=partial["cache_revision"]))

    def test_cross_session_grid_reuse_and_actual_pts_asset_dedup(self):
        c.get_or_extract_frames(self.media, [0, 250, 500], extractor=self.extract)
        first = c.sample_manifest(self.media, [0, 250, 500])
        self.assertEqual(len({s["asset"] for s in first["samples"]}), 1)
        c._session.clear()
        c._session_assets.clear()
        self.calls.clear()
        frames = c.get_or_extract_frames(self.media, [0, 500, 1000], extractor=self.extract)
        self.assertEqual(self.calls, [[1000]])
        self.assertEqual([f.requested_ms for f in frames], [0, 500, 1000])
        old_key = c.identity_key(self.media)
        self.media.write_bytes(b"new source")
        self.assertNotEqual(old_key, c.identity_key(self.media))
        self.assertEqual(c.lookup_frames(self.media, [0]), [None])

    def test_symlink_registration_matches_resolved_source_namespace(self):
        alias = self.root / "alias.mkv"
        try:
            alias.symlink_to(self.media)
        except OSError:
            self.skipTest("symlink creation is unavailable")
        expected = c.source_signature(alias)
        self.assertEqual(expected, c.source_signature(self.media))
        self.assertEqual(c.identity_key(alias), c.identity_key(self.media))
        c.register_frames(alias, self.extract(alias, [0]), info=self.video, expected_source=expected)
        self.assertIsNotNone(c.lookup_frames(self.media, [0])[0])

    def test_registration_replacement_at_entry_rejects_old_frames(self):
        expected = c.source_signature(self.media)
        frames = self.extract(self.media, [0])
        self.media.write_bytes(b"replacement")
        with self.assertRaises(ThumbnailError):
            c.register_frames(self.media, frames, info=self.video, expected_source=expected)
        self.assertEqual(c.lookup_frames(self.media, [0]), [None])

    def test_replacement_after_registration_check_keeps_old_namespace(self):
        expected = c.source_signature(self.media)
        frames = self.extract(self.media, [0])
        source_key = c._source_key
        changed = [False]
        def key(path, signature=None):
            if signature is not None and not changed[0]:
                changed[0] = True
                self.media.write_bytes(b"replacement")
            return source_key(path, signature)
        with mock.patch.object(c, "_source_key", side_effect=key):
            c.register_frames(self.media, frames, info=self.video, expected_source=expected)
        self.assertEqual(c.lookup_frames(self.media, [0]), [None])

    def test_source_replaced_while_extraction_rejects_registration(self):
        def changed(path, targets, **kw):
            result = self.extract(path, targets, **kw)
            self.media.write_bytes(b"replacement")
            return result
        with self.assertRaises(ThumbnailError):
            c.get_or_extract_frames(self.media, [0], extractor=changed)
        self.assertEqual(c.lookup_frames(self.media, [0]), [None])
        with self.assertRaises(ThumbnailError):
            c.load_or_build_base(self.media, batch_extract=changed)
        self.assertIsNone(c.load_base(self.media))

    def test_disk_failure_reports_once_and_session_stays_usable(self):
        output = io.StringIO()
        with mock.patch.object(c, "_connect", side_effect=OSError("read only")), contextlib.redirect_stdout(output):
            c.get_or_extract_frames(self.media, [0, 1000], extractor=self.extract)
            c.get_or_extract_frames(self.media, [2000], extractor=self.extract)
            self.calls.clear()
            frames = c.get_or_extract_frames(self.media, [0, 1000], extractor=self.extract)
        self.assertEqual(output.getvalue().count("could not be persisted"), 1)
        self.assertEqual(self.calls, [])
        self.assertTrue(all(frame.jpeg for frame in frames))
        self.assertFalse(c.sample_manifest(self.media, [0])["persisted"])

    def test_quota_protects_current_asset_and_does_not_reextract(self):
        first = c.get_or_extract_frames(self.media, [0], extractor=self.extract)[0]
        c.protect_assets(self.media, [c._asset_id(first.jpeg)])
        with mock.patch.object(c, "MEDIA_QUOTA_BYTES", len(first.jpeg)+1):
            c.get_or_extract_frames(self.media, [2000], extractor=self.extract)
        c._session.clear()
        c._session_assets.clear()
        self.calls.clear()
        self.assertIsNotNone(c.get_or_extract_frames(self.media, [0], extractor=self.extract)[0].jpeg)
        self.assertEqual(self.calls, [])

    def rewrite(self, manifest, *, remove=None):
        path = c.base_path(self.media)
        with zipfile.ZipFile(path) as old:
            blobs = {name: old.read(name) for name in old.namelist() if name != "manifest.json" and name != remove}
        with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as output:
            output.writestr("manifest.json", json.dumps(manifest))
            for name, blob in blobs.items():
                output.writestr(name, blob)
        c._base_memo.clear()

    def test_unknown_version_missing_assets_and_false_complete_are_misses(self):
        for kind in ("version", "asset", "complete"):
            with self.subTest(kind=kind):
                manifest = self.build()
                if kind == "version":
                    manifest["generator_version"] = 999
                    self.rewrite(manifest)
                elif kind == "asset":
                    self.rewrite(manifest, remove="assets/"+manifest["assets"][0]["id"]+".jpg")
                else:
                    manifest["samples"].pop()
                    manifest["valid_count"] -= 1
                    manifest["assets"][0]["valid_count"] -= 1
                    self.rewrite(manifest)
                self.assertIsNone(c.load_base(self.media))

    def test_manifest_file_budget_and_crc_corruption(self):
        self.build()
        with mock.patch.object(c, "MAX_SIDECAR_BYTES", 1):
            self.assertIsNone(c.load_base(self.media))
        path = c.base_path(self.media)
        data = bytearray(path.read_bytes())
        index = data.index(b"\xff\xd8")
        data[index+1] ^= 1
        path.write_bytes(data)
        c._base_memo.clear()
        self.assertIsNone(c.load_base(self.media))

    def test_atomic_windows_replace_retry_and_old_file_preservation(self):
        with mock.patch.object(c.zipfile.time, "localtime", return_value=(2020, 1, 1, 0, 0, 0, 2, 1, -1)):
            manifest = self.build()
        original = c.base_path(self.media).read_bytes()
        asset = manifest["assets"][0]["id"]
        blobs = {asset: c.read_asset(self.media, asset)}
        real = os.replace
        calls = []
        def replace(source, target):
            calls.append(1)
            if len(calls) < 3:
                raise PermissionError("busy")
            real(source, target)
        with mock.patch.object(c.zipfile.time, "localtime", return_value=(2020, 1, 1, 0, 0, 2, 2, 1, -1)), mock.patch.object(c.os, "replace", side_effect=replace):
            c._atomic_save(c.base_path(self.media), manifest, blobs, self.media)
        self.assertEqual(len(calls), 3)
        # ZIP timestamps may change after a successful retry. A later failure
        # must preserve that latest successful publication byte for byte.
        last_valid = c.base_path(self.media).read_bytes()
        self.assertNotEqual(last_valid, original)
        with mock.patch.object(c.os, "replace", side_effect=PermissionError("busy")):
            with self.assertRaises(PermissionError):
                c._atomic_save(c.base_path(self.media), manifest, blobs, self.media)
        self.assertEqual(c.base_path(self.media).read_bytes(), last_valid)

    def test_output_candidates_and_bounded_nearby_preview(self):
        self.build()
        target = self.root / "_maw" / "video.mkv.mothumbs"
        target.parent.mkdir()
        c.base_path(self.media).replace(target)
        c._base_memo.clear()
        self.assertIsNotNone(c.load_base(self.media))
        c._session.clear()
        c._session_assets.clear()
        view = c.sample_manifest(self.media, [1000], nearby_ms=500)
        self.assertEqual(view["samples"], [])

    def test_deadline_does_not_mark_partial_complete_or_restart_failed_targets(self):
        with self.assertRaises(ThumbnailError):
            self.build(timeout_s=-1)
        self.assertFalse(c.load_base(self.media)["base_complete"])
        def unavailable(path, targets, **kw):
            self.calls.append(list(targets))
            return [FrameResult(t, None, "unavailable", None) for t in targets]
        c.get_or_extract_frames(self.media, [0], extractor=unavailable)
        c.get_or_extract_frames(self.media, [0], extractor=unavailable)
        self.assertEqual(len(self.calls), 1)


if __name__ == "__main__":
    unittest.main()
