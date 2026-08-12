# pyright: reportAny=false, reportImplicitOverride=false, reportUnknownArgumentType=false, reportUnusedCallResult=false, reportUnusedImport=false

from __future__ import annotations

import base64
import unittest
from pathlib import Path

import reapeaks

TEST_DATA_DIR = Path(__file__).resolve().parent / "test_data"


def _fixture_present(name: str) -> bool:
    return (TEST_DATA_DIR / name).is_file()


def _waveform_amps(reapeaks_path: Path, media_path: Path) -> tuple[int, list[int]]:
    """从 .ReaPeaks 提取最细 wave 层，返回 (peaks_per_second, 每峰振幅)。

    振幅 = max(|min|, |max|)，量化到 int8（与编辑器 i8-minmax 负载一致）。
    """
    payload = reapeaks.extract_waveform_payload(reapeaks_path, media_path)
    assert payload is not None
    raw = base64.b64decode(payload["data"])
    pps = payload["peaks_per_second"]
    amps: list[int] = []
    for i in range(0, len(raw), 2):
        low = raw[i] - 256 if raw[i] >= 128 else raw[i]
        high = raw[i + 1] - 256 if raw[i + 1] >= 128 else raw[i + 1]
        amps.append(max(abs(low), abs(high)))
    return pps, amps


class FixtureReaPeaksTests(unittest.TestCase):
    """用 REAPER 真机生成的 .ReaPeaks 验证解析器与 REAPER 格式兼容。

    fixture 流程：gen_fixtures.py 生成 wav → 用户在 REAPER 打开生成
    .ReaPeaks → 放回 tests/test_data/。文件缺失时这些用例自动 skip，
    不阻塞其余测试；放回后自动启用。内容设计见 FIXTURES.md。
    """

    @unittest.skipUnless(_fixture_present("tone30.wav.ReaPeaks"), "REAPER fixture missing: tone30")
    def test_tone30_parses_real_reaper_cache(self) -> None:
        ra = reapeaks.ReaPeaksFile(str(TEST_DATA_DIR / "tone30.wav.ReaPeaks"))
        self.assertEqual(ra.sample_rate, 44100)
        self.assertEqual(ra.channels, 1)
        kinds = [m.kind for m in ra.mipmaps]
        self.assertIn("wave", kinds)
        self.assertIn("spectral", kinds)
        wave_mips = ra.wave_mipmaps()
        self.assertTrue(wave_mips)
        # 30 分钟媒体，最细层应有足够多的峰值（远多于几百）
        self.assertGreater(wave_mips[0].peak_count, 1000)

    @unittest.skipUnless(_fixture_present("tone_dual.wav.ReaPeaks"), "REAPER fixture missing: tone_dual")
    def test_tone_dual_parses_stereo_layout(self) -> None:
        ra = reapeaks.ReaPeaksFile(str(TEST_DATA_DIR / "tone_dual.wav.ReaPeaks"))
        self.assertEqual(ra.channels, 2)
        wave_mips = ra.wave_mipmaps()
        self.assertTrue(wave_mips)
        # 每行 wave peak 应含 2 个声道
        self.assertEqual(len(wave_mips[0].wave[0]), 2)

    @unittest.skipUnless(_fixture_present("tone_48k.wav.ReaPeaks"), "REAPER fixture missing: tone_48k")
    def test_tone_48k_sample_rate(self) -> None:
        ra = reapeaks.ReaPeaksFile(str(TEST_DATA_DIR / "tone_48k.wav.ReaPeaks"))
        self.assertEqual(ra.sample_rate, 48000)

    @unittest.skipUnless(_fixture_present("tone30.wav.ReaPeaks"), "REAPER fixture missing: tone30")
    def test_tone30_waveform_shape_by_segments(self) -> None:
        """按内容段验证波形形状：静音段≈0，纯音/噪声段振幅饱满。

        内容设计见 FIXTURES.md：0-10s 静音 / 10-600s 200Hz / 600-900s 粉噪声 /
        900-1350s 1kHz / 1350-1790s 3kHz / 1790-1800s 静音。
        """
        pps, amps = _waveform_amps(
            TEST_DATA_DIR / "tone30.wav.ReaPeaks", TEST_DATA_DIR / "tone30.wav"
        )
        self.assertGreater(pps, 0)
        for start, end in ((0, 10), (1790, 1800)):
            seg = amps[int(start * pps):int(end * pps)]
            self.assertTrue(seg, f"静音段 {start}-{end}s 应有峰值样本")
            self.assertLessEqual(max(seg), 1, f"静音段 {start}-{end}s 振幅应≈0")
        for start, end, label in (
            (10, 600, "200Hz"),
            (600, 900, "粉噪声"),
            (900, 1350, "1kHz"),
            (1350, 1790, "3kHz"),
        ):
            seg = amps[int(start * pps):int(end * pps)]
            self.assertTrue(seg, f"{label} 段应有峰值样本")
            self.assertGreater(max(seg), 40, f"{label} 段振幅应饱满")
            nonzero = sum(1 for a in seg if a > 0)
            self.assertGreater(nonzero / len(seg), 0.8, f"{label} 段波形不应被压平")

    @unittest.skipUnless(_fixture_present("tone_dual.wav.ReaPeaks"), "REAPER fixture missing: tone_dual")
    def test_tone_dual_both_channels_have_amplitude(self) -> None:
        """双声道：左右声道各自应有非零振幅（左 1kHz 纯音，右 500Hz+噪声）。"""
        ra = reapeaks.ReaPeaksFile(str(TEST_DATA_DIR / "tone_dual.wav.ReaPeaks"))
        finest = ra.wave_mipmaps()[0]
        ch_amp = [0, 0]
        for row in finest.wave:
            for c, peak in enumerate(row):
                ch_amp[c] = max(ch_amp[c], abs(peak.max), abs(peak.min))
        self.assertGreater(ch_amp[0], 40, "左声道应有振幅")
        self.assertGreater(ch_amp[1], 40, "右声道应有振幅")

    @unittest.skipUnless(_fixture_present("tone_48k.wav.ReaPeaks"), "REAPER fixture missing: tone_48k")
    def test_tone_48k_waveform_has_amplitude(self) -> None:
        """48kHz：前 5s 440Hz 纯音 + 后 5s 白噪声，整体应有非零振幅。"""
        pps, amps = _waveform_amps(
            TEST_DATA_DIR / "tone_48k.wav.ReaPeaks", TEST_DATA_DIR / "tone_48k.wav"
        )
        self.assertGreater(max(amps), 40)


if __name__ == "__main__":
    unittest.main()