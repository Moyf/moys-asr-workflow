"""mopeaks：自研波形的二进制 sidecar（无内核时的回退档）与其读缓存契约。

这里刻意不使用 quapeaks 内核 —— mopeaks 存在的理由就是"内核装不上也要有缓存可
用"，所以它的测试同样必须纯 Python 能跑。字节布局不靠 fixture 而靠现场 encode
往返，配合下面几条拒绝路径来钉住格式。
"""

from __future__ import annotations

import base64
import json
import os
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from maw import mopeaks, quapeaks, waveform  # noqa: E402

WT_ROOT = ROOT


class _FakeStat:
    """只带 mopeaks 真正会读的字段，用来伪造 >2 GiB 素材。"""

    def __init__(self, size: int, mtime: float) -> None:
        self.st_size = size
        self.st_mtime = mtime
        self.st_mtime_ns = int(mtime * 1_000_000_000)


def make_payload(
    *,
    peaks: bytes = b"\x00\x64\x9c\xff",
    peaks_per_second: int = 100,
    sample_rate: int | None = 1000,
    division: int | None = 10,
    media_path: Path | None = None,
) -> dict:
    payload: dict = {
        "schema": waveform.WAVEFORM_SCHEMA,
        "encoding": waveform.WAVEFORM_ENCODING,
        "peaks_per_second": peaks_per_second,
        "peak_count": len(peaks) // 2,
        "duration_ms": round(len(peaks) // 2 / peaks_per_second * 1000),
        "data": base64.b64encode(peaks).decode("ascii"),
    }
    if sample_rate is not None:
        payload["sample_rate"] = sample_rate
    if division is not None:
        payload["division"] = division
    if media_path is not None:
        payload["source"] = waveform.media_signature(media_path)
    return payload


class MopeaksRoundTripTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.media_path = Path(self.temp_dir.name) / "tone.wav"
        self.media_path.write_bytes(b"RIFF" + b"\x00" * 40)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_path_keeps_full_media_name(self) -> None:
        # 与 .ReaPeaks/.quapeaks 同风格：不能把 .wav 吃掉。
        self.assertEqual(mopeaks.mopeaks_path(self.media_path).name, "tone.wav.mopeaks")

    def test_header_matches_the_shared_container_layout(self) -> None:
        blob = mopeaks.encode_mopeaks(make_payload(media_path=self.media_path), self.media_path)
        self.assertEqual(blob[:3], mopeaks.MAGIC_PREFIX)
        self.assertEqual(blob[3 : 4], b"1")
        self.assertEqual(blob[4], mopeaks.CHANNELS)
        self.assertEqual(blob[5], mopeaks.LAYER_COUNT)
        div, npeak = struct.unpack_from("<ii", blob, mopeaks.HEADER_LEN)
        self.assertEqual(div, mopeaks.DIV_SELF_WAVE)
        self.assertEqual(div, -ord("m"), "层 token 必须与 quapeaks 自研层同值，解析器才只有一条分支")
        self.assertEqual(npeak, 2)
        self.assertEqual(len(blob), mopeaks.HEADER_LEN + 8 + 8 + 2 * npeak)

    def test_round_trip_preserves_everything_but_the_full_precision_mtime(self) -> None:
        payload = make_payload(media_path=self.media_path)
        back = mopeaks.decode_mopeaks(mopeaks.encode_mopeaks(payload, self.media_path))
        source = back.pop("source")
        back.pop("audio_track")  # 由落点（文件名/调用方）告知，不来自载荷本身
        self.assertEqual(back, {k: v for k, v in payload.items() if k != "source"})
        # 容器只存得下秒级 mtime 与 low-32 size，所以这两项按同一口径折过。
        self.assertEqual(source["size"], self.media_path.stat().st_size)
        self.assertEqual(source["modified_ms"], int(self.media_path.stat().st_mtime) * 1000)

    def test_save_then_load_returns_the_same_payload(self) -> None:
        payload = make_payload(media_path=self.media_path)
        mopeaks.save_mopeaks(payload, self.media_path)
        self.assertEqual(
            {k: v for k, v in mopeaks.load_mopeaks(self.media_path).items() if k != "audio_track"},
            payload,
        )

    def test_exact_rate_survives_a_payload_that_only_has_the_rounded_rate(self) -> None:
        # PR #102 的教训：只留整数峰率会把刻度漂移又请回来。
        payload = make_payload(media_path=self.media_path, sample_rate=None, division=None)
        back = mopeaks.decode_mopeaks(mopeaks.encode_mopeaks(payload, self.media_path))
        self.assertEqual((back["sample_rate"], back["division"]), (100, 1))
        self.assertEqual(waveform.waveform_peaks_per_second(back), 100.0)

    def test_fractional_rate_is_not_rounded_away(self) -> None:
        payload = make_payload(
            media_path=self.media_path,
            peaks_per_second=302,
            sample_rate=16_000,
            division=53,
            peaks=b"\x01\x02\x03\x04" * 6,
        )
        back = mopeaks.decode_mopeaks(mopeaks.encode_mopeaks(payload, self.media_path))
        self.assertEqual(waveform.waveform_peaks_per_second(back), 16_000 / 53)
        self.assertEqual(back["peaks_per_second"], 302, "显示用的取整率仍要留着")

    def test_atomic_write_leaves_no_temp_files(self) -> None:
        mopeaks.save_mopeaks(make_payload(media_path=self.media_path), self.media_path)
        leftovers = [p.name for p in self.media_path.parent.glob(".mopeaks-*")]
        self.assertEqual(leftovers, [])


class MopeaksRejectsGarbageTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.media_path = Path(self.temp_dir.name) / "tone.wav"
        self.media_path.write_bytes(b"RIFF" + b"\x00" * 40)
        self.good = mopeaks.encode_mopeaks(make_payload(media_path=self.media_path), self.media_path)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_wrong_magic_is_refused(self) -> None:
        with self.assertRaises(mopeaks.MopeaksError):
            mopeaks.decode_mopeaks(b"QPK1" + self.good[4:])

    def test_stereo_or_multilayer_is_refused(self) -> None:
        for channel, layer in ((2, 1), (1, 2)):
            blob = bytearray(self.good)
            blob[4] = channel
            blob[5] = layer
            with self.subTest(channels=channel, layers=layer):
                with self.assertRaises(mopeaks.MopeaksError):
                    mopeaks.decode_mopeaks(bytes(blob))

    def test_non_self_layer_is_refused(self) -> None:
        blob = bytearray(self.good)
        struct.pack_into("<i", blob, mopeaks.HEADER_LEN, -ord("s"))
        with self.assertRaises(mopeaks.MopeaksError):
            mopeaks.decode_mopeaks(bytes(blob))

    def test_truncated_peak_data_is_refused(self) -> None:
        with self.assertRaises(mopeaks.MopeaksError):
            mopeaks.decode_mopeaks(self.good[:-1])
        with self.assertRaises(mopeaks.MopeaksError):
            mopeaks.decode_mopeaks(self.good[:12])

    def test_load_treats_every_refusal_as_no_cache(self) -> None:
        path = mopeaks.mopeaks_path(self.media_path)
        for blob in (b"", b"\x00" * 8, b"QPK1" + self.good[4:], self.good[:-1]):
            with self.subTest(size=len(blob)):
                path.write_bytes(blob)
                self.assertIsNone(mopeaks.load_mopeaks(self.media_path))
        path.write_bytes(self.good)
        path.unlink()
        self.assertIsNone(mopeaks.load_mopeaks(self.media_path))

    def test_inconsistent_peak_count_is_refused_on_write(self) -> None:
        payload = make_payload(media_path=self.media_path)
        payload["peak_count"] += 1
        with self.assertRaises(mopeaks.MopeaksError):
            mopeaks.encode_mopeaks(payload, self.media_path)

    def test_odd_peak_length_is_refused_on_write(self) -> None:
        # make_payload 把 3 字节折成 peak_count=1，先过签名校验，再被长度挡住。
        with self.assertRaises(mopeaks.MopeaksError):
            mopeaks.encode_mopeaks(make_payload(peaks=b"\x00\x01\x02", media_path=self.media_path), self.media_path)

    def test_media_change_invalidates_the_cache(self) -> None:
        mopeaks.save_mopeaks(make_payload(media_path=self.media_path), self.media_path)
        self.media_path.write_bytes(self.media_path.read_bytes() + b"\x7f\x7f")
        self.assertIsNone(mopeaks.load_mopeaks(self.media_path))


class MopeaksLow32ProvenanceTests(unittest.TestCase):
    """>2 GiB 素材：容器只存得下低 32 位，两侧必须按同一口径折。"""

    HUGE = 0xC0000011  # 3 GiB + 17 B：有符号读法会读成负数

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.media_path = Path(self.temp_dir.name) / "tone.wav"
        self.media_path.write_bytes(b"RIFF" + b"\x00" * 40)
        self.fake = _FakeStat(self.HUGE, 1_700_000_123.0)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_size_field_is_written_and_read_unsigned(self) -> None:
        with mock.patch.object(Path, "stat", return_value=self.fake):
            blob = mopeaks.encode_mopeaks(make_payload(media_path=self.media_path), self.media_path)
        self.assertEqual(struct.unpack_from("<I", blob, 14)[0], self.HUGE)
        self.assertLess(struct.unpack_from("<i", blob, 14)[0], 0, "先确认这条字节确实会被有符号读法坑到")
        self.assertEqual(mopeaks.decode_mopeaks(blob)["source"]["size"], self.HUGE)

    def test_cache_still_matches_a_huge_media(self) -> None:
        # 回归：早先按有符号 i32 解，>2 GiB 素材的 size 读成负数，
        # 与真实的 st_size 永不相等 —— 缓存被判过期，每次打开都重算。
        with mock.patch.object(Path, "stat", return_value=self.fake):
            mopeaks.save_mopeaks(make_payload(media_path=self.media_path), self.media_path)
            self.assertEqual(mopeaks.load_mopeaks(self.media_path)["source"]["size"], self.HUGE)


class MopeaksFingerprintPolicyTests(unittest.TestCase):
    """回退档与内核缓存必须对"媒体变没变"给出同一个答案。"""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.media_path = Path(self.temp_dir.name) / "tone.wav"
        self.media_path.write_bytes(b"RIFF" + b"\x00" * 40)
        os.utime(self.media_path, (1_700_000_000.0, 1_700_000_000.0))
        mopeaks.save_mopeaks(make_payload(media_path=self.media_path), self.media_path)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_copy_mtime_drift_does_not_kill_the_cache(self) -> None:
        # 跨盘拷贝常使 mtime 漂几秒；上游 #113 已让 .ReaPeaks 容忍，回退档不能更严。
        os.utime(self.media_path, (1_700_000_003.0, 1_700_000_003.0))
        self.assertIsNotNone(mopeaks.load_mopeaks(self.media_path))

    def test_real_change_still_kills_it(self) -> None:
        os.utime(self.media_path, (1_700_007_200.0, 1_700_007_200.0))
        self.assertIsNone(mopeaks.load_mopeaks(self.media_path))

    def test_format_constants_have_a_single_source(self) -> None:
        # assertIs 对小整数会假绿（-5..256 被 CPython 驻留，抄一份也 is 相等），
        # 所以直接查源码：mopeaks 里不得再出现这些常量的赋值。
        src = Path(mopeaks.__file__).read_text(encoding="utf-8")
        for name in ("DIV_SELF_WAVE", "SELF_PREFIX_LEN", "BYTES_PER_PEAK", "UINT32_MASK"):
            with self.subTest(name=name):
                self.assertNotIn(f"\n{name} =", src, "格式常量的真源在 maw.quapeaks，不要抄第二份")
        self.assertIs(mopeaks.timestamp_fingerprint_matches, quapeaks._timestamp_fingerprint_matches)



class UnsupportedVersionAndBoundaryTests(unittest.TestCase):
    """review 第 5 项：只比前缀会把未知版本/损坏文件当合法缓存读。"""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.media_path = Path(self.temp_dir.name) / "tone.wav"
        self.media_path.write_bytes(b"RIFF" + b"\x00" * 40)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def _good(self) -> bytes:
        return mopeaks.encode_mopeaks(make_payload(media_path=self.media_path), self.media_path)

    def _patch(self, blob: bytes, offset: int, raw: bytes) -> bytes:
        out = bytearray(blob)
        out[offset : offset + len(raw)] = raw
        return bytes(out)

    def test_unknown_mopeaks_version_is_a_cache_miss(self) -> None:
        blob = self._patch(self._good(), 3, b"2")
        self.assertEqual(blob[:4], b"MPK2")
        with self.assertRaises(mopeaks.MopeaksError):
            mopeaks.decode_mopeaks(blob)
        path = mopeaks.mopeaks_path(self.media_path)
        path.write_bytes(blob)
        self.assertIsNone(mopeaks.load_mopeaks(self.media_path), "未知版本必须重建，不能按旧布局解")

    def test_negative_and_zero_peak_count_are_refused(self) -> None:
        good = self._good()
        for npeak in (-1, 0, 1 << 30):
            with self.subTest(npeak=npeak):
                blob = self._patch(good, mopeaks.HEADER_LEN + 4, struct.pack("<i", npeak))
                with self.assertRaises(mopeaks.MopeaksError):
                    mopeaks.decode_mopeaks(blob)

    def test_supported_version_still_round_trips(self) -> None:
        payload = make_payload(media_path=self.media_path)
        mopeaks.save_mopeaks(payload, self.media_path)
        back = mopeaks.load_mopeaks(self.media_path)
        self.assertIsNotNone(back)
        self.assertEqual(back["data"], payload["data"])

    def test_parser_refuses_unknown_native_container(self) -> None:
        """ReapeaksFile 同样只比前缀过：QPK2 必须整份判不支持。"""
        from maw import quapeaks as maw_quapeaks

        fixture = WT_ROOT / "tests" / "test_data" / "tone_selfwave.wav.quapeaks"
        if not fixture.exists():
            self.skipTest(f"缺少 fixture {fixture}")
        blob = bytearray(fixture.read_bytes())
        self.assertEqual(bytes(blob[:4]), b"QPK1", "fixture 应是已支持版本")
        blob[3] = ord("2")
        probe = Path(self.temp_dir.name) / "probe.quapeaks"
        probe.write_bytes(bytes(blob))
        with self.assertRaises(ValueError):
            maw_quapeaks.ReapeaksFile(str(probe))


if __name__ == "__main__":
    unittest.main()
