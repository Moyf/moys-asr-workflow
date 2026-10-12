from __future__ import annotations

import copy
import json
from pathlib import Path
import tempfile
import unittest

from maw.postprocess import LlmPostprocessRequest, OutputMode, run_llm_postprocess
from maw.postprocess_annotations import validate_annotations, write_annotations
from maw.postprocess_comparison import comparison_data
from maw.project import normalize_project


def source_project():
    return normalize_project({"schema": "moy.asr.project.v1", "segments": [
        {"id": "main-001", "start": 0, "end": 1000, "text": "介绍 API。", "items": [{"start": 0, "end": 1000, "text": "介绍 API。"}]},
        {"id": "main-002", "start": 1200, "end": 2200, "text": "它可以处理字幕。"},
    ], "user_metadata": {"keep": "原元数据"}})


class AnnotationTest(unittest.TestCase):
    def test_scope_validation_and_distinct_review_state(self):
        project = source_project()
        sources = {"c0001": project["segments"][0], "c0002": project["segments"][1]}
        raw = [{"source_ids": ["c0001"], "kind": "note", "message": "API 指接口"},
               {"source_ids": ["c0002"], "kind": "review", "message": "代词指向需要确认"}]
        self.assertFalse(write_annotations(project, sources, raw, "translate_en"))
        notes = project["markers"]["items"]
        self.assertNotIn("review", notes[0])
        self.assertEqual(notes[0]["note"], "[AI] 注：API 指接口")
        self.assertEqual(notes[1]["review"]["status"], "pending")
        self.assertEqual((notes[1]["start"], notes[1]["end"]), (1200, 2200))
        for bad in ([{"source_ids": ["unknown"], "kind": "note", "message": "bad"}],
                    [{"source_ids": ["c0001"], "kind": [], "message": "bad"}],
                    [{"source_ids": ["c0001"], "kind": "note", "message": "bad\x00"}],
                    [{"source_ids": ["c0001"], "kind": "note", "message": " "}], [{}] * 81):
            accepted, warnings = validate_annotations(bad, sources)
            self.assertFalse(accepted)
            self.assertTrue(warnings)

    def test_rerun_reuses_ids_and_preserves_user_edits_and_other_tasks(self):
        project = source_project()
        sources = {"c0001": project["segments"][0], "c0002": project["segments"][1]}
        raw = [{"source_ids": ["c0001"], "kind": "note", "message": "原备注"},
               {"source_ids": ["c0002"], "kind": "review", "message": "疑点"}]
        write_annotations(project, sources, raw, "proofread")
        old = copy.deepcopy(project["markers"]["items"])
        raw[0]["message"] = "更新备注"
        write_annotations(project, sources, raw, "proofread")
        self.assertEqual([m["id"] for m in project["markers"]["items"]], [m["id"] for m in old])
        project["markers"]["items"][0]["note"] = "用户已改"
        project["markers"]["items"][1]["review"]["status"] = "confirmed"
        protected = copy.deepcopy(project["markers"]["items"])
        write_annotations(project, sources, raw, "proofread")
        self.assertEqual(project["markers"]["items"], protected)
        write_annotations(project, sources, raw[:1], "translate_en")
        write_annotations(project, sources, [], "translate_en")
        self.assertEqual(project["markers"]["items"], protected)
        self.assertEqual(project["segments"], source_project()["segments"])

    def test_normalized_save_reopen_and_multiple_batches(self):
        project = source_project()
        sources = {"c0001": project["segments"][0]}
        raw = [{"source_ids": ["c0001"], "kind": "note", "message": f"注{i}"} for i in range(90)]
        write_annotations(project, sources, raw, "custom")
        reopened = normalize_project(json.loads(json.dumps(project)))
        self.assertEqual(reopened["markers"], project["markers"])
        write_annotations(reopened, sources, [], "custom")
        self.assertEqual(reopened["markers"]["items"], [])

    def test_end_to_end_translation_and_proofread_return_annotations(self):
        for operation in ("proofread", "custom", "translate_en"):
            with self.subTest(operation=operation), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "input.mosp"
                path.write_text(json.dumps(source_project()), encoding="utf-8")
                def complete(prompt, cues):
                    self.assertIn("annotations", prompt)
                    return {"groups": [{"id": row["id"], "text": "A translation."} for row in cues],
                            "annotations": [{"source_ids": [cues[0]["id"]], "kind": "note", "message": "术语说明"}]}
                artifact = run_llm_postprocess(LlmPostprocessRequest(path, None, OutputMode.BOTH, operation, "", generate_comparison=True), complete=complete)
                project = json.loads(artifact.project_path.read_text(encoding="utf-8"))
                self.assertEqual(project["markers"]["items"][0]["note"], "[AI] 注：术语说明")
                self.assertTrue(comparison_data(source_project(), project, operation)["rows"][0]["notes"])

    def test_translation_repair_preserves_accepted_notes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "input.mosp"
            path.write_text(json.dumps(source_project()), encoding="utf-8")
            calls = []
            def complete(prompt, cues):
                calls.append(cues)
                row = cues[0]
                return {"groups": [{"id": row["id"], "text": "Translated."}],
                        "annotations": [{"source_ids": [row["id"]], "kind": "review", "message": "需确认"}]}
            artifact = run_llm_postprocess(LlmPostprocessRequest(path, None, OutputMode.JSON, "translate_en", ""), complete=complete)
            result = json.loads(artifact.project_path.read_text(encoding="utf-8"))
            self.assertGreater(len(calls), 1)
            self.assertEqual(len(result["markers"]["items"]), 2)


if __name__ == "__main__":
    unittest.main()
