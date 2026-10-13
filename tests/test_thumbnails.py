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
            payload = {"frames": [{"best_effort_timestamp_time": "0"}]}
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


if __name__ == "__main__":
    unittest.main()
