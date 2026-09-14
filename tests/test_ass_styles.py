from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from maw.ass_styles import (
    ASS_STYLE_LIBRARY_SCHEMA,
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
        self.assertEqual(library["assignments"], {
            "srtBurnStyleId": "default",
            "assExportProfileId": "ass",
        })
        self.assertEqual([style["id"] for style in library["styles"]], ["default", "ass"])
        self.assertEqual([profile["id"] for profile in library["assProfiles"]], ["ass"])
        self.assertTrue(library["styles"][0]["builtin"])
        self.assertTrue(library["assProfiles"][0]["builtin"])

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
        self.assertIn("force_style='FontName=Arial,FontSize=24,PrimaryColour=&H00563412", srt_filter)
        self.assertEqual(ass_filter, "ass=filename='caption.ass'")

    def test_srt_filter_loads_the_shared_default_slot_when_style_is_omitted(self) -> None:
        library = normalize_ass_style_library({
            "styles": [{"id": "custom", "fontName": "SimHei", "fontSize": 28}],
            "assignments": {"srtBurnStyleId": "custom"},
        })

        with mock.patch("maw.postprocess_ffmpeg.load_ass_style_library", return_value=library):
            srt_filter = _subtitle_filter(Path("caption.srt"))

        self.assertIn("FontName=SimHei,FontSize=28", srt_filter)


if __name__ == "__main__":
    unittest.main()
