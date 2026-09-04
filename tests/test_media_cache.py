# pyright: reportAny=false, reportImplicitOverride=false, reportUnknownArgumentType=false, reportUnusedCallResult=false, reportUnusedImport=false

from __future__ import annotations

import math
import shutil
import struct
import tempfile
import unittest
import wave
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from maw import media_cache, reapeaks

try:
    import numpy  # noqa: F401
    HAS_NUMPY = True
except ImportError:
    HAS_NUMPY = False


def _make_tone(
    path: Path, sample_rate: int = 8000, channels: int = 1, seconds: float = 1.0
) -> None:
    """指定采样率/声道/时长的单音 wav（默认 1s 440Hz 单声道 8 kHz）。"""
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        frames = bytearray()
        for i in range(round(sample_rate * seconds)):
            value = round(math.sin(2 * math.pi * 440 * i / sample_rate) * 16_000)
            for _ in range(channels):
                frames.extend(struct.pack("<h", value))
        wf.writeframes(frames)


class MediaCacheTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.wav = self.root / "tone.wav"
        _make_tone(self.wav)
        self.project: dict = {"media": str(self.wav), "segments": []}

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is required")
    def test_embeds_waveform_and_wave_only_reapeaks_by_default(self) -> None:
        result = media_cache.embed_media_caches(self.project, self.wav)
        # 波形已嵌入工程
        self.assertIsNone(result.waveform_error)
        self.assertIn("waveform", result.project)
        self.assertGreater(result.project["waveform"]["peak_count"], 0)
        # 默认只生成 ReaPeaks 波形层，不计算频谱。
        self.assertIsNotNone(result.reapeaks_path)
        self.assertTrue(Path(result.reapeaks_path).exists())
        self.assertEqual(Path(result.reapeaks_path).name, "tone.wav.ReaPeaks")
        self.assertNotIn("spectral", result.project)
        parsed = reapeaks.ReaPeaksFile(str(result.reapeaks_path))
        self.assertFalse(parsed.spectral_mipmaps())
        self.assertIn("wave", [m.kind for m in parsed.mipmaps])
        self.assertIsNotNone(reapeaks.load_waveform_payload(self.wav))

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is required")
    def test_embeds_spectral_when_explicitly_requested(self) -> None:
        result = media_cache.embed_media_caches(
            self.project,
            self.wav,
            generate_spectral=True,
        )

        self.assertIn("spectral", result.project)
        self.assertIsNotNone(reapeaks.load_spectral_payload(self.wav))

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is required")
    def test_caches_describe_source_media_not_the_derived_extraction(self) -> None:
        """缓存必须描述源媒体本身，而不是派生的 16 kHz / 截断提取音频。

        回归：本地 ASR 把视频抽成 16 kHz 单声道临时 wav 后交给缓存生成，
        .ReaPeaks 头部因此记下 16000 Hz —— 16 kHz 的最细层分频不整除采样率，
        取整后的峰率把整条波形时间轴按比例缩放（15 分钟约错开 1/3 秒），
        配合 --length-limit 时尾部还会完全没有数据。
        """
        source = self.root / "source.wav"
        _make_tone(source, sample_rate=48000, channels=2, seconds=3.0)
        derived = self.root / "prepared.wav"
        _make_tone(derived, sample_rate=16000, channels=1, seconds=1.0)

        result = media_cache.embed_media_caches(
            {"media": str(source), "segments": []},
            derived,
            source_media_path=source,
            generate_spectral=True,
        )

        reapeaks_wave = result.project["waveform_reapeaks"]
        spectral = result.project["spectral"]
        self.assertEqual(reapeaks_wave["sample_rate"], 48000)
        self.assertGreaterEqual(reapeaks_wave["duration_ms"], 2900)
        self.assertGreaterEqual(result.project["waveform"]["duration_ms"], 2900)
        self.assertEqual(spectral["sample_rate"], 48000)
        self.assertGreaterEqual(
            spectral["peak_count"] * spectral["division"] / spectral["sample_rate"] * 1000, 2900
        )
        for key in ("waveform", "spectral", "waveform_reapeaks"):
            self.assertEqual(
                result.project[key]["source"], media_cache.media_signature(source)
            )
        # 服务器只读路径必须接受这份缓存
        self.assertIsNotNone(reapeaks.load_waveform_payload(source))
        self.assertIsNotNone(reapeaks.load_spectral_payload(source))

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is required")
    def test_undecodable_source_falls_back_to_derived_with_actual_signature(self) -> None:
        """源媒体解不开时退回派生文件，但缓存签名必须描述实际解码文件。"""
        source = self.root / "source.mp4"
        cache_media = self.root / "limited.wav"
        shutil.copy2(self.wav, cache_media)
        source.write_bytes(b"original-media")

        result = media_cache.embed_media_caches(
            self.project,
            cache_media,
            source_media_path=source,
            generate_spectral=True,
        )

        derived_signature = media_cache.media_signature(cache_media)
        for key in ("waveform", "spectral", "waveform_reapeaks"):
            self.assertEqual(
                result.project[key]["source"], derived_signature
            )
        self.assertGreater(result.project["waveform"]["duration_ms"], 0)
        self.assertEqual(
            Path(result.reapeaks_path),
            cache_media.with_name(cache_media.name + ".ReaPeaks"),
        )
        # 退回派生文件后，缓存只能被派生文件接受，不能误用于源媒体。
        self.assertIsNotNone(reapeaks.load_waveform_payload(cache_media))
        self.assertIsNone(reapeaks.load_spectral_payload(source))
        self.assertIsNone(reapeaks.load_waveform_payload(source))

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is required")
    def test_reapeaks_cache_lands_next_to_source_media(self) -> None:
        """临时缓存媒体的 .ReaPeaks 必须落到源媒体旁并记录源签名。

        回归：CLI 把提取音频放在 TemporaryDirectory 里，with 块退出后目录
        即被删除；.ReaPeaks 若写在缓存媒体旁会随目录一起消失，源媒体旁永远
        没有频谱缓存，编辑器的频谱颜色与 ReaPeaks 波形层随之失效。
        """
        source = self.root / "source.mp4"
        shutil.copy2(self.wav, source)
        with tempfile.TemporaryDirectory() as tmp:
            cache_media = Path(tmp) / "audio.wav"
            shutil.copy2(self.wav, cache_media)
            result = media_cache.embed_media_caches(
                self.project,
                cache_media,
                source_media_path=source,
                generate_spectral=True,
            )
        # with 块已退出、临时目录已删除：源媒体旁必须留有可用缓存
        self.assertIsNotNone(result.reapeaks_path)
        self.assertEqual(
            Path(result.reapeaks_path), source.with_name(source.name + ".ReaPeaks")
        )
        self.assertTrue(Path(result.reapeaks_path).exists())
        # server 从源媒体旁读取时，头部签名必须匹配
        self.assertIsNotNone(reapeaks.load_spectral_payload(source))
        self.assertIsNotNone(reapeaks.load_waveform_payload(source))

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is required")
    def test_missing_media_degrades_to_warning(self) -> None:
        missing = self.root / "missing.mp3"
        result = media_cache.embed_media_caches(self.project, missing)
        self.assertIsNotNone(result.waveform_error)
        self.assertIsNone(result.reapeaks_path)
        # 工程未被篡改（无 waveform 键）
        self.assertNotIn("waveform", result.project)

    def test_explicit_ffmpeg_path_is_shared_by_both_cache_generators(self) -> None:
        ffmpeg = "C:/MAW/ffmpeg.exe"
        with (
            mock.patch(
                "maw.media_cache.embed_waveform",
                return_value=SimpleNamespace(project=self.project, error=None),
            ) as embed,
            mock.patch(
                "maw.media_cache.reapeaks.generate_for_media",
                return_value=None,
            ) as generate,
        ):
            media_cache.embed_media_caches(
                self.project,
                self.wav,
                ffmpeg_bin=ffmpeg,
            )

        embed.assert_called_once_with(self.project, self.wav, ffmpeg_bin=ffmpeg)
        generate.assert_called_once_with(
            self.wav,
            ffmpeg_bin=ffmpeg,
            include_spectral=False,
            source_media_path=self.wav,
        )


if __name__ == "__main__":
    unittest.main()
