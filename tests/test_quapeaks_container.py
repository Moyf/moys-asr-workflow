"""quapeaks 自有容器与 MAW 自研波形层的解析契约。

fixture 由 quapeaks 内核真实产出（不是手搓字节），所以本文件同时是
**内核与解析器两个语言实现之间的一致性检查**：任一边改了布局而另一边没跟上，
这里就会红。

两个 fixture 是刻意配对的：
- tone_selfwave.wav.quapeaks     —— 单声道容器 + 单声道自研层
- tone_stereo_selfwave.wav.quapeaks —— **双声道容器** + 单声道自研层
第二个才是关键：若解析器按容器头 channels 循环读自研层，每峰会多吃 2 字节，
该层之后的偏移全错。只有单声道样本的话，这条 bug 检不出来。
"""

import struct
import tempfile
import unittest
from pathlib import Path

from maw import reapeaks

TEST_DATA_DIR = Path(__file__).resolve().parent / "test_data"
MONO = TEST_DATA_DIR / "tone_selfwave.wav.quapeaks"
STEREO = TEST_DATA_DIR / "tone_stereo_selfwave.wav.quapeaks"

MONO_PEAKS = [(-10, 10), (-20, 20), (-30, 30), (-40, 40), (-50, 50)]
STEREO_PEAKS = [(-11, 11), (-22, 22), (-33, 33), (-44, 44)]


def _only_self(ra: reapeaks.ReaPeaksFile):
    layers = ra.self_wave_mipmaps()
    assert len(layers) == 1, f"期望恰好一个自研层，实得 {len(layers)}"
    return layers[0]


class QuapeaksContainerTests(unittest.TestCase):
    @unittest.skipUnless(MONO.exists(), "fixture 缺失：tone_selfwave.wav.quapeaks")
    def test_container_is_recognised_as_quapeaks(self):
        ra = reapeaks.ReaPeaksFile(str(MONO))
        self.assertTrue(ra.is_quapeaks)
        self.assertEqual(ra.magic, b"QPK1")
        self.assertEqual(ra.format_version, ord("1"))
        self.assertFalse(ra.is_v12, "自有容器不得被当成 RPKL")

    @unittest.skipUnless(MONO.exists(), "fixture 缺失：tone_selfwave.wav.quapeaks")
    def test_self_wave_layer_is_decoded(self):
        ra = reapeaks.ReaPeaksFile(str(MONO))
        mip = _only_self(ra)
        self.assertEqual(mip.division_factor, reapeaks.DIV_SELF_WAVE)
        self.assertEqual(mip.division_factor, -109)
        self.assertEqual(mip.kind, "self_wave")
        self.assertIsNotNone(mip.self_layer)
        self.assertEqual(mip.self_layer.sample_rate, 500)
        self.assertEqual(mip.self_layer.division, 1)
        self.assertEqual(mip.self_layer.peaks, MONO_PEAKS)

    @unittest.skipUnless(MONO.exists(), "fixture 缺失：tone_selfwave.wav.quapeaks")
    def test_parse_consumes_whole_file(self):
        # 任何一层宽度算错都会留下尾巴或越界；这里要求严丝合缝。
        ra = reapeaks.ReaPeaksFile(str(MONO))
        self.assertEqual(ra.data_end, len(ra.data))

    @unittest.skipUnless(STEREO.exists(), "fixture 缺失：tone_stereo_selfwave.wav.quapeaks")
    def test_stereo_container_does_not_widen_self_layer(self):
        """自研层恒单声道：容器头 channels=2 时也不得按 2 声道读。"""
        ra = reapeaks.ReaPeaksFile(str(STEREO))
        self.assertEqual(ra.channels, 2, "前提：这是双声道容器")
        mip = _only_self(ra)
        self.assertEqual(mip.peak_count, len(STEREO_PEAKS), "峰数不能被声道数放大")
        self.assertEqual(mip.self_layer.peaks, STEREO_PEAKS)
        self.assertEqual(ra.data_end, len(ra.data), "多吃字节会让后续层偏移全错")
        # wave 层则必须按 2 声道读——两条规则不能互相污染
        finest = ra.wave_mipmaps()[0]
        self.assertTrue(finest.wave)
        self.assertTrue(all(len(row) == 2 for row in finest.wave), "wave 层应保持双声道")

    def test_self_token_under_reaper_magic_is_refused(self):
        """RPKN 里冒出 -'m' token 时必须报错，不能静默按自研层猜。"""
        peaks = bytes(v for lo, hi in MONO_PEAKS for v in (lo & 0xFF, hi & 0xFF))
        buf = bytearray(
            struct.pack(
                "<4sBBiii", b"RPKN", 1, 1, 8000, 1700000000, 100
            )
        )
        buf += struct.pack("<ii", reapeaks.DIV_SELF_WAVE, len(MONO_PEAKS))
        buf += struct.pack("<II", 500, 1) + peaks
        tmp = self.temp_dir / "fake.wav.ReaPeaks"
        tmp.write_bytes(bytes(buf))
        with self.assertRaises(ValueError) as ctx:
            reapeaks.ReaPeaksFile(str(tmp))
        self.assertIn("拒绝猜测", str(ctx.exception))

    @unittest.skipUnless(STEREO.exists(), "fixture 缺失：tone_stereo_selfwave.wav.quapeaks")
    def test_truncated_self_layer_reports_instead_of_crashing(self):
        """自研层被截断时给出可读 ValueError，而不是 struct.error 让调用方静默降级。

        刻意只截自研层自身：它前面的 wave/spectral/loudness 读取器没有边界守卫，
        截到那里只会得到 struct.error —— 那是既有行为，不在本次改动范围内，
        测试不能假装它顺带被修好了。
        """
        raw = STEREO.read_bytes()
        count = raw[5]
        self_div, self_npeak = struct.unpack_from("<ii", raw, 18 + 8 * (count - 1))
        self.assertEqual(self_div, reapeaks.DIV_SELF_WAVE, "前提：末层就是自研层")
        section_len = (
            reapeaks.SELF_WAVE_PREFIX_LEN + self_npeak * reapeaks.SELF_WAVE_BYTES_PER_PEAK
        )
        self_start = len(raw) - section_len

        for label, keep in (("截掉峰数据", section_len - 6), ("只留前缀", 4)):
            with self.subTest(label):
                tmp = self.temp_dir / "chopped.wav.quapeaks"
                tmp.write_bytes(raw[: self_start] + raw[self_start : self_start + keep])
                with self.assertRaises(ValueError) as ctx:
                    reapeaks.ReaPeaksFile(str(tmp))
                self.assertIn("自研波形层", str(ctx.exception))

    def setUp(self):
        # 本机 TEMP 可能是相对路径，必须 resolve()，否则写文件落到 CWD 之外。
        self._td = tempfile.TemporaryDirectory()
        self.temp_dir = Path(self._td.name).resolve()
        self.addCleanup(self._td.cleanup)


if __name__ == "__main__":
    unittest.main()
