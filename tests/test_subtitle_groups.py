import copy
import json
import unittest

from maw.project import normalize_project, validate_project
from maw.project_io import serialize_mosp


class SubtitleGroupContractTests(unittest.TestCase):
    def fixture(self):
        return {"schema": "moy.asr.project.v2", "subtitle_groups": {
            "color": [], "sticker": [{"id": "s1", "value": {"name": "cat", "rel": "cat.png"}}]},
            "segments": [{"id": "a", "start": 1000, "end": 3000, "text": "one", "sticker_group_id": "s1"}],
            "overlay_track": {"enabled": True, "segments": [
                {"id": "b", "start": 5000, "end": 7000, "text": "two", "sticker_group_id": "s1"}]}}

    def test_round_trip_retains_version_cross_track_members_and_extensions(self):
        source = self.fixture()
        source["segments"][0]["vendor"] = {"x": [1]}
        original = copy.deepcopy(source)
        saved = json.loads(serialize_mosp(normalize_project(source)))
        self.assertEqual(source, original)
        self.assertEqual(saved["schema"], "moy.asr.project.v2")
        self.assertEqual(saved["subtitle_groups"], source["subtitle_groups"])
        self.assertEqual(saved["overlay_track"]["segments"][0]["sticker_group_id"], "s1")
        self.assertEqual(saved["segments"][0]["vendor"], {"x": [1]})

    def test_rejects_missing_groups_duplicate_identity_bad_reference_and_second_range(self):
        cases = []
        p = self.fixture(); del p["subtitle_groups"]; cases.append((p, "$.subtitle_groups"))
        p = self.fixture(); p["overlay_track"]["segments"][0]["id"] = "a"
        cases.append((p, "$.overlay_track.segments[0].id"))
        p = self.fixture(); p["segments"][0]["sticker_group_id"] = "missing"
        cases.append((p, "$.segments[0].sticker_group_id"))
        p = self.fixture(); p["subtitle_groups"]["sticker"][0]["value"]["end"] = 9999
        cases.append((p, "$.subtitle_groups.sticker[0].value"))
        p = self.fixture(); p["segments"][0]["sticker_ref"] = {"headIdx": 0}
        cases.append((p, "$.segments[0].sticker"))
        p = self.fixture(); p["segments"][0]["sticker_group_id"] = {}
        cases.append((p, "$.segments[0].sticker_group_id"))
        for project, path in cases:
            with self.subTest(path=path):
                result = validate_project(project)
                self.assertFalse(result.ok)
                self.assertIn(path, {error.path for error in result.errors})

    def test_writer_rejects_future_schema_instead_of_downgrading(self):
        source = self.fixture(); source["schema"] = "moy.asr.project.v99"
        with self.assertRaises(ValueError):
            serialize_mosp(source)

    def test_character_match_preserves_v2_groups_and_rejects_lossy_count_change(self):
        from scripts.mosp_match_text import AlignmentError, generate_matched_mosp
        source = self.fixture()
        source["segments"][0]["items"] = [{"text": "one", "start": 1000, "end": 3000}]
        source["segments"][0]["assOverride"] = {"pos": {"x": 10, "y": 20}}
        source["segments"][0]["vendor"] = {"keep": [1]}
        _, _, text = generate_matched_mosp(json.dumps(source), "one")
        matched = normalize_project(json.loads(text))
        self.assertEqual(matched["schema"], source["schema"])
        self.assertEqual(matched["segments"][0]["sticker_group_id"], "s1")
        self.assertEqual(matched["segments"][0]["vendor"], {"keep": [1]})
        self.assertEqual(matched["segments"][0]["assOverride"], {"pos": {"x": 10, "y": 20}})
        with self.assertRaisesRegex(AlignmentError, "独立分组"):
            generate_matched_mosp(json.dumps(source), "o\nne")
