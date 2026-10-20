from __future__ import annotations

import hashlib
import shutil
import struct
import subprocess
import tempfile
import unittest
from pathlib import Path


FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")


def mix_hevc_parameter_arrays(path: Path) -> None:
    """Construct the user's class of hvcC anomaly without real media fixtures.

    Move PPS NAL units to the VPS array, retaining an empty PPS array so all
    MP4 atom sizes and sample offsets stay unchanged. The bitstream itself is
    untouched and remains decodable with an Annex B parameter conversion.
    """
    payload = bytearray(path.read_bytes())
    marker = payload.index(b"hvcC")
    start = marker + 4
    size = struct.unpack_from(">I", payload, marker - 4)[0] - 8
    config = bytes(payload[start:start + size])
    arrays = []
    position = 23
    for _ in range(config[22]):
        header, count = config[position], struct.unpack_from(">H", config, position + 1)[0]
        position += 3
        nals = []
        for _ in range(count):
            length = struct.unpack_from(">H", config, position)[0]
            nals.append(config[position:position + 2 + length])
            position += 2 + length
        arrays.append([header, nals])
    vps = next(array for array in arrays if array[0] & 63 == 32)
    pps = next(array for array in arrays if array[0] & 63 == 34)
    if not vps[1] or not pps[1]:
        raise AssertionError("encoder did not produce VPS and PPS arrays")
    vps[1].extend(pps[1])
    pps[1] = []
    replacement = config[:23] + b"".join(bytes([header]) + struct.pack(">H", len(nals)) +
                                        b"".join(nals) for header, nals in arrays)
    if len(replacement) != len(config):
        raise AssertionError("hvcC mutation changed container offsets")
    payload[start:start + size] = replacement
    path.write_bytes(payload)


@unittest.skipUnless(FFMPEG and FFPROBE, "FFmpeg tools unavailable")
class GapRemovedVideoCompatibilityTests(unittest.TestCase):
    def setUp(self):
        from tests.test_local_editor_server import server_editor
        self.server = server_editor
        temp_root = Path(__file__).resolve().parents[1] / ".debug-runs"
        temp_root.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=temp_root)
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def generate(self, name, *, mixed_video=False, audio_delay=False):
        source = self.root / name
        command = [str(FFMPEG), "-y", "-nostdin", "-v", "error", "-f", "lavfi", "-i",
            "testsrc2=size=96x64:rate=10", *(["-itsoffset", "0.1"] if audio_delay else []), "-f", "lavfi", "-i",
            "sine=frequency=400:sample_rate=48000", *(["-itsoffset", "0.1"] if audio_delay else []), "-f", "lavfi", "-i",
            "sine=frequency=800:sample_rate=48000", "-t", "3"]
        if mixed_video:
            command += ["-map", "0:v", "-map", "0:v", "-map", "1:a", "-map", "2:a",
                        "-c:v:0", "libx264", "-c:v:1", "libx265", "-tag:v:1", "hvc1"]
        else:
            command += ["-map", "0:v", "-map", "1:a", "-map", "2:a", "-c:v", "libx265",
                        "-tag:v", "hvc1"]
        command += ["-g", "1", "-x265-params", "log-level=error:pools=1", "-c:a", "aac",
            "-metadata:s:a:0", "language=eng", "-metadata:s:a:0", "title=English",
            "-metadata:s:a:1", "language=deu", "-metadata:s:a:1", "title=German",
            "-disposition:a:0", "0", "-disposition:a:1", "default", str(source)]
        result = subprocess.run(command, capture_output=True, timeout=30)
        if result.returncode and b"Unknown encoder" in result.stderr:
            self.skipTest("H.264/HEVC encoder unavailable")
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace")[-2000:])
        return source

    def frame_hashes(self, source, stream=0):
        result = subprocess.run([str(FFMPEG), "-nostdin", "-v", "error", "-i", str(source),
            "-map", f"0:v:{stream}", "-f", "framemd5", "pipe:1"],
            capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr[-2000:])
        return [line.rsplit(",", 1)[1].strip() for line in result.stdout.splitlines()
                if line and not line.startswith("#")]

    def test_malformed_hvcc_exports_and_preserves_mixed_codec_tracks_and_metadata(self):
        source = self.generate("mixed-video.mp4", mixed_video=True)
        expected_hashes = [self.frame_hashes(source, index) for index in (0, 1)]
        mix_hevc_parameter_arrays(source)
        before = hashlib.sha256(source.read_bytes()).digest()
        original = self.server._probe_gap_removed_video(source, Path(FFPROBE))
        output = self.root / "rebuilt.mp4"
        self.server.rebuild_gap_removed_video(source, [(0, 1000), (2000, 3000)], output,
            ffmpeg_path=Path(FFMPEG), ffprobe_path=Path(FFPROBE))
        actual = self.server._probe_gap_removed_video(output, Path(FFPROBE))
        self.assertTrue(self.server._gap_removed_video_streams_match(original.streams, actual.streams),
                        f"stream metadata changed: {original.streams!r} -> {actual.streams!r}")
        self.assertEqual([item.codec_signature[1] for item in actual.streams[:2]], ["h264", "hevc"])
        for index in (0, 1):
            # All-intra fixture isolates the compatibility fix from GOP seek
            # behavior. The kept contents must match both codecs exactly.
            self.assertEqual(self.frame_hashes(output, index),
                             expected_hashes[index][:10] + expected_hashes[index][20:30])
        self.assertEqual(hashlib.sha256(source.read_bytes()).digest(), before)

    def test_tiny_interval_expands_to_safe_boundary_without_silently_dropping_audio(self):
        source = self.generate("tiny.mp4", audio_delay=True)
        mix_hevc_parameter_arrays(source)
        output = self.root / "rebuilt.mp4"
        self.server.rebuild_gap_removed_video(source, [(20, 21)], output,
            ffmpeg_path=Path(FFMPEG), ffprobe_path=Path(FFPROBE))
        self.assertTrue(self.server._gap_removed_video_streams_match(
            self.server._probe_gap_removed_video(source, Path(FFPROBE)).streams,
            self.server._probe_gap_removed_video(output, Path(FFPROBE)).streams))


if __name__ == "__main__":
    unittest.main()
