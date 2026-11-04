# pyright: reportAny=false, reportImplicitOverride=false, reportUnknownArgumentType=false, reportUnusedCallResult=false, reportUnusedImport=false

from __future__ import annotations

import base64
import importlib.util
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from maw import quapeaks

TEST_DATA_DIR = Path(__file__).resolve().parent / "test_data"

try:
    _spec = importlib.util.spec_from_file_location(
        "gen_fixtures", TEST_DATA_DIR / "gen_fixtures.py"
    )
    gen_fixtures = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(gen_fixtures)
    # gen_fixtures 顶层 import numpy；numpy 已移入 ocr 可选依赖，
    # 缺失时仅生成回归降级为 skip，不影响冻结 cache 解析。
    HAS_NUMPY = True
except ImportError:
    gen_fixtures = None
    HAS_NUMPY = False


def _fixture_present(name: str) -> bool:
    return (TEST_DATA_DIR / name).is_file()


def _waveform_amps(reapeaks_path: Path) -> tuple[int, list[int]]:
    """从 .ReaPeaks 提取最细 wave 层，返回 (peaks_per_second, 每峰振幅)。

    振幅 = max(|min|, |max|)，量化到 int8（与编辑器 i8-minmax 负载一致）。
    """
    # 此处只验证冻结 cache 的波形；source 仅需现存文件的 stat 元数据，
    # 不验证源媒体指纹，也不需要合成/解码源 WAV。
    payload = quapeaks.extract_waveform_payload(reapeaks_path, reapeaks_path)
    assert payload is not None
    raw = base64.b64decode(payload["data"])
    pps = payload["peaks_per_second"]
    amps: list[int] = []
    for i in range(0, len(raw), 2):
        low = raw[i] - 256 if raw[i] >= 128 else raw[i]
        high = raw[i + 1] - 256 if raw[i + 1] >= 128 else raw[i + 1]
        amps.append(max(abs(low), abs(high)))
    return pps, amps


class FixtureReapeaksTests(unittest.TestCase):
    """用 REAPER 真机生成的 .ReaPeaks 验证解析器与 REAPER 格式兼容。

    fixture 流程：gen_fixtures.py 生成 wav → 用户在 REAPER 打开生成
    .ReaPeaks → 放回 tests/test_data/。文件缺失时报告 skip，
    内容设计见 FIXTURES.md。

    解析与形状检查只读取已提交 cache，不生成源 WAV，因此不依赖
    NumPy、FFmpeg 或长媒体生成。
    """

    @unittest.skipUnless(_fixture_present("tone30.wav.ReaPeaks"), "REAPER fixture missing: tone30")
    def test_tone30_parses_real_reaper_cache(self) -> None:
        ra = quapeaks.ReapeaksFile(str(TEST_DATA_DIR / "tone30.wav.ReaPeaks"))
        self.assertEqual(ra.sample_rate, 44100)
        self.assertEqual(ra.channels, 1)
        kinds = [m.kind for m in ra.mipmaps]
        self.assertIn("wave", kinds)
        self.assertIn("spectral", kinds)
        wave_mips = ra.wave_mipmaps()
        self.assertTrue(wave_mips)
        # 30 分钟媒体，最细层应有足够多的峰值（远多于几百）
        self.assertGreater(wave_mips[0].peak_count, 1000)
        # 固定长 cache 保留全部粗层级的解析保障；短媒体不会产出这些层。
        self.assertEqual(
            [(mip.kind, mip.division_factor, mip.peak_count) for mip in ra.mipmaps],
            [
                ("wave", 147, 540000),
                ("wave", 2205, 36000),
                ("wave", 44100, 1800),
                ("spectral", -115, 539993),
                ("spectral", -115, 35999),
                ("spectral", -115, 1799),
                ("loudness", -114, 72000),
                ("loudness", -114, 3600),
            ],
        )

    @unittest.skipUnless(_fixture_present("tone_dual.wav.ReaPeaks"), "REAPER fixture missing: tone_dual")
    def test_tone_dual_parses_stereo_layout(self) -> None:
        ra = quapeaks.ReapeaksFile(str(TEST_DATA_DIR / "tone_dual.wav.ReaPeaks"))
        self.assertEqual(ra.channels, 2)
        wave_mips = ra.wave_mipmaps()
        self.assertTrue(wave_mips)
        # 每行 wave peak 应含 2 个声道
        self.assertEqual(len(wave_mips[0].wave[0]), 2)

    @unittest.skipUnless(_fixture_present("tone_48k.wav.ReaPeaks"), "REAPER fixture missing: tone_48k")
    def test_tone_48k_sample_rate(self) -> None:
        ra = quapeaks.ReapeaksFile(str(TEST_DATA_DIR / "tone_48k.wav.ReaPeaks"))
        self.assertEqual(ra.sample_rate, 48000)

    @unittest.skipUnless(_fixture_present("tone30.wav.ReaPeaks"), "REAPER fixture missing: tone30")
    def test_tone30_waveform_shape_by_segments(self) -> None:
        """按内容段验证波形形状：静音段≈0，纯音/噪声段振幅饱满。

        内容设计见 FIXTURES.md：0-10s 静音 / 10-600s 200Hz / 600-900s 粉噪声 /
        900-1350s 1kHz / 1350-1790s 3kHz / 1790-1800s 静音。
        """
        pps, amps = _waveform_amps(TEST_DATA_DIR / "tone30.wav.ReaPeaks")
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
        ra = quapeaks.ReapeaksFile(str(TEST_DATA_DIR / "tone_dual.wav.ReaPeaks"))
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
        pps, amps = _waveform_amps(TEST_DATA_DIR / "tone_48k.wav.ReaPeaks")
        self.assertGreater(max(amps), 40)


class GeneratedFixtureTests(unittest.TestCase):
    """验证 MAW 生成的 .quapeaks 与 REAPER 真机 fixture 保持兼容布局。

    测试流程：gen_fixtures.py 生成 wav → MAW 生成器生成 .quapeaks → 对比
    fixture 目录里的 REAPER 真机 .ReaPeaks。magic 和自研层是 MAW 扩展，
    其余头字段与共有层仍应兼容。
    """

    def _compare_reapeaks(self, name: str) -> None:
        fixture_path = TEST_DATA_DIR / f"{name}.wav.ReaPeaks"
        with tempfile.TemporaryDirectory(prefix="maw-reapeaks-") as directory:
            # 每条生成回归只构造一次源 WAV；临时目录隔离生成器/sidecar，
            # 不写入或恢复已提交的 REAPER cache 与用户本地源 WAV。
            gen_func = getattr(gen_fixtures, f"gen_{name}")
            with mock.patch.object(gen_fixtures, "OUT", Path(directory)):
                gen_func()
            wav = Path(directory) / f"{name}.wav"
            # MAW 生成 .quapeaks
            maw_reapeaks = quapeaks.generate_for_media(wav)
            self.assertIsNotNone(maw_reapeaks, f"MAW 生成 {name}.wav.quapeaks 失败")
            assert maw_reapeaks is not None
            generated = quapeaks.ReapeaksFile(str(maw_reapeaks))
            fixture = quapeaks.ReapeaksFile(str(fixture_path))
            self.assertEqual(generated.magic, b"QPK1")
            self.assertEqual(generated.channels, fixture.channels)
            self.assertEqual(generated.sample_rate, fixture.sample_rate)
            generated_shared = [mip for mip in generated.mipmaps if mip.kind != "self_wave"]
            self.assertEqual(
                [(mip.kind, mip.division_factor) for mip in generated_shared],
                [(mip.kind, mip.division_factor) for mip in fixture.mipmaps],
            )
            for index, (generated_mip, fixture_mip) in enumerate(
                zip(generated_shared, fixture.mipmaps)
            ):
                diff_ratio = abs(generated_mip.peak_count - fixture_mip.peak_count) / max(
                    generated_mip.peak_count, fixture_mip.peak_count, 1
                )
                self.assertLess(
                    diff_ratio,
                    0.1,
                    f"{name} mip{index} 峰数差异 {diff_ratio:.2%} > 10%",
                )

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is required")
    @unittest.skipUnless(HAS_NUMPY, "numpy is required")
    @unittest.skipUnless(_fixture_present("tone30.wav.ReaPeaks"), "REAPER fixture missing: tone30")
    def test_tone30_generated_matches_fixture(self) -> None:
        self._compare_reapeaks("tone30")

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is required")
    @unittest.skipUnless(HAS_NUMPY, "numpy is required")
    @unittest.skipUnless(_fixture_present("tone_dual.wav.ReaPeaks"), "REAPER fixture missing: tone_dual")
    def test_tone_dual_generated_matches_fixture(self) -> None:
        self._compare_reapeaks("tone_dual")

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is required")
    @unittest.skipUnless(HAS_NUMPY, "numpy is required")
    @unittest.skipUnless(_fixture_present("tone_48k.wav.ReaPeaks"), "REAPER fixture missing: tone_48k")
    def test_tone_48k_generated_matches_fixture(self) -> None:
        self._compare_reapeaks("tone_48k")


if __name__ == "__main__":
    unittest.main()
