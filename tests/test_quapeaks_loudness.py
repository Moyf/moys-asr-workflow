"""quapeaks 响度层 → 整文件响度统计（``moy.asr.loudness.v1``）的读取契约。

这个 payload 是编辑器给波形定垂直缩放的唯一依据，所以本文件钉的是**语义**而不
只是"能不能跑通"：

- 值必须是线性满量程 RMS（0..1），既不是 dB 也不是 peak；
- 跨声道必须逐桶取最响的声道，不能只看声道 0；
- 必须取最细那一层（40 桶/秒），拿粗层会让 p95 退化等于 max；
- 缺层 / 全静音一律降级成 None 或全零，前端据此保持用户原来的手动振幅。

合成容器刻意手搓字节（不依赖 ffmpeg 与真媒体），这样"左声道全静音、右声道才响"
这种真机 fixture 里不存在的形状也能覆盖到。

RPKN 全局头布局（见 ``ReapeaksFile.__init__``）：``[0:4]`` magic、``[4]``
channels、**``[5]`` mipmap_count**、``[6:18]`` sampleRate / srcTimestamp /
srcFilesize。写错一位就会把 mipmap 表当成数据，症状是 struct.error。
"""

import math
import struct
import tempfile
import unittest
from pathlib import Path

from maw import quapeaks

TEST_DATA_DIR = Path(__file__).resolve().parent / "test_data"
MONO = TEST_DATA_DIR / "tone_selfwave.wav.quapeaks"
STEREO = TEST_DATA_DIR / "tone_stereo_selfwave.wav.quapeaks"
REAPER_48K = TEST_DATA_DIR / "tone_48k.wav.ReaPeaks"

# fixture 是 8 kHz 方波，幅值 11000/32768；方波的 RMS 等于峰值，
# 所以响度层的 max 必须和这个数对上 —— 这是两个实现之间的交叉核对。
SQUARE_RMS = 11000.0 / 32768.0


_DIV = quapeaks.DIV_LOUDNESS


def _loudness_body(channels: int, values_per_channel: list[list[float]]) -> bytes:
    """按 _read_loudness 的读取顺序（逐峰、峰内逐声道）铺 f32。"""
    count = len(values_per_channel[0])
    assert all(len(values) == count for values in values_per_channel), "各声道峰数必须一致"
    buf = bytearray(struct.pack("<ii", _DIV, count))
    for index in range(count):
        for channel in range(channels):
            buf += struct.pack("<f", values_per_channel[channel][index])
    return bytes(buf)


class LoudnessLayerAccessTests(unittest.TestCase):
    def setUp(self):
        # 本机 TEMP 可能是相对路径，必须 resolve()，否则写文件落到 CWD 之外。
        self._td = tempfile.TemporaryDirectory()
        self.temp_dir = Path(self._td.name).resolve()
        self.addCleanup(self._td.cleanup)
        self.media = self.temp_dir / "tone_selfwave.wav"
        self.media.write_bytes(b"placeholder-for-signature")

    @unittest.skipUnless(MONO.exists(), "fixture 缺失：tone_selfwave.wav.quapeaks")
    def test_loudness_mipmaps_are_exposed(self):
        ra = quapeaks.ReapeaksFile(str(MONO))
        layers = ra.loudness_mipmaps()
        self.assertEqual([mip.peak_count for mip in layers], [81, 4])
        for mip in layers:
            self.assertEqual(mip.division_factor, quapeaks.DIV_LOUDNESS)
            self.assertEqual(mip.division_factor, -114)
            self.assertEqual(mip.kind, "loudness")

    @unittest.skipUnless(MONO.exists(), "fixture 缺失：tone_selfwave.wav.quapeaks")
    def test_stats_cross_check_against_the_wave_layer_peak(self):
        """方波的 RMS == 峰值，所以响度 max 必须精确等于 wave 层的满幅比例。"""
        stats = quapeaks.extract_loudness_stats(MONO, self.media)
        self.assertIsNotNone(stats)
        self.assertEqual(stats["schema"], "moy.asr.loudness.v1")
        self.assertAlmostEqual(stats["max"], SQUARE_RMS, places=5)
        # 取的是最细那层（81 桶），不是 4 桶的粗层
        self.assertEqual(stats["bin_count"], 81)

    @unittest.skipUnless(MONO.exists(), "fixture 缺失：tone_selfwave.wav.quapeaks")
    def test_silent_edges_pull_the_mean_just_below_the_tone_level(self):
        """fixture 首尾各有一桶静音，所以 mean 略低于 max，但差距只有 1% 量级。

        这条是"电平基本恒定"的正向证据：若哪天 mean/max 差出一个量级，说明
        选层或声道合并被改坏了。
        """
        stats = quapeaks.extract_loudness_stats(MONO, self.media)
        self.assertAlmostEqual(stats["max"], SQUARE_RMS, places=5)
        for key in ("p95", "rms", "mean"):
            self.assertGreater(stats[key], stats["max"] * 0.97, key)
            self.assertLessEqual(stats[key], stats["max"], key)

    @unittest.skipUnless(STEREO.exists(), "fixture 缺失：tone_stereo_selfwave.wav.quapeaks")
    def test_stereo_fixture_matches_the_mono_one(self):
        """两个 fixture 幅值相同，只是声道数不同 → 合并后的统计必须一致。"""
        mono = quapeaks.extract_loudness_stats(MONO, self.media)
        stereo = quapeaks.extract_loudness_stats(STEREO, self.media)
        self.assertEqual(mono["channels"], 1)
        self.assertEqual(stereo["channels"], 2)
        for key in ("max", "p95", "rms", "mean"):
            self.assertAlmostEqual(mono[key], stereo[key], places=6)

    @unittest.skipUnless(REAPER_48K.exists(), "fixture 缺失：tone_48k.wav.ReaPeaks")
    def test_reaper_native_container_is_readable_too(self):
        """读取端不能只认 QPK1：REAPER 自己产出的 RPKN 同样有响度层。"""
        ra = quapeaks.ReapeaksFile(str(REAPER_48K))
        self.assertFalse(ra.is_quapeaks)
        self.assertEqual([mip.peak_count for mip in ra.loudness_mipmaps()], [400, 20])
        stats = quapeaks.extract_loudness_stats(REAPER_48K, self.media)
        self.assertEqual(stats["bin_count"], 400)
        self.assertLess(stats["mean"], stats["max"], "真机素材电平有起伏，均值不该等于峰值")


class LoudnessChannelMergeTests(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.temp_dir = Path(self._td.name).resolve()
        self.addCleanup(self._td.cleanup)
        self.media = self.temp_dir / "dualmono.wav"
        self.media.write_bytes(b"placeholder-for-signature")

    def _container(self, name: str, channels: int, values_per_channel, *, div=_DIV) -> Path:
        path = self.temp_dir / name
        header = struct.pack("<4sBBiii", b"RPKN", channels, 1, 8000, 1700000000, 100)
        body = _loudness_body(channels, values_per_channel)
        if div != _DIV:  # 覆盖旧 token 时才改头部那个 i
            count = len(values_per_channel[0])
            body = struct.pack("<ii", div, count) + body[8:]
        path.write_bytes(header + body)
        return path

    def test_quiet_channel_zero_does_not_drag_the_scale_down(self):
        """广播/游戏素材常见的双单声道：人声只在右声道。

        只看声道 0 会得到一条接近静音的标尺，前端据此把振幅拉到上限，画面糊成
        一片 —— 与 PR #102 里"波形画成形同静音的直线"是同一类错而不显。
        """
        container = self._container(
            "dualmono.wav.ReaPeaks", 2, [[0.0] * 10, [0.5] * 10]
        )
        stats = quapeaks.extract_loudness_stats(container, self.media)
        self.assertEqual(stats["channels"], 2, "前提：容器头确实被读成双声道")
        for key in ("max", "p95", "rms", "mean"):
            self.assertAlmostEqual(stats[key], 0.5, places=6, msg=key)

    def test_per_bin_max_beats_a_flat_average_across_channels(self):
        """逐桶取 max：两声道交替满幅时，每一桶的电平都该是 1.0。

        若实现先把两声道平均再统计，得到的是 0.5 —— 整条标尺会小一倍。
        """
        left = [1.0, 0.0, 1.0, 0.0]
        right = [0.0, 1.0, 0.0, 1.0]
        container = self._container("alt.wav.ReaPeaks", 2, [left, right])
        stats = quapeaks.extract_loudness_stats(container, self.media)
        for key in ("max", "p95", "rms", "mean"):
            self.assertAlmostEqual(stats[key], 1.0, places=6, msg=key)

    def test_old_loudness_token_is_accepted(self):
        """历史上响度层用过 -'l' token，读旧缓存不能因为 token 不同就没数据。"""
        container = self._container(
            "old.wav.ReaPeaks", 1, [[0.25] * 6], div=quapeaks.DIV_LOUDNESS_OLD
        )
        stats = quapeaks.extract_loudness_stats(container, self.media)
        self.assertEqual(stats["bin_count"], 6)
        self.assertAlmostEqual(stats["max"], 0.25, places=6)


class LoudnessStatisticTests(unittest.TestCase):
    """四个标量各自的算法口径，用一组人造的等差序列钉死。"""

    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.temp_dir = Path(self._td.name).resolve()
        self.addCleanup(self._td.cleanup)
        self.media = self.temp_dir / "ramp.wav"
        self.media.write_bytes(b"placeholder-for-signature")
        # 0.05 .. 1.00 共 20 桶
        self.values = [index / 20.0 for index in range(1, 21)]
        path = self.temp_dir / "ramp.wav.ReaPeaks"
        header = struct.pack("<4sBBiii", b"RPKN", 1, 1, 8000, 1700000000, 100)
        path.write_bytes(header + _loudness_body(1, [self.values]))
        self.container = path

    def test_four_stats_use_their_documented_definitions(self):
        stats = quapeaks.extract_loudness_stats(self.container, self.media)
        values = self.values
        n = len(values)
        # places=6 而不是更高：响度层按 f32 存，写进去的 0.05..1.00 本身就已经
        # 被 float32 量化过一次（约 7 位有效数字），再往下比是在测 Python 的
        # 求和顺序，不是测这段代码。
        self.assertAlmostEqual(stats["max"], max(values), places=6)
        self.assertAlmostEqual(stats["mean"], sum(values) / n, places=6)
        self.assertAlmostEqual(
            stats["rms"], math.sqrt(sum(v * v for v in values) / n), places=6
        )
        # 高分位数按 nearest-rank：rank = ceil(0.95 * 20) = 19 → 第 19 小 = 0.95
        self.assertAlmostEqual(stats["p95"], 0.95, places=6)

    def test_stats_are_full_scale_linear_not_dB(self):
        """值域必须仍是 0..1 的线性量。谁哪天在这里塞了 dB 变换，前端就会双份换算。"""
        stats = quapeaks.extract_loudness_stats(self.container, self.media)
        for key in ("max", "p95", "rms", "mean"):
            self.assertGreaterEqual(stats[key], 0.0, key)
            self.assertLessEqual(stats[key], 1.0, key)

    def test_finite_sample_needs_no_time_base(self):
        """响度层头部那个 -114 是 kind token，不是 division。

        本 payload 刻意只给整文件标量、不给时序列，所以前端拿不到也不需要
        时间刻度；一旦有人为了"顺手"把 abs(division_factor) 当峰率发布，就会
        重演 PR #102 的时间轴漂移。这条断言把"没有刻度字段"本身钉住。
        """
        stats = quapeaks.extract_loudness_stats(self.container, self.media)
        for forbidden in ("division", "sample_rate", "peaks_per_second"):
            self.assertNotIn(forbidden, stats, f"{forbidden} 会成为被误用的时间刻度")


class LoudnessDegradationTests(unittest.TestCase):
    """服务器只用 ``load_loudness_stats`` 这个公开入口，所以契约在它身上验。"""

    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.temp_dir = Path(self._td.name).resolve()
        self.addCleanup(self._td.cleanup)
        self.media = self.temp_dir / "plain.wav"
        self.media.write_bytes(b"placeholder-for-signature")

    def _sided_container(self, channels: int, values_per_channel) -> Path:
        """在媒体旁写 .ReaPeaks，头部带它真实的 mtime/size（指纹校验要过得去）。"""
        src = self.media.stat()
        header = struct.pack(
            "<4sBBiii", b"RPKN", channels, 1, 8000, int(src.st_mtime), src.st_size
        )
        path = self.media.with_name(self.media.name + ".ReaPeaks")
        path.write_bytes(header + _loudness_body(channels, values_per_channel))
        return path

    def test_load_returns_stats_for_a_matching_container(self):
        self._sided_container(1, [[0.4] * 12])
        stats = quapeaks.load_loudness_stats(self.media)
        self.assertIsNotNone(stats)
        self.assertEqual(stats["bin_count"], 12)
        self.assertAlmostEqual(stats["max"], 0.4, places=6)

    def test_load_swallows_a_truncated_container(self):
        """``extract_*`` 允许抛 struct.error，``load_*`` 必须永不抛。

        这与 load_spectral_payload / load_waveform_payload 是同一套分工；响度
        读不出来时编辑器只是不自动缩放，不该把整个页面带崩。
        """
        container = self._sided_container(1, [[0.3] * 20])
        raw = container.read_bytes()
        container.write_bytes(raw[: len(raw) - 17])
        with self.assertRaises(struct.error):
            quapeaks.extract_loudness_stats(container, self.media)
        self.assertIsNone(quapeaks.load_loudness_stats(self.media))

    def test_load_returns_none_when_the_media_fingerprint_moved(self):
        """媒体被改过（体积变了）→ 缓存的响度不再代表当前素材，必须拒用。"""
        self._sided_container(1, [[0.4] * 12])
        self.assertIsNotNone(quapeaks.load_loudness_stats(self.media))
        self.media.write_bytes(b"placeholder-for-signature-and-longer-by-far")
        self.assertIsNone(quapeaks.load_loudness_stats(self.media))

    def test_wave_only_container_has_no_loudness(self):
        """只有 wave 层的容器必须得到 None，而不是编造一个 0 让前端放大到顶。"""
        header = struct.pack("<4sBBiii", b"RPKN", 1, 1, 8000, 1700000000, 100)
        # v1.1 wave 峰是 int16 的 min/max 一对，每峰每声道 4 字节
        wave = struct.pack("<hhhh", -100, 100, -50, 50)
        container = self.temp_dir / "waveonly.wav.ReaPeaks"
        container.write_bytes(header + struct.pack("<ii", 26, 2) + wave)
        parsed = quapeaks.ReapeaksFile(str(container))
        self.assertEqual(parsed.loudness_mipmaps(), [])
        self.assertEqual(len(parsed.wave_mipmaps()), 1)
        self.assertIsNone(quapeaks.extract_loudness_stats(container, self.media))

    def test_all_silence_reports_zeros_without_raising(self):
        """全静音是合法输入，不是错误：返回全零，由前端决定不猜。"""
        container = self._loudness_only([[0.0] * 8])
        stats = quapeaks.extract_loudness_stats(container, self.media)
        self.assertEqual(stats["bin_count"], 8)
        for key in ("max", "p95", "rms", "mean"):
            self.assertEqual(stats[key], 0.0)

    def test_non_finite_bins_are_dropped(self):
        """NaN / Inf 必须整桶丢弃，不能混进统计。

        json.dumps 会把非有限值写成裸 NaN/Infinity 字面量，浏览器的
        JSON.parse 拒收整个 /api/waveform 响应，前端会陷入无限重试；
        所以必须在提取层丢掉，而不是等到序列化边界才爆。
        """
        container = self._loudness_only(
            [[float("nan"), 0.4, float("inf"), float("-inf"), 0.2]]
        )
        stats = quapeaks.extract_loudness_stats(container, self.media)
        self.assertEqual(stats["bin_count"], 2)
        self.assertAlmostEqual(stats["max"], 0.4, places=6)
        self.assertAlmostEqual(stats["p95"], 0.4, places=6)
        for key in ("mean", "rms", "max", "p95"):
            self.assertTrue(math.isfinite(stats[key]), key)

    def test_all_non_finite_bins_degrade_to_none(self):
        """全部桶都非有限等价于没有响度层：None，而不是 NaN 统计。"""
        container = self._loudness_only([[float("nan")] * 4])
        self.assertIsNone(quapeaks.extract_loudness_stats(container, self.media))
        self.assertIsNone(quapeaks.load_loudness_stats(self.media))

    def _loudness_only(self, values_per_channel) -> Path:
        path = self.temp_dir / "quiet.wav.ReaPeaks"
        header = struct.pack("<4sBBiii", b"RPKN", 1, 1, 8000, 1700000000, 100)
        path.write_bytes(header + _loudness_body(1, values_per_channel))
        return path

    def test_missing_container_degrades_to_none(self):
        self.assertIsNone(quapeaks.load_loudness_stats(self.temp_dir / "nope.wav"))


if __name__ == "__main__":
    unittest.main()
