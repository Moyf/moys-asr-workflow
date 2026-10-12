from __future__ import annotations

import hashlib
from contextlib import closing
import json
import shutil
import struct
import subprocess
import tempfile
import threading
import time
import unittest
import wave
from pathlib import Path

from maw.media_jobs import MediaJobManager


FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")


@unittest.skipUnless(FFMPEG and FFPROBE, "FFmpeg tools unavailable")
class GapRemovedAudioExportTests(unittest.TestCase):
    def setUp(self):
        from maw.media_export_audio import rebuild_gap_removed_audio
        self.rebuild = rebuild_gap_removed_audio
        temp_root = Path(__file__).resolve().parents[1] / ".debug-runs"
        temp_root.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=temp_root)
        self.root = Path(self.temp.name)
        self.source = self.root / "position-stereo.wav"
        self.rate = 44100
        # Each stereo pair identifies its original sample position, including
        # positions beyond the 16-bit range. Avoid periodic-tone-only checks.
        self.frames = b"".join(struct.pack("<hh", (i % 65536) - 32768,
                                         (i // 65536) * 1000 - 500)
                               for i in range(self.rate * 2))
        with wave.open(str(self.source), "wb") as output:
            output.setparams((2, 2, self.rate, 0, "NONE", "not compressed"))
            output.writeframes(self.frames)
        self.before = hashlib.sha256(self.source.read_bytes()).digest()

    def tearDown(self):
        self.temp.cleanup()

    def command(self, *args):
        result = subprocess.run([str(FFMPEG), "-nostdin", "-v", "error", *map(str, args)],
                                capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace")[-1500:])
        return result.stdout

    def expected(self, frames, intervals, frame_size):
        # Integer half-up conversion is independent of the export helper.
        return b"".join(frames[((start * self.rate + 500) // 1000) * frame_size:
                              ((end * self.rate + 500) // 1000) * frame_size]
                        for start, end in intervals)

    def export(self, source, intervals, name="rebuilt.wav", **kwargs):
        output = self.root / name
        self.assertEqual(self.rebuild(source, intervals, output,
            ffmpeg_path=Path(FFMPEG), ffprobe_path=Path(FFPROBE), **kwargs), output)
        return output

    def test_pcm_preserves_exact_cut_samples_duration_channels_and_source(self):
        intervals = [(7, 119), (437, 598), (1703, 1991)]
        output = self.export(self.source, intervals)
        expected = self.expected(self.frames, intervals, 4)
        with wave.open(str(output), "rb") as rebuilt:
            self.assertEqual((rebuilt.getframerate(), rebuilt.getnchannels(), rebuilt.getsampwidth()),
                             (self.rate, 2, 2))
            self.assertEqual(rebuilt.getnframes(), len(expected) // 4)
            self.assertEqual(rebuilt.readframes(rebuilt.getnframes()), expected)
            requested_seconds = sum(end - start for start, end in intervals) / 1000
            self.assertLessEqual(abs(rebuilt.getnframes() / self.rate - requested_seconds),
                                 len(intervals) / self.rate)
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).digest(), self.before)
        self.assertFalse(list(self.root.glob("*.raw")), "private decode work must be removed")

    def test_aac_and_mp3_non_packet_cuts_match_complete_decode_control(self):
        intervals = [(13, 127), (503, 711), (1507, 1919)]
        for codec, suffix in (("aac", ".m4a"), ("libmp3lame", ".mp3")):
            with self.subTest(codec=codec):
                compressed = self.root / (codec + suffix)
                encoded = subprocess.run([str(FFMPEG), "-y", "-nostdin", "-v", "error",
                    "-i", str(self.source), "-c:a", codec, "-b:a", "192k", str(compressed)],
                    capture_output=True, timeout=30)
                if encoded.returncode and b"Unknown encoder" in encoded.stderr:
                    self.skipTest(f"{codec} encoder unavailable")
                self.assertEqual(encoded.returncode, 0, encoded.stderr.decode(errors="replace"))
                before = hashlib.sha256(compressed.read_bytes()).digest()
                # Full decode then sample slicing checks boundaries independent
                # of seek/packet alignment in the helper's production path.
                control = self.command("-i", compressed, "-map", "0:a:0", "-c:a", "pcm_f32le",
                                       "-f", "f32le", "pipe:1")
                output = self.export(compressed, intervals, codec + "-rebuilt.wav")
                actual = self.command("-i", output, "-map", "0:a:0", "-c:a", "pcm_f32le",
                                      "-f", "f32le", "pipe:1")
                expected = self.expected(control, intervals, 8)
                self.assertEqual(len(actual), len(expected))
                self.assertEqual(actual, expected, "decoded sample content or splice boundary changed")
                self.assertEqual(hashlib.sha256(compressed.read_bytes()).digest(), before)

    def test_selected_audio_track_is_used(self):
        multitrack = self.root / "two-tracks.mka"
        self.command("-y", "-i", self.source, "-f", "lavfi", "-i",
                     f"sine=frequency=800:sample_rate={self.rate}:duration=2",
                     "-map", "0:a", "-map", "1:a", "-c:a", "pcm_s16le", multitrack)
        intervals = [(17, 113), (1091, 1297)]
        control = self.command("-i", multitrack, "-map", "0:a:1", "-c:a", "pcm_s16le",
                               "-f", "s16le", "pipe:1")
        output = self.export(multitrack, intervals, audio_track=1)
        actual = self.command("-i", output, "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1")
        self.assertEqual(actual, self.expected(control, intervals, 2))

    def test_high_resolution_and_float_samples_preserve_format_and_contents(self):
        intervals = [(3, 91), (617, 953)]
        for codec, raw_format, width in (("pcm_s24le", "s24le", 3),
                                         ("pcm_s32le", "s32le", 4),
                                         ("pcm_f32le", "f32le", 4),
                                         ("pcm_f64le", "f64le", 8)):
            with self.subTest(codec=codec):
                source = self.root / (codec + ".wav")
                self.command("-y", "-i", self.source, "-c:a", codec, source)
                control = self.command("-i", source, "-c:a", codec, "-f", raw_format, "pipe:1")
                output = self.export(source, intervals, codec + "-rebuilt.wav")
                actual = self.command("-i", output, "-c:a", codec, "-f", raw_format, "pipe:1")
                self.assertEqual(actual, self.expected(control, intervals, 2 * width))
                probe = subprocess.run([str(FFPROBE), "-v", "error", "-show_streams", "-of", "json",
                                        str(output)], capture_output=True, text=True, timeout=10)
                self.assertEqual(probe.returncode, 0, probe.stderr)
                self.assertEqual(json.loads(probe.stdout)["streams"][0]["codec_name"], codec)

    def test_surround_channel_layout_and_samples_are_preserved(self):
        source = self.root / "surround.wav"
        self.command("-y", "-f", "lavfi", "-i",
                     "aevalsrc=sin(400*t)|sin(500*t)|sin(600*t)|sin(700*t)|sin(800*t)|sin(900*t):s=44100:d=1:c=5.1",
                     "-c:a", "pcm_s24le", source)
        control = self.command("-i", source, "-c:a", "pcm_s24le", "-f", "s24le", "pipe:1")
        intervals = [(7, 113), (701, 913)]
        output = self.export(source, intervals)
        actual = self.command("-i", output, "-c:a", "pcm_s24le", "-f", "s24le", "pipe:1")
        self.assertEqual(actual, self.expected(control, intervals, 18))
        probe = subprocess.run([str(FFPROBE), "-v", "error", "-show_streams", "-of", "json", str(output)],
                               capture_output=True, text=True, timeout=10)
        self.assertEqual(probe.returncode, 0, probe.stderr)
        stream = json.loads(probe.stdout)["streams"][0]
        self.assertEqual((stream["channels"], stream["channel_layout"]), (6, "5.1"))

    def test_nearest_millisecond_natural_tail_is_clamped_but_larger_overrun_rejected(self):
        source = self.root / "short-tail.wav"
        with wave.open(str(source), "wb") as short:
            short.setparams((2, 2, self.rate, 0, "NONE", "not compressed"))
            short.writeframes(self.frames[:4000])
        output = self.export(source, [(0, 23)])
        with wave.open(str(output), "rb") as rebuilt:
            self.assertEqual(rebuilt.getnframes(), 1000)
            self.assertEqual(rebuilt.readframes(1000), self.frames[:4000])
        with self.assertRaises(ValueError):
            self.export(source, [(0, 24)], "overrun.wav")
        self.assertFalse((self.root / "overrun.wav").exists())

    def test_out_of_bounds_is_rejected_and_partial_result_removed(self):
        output = self.root / "out-of-range.wav"
        with self.assertRaises(ValueError):
            self.rebuild(self.source, [(1900, 2100)], output,
                         ffmpeg_path=Path(FFMPEG), ffprobe_path=Path(FFPROBE))
        self.assertFalse(output.exists())
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).digest(), self.before)

    def test_existing_output_and_source_are_never_overwritten(self):
        output = self.root / "existing.wav"
        output.write_bytes(b"existing user output")
        for destination in (self.source, output):
            with self.subTest(destination=destination.name), self.assertRaises(ValueError):
                self.rebuild(self.source, [(7, 119)], destination,
                             ffmpeg_path=Path(FFMPEG), ffprobe_path=Path(FFPROBE))
        self.assertEqual(output.read_bytes(), b"existing user output")
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).digest(), self.before)

    def test_audio_job_cancel_reaps_ffmpeg_and_removes_private_work(self):
        # Slow only the decode command using FFmpeg's real-time input pacing;
        # the actual helper and MediaJob process/cancellation code still run.
        with closing(MediaJobManager(temp_root=self.root)) as manager:
            entered = threading.Event()
            def runner(job):
                original_run = job.run_command
                def paced(command, **kwargs):
                    if Path(command[0]).stem.lower() == "ffmpeg" and "-i" in command:
                        command = list(command)
                        command.insert(command.index("-i"), "-re")
                        entered.set()
                    return original_run(command, **kwargs)
                job.run_command = paced
                self.rebuild(job.source, list(job.intervals), job.output,
                             ffmpeg_path=Path(FFMPEG), ffprobe_path=Path(FFPROBE), job=job)
            job = manager.start(self.source, (1, "audio-source"), [(0, 1990)], runner,
                                output_extension=".wav")
            self.assertTrue(entered.wait(5))
            deadline = time.monotonic() + 5
            while job.process is None and time.monotonic() < deadline:
                time.sleep(.01)
            process = job.process
            self.assertIsNotNone(process)
            manager.cancel(job.id)
            job.thread.join(5)
            self.assertFalse(job.thread.is_alive())
            self.assertEqual(job.state, "cancelled", job.error)
            self.assertIsNotNone(process.poll())
            self.assertFalse(job.directory.exists())
            self.assertEqual(hashlib.sha256(self.source.read_bytes()).digest(), self.before)


class AudioLargeWaveHeaderTests(unittest.TestCase):
    def test_rf64_declares_64_bit_file_and_sample_sizes_without_allocating_gigabytes(self):
        from maw.media_export_audio import _wave_header
        samples = 1_500_000_000
        data_bytes = samples * 2 * 3
        header = _wave_header(rate=48000, channels=2, sample_width=3,
                             format_tag=1, samples=samples, channel_layout="stereo")
        self.assertEqual(header[:12], b"RF64\xff\xff\xff\xffWAVE")
        self.assertEqual(header[12:20], b"ds64\x1c\0\0\0")
        riff_size, declared_data, declared_samples, table_entries = struct.unpack_from("<QQQI", header, 20)
        self.assertEqual((riff_size, declared_data, declared_samples, table_entries),
                         (len(header) - 8 + data_bytes, data_bytes, samples, 0))
        self.assertEqual(header[-8:], b"data\xff\xff\xff\xff")


if __name__ == "__main__":
    unittest.main()
