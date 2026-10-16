from __future__ import annotations

import json
import re
import shutil
import subprocess
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path
from unittest import mock

from maw.media_export_video import VideoCopyPlan, VideoTimelineError, verify_video_packets

ROOT = Path(__file__).resolve().parents[1]
TEMP_ROOT = ROOT / ".artifacts" / "embedded-subtitle-tests"
FFMPEG, FFPROBE = shutil.which("ffmpeg"), shutil.which("ffprobe")


class SubtitleDurationVerificationTests(unittest.TestCase):
    def test_original_duration_on_a_shortened_subtitle_is_rejected(self):
        TEMP_ROOT.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as temporary:
            directory = Path(temporary)
            index = directory / "source-packets.txt"
            index.write_text("stream_index=0|pts_time=0|dts_time=0|duration_time=11|flags=K\n")
            windows = [[(Decimal(0), Decimal(4), Decimal(0)), (Decimal(8), Decimal(12), Decimal(4))]]
            plan = VideoCopyPlan({}, windows, index, [None])
            def scan(_source, destination, *_args):
                destination.write_text("stream_index=0|pts_time=0|dts_time=0|duration_time=11|flags=K\n")
            with mock.patch("maw.media_export_video.scan_packets", side_effect=scan), self.assertRaisesRegex(
                    VideoTimelineError, "包时间线不符合"):
                verify_video_packets(plan, directory / "output.mp4", ["subtitle"], directory, None, None)

    def test_missing_output_duration_or_pts_does_not_count_as_verified(self):
        TEMP_ROOT.mkdir(parents=True, exist_ok=True)
        for output_fields, expected_error in (("pts_time=0|dts_time=0|duration_time=N/A", "持续时间"),
                                               ("pts_time=N/A|dts_time=0|duration_time=4", "显示时间")):
            with self.subTest(fields=output_fields), tempfile.TemporaryDirectory(dir=TEMP_ROOT) as temporary:
                directory = Path(temporary)
                index = directory / "source-packets.txt"
                index.write_text("stream_index=0|pts_time=0|dts_time=0|duration_time=4|flags=K\n")
                plan = VideoCopyPlan({}, [[(Decimal(0), Decimal(4), Decimal(0))]], index, [None])
                def scan(_source, destination, *_args):
                    destination.write_text(f"stream_index=0|{output_fields}|flags=K\n")
                with mock.patch("maw.media_export_video.scan_packets", side_effect=scan), self.assertRaisesRegex(
                        VideoTimelineError, expected_error):
                    verify_video_packets(plan, directory / "output.mp4", ["subtitle"], directory, None, None)


@unittest.skipUnless(FFMPEG and FFPROBE, "FFmpeg tools unavailable")
class EmbeddedSubtitleTimelineTests(unittest.TestCase):
    def setUp(self):
        from tests.test_local_editor_server import server_editor
        self.server = server_editor
        TEMP_ROOT.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=TEMP_ROOT)
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.video = self.directory / "video.mp4"
        self.run_tool([FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=96x64:rate=10:duration=12",
                       "-c:v", "libx264", "-g", "10", "-keyint_min", "10", "-sc_threshold", "0", "-bf", "0", str(self.video)])

    def run_tool(self, command):
        result = subprocess.run(command, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr[-2000:])
        return result

    def export(self, start, end, text):
        subtitle = self.directory / "input.srt"
        subtitle.write_text(f"1\n{start} --> {end}\n{text}\n", encoding="utf-8")
        source, output = self.directory / "source.mp4", self.directory / "output.mp4"
        self.run_tool([FFMPEG, "-y", "-v", "error", "-i", str(self.video), "-i", str(subtitle),
                       "-map", "0:v", "-map", "1:s", "-c:v", "copy", "-c:s", "mov_text", str(source)])
        self.server.rebuild_gap_removed_video(source, [(0, 2000), (4000, 6000), (8000, 10000)], output,
                                              ffmpeg_path=Path(FFMPEG), ffprobe_path=Path(FFPROBE))
        probe = json.loads(self.run_tool([FFPROBE, "-v", "error", "-show_entries",
                                         "format=duration:stream=codec_type,duration", "-of", "json", str(output)]).stdout)
        self.assertAlmostEqual(float(probe["format"]["duration"]), 6, places=3)
        self.assertEqual([stream["codec_type"] for stream in probe["streams"]], ["video", "subtitle"])
        for stream in probe["streams"]:
            if "duration" in stream:
                self.assertLessEqual(float(stream["duration"]), 6.001)
        decoded = self.run_tool([FFMPEG, "-v", "error", "-i", str(output), "-map", "0:s", "-f", "srt", "-"]).stdout
        return re.findall(r"(\d\d:\d\d:\d\d,\d\d\d) --> (\d\d:\d\d:\d\d,\d\d\d)\n([^\n]+)", decoded)

    def test_caption_spanning_multiple_removed_gaps_is_shortened_to_output_union(self):
        self.assertEqual(self.export("00:00:00,000", "00:00:11,000", "Across two gaps"),
                         [("00:00:00,000", "00:00:06,000", "Across two gaps")])

    def test_caption_starting_inside_removed_gap_keeps_its_retained_tail(self):
        self.assertEqual(self.export("00:00:03,000", "00:00:05,000", "Retained tail"),
                         [("00:00:02,000", "00:00:03,000", "Retained tail")])

    def test_wholly_removed_caption_does_not_reappear_or_remove_the_subtitle_track(self):
        self.assertEqual(self.export("00:00:03,000", "00:00:03,500", "Deleted caption"), [])

    def test_partial_leading_and_trailing_caption_ranges_keep_exact_duration(self):
        self.assertEqual(self.export("00:00:00,500", "00:00:09,500", "Partial edges"),
                         [("00:00:00,500", "00:00:05,500", "Partial edges")])
