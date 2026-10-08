from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from maw.ass_styles import (
    ASS_STYLE_LIBRARY_SCHEMA,
    ass_alpha,
    ass_color,
    ass_style_force_style,
    ass_style_line,
    default_ass_style_library,
    find_ass_profile,
    find_ass_style,
    load_ass_style_library,
    normalize_ass_style_library,
    save_ass_style_library,
)
from maw.postprocess_ffmpeg import _subtitle_filter


class AssStyleLibraryTests(unittest.TestCase):
    def test_default_library_has_protected_style_and_profile_slots(self) -> None:
        library = default_ass_style_library()

        self.assertEqual(library["schema"], ASS_STYLE_LIBRARY_SCHEMA)
        self.assertEqual(library["version"], 2)
        self.assertEqual(library["assignments"], {
            "srtBurnStyleId": "default",
            "assExportProfileId": "ass",
            "assExtensionStyleId": "ass-extension",
        })
        self.assertEqual(
            [style["id"] for style in library["styles"]],
            ["default", "ass", "ass-extension"],
        )
        self.assertEqual([profile["id"] for profile in library["assProfiles"]], ["ass"])
        self.assertTrue(library["styles"][0]["builtin"])
        self.assertTrue(library["assProfiles"][0]["builtin"])
        self.assertEqual(find_ass_style(library, "ass")["emphasisScale"], 1.3)

    def test_new_defaults_match_configured_parameters_and_keep_saved_library(self) -> None:
        library = default_ass_style_library()
        srt, main, extension = library["styles"]
        for style in (srt, main):
            self.assertEqual((style["fontSize"], style["outline"], style["marginV"], style["bold"]),
                             (86, 6, 88, True))
        self.assertEqual((main["emphasisColor"], main["emphasisScale"], main["backColor"], main["backOpacity"]),
                         ("#ffaa00", 1.3, "#ff8647", 60))
        self.assertEqual((extension["fontSize"], extension["outline"], extension["marginV"], extension["primaryColor"]),
                         (64, 2, 36, "#ffd34d"))
        self.assertEqual(library["assProfiles"][0]["animations"]["fad"],
                         {"enabled": True, "inMs": 250, "outMs": 250})
        main.update(fontName="Arial", fontSize=72, emphasisScale=1.1, backColor="#000000",
                    backOpacity=100, bold=False, outline=4, marginV=80)
        library["assProfiles"][0]["animations"]["fad"]["enabled"] = False
        self.assertEqual(normalize_ass_style_library(library), library)

    def test_v1_emphasis_scale_default_migrates_for_builtin_styles_only(self) -> None:
        legacy = normalize_ass_style_library({
            "version": 1,
            "styles": [
                {"id": "default", "emphasisScale": 1.0},
                {"id": "ass", "emphasisScale": 1.0},
                {"id": "ass-extension", "emphasisScale": 1.0},
                {"id": "custom-one", "emphasisScale": 1.0},
            ],
        })
        self.assertEqual(legacy["version"], 2)
        for style_id in ("default", "ass", "ass-extension"):
            self.assertEqual(find_ass_style(legacy, style_id)["emphasisScale"], 1.1)
        self.assertEqual(find_ass_style(legacy, "custom-one")["emphasisScale"], 1.0)

        current = normalize_ass_style_library({
            "version": 2,
            "styles": [{"id": "ass", "emphasisScale": 1.0}],
        })
        self.assertEqual(find_ass_style(current, "ass")["emphasisScale"], 1.0)

    def test_extension_style_slot_is_protected_and_repaired(self) -> None:
        # 旧版库没有 ass-extension 槽位：归一化补齐内置副字幕样式，
        # 用户对它的自定义会保留，非法槽位回退内置。
        normalized = normalize_ass_style_library({
            "styles": [
                {"id": "ass-extension", "name": "我的副字幕", "fontSize": 60, "marginV": 200},
            ],
            "assignments": {"assExtensionStyleId": "not a style!"},
        })
        extension = find_ass_style(normalized, "ass-extension")
        self.assertEqual(extension["name"], "我的副字幕")
        self.assertEqual(extension["fontSize"], 60)
        self.assertEqual(extension["marginV"], 200)
        self.assertTrue(extension["builtin"])
        self.assertIn("ass-extension", [style["id"] for style in normalized["styles"]])
        self.assertEqual(normalized["assignments"]["assExtensionStyleId"], "ass-extension")

        fallback = normalize_ass_style_library({})
        self.assertEqual(
            fallback["assignments"]["assExtensionStyleId"],
            "ass-extension",
        )
        default_extension = find_ass_style(fallback, "ass-extension")
        self.assertEqual(default_extension["primaryColor"], "#ffd34d")
        self.assertEqual(default_extension["fontSize"], 64)
        self.assertEqual(default_extension["marginV"], 36)

    def test_emphasis_style_settings_survive_server_normalization(self) -> None:
        library = normalize_ass_style_library({
            "styles": [{"id": "ass", "emphasisSyntax": "single",
                        "emphasisColor": "#aabbcc", "emphasisScale": 1.27,
                        "emphasisStyle": "stroke", "smallTextScale": 0.63, "largeTextScale": 2.2}],
        })
        style = find_ass_style(library, "ass")
        self.assertNotIn("emphasisSyntax", style)
        self.assertEqual((style["emphasisColor"], style["emphasisStyle"]),
                         ("#aabbcc", "stroke"))
        self.assertEqual(style["emphasisScale"], 1.25)
        self.assertEqual(style["smallTextScale"], 0.65)
        self.assertEqual(style["largeTextScale"], 2.2)
        invalid = normalize_ass_style_library({
            "styles": [{"id": "ass", "emphasisSyntax": {},
                        "emphasisColor": "invalid", "emphasisScale": "bad", "emphasisStyle": []}],
        })
        self.assertNotIn("emphasisSyntax", find_ass_style(invalid, "ass"))
        self.assertEqual(find_ass_style(invalid, "ass")["emphasisColor"], "#ffaa00")
        self.assertEqual(find_ass_style(invalid, "ass")["emphasisStyle"], "text")
        self.assertEqual(find_ass_style(invalid, "ass")["emphasisScale"], 1.3)
        self.assertEqual(find_ass_style(invalid, "ass")["smallTextScale"], 0.8)
        self.assertEqual(find_ass_style(invalid, "ass")["largeTextScale"], 1.5)
        self.assertEqual(find_ass_style(normalize_ass_style_library({"styles": [{"id": "ass", "emphasisScale": 9}]}), "ass")["emphasisScale"], 1.5)

    def test_legacy_full_library_keeps_every_custom_style(self) -> None:
        # 旧版满员库（2 内置 + 62 自定义 = 64）：归一化补入第三个内置
        # 副字幕样式后总数 65，不得截断丢弃任何自定义样式。
        custom_styles = [
            {"id": f"custom-{index:02d}", "name": f"自定义 {index}"}
            for index in range(62)
        ]
        legacy = {"styles": [{"id": "default"}, {"id": "ass"}, *custom_styles]}
        normalized = normalize_ass_style_library(legacy)
        style_ids = [style["id"] for style in normalized["styles"]]
        self.assertEqual(len(style_ids), 65)
        self.assertEqual(
            style_ids,
            ["default", "ass", "ass-extension", *(f"custom-{index:02d}" for index in range(62))],
        )

    def test_normalization_repairs_entries_and_preserves_ass_tag_commas(self) -> None:
        normalized = normalize_ass_style_library({
            "styles": [
                {
                    "id": "motion",
                    "name": "  Motion, test\n",
                    "fontSize": 9999,
                    "primaryColor": "not-a-color",
                },
                {"id": "not valid!", "name": "ignored"},
            ],
            "assProfiles": [{
                "id": "motion-profile",
                "name": "Motion",
                "styleId": "motion",
                "animations": {
                    "t": {
                        "enabled": True,
                        "tags": r"{\pos(10,20)\clip(0,0,100,100)}",
                    },
                },
            }],
            "assignments": {
                "srtBurnStyleId": "motion",
                "assExportProfileId": "motion-profile",
            },
        })

        style = find_ass_style(normalized, "motion")
        profile = find_ass_profile(normalized, "motion-profile")
        self.assertEqual(style["name"], "Motion test")
        self.assertEqual(style["fontSize"], 512)
        self.assertEqual(style["primaryColor"], "#ffffff")
        self.assertEqual(profile["styleId"], "motion")
        self.assertEqual(profile["animations"]["t"]["tags"], r"\pos(10,20)\clip(0,0,100,100)")
        self.assertEqual(normalized["assignments"]["srtBurnStyleId"], "motion")
        self.assertEqual(normalized["assignments"]["assExportProfileId"], "motion-profile")

    def test_style_serializers_use_ass_color_order_and_all_supported_fields(self) -> None:
        style = {
            "id": "custom",
            "fontName": "Microsoft YaHei",
            "fontSize": 36,
            "primaryColor": "#123456",
            "secondaryColor": "#abcdef",
            "outlineColor": "#654321",
            "backColor": "#0f1e2d",
            "bold": True,
            "italic": True,
            "underline": True,
            "strikeOut": True,
            "scaleX": 90,
            "scaleY": 110,
            "spacing": 2,
            "angle": -5,
            "borderStyle": 3,
            "outline": 4,
            "shadow": 2,
            "alignment": 8,
            "marginL": 20,
            "marginR": 30,
            "marginV": 40,
            "encoding": 1,
        }

        self.assertEqual(ass_color("#123456"), "&H00563412")
        line = ass_style_line(style, name="Caption")
        self.assertTrue(line.startswith("Style: Caption,Microsoft YaHei,36,&H00563412,&H00EFCDAB,&H00214365,&H002D1E0F,-1,-1,-1,-1,90,110,2,-5,3,4,2,8,20,30,40,1"))
        force_style = ass_style_force_style(style)
        self.assertIn("FontName=Microsoft YaHei", force_style)
        self.assertIn("PrimaryColour=&H00563412", force_style)
        self.assertIn("Bold=-1", force_style)
        self.assertIn("BorderStyle=3", force_style)

    def test_outline_and_shadow_opacity_map_to_ass_alpha(self) -> None:
        # ASS 的 AA 通道：00 = 不透明，FF = 全透明；样式用「不透明度百分比」表达。
        self.assertEqual(ass_alpha(100), 0)
        self.assertEqual(ass_alpha(50), 128)
        self.assertEqual(ass_alpha(0), 255)
        # 显式 None 与 JS null 一样视为 0%；缺失字段另由样式归一化补齐。
        self.assertEqual(ass_alpha(None), 255)
        self.assertEqual(ass_alpha(150), 0)
        self.assertEqual(ass_alpha(30), 179)
        self.assertEqual(ass_alpha(70), 77)
        self.assertEqual(ass_alpha(50.5), 126)
        self.assertEqual(ass_alpha(float("nan")), 0)
        self.assertEqual(ass_color("#123456", opacity=50), "&H80563412")

        style = {
            "fontName": "Arial",
            "fontSize": 24,
            "outlineColor": "#112233",
            "backColor": "#445566",
            "outlineOpacity": 50,
            "backOpacity": 0,
        }
        line = ass_style_line(style, name="Alpha")
        self.assertIn("&H80332211", line)
        self.assertIn("&HFF665544", line)
        force_style = ass_style_force_style(style)
        self.assertIn("OutlineColour=&H80332211", force_style)
        self.assertIn("BackColour=&HFF665544", force_style)

    def test_opacity_rounding_matches_browser_style_library(self) -> None:
        library = normalize_ass_style_library({
            "styles": [{"id": "alpha", "outlineOpacity": 50.5, "backOpacity": None}],
        })
        style = find_ass_style(library, "alpha")
        self.assertEqual(style["outlineOpacity"], 51)
        self.assertEqual(style["backOpacity"], 0)

    def test_opacity_defaults_keep_legacy_styles_opaque(self) -> None:
        # 旧样式库没有不透明度字段：归一化补 100（完全不透明），导出字节不变。
        library = normalize_ass_style_library({
            "styles": [{"id": "legacy", "name": "Legacy", "outlineColor": "#112233"}],
        })
        legacy = find_ass_style(library, "legacy")
        self.assertEqual(legacy["outlineOpacity"], 100)
        self.assertEqual(legacy["backOpacity"], 100)
        self.assertIn("&H00332211", ass_style_line(legacy, name="Legacy"))

    def test_save_is_atomic_and_loads_normalized_user_library(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ass-styles.json"
            saved = save_ass_style_library({
                "styles": [{"id": "custom", "name": "Custom"}],
                "assignments": {"srtBurnStyleId": "custom"},
            }, path)

            self.assertEqual(load_ass_style_library(path), saved)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["schema"], ASS_STYLE_LIBRARY_SCHEMA)
            self.assertFalse(list(path.parent.glob(f".{path.stem}.*.tmp")))

    def test_srt_filter_uses_style_but_ass_filter_keeps_embedded_styles(self) -> None:
        style = {"fontName": "Arial", "fontSize": 24, "primaryColor": "#123456"}

        srt_filter = _subtitle_filter(Path("caption.srt"), style)
        ass_filter = _subtitle_filter(Path("caption.ass"), style)
        self.assertIn("subtitles=filename='caption.srt'", srt_filter)
        # force_style 整体位于单引号 filter 参数内，样式字段的 `=`/`,` 在
        # filter 语法层会被转义；libass 收到的是还原后的原始样式串。
        self.assertIn(
            r"force_style='FontName\=Arial\,FontSize\=24\,PrimaryColour\=&H00563412",
            srt_filter,
        )
        self.assertEqual(ass_filter, "ass=filename='caption.ass'")

    def test_srt_filter_escapes_filter_metacharacters_in_font_names(self) -> None:
        style = {"fontName": "O'Brien", "fontSize": 24}

        srt_filter = _subtitle_filter(Path("caption.srt"), style)

        # `'` 不转义会提前结束 filter 参数的单引号，整个 -vf 滤镜链都会解析失败。
        self.assertIn(r"FontName\=O\'Brien", srt_filter)
        self.assertNotIn("FontName=O'Brien", srt_filter)

    def test_srt_filter_force_style_round_trips_through_filter_parsing(self) -> None:
        import re

        style = {
            "fontName": "O'Brien: Test, [Font]=Name",
            "fontSize": 24,
        }
        expected_force_style = ass_style_force_style(style)
        srt_filter = _subtitle_filter(Path("caption.srt"), style)

        # 按 FFmpeg av_get_token 的规则拆分滤镜参数：单引号包裹 + 反斜杠转义，
        # 解析结果必须还原出未转义的 force_style 值。
        match = re.search(r"force_style='((?:[^'\\]|\\.)*)'", srt_filter)
        self.assertIsNotNone(match)
        parsed = re.sub(r"\\(.)", r"\1", match.group(1))
        self.assertEqual(parsed, expected_force_style)

    def test_srt_filter_with_special_font_name_parses_in_real_ffmpeg(self) -> None:
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            self.skipTest("ffmpeg 不在 PATH 上，跳过真实滤镜解析验证")
        probe = subprocess.run(
            [ffmpeg, "-hide_banner", "-loglevel", "error", "-filters"],
            capture_output=True, text=True,
        )
        if "subtitles" not in probe.stdout.split():
            # Homebrew 等发行版构建可能不编译 libass（无 subtitles 滤镜）。
            # 滤镜参数转义规则已由上方纯解析用例覆盖，此处只补真实解析。
            self.skipTest("ffmpeg 未编译 subtitles 滤镜，跳过真实滤镜解析验证")

        style = {"fontName": "O'Brien", "fontSize": 24}
        with tempfile.TemporaryDirectory() as directory:
            subtitle = Path(directory) / "caption.srt"
            subtitle.write_text(
                "1\n00:00:00,000 --> 00:00:00,400\n样式\n",
                encoding="utf-8",
            )
            command = [
                ffmpeg, "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", "color=black:s=320x180:d=0.5",
                "-vf", _subtitle_filter(subtitle, style),
                "-frames:v", "1", "-f", "null", "-",
            ]
            # 生产路径以字幕所在目录为 cwd 且只传文件名，这里保持一致。
            result = subprocess.run(command, capture_output=True, text=True, cwd=directory)
        self.assertEqual(
            result.returncode, 0,
            f"ffmpeg filter 解析失败：{result.stderr.strip()}",
        )

    def test_srt_filter_loads_the_shared_default_slot_when_style_is_omitted(self) -> None:
        library = normalize_ass_style_library({
            "styles": [{"id": "custom", "fontName": "SimHei", "fontSize": 28}],
            "assignments": {"srtBurnStyleId": "custom"},
        })

        with mock.patch("maw.postprocess_ffmpeg.load_ass_style_library", return_value=library):
            srt_filter = _subtitle_filter(Path("caption.srt"))

        self.assertIn(r"FontName\=SimHei\,FontSize\=28", srt_filter)


if __name__ == "__main__":
    unittest.main()
