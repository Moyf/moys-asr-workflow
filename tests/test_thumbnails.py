from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from maw import thumbnails as t


class ThumbnailTests(unittest.TestCase):
    def test_base_intervals_and_bounded_deduplicated_batches(self):
        self.assertEqual([t.base_interval_ms(d) for d in (600000, 600001, 3600000, 3600001)], [2000, 5000, 5000, 10000])
        groups = t.batches([1000, 0, 1000, *range(2000, 50000, 250)])
        self.assertTrue(all(len(group) <= 16 and group[-1]-group[0] <= t.MAX_BATCH_SPAN_MS for group in groups))
        self.assertEqual(len([v for g in groups for v in g]), len(set([1000, 0, *range(2000, 50000, 250)])))

    def test_tool_override_selects_ffprobe_peer_and_sprite_encoder(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "source.mkv"
            path.write_bytes(b"source")
            payload = {"streams": []}
            with mock.patch.object(t, "resolve_ffmpeg_tool", return_value=Path("tool")) as resolve, mock.patch.object(t, "_run", return_value=subprocess.CompletedProcess([], 0, json.dumps(payload).encode(), b"")):
                t.probe_video(path, ffmpeg_path="custom-tools")
                resolve.assert_called_with("ffprobe", "custom-tools")
            video = t.VideoInfo(0, 1000, 0)
            payload = {"packets": [{"pts_time": "0"}]}
            with mock.patch.object(t, "resolve_ffmpeg_tool", return_value=Path("tool")) as resolve, mock.patch.object(t, "_run", return_value=subprocess.CompletedProcess([], 0, json.dumps(payload).encode(), b"")):
                self.assertEqual(t._frame_times(path, video, [0], timeout_s=1, cancel=None, ffmpeg_path="custom-tools"), [0])
                resolve.assert_called_with("ffprobe", "custom-tools")
            def fake_run(command, **kwargs):
                Path(command[-1]).write_bytes(b"jpeg")
                return subprocess.CompletedProcess([], 0, b"", b"")
            with mock.patch.object(t, "resolve_ffmpeg_tool", return_value=Path("tool")) as resolve, mock.patch.object(t, "_run", side_effect=fake_run):
                self.assertEqual(t.make_sprite([b"jpeg"], ffmpeg_path="custom-tools"), b"jpeg")
                resolve.assert_called_with("ffmpeg", "custom-tools")

    def test_audio_and_attached_picture_are_skipped(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "input.wav"
            path.write_bytes(b"test")
            payload = {"streams": [{"index": 0, "codec_type": "audio"}, {"index": 1, "codec_type": "video", "disposition": {"attached_pic": 1}}]}
            with mock.patch.object(t, "resolve_ffmpeg_tool", return_value=Path("ffprobe")), mock.patch.object(t, "_run", return_value=subprocess.CompletedProcess([], 0, json.dumps(payload).encode(), b"")):
                self.assertIsNone(t.probe_video(path))

    def test_truncated_probe_json_is_retried_once(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "video.mkv"
            path.write_bytes(b"video")
            good = json.dumps({"streams": [{"index": 0, "codec_type": "video", "duration": "1"}], "format": {"duration": "1"}}).encode()
            responses = [subprocess.CompletedProcess([], 0, good[:len(good)//2], b""), subprocess.CompletedProcess([], 0, good, b"")]
            with mock.patch.object(t, "resolve_ffmpeg_tool", return_value=Path("ffprobe")), mock.patch.object(t, "_run", side_effect=responses) as run:
                info = t.probe_video(path)
            self.assertEqual(info.duration_ms, 1000)
            self.assertEqual(run.call_count, 2)

    def test_repeatedly_truncated_probe_json_reports_probe_failure(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "video.mkv"
            path.write_bytes(b"video")
            with mock.patch.object(t, "resolve_ffmpeg_tool", return_value=Path("ffprobe")), mock.patch.object(t, "_run", return_value=subprocess.CompletedProcess([], 0, b"{truncated", b"")):
                with self.assertRaises(t.ThumbnailError):
                    t.probe_video(path)

    def test_keyframe_scan_does_not_start_another_chunk_after_deadline(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "long.mp4"
            source.write_bytes(b"source")
            with mock.patch.object(t, "resolve_ffmpeg_tool", return_value=Path("ffmpeg")), \
                 mock.patch.object(t.time, "monotonic", return_value=100) as clock:
                def scan(*args, **kwargs):
                    clock.return_value = 102
                    return [0.0], [0.0]

                with mock.patch.object(t, "_packet_times", side_effect=scan) as packets, \
                     mock.patch.object(t, "_run") as decode:
                    with self.assertRaisesRegex(t.ThumbnailError, "timed out"):
                        t.extract_keyframes(source, info=t.VideoInfo(0, 900_000, 0), timeout_s=1)
                self.assertEqual(packets.call_count, 1)
                decode.assert_not_called()

    def test_child_cancel_and_timeout_reap_process(self):
        with tempfile.TemporaryDirectory() as temp:
            ready = Path(temp) / "ready"
            cancel = threading.Event()
            cancelled_at = []
            processes = []
            readiness_errors = []
            real_spawn = t.subprocess.Popen
            def request_cancel():
                deadline = time.monotonic() + 8
                while not ready.exists():
                    if time.monotonic() >= deadline or processes[0].poll() is not None:
                        readiness_errors.append("child did not reach its running state")
                        break
                    time.sleep(.01)
                cancelled_at.append(time.monotonic())
                cancel.set()
            watcher = threading.Thread(target=request_cancel)
            def spawn(*args, **kwargs):
                process = real_spawn(*args, **kwargs)
                processes.append(process)
                if len(processes) == 1:
                    # Windows may still be loading the image after Popen returns.
                    # Exercise cancellation of running work, not cold loader teardown.
                    watcher.start()
                return process
            script = f"from pathlib import Path; import time; Path({str(ready)!r}).write_text('ready'); time.sleep(30)"
            with mock.patch.object(t.subprocess, "Popen", side_effect=spawn):
                try:
                    with self.assertRaises(t.ThumbnailCancelled):
                        t._run([sys.executable, "-c", script], timeout_s=10, cancel=cancel)
                    finished = time.monotonic()
                finally:
                    cancel.set()
                    if watcher.ident is not None:
                        watcher.join(10)
                self.assertFalse(watcher.is_alive())
                self.assertEqual(readiness_errors, [])
                self.assertLess(finished-cancelled_at[0], 1)
                self.assertIsNotNone(processes[0].poll())
                with self.assertRaises(t.ThumbnailError):
                    t._run([sys.executable, "-c", "import time; time.sleep(30)"], timeout_s=0.1)
                self.assertIsNotNone(processes[1].poll())

    def test_large_child_output_cannot_fill_pipe(self):
        result = t._run([sys.executable, "-c", "import sys; sys.stderr.write('a'*1000000); print('done')"], timeout_s=5)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(len(result.stderr), 8192)


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg required")
class ThumbnailIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def video(self, name="video.mkv", *, rate="2", duration="4", filters=None, size="320x180"):
        path = self.root / name
        command = ["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", f"testsrc2=size={size}:rate={rate}:duration={duration}"]
        if filters:
            command += ["-vf", filters, "-fps_mode", "passthrough"]
        subprocess.run([*command, "-c:v", "libx264", "-g", "120", "-threads", "2", "-y", str(path)], check=True, capture_output=True, timeout=15)
        return path

    def test_low_fps_tail_and_duplicate_targets_share_real_frame(self):
        path = self.video(rate="1/2", duration="6")
        info = t.probe_video(path)
        self.assertEqual(info.duration_ms, 6000)
        frames = t.extract_frames(path, [0, 250, 1500, 2500, 5500, 5999, 250], info=info)
        self.assertEqual([f.actual_pts_ms for f in frames], [0, 0, 0, 2000, 4000, 4000, 0])
        self.assertTrue(all(f.status == "target" and f.jpeg.startswith(b"\xff\xd8") for f in frames))
        self.assertEqual(frames[0].jpeg, frames[1].jpeg)
        with self.assertRaises(ValueError):
            t.extract_frames(path, [info.duration_ms], info=info)

    def test_source_format_clock_preserves_delayed_video_and_empty_head(self):
        path = self.root / "offset.mp4"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=5", "-itsoffset", "2", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=10:duration=3", "-map", "1:v:0", "-map", "0:a:0", "-c:v", "libx264", "-g", "30", "-threads", "2", "-fps_mode", "passthrough", "-c:a", "aac", "-y", str(path)], check=True, capture_output=True, timeout=15)
        info = t.probe_video(path)
        self.assertEqual((info.start_ms, info.video_start_ms, info.duration_ms), (0, 2000, 5000))
        frames = t.extract_frames(path, [0, 1000, 2500, 4999], info=info)
        self.assertEqual([frame.status for frame in frames], ["unavailable", "unavailable", "target", "target"])
        self.assertEqual([frame.actual_pts_ms for frame in frames], [None, None, 2500, 4900])
        # A simple source-clock override is an independent oracle for the JPEG,
        # so relabelling a mistakenly selected4.5s frame as2.5s cannot pass.
        oracle = t.extract_frames(path, [2500], info=t.VideoInfo(info.stream_index, 5000, 0))[0]
        self.assertEqual(frames[2].jpeg, oracle.jpeg)
        with tempfile.TemporaryDirectory() as cache_dir:
            from maw import thumbnail_cache as cache
            directory = Path(cache_dir)
            with mock.patch.object(cache, "cache_root", return_value=directory / "app"), mock.patch.object(cache, "waveform_dirs", return_value=[directory]):
                manifest = cache.load_or_build_base(path)
                self.assertTrue(manifest["base_complete"])
                self.assertEqual(manifest["valid_count"], 2)
                self.assertEqual([sample["status"] for sample in manifest["samples"]], ["unavailable", "target", "target"])
                self.assertEqual(cache.load_base(path)["time_origin"], "source-format-start-ms")
                self.assertEqual(cache.lookup_frames(path, [0])[0].status, "unavailable")
                self.assertEqual(cache.sample_manifest(path, [500])["samples"][0]["asset"], None)
                self.assertEqual(cache.sample_manifest(path, [500])["samples"][0]["status"], "unavailable")

    def test_nonzero_start_pts_is_normalized(self):
        path = self.video(filters="setpts=PTS+5/TB")
        info = t.probe_video(path)
        self.assertEqual(info.start_ms, 5000)
        self.assertEqual(info.duration_ms, 4000)
        frames = t.extract_frames(path, [0, 750, 3999], info=info)
        self.assertEqual([f.actual_pts_ms for f in frames], [0, 500, 3500])

    def test_vfr_and_high_fps_tail_do_not_use_nominal_fps_or_frame_cap(self):
        path = self.video(rate="60", duration="8")
        frames = t.extract_frames(path, [0, 7000, 7999])
        self.assertGreaterEqual(frames[-1].actual_pts_ms, 7980)
        variable = self.video(name="vfr.mkv", rate="10", duration="4", filters="select='eq(n,0)+eq(n,2)+eq(n,10)+eq(n,19)+eq(n,30)+eq(n,39)'")
        frames = t.extract_frames(variable, [500, 1500, 2500, 3999])
        self.assertEqual([f.actual_pts_ms for f in frames], [200, 1000, 1900, 3900])

    def test_sar_portrait_and_sprite_dimensions(self):
        from maw.thumbnail_cache import _jpeg_dimensions
        path = self.video(rate="1", duration="2", size="180x320", filters="setsar=2")
        frames = t.extract_frames(path, [0, 1000])
        self.assertEqual(_jpeg_dimensions(frames[0].jpeg), (160, 90))
        jpeg = t.make_sprite([frame.jpeg for frame in frames])
        self.assertEqual(_jpeg_dimensions(jpeg), (1280, 90))

    def test_keyframe_only_extraction_stamps_real_keyframe_pts(self):
        path = self.root / "keyframes.mp4"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi",
                        "-i", "testsrc2=size=320x180:rate=2:duration=4", "-c:v", "libx264",
                        "-g", "2", "-threads", "2", "-y", str(path)], check=True, capture_output=True, timeout=15)
        video = t.probe_video(path)
        scanned = t._packet_times(path, video, 0.0, video.duration_ms / 1000, timeout_s=30, cancel=None)[1]
        frames = t.extract_keyframes(path, info=video)
        self.assertEqual([f.requested_ms for f in frames], [round(value * 1000) for value in scanned])
        self.assertTrue(frames and frames[0].requested_ms == 0)
        self.assertTrue(all(f.status == "preview" and f.actual_pts_ms == f.requested_ms and f.jpeg.startswith(b"\xff\xd8") for f in frames))
        from maw.thumbnail_cache import _jpeg_dimensions
        self.assertEqual(_jpeg_dimensions(frames[1].jpeg), (160, 90))

    def test_keyframe_extraction_decimates_dense_sources_during_planning(self):
        path = self.root / "dense.mp4"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi",
                        "-i", "testsrc2=size=320x180:rate=24:duration=2", "-c:v", "libx264",
                        "-g", "1", "-threads", "2", "-y", str(path)], check=True, capture_output=True, timeout=15)
        video = t.probe_video(path)
        scanned = set()
        for _pass in range(2):
            scanned.update(t._packet_times(path, video, 0.0, video.duration_ms / 1000, timeout_s=30, cancel=None)[1])
        scanned = sorted(scanned)
        frames = t.extract_keyframes(path, info=video, max_cells=10)
        stride = -(-len(scanned) // 10)
        expected = [round(value * 1000) for value in scanned[::stride]]
        self.assertEqual([frame.requested_ms for frame in frames], expected,
            "decimation is decided during planning from the packet scan")
        self.assertLessEqual(len(frames), 10)
        self.assertEqual(frames[0].requested_ms, 0)

    def test_keyframe_stage_yields_to_visible_demand(self):
        import os
        path = self.root / "yield.mp4"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi",
                        "-i", "testsrc2=size=320x180:rate=2:duration=4", "-c:v", "libx264",
                        "-g", "2", "-threads", "2", "-y", str(path)], check=True, capture_output=True, timeout=15)
        from maw.thumbnail_jobs import ThumbnailCoordinator, build_base, source_key
        with tempfile.TemporaryDirectory() as cache_dir:
            directory = Path(cache_dir)
            with mock.patch.dict(os.environ, {"MAW_APP_DATA_ROOT": str(directory / "app")}):
                coordinator = ThumbnailCoordinator(Path(directory) / "jobs.sqlite3")
                coordinator.lease("blocker", source_key(path), visible=True)
                messages = []
                manifest = build_base(path, coordinator=coordinator, exact=False,
                    timeout_s=1.5, progress=messages.append)
                self.assertEqual(manifest["keyframe_count"], 0,
                    "a visible demand blocks the keyframe pass instead of competing")
                self.assertTrue(any("关键帧底图" in message for message in messages))
                coordinator.release("blocker")
                manifest = build_base(path, coordinator=coordinator, exact=False, progress=messages.append)
                self.assertEqual(manifest["tier"], "keyframes")
                self.assertGreater(manifest["keyframe_count"], 0, "released demand lets the pass finish")

    def test_keyframe_base_registers_previews_and_upgrades_to_exact(self):
        import os
        path = self.root / "tiered.mp4"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi",
                        "-i", "testsrc2=size=320x180:rate=2:duration=4", "-c:v", "libx264",
                        "-g", "3", "-threads", "2", "-y", str(path)], check=True, capture_output=True, timeout=15)
        from maw import thumbnail_cache as cache
        with tempfile.TemporaryDirectory() as cache_dir:
            directory = Path(cache_dir)
            with mock.patch.dict(os.environ, {"MAW_APP_DATA_ROOT": str(directory / "app")}), \
                 mock.patch.object(cache, "cache_root", return_value=directory / "app"), \
                 mock.patch.object(cache, "waveform_dirs", return_value=[directory]):
                video = t.probe_video(path)
                scanned = t._packet_times(path, video, 0.0, video.duration_ms / 1000, timeout_s=30, cancel=None)[1]
                manifest = cache.load_or_build_base(path, exact=False)
                self.assertEqual(manifest["tier"], "keyframes")
                self.assertEqual(manifest["keyframe_count"], len(scanned),
                    "the landmark tier stores one cell per keyframe at its own PTS")
                self.assertTrue(cache.has_cached_frames(path))
                served = cache.sample_manifest(path, [0, 2000])
                by_target = {sample["requested_ms"]: sample for sample in served["samples"]}
                self.assertEqual(by_target[0]["status"], "preview")
                self.assertEqual(by_target[2000]["status"], "preview")
                covering = [round(value * 1000) for value in scanned if value * 1000 <= 2000.001][-1]
                self.assertEqual(by_target[2000]["actual_pts_ms"], covering, "cell 2s holds its covering keyframe")
                markers = served["keyframes"]
                window = [round(value * 1000) for value in scanned if value * 1000 <= 2000]
                self.assertEqual([marker["requested_ms"] for marker in markers], window,
                    "markers cover the requested span, not beyond it")
                # The exact stage upgrades grid cells to precise frames.
                frames = t.extract_frames(path, [0, 2000], info=video)
                cache.register_frames(path, frames, info=video)
                refined = cache.sample_manifest(path, [0, 2000])
                by_refined = {sample["requested_ms"]: sample for sample in refined["samples"]}
                self.assertEqual(by_refined[2000]["status"], "target")
                self.assertEqual(by_refined[2000]["actual_pts_ms"], 2000)
                marker_assets = {marker["asset"] for marker in served["keyframes"]}
                self.assertTrue(marker_assets <= {a["id"] for a in served["assets"]},
                    "every marker image is declared in the response assets")
                held = cache.sample_manifest(path, [2500, 2800])
                self.assertEqual([sample["actual_pts_ms"] for sample in held["samples"]], [2000, 2000],
                    "a landmark-free span still holds the nearest preceding landmark")
                self.assertEqual([marker["requested_ms"] for marker in refined["keyframes"]], window,
                    "landmarks survive exact refinement")


if __name__ == "__main__":
    unittest.main()
