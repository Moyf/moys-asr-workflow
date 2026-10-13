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

    def test_audio_and_attached_picture_are_skipped(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "input.wav"
            path.write_bytes(b"test")
            payload = {"streams": [{"index": 0, "codec_type": "audio"}, {"index": 1, "codec_type": "video", "disposition": {"attached_pic": 1}}]}
            with mock.patch.object(t, "resolve_ffmpeg_tool", return_value=Path("ffprobe")), mock.patch.object(t, "_run", return_value=subprocess.CompletedProcess([], 0, json.dumps(payload).encode(), b"")):
                self.assertIsNone(t.probe_video(path))

    def test_child_cancel_and_timeout_reap_process(self):
        cancel = threading.Event()
        timer = threading.Timer(0.15, cancel.set)
        timer.start()
        begin = time.monotonic()
        with self.assertRaises(t.ThumbnailCancelled):
            t._run([sys.executable, "-c", "import time; time.sleep(30)"], timeout_s=2, cancel=cancel)
        timer.join()
        self.assertLess(time.monotonic()-begin, 1)
        with self.assertRaises(t.ThumbnailError):
            t._run([sys.executable, "-c", "import time; time.sleep(30)"], timeout_s=0.1)

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
