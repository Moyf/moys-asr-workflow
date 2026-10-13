from __future__ import annotations

import contextlib
import io
import json
import os
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
        for collection in (c._video_memo, c._base_memo, c._session, c._session_assets, c._write_disabled, c._session_bases, c._session_pins):
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
        with mock.patch.object(c.os, "replace", side_effect=replace):
            c._atomic_save(c.base_path(self.media), manifest, blobs, self.media)
        self.assertEqual(len(calls), 3)
        with mock.patch.object(c.os, "replace", side_effect=PermissionError("busy")):
            with self.assertRaises(PermissionError):
                c._atomic_save(c.base_path(self.media), manifest, blobs, self.media)
        self.assertEqual(c.base_path(self.media).read_bytes(), original)

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
