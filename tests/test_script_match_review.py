from __future__ import annotations

import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from maw.gui_web import LauncherApi
from maw.postprocess_io import read_project
from maw.postprocess_match import ScriptMatchTrace
from maw.project import normalize_project
from maw.project_mutations import replace_main_segments
from maw.project_tracks import get_main_track, get_tracks_by_role
from maw.script_match_review import ScriptMatchReview, ScriptMatchReviewApi


class ScriptMatchReviewTests(unittest.TestCase):
    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.directory = Path(temp.name)
        self.source = self.directory / "original.mosp"
        self.manuscript = self.directory / "script.txt"

    def test_restore_whole_overlap_group_and_export_unfiltered_project(self) -> None:
        from maw.media import project_media_reference

        before = normalize_project({"media": "input.mp4", "segments": [
            {"id": "main-003", "start": 0, "end": 600, "text": "原句甲", "speaker": "speaker-a"},
            {"id": "original-2", "start": 900, "end": 1800, "text": "原句乙"},
            {"id": "original-3", "start": 2500, "end": 3200, "text": "原句丙"},
            {"id": "original-4", "start": 4000, "end": 4600, "text": "原句丁"},
        ]})
        after = copy.deepcopy(before)
        replace_main_segments(after, [
            {"id": "main-001", "start": 200, "end": 1500, "text": "合并文稿"},
            {"id": "main-002", "start": 1500, "end": 1800, "text": "续"},
            {"id": "main-003", "start": 2500, "end": 3200, "text": "结果丙", "items": [
                {"start": 2500, "end": 3200, "text": "结果丙"},
            ]},
            {"id": "main-004", "start": 4000, "end": 4600, "text": "保留的隐藏组"},
        ])
        trace = ScriptMatchTrace(candidates={(200, 1500): "合并文稿"}, estimated={(0, 600)})
        review = ScriptMatchReview(before, after, trace, self.source, self.manuscript, (), "script")
        groups = review.data()["groups"]
        self.assertEqual(len(groups[0]["before"]), 2)
        self.assertEqual(len(groups[0]["after"]), 2)
        self.assertEqual(groups[0]["candidates"], ["合并文稿"])
        self.assertIn("estimated", groups[0]["issues"])
        output_dir = self.directory / "output"
        output_dir.mkdir()
        target = output_dir / "reviewed.mosp"
        cancel = ScriptMatchReviewApi(review, lambda: None)
        self.assertEqual(cancel.export_review({"restore":[0], "edits":[]}), {"ok":False, "cancelled":True})
        self.assertFalse(target.exists())
        bridge = ScriptMatchReviewApi(review, lambda: target)
        result = bridge.export_review({"restore": [0], "edits": [[1, 2, "人工改字"]], "path": str(self.source)})
        self.assertTrue(result["ok"], result)
        exported = read_project(target)
        self.assertEqual(exported["media"], project_media_reference(target, self.directory / "input.mp4"))
        main = get_main_track(exported)["segments"]
        self.assertEqual([(cue["text"], cue["start"], cue["end"]) for cue in main], [
            ("原句甲", 0, 600), ("原句乙", 900, 1800), ("人工改字", 2500, 3200), ("保留的隐藏组", 4000, 4600),
        ])
        self.assertEqual(main[0]["speaker"], get_main_track(before)["segments"][0]["speaker"])
        self.assertNotIn("items", main[2])
        self.assertFalse(bridge.export_review({"restore": [], "edits": []})["ok"])
        self.assertFalse(self.source.exists())

    def test_restore_keeps_v2_group_members_together(self) -> None:
        before = normalize_project({"segments": [
            {"start": 0, "end": 500, "text": "甲"},
            {"start": 600, "end": 900, "text": "乙"},
            {"start": 1000, "end": 1500, "text": "头", "color": {"name": "group"}},
            {"start": 1600, "end": 2100, "text": "尾", "color_ref": {"name": "group", "headIdx": 2}},
        ]})
        after = copy.deepcopy(before)
        head, tail = get_main_track(before)["segments"][2:]
        replace_main_segments(after, [
            {"id": "merged", "start": 0, "end": 900, "text": "甲乙"}, head, {**tail, "text": "新尾"},
        ])
        review = ScriptMatchReview(before, after, ScriptMatchTrace(), self.source, self.manuscript, (), "script")
        restored = review.adjusted({"restore": [1], "edits": []})
        result = get_main_track(restored)["segments"]
        self.assertEqual([cue["text"] for cue in result], ["甲乙", "头", "尾"])
        self.assertEqual(result[-1]["color_group_id"], result[1]["color_group_id"])
        self.assertEqual(restored["subtitle_groups"], before["subtitle_groups"])

    def test_review_moves_disabled_cue_back_to_main_only_when_its_group_is_restored(self):
        import json
        original = [{"id":"a","start":0,"end":1000,"text":"甲","items":[{"start":0,"end":1000,"text":"甲"}]},
                    {"id":"off","start":1200,"end":1500,"text":"备注","disabled":True},
                    {"id":"b","start":1700,"end":2200,"text":"乙","items":[{"start":1700,"end":2200,"text":"乙"}]}]
        before = normalize_project({"segments": original})
        self.source.write_text(json.dumps(before), encoding="utf-8")
        self.manuscript.write_text("甲乙", encoding="utf-8")
        api = LauncherApi()
        with patch("maw.gui_web._open_script_match_review") as show:
            outcome = api.open_script_match_review({"projectPath":str(self.source), "scriptPath":str(self.manuscript)})
            self.assertTrue(outcome["ok"], outcome)
            review = show.call_args.args[1]
        self.assertIn("overlay", review.data()["groups"][0]["issues"])
        matched = review.adjusted({"restore":[], "edits":[]})
        overlay, = get_tracks_by_role(matched,"overlay")
        self.assertEqual([c["id"] for c in overlay["segments"]], ["off"])
        restored = review.adjusted({"restore":[0], "edits":[]})
        self.assertEqual(restored, before)

    def test_same_text_and_times_can_restore_a_word_confidence_or_cue_attribute(self):
        before = normalize_project({"segments":[{"start":0,"end":1000,"text":"甲",
            "items":[{"start":0,"end":1000,"text":"甲","confidence":.98}], "custom":{"note":"original"}}]})
        after = copy.deepcopy(before)
        cue = get_main_track(after)["segments"][0]
        cue["items"][0].pop("confidence")
        cue["custom"]["note"] = "changed"
        review = ScriptMatchReview(before, after, ScriptMatchTrace(), self.source, self.manuscript, (), "script")
        group, = review.data()["groups"]
        self.assertTrue(group["changed"])
        self.assertIn("attributes", group["issues"])
        self.assertEqual(review.adjusted({"restore":[0], "edits":[]}), before)

    def test_launcher_opens_review_with_preview_settings_without_writing(self) -> None:
        source = self.directory / "original.srt"
        source.write_text("1\n00:00:00,100 --> 00:00:01,000\n甲乙\n", encoding="utf-8")
        self.manuscript.write_text("甲乙。", encoding="utf-8")
        payload = {"srtPath": str(source), "scriptPath": str(self.manuscript), "matchMode": "text", "lang": "en"}
        api = LauncherApi()
        with patch("maw.gui_web._open_script_match_review") as open_review:
            preview = api.preview_script_match(payload)
            self.assertEqual(preview["preview"], "1. 甲乙。")
            self.assertEqual(api.open_script_match_review(payload), {"ok": True})
            _root, review = open_review.call_args.args
        data = review.data()
        self.assertEqual(data["lang"], "en")
        self.assertEqual(data["groups"][0]["candidates"], ["甲乙。"])
        self.assertEqual(sorted(path.name for path in self.directory.iterdir()), ["original.srt", "script.txt"])


if __name__ == "__main__":
    unittest.main()
