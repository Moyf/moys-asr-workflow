"""c7b：生成侧产出 .quapeaks（含自研层）与 mopeaks 回退的端到端契约。

与 tests/test_reapeaks.py 的分工：那边管容器**解析**与 REAPER 兼容；这里管
"MAW 生成时把哪一层写到哪里、拿不到就退到哪"。生成相关用例都跑真 ffmpeg +
真内核（缺任一即 skip），因为回退链的价值恰恰在于跨进程的真实失败模式。
"""

from __future__ import annotations

import base64
import math
import shutil
import struct
import sys
import tempfile
import unittest
import wave
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import quapeaks as kernel  # noqa: E402  真内核，用来钉后缀常量同源
from maw import media_cache, mopeaks, quapeaks, waveform  # noqa: E402


HAS_FFMPEG = shutil.which("ffmpeg") is not None


def _make_tone(path: Path, *, seconds: float = 1.0, sample_rate: int = 8000) -> None:
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        frames = bytearray()
        for index in range(round(sample_rate * seconds)):
            value = round(math.sin(2 * math.pi * 440 * index / sample_rate) * 16_000)
            frames.extend(struct.pack("<h", value))
        output.writeframes(frames)


def _container_with_provenance(
    path: Path, *, magic: bytes, timestamp: int, filesize: int, self_layer: bool
) -> None:
    """手搓一个只含一层的容器，头部指纹由调用方指定（用来构造新鲜/过期对）。"""
    header = struct.pack("<4sBBiII", magic, 1, 1, 8000, timestamp, filesize)
    if self_layer:
        body = struct.pack("<ii", quapeaks.DIV_SELF_WAVE, 1)
        body += struct.pack("<II", 1000, 10) + b"\x00\x64"
    else:
        body = struct.pack("<ii", 80, 1) + struct.pack("<hh", 100, -100)
    path.write_bytes(header + body)


@unittest.skipUnless(HAS_FFMPEG, "ffmpeg is required")
class QuapeaksGenerationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.tone = self.root / "tone.wav"
        _make_tone(self.tone)
        self.payload = waveform.extract_waveform(self.tone, peaks_per_second=100)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def _self_peaks(self) -> tuple[int, int, bytes]:
        peaks = quapeaks.self_peaks_from_payload(self.payload)
        self.assertIsNotNone(peaks, "extract_waveform 的载荷必须能换成内核入参")
        assert peaks is not None
        return peaks

    def test_suffix_constant_shares_one_source_with_the_kernel(self) -> None:
        # 两边各写一份的话，改名时会出现"内核写 A、MAW 找 B"的静默哑火。
        self.assertEqual(quapeaks.QUAPEAKS_SUFFIX, kernel.FILE_SUFFIX)
        self.assertEqual(mopeaks.mopeaks_path(self.tone).name, "tone.wav.mopeaks")

    def test_exact_rate_is_taken_from_the_payload_not_the_rounded_rate(self) -> None:
        # PR #102 的口径：内核那一层要的是 (sample_rate, division)，不是取整峰率。
        sample_rate, division, peaks = self._self_peaks()
        self.assertEqual(sample_rate, self.payload["sample_rate"])
        self.assertEqual(division, self.payload["division"])
        self.assertEqual(waveform.waveform_peaks_per_second(self.payload), sample_rate / division)
        self.assertEqual(len(peaks), self.payload["peak_count"] * 2)

    def test_generated_container_carries_the_self_layer(self) -> None:
        generated = quapeaks.generate_for_media(self.tone, self_peaks=self._self_peaks())
        self.assertIsNotNone(generated)
        assert generated is not None
        self.assertEqual(generated.name, "tone.wav.quapeaks")
        parsed = quapeaks.ReapeaksFile(str(generated))
        self.assertTrue(parsed.is_quapeaks)
        self.assertEqual(parsed.format_version, ord("1"))
        kinds = [mip.kind for mip in parsed.mipmaps]
        self.assertIn("self_wave", kinds)
        self.assertIn("wave", kinds)
        # 自研层排在最末：内核刻意把它放在所有既有层之后，不扰动前序偏移。
        self.assertEqual(kinds.index("self_wave"), len(kinds) - 1)

    def test_self_layer_peaks_equal_the_python_pipeline_output(self) -> None:
        """内核那一层与 Python 提取必须给出同一批峰——两边没跑偏的唯一硬证据。"""
        generated = quapeaks.generate_for_media(self.tone, self_peaks=self._self_peaks())
        assert generated is not None
        layers = quapeaks.ReapeaksFile(str(generated)).self_wave_mipmaps()
        self.assertEqual(len(layers), 1)
        layer = layers[0].self_layer
        self.assertIsNotNone(layer)
        assert layer is not None
        self.assertEqual(layer.sample_rate, self.payload["sample_rate"])
        self.assertEqual(layer.division, self.payload["division"])
        self.assertEqual(len(layer.peaks), self.payload["peak_count"])
        raw = bytearray()
        for low, high in layer.peaks:
            raw += bytes((low & 0xFF, high & 0xFF))
        self.assertEqual(bytes(raw), base64.b64decode(self.payload["data"]))

    def test_cold_start_hits_container_without_extracting(self) -> None:
        """去内联工程冷启动：无内联、无 .mopeaks，读取链必须直接命中自研层。

        判别力：extract_waveform 一被调用就失败——"没有 [reapeaks] 生成日志"
        证明不了没重抽，因为 Python 自研波形提取根本不打这条日志。
        """
        generated = quapeaks.generate_for_media(self.tone, self_peaks=self._self_peaks())
        self.assertIsNotNone(generated)

        def _must_not_extract(*args: object, **kwargs: object) -> dict[str, object]:
            raise AssertionError("有有效 .quapeaks 自研层时不得走 FFmpeg 重抽")

        with mock.patch.object(waveform, "extract_waveform", _must_not_extract):
            payload, extracted = waveform.load_or_extract_waveform(
                None, self.tone, peaks_per_second=self.payload["peaks_per_second"]
            )
        self.assertFalse(extracted)
        self.assertEqual(payload["data"], self.payload["data"])
        self.assertEqual(payload["audio_track"], 0)
        self.assertEqual(payload["source"], waveform.media_signature(self.tone))
        self.assertFalse(
            mopeaks.mopeaks_path(self.tone).exists(),
            "命中容器自研层时不得新建 .mopeaks 回退档",
        )

    def test_resolution_mismatch_falls_through_to_extraction(self) -> None:
        generated = quapeaks.generate_for_media(self.tone, self_peaks=self._self_peaks())
        self.assertIsNotNone(generated)
        calls: list[int] = []

        def _fake_extract(media_path: object, *, peaks_per_second: int, **kwargs: object) -> dict[str, object]:
            calls.append(peaks_per_second)
            return {**self.payload, "peaks_per_second": peaks_per_second}

        with mock.patch.object(waveform, "extract_waveform", _fake_extract):
            payload, extracted = waveform.load_or_extract_waveform(
                None, self.tone, peaks_per_second=50
            )
        self.assertTrue(extracted)
        self.assertEqual(calls, [50])
        self.assertEqual(payload["peaks_per_second"], 50)
        self.assertTrue(
            mopeaks.mopeaks_path(self.tone).exists(), "重抽后回退档照常落盘"
        )

    def test_track_mismatch_does_not_cross_hit_other_track_container(self) -> None:
        """第 0 轨读取不得命中第 2 轨的容器。

        单轨媒体解不出第 2 轨，无法走真实生成；按 _container_with_provenance
        的字节口径手搓一份 track-2 容器，头部指纹对齐当前媒体。
        """
        st = self.tone.stat()
        header = struct.pack(
            "<4sBBiII", b"QPK1", 1, 1, 8000,
            int(st.st_mtime) & 0xFFFF_FFFF, st.st_size & 0xFFFF_FFFF,
        )
        body = struct.pack("<ii", quapeaks.DIV_SELF_WAVE, 1)
        body += struct.pack("<II", 1000, 10) + b"\x00\x64"
        (self.root / "tone.wav.track-2.quapeaks").write_bytes(header + body)

        hit = quapeaks.load_self_wave_payload(self.tone, audio_track=1)
        self.assertIsNotNone(hit)
        assert hit is not None
        self.assertEqual(hit["audio_track"], 1)
        self.assertEqual(hit["sample_rate"], 1000)
        self.assertEqual(hit["division"], 10)

        miss = quapeaks.load_self_wave_payload(self.tone, audio_track=0)
        self.assertIsNone(miss, "非本轨的容器不得被当作本轨缓存")

    def test_self_wave_container_is_found_for_the_reader_chain(self) -> None:
        generated = quapeaks.generate_for_media(self.tone, self_peaks=self._self_peaks())
        assert generated is not None
        self.assertEqual(quapeaks.find_self_wave_container(self.tone), generated)

    def test_container_without_self_layer_does_not_count(self) -> None:
        # 只生成波峰层（没传 self_peaks）→ 判据仍回答"没有"，回退档该写。
        quapeaks.generate_for_media(self.tone)
        self.assertIsNone(quapeaks.find_self_wave_container(self.tone))


@unittest.skipUnless(HAS_FFMPEG, "ffmpeg is required")
class MopeaksFallbackTests(unittest.TestCase):
    """四条成因（未选内核 / import 失败 / 内核抛错 / 产物自检不过）都落到 mopeaks。"""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.tone = self.root / "tone.wav"
        _make_tone(self.tone)
        self.project: dict = {"media": str(self.tone), "segments": []}

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def _assert_fell_back(self, result, *, container_absent: bool = True) -> None:
        self.assertEqual((self.root / "tone.wav.quapeaks").exists(), not container_absent)
        path = mopeaks.mopeaks_path(self.tone)
        self.assertTrue(path.exists(), "自研波形必须仍有二进制缓存可落")
        cached = mopeaks.load_mopeaks(self.tone)
        self.assertIsNotNone(cached)
        assert cached is not None
        embedded = result.project["waveform"]
        # 回退档与工程内联的那份必须是同一批峰
        self.assertEqual(cached["data"], embedded["data"])
        self.assertEqual(cached["source"], embedded["source"])

    def test_missing_kernel_falls_back_via_media_cache(self) -> None:
        with mock.patch.dict(sys.modules, {"quapeaks": None}):
            result = media_cache.embed_media_caches(self.project, self.tone)
        self.assertIsNotNone(result.project.get("waveform"))
        self.assertIsNone(result.reapeaks_path)
        self._assert_fell_back(result)

    def test_kernel_error_falls_back_via_media_cache(self) -> None:
        with mock.patch.object(
            quapeaks, "generate_reapeaks_stream_bytes", side_effect=RuntimeError("内核炸了")
        ):
            result = media_cache.embed_media_caches(self.project, self.tone)
        self.assertIsNone(result.reapeaks_path)
        self._assert_fell_back(result)

    def test_artifact_failing_self_check_yields_no_container(self) -> None:
        # 内核"成功"返回了一个没有自研层的 RPKN 产物：等于这一档不成立。
        bogus = struct.pack("<4sBBiII", b"RPKN", 1, 1, 8000, 1, 1) + struct.pack("<ii", 80, 1)
        bogus += struct.pack("<hh", 100, -100)
        with mock.patch.object(
            quapeaks, "generate_reapeaks_stream_bytes", return_value=bogus
        ):
            generated = quapeaks.generate_for_media(
                self.tone, self_peaks=(1000, 10, b"\x00\x64")
            )
        self.assertIsNone(generated)
        self.assertIsNone(quapeaks.find_self_wave_container(self.tone))
        # 自检不过的文件留在盘上（不悄悄删用户媒体目录里的东西），但不被当成有效容器；
        # 于是编排层该写 mopeaks。
        self.assertTrue((self.root / "tone.wav.quapeaks").exists())
        with mock.patch.object(
            quapeaks, "generate_reapeaks_stream_bytes", return_value=bogus
        ):
            result = media_cache.embed_media_caches(self.project, self.tone)
        self.assertTrue(mopeaks.mopeaks_path(self.tone).exists())
        self._assert_fell_back(result, container_absent=False)

    def test_existing_valid_mopeaks_is_not_rewritten(self) -> None:
        with mock.patch.dict(sys.modules, {"quapeaks": None}):
            media_cache.embed_media_caches(self.project, self.tone)
            path = mopeaks.mopeaks_path(self.tone)
            first = path.read_bytes()
            mtime = path.stat().st_mtime_ns
            media_cache.embed_media_caches(self.project, self.tone)
            self.assertEqual(path.read_bytes(), first)
            self.assertEqual(path.stat().st_mtime_ns, mtime, "已有有效回退档就不该白写一遍")

    def test_no_self_peaks_means_no_fallback_file(self) -> None:
        # 波形都没抽出来时不该凭空造缓存。
        missing = self.root / "nothing.wav"
        with mock.patch.dict(sys.modules, {"quapeaks": None}):
            result = media_cache.embed_media_caches(self.project, missing)
        self.assertIsNotNone(result.waveform_error)
        self.assertFalse(mopeaks.mopeaks_path(missing).exists())


class FindReapeaksPreferenceTests(unittest.TestCase):
    """容器发现：过期的一方不得挡住新鲜的一方。"""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.tone = self.root / "tone.wav"
        self.tone.write_bytes(b"RIFF" + b"\x00" * 40)
        st = self.tone.stat()
        self.fresh = (int(st.st_mtime), st.st_size)
        self.stale = (int(st.st_mtime), st.st_size + 999)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def _write(self, name: str, magic: bytes, stamp: tuple[int, int], self_layer: bool) -> None:
        _container_with_provenance(
            self.root / name,
            magic=magic,
            timestamp=stamp[0],
            filesize=stamp[1],
            self_layer=self_layer,
        )

    def test_prefers_the_container_whose_header_matches_the_media(self) -> None:
        # 过期的 .quapeaks（还带着自研层）不能挡住 REAPER 新鲜产出的 .ReaPeaks。
        self._write("tone.wav.quapeaks", b"QPK1", self.stale, True)
        self._write("tone.wav.ReaPeaks", b"RPKN", self.fresh, False)
        found = quapeaks.find_reapeaks(self.tone)
        self.assertEqual(found, self.root / "tone.wav.ReaPeaks")

    def test_native_container_wins_when_both_are_fresh(self) -> None:
        self._write("tone.wav.quapeaks", b"QPK1", self.fresh, True)
        self._write("tone.wav.ReaPeaks", b"RPKN", self.fresh, False)
        found = quapeaks.find_reapeaks(self.tone)
        # .quapeaks 候选经 waveform_dirs（已 resolve 成长名），期望值同口径展开，
        # 避免 CI 的 8.3 短名 TEMP（RUNNER~1）拼写不一致。
        self.assertEqual(found, (self.root / "tone.wav.quapeaks").resolve())
        self.assertEqual(quapeaks.find_self_wave_container(self.tone), found)

    def test_falls_back_to_the_first_existing_when_all_are_stale(self) -> None:
        # 保持既有语义：都不匹配时仍返回一个路径，由调用方的签名校验决定降级。
        self._write("tone.wav.ReaPeaks", b"RPKN", self.stale, False)
        self.assertEqual(quapeaks.find_reapeaks(self.tone), self.root / "tone.wav.ReaPeaks")
        self.assertIsNone(quapeaks.find_self_wave_container(self.tone))

    def test_mopeaks_is_not_treated_as_a_peaks_container(self) -> None:
        # 混进来会挡住 .ReaPeaks 的频谱染色：mopeaks 由 maw.mopeaks 自己管。
        self._write("tone.wav.mopeaks", b"MPK1", self.fresh, True)
        self.assertIsNone(quapeaks.find_reapeaks(self.tone))
        # 但回退档自己当然读得动它。
        self.assertIsNotNone(
            mopeaks.decode_mopeaks((self.root / "tone.wav.mopeaks").read_bytes())
        )

    def test_reaper_uppercase_variants_still_discovered(self) -> None:
        # 这条原先断言精确拼法，在 macOS 上必炸：默认 APFS 与 NTFS 一样**大小写不敏感
        # 但保留大小写**，.ReaPeaks 与 .REAPEAKS 是同一个文件，find_reapeaks 按候选
        # 顺序先命中 .ReaPeaks 就返回那个拼法；而 PurePosixPath 的比较又是大小写**敏感**
        # 的，于是断言失败。Windows 同样不敏感却看不出来，因为 WindowsPath.__eq__
        # 自己忽略大小写。Linux 真区分大小写，所以也只有它走到 .REAPEAKS 分支。
        # 这条要保的是"大写变体也能被发现"，拼法不是它该钉的东西。
        self._write("tone.wav.REAPEAKS", b"RPKN", self.fresh, False)
        found = quapeaks.find_reapeaks(self.tone)
        self.assertIsNotNone(found)
        assert found is not None
        self.assertEqual(found.name.lower(), "tone.wav.reapeaks")
        self.assertTrue(found.is_file(), "返回的必须是真实存在的文件")



class SpectralCapabilityFilterTests(unittest.TestCase):
    """review 第 4 项：候选要先按能力过滤，再比新鲜度。"""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.tone = self.root / "tone.wav"
        self.tone.write_bytes(b"RIFF" + b"\x00" * 40)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def _container(self, name: str, *, spectral: bool) -> Path:
        """手搓一份合法容器：wave 层 + 可选 spectral 层，指纹指向当前媒体。"""
        st = self.tone.stat()
        layers = 2 if spectral else 1
        head = struct.pack("<4sBBiII", b"RPKN", 1, layers, 8000,
                           int(st.st_mtime) & 0xFFFF_FFFF, st.st_size & 0xFFFF_FFFF)
        table = struct.pack("<ii", 80, 1)
        wave = struct.pack("<hh", 100, -100)
        if spectral:
            table += struct.pack("<ii", -ord("s"), 1)
            wave += struct.pack("<ii", 1000, 1)
        path = self.root / name
        path.write_bytes(head + table + wave)
        return path

    def test_wave_only_native_container_does_not_shadow_spectral_cache(self) -> None:
        # 两份都新鲜（指纹都指向当前媒体），只有一份带 spectral 层。
        self._container("tone.wav.quapeaks", spectral=False)
        with_spec = self._container("tone.wav.ReaPeaks", spectral=True)
        # 不声明需求时，优先级仍是自有容器在前 —— 这条不变。
        plain = quapeaks.find_reapeaks(self.tone)
        assert plain is not None
        self.assertEqual(plain.name, "tone.wav.quapeaks")
        # 要频谱时必须落到带 spectral 的那份，否则频谱染色被静默短路。
        picked = quapeaks.find_reapeaks(self.tone, need_spectral=True)
        self.assertEqual(picked, with_spec)

    def test_load_spectral_payload_picks_the_usable_candidate(self) -> None:
        self._container("tone.wav.quapeaks", spectral=False)
        self._container("tone.wav.ReaPeaks", spectral=True)
        payload = quapeaks.load_spectral_payload(self.tone)
        self.assertIsNotNone(payload, "带 spectral 的候选被 wave-only 容器挡住时会返回 None")
        self.assertEqual(payload["peak_count"], 1)

    def test_no_spectral_candidate_at_all_is_a_miss_not_a_crash(self) -> None:
        self._container("tone.wav.quapeaks", spectral=False)
        self.assertIsNone(quapeaks.find_reapeaks(self.tone, need_spectral=True))
        self.assertIsNone(quapeaks.load_spectral_payload(self.tone))



class SameBasenameDifferentDirTests(unittest.TestCase):
    """review 第 2/6 项：源与派生媒体同名不同目录时，回退档必须跟解码方走。

    场景刻意让**源可用**：media_cache 优先解码源媒体，于是 decode_path = 源，
    payload["source"]["name"] 也就是 "tone.wav" —— 与派生文件的 name 相同。
    旧的 basename 猜法在这一步会错选 cache_path，把缓存写到派生目录去。
    """

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.src_dir = self.root / "src"
        self.cache_dir = self.root / "cache"
        self.src_dir.mkdir()
        self.cache_dir.mkdir()
        self.source_media = self.src_dir / "tone.wav"
        self.cache_media = self.cache_dir / "tone.wav"  # 同名，不同目录
        _make_tone(self.source_media)
        self.cache_media.write_bytes(b"RIFF" + b"\x00" * 40)
        self.payload = {
            "schema": waveform.WAVEFORM_SCHEMA,
            "encoding": waveform.WAVEFORM_ENCODING,
            "peaks_per_second": 100,
            "sample_rate": 1000,
            "division": 10,
            "peak_count": 1,
            "duration_ms": 10,
            "data": "AAA=",
            "source": waveform.media_signature(self.source_media),
        }

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def _run(self):
        from maw.waveform import EmbeddedWaveformResult

        seen: list = []

        def fake_embed(project, media_path, **kwargs):
            merged = dict(project)
            merged["waveform"] = self.payload
            return EmbeddedWaveformResult(project=merged, error=None)

        with mock.patch.object(media_cache, "embed_waveform", side_effect=fake_embed), \
            mock.patch.object(quapeaks, "generate_for_media", return_value=None), \
            mock.patch.object(quapeaks, "find_self_wave_container", return_value=None), \
            mock.patch.object(
                media_cache, "_persist_mopeaks_fallback",
                side_effect=lambda payload, media_path, **kw: seen.append(Path(media_path)),
            ):
            media_cache.embed_media_caches(
                {"media": str(self.source_media), "segments": []},
                self.cache_media,
                source_media_path=self.source_media,
            )
        return seen

    def test_fallback_follows_the_decoded_source_not_the_derived_sibling(self) -> None:
        seen = self._run()
        self.assertEqual(
            seen, [self.source_media],
            "解码的是源媒体，回退档就得写在源媒体旁；按 basename 猜会跑到派生目录去",
        )
        self.assertEqual(seen[0].name, "tone.wav")
        self.assertEqual(seen[0].parent, self.src_dir)
        self.assertNotEqual(seen[0].parent, self.cache_dir)


if __name__ == "__main__":
    unittest.main()
