import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from maw.postprocess import OutputMode
from maw.postprocess_io import read_project
from maw.postprocess_match import ScriptMatchRequest, run_script_match
from maw.project_tracks import get_main_track
from scripts.mosp_match_text import AlignmentError, generate_matched_mosp


def project():
    fixture = Path(__file__).parent / "fixtures" / "project-tracks" / "canonical.json"
    return json.loads(fixture.read_text(encoding="utf-8"))


class ScriptMatchGroupRetentionTests(unittest.TestCase):
    def test_equal_count_keeps_cue_identity_group_and_binding(self):
        original = project()
        original["tracks"][0]["segments"][0]["extra"] = {"value": 1}
        source = json.dumps(original, ensure_ascii=False)
        _cues, _report, serialized = generate_matched_mosp(source, "你好")
        result = json.loads(serialized)
        main = get_main_track(result)["segments"][0]
        self.assertEqual(main["id"], "cue-main")
        self.assertEqual(main["color_group_id"], "color-1")
        self.assertEqual(main["extra"], {"value": 1})
        self.assertEqual(result["subtitle_groups"], original["subtitle_groups"])
        self.assertEqual(result["bindings"][0]["id"], "binding-1")
        self.assertEqual(result["bindings"][0]["source_segment_ids"], ["cue-main"])
        secondary = result["tracks"][1]["segments"][0]
        self.assertEqual(result["bindings"][0]["start_offset_ms"], secondary["start"] - main["start"])
        self.assertEqual(result["bindings"][0]["end_offset_ms"], secondary["end"] - main["end"])
        self.assertEqual(json.loads(source), original)

    def test_count_change_rejects_bound_grouped_project(self):
        source = json.dumps(project(), ensure_ascii=False)
        with self.assertRaises(AlignmentError):
            generate_matched_mosp(source, "你\n好")

    def test_toolbox_equal_count_retains_binding_and_input_file(self):
        original = project()
        with TemporaryDirectory() as directory:
            source = Path(directory) / "input.mosp"
            script = Path(directory) / "script.txt"
            source.write_text(json.dumps(original, ensure_ascii=False), encoding="utf-8")
            script.write_text("你好", encoding="utf-8")
            before = source.read_bytes()
            artifact = run_script_match(ScriptMatchRequest(source, None, script, OutputMode.JSON))
            result = read_project(artifact.project_path)
            self.assertEqual(source.read_bytes(), before)
            self.assertEqual(get_main_track(result)["segments"][0]["id"], "cue-main")
            self.assertEqual(result["bindings"][0]["source_segment_ids"], ["cue-main"])
            self.assertEqual(get_main_track(result)["segments"][0]["color_group_id"], "color-1")

    def test_disabled_bound_cue_survives_toolbox_matching(self):
        original = project()
        original["tracks"][0]["segments"].insert(0, {"id": "disabled-main", "start": 1000, "end": 1100,
            "text": "保", "disabled": True, "color_group_id": "color-1",
            "items": [{"text": "保", "start": 1000, "end": 1100}]})
        original["tracks"][1]["segments"].insert(0, {"id": "disabled-en", "start": 1000, "end": 1100, "text": "Keep"})
        original["bindings"].append({"id": "disabled-binding", "source_track_id": "main",
            "target_track_id": "translation-en", "source_segment_ids": ["disabled-main"],
            "target_segment_ids": ["disabled-en"], "start_offset_ms": 0, "end_offset_ms": 0})
        with TemporaryDirectory() as directory:
            source, script = Path(directory) / "input.mosp", Path(directory) / "script.txt"
            source.write_text(json.dumps(original, ensure_ascii=False), encoding="utf-8")
            script.write_text("你好", encoding="utf-8")
            artifact = run_script_match(ScriptMatchRequest(source, None, script, OutputMode.JSON))
            result = read_project(artifact.project_path)
            self.assertEqual(get_main_track(result)["segments"][0], original["tracks"][0]["segments"][0])
            self.assertEqual({binding["id"] for binding in result["bindings"]}, {"binding-1", "disabled-binding"})

    def test_toolbox_default_keeps_period(self):
        original = project()
        with TemporaryDirectory() as directory:
            source, script = Path(directory) / "input.mosp", Path(directory) / "script.txt"
            source.write_text(json.dumps(original, ensure_ascii=False), encoding="utf-8")
            script.write_text("你好。", encoding="utf-8")
            artifact = run_script_match(ScriptMatchRequest(source, None, script, OutputMode.JSON))
            result = read_project(artifact.project_path)
            self.assertEqual(get_main_track(result)["segments"][0]["text"], "你好。")

    def test_toolbox_rejects_count_change_without_word_timings(self):
        original = project()
        original["tracks"][0]["segments"][0].pop("items")
        with TemporaryDirectory() as directory:
            source, script = Path(directory) / "input.mosp", Path(directory) / "script.txt"
            source.write_text(json.dumps(original, ensure_ascii=False), encoding="utf-8")
            script.write_text("你\n好", encoding="utf-8")
            before = source.read_bytes()
            with self.assertRaises(ValueError):
                run_script_match(ScriptMatchRequest(source, None, script, OutputMode.JSON))
            self.assertEqual(source.read_bytes(), before)
            self.assertEqual({path.name for path in Path(directory).iterdir()}, {"input.mosp", "script.txt"})

    def test_toolbox_equal_count_resegment_preserves_bindings(self):
        original = project()
        original["tracks"][0]["segments"] = [
            {"id": "cue-main", "start": 1200, "end": 1500, "text": "甲", "color_group_id": "color-1"},
            {"id": "extra-main", "start": 1500, "end": 1800, "text": "多"},
            {"id": "last-main", "start": 1800, "end": 2300, "text": "乙"},
        ]
        original["bindings"][0]["end_offset_ms"] = 850
        with TemporaryDirectory() as directory:
            source, script = Path(directory) / "input.mosp", Path(directory) / "script.txt"
            source.write_text(json.dumps(original, ensure_ascii=False), encoding="utf-8")
            script.write_text("甲\n乙", encoding="utf-8")
            artifact = run_script_match(ScriptMatchRequest(source, None, script, OutputMode.JSON))
            result = read_project(artifact.project_path)
            self.assertEqual([cue["id"] for cue in get_main_track(result)["segments"]],
                             ["cue-main", "extra-main", "last-main"])
            self.assertEqual(result["bindings"][0]["source_segment_ids"], ["cue-main"])
            self.assertEqual(get_main_track(result)["segments"][0]["color_group_id"], "color-1")


if __name__ == "__main__":
    unittest.main()
