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
import reapeaks

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
    def test_embeds_waveform_and_reapeaks(self) -> None:
        result = media_cache.embed_media_caches(self.project, self.wav)
        # 波形已嵌入工程
        self.assertIsNone(result.waveform_error)
        self.assertIn("waveform", result.project)
        self.assertGreater(result.project["waveform"]["peak_count"], 0)
        # ReaPeaks 频谱缓存已生成在媒体旁
        self.assertIsNotNone(result.reapeaks_path)
        self.assertTrue(Path(result.reapeaks_path).exists())
        self.assertEqual(Path(result.reapeaks_path).name, "tone.wav.ReaPeaks")
        # 可被只读路径解析
        payload = reapeaks.load_spectral_payload(self.wav)
        self.assertIsNotNone(payload)

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