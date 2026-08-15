# pyright: reportAny=false, reportImplicitOverride=false, reportUnknownArgumentType=false, reportUnusedCallResult=false, reportUnusedImport=false

from __future__ import annotations

import math
import shutil
import struct
import tempfile
import unittest
import wave
from pathlib import Path

import media_cache
import reapeaks_io as reapeaks

try:
    import numpy  # noqa: F401
    HAS_NUMPY = True
except ImportError:
    HAS_NUMPY = False


def _make_tone(path: Path) -> None:
    """1s 440Hz 单声道 wav。"""
    sample_rate = 8000
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        frames = bytearray()
        for i in range(sample_rate):
            value = round(math.sin(2 * math.pi * 440 * i / sample_rate) * 16_000)
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
    @unittest.skipUnless(HAS_NUMPY, "numpy is required")
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
    @unittest.skipUnless(HAS_NUMPY, "numpy is required")
    def test_embeds_spectral_when_explicitly_requested(self) -> None:
        result = media_cache.embed_media_caches(
            self.project,
            self.wav,
            generate_spectral=True,
        )

        self.assertIn("spectral", result.project)
        self.assertIsNotNone(reapeaks.load_spectral_payload(self.wav))

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is required")
    @unittest.skipUnless(HAS_NUMPY, "numpy is required")
    def test_test_mode_cache_uses_limited_media_but_keeps_source_signature(self) -> None:
        source = self.root / "source.mp4"
        cache_media = self.root / "limited.wav"
        # 测试模式把实际生成缓存的媒体放在临时文件，工程仍需记录原始媒体签名。
        shutil.copy2(self.wav, cache_media)
        source.write_bytes(b"original-media")

        result = media_cache.embed_media_caches(
            self.project,
            cache_media,
            source_media_path=source,
            generate_spectral=True,
        )

        self.assertEqual(result.project["waveform"]["source"], media_cache.media_signature(source))
        self.assertEqual(result.project["spectral"]["source"], media_cache.media_signature(source))
        self.assertEqual(result.project["waveform_reapeaks"]["source"], media_cache.media_signature(source))
        self.assertGreater(result.project["waveform"]["duration_ms"], 0)

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is required")
    @unittest.skipUnless(HAS_NUMPY, "numpy is required")
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
    @unittest.skipUnless(HAS_NUMPY, "numpy is required")
    def test_missing_media_degrades_to_warning(self) -> None:
        missing = self.root / "missing.mp3"
        result = media_cache.embed_media_caches(self.project, missing)
        self.assertIsNotNone(result.waveform_error)
        self.assertIsNone(result.reapeaks_path)
        # 工程未被篡改（无 waveform 键）
        self.assertNotIn("waveform", result.project)


if __name__ == "__main__":
    unittest.main()
