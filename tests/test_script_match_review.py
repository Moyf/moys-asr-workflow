from __future__ import annotations

import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from maw.gui_web import LauncherApi
from maw.postprocess import OutputMode
from maw.postprocess_ai_cleanup import AiCleanupRequest, run_ai_cleanup
from maw.postprocess_ai_cleanup_items import verified_scope_indices
from maw.postprocess_io import read_project, render_srt
from maw.postprocess_match import ScriptMatchTrace
from maw.project import normalize_project
from maw.project_mutations import replace_main_segments
from maw.project_tracks import get_main_track, get_tracks_by_role
from maw.script_alignment import _gap_ranges_from_provenance
from maw.script_match_review import ScriptMatchReview, ScriptMatchReviewApi


class ScriptMatchReviewTests(unittest.TestCase):
    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.directory = Path(temp.name)
        self.source = self.directory / "original.mosp"
        self.manuscript = self.directory / "script.txt"

    def cleaned_input(self) -> Path:
        words = [" Hello", " Hello", " world "]
        self.source.write_text(json.dumps({"segments": [
            {"id": "greeting", "start": 0, "end": 600, "text": "Hello Hello world", "items": [
                {"start": i * 200, "end": (i + 1) * 200, "text": word} for i, word in enumerate(words)
            ]},
            {"id": "next", "start": 1000, "end": 1400, "text": "Next", "items": [
                {"start": 1000, "end": 1400, "text": "Next"},
            ]},
            {"id": "last", "start": 2000, "end": 2400, "text": "End"},
        ]}), encoding="utf-8")
        self.manuscript.write_text("Hello Hello world\nNext\nEnd", encoding="utf-8")
        cleaned = run_ai_cleanup(
            AiCleanupRequest(self.source, None, None, OutputMode.BOTH, review_enabled=False),
            complete=lambda _prompt, rows: {"timeline": "\n".join(
                f"[{row['id']}] ~~Hello~~ Hello world" if row["asrText"] == "Hello Hello world"
                else row["sourceLine"] for row in rows
            )},
        )
        self.assertEqual(cleaned.srt_path.read_text(encoding="utf-8-sig").splitlines()[2], "Hello world")
        return cleaned.project_path

    def test_launcher_match_keeps_spaced_word_cut_and_reversible_source(self) -> None:
        source = self.cleaned_input()
        original = source.read_bytes()
        before = read_project(source)
        result = LauncherApi().run_script_match({
            "projectPath": str(source), "scriptPath": str(self.manuscript), "outputMode": "both",
        })
        self.assertTrue(result["ok"], result)
        self.assertTrue(any("缺少字词时间码" in warning for warning in result["warnings"]))
        rendered = Path(result["srtPath"]).read_text(encoding="utf-8-sig")
        self.assertEqual(rendered.splitlines()[2], "Hello world")
        matched = read_project(Path(result["projectPath"]))
        cue = get_main_track(matched)["segments"][0]
        self.assertEqual(cue["text"], "Hello Hello world")
        gap = matched["gap_remove"]
        entry, = gap["provenance"]["sources"]["ai_cleanup"]
        self.assertEqual(list(verified_scope_indices(entry, cue)), [0])
        self.assertEqual(gap["gaps"], before["gap_remove"]["gaps"])
        self.assertEqual(_gap_ranges_from_provenance(gap["provenance"]), [
            {"start": 0, "end": 200, "removed": True},
        ])
        gap["provenance"]["manual_overrides"].append({"id": "restore", "start": 0, "end": 200, "removed": False})
        gap["gaps"] = _gap_ranges_from_provenance(gap["provenance"])
        self.assertEqual(render_srt(matched).splitlines()[2], "Hello Hello world")
        self.assertEqual(source.read_bytes(), original)

    def test_review_preserves_a_restored_cut_and_rejects_an_unmappable_edit(self) -> None:
        source = self.cleaned_input()
        before = read_project(source)
        gap = before["gap_remove"]
        gap["provenance"]["manual_overrides"].append({"id": "restore", "start": 0, "end": 200, "removed": False})
        gap["gaps"] = _gap_ranges_from_provenance(gap["provenance"])
        source.write_text(json.dumps(before), encoding="utf-8")
        original = source.read_bytes()
        payload = {"projectPath": str(source), "scriptPath": str(self.manuscript)}
        with patch("maw.gui_web._open_script_match_review") as show:
            result = LauncherApi().open_script_match_review(payload)
            self.assertTrue(result["ok"], result)
            review = show.call_args.args[1]
        for restore in ([], [0]):
            with self.subTest(restore=restore):
                target = self.directory / f"reviewed-{len(restore)}.mosp"
                result = ScriptMatchReviewApi(review, lambda: target).export_review({"restore": restore, "edits": []})
                self.assertTrue(result["ok"], result)
                projected = read_project(target)
                cue = get_main_track(projected)["segments"][0]
                saved_gap = projected["gap_remove"]
                entry, = saved_gap["provenance"]["sources"]["ai_cleanup"]
                self.assertEqual(list(verified_scope_indices(entry, cue)), [0])
                self.assertEqual(render_srt(projected).splitlines()[2], "Hello Hello world")
                self.assertEqual(saved_gap["gaps"], [{"start": 0, "end": 200, "removed": False}])
                self.assertEqual(saved_gap["provenance"]["manual_overrides"], gap["provenance"]["manual_overrides"])
                saved_gap["provenance"]["manual_overrides"] = []
                saved_gap["gaps"] = _gap_ranges_from_provenance(saved_gap["provenance"])
                self.assertEqual(render_srt(projected).splitlines()[2], "Hello world")
        target = self.directory / "edited.mosp"
        result = ScriptMatchReviewApi(review, lambda: target).export_review({
            "restore": [], "edits": [[1, 0, "Hello Hello planet"]],
        })
        self.assertTrue(result["ok"], result)
        self.assertEqual(render_srt(read_project(target)).splitlines()[2], "Hello Hello planet")
        target = self.directory / "unmappable.mosp"
        picker = Mock(return_value=target)
        result = ScriptMatchReviewApi(review, picker).export_review({"restore": [], "edits": [[1, 0, "Goodbye Hello world"]]})
        self.assertFalse(result["ok"], result)
        self.assertIn("局部删减", result["error"])
        picker.assert_not_called()
        self.assertFalse(target.exists())
        self.assertEqual(source.read_bytes(), original)

    def test_launcher_rejects_an_unmappable_word_cut_before_writing(self) -> None:
        source = self.cleaned_input()
        self.manuscript.write_text("Goodbye Hello world\nNext\nEnd", encoding="utf-8")
        files = set(self.directory.iterdir())
        original = source.read_bytes()
        result = LauncherApi().run_script_match({
            "projectPath": str(source), "scriptPath": str(self.manuscript), "outputMode": "both",
        })
        self.assertFalse(result["ok"], result)
        self.assertIn("局部删减", result["detail"])
        self.assertEqual(set(self.directory.iterdir()), files)
        self.assertEqual(source.read_bytes(), original)

    def test_launcher_match_preserves_an_audio_pause_when_a_cut_spans_new_cues(self) -> None:
        words = ["这个", "这个", "这个", "方法"]
        self.source.write_text(json.dumps({"segments": [{
            "id": "original", "start": 0, "end": 720, "text": "".join(words), "items": [
                {"start": i * 200, "end": i * 200 + 120, "text": word} for i, word in enumerate(words)
            ],
        }]}), encoding="utf-8")
        cleaned = run_ai_cleanup(
            AiCleanupRequest(self.source, None, None, OutputMode.BOTH, review_enabled=False),
            complete=lambda _prompt, _rows: {"timeline": "[c001] ~~这个这个~~这个方法"},
        )
        source = cleaned.project_path
        before = read_project(source)
        cut, = before["gap_remove"]["provenance"]["sources"]["ai_cleanup"]
        cut["cleanup_scope"]["vendor"] = {"note": "preserve"}
        source.write_text(json.dumps(before), encoding="utf-8")
        self.manuscript.write_text("这个\n这个\n这个方法", encoding="utf-8")
        result = LauncherApi().run_script_match({
            "projectPath": str(source), "scriptPath": str(self.manuscript), "outputMode": "both",
        })
        self.assertTrue(result["ok"], result)
        after = read_project(Path(result["projectPath"]))
        main = get_main_track(after)["segments"]
        self.assertEqual([cue["text"] for cue in main], ["这个", "这个", "这个方法"])
        self.assertEqual(Path(result["srtPath"]).read_text(encoding="utf-8-sig").splitlines()[2:], ["这个方法"])
        provenance = after["gap_remove"]["provenance"]
        first, pause, second = provenance["sources"]["ai_cleanup"]
        self.assertEqual(list(verified_scope_indices(first, main[0])), [0])
        self.assertEqual(list(verified_scope_indices(second, main[1])), [0])
        self.assertEqual(first["cleanup_scope"]["vendor"], cut["cleanup_scope"]["vendor"])
        self.assertEqual(second["cleanup_scope"]["vendor"], cut["cleanup_scope"]["vendor"])
        self.assertEqual((pause["start"], pause["end"]), (120, 200))
        self.assertNotIn("cleanup_scope", pause)
        self.assertEqual(_gap_ranges_from_provenance(provenance), [{"start": 0, "end": 320, "removed": True}])
        self.assertEqual(after["gap_remove"]["gaps"], before["gap_remove"]["gaps"])

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
