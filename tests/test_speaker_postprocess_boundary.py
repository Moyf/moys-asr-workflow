import copy
import json
from pathlib import Path
import tempfile
import unittest

from maw.postprocess import (
    LlmPostprocessRequest, OutputMode, _apply_llm_atom_groups_with_warnings,
    apply_llm_groups, run_llm_postprocess,
)
from maw.postprocess_io import read_project
from maw.project_tracks import get_main_track, make_project


def _project(identities):
    segments = []
    for index, identity in enumerate(identities):
        start = index * 100
        segment = {"id": f"cue-{index + 1}", "start": start, "end": start + 100, "text": str(index + 1),
                   "items": [{"start": start, "end": start + 100, "text": str(index + 1)}]}
        if identity is not None:
            segment["speaker"] = identity
        segments.append(segment)
    return make_project(segments, project_fields={"speakers": [
        {"id": "p1", "name": "同名", "color": "#969fab"},
        {"id": "p2", "name": "同名", "color": "#969fab"},
    ]})


class SpeakerPostprocessBoundaryTests(unittest.TestCase):
    def test_cue_and_atom_merges_reject_distinct_or_assigned_unassigned_sources_without_mutation(self):
        for identities in (("p1", "p2"), ("p1", None), (None, "p1")):
            for mode in ("cues", "atoms"):
                with self.subTest(identities=identities, mode=mode):
                    project = _project(identities)
                    before = copy.deepcopy(project)
                    with self.assertRaisesRegex(ValueError, "different speaker identities"):
                        if mode == "cues":
                            apply_llm_groups(project, {"groups": [{"source_ids": ["c0001", "c0002"], "text": "12"}]})
                        else:
                            _apply_llm_atom_groups_with_warnings(project, {"groups": [{"atom_ids": ["c0001a0001", "c0002a0001"]}]})
                    self.assertEqual(project, before)

    def test_equal_and_unassigned_merges_remain_supported_in_both_protocols(self):
        for identities in (("p1", "p1"), (None, None)):
            for mode in ("cues", "atoms"):
                with self.subTest(identities=identities, mode=mode):
                    project = _project(identities)
                    before = copy.deepcopy(project)
                    if mode == "cues":
                        processed = apply_llm_groups(project, {"groups": [{"source_ids": ["c0001", "c0002"], "text": "12"}]})
                    else:
                        processed, _ = _apply_llm_atom_groups_with_warnings(project, {"groups": [{"atom_ids": ["c0001a0001", "c0002a0001"]}]})
                    self.assertEqual(project, before)
                    segments = get_main_track(processed)["segments"]
                    self.assertEqual(len(segments), 1)
                    self.assertEqual(segments[0].get("speaker"), identities[0])
                    self.assertEqual(segments[0]["text"], "12")

    def test_resegment_respects_visual_and_speaker_boundaries_together(self):
        for kind in ("color", "sticker"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                project = _project(("p1", "p1", "p1", "p2"))
                project["subtitle_groups"][kind] = [{"id": "g", "value": {"name": "group"}}]
                segments = get_main_track(project)["segments"]
                for segment in segments[:2]:
                    segment[f"{kind}_group_id"] = "g"
                source = Path(directory) / "source.mosp"
                source.write_text(json.dumps(project), encoding="utf-8")
                requests = []
                def complete(_prompt, rows):
                    requests.append([row["text"] for row in rows])
                    return {"draft": f"[{rows[-1]['items'][-1]['id']}]"}
                artifact = run_llm_postprocess(LlmPostprocessRequest(
                    project_path=source, srt_path=None, output_mode=OutputMode.JSON,
                    operation="resegment", custom_prompt="",
                ), complete=complete)
                result = get_main_track(read_project(artifact.project_path))["segments"]
                self.assertEqual(requests, [["1", "2"], ["3"], ["4"]])
                self.assertEqual([s["text"] for s in result], ["12", "3", "4"])
                self.assertEqual([s["speaker"] for s in result], ["p1", "p1", "p2"])
                self.assertEqual(result[0][f"{kind}_group_id"], "g")
                self.assertNotIn(f"{kind}_group_id", result[1])
                self.assertTrue(all("speaker" not in item for s in result for item in s.get("items", [])))

    def test_real_resegment_separates_assigned_unassigned_and_distinct_identities(self):
        for identities in (("p1", "p2"), ("p1", None), (None, "p1")):
            with self.subTest(identities=identities), tempfile.TemporaryDirectory() as directory:
                source = Path(directory) / "source.mosp"
                source.write_text(json.dumps(_project(identities)), encoding="utf-8")
                before = source.read_bytes()
                requests = []

                def complete(_prompt, rows):
                    requests.append(copy.deepcopy(rows))
                    return {"draft": f"[{rows[-1]['items'][-1]['id']}]"}

                artifact = run_llm_postprocess(LlmPostprocessRequest(
                    project_path=source, srt_path=None, output_mode=OutputMode.JSON,
                    operation="resegment", custom_prompt="",
                ), complete=complete)
                self.assertEqual(source.read_bytes(), before)
                self.assertEqual([len(rows) for rows in requests], [1, 1])
                segments = get_main_track(read_project(artifact.project_path))["segments"]
                self.assertEqual([segment.get("speaker") for segment in segments], list(identities))
                self.assertEqual([segment["text"] for segment in segments], ["1", "2"])


if __name__ == "__main__":
    unittest.main()
