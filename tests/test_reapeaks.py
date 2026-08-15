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

import reapeaks as rust_generate
import reapeaks_io as reapeaks
import waveform


# 固定源媒体 mtime，避免测试跨秒边界导致校验结果不确定。
FIXED_MTIME = 1_700_000_000.0


def _read_wav_pcm(path: Path) -> tuple[int, int, bytes]:
    """Return (sample_rate, channels, interleaved int16 PCM) for a WAV file."""
    with wave.open(str(path), "rb") as wf:
        return wf.getframerate(), wf.getnchannels(), wf.readframes(wf.getnframes())


def build_reapeaks(path: Path, media_path: Path) -> None:
    """Write a small synthetic RPKN (v1.1) file with one wave + one spectral mip.

       2 peaks, 1 channel. Wave: [(max=100,min=-100),(max=200,min=-50)].
       Spectral: [(freq=300,density=16383),(freq=5000,density=100)].
       Header carries the media's real mtime/size so cache validation passes.
    """
    channels = 1
    mipmap_count = 2
    sample_rate = 8000
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
    # mip0 wave: div=80, 2 peaks; mip1 spectral: div=-(ord('s'))=-115, 2 peaks
    mip_headers = struct.pack("<iiii", 80, 2, -ord("s"), 2)
    wave_data = struct.pack("<hhhh", 100, -100, 200, -50)
    spec_data = struct.pack(
        "<ii",
        (16383 << 15) | 300,
        (100 << 15) | 5000,
    )
    path.write_bytes(
        header + mip_headers + wave_data + spec_data
    )


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


def subprocess_run(command: list[str]) -> None:
    import subprocess

    result = subprocess.run(command, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.decode("utf-8", errors="replace"))


if __name__ == "__main__":
    unittest.main()
