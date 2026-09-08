"""mopeaks：自研波形的二进制 sidecar（无内核时的回退档）与其读缓存契约。

这里刻意不使用 quapeaks 内核 —— mopeaks 存在的理由就是"内核装不上也要有缓存可
用"，所以它的测试同样必须纯 Python 能跑。字节布局不靠 fixture 而靠现场 encode
往返，配合下面几条拒绝路径来钉住格式。
"""

from __future__ import annotations

import base64
import contextlib
import os
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from maw import mopeaks, waveform  # noqa: E402

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

    @contextlib.contextmanager
    def _huge_media(self):
        """只把**这个媒体文件**的 stat 换成假的，其余路径一律走真 stat。

        全局 patch Path.stat 会把目录的 stat 也换掉：save_mopeaks 里
        mkdir(exist_ok=True) 撞 FileExistsError 后，pathlib 会转去问
        is_dir()→stat().st_mode，假对象没这个字段就直接炸——那是 patch 越界，
        不是被测行为。
        """
        real = Path.stat
        target = self.media_path
        fake = self.fake

        def fake_stat(self_path, *args, **kwargs):
            if self_path == target:
                return fake
            return real(self_path, *args, **kwargs)

        with mock.patch.object(Path, "stat", autospec=True, side_effect=fake_stat):
            yield

    def test_size_field_is_written_and_read_unsigned(self) -> None:
        with self._huge_media():
            blob = mopeaks.encode_mopeaks(make_payload(media_path=self.media_path), self.media_path)
        self.assertEqual(struct.unpack_from("<I", blob, 14)[0], self.HUGE)
        self.assertLess(struct.unpack_from("<i", blob, 14)[0], 0, "先确认这条字节确实会被有符号读法坑到")
        self.assertEqual(mopeaks.decode_mopeaks(blob)["source"]["size"], self.HUGE)

    def test_cache_still_matches_a_huge_media(self) -> None:
        # 回归：早先按有符号 i32 解，>2 GiB 素材的 size 读成负数，
        # 与真实的 st_size 永不相等 —— 缓存被判过期，每次打开都重算。
        with self._huge_media():
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

    def test_container_implementation_does_not_depend_on_quapeaks(self) -> None:
        # mopeaks 是长期稳定的纯 Python 兜底层；quapeaks 模块无法导入时，
        # 容器本身仍必须可编码、解码和校验。
        src = Path(mopeaks.__file__).read_text(encoding="utf-8")
        self.assertNotIn("from maw.quapeaks import", src)
        self.assertEqual(mopeaks.DIV_SELF_WAVE, -ord("m"))
        self.assertEqual(mopeaks.BYTES_PER_PEAK, 2)



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



@contextlib.contextmanager
def _subfolder_config(*, output_subfolder: bool, per_video: bool = False):
    """只替 output_naming 读配置的那一个入口，不动别的环境。"""
    from types import SimpleNamespace

    from maw import gui_config

    def effective_config():
        return SimpleNamespace(
            gui_lang="zh",
            output_subfolder=output_subfolder,
            per_video_subfolder=per_video,
        )

    with mock.patch.object(gui_config, "effective_config", effective_config):
        yield


class WaveformPlacementContractTests(unittest.TestCase):
    """review 第 7 项：写入点跟随配置，读取端两种位置都要找得到。"""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.media_path = self.root / "ICE.mkv"
        self.media_path.write_bytes(b"RIFF" + b"\x00" * 40)
        self.payload = make_payload(media_path=self.media_path)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def _expected(self, *parts: str) -> Path:
        """期望路径按生产端口径 resolve：CI 的 TEMP 常是 8.3 短名（RUNNER~1），
        waveform_dirs/maw_root 返回的是展开后的长名，直接比原始拼写必挂。"""
        return self.root.joinpath(*parts).resolve()

    def test_default_writes_next_to_media(self) -> None:
        with _subfolder_config(output_subfolder=False):
            written = mopeaks.save_mopeaks(self.payload, self.media_path)
        self.assertEqual(written, self._expected("ICE.mkv.mopeaks"))
        self.assertFalse((self.root / "_maw").exists())

    def test_subfolder_preference_moves_the_write_point(self) -> None:
        with _subfolder_config(output_subfolder=True):
            written = mopeaks.save_mopeaks(self.payload, self.media_path)
        self.assertEqual(written, self._expected("_maw", "ICE.mkv.mopeaks"))
        self.assertTrue(written.is_file(), "_maw 不存在时必须自己建出来")

    def test_reader_finds_a_cache_left_by_the_other_setting(self) -> None:
        """用户改一次设置就把已有缓存判过期、整批重抽 ffmpeg，是最难归因的静默慢。"""
        with _subfolder_config(output_subfolder=False):
            mopeaks.save_mopeaks(self.payload, self.media_path)
        with _subfolder_config(output_subfolder=True):
            back = mopeaks.load_mopeaks(self.media_path)
        self.assertIsNotNone(back, "缓存写在媒体旁、设置改成子文件夹后仍须读得到")
        self.assertEqual(back["data"], self.payload["data"])

    def test_reader_skips_a_stale_preferred_candidate(self) -> None:
        valid = mopeaks.encode_mopeaks(self.payload, self.media_path)
        stale = bytearray(valid)
        struct.pack_into("<I", stale, 14, self.media_path.stat().st_size + 1)
        (self.root / "_maw").mkdir()
        (self.root / "_maw" / "ICE.mkv.mopeaks").write_bytes(stale)
        (self.root / "ICE.mkv.mopeaks").write_bytes(valid)

        with _subfolder_config(output_subfolder=True):
            back = mopeaks.load_mopeaks(self.media_path)

        self.assertIsNotNone(back, "过期的首选位置不能挡住后续有效候选")
        self.assertEqual(back["data"], self.payload["data"])

    def test_per_video_maw_root_is_also_searched(self) -> None:
        (self.root / "ICE_maw").mkdir()
        blob = mopeaks.encode_mopeaks(self.payload, self.media_path)
        (self.root / "ICE_maw" / "ICE.mkv.mopeaks").write_bytes(blob)
        with _subfolder_config(output_subfolder=True, per_video=True):
            self.assertEqual(
                mopeaks.mopeaks_path(self.media_path).parent,
                self._expected("ICE_maw"),
            )
        with _subfolder_config(output_subfolder=False):
            back = mopeaks.load_mopeaks(self.media_path)
        self.assertIsNotNone(back, "每视频 _maw 里的缓存也要能回退读到")

    def test_non_default_track_does_not_share_a_file(self) -> None:
        with _subfolder_config(output_subfolder=False):
            first = mopeaks.mopeaks_path(self.media_path, audio_track=0)
            second = mopeaks.mopeaks_path(self.media_path, audio_track=1)
        self.assertEqual(first.name, "ICE.mkv.mopeaks")
        self.assertEqual(second.name, "ICE.mkv.track-2.mopeaks")
        with _subfolder_config(output_subfolder=False):
            mopeaks.save_mopeaks(self.payload, self.media_path, audio_track=1)
            self.assertIsNotNone(mopeaks.load_mopeaks(self.media_path, audio_track=1))
            self.assertIsNone(
                mopeaks.load_mopeaks(self.media_path, audio_track=0),
                "第 2 轨的缓存不得被第 1 轨命中",
            )

    def test_nonzero_default_track_uses_unsuffixed_cache(self) -> None:
        with _subfolder_config(output_subfolder=False):
            default_track = mopeaks.mopeaks_path(
                self.media_path,
                audio_track=1,
                default_audio_track=1,
            )
        self.assertEqual(default_track.name, "ICE.mkv.mopeaks")

    def test_index_zero_nondefault_track_uses_track_one_suffix(self) -> None:
        with _subfolder_config(output_subfolder=False):
            nondefault = mopeaks.mopeaks_path(
                self.media_path,
                audio_track=0,
                default_audio_track=1,
            )
        self.assertEqual(nondefault.name, "ICE.mkv.track-1.mopeaks")

    def test_exact_cache_precedes_default_fallback(self) -> None:
        with _subfolder_config(output_subfolder=False):
            mopeaks.save_mopeaks(
                self.payload,
                self.media_path,
                audio_track=1,
                default_audio_track=1,
            )
            mopeaks.save_mopeaks(
                self.payload,
                self.media_path,
                audio_track=0,
                default_audio_track=1,
            )
            hit = mopeaks.load_mopeaks_hit(
                self.media_path,
                audio_track=0,
                default_audio_track=1,
            )

        self.assertIsNotNone(hit)
        assert hit is not None
        self.assertEqual(hit.kind, "exact")
        self.assertEqual(hit.audio_track, 0)
        self.assertEqual(hit.path.name, "ICE.mkv.track-1.mopeaks")

    def test_missing_exact_cache_returns_typed_default_fallback(self) -> None:
        with _subfolder_config(output_subfolder=False):
            mopeaks.save_mopeaks(
                self.payload,
                self.media_path,
                audio_track=1,
                default_audio_track=1,
            )
            hit = mopeaks.load_mopeaks_hit(
                self.media_path,
                audio_track=0,
                default_audio_track=1,
            )

        self.assertIsNotNone(hit)
        assert hit is not None
        self.assertEqual(hit.kind, "default_fallback")
        self.assertEqual(hit.audio_track, 1)
        self.assertEqual(hit.payload["audio_track"], 1)
        self.assertEqual(hit.path.name, "ICE.mkv.mopeaks")
        self.assertIsNone(
            mopeaks.load_mopeaks(
                self.media_path,
                audio_track=0,
                default_audio_track=1,
            ),
            "兼容读取 API 不能把默认轨回退伪装成所选轨的精确缓存",
        )

    def test_missing_default_disposition_falls_back_to_index_zero(self) -> None:
        with _subfolder_config(output_subfolder=False):
            default_track = mopeaks.mopeaks_path(
                self.media_path,
                audio_track=0,
                default_audio_track=None,
            )
            nondefault = mopeaks.mopeaks_path(
                self.media_path,
                audio_track=1,
                default_audio_track=None,
            )

        self.assertEqual(default_track.name, "ICE.mkv.mopeaks")
        self.assertEqual(nondefault.name, "ICE.mkv.track-2.mopeaks")

    def test_quapeaks_follows_config_while_reapeaks_does_not(self) -> None:
        from maw import quapeaks as maw_quapeaks

        with _subfolder_config(output_subfolder=True):
            dirs = maw_quapeaks.waveform_dirs(self.media_path)
            self.assertEqual(maw_quapeaks.find_reapeaks(self.media_path), None)
            # .ReaPeaks 是 REAPER 写的，永远只在媒体旁：造一份就要被找到，
            # 哪怕配置说"所有输出进子文件夹"。
            st = self.media_path.stat()
            head = struct.pack(
                "<4sBBiII", b"RPKN", 1, 1, 8000,
                int(st.st_mtime) & 0xFFFF_FFFF, st.st_size & 0xFFFF_FFFF,
            )
            (self.root / "ICE.mkv.ReaPeaks").write_bytes(
                head + struct.pack("<ii", 80, 1) + struct.pack("<hh", 10, -10)
            )
            found = maw_quapeaks.find_reapeaks(self.media_path)
            self.assertEqual(found, self.root / "ICE.mkv.ReaPeaks")
            self.assertEqual(dirs[0], self._expected("_maw"))

    def test_quapeaks_generation_uses_the_configured_write_directory(self) -> None:
        from maw import quapeaks as maw_quapeaks

        blob = (
            struct.pack("<4sBBiII", b"QPK1", 1, 1, 8000, 1, 1)
            + struct.pack("<ii", 80, 1)
            + struct.pack("<hh", 100, -100)
        )
        with (
            _subfolder_config(output_subfolder=True),
            mock.patch.object(
                maw_quapeaks, "generate_reapeaks_stream_bytes", return_value=blob
            ),
            mock.patch.object(maw_quapeaks, "_self_check", return_value=True),
        ):
            generated = maw_quapeaks.generate_for_media(
                self.media_path,
                include_spectral=False,
            )

        self.assertEqual(generated, self._expected("_maw", "ICE.mkv.quapeaks"))
        self.assertTrue(generated.is_file())
        self.assertFalse((self.root / "ICE.mkv.quapeaks").exists())
        self.assertEqual(list(generated.parent.glob(".quapeaks-*")), [])


if __name__ == "__main__":
    unittest.main()
