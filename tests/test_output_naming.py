from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from maw import gui_config, output_naming


def _config(*, gui_lang: str = "zh", all_subfolder: bool = False, per_video: bool = False) -> SimpleNamespace:
    return SimpleNamespace(
        gui_lang=gui_lang,
        output_subfolder=all_subfolder,
        per_video_subfolder=per_video,
    )


def _patch_config(config: SimpleNamespace) -> mock.patch:
    return mock.patch.object(
        gui_config,
        "effective_config",
        return_value=config,
    )


class ResolveLangAndPrefsTests(unittest.TestCase):
    def test_resolve_lang_prefers_explicit_value(self) -> None:
        with _patch_config(_config(gui_lang="en")):
            self.assertEqual(output_naming.resolve_lang("zh"), "zh")
            self.assertEqual(output_naming.resolve_lang("en"), "en")

    def test_resolve_lang_reads_config_and_falls_back_to_zh(self) -> None:
        with _patch_config(_config(gui_lang="en")):
            self.assertEqual(output_naming.resolve_lang(), "en")
        with _patch_config(_config(gui_lang="zh")):
            self.assertEqual(output_naming.resolve_lang(), "zh")
        # 配置读到非法值时兜底 zh
        with _patch_config(_config(gui_lang="ja")):
            self.assertEqual(output_naming.resolve_lang(), output_naming.DEFAULT_LANG)

    def test_resolve_lang_defaults_to_zh_when_config_is_unavailable(self) -> None:
        # 不 patch effective_config：让它自然抛错（读真实 .env 也应返回 zh），
        # 但为了不依赖开发者机器的 .env，显式把配置读取器替换为抛异常版本。
        def boom(*_args, **_kwargs):  # noqa: ANN001, ANN002, ANN003
            raise RuntimeError("config unavailable")

        with mock.patch.object(gui_config, "effective_config", side_effect=boom):
            self.assertEqual(output_naming.resolve_lang(), "zh")

    def test_subfolder_prefs_mirrors_config_switches(self) -> None:
        with _patch_config(_config(all_subfolder=True, per_video=True)):
            self.assertEqual(output_naming.subfolder_prefs(), (True, True))
        with _patch_config(_config()):
            self.assertEqual(output_naming.subfolder_prefs(), (False, False))

    def test_subfolder_prefs_defaults_to_off_when_config_is_unavailable(self) -> None:
        def boom(*_args, **_kwargs):  # noqa: ANN001, ANN002, ANN003
            raise RuntimeError("config unavailable")

        with mock.patch.object(gui_config, "effective_config", side_effect=boom):
            self.assertEqual(output_naming.subfolder_prefs(), (False, False))


class MawRootTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name).resolve()
        self.media = self.root / "clip.mp4"

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_maw_root_uses_shared_dir_by_default(self) -> None:
        with _patch_config(_config()):
            self.assertEqual(output_naming.maw_root(self.media), self.root / "_maw")

    def test_maw_root_uses_per_video_dir_when_preference_is_on(self) -> None:
        with _patch_config(_config(per_video=True)):
            self.assertEqual(output_naming.maw_root(self.media), self.root / "clip_maw")

    def test_maw_root_explicit_per_video_overrides_config(self) -> None:
        with _patch_config(_config(per_video=False)):
            self.assertEqual(
                output_naming.maw_root(self.media, per_video=True),
                self.root / "clip_maw",
            )
            self.assertEqual(
                output_naming.maw_root(self.media, per_video=False),
                self.root / "_maw",
            )

    def test_maw_root_per_video_sanitizes_stem(self) -> None:
        # 避开 Windows「单字母 + 冒号」被当作盘符的解析（a:b → 驱动器 a）
        weird = self.root / "clip*?.mp4"
        stem = weird.stem
        with _patch_config(_config(per_video=True)):
            self.assertEqual(
                output_naming.maw_root(weird),
                self.root / f"{output_naming.sanitize_component(stem)}{output_naming.MAW_DIR_NAME}",
            )
        # 共享根不受主名影响
        with _patch_config(_config()):
            self.assertEqual(output_naming.maw_root(weird), self.root / "_maw")

    def test_maw_root_candidates_cover_shared_and_per_video(self) -> None:
        candidates = output_naming.maw_root_candidates(self.media)
        self.assertEqual(
            candidates,
            [self.root / "_maw", self.root / "clip_maw"],
        )

    def test_maw_root_candidates_accepts_relative_path(self) -> None:
        previous = Path.cwd()
        os.chdir(self.root)
        try:
            candidates = output_naming.maw_root_candidates("clip.mp4")
        finally:
            os.chdir(previous)
        self.assertEqual(candidates[0], self.root / "_maw")


class PostprocessWorkspaceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name).resolve()
        self.media = self.root / "clip.mp4"

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_postprocess_workspace_names_directory_by_language(self) -> None:
        with _patch_config(_config(gui_lang="zh")):
            self.assertEqual(
                output_naming.postprocess_workspace(self.media),
                self.root / "_maw" / "后处理",
            )
        with _patch_config(_config(gui_lang="en")):
            self.assertEqual(
                output_naming.postprocess_workspace(self.media),
                self.root / "_maw" / "postprocess",
            )

    def test_postprocess_workspace_honours_per_video(self) -> None:
        with _patch_config(_config(gui_lang="en", per_video=True)):
            self.assertEqual(
                output_naming.postprocess_workspace(self.media),
                self.root / "clip_maw" / "postprocess",
            )

    def test_postprocess_workspace_candidates_order_is_deterministic_and_current_lang_first(self) -> None:
        expected_zh = [
            self.root / "_maw" / "后处理",
            self.root / "_maw" / "postprocess",
            self.root / "clip_maw" / "后处理",
            self.root / "clip_maw" / "postprocess",
        ]
        expected_en = [
            self.root / "_maw" / "postprocess",
            self.root / "_maw" / "后处理",
            self.root / "clip_maw" / "postprocess",
            self.root / "clip_maw" / "后处理",
        ]
        with _patch_config(_config(gui_lang="zh")):
            self.assertEqual(output_naming.postprocess_workspace_candidates(self.media), expected_zh)
        with _patch_config(_config(gui_lang="en")):
            self.assertEqual(output_naming.postprocess_workspace_candidates(self.media), expected_en)
        # 顺序稳定：多次调用结果一致（不依赖 set 迭代随机性）
        with _patch_config(_config(gui_lang="zh")):
            self.assertEqual(
                output_naming.postprocess_workspace_candidates(self.media),
                output_naming.postprocess_workspace_candidates(self.media),
            )


class OperationSuffixTests(unittest.TestCase):
    def test_operation_suffix_localizes_per_language(self) -> None:
        self.assertEqual(output_naming.operation_suffix("postprocess", "zh"), ".后处理")
        self.assertEqual(output_naming.operation_suffix("postprocess", "en"), ".postprocess")
        self.assertEqual(output_naming.operation_suffix("ocr-dedup", "zh"), ".OCR去重")
        self.assertEqual(output_naming.operation_suffix("ocr-dedup", "en"), ".ocr-dedup")
        self.assertEqual(output_naming.operation_suffix("match", "zh"), ".匹配")
        self.assertEqual(output_naming.operation_suffix("match", "en"), ".match")

    def test_operation_suffix_unknown_operation_keeps_original(self) -> None:
        self.assertEqual(output_naming.operation_suffix("translate", "zh"), ".translate")
        self.assertEqual(output_naming.operation_suffix("translate", "en"), ".translate")
        self.assertEqual(output_naming.operation_suffix("unknown-op", "zh"), ".unknown-op")

    def test_operation_suffix_localizes_translation_targets_in_zh(self) -> None:
        self.assertEqual(output_naming.operation_suffix("translate-zh", "zh"), ".翻译为中文")
        self.assertEqual(output_naming.operation_suffix("translate-en", "zh"), ".翻译为英文")
        self.assertEqual(
            output_naming.operation_suffix("translate-zh-bilingual", "zh"),
            ".翻译为中文.双语合一",
        )
        self.assertEqual(
            output_naming.operation_suffix("translate-zh-combined", "zh"),
            ".翻译为中文.整合",
        )
        self.assertEqual(
            output_naming.operation_suffix("translate-en-bilingual", "zh"),
            ".翻译为英文.双语合一",
        )
        self.assertEqual(
            output_naming.operation_suffix("translate-en-combined", "zh"),
            ".翻译为英文.整合",
        )

    def test_operation_suffix_localizes_underscore_bases_in_zh(self) -> None:
        # 工具箱 operation（下划线 base）在 zh 界面同样本地化，
        # 含混合形态（下划线 base + 连字符标记 translate_zh-bilingual）。
        self.assertEqual(output_naming.operation_suffix("translate_zh", "zh"), ".翻译为中文")
        self.assertEqual(output_naming.operation_suffix("translate_en", "zh"), ".翻译为英文")
        self.assertEqual(
            output_naming.operation_suffix("translate_zh-bilingual", "zh"),
            ".翻译为中文.双语合一",
        )
        self.assertEqual(
            output_naming.operation_suffix("translate_en-combined", "zh"),
            ".翻译为英文.整合",
        )
        self.assertEqual(
            output_naming.operation_suffix("translate_zh_combined", "zh"),
            ".翻译为中文.整合",
        )

    def test_operation_suffix_keeps_english_translation_names_byte_identical(self) -> None:
        # en 界面翻译段与改动前逐字节一致：纯段与 bilingual/combined 连字符原样。
        self.assertEqual(output_naming.operation_suffix("translate-zh", "en"), ".translate-zh")
        self.assertEqual(output_naming.operation_suffix("translate-en", "en"), ".translate-en")
        self.assertEqual(
            output_naming.operation_suffix("translate-zh-bilingual", "en"),
            ".translate-zh-bilingual",
        )
        self.assertEqual(
            output_naming.operation_suffix("translate-en-combined", "en"),
            ".translate-en-combined",
        )

    def test_operation_suffix_underscore_bases_stay_legacy_ascii_in_en(self) -> None:
        # 下划线变体（工具箱）en 界面沿用 legacy ASCII 清洗，输出与改动前逐字节一致。
        self.assertEqual(output_naming.operation_suffix("translate_zh", "en"), ".translate-zh")
        self.assertEqual(output_naming.operation_suffix("translate_en", "en"), ".translate-en")
        self.assertEqual(
            output_naming.operation_suffix("translate_zh-bilingual", "en"),
            ".translate-zh-bilingual",
        )
        self.assertEqual(
            output_naming.operation_suffix("translate_en-combined", "en"),
            ".translate-en-combined",
        )

    def test_operation_suffix_unknown_translation_target_stays_english(self) -> None:
        # 防御性：未知 target 在两种界面都原样保留英文段。
        for lang in ("zh", "en"):
            self.assertEqual(output_naming.operation_suffix("translate-ja", lang), ".translate-ja")
            self.assertEqual(
                output_naming.operation_suffix("translate-ja-combined", lang),
                ".translate-ja-combined",
            )
            self.assertEqual(
                output_naming.operation_suffix("translate_ja_bilingual", lang),
                ".translate-ja-bilingual",
            )

    def test_translation_target_names_map_per_ui_language(self) -> None:
        self.assertEqual(output_naming.TRANSLATION_TARGET_NAMES["zh"]["zh"], "中文")
        self.assertEqual(output_naming.TRANSLATION_TARGET_NAMES["zh"]["en"], "英文")
        self.assertEqual(output_naming.TRANSLATION_TARGET_NAMES["en"]["zh"], "zh")
        self.assertEqual(output_naming.TRANSLATION_TARGET_NAMES["en"]["en"], "en")

    def test_translation_marker_names_map_per_ui_language(self) -> None:
        self.assertEqual(output_naming.translation_marker_name("bilingual", "zh"), "双语合一")
        self.assertEqual(output_naming.translation_marker_name("bilingual", "en"), "bilingual")
        self.assertEqual(output_naming.translation_marker_name("combined", "zh"), "整合")
        self.assertEqual(output_naming.translation_marker_name("combined", "en"), "combined")
        # 未登记的 marker 原样回退。
        self.assertEqual(output_naming.translation_marker_name("unknown", "zh"), "unknown")

    def test_is_translation_operation_matches_shape_only(self) -> None:
        for operation in (
            "translate-zh",
            "translate-en-bilingual",
            "translate-ja-combined",
            "translate_zh",
            "translate_en",
            "translate_zh-bilingual",
            "translate_ja_bilingual",
        ):
            self.assertTrue(output_naming.is_translation_operation(operation), operation)
        for operation in ("translate", "translate_zh_x", "postprocess", "translate-en-x", "translate-en-bilingual-2"):
            self.assertFalse(output_naming.is_translation_operation(operation), operation)

    def test_operation_suffix_defaults_via_config_language(self) -> None:
        with _patch_config(_config(gui_lang="zh")):
            self.assertEqual(output_naming.operation_suffix("postprocess"), ".后处理")
            self.assertEqual(output_naming.operation_suffix("translate-zh"), ".翻译为中文")
        with _patch_config(_config(gui_lang="en")):
            self.assertEqual(output_naming.operation_suffix("postprocess"), ".postprocess")
            self.assertEqual(output_naming.operation_suffix("translate-zh"), ".translate-zh")


class StatLineTests(unittest.TestCase):
    def test_format_maw_stat_and_parse_round_trip(self) -> None:
        for value in (0.123, 1.0, 12.345):
            line = output_naming.format_maw_stat(value)
            self.assertIsNotNone(line)
            assert line is not None
            parsed = output_naming.parse_maw_stat(line)
            self.assertEqual(parsed, {"rtf": f"{value:.3f}"})

    def test_format_maw_stat_rejects_invalid_values(self) -> None:
        self.assertIsNone(output_naming.format_maw_stat(None))
        self.assertIsNone(output_naming.format_maw_stat(0))
        self.assertIsNone(output_naming.format_maw_stat(-2))

    def test_parse_maw_stat_rejects_non_matching_lines(self) -> None:
        self.assertIsNone(output_naming.parse_maw_stat(""))
        self.assertIsNone(output_naming.parse_maw_stat("MAW_STAT"))
        self.assertIsNone(output_naming.parse_maw_stat("maw_stat rtf=1.0"))
        self.assertIsNone(output_naming.parse_maw_stat("MAW_STAT =1.0"))
        self.assertIsNone(output_naming.parse_maw_stat("随便一行 MAW_STAT rtf=1.0"))

    def test_parse_maw_stat_accepts_arbitrary_keys_and_values(self) -> None:
        self.assertEqual(
            output_naming.parse_maw_stat("  MAW_STAT rtf=2.000x  "),
            {"rtf": "2.000x"},
        )
        self.assertEqual(
            output_naming.parse_maw_stat("MAW_STAT duration=100"),
            {"duration": "100"},
        )


class SanitizeComponentTests(unittest.TestCase):
    def test_windows_reserved_names_get_a_suffix(self) -> None:
        for reserved in ("CON", "PRN", "AUX", "NUL", "COM1", "LPT9", "con", "Com3"):
            sanitized = output_naming.sanitize_component(reserved)
            self.assertTrue(sanitized.startswith(reserved), sanitized)
            self.assertNotIn("\\", sanitized)

    def test_reserved_check_applies_to_dotted_basename(self) -> None:
        self.assertEqual(output_naming.sanitize_component("CON.txt"), "CON.txt_")

    def test_invalid_chars_are_replaced_and_stripped(self) -> None:
        self.assertEqual(output_naming.sanitize_component('a:b\\c*?"<>|'), "a_b_c______")
        self.assertEqual(output_naming.sanitize_component("  clip  "), "clip")
        self.assertEqual(output_naming.sanitize_component("clip."), "clip")

    def test_empty_and_dot_only_values_fall_back(self) -> None:
        self.assertEqual(output_naming.sanitize_component(""), "视频")
        self.assertEqual(output_naming.sanitize_component("..."), "视频")
        self.assertEqual(output_naming.sanitize_component(".."), "视频")
        self.assertEqual(output_naming.sanitize_component(None), "视频")

    def test_custom_fallback_is_used(self) -> None:
        self.assertEqual(output_naming.sanitize_component("", fallback="媒体"), "媒体")
        self.assertEqual(output_naming.sanitize_component(".", fallback="media"), "media")

    def test_non_empty_invalid_chars_do_not_trigger_fallback(self) -> None:
        # "//" 被替换成 "__"：fallback 只在值为空 / 纯点号时触发
        self.assertEqual(output_naming.sanitize_component("//"), "__")

    def test_long_names_are_truncated(self) -> None:
        long_name = "x" * 500
        self.assertEqual(len(output_naming.sanitize_component(long_name)), 160)


class FormatElapsedTests(unittest.TestCase):
    def test_seconds_below_a_minute(self) -> None:
        self.assertEqual(output_naming.format_elapsed(0), "0 秒")
        self.assertEqual(output_naming.format_elapsed(36.0), "36 秒")
        # 四舍五入到 60 秒时进位为分钟，避免出现 "60 秒"
        self.assertEqual(output_naming.format_elapsed(59.6), "1 分 0 秒")

    def test_minutes_with_seconds_below_an_hour(self) -> None:
        self.assertEqual(output_naming.format_elapsed(60), "1 分 0 秒")
        self.assertEqual(output_naming.format_elapsed(75), "1 分 15 秒")
        self.assertEqual(output_naming.format_elapsed(3599), "59 分 59 秒")
        self.assertEqual(output_naming.format_elapsed(4529), "1 小时 15 分")

    def test_hours_ignore_seconds(self) -> None:
        self.assertEqual(output_naming.format_elapsed(3600), "1 小时 0 分")
        self.assertEqual(output_naming.format_elapsed(3661), "1 小时 1 分")
        self.assertEqual(output_naming.format_elapsed(4530), "1 小时 15 分")

    def test_invalid_values(self) -> None:
        self.assertEqual(output_naming.format_elapsed(None), "未知")
        self.assertEqual(output_naming.format_elapsed(-1), "未知")


class EstimateDashscopeCostTests(unittest.TestCase):
    def test_cost_is_duration_times_unit_price(self) -> None:
        self.assertAlmostEqual(output_naming.estimate_dashscope_cost(3000.0), 0.66)
        self.assertAlmostEqual(output_naming.estimate_dashscope_cost(1.0), output_naming.DASHSCOPE_PRICE_PER_SECOND)

    def test_invalid_durations_return_none(self) -> None:
        self.assertIsNone(output_naming.estimate_dashscope_cost(None))
        self.assertIsNone(output_naming.estimate_dashscope_cost(0))
        self.assertIsNone(output_naming.estimate_dashscope_cost(-5))


if __name__ == "__main__":
    unittest.main()
