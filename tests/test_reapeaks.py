# pyright: reportAny=false, reportImplicitOverride=false, reportUnknownArgumentType=false, reportUnusedCallResult=false, reportUnusedImport=false

from __future__ import annotations

import base64
import math
import os
import shutil
import struct
import tempfile
import unittest
import wave
from pathlib import Path

from maw import reapeaks, waveform
import reapeaks as rust_generate


# 固定源媒体 mtime，避免测试跨秒边界导致校验结果不确定。
FIXED_MTIME = 1_700_000_000.0


def _read_wav_pcm(path: Path) -> tuple[int, int, bytes]:
    """Return (sample_rate, channels, interleaved int16 PCM) for a WAV file."""
    with wave.open(str(path), "rb") as wf:
        return wf.getframerate(), wf.getnchannels(), wf.readframes(wf.getnframes())


def build_reapeaks(
    path: Path,
    media_path: Path,
    *,
    sample_rate: int = 8000,
    division: int = 80,
    peaks: int = 2,
    channels: int = 1,
    wave_values: list[list[tuple[int, int]]] | None = None,
) -> None:
    """Write a synthetic RPKN (v1.1) file with one wave + one spectral mip.

       Wave: [(max=100,min=-100),(max=200,min=-50), ...] repeated to ``peaks``.
       Spectral: [(freq=300,density=16383),(freq=5000,density=100), ...].
       Header carries the media's real mtime/size so cache validation passes.

    ``sample_rate`` / ``division`` are free so tests can express a fractional
    bin rate (16000 / 53 = 301.8868 peaks/s), which is what REAPER actually
    produces for most media.  ``channels`` / ``wave_values`` (per channel, a
    list of per-peak ``(max, min)``) let a test build the dual-mono layout where
    only one channel carries the audio.
    """
    mipmap_count = 2
    if wave_values is None:
        default = [(100, -100), (200, -50)]
        wave_values = [
            [default[index % 2] for index in range(peaks)] for _ in range(channels)
        ]
    src = media_path.stat()
    src_timestamp = int(src.st_mtime)
    src_filesize = src.st_size
    header = struct.pack(
        "<4sBBiii",
        b"RPKN",
        channels,
        mipmap_count,
        sample_rate,
        src_timestamp,
        src_filesize,
    )
    # mip0 wave: div=division, `peaks` entries; mip1 spectral: -ord('s'), same count
    mip_headers = struct.pack("<iiii", division, peaks, -ord("s"), peaks)
    # 文件内顺序是 peak-major / channel-minor
    flat: list[int] = []
    for index in range(peaks):
        for channel in range(channels):
            peak_max, peak_min = wave_values[channel][index]
            flat.extend((peak_max, peak_min))
    wave_data = struct.pack(f"<{2 * peaks * channels}h", *flat)
    spec_pattern = [((16383 << 15) | 300), ((100 << 15) | 5000)]
    spec_data = struct.pack(
        f"<{peaks * channels}i",
        *(spec_pattern[index % 2] for index in range(peaks * channels)),
    )
    path.write_bytes(header + mip_headers + wave_data + spec_data)


class ReaPeaksParseTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.media_path = self.root / "clip.wav"
        self.media_path.write_bytes(b"RIFF" + b"\x00" * 64)
        os.utime(self.media_path, (FIXED_MTIME, FIXED_MTIME))
        self.reapeaks_path = self.root / "clip.wav.ReaPeaks"
        build_reapeaks(self.reapeaks_path, self.media_path)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_parses_header_and_mipmap_layout(self) -> None:
        parsed = reapeaks.ReaPeaksFile(str(self.reapeaks_path))
        self.assertEqual(parsed.magic, b"RPKN")
        self.assertFalse(parsed.is_v12)
        self.assertEqual(parsed.channels, 1)
        self.assertEqual(parsed.mipmap_count, 2)
        self.assertEqual(parsed.sample_rate, 8000)
        self.assertEqual(parsed.data_end, len(parsed.data))
        self.assertEqual([m.kind for m in parsed.mipmaps], ["wave", "spectral"])

    def test_parses_wave_minmax(self) -> None:
        parsed = reapeaks.ReaPeaksFile(str(self.reapeaks_path))
        wave = parsed.mipmaps[0]
        self.assertEqual(wave.division_factor, 80)
        self.assertEqual(wave.peak_count, 2)
        self.assertEqual([(round(p[0].max), round(p[0].min)) for p in wave.wave], [
            (100, -100),
            (200, -50),
        ])

    def test_parses_spectral_freq_density(self) -> None:
        parsed = reapeaks.ReaPeaksFile(str(self.reapeaks_path))
        spectral = parsed.mipmaps[1]
        self.assertEqual(spectral.division_factor, -ord("s"))
        self.assertEqual(spectral.kind, "spectral")
        self.assertEqual(spectral.spectral, [[(300, 16383)], [(5000, 100)]])

    def test_find_reapeaks_locates_REAPER_cache(self) -> None:
        self.assertEqual(reapeaks.find_reapeaks(self.media_path), self.reapeaks_path)
        # 无 .ReaPeaks 时返回 None
        lone = self.root / "other.mp3"
        lone.write_bytes(b"\x00")
        self.assertIsNone(reapeaks.find_reapeaks(lone))

    def test_extract_spectral_payload_contract(self) -> None:
        payload = reapeaks.extract_spectral_payload(
            self.reapeaks_path, self.media_path, peaks_per_second=100
        )
        self.assertEqual(payload["schema"], reapeaks.SPECTRAL_SCHEMA)
        self.assertEqual(payload["encoding"], reapeaks.SPECTRAL_ENCODING)
        self.assertEqual(payload["sample_rate"], 8000)
        # target div = round(8000/100) = 80, 与唯一 spectral 层匹配
        self.assertEqual(payload["division"], 80)
        self.assertEqual(payload["peak_count"], 2)
        self.assertEqual(payload["source"], waveform.media_signature(self.media_path))
        decoded = base64.b64decode(payload["data"])
        self.assertEqual(len(decoded), 2 * 4)
        freq, density = struct.unpack("<HH", decoded[:4])
        self.assertEqual((freq, density), (300, 16383))
        freq2, density2 = struct.unpack("<HH", decoded[4:8])
        self.assertEqual((freq2, density2), (5000, 100))

    def test_extract_waveform_payload_contract(self) -> None:
        payload = reapeaks.extract_waveform_payload(self.reapeaks_path, self.media_path)
        self.assertEqual(payload["schema"], "moy.asr.waveform.v1")
        self.assertEqual(payload["encoding"], "i8-minmax-base64")
        # sample_rate 8000 / div 80 = 100 峰/秒
        self.assertEqual(payload["peaks_per_second"], 100)
        self.assertEqual(payload["peak_count"], 2)
        self.assertEqual(payload["source"], waveform.media_signature(self.media_path))
        decoded = base64.b64decode(payload["data"])
        self.assertEqual(len(decoded), 2 * 2)

    def test_load_waveform_payload_reads_media_reapeaks(self) -> None:
        payload = reapeaks.load_waveform_payload(self.media_path)
        self.assertIsNotNone(payload)
        self.assertEqual(payload["peak_count"], 2)

    def test_load_spectral_degrades_to_none_without_cache(self) -> None:
        no_cache = self.root / "silent.mp3"
        no_cache.write_bytes(b"\x00")
        self.assertIsNone(reapeaks.load_spectral_payload(no_cache))

    def test_load_spectral_reads_media_reapeaks(self) -> None:
        payload = reapeaks.load_spectral_payload(self.media_path)
        self.assertIsNotNone(payload)
        self.assertEqual(payload["peak_count"], 2)

    def test_corrupt_reapeaks_degrades_to_none(self) -> None:
        bad = self.root / "broken.wav.ReaPeaks"
        bad.write_bytes(b"RPKN" + b"\x00" * 4)
        media = self.root / "broken.wav"
        media.write_bytes(b"\x00")
        self.assertIsNone(reapeaks.load_spectral_payload(media))

    def test_stale_cache_degrades_when_media_replaced(self) -> None:
        # 媒体被替换（内容与大小变化）后，旧缓存不再被使用。
        self.media_path.write_bytes(b"RIFF" + b"\x00" * 128)
        os.utime(self.media_path, (FIXED_MTIME + 100, FIXED_MTIME + 100))
        self.assertIsNone(reapeaks.load_spectral_payload(self.media_path))
        self.assertIsNone(reapeaks.load_waveform_payload(self.media_path))

    def test_legacy_zero_metadata_cache_degrades(self) -> None:
        # 旧版 MAW 缓存头部源元数据为 0，无法证明来源，视为失效。
        media = self.root / "legacy.mp3"
        media.write_bytes(b"\x00" * 8)
        os.utime(media, (FIXED_MTIME, FIXED_MTIME))
        legacy = self.root / "legacy.mp3.ReaPeaks"
        header = struct.pack("<4sBBiii", b"RPKN", 1, 2, 8000, 0, 0)
        mip_headers = struct.pack("<iiii", 80, 2, -ord("s"), 2)
        wave_data = struct.pack("<hhhh", 100, -100, 200, -50)
        spec_data = struct.pack("<ii", (16383 << 15) | 300, (100 << 15) | 5000)
        legacy.write_bytes(header + mip_headers + wave_data + spec_data)
        self.assertIsNone(reapeaks.load_spectral_payload(media))


class GenerateReaPeaksTests(unittest.TestCase):
    """生成 → 解析 往返：验证 MAW 能自建 .ReaPeaks 并被只读路径读取。"""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.tone_path = self.root / "tone.wav"
        sample_rate = 8000
        duration_seconds = 1.0
        with wave.open(str(self.tone_path), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(sample_rate)
            frames = bytearray()
            for index in range(round(sample_rate * duration_seconds)):
                value = round(math.sin(2 * math.pi * 440 * index / sample_rate) * 16_000)
                frames.extend(struct.pack("<h", value))
            output.writeframes(frames)
        os.utime(self.tone_path, (FIXED_MTIME, FIXED_MTIME))

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_generate_reapeaks_bytes_roundtrip(self) -> None:
        sr, ch, frames = _read_wav_pcm(self.tone_path)
        streamer = rust_generate.ReapeaksStreamer(
            sr, ch,
            features=["wave", "spectral", "loudness"],
            mipmap_levels=3,
        )
        streamer.feed(frames)
        data = streamer.finish()
        target = self.root / "tone.ReaPeaks"
        target.write_bytes(data)
        parsed = reapeaks.ReaPeaksFile(str(target))
        self.assertEqual(parsed.magic, b"RPKN")
        self.assertEqual(parsed.channels, 1)
        kinds = [m.kind for m in parsed.mipmaps]
        self.assertIn("wave", kinds)
        self.assertIn("spectral", kinds)
        self.assertIn("loudness", kinds)
        # 最细 wave 层的第一峰 max/min 与原始样本一致
        wave0 = parsed.wave_mipmaps()[0]
        div = wave0.division_factor
        first = wave0.wave[0][0]
        samples = struct.unpack("<%dh" % (len(frames) // 2), frames)
        self.assertAlmostEqual(first.max, max(samples[:div]), delta=1)
        self.assertAlmostEqual(first.min, min(samples[:div]), delta=1)
        # 440Hz 纯音的主导频率应落在 300-600Hz
        spec0 = parsed.spectral_mipmaps()[0]
        freq = spec0.spectral[0][0][0]
        self.assertGreater(freq, 300)
        self.assertLess(freq, 600)

    def test_generate_reapeaks_bytes_can_skip_spectral_layer(self) -> None:
        sr, ch, frames = _read_wav_pcm(self.tone_path)
        streamer = rust_generate.ReapeaksStreamer(
            sr, ch,
            features=["wave", "loudness"],
            mipmap_levels=3,
        )
        streamer.feed(frames)
        data = streamer.finish()
        target = self.root / "tone-wave-only.ReaPeaks"
        target.write_bytes(data)

        parsed = reapeaks.ReaPeaksFile(str(target))
        self.assertIn("wave", [m.kind for m in parsed.mipmaps])
        self.assertNotIn("spectral", [m.kind for m in parsed.mipmaps])
        self.assertIsNone(reapeaks.extract_spectral_payload(target, self.tone_path))

    def test_extract_waveform_payload_has_amplitude(self) -> None:
        sr, ch, frames = _read_wav_pcm(self.tone_path)
        streamer = rust_generate.ReapeaksStreamer(
            sr, ch,
            features=["wave", "spectral", "loudness"],
            mipmap_levels=3,
        )
        streamer.feed(frames)
        src = self.tone_path.stat()
        data = streamer.finish(src_timestamp=int(src.st_mtime), src_filesize=src.st_size)
        (self.root / "tone.wav.ReaPeaks").write_bytes(data)
        payload = reapeaks.load_waveform_payload(self.tone_path)
        self.assertIsNotNone(payload)
        self.assertGreater(payload["peak_count"], 0)
        raw = base64.b64decode(payload["data"])
        vals = [raw[i] - 256 if raw[i] >= 128 else raw[i] for i in range(len(raw))]
        # 正弦波应有非零振幅，而非被压平成 0
        self.assertTrue(any(value != 0 for value in vals))

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is required")
    def test_generate_for_media_writes_and_reuses(self) -> None:
        target = self.root / "tone.wav.ReaPeaks"
        self.assertFalse(target.exists())
        generated = reapeaks.generate_for_media(self.tone_path)
        self.assertEqual(generated, target)
        self.assertTrue(target.exists())
        payload = reapeaks.load_spectral_payload(self.tone_path)
        self.assertIsNotNone(payload)
        self.assertEqual(payload["schema"], reapeaks.SPECTRAL_SCHEMA)
        self.assertGreater(payload["peak_count"], 0)
        # 已有 .ReaPeaks 时复用，不重复生成
        self.assertEqual(reapeaks.generate_for_media(self.tone_path), target)
        payload2 = reapeaks.load_spectral_payload(self.tone_path)
        self.assertIsNotNone(payload2)

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is required")
    def test_generate_for_media_rebuilds_stale_cache(self) -> None:
        # 已有缓存但与当前媒体不匹配（旧媒体残留）时重新生成并覆盖。
        stale = self.root / "tone.wav.ReaPeaks"
        stale.write_bytes(b"RPKN" + b"\x00" * 4)
        generated = reapeaks.generate_for_media(self.tone_path)
        self.assertIsNotNone(generated)
        payload = reapeaks.load_spectral_payload(self.tone_path)
        self.assertIsNotNone(payload)

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is required")
    def test_generate_for_media_rebuilds_wave_only_cache_when_spectral_is_requested(self) -> None:
        target = self.root / "tone.wav.ReaPeaks"
        reapeaks.generate_for_media(self.tone_path, include_spectral=False)
        self.assertFalse(reapeaks.ReaPeaksFile(str(target)).spectral_mipmaps())

        reapeaks.generate_for_media(self.tone_path, include_spectral=True)
        self.assertTrue(reapeaks.ReaPeaksFile(str(target)).spectral_mipmaps())

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is required")
    def test_generate_for_media_handles_non_wav_media(self) -> None:
        mp3 = self.root / "tone.mp3"
        subprocess_run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
                        "-y", "-i", str(self.tone_path), str(mp3)])
        os.utime(mp3, (FIXED_MTIME, FIXED_MTIME))
        generated = reapeaks.generate_for_media(mp3)
        self.assertIsNotNone(generated)
        self.assertTrue(generated.exists())
        payload = reapeaks.load_spectral_payload(mp3)
        self.assertIsNotNone(payload)


class WaveformTimeBaseTests(unittest.TestCase):
    """时间轴契约：.ReaPeaks 的 bin 率是分数，取整后不能当刻度用。

    回归：``extract_waveform_payload`` 曾发布 ``round(sample_rate / division)``，
    编辑器拿它做"峰值序号 ↔ 毫秒"的线性换算，于是整条时间轴被按比例缩放，
    错位随媒体时长线性累积（16 kHz 媒体在 15 分钟处约错开 1/3 秒），
    而且与同一 payload 里用精确公式算出的 ``duration_ms`` 自相矛盾。
    """

    SAMPLE_RATE = 16000
    DIVISION = 53  # 内核对 16 kHz 媒体实际选择的最细 wave 层分频
    PEAKS = 9057  # ≈ 30 s

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.media_path = self.root / "clip16k.wav"
        self.media_path.write_bytes(b"RIFF" + b"\x00" * 64)
        os.utime(self.media_path, (FIXED_MTIME, FIXED_MTIME))
        self.reapeaks_path = self.root / "clip16k.wav.ReaPeaks"
        build_reapeaks(
            self.reapeaks_path,
            self.media_path,
            sample_rate=self.SAMPLE_RATE,
            division=self.DIVISION,
            peaks=self.PEAKS,
        )
        self.payload = reapeaks.extract_waveform_payload(self.reapeaks_path, self.media_path)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_precondition_rate_is_not_integral(self) -> None:
        exact = self.SAMPLE_RATE / self.DIVISION
        self.assertNotEqual(exact, round(exact))

    def test_publishes_exact_rate_and_the_authoritative_pair(self) -> None:
        exact = self.SAMPLE_RATE / self.DIVISION
        self.assertAlmostEqual(self.payload["peaks_per_second"], exact, delta=1e-6)
        self.assertNotEqual(self.payload["peaks_per_second"], round(exact))
        self.assertEqual(self.payload["sample_rate"], self.SAMPLE_RATE)
        self.assertEqual(self.payload["division"], self.DIVISION)

    def test_waveform_rate_helper_prefers_the_pair(self) -> None:
        exact = self.SAMPLE_RATE / self.DIVISION
        self.assertAlmostEqual(waveform.waveform_peaks_per_second(self.payload), exact, places=9)
        legacy = {k: v for k, v in self.payload.items() if k not in ("sample_rate", "division")}
        self.assertEqual(
            waveform.waveform_peaks_per_second(legacy), legacy["peaks_per_second"]
        )
        self.assertEqual(waveform.waveform_peaks_per_second({"peaks_per_second": 0}), 0.0)
        self.assertEqual(
            waveform.waveform_peaks_per_second(
                {"peaks_per_second": 100, "sample_rate": 16000}
            ),
            0.0,
        )
        self.assertEqual(
            waveform.waveform_peaks_per_second(
                {"peaks_per_second": 100, "sample_rate": float("inf"), "division": 53}
            ),
            0.0,
        )
        self.assertEqual(waveform.waveform_peaks_per_second({}), 0.0)
        self.assertEqual(waveform.waveform_peaks_per_second(None), 0.0)

    def test_bin_maps_to_its_own_sample_position(self) -> None:
        """峰 i 必须落回它自己的样本位置 i*div/sr，误差不得超过一个 bin。"""
        rate = waveform.waveform_peaks_per_second(self.payload)
        bin_ms = 1000 / rate
        for index in (0, 1, self.PEAKS // 2, self.PEAKS - 1):
            true_ms = index * self.DIVISION / self.SAMPLE_RATE * 1000
            self.assertLessEqual(abs(index / rate * 1000 - true_ms), bin_ms)

    def test_rounded_scale_would_have_drifted(self) -> None:
        """钉住取整的代价：同一个峰序号，整数刻度在 30 s 处已偏 11 ms。"""
        rate = waveform.waveform_peaks_per_second(self.payload)
        rounded = float(round(rate))
        last = self.PEAKS - 1
        true_ms = last * self.DIVISION / self.SAMPLE_RATE * 1000
        self.assertGreater(abs(last / rounded * 1000 - true_ms), 10.0)
        self.assertLessEqual(abs(last / rate * 1000 - true_ms), 1000 / rate)

    def test_duration_ms_agrees_with_the_exact_rate(self) -> None:
        """payload 必须自洽：duration_ms 等于 peak_count 按真率铺开的长度。"""
        rate = waveform.waveform_peaks_per_second(self.payload)
        covered_ms = self.payload["peak_count"] / rate * 1000
        self.assertLessEqual(abs(covered_ms - self.payload["duration_ms"]), 1.0)

    def test_validator_accepts_float_rate_and_rejects_bad_pair(self) -> None:
        self.assertTrue(waveform.is_waveform_payload(self.payload))
        self.assertFalse(waveform.is_waveform_payload({**self.payload, "division": 0}))
        self.assertFalse(
            waveform.is_waveform_payload(
                {k: v for k, v in self.payload.items() if k != "division"}
            )
        )
        self.assertFalse(waveform.is_waveform_payload({**self.payload, "division": True}))


class GeneratedFractionalRateTests(unittest.TestCase):
    """真实 Rust 内核在 16 kHz 媒体上的产物：分频不整除采样率时的契约。"""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.sample_rate = 16000
        self.tone_path = self.root / "clip.wav"
        frames = bytearray()
        for index in range(3 * self.sample_rate):
            value = round(math.sin(2 * math.pi * 440 * index / self.sample_rate) * 16_000)
            frames.extend(struct.pack("<h", value))
        with wave.open(str(self.tone_path), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(self.sample_rate)
            output.writeframes(bytes(frames))
        os.utime(self.tone_path, (FIXED_MTIME, FIXED_MTIME))
        src = self.tone_path.stat()
        streamer = rust_generate.ReapeaksStreamer(
            self.sample_rate,
            1,
            features=["wave", "spectral", "loudness"],
            mipmap_levels=3,
        )
        streamer.feed(bytes(frames))
        self.cache = self.root / "clip.wav.ReaPeaks"
        self.cache.write_bytes(
            streamer.finish(src_timestamp=int(src.st_mtime), src_filesize=src.st_size)
        )
        self.parsed = reapeaks.ReaPeaksFile(str(self.cache))

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_kernel_division_does_not_divide_the_sample_rate(self) -> None:
        division = abs(self.parsed.wave_mipmaps()[0].division_factor)
        self.assertNotEqual(self.sample_rate % division, 0)

    def test_payload_rate_equals_kernel_bin_width(self) -> None:
        payload = reapeaks.extract_waveform_payload(self.cache, self.tone_path)
        division = abs(self.parsed.wave_mipmaps()[0].division_factor)
        self.assertEqual(payload["division"], division)
        self.assertEqual(payload["sample_rate"], self.sample_rate)
        self.assertAlmostEqual(
            waveform.waveform_peaks_per_second(payload),
            self.sample_rate / division,
            places=9,
        )

    def test_coverage_and_duration_agree_within_one_bin(self) -> None:
        payload = reapeaks.extract_waveform_payload(self.cache, self.tone_path)
        rate = waveform.waveform_peaks_per_second(payload)
        bin_ms = 1000 / rate
        covered_ms = payload["peak_count"] / rate * 1000
        self.assertLessEqual(abs(covered_ms - payload["duration_ms"]), 1.0)
        # 3 s 音频的缓存覆盖长度必须落在 [3000, 3000 + 一个 bin] 之间
        self.assertGreaterEqual(covered_ms, 3000.0)
        self.assertLess(covered_ms, 3000.0 + bin_ms + 1.0)


class ChannelMergeTests(unittest.TestCase):
    """wave 载荷合并全部声道，与浏览器端 decodeReapeaksFile 同一语义。"""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.media = self.root / "dual.wav"
        self.media.write_bytes(b"RIFF" + b"\x00" * 64)
        os.utime(self.media, (FIXED_MTIME, FIXED_MTIME))

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def _pairs(self, name: str, **kwargs) -> list[tuple[int, int]]:
        """解码成有符号的 (min, max) 峰对列表。"""
        cache = self.root / name
        build_reapeaks(cache, self.media, **kwargs)
        payload = reapeaks.extract_waveform_payload(cache, self.media)
        assert payload is not None
        signed = memoryview(base64.b64decode(payload["data"])).cast("b")
        return [(signed[i * 2], signed[i * 2 + 1]) for i in range(len(signed) // 2)]

    def test_dual_mono_right_channel_content_is_not_dropped(self) -> None:
        """广播/游戏里常见的双单声道：人声只在右声道，只取一路会画成直线。"""
        pairs = self._pairs(
            "dual.wav.ReaPeaks",
            sample_rate=48000,
            division=160,
            peaks=3,
            channels=2,
            wave_values=[[(0, 0)] * 3, [(3000, -3000), (6000, -6000), (1500, -1500)]],
        )
        self.assertEqual(len(pairs), 3)
        for peak_min, peak_max in pairs:
            self.assertGreater(peak_max, 0, f"右声道的正向峰值必须被合并: {pairs}")
            self.assertLess(peak_min, 0, f"右声道的负向峰值必须被合并: {pairs}")

    def test_merged_envelope_spans_every_channel(self) -> None:
        """合并 = 各声道 min 取最小、max 取最大，而不是固定取第一路。"""
        pairs = self._pairs(
            "wide.wav.ReaPeaks",
            sample_rate=48000,
            division=160,
            peaks=1,
            channels=2,
            wave_values=[[(1000, -100)], [(300, -9000)]],
        )
        # max 来自声道 0（1000），min 来自声道 1（-9000）
        self.assertEqual(
            pairs,
            [
                (
                    reapeaks._wave_to_int8(-9000),
                    reapeaks._wave_to_int8(1000),
                )
            ],
        )
        self.assertGreater(pairs[0][1], reapeaks._wave_to_int8(300))
        self.assertLess(pairs[0][0], reapeaks._wave_to_int8(-100))

    def test_single_channel_is_unchanged(self) -> None:
        mono = self._pairs("mono.wav.ReaPeaks", sample_rate=8000, division=80, peaks=2)
        explicit = self._pairs(
            "same.wav.ReaPeaks",
            sample_rate=8000,
            division=80,
            peaks=2,
            channels=1,
            wave_values=[[(100, -100), (200, -50)]],
        )
        self.assertEqual(mono, explicit)


def subprocess_run(command: list[str]) -> None:
    import subprocess

    result = subprocess.run(command, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.decode("utf-8", errors="replace"))


if __name__ == "__main__":
    unittest.main()
