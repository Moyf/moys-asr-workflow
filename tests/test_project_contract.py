from __future__ import annotations

import unittest

from maw.project import ProjectValidationFailed, normalize_project, validate_project


class ProjectContractTests(unittest.TestCase):
    def test_normalize_project_accepts_legacy_optional_omissions(self) -> None:
        project = {"segments": [{"start": 0, "end": 1000, "text": "hello"}]}

        normalized = normalize_project(project)

        self.assertNotIn("items", normalized["segments"][0])

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


if __name__ == "__main__":
    unittest.main()
