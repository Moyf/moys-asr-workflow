from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest import mock

from maw.media_keyframes import KeyframeInspector, KeyframeLimits


def sample(*nals, width=4):
    return b"".join(len(nal).to_bytes(width, "big") + nal for nal in nals)


def mkv_block(track_header, payload, *, transformed=False):
    def element(kind, body):
        for width in range(1, 9):
            if len(body) < (1 << (width * 7)) - 1:
                return kind + ((1 << (width * 7)) | len(body)).to_bytes(width, "big") + body
    track = 1 if track_header == b"\x81" else 128
    entry = element(b"\xd7", bytes([track])) + element(b"\x86", b"V_MPEG4/ISO/AVC")
    if transformed:
        entry += element(b"\x6d\x80", b"")
    tracks = element(b"\x16\x54\xae\x6b", element(b"\xae", entry))
    prefix = element(b"\x1a\x45\xdf\xa3", b"") + b"\x18\x53\x80\x67\xff" + tracks
    block = track_header + b"\0\0\x80" + payload
    wrapper = element(b"\xa3", block)
    return prefix + wrapper, len(prefix) + len(wrapper) - len(block)


def ts_payload(data, *, declared=True):
    pes_size = len(data) + 3 if declared else 0
    pes = b"\0\0\1\xe0" + pes_size.to_bytes(2, "big") + b"\x80\0\0" + data
    result = bytearray()
    for counter, offset in enumerate(range(0, len(pes), 184)):
        chunk = pes[offset:offset + 184]
        header = bytes([0x47, 0x41 if counter == 0 else 0x01, 0, 0x10 | (counter & 15)])
        if len(chunk) < 184:
            padding = 184 - len(chunk)
            header = header[:3] + bytes([header[3] | 0x20])
            adaptation = bytes([padding - 1]) + (b"\0" + b"\xff" * (padding - 2) if padding > 1 else b"")
            result.extend(header + adaptation + chunk)
        else:
            result.extend(header + chunk)
    return bytes(result)


class KeyframeInspectorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "sample.bin"

    def inspector(self, data, container="mov,mp4", **kwargs):
        self.path.write_bytes(data)
        inspector = KeyframeInspector(self.path, container_name=container, **kwargs)
        self.addCleanup(inspector.close)
        return inspector

    def classify(self, inspector, size=None, **kwargs):
        return inspector.classify(stream_index=0, codec_name=kwargs.pop("codec_name", "h264"),
            pos=kwargs.pop("pos", 0), size=size if size is not None else self.path.stat().st_size,
            **kwargs)

    def test_real_idr_cra_and_recovery_categories(self):
        for codec, nal, kind, safe in [
            ("h264", b"\x65\x88", "h264_idr", True),
            ("hevc", b"\x28\x01\x80", "hevc_idr", True),
            ("hevc", b"\x26\x01\x80", "hevc_idr", True),
            ("hevc", b"\x2a\x01\x80", "hevc_cra", False),
            ("h264", b"\x41\x88", "h264_non_idr", False),
        ]:
            with self.subTest(codec=codec, kind=kind):
                inspector = self.inspector(sample(nal))
                result = self.classify(inspector, codec_name=codec)
                self.assertEqual((result.kind, result.safe), (kind, safe))
        inspector = self.inspector(sample(b"\x06\x06\x01\x38\x80", b"\x41\x88"))
        result = self.classify(inspector)
        self.assertEqual((result.kind, result.safe, result.recovery_frame_count), ("h264_recovery", False, 6))

    def test_length_inference_validates_all_nals_not_only_first_idr(self):
        for width in (1, 2, 3, 4):
            with self.subTest(width=width):
                inspector = self.inspector(sample(b"\x65\x88", width=width))
                self.assertTrue(self.classify(inspector).safe)
        inspector = self.inspector(sample(b"\x65\x88") + b"\xff\xff\xff\xff")
        self.assertIsNone(self.classify(inspector).safe)
        inspector = self.inspector(sample(b"\x41\x88", b"\x65\x88"))
        self.assertIsNone(self.classify(inspector).safe)
        inspector = self.inspector(sample(b"\x65\x88", b"\x65\x88"))
        self.assertIsNone(self.classify(inspector).safe)

    def test_large_payload_is_skipped_not_read_and_cache_has_no_second_io(self):
        inspector = self.inspector(sample(b"\x65\x88" + b"\0" * 1_000_000))
        result = self.classify(inspector, nal_length_size=4)
        self.assertTrue(result.safe)
        before = inspector.stats
        self.assertLess(before["bytes_read"], 32)
        self.assertEqual(self.classify(inspector, nal_length_size=4), result)
        self.assertEqual(inspector.stats["bytes_read"], before["bytes_read"])
        self.assertEqual(inspector.stats["cache_hits"], 1)

    def test_matroska_reads_vint_header_and_rejects_lacing_or_unproven_offset(self):
        payload = sample(b"\x65\x88")
        for track in (b"\x81", b"\x40\x80"):
            source, position = mkv_block(track, payload)
            inspector = self.inspector(source, "matroska,webm")
            self.assertTrue(self.classify(inspector, len(payload), pos=position).safe)
        block = b"\x81\0\0\x82" + payload
        inspector = self.inspector(b"\xa3" + bytes([0x80 | len(block)]) + block, "matroska")
        self.assertEqual(self.classify(inspector, len(payload), pos=2).reason, "unsupported_lacing")
        inspector = self.inspector(b"\x81\0\0\x80" + payload, "matroska")
        self.assertEqual(self.classify(inspector, len(payload)).reason, "payload_position_unverified")
        source, position = mkv_block(b"\x81", payload, transformed=True)
        inspector = self.inspector(source, "matroska")
        self.assertEqual(self.classify(inspector, len(payload), pos=position).reason, "unsupported_packet_transform")

    def test_ts_reconstructs_one_pes_au_and_refuses_later_idr_or_size_mismatch(self):
        payload = b"\0\0\0\1\x09\xf0\0\0\1\x65\x88"
        for declared in (True, False):
            inspector = self.inspector(ts_payload(payload, declared=declared), "mpegts")
            self.assertTrue(self.classify(inspector, len(payload)).safe)
        inspector = self.inspector(ts_payload(payload), "mpegts")
        self.assertIsNone(self.classify(inspector, len(payload) - 1).safe)
        combined = b"\0\0\1\x41\x88\0\0\1\x65\x88"
        inspector = self.inspector(ts_payload(combined), "mpegts")
        self.assertIsNone(self.classify(inspector, len(combined)).safe)
        inspector = self.inspector(b"x" * 188 + ts_payload(payload), "mpegts")
        self.assertIsNone(self.classify(inspector, len(payload)).safe)
        adaptation_only = b"\x47\x01\0\x20\xb7\0" + b"\xff" * 182
        inspector = self.inspector(adaptation_only + ts_payload(payload), "mpegts")
        self.assertEqual(self.classify(inspector, len(payload)).reason, "payload_position_unverified")
        inspector = self.inspector(ts_payload(payload), "mpegts")
        self.assertEqual(self.classify(inspector, 1_000_000).reason, "point_budget_exhausted")
        self.assertEqual(inspector.stats["bytes_read"], 0)

    def test_dense_candidates_stop_at_global_budget_and_duplicates_do_not_spend_it(self):
        payload = sample(b"\x65\x88")
        inspector = self.inspector(payload * 100, limits=replace(KeyframeLimits(), max_points=3))
        for index in range(3):
            self.assertTrue(self.classify(inspector, len(payload), pos=index * len(payload), nal_length_size=4).safe)
        self.assertTrue(self.classify(inspector, len(payload), nal_length_size=4).safe)
        self.assertEqual(self.classify(inspector, len(payload), pos=18).reason, "budget_exhausted")
        self.assertEqual(inspector.stats["points"], 3)
        self.assertTrue(inspector.stats["exhausted"])

    def test_nal_and_byte_budgets_and_malicious_metadata(self):
        limits = replace(KeyframeLimits(), max_nals=2)
        inspector = self.inspector(sample(b"\x09\xf0", b"\x09\xf0", b"\x65\x88"), limits=limits)
        self.assertEqual(self.classify(inspector, nal_length_size=4).reason, "nal_limit")
        inspector = self.inspector(sample(b"\x65\x88"), limits=replace(KeyframeLimits(), max_point_bytes=1))
        self.assertEqual(self.classify(inspector, nal_length_size=4).reason, "point_budget_exhausted")
        inspector = self.inspector(sample(b"\x65\x88"), limits=replace(KeyframeLimits(), max_total_bytes=1))
        self.assertEqual(self.classify(inspector, nal_length_size=4).reason, "budget_exhausted")
        inspector = self.inspector(sample(b"\x65\x88"))
        for pos, size in [(True, 5), (-1, 6), (0, 0), ("N/A", 1), (0, 2**100), (1.5, 5)]:
            self.assertIsNone(self.classify(inspector, size, pos=pos).safe)
        self.assertLess(inspector.stats["bytes_read"], 20)

    def test_cancellation_and_active_time_limit(self):
        inspector = self.inspector(sample(b"\x65\x88"), check_cancelled=mock.Mock(side_effect=InterruptedError("cancel")))
        with self.assertRaises(InterruptedError):
            self.classify(inspector)
        inspector = self.inspector(sample(b"\x65\x88"))
        with mock.patch("maw.media_keyframes.time.monotonic", side_effect=[0, 1, 1]):
            self.assertEqual(self.classify(inspector).reason, "budget_exhausted")
        self.assertEqual(inspector.stats["bytes_read"], 0)

    def test_cancellation_between_reads_and_missing_file_are_not_safe(self):
        checks = 0
        def cancelled():
            nonlocal checks
            checks += 1
            if checks == 5:
                raise InterruptedError("cancel during read")
        inspector = self.inspector(sample(b"\x65\x88"), check_cancelled=cancelled)
        with self.assertRaises(InterruptedError):
            self.classify(inspector, nal_length_size=4)
        self.assertGreater(inspector.stats["bytes_read"], 0)
        missing = KeyframeInspector(self.path.parent / "missing.mp4", container_name="mov")
        self.addCleanup(missing.close)
        self.assertEqual(self.classify(missing, 5).reason, "read_error")


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "media tools unavailable")
class RealKeyframeInspectorTests(unittest.TestCase):
    def test_mp4_matroska_ts_real_positions_and_idr_cra_classification(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for codec, encoder in (("h264", "libx264"), ("hevc", "libx265")):
                source = root / f"{codec}-source.mp4"
                command = ["ffmpeg", "-nostdin", "-y", "-v", "error", "-f", "lavfi", "-i",
                    "testsrc2=size=96x64:rate=10:duration=3", "-c:v", encoder, "-threads", "1"]
                if codec == "h264":
                    command += ["-x264-params", "keyint=10:min-keyint=10:scenecut=0:open-gop=0:bframes=2:threads=1"]
                else:
                    command += ["-x265-params", "keyint=10:min-keyint=10:scenecut=0:open-gop=1:bframes=2:log-level=error:pools=1:frame-threads=1"]
                encoded = subprocess.run([*command, str(source)], capture_output=True, timeout=30)
                if b"Unknown encoder" in encoded.stderr:
                    self.skipTest("H264/HEVC encoder unavailable")
                self.assertEqual(encoded.returncode, 0, encoded.stderr[-1000:])
                for extension in ("mp4", "mkv", "ts"):
                    with self.subTest(codec=codec, container=extension):
                        target = root / f"{codec}.{extension}"
                        subprocess.run(["ffmpeg", "-nostdin", "-y", "-v", "error", "-i", str(source),
                            "-c", "copy", str(target)], capture_output=True, timeout=20, check=True)
                        probe = subprocess.run(["ffprobe", "-v", "error", "-show_packets", "-show_streams",
                            "-show_format", "-show_entries", "packet=stream_index,pos,size,flags:stream=codec_name,nal_length_size:format=format_name",
                            "-of", "json", str(target)], capture_output=True, text=True, timeout=20, check=True)
                        metadata = json.loads(probe.stdout)
                        stream = metadata["streams"][0]
                        with KeyframeInspector(target, container_name=metadata["format"]["format_name"]) as inspector:
                            keys = [p for p in metadata["packets"] if "K" in p["flags"]]
                            self.assertGreaterEqual(len(keys), 3)
                            for index, packet in enumerate(keys):
                                result = inspector.classify(stream_index=0, codec_name=codec, pos=packet["pos"],
                                    size=packet["size"], nal_length_size=stream.get("nal_length_size"))
                                self.assertEqual(result.kind, "hevc_cra" if codec == "hevc" and index else f"{codec}_idr",
                                    f"{result}; stats={inspector.stats}")
                                self.assertEqual(result.safe, codec == "h264" or index == 0)
                            self.assertLess(inspector.stats["bytes_read"], 65_536)


if __name__ == "__main__":
    unittest.main()
