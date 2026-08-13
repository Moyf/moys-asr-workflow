from __future__ import annotations

import unittest

from maw.project import (
    ProjectValidationFailed,
    normalize_project,
    repair_segment_durations,
    validate_project,
)


class ProjectContractTests(unittest.TestCase):
    def test_normalize_project_generates_stable_main_ids_for_legacy_projects(self) -> None:
        project = {"segments": [{"start": 0, "end": 1000, "text": "hello"}]}

        normalized = normalize_project(project)

        self.assertNotIn("items", normalized["segments"][0])
        self.assertEqual(normalized["segments"][0]["id"], "main-001")
        self.assertNotIn("multi_subtitle", normalized)

    def test_generated_main_ids_reserve_later_explicit_ids(self) -> None:
        project = {
            "segments": [
                {"start": 0, "end": 1000, "text": "generated"},
                {"id": "main-001", "start": 1000, "end": 2000, "text": "explicit"},
                {"start": 2000, "end": 3000, "text": "next"},
            ],
        }

        normalized = normalize_project(project)

        self.assertEqual(
            [segment["id"] for segment in normalized["segments"]],
            ["main-001-generated", "main-001", "main-003"],
        )

    def test_validate_project_accepts_optional_multi_subtitle_items(self) -> None:
        project = {
            "segments": [
                {"start": 1000, "end": 3000, "text": "主字幕"},
            ],
            "multi_subtitle": {
                "enabled": True,
                "display_mode": "both",
                "main_split_mode": "word",
                "tracks": [{
                    "id": "translation",
                    "language": "English",
                    "split_mode": "word",
                    "source_name": "translation.srt",
                    "segments": [{
                        "id": "translation-a",
                        "start": 1100,
                        "end": 2900,
                        "text": "Extended subtitle",
                        "items": [{"text": "wrong source", "start": 1100, "end": 2900}],
                    }],
                }],
                "bindings": [{
                    "id": "binding-a",
                    "track_id": "translation",
                    "main_segment_ids": ["main-001"],
                    "extension_segment_ids": ["translation-a"],
                }],
            },
        }

        result = validate_project(project)

        self.assertTrue(result.ok)
        self.assertIsNotNone(result.project)
        self.assertEqual(result.project["segments"][0]["id"], "main-001")
        extension = result.project["multi_subtitle"]["tracks"][0]["segments"][0]
        self.assertEqual(
            extension["items"],
            [{"text": "wrong source", "start": 1100, "end": 2900}],
        )
        binding = result.project["multi_subtitle"]["bindings"][0]
        self.assertEqual(binding["start_offset_ms"], 100)
        self.assertEqual(binding["end_offset_ms"], -100)

    def test_validate_project_reports_multi_subtitle_contract_errors(self) -> None:
        project = {
            "segments": [{"id": "main-a", "start": 0, "end": 1000, "text": "主"}],
            "multi_subtitle": {
                "enabled": True,
                "main_split_mode": "invalid",
                "tracks": [{
                    "id": "translation",
                    "split_mode": "invalid",
                    "segments": [{"id": "translation-a", "start": 100, "end": 900, "text": "扩"}],
                }],
                "bindings": [{
                    "track_id": "translation",
                    "main_segment_ids": ["main-a", "main-extra"],
                    "extension_segment_ids": ["translation-a"],
                    "start_offset_ms": 0,
                    "end_offset_ms": 0,
                }],
            },
        }

        result = validate_project(project)
        paths = {error.path for error in result.errors}

        self.assertFalse(result.ok)
        self.assertIn("$.multi_subtitle.tracks[0].split_mode", paths)
        self.assertIn("$.multi_subtitle.main_split_mode", paths)
        self.assertIn("$.multi_subtitle.bindings[0].main_segment_ids", paths)

    def test_validate_project_accepts_head_refs_speakers_and_preview_clamps(self) -> None:
        project = {
            "media": "clip.mp4",
            "segments": [
                {
                    "start": 0,
                    "end": 1000,
                    "text": "猫",
                    "items": [{"text": "猫", "start": 0, "end": 1000}],
                    "speaker": "S1",
                    "sticker": {"name": "cat"},
                    "color": {"name": "red"},
                },
                {
                    "start": 1200,
                    "end": 2200,
                    "text": "狗",
                    "items": [{"text": "狗", "start": 1200, "end": 2200}],
                    "sticker_ref": {"name": "cat", "headIdx": 0},
                    "color_ref": {"name": "red", "headIdx": 0},
                },
            ],
        }

        result = validate_project(project, preview_duration_ms=1500)

        self.assertTrue(result.ok)
        self.assertEqual(result.errors, ())
        self.assertIsNotNone(result.project)
        self.assertIsNotNone(result.preview)
        self.assertEqual(result.preview["segments"][1]["end"], 1500)
        self.assertEqual(result.project["segments"][1]["end"], 2200)

    def test_validate_project_reports_path_qualified_errors(self) -> None:
        project = {
            "segments": [
                {"start": 0, "end": 1000, "text": "ok", "sticker": {"name": "head"}},
                {
                    "start": 900,
                    "end": 1200,
                    "text": "bad",
                    "items": [{"text": "x", "start": 850, "end": 1300}],
                    "speaker": " ",
                    "sticker_ref": {"name": "head", "headIdx": 99},
                },
                {"start": "1200", "end": 1300, "text": 123},
            ],
        }

        result = validate_project(project)
        paths = {error.path for error in result.errors}

        self.assertFalse(result.ok)
        self.assertIn("$.segments[1].start", paths)
        self.assertIn("$.segments[1].items[0].start", paths)
        self.assertIn("$.segments[1].items[0].end", paths)
        self.assertIn("$.segments[1].speaker", paths)
        self.assertIn("$.segments[1].sticker_ref.headIdx", paths)
        self.assertIn("$.segments[2].start", paths)
        self.assertIn("$.segments[2].text", paths)

    def test_normalize_project_raises_path_qualified_failure(self) -> None:
        project = {"segments": [{"start": 0, "end": 0, "text": "bad"}]}

        with self.assertRaises(ProjectValidationFailed) as raised:
            normalize_project(project)

        self.assertIn("$.segments[0].end", str(raised.exception))

    def test_repair_segment_durations_widens_zero_length_item_and_segment(self) -> None:
        """Given a zero-length trailing item, When repaired, Then it keeps at least 100ms."""
        segments = [
            {
                "start": 17790,
                "end": 20340,
                "text": "用卫星拍照片 能得到什么？",
                "items": [
                    {"text": "用卫星拍照片 能得到", "start": 17790, "end": 20340},
                    {"text": "什么？", "start": 20340, "end": 20340},
                ],
            },
        ]

        fixed = repair_segment_durations(segments)

        self.assertGreaterEqual(fixed, 1)
        segment = segments[0]
        self.assertEqual(segment["end"], 20440)
        self.assertEqual(segment["items"][1]["end"], 20440)
        normalize_project({"segments": segments})

    def test_repair_segment_durations_widens_zero_segment_and_cascades(self) -> None:
        """Given a zero-length segment, When repaired, Then following segments stay ordered."""
        segments = [
            {"start": 0, "end": 1000, "text": "第一句"},
            {"start": 1000, "end": 1000, "text": "嗯"},
            {"start": 1000, "end": 2000, "text": "第二句"},
        ]

        fixed = repair_segment_durations(segments)

        self.assertGreaterEqual(fixed, 2)
        self.assertEqual((segments[1]["start"], segments[1]["end"]), (1000, 1100))
        self.assertEqual(segments[2]["start"], 1100)
        normalize_project({"segments": segments})

    def test_repair_segment_durations_leaves_genuine_short_timings_untouched(self) -> None:
        """Given valid sub-100ms timings, When repaired, Then nothing changes."""
        segments = [
            {
                "start": 0,
                "end": 300,
                "text": "The end.",
                "items": [
                    {"text": "The", "start": 0, "end": 60},
                    {"text": " end.", "start": 60, "end": 300},
                ],
            },
            {"start": 400, "end": 460, "text": "嗯"},
        ]

        fixed = repair_segment_durations(segments)

        self.assertEqual(fixed, 0)
        self.assertEqual(segments[0]["items"][0]["end"], 60)
        self.assertEqual((segments[1]["start"], segments[1]["end"]), (400, 460))

    def test_validate_project_rejects_forward_head_refs_and_name_mismatch(self) -> None:
        project = {
            "segments": [
                {"start": 0, "end": 1000, "text": "early", "sticker_ref": {"name": "later", "headIdx": 1}},
                {"start": 1000, "end": 2000, "text": "head", "sticker": {"name": "later"}},
                {"start": 2000, "end": 3000, "text": "mismatch", "sticker_ref": {"name": "other", "headIdx": 1}},
            ],
        }

        result = validate_project(project)
        errors = {(error.path, error.message) for error in result.errors}

        self.assertIn(("$.segments[0].sticker_ref.headIdx", "must point to an earlier head segment"), errors)
        self.assertIn(("$.segments[2].sticker_ref.name", "must match referenced head name"), errors)

    def test_validate_project_accepts_absent_preview_as_legacy(self) -> None:
        project = {"segments": [{"start": 0, "end": 1000, "text": "hi"}]}

        result = validate_project(project)

        self.assertTrue(result.ok)
        self.assertNotIn("preview", result.project)

    def test_validate_project_accepts_valid_preview_subtitle_geometry(self) -> None:
        project = {
            "segments": [{"start": 0, "end": 1000, "text": "hi"}],
            "preview": {"subtitle": {"x": 0.0, "y": 0.76, "width": 1.0, "height": 0.16,
                                        "font_size": 32, "font_family": "yahei",
                                        "background_color": "#1A2b3C", "background_alpha": 0,
                                        "color": "#ffffff"},
                        "extension_subtitle": {"font_size": 16, "font_family": "sans", "color": "#ffd34d"}},
        }

        result = validate_project(project)

        self.assertTrue(result.ok)
        self.assertEqual(result.project["preview"]["subtitle"]["y"], 0.76)
        self.assertEqual(result.project["preview"]["subtitle"]["font_family"], "yahei")
        self.assertEqual(result.project["preview"]["subtitle"]["background_color"], "#1A2b3C")
        self.assertEqual(result.project["preview"]["subtitle"]["background_alpha"], 0)
        self.assertEqual(result.project["preview"]["extension_subtitle"]["color"], "#ffd34d")

    def test_validate_project_accepts_custom_preview_subtitle_font_family(self) -> None:
        project = {
            "segments": [{"start": 0, "end": 1000, "text": "hi"}],
            "preview": {"subtitle": {"x": 0.0, "y": 0.76, "width": 1.0, "height": 0.16,
                                        "font_family": "Noto Sans CJK SC"}},
        }

        result = validate_project(project)

        self.assertTrue(result.ok)
        self.assertEqual(result.project["preview"]["subtitle"]["font_family"], "Noto Sans CJK SC")

    def test_validate_project_rejects_preview_subtitle_out_of_range(self) -> None:
        project = {
            "segments": [{"start": 0, "end": 1000, "text": "hi"}],
            "preview": {"subtitle": {"x": -0.1, "y": 0.5, "width": 1.5, "height": 0.2}},
        }

        result = validate_project(project)
        paths = {error.path for error in result.errors}

        self.assertFalse(result.ok)
        self.assertIn("$.preview.subtitle.x", paths)
        self.assertIn("$.preview.subtitle.width", paths)

    def test_validate_project_rejects_preview_subtitle_box_outside_player(self) -> None:
        project = {
            "segments": [{"start": 0, "end": 1000, "text": "hi"}],
            "preview": {"subtitle": {"x": 0.8, "y": 0.8, "width": 0.5, "height": 0.5}},
        }

        result = validate_project(project)
        messages = {error.message for error in result.errors}

        self.assertFalse(result.ok)
        self.assertIn("x + width must be <= 1", messages)
        self.assertIn("y + height must be <= 1", messages)

    def test_validate_project_rejects_preview_subtitle_wrong_type_and_missing_field(self) -> None:
        project = {
            "segments": [{"start": 0, "end": 1000, "text": "hi"}],
            "preview": {"subtitle": {"x": "0.5", "y": 0.5, "width": 0.5}},
        }

        result = validate_project(project)
        paths = {error.path for error in result.errors}

        self.assertFalse(result.ok)
        self.assertIn("$.preview.subtitle.x", paths)
        self.assertIn("$.preview.subtitle.height", paths)

    def test_validate_project_rejects_preview_subtitle_style_out_of_range(self) -> None:
        project = {
            "segments": [{"start": 0, "end": 1000, "text": "hi"}],
            "preview": {"subtitle": {
                "x": 0.0, "y": 0.76, "width": 1.0, "height": 0.16,
                "font_size": 100, "font_family": "", "background_color": "black", "background_alpha": 1.1,
            }},
        }

        result = validate_project(project)
        paths = {error.path for error in result.errors}

        self.assertIn("$.preview.subtitle.font_size", paths)
        self.assertIn("$.preview.subtitle.font_family", paths)
        self.assertIn("$.preview.subtitle.background_color", paths)
        self.assertIn("$.preview.subtitle.background_alpha", paths)

    def test_validate_project_rejects_non_object_preview(self) -> None:
        project = {
            "segments": [{"start": 0, "end": 1000, "text": "hi"}],
            "preview": "not-an-object",
        }

        result = validate_project(project)

        self.assertFalse(result.ok)
        self.assertIn("$.preview", {error.path for error in result.errors})

    def test_validate_project_rejects_invalid_extension_subtitle_style(self) -> None:
        project = {
            "segments": [{"start": 0, "end": 1000, "text": "hi"}],
            "preview": {"extension_subtitle": {"font_size": 10, "color": "yellow"}},
        }

        result = validate_project(project)
        paths = {error.path for error in result.errors}

        self.assertFalse(result.ok)
        self.assertIn("$.preview.extension_subtitle.font_size", paths)
        self.assertIn("$.preview.extension_subtitle.color", paths)


if __name__ == "__main__":
    unittest.main()
