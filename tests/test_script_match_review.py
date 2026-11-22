from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from maw.gui_web import LauncherApi
from maw.postprocess_io import read_project
from maw.postprocess_match import ScriptMatchTrace
from maw.project import normalize_project
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
        after = normalize_project({**before, "segments": [
            {"id": "main-001", "start": 200, "end": 1500, "text": "合并文稿"},
            {"id": "main-002", "start": 1500, "end": 1800, "text": "续"},
            {"id": "main-003", "start": 2500, "end": 3200, "text": "结果丙", "items": [
                {"start": 2500, "end": 3200, "text": "结果丙"},
            ]},
            {"id": "main-004", "start": 4000, "end": 4600, "text": "保留的隐藏组"},
        ]})
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
        bridge = ScriptMatchReviewApi(review, lambda: target)
        result = bridge.export_review({"restore": [0], "edits": [[1, 2, "人工改字"]], "path": str(self.source)})
        self.assertTrue(result["ok"], result)
        exported = read_project(target)
        self.assertEqual(exported["media"], project_media_reference(target, self.directory / "input.mp4"))
        self.assertEqual([(cue["text"], cue["start"], cue["end"]) for cue in exported["segments"]], [
            ("原句甲", 0, 600), ("原句乙", 900, 1800), ("人工改字", 2500, 3200), ("保留的隐藏组", 4000, 4600),
        ])
        self.assertEqual(exported["segments"][0]["speaker"], "speaker-a")
        self.assertNotIn("items", exported["segments"][2])
        self.assertFalse(bridge.export_review({"restore": [], "edits": []})["ok"])
        self.assertFalse(self.source.exists())

    def test_restore_keeps_head_references_and_rebases_indexes(self) -> None:
        before = normalize_project({"segments": [
            {"start": 0, "end": 500, "text": "甲"},
            {"start": 600, "end": 900, "text": "乙"},
            {"start": 1000, "end": 1500, "text": "头", "color": {"name": "group"}},
            {"start": 1600, "end": 2100, "text": "尾", "color_ref": {"name": "group", "headIdx": 2}},
        ]})
        after = normalize_project({"segments": [
            {"id": "merged", "start": 0, "end": 900, "text": "甲乙"},
            {"id": "head", "start": 1000, "end": 1500, "text": "头"},
            {"id": "tail", "start": 1600, "end": 2100, "text": "新尾"},
        ]})
        review = ScriptMatchReview(before, after, ScriptMatchTrace(), self.source, self.manuscript, (), "script")
        result = review.adjusted({"restore": [1], "edits": []})["segments"]
        self.assertEqual([cue["text"] for cue in result], ["甲乙", "头", "尾"])
        self.assertEqual(result[-1]["color_ref"]["headIdx"], 1)

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
