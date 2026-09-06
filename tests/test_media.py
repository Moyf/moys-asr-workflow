from __future__ import annotations

import struct
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from maw import output_naming
from maw.media import (
    MediaConversionError,
    MediaStatus,
    _media_stem,
    convert_media_for_browser,
    probe_video_fps,
    read_bwf_time_reference,
    resolve_project_media,
)


def _patch_shared_maw() -> mock.patch:
    """固定输出目录开关，避免默认转换路径依赖开发者机器的 .env。"""
    return mock.patch.object(output_naming, "subfolder_prefs", return_value=(False, False))



def _write_bwf_wav(path: Path, sample_rate: int, time_reference_samples: int) -> None:
    fmt = struct.pack('<HHIIHH', 1, 1, sample_rate, sample_rate * 2, 2, 16)
    bext = bytearray(346)
    bext[338:346] = struct.pack('<II', time_reference_samples & 0xFFFFFFFF, time_reference_samples >> 32)
    data = bytes(4)
    chunks = (
        b'fmt ' + struct.pack('<I', len(fmt)) + fmt
        + b'bext' + struct.pack('<I', len(bext)) + bext
        + b'data' + struct.pack('<I', len(data)) + data
    )
    path.write_bytes(b'RIFF' + struct.pack('<I', 4 + len(chunks)) + b'WAVE' + chunks)


class MediaResolutionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name).resolve()
        self.project = self.root / "take.qwen3-asr-api.mosp"

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_project_media_field_has_priority(self) -> None:
        media = self.root / "elsewhere.mp4"
        media.write_bytes(b"media")
        result = resolve_project_media(self.project, {"media": str(media)})
        self.assertEqual(result.status, MediaStatus.SUCCESS)
        self.assertEqual(result.resolved_path, media)

    def test_reads_bwf_time_reference_from_wav(self) -> None:
        media = self.root / 'recording.wav'
        time_reference_samples = (2 << 32) + 8895762
        _write_bwf_wav(media, 48000, time_reference_samples)

        self.assertEqual(
            read_bwf_time_reference(media),
            {
                'sample_rate': 48000,
                'time_reference_samples': time_reference_samples,
            },
        )

    def test_ignores_non_bwf_wav_and_non_wav_files(self) -> None:
        wav = self.root / 'plain.wav'
        wav.write_bytes(b'RIFF' + bytes(4) + b'WAVE')
        mp3 = self.root / 'recording.mp3'
        mp3.write_bytes(b'not wav')

        self.assertIsNone(read_bwf_time_reference(wav))
        self.assertIsNone(read_bwf_time_reference(mp3))

    def test_probes_video_fps_and_preserves_ffprobe_ratio(self) -> None:
        media = self.root / "take.mp4"
        media.write_bytes(b"video")
        ffprobe = self.root / "ffprobe.exe"
        ffprobe.write_bytes(b"exe")
        completed = type(
            "Completed",
            (),
            {"stdout": '{"streams":[{"avg_frame_rate":"30000/1001","r_frame_rate":"30/1"}]}'}
        )()

        with mock.patch("maw.media.find_ffprobe", return_value=ffprobe):
            with mock.patch("maw.media.subprocess.run", return_value=completed) as process:
                metadata = probe_video_fps(media)

        self.assertIsNotNone(metadata)
        self.assertAlmostEqual(metadata["video_fps"], 30000 / 1001)
        self.assertEqual(metadata["video_fps_ratio"], "30000/1001")
        command = process.call_args.args[0]
        self.assertIn("-select_streams", command)
        self.assertIn("v:0", command)
        self.assertIn("stream=avg_frame_rate,r_frame_rate", command)
        self.assertIn("-of", command)
        self.assertIn("json", command)

    def test_probes_r_frame_rate_when_average_rate_is_unavailable(self) -> None:
        media = self.root / "take.mkv"
        media.write_bytes(b"video")
        completed = type(
            "Completed",
            (),
            {"stdout": '{"streams":[{"avg_frame_rate":"N/A","r_frame_rate":"24/1"}]}'}
        )()

        with mock.patch("maw.media.find_ffprobe", return_value=Path("ffprobe")):
            with mock.patch("maw.media.subprocess.run", return_value=completed):
                self.assertEqual(
                    probe_video_fps(media),
                    {"video_fps": 24.0, "video_fps_ratio": "24/1"},
                )

    def test_video_fps_probe_is_best_effort_when_tool_or_rate_is_unavailable(self) -> None:
        media = self.root / "take.mp4"
        media.write_bytes(b"video")
        with mock.patch("maw.media.find_ffprobe", return_value=None):
            with mock.patch("maw.media.subprocess.run") as process:
                self.assertIsNone(probe_video_fps(media))
        process.assert_not_called()

        completed = type("Completed", (), {"stdout": '{"streams":[]}'})()
        with mock.patch("maw.media.find_ffprobe", return_value=Path("ffprobe")):
            with mock.patch("maw.media.subprocess.run", return_value=completed):
                self.assertIsNone(probe_video_fps(media))

        audio = self.root / "take.wav"
        audio.write_bytes(b"audio")
        with mock.patch("maw.media.find_ffprobe", return_value=Path("ffprobe")):
            with mock.patch("maw.media.subprocess.run") as process:
                self.assertIsNone(probe_video_fps(audio))
        process.assert_not_called()

    def test_missing_project_media_falls_back_to_one_same_name_candidate(self) -> None:
        media = self.root / "take.flv"
        media.write_bytes(b"media")
        result = resolve_project_media(self.project, {"media": "D:/old/take.mp4"})
        self.assertEqual(result.status, MediaStatus.CONVERSION_NEEDED)
        self.assertEqual(result.resolved_path, media)

    def test_flv_prefers_adjacent_mp4(self) -> None:
        flv = self.root / "take.flv"
        mp4 = self.root / "take.mp4"
        flv.write_bytes(b"flv")
        mp4.write_bytes(b"mp4")

        result = resolve_project_media(self.project, {"media": str(flv)})

        self.assertEqual(result.status, MediaStatus.SUCCESS)
        self.assertEqual(result.requested_path, flv)
        self.assertEqual(result.resolved_path, mp4)

    def test_multiple_same_name_candidates_report_conflict(self) -> None:
        (self.root / "take.mp4").write_bytes(b"mp4")
        (self.root / "take.wav").write_bytes(b"wav")
        result = resolve_project_media(self.project, {"media": "D:/old/take.mp4"})
        self.assertEqual(result.status, MediaStatus.CONFLICT)
        self.assertEqual([path.name for path in result.candidates], ["take.mp4", "take.wav"])

    def test_unknown_existing_extension_is_unsupported(self) -> None:
        media = self.root / "take.xyz"
        media.write_bytes(b"media")
        result = resolve_project_media(self.project, {"media": str(media)})
        self.assertEqual(result.status, MediaStatus.UNSUPPORTED)
        self.assertIsNone(result.resolved_path)

    def test_no_media_is_missing_without_scanning_other_stems(self) -> None:
        (self.root / "other.mp4").write_bytes(b"media")
        result = resolve_project_media(self.project, {"segments": []})
        self.assertEqual(result.status, MediaStatus.MISSING)
        self.assertFalse(result.candidates)

    def test_media_stem_strips_localized_operation_suffixes(self) -> None:
        # 两套语言的操作后缀都识别（小写匹配；中文不随 lower 变化）
        for name in (
            "clip.后处理.mp4",
            "clip.postprocess.mp4",
            "clip.OCR去重.mp4",
            "clip.ocr去重.mp4",
            "clip.ocr-dedup.mp4",
            "clip.匹配.wav",
            "clip.match.mp4",
            "Clip.PostProcess.mkv",
        ):
            self.assertEqual(_media_stem(name), "clip", name)
        # 中段形式的操作标记也截断（后处理中间产物常带双语等后缀）
        self.assertEqual(_media_stem("clip.后处理.双语.mp4"), "clip")
        self.assertEqual(_media_stem("clip.postprocess.bilingual.mp4"), "clip")
        # ASR 引擎既有标记只按中段截断（与历史语义一致），末段不误剥
        self.assertEqual(_media_stem("take.qwen3-asr.mp4"), "take.qwen3-asr")
        self.assertEqual(_media_stem("take.qwen3-asr-api.mosp"), "take.qwen3-asr-api")
        self.assertEqual(_media_stem("x.qwen3-asr.srt.mp4"), "x")
        # .translate- 不是操作后缀，不识别
        self.assertEqual(_media_stem("Take.translate.mp4"), "take.translate")
        # zh 界面翻译段（翻译为中文 / 翻译为英文）剥回原始主名，
        # 中段与 bilingual/combined 组合、紧跟主名的纯段都覆盖
        self.assertEqual(_media_stem("clip.翻译为中文.mosp"), "clip")
        self.assertEqual(_media_stem("clip.翻译为中文.bilingual.mosp"), "clip")
        self.assertEqual(_media_stem("clip.翻译为中文.combined.srt"), "clip")
        self.assertEqual(_media_stem("clip.翻译为英文.srt"), "clip")
        self.assertEqual(_media_stem("clip.后处理.翻译为中文.srt"), "clip")
        # zh 界面本地化组合标记（双语合一 / 整合）同样剥回原始主名：
        # 作为中段、紧跟翻译段后、或直接顶在扩展名前都覆盖。
        self.assertEqual(_media_stem("clip.翻译为中文.双语合一.mosp"), "clip")
        self.assertEqual(_media_stem("clip.翻译为中文.整合.srt"), "clip")
        self.assertEqual(_media_stem("clip.后处理.双语合一.mosp"), "clip")
        self.assertEqual(_media_stem("clip.双语合一.mosp"), "clip")
        self.assertEqual(_media_stem("clip.整合.srt"), "clip")
        self.assertEqual(_media_stem("clip.双语合一.翻译为中文.srt"), "clip")
        # 英文界面 / 旧版 .translate-* 命名保持不识别（与改动前一致）
        self.assertEqual(_media_stem("clip.translate-zh.mosp"), "clip.translate-zh")
        self.assertEqual(_media_stem("clip.translate-en-bilingual.srt"), "clip.translate-en-bilingual")
        # 标签要求有点边界：postprocess-foo 不会误剥
        self.assertEqual(_media_stem("clip.postprocess-foo.mp4"), "clip.postprocess-foo")

    def test_resolve_project_media_finds_localized_operation_named_media(self) -> None:
        """OCR 去重产物 clip.OCR去重.mp4 应能被同主名查找命中为 clip。"""
        media = self.root / "clip.OCR去重.mp4"
        media.write_bytes(b"media")
        result = resolve_project_media(self.project, {"media": "D:/old/clip.mp4"})
        self.assertEqual(result.status, MediaStatus.SUCCESS)
        self.assertEqual(result.resolved_path, media)

    def test_flv_conversion_uses_ffmpeg_and_caches_result(self) -> None:
        source = self.root / "take.flv"
        source.write_bytes(b"flv")
        ffmpeg = self.root / "ffmpeg.exe"
        ffmpeg.write_bytes(b"exe")
        cache = self.root / "cache"

        def run(command, **kwargs):
            output = Path(command[-1])
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(b"mp4")
            return type("Completed", (), {"returncode": 0, "stderr": "", "stdout": ""})()

        with mock.patch("maw.media.subprocess.run", side_effect=run) as process:
            result = convert_media_for_browser(source, ffmpeg_path=ffmpeg, cache_dir=cache)
            again = convert_media_for_browser(source, ffmpeg_path=ffmpeg, cache_dir=cache)

        self.assertEqual(result, again)
        self.assertEqual(result.read_bytes(), b"mp4")
        process.assert_called_once()

    def test_flv_conversion_defaults_to_maw_cache(self) -> None:
        source = self.root / "take.flv"
        source.write_bytes(b"flv")
        ffmpeg = self.root / "ffmpeg.exe"
        ffmpeg.write_bytes(b"exe")
        expected = self.root / "_maw" / "take.mp4"

        def run(command, **kwargs):
            output = Path(command[-1])
            output.write_bytes(b"mp4")
            return type("Completed", (), {"returncode": 0, "stderr": "", "stdout": ""})()

        with _patch_shared_maw():
            with mock.patch("maw.media.subprocess.run", side_effect=run) as process:
                result = convert_media_for_browser(source, ffmpeg_path=ffmpeg)

        self.assertEqual(result, expected)
        self.assertTrue(result.is_file())
        self.assertFalse(list(self.root.glob("take.part-*.mp4")))
        self.assertFalse(list((self.root / "_maw").glob("take.part-*.mp4")))
        self.assertEqual(Path(process.call_args.args[0][-1]).name, "take.part-0.mp4")
        process.assert_called_once()

    def test_flv_conversion_reuses_legacy_media_adjacent_cache(self) -> None:
        """旧位置媒体旁缓存兼容读取：存在有效 clip.mp4 时直接复用，不再转码。"""
        source = self.root / "take.flv"
        source.write_bytes(b"flv")
        legacy = self.root / "take.mp4"
        legacy.write_bytes(b"mp4")
        ffmpeg = self.root / "ffmpeg.exe"
        ffmpeg.write_bytes(b"exe")

        with _patch_shared_maw():
            with mock.patch("maw.media.subprocess.run") as process:
                result = convert_media_for_browser(source, ffmpeg_path=ffmpeg)

        self.assertEqual(result, legacy)
        process.assert_not_called()
        # 不迁移：_maw 里不复制新副本
        self.assertFalse((self.root / "_maw" / "take.mp4").exists())

    def test_flv_conversion_cleans_stale_part_files_when_adjacent_mp4_is_reusable(self) -> None:
        source = self.root / "take.flv"
        source.write_bytes(b"flv")
        output = self.root / "take.mp4"
        output.write_bytes(b"mp4")
        (self.root / "take.part-0.mp4").write_bytes(b"partial")
        (self.root / "take.part-123-456789-0.mp4").write_bytes(b"legacy")
        ffmpeg = self.root / "ffmpeg.exe"
        ffmpeg.write_bytes(b"exe")

        with mock.patch("maw.media.subprocess.run") as process:
            result = convert_media_for_browser(source, ffmpeg_path=ffmpeg)

        self.assertEqual(result, output)
        process.assert_not_called()
        self.assertFalse(list(self.root.glob("take.part-*.mp4")))

    def test_flv_conversion_rejects_nonzero_ffmpeg_output_and_cleans_temp(self) -> None:
        source = self.root / "take.flv"
        source.write_bytes(b"flv")
        ffmpeg = self.root / "ffmpeg.exe"
        ffmpeg.write_bytes(b"exe")

        def run(command, **kwargs):
            Path(command[-1]).write_bytes(b"partial")
            return type("Completed", (), {"returncode": 1, "stderr": "bad input", "stdout": ""})()

        with _patch_shared_maw():
            with mock.patch("maw.media.subprocess.run", side_effect=run) as process:
                with self.assertRaisesRegex(MediaConversionError, "退出码 1"):
                    convert_media_for_browser(source, ffmpeg_path=ffmpeg)

        self.assertFalse((self.root / "take.mp4").exists())
        self.assertFalse((self.root / "_maw" / "take.mp4").exists())
        self.assertFalse(list(self.root.glob("take.part-*.mp4")))
        self.assertFalse(list((self.root / "_maw").glob("take.part-*.mp4")))
        self.assertEqual(process.call_count, 2)

    def test_flv_conversion_reports_missing_ffmpeg(self) -> None:
        source = self.root / "take.flv"
        source.write_bytes(b"flv")
        with mock.patch("maw.media.find_ffmpeg", return_value=None):
            with self.assertRaises(MediaConversionError):
                convert_media_for_browser(source, cache_dir=self.root / "cache")


if __name__ == "__main__":
    unittest.main()
