from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path
from unittest import mock

from maw.media_export_video import VideoTimelineError, packet_filter, prepare_video_copy

TEMP_ROOT = Path(__file__).resolve().parents[1] / ".artifacts" / "video-timeline-tests"


class VideoCopyPlanTests(unittest.TestCase):
    def test_expansion_merges_overlap_and_reports_union_delta_with_nonzero_origin(self):
        TEMP_ROOT.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as temporary:
            root = Path(temporary)
            rows = [f"stream_index=0|pts_time={5 + i}|dts_time={5 + i}|duration_time=1|flags={'K' if i % 4 == 0 else '_'}"
                    for i in range(12)]
            def scan(_source, destination, *_args):
                destination.write_text("\n".join(rows), encoding="utf-8")
            with mock.patch("maw.media_export_video.scan_packets", side_effect=scan):
                plan = prepare_video_copy(root / "source.mp4", [(500, 2500), (3000, 5000), (8500, 9500)],
                                          ["video"], Decimal(5), root, None, None)
            self.assertEqual(plan.timeline["intervals"], [
                {"sourceStartMs": 0, "sourceEndMs": 12000, "outputStartMs": 0, "outputEndMs": 12000}])
            self.assertEqual(plan.timeline["keyframeExpansionMs"], 7000)
            self.assertTrue(plan.timeline["noGapsRemoved"])
            json.dumps(plan.timeline)  # Ready/status responses must remain JSON-safe.
            with mock.patch("maw.media_export_video.scan_packets", side_effect=scan):
                unchanged = prepare_video_copy(root / "source.mp4", [(0, 12000)],
                                               ["video"], Decimal(5), root, None, None)
            self.assertEqual(unchanged.timeline["keyframeExpansionMs"], 0)
            self.assertFalse(unchanged.timeline["noGapsRemoved"])

    def test_zero_expansion_and_balanced_expression_size(self):
        windows = [(Decimal(i * 2), Decimal(i * 2 + 1), Decimal(i)) for i in range(1024)]
        expression = packet_filter(windows, True)
        self.assertLess(len(expression), 400_000)
        # Left/right subtrees split evenly, avoiding linear per-packet scans.
        self.assertLess(expression.count('if('), 8 * len(windows))

    def test_variable_leading_duration_without_dts_is_rejected_instead_of_self_validating(self):
        TEMP_ROOT.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as temporary:
            root = Path(temporary)
            def scan(_source, destination, *_args):
                destination.write_text("stream_index=0|pts_time=5|duration_time=0.04|flags=K\n"
                                       "stream_index=0|pts_time=5.16|duration_time=0.08|flags=_\n"
                                       "stream_index=0|pts_time=5.08|dts_time=5|duration_time=0.04|flags=_\n")
            with mock.patch("maw.media_export_video.scan_packets", side_effect=scan), self.assertRaisesRegex(
                    VideoTimelineError, "帧时长不一致"):
                prepare_video_copy(root / "source.mkv", [(0, 100)], ["video"], Decimal(5), root, None, None)


FFMPEG, FFPROBE = shutil.which("ffmpeg"), shutil.which("ffprobe")


@unittest.skipUnless(FFMPEG and FFPROBE, "FFmpeg tools unavailable")
class RealVideoTimelineTests(unittest.TestCase):
    def setUp(self):
        from tests.test_local_editor_server import server_editor
        self.server = server_editor
        TEMP_ROOT.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=TEMP_ROOT)
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def run_tool(self, arguments):
        result = subprocess.run(arguments, capture_output=True, text=True, timeout=45)
        if result.returncode and "Unknown encoder" in result.stderr:
            self.skipTest("Required synthetic encoder unavailable")
        self.assertEqual(result.returncode, 0, result.stderr[-2000:])
        return result

    def generate(self, extension=".mp4", *, mixed=False, offset=0, open_gop=False, hevc_only=False,
                 intra_refresh=False, b_frames=3):
        source = self.root / ("source" + extension)
        command = [FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=96x64:rate=25",
                   "-f", "lavfi", "-i", "sine=frequency=400:sample_rate=48000", "-f", "lavfi", "-i",
                   "sine=frequency=800:sample_rate=48000", "-t", "12", "-map", "0:v"]
        if mixed:
            command += ["-map", "0:v"]
        command += ["-map", "1:a", "-map", "2:a", "-c:v:0", "libx265" if hevc_only else "libx264", "-g", "100", "-keyint_min", "100",
                    "-sc_threshold", "0", "-bf", str(b_frames)]
        if open_gop and not hevc_only:
            command += ["-x264-params", "open-gop=1" + (":b-pyramid=none" if b_frames == 1 else "")]
        if hevc_only:
            command += ["-tag:v:0", "hvc1", "-x265-params",
                        "keyint=100:min-keyint=100:scenecut=0:open-gop=1:log-level=error:pools=1"]
        if intra_refresh:
            command += ["-x264-params", "intra-refresh=1:keyint=100:min-keyint=100:ref=1:bframes=0:scenecut=0"]
        if mixed:
            command += ["-c:v:1", "libx265", "-tag:v:1", "hvc1", "-x265-params",
                        "keyint=100:min-keyint=100:scenecut=0:open-gop=0:log-level=error:pools=1"]
        command += ["-c:a", "aac", "-metadata:s:a:0", "language=eng", "-metadata:s:a:1", "language=deu",
                    "-disposition:a:0", "0", "-disposition:a:1", "default", "-output_ts_offset", str(offset), str(source)]
        self.run_tool(command)
        return source

    def frames(self, path, stream):
        result = self.run_tool([FFMPEG, "-v", "error", "-xerror", "-i", str(path), "-map", f"0:v:{stream}",
                                "-fps_mode", "passthrough", "-f", "framemd5", "-"])
        return [line.rsplit(",", 1)[-1].strip() for line in result.stdout.splitlines() if line and not line.startswith("#")]

    def rebuild(self, source, *, intervals=None):
        output = self.root / ("result" + source.suffix)
        timelines = []
        original = self.server.prepare_video_copy
        def capture(*args, **kwargs):
            plan = original(*args, **kwargs)
            timelines.append(plan.timeline)
            return plan
        with mock.patch.object(self.server, "prepare_video_copy", side_effect=capture):
            self.server.rebuild_gap_removed_video(source, intervals or [(1000, 2000), (8500, 9500)], output,
                                                  ffmpeg_path=Path(FFMPEG), ffprobe_path=Path(FFPROBE))
        return output, timelines[0]

    def test_long_gop_mixed_video_and_audio_preserves_exact_decoded_frames_without_duplicate_seeks(self):
        source = self.generate(mixed=True)
        output, timeline = self.rebuild(source)
        self.assertEqual(len(timeline["intervals"]), 2)
        self.assertGreater(timeline["keyframeExpansionMs"], 5900)
        for index in (0, 1):
            frames = self.frames(source, index)
            self.assertEqual(self.frames(output, index), frames[:100] + frames[200:300])
        self.assertTrue(self.server._gap_removed_video_streams_match(
            self.server._probe_gap_removed_video(source, Path(FFPROBE)).streams,
            self.server._probe_gap_removed_video(output, Path(FFPROBE)).streams))

    def test_nonzero_origin_and_multiple_audio_tracks_in_mp4_mkv_and_ts(self):
        for extension in (".mp4", ".mkv", ".ts"):
            with self.subTest(extension=extension):
                source = self.generate(extension, offset=5)
                output, timeline = self.rebuild(source)
                frames = self.frames(source, 0)
                self.assertEqual(self.frames(output, 0), frames[:100] + frames[200:300])
                self.assertGreaterEqual(timeline["intervals"][0]["sourceStartMs"], 0)
                # Display times, unlike B-frame packet PTS in decode order,
                # must strictly increase, with no muxer-repaired duplicate run.
                result = self.run_tool([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_frames",
                                       "-show_entries", "frame=best_effort_timestamp_time", "-of", "json", str(output)])
                times = [Decimal(frame["best_effort_timestamp_time"]) for frame in json.loads(result.stdout)["frames"]]
                self.assertTrue(all(right > left for left, right in zip(times, times[1:])))
                self.assertLess(max(right - left for left, right in zip(times, times[1:])), Decimal("0.05"))

    def assert_no_output(self, source, reason):
        with mock.patch.object(self.server.subprocess, "run", wraps=subprocess.run) as commands:
            with self.assertRaises(self.server.VideoNoOutput) as result:
                self.rebuild(source)
        self.assertEqual(result.exception.timeline["actualRemovedMs"], 0)
        self.assertIn(reason, result.exception.timeline["diagnosis"]["reasonCounts"])
        self.assertFalse((self.root / ("result" + source.suffix)).exists())
        self.assertFalse(any(Path(call.args[0][0]).stem.lower() == "ffmpeg" for call in commands.call_args_list))

    def test_open_gop_without_safe_cut_returns_explicit_no_output_instead_of_complete_source_copy(self):
        source = self.generate(open_gop=True)
        self.assert_no_output(source, "h264_recovery")

    def test_hevc_cra_leading_pictures_also_report_when_no_internal_safe_cut_remains(self):
        source = self.generate(open_gop=True, hevc_only=True)
        self.assert_no_output(source, "hevc_cra")

    def test_recovery_key_flags_are_not_accepted_as_immediate_random_access(self):
        source = self.generate(intra_refresh=True)
        self.assert_no_output(source, "h264_recovery")

    def test_review_open_gop_single_b_frame_counterexample_cannot_silently_lose_two_frames(self):
        source = self.generate(open_gop=True, b_frames=1)
        self.assert_no_output(source, "h264_recovery")
