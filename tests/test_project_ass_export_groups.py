import copy
import json
from pathlib import Path
import tempfile
import unittest

from maw.project_ass_export import ProjectSubtitleError, load_burn_project, render_project_ass
from maw.project import normalize_project


def group_project():
    return {
        "schema": "moy.asr.project.v1.5",
        "subtitle_groups": {
            "next_id": 3,
            "color": [{"id": "shared", "value": {"name": "red", "value": "#eb4d4b", "vendor": "retained"}}],
            "sticker": [],
        },
        "segments": [{"id": "main", "start": 1200, "end": 2400, "text": "主字幕", "color_group_id": "shared"}],
        "overlay_track": {"enabled": True, "segments": [
            {"id": "overlay", "start": 1500, "end": 2500, "text": "叠加字幕", "color_group_id": "shared"}]},
        "preview": {"subtitle": {"x": 0.1, "y": 0.76, "width": 0.8, "height": 0.16, "ass_color_style": "text"}},
        "vendor": {"unchanged": True},
    }


def render(project):
    return render_project_ass(project, title="compatibility", play_resolution=(1920, 1080))


class ProjectAssExportGroupTests(unittest.TestCase):
    def test_shared_stable_color_is_resolved_across_tracks_without_mutating_input(self):
        source = group_project()
        before = copy.deepcopy(source)
        output = render(source)
        self.assertIn("Dialogue: 0,0:00:01.20,0:00:02.40,RED,", output)
        self.assertIn("Dialogue: 2,0:00:01.50,0:00:02.50,Overlay RED,", output)
        self.assertEqual(source, before)
        self.assertNotIn("color", source["segments"][0])

    def test_group_table_order_and_missing_group_head_do_not_change_color(self):
        source = group_project()
        output = render(source)
        source["subtitle_groups"]["color"].insert(0, {"id": "unused", "value": {"name": "blue"}})
        self.assertEqual(render(source), output)
        source["segments"] = []
        self.assertIn("Overlay RED", render(source))

    def test_disabled_members_and_disabled_overlay_remain_excluded(self):
        source = group_project()
        source["overlay_track"]["enabled"] = False
        self.assertNotIn("Dialogue: 2,", render(source))
        source["overlay_track"]["enabled"] = True
        source["overlay_track"]["segments"][0]["disabled"] = True
        self.assertNotIn("Dialogue: 2,", render(source))

    def test_loader_accepts_v1_5_without_rewriting_the_file_or_schema(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "v1.5.mosp"
            content = json.dumps(group_project(), ensure_ascii=False)
            path.write_text(content, encoding="utf-8")
            loaded, title = load_burn_project(path)
            self.assertEqual(loaded, normalize_project(group_project()))
            self.assertEqual(title, "v1.5")
            self.assertEqual(path.read_text(encoding="utf-8"), content)
            self.assertIn("Overlay RED", render(loaded))

    def test_invalid_group_references_and_legacy_fields_are_rejected_without_color_fallback(self):
        for invalid in ("missing", {}, None):
            source = group_project()
            source["segments"][0]["color_group_id"] = invalid
            with self.subTest(invalid=invalid), self.assertRaisesRegex(ProjectSubtitleError, "color_group_id"):
                render(source)
        source = group_project()
        source["segments"][0]["color_ref"] = {"name": "red", "headIdx": 0}
        with self.assertRaisesRegex(ProjectSubtitleError, "legacy group fields"):
            render(source)

    def test_loader_and_direct_renderer_both_reject_malformed_v1_5_and_future_versions(self):
        for source in ({**group_project(), "schema": "moy.asr.project.v2"},
                       {**group_project(), "schema": "moy.asr.project.v99"},
                       {**group_project(), "subtitle_groups": {"color": [], "sticker": []}}):
            before = copy.deepcopy(source)
            with self.subTest(source=source):
                with self.assertRaises(ProjectSubtitleError):
                    render(source)
                with tempfile.TemporaryDirectory() as directory:
                    path = Path(directory) / "invalid.mosp"
                    path.write_text(json.dumps(source), encoding="utf-8")
                    with self.assertRaises(ProjectSubtitleError):
                        load_burn_project(path)
            self.assertEqual(source, before)
