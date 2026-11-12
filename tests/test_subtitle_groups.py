import copy
import json
import unittest
import tempfile
from pathlib import Path

from maw.project import normalize_project, validate_project
from maw.project_io import serialize_mosp
from maw.project_tracks import get_main_track, get_tracks_by_role


class SubtitleGroupContractTests(unittest.TestCase):
    def fixture(self):
        return {"schema": "moy.asr.project.v1.5", "subtitle_groups": {
            "color": [], "sticker": [{"id": "s1", "value": {"name": "cat", "rel": "cat.png"}}]},
            "segments": [{"id": "a", "start": 1000, "end": 3000, "text": "one", "sticker_group_id": "s1"}],
            "overlay_track": {"enabled": True, "segments": [
                {"id": "b", "start": 5000, "end": 7000, "text": "two", "sticker_group_id": "s1"}]}}

    def test_v15_migration_retains_cross_track_members_and_extensions(self):
        source = self.fixture()
        source["segments"][0]["vendor"] = {"x": [1]}
        original = copy.deepcopy(source)
        saved = json.loads(serialize_mosp(normalize_project(source)))
        self.assertEqual(source, original)
        self.assertEqual(saved["schema"], "moy.asr.project.v2")
        self.assertEqual(saved["subtitle_groups"], source["subtitle_groups"])
        self.assertEqual(get_tracks_by_role(saved, "overlay")[0]["segments"][0]["sticker_group_id"], "s1")
        self.assertEqual(get_main_track(saved)["segments"][0]["vendor"], {"x": [1]})

    def test_rejects_missing_groups_duplicate_identity_bad_reference_and_second_range(self):
        cases = []
        p = self.fixture()
        del p["subtitle_groups"]
        cases.append((p, "$.subtitle_groups"))
        p = self.fixture()
        p["overlay_track"]["segments"][0]["id"] = "a"
        cases.append((p, "$.tracks[1].segments[0].id"))
        p = self.fixture()
        p["segments"][0]["sticker_group_id"] = "missing"
        cases.append((p, "$.tracks[0].segments[0].sticker_group_id"))
        p = self.fixture()
        p["subtitle_groups"]["sticker"][0]["value"]["end"] = 9999
        cases.append((p, "$.subtitle_groups.sticker[0].value"))
        p = self.fixture()
        p["segments"][0]["sticker_ref"] = {"headIdx": 0}
        cases.append((p, "$.tracks[0].segments[0].sticker"))
        p = self.fixture()
        p["segments"][0]["sticker_group_id"] = {}
        cases.append((p, "$.tracks[0].segments[0].sticker_group_id"))
        for project, path in cases:
            with self.subTest(path=path):
                result = validate_project(project)
                self.assertFalse(result.ok)
                self.assertIn(path, {error.path for error in result.errors})

    def test_writer_rejects_legacy_shape_as_v2_and_future_schema(self):
        from scripts.mosp_match_text import AlignmentError, generate_matched_mosp
        for schema in ("moy.asr.project.v2", "moy.asr.project.v99"):
            source = self.fixture()
            source["schema"] = schema
            before = copy.deepcopy(source)
            with self.subTest(schema=schema):
                self.assertFalse(validate_project(source).ok)
                with self.assertRaises(ValueError):
                    serialize_mosp(source)
                with self.assertRaises(AlignmentError):
                    generate_matched_mosp(json.dumps(source), "one")
                self.assertEqual(source, before)

    def test_character_match_preserves_v1_5_groups_and_rejects_lossy_count_change(self):
        from scripts.mosp_match_text import AlignmentError, generate_matched_mosp
        source = self.fixture()
        source["segments"][0]["items"] = [{"text": "one", "start": 1000, "end": 3000}]
        source["segments"][0]["assOverride"] = {"pos": {"x": 10, "y": 20}}
        source["segments"][0]["vendor"] = {"keep": [1]}
        _, _, text = generate_matched_mosp(json.dumps(source), "one")
        matched = normalize_project(json.loads(text))
        self.assertEqual(matched["schema"], "moy.asr.project.v2")
        self.assertEqual(get_main_track(matched)["segments"][0]["sticker_group_id"], "s1")
        self.assertEqual(get_main_track(matched)["segments"][0]["vendor"], {"keep": [1]})
        self.assertEqual(get_main_track(matched)["segments"][0]["assOverride"], {"pos": {"x": 10, "y": 20}})
        with self.assertRaisesRegex(AlignmentError, "独立分组"):
            generate_matched_mosp(json.dumps(source), "o\nne")

    def test_match_accepts_nullable_tracks_and_reserves_all_existing_ids(self):
        from scripts.mosp_match_text import generate_matched_mosp

        for multi in (
            None,
            {"tracks": None},
            {"tracks": [{"id": "ext", "segments": None}]},
        ):
            for overlay in (None, {"segments": None}):
                with self.subTest(multi=multi, overlay=overlay):
                    source = {
                        "schema": "moy.asr.project.v1.5",
                        "subtitle_groups": {"color": [], "sticker": []},
                        "segments": [
                            {
                                "id": "main",
                                "start": 0,
                                "end": 1000,
                                "text": "甲乙",
                                "items": [
                                    {"text": "甲", "start": 0, "end": 500},
                                    {"text": "乙", "start": 500, "end": 1000},
                                ],
                            }
                        ],
                        "multi_subtitle": multi,
                        "overlay_track": overlay,
                    }
                    self.assertTrue(validate_project(source).ok)
                    _, _, text = generate_matched_mosp(json.dumps(source), "甲。乙")
                    output = json.loads(text)
                    self.assertTrue(validate_project(output).ok)
                    self.assertEqual(
                        [s["id"] for s in get_main_track(output)["segments"]],
                        ["matched-cue-1", "matched-cue-2"],
                    )

    def test_match_rejects_bound_count_change_and_updates_retained_binding_offsets(
        self,
    ):
        from scripts.mosp_match_text import AlignmentError, generate_matched_mosp

        source = {
            "schema": "moy.asr.project.v1.5",
            "subtitle_groups": {"color": [], "sticker": []},
            "segments": [
                {
                    "id": "main",
                    "start": 0,
                    "end": 1000,
                    "text": "甲乙",
                    "items": [
                        {"text": "甲", "start": 100, "end": 500},
                        {"text": "乙", "start": 500, "end": 900},
                    ],
                }
            ],
            "multi_subtitle": {
                "tracks": [
                    {
                        "id": "ext",
                        "segments": [
                            {"id": "translation", "start": 0, "end": 1000, "text": "AB"}
                        ],
                    }
                ],
                "bindings": [
                    {
                        "track_id": "ext",
                        "main_segment_ids": ["main"],
                        "extension_segment_ids": ["translation"],
                        "start_offset_ms": 0,
                        "end_offset_ms": 0,
                    }
                ],
            },
        }
        self.assertTrue(validate_project(source).ok)
        before = copy.deepcopy(source)
        with self.assertRaisesRegex(AlignmentError, "双语绑定"):
            generate_matched_mosp(json.dumps(source), "甲。乙")
        _, _, text = generate_matched_mosp(json.dumps(source), "甲乙")
        output = json.loads(text)
        self.assertTrue(validate_project(output).ok)
        binding = output["bindings"][0]
        self.assertEqual(
            (binding["start_offset_ms"], binding["end_offset_ms"]), (-100, 100)
        )
        self.assertEqual(source, before)

        for field in ("main", "track", "main-ref", "extension-ref", "extension", "track-ref"):
            with self.subTest(padded=field):
                padded = copy.deepcopy(source)
                track = padded["multi_subtitle"]["tracks"][0]
                binding = padded["multi_subtitle"]["bindings"][0]
                if field == "main":
                    padded["segments"][0]["id"] = " main "
                elif field == "track":
                    track["id"] = " ext "
                elif field == "main-ref":
                    binding["main_segment_ids"] = [" main "]
                elif field == "extension-ref":
                    binding["extension_segment_ids"] = [" translation "]
                elif field == "extension":
                    track["segments"][0]["id"] = " translation "
                else:
                    binding["track_id"] = " ext "
                self.assertTrue(validate_project(padded).ok)
                _, _, text = generate_matched_mosp(json.dumps(padded), "甲乙")
                self.assertTrue(validate_project(json.loads(text)).ok)

    def test_match_reserves_normalized_other_track_ids(self):
        from scripts.mosp_match_text import generate_matched_mosp

        source = {"schema": "moy.asr.project.v1.5", "subtitle_groups": {"color": [], "sticker": []},
                  "segments": [{"id": "main", "start": 0, "end": 1000, "text": "甲乙",
                                "items": [{"text": "甲", "start": 0, "end": 500},
                                          {"text": "乙", "start": 500, "end": 1000}]}],
                  "overlay_track": {"segments": [
                      {"id": " matched-cue-1 ", "start": 0, "end": 1000, "text": "overlay"}]}}
        self.assertTrue(validate_project(source).ok)
        _, _, text = generate_matched_mosp(json.dumps(source), "甲。乙")
        output = json.loads(text)
        self.assertTrue(validate_project(output).ok)
        self.assertEqual([s["id"] for s in get_main_track(output)["segments"]], ["matched-cue-1-2", "matched-cue-2"])

    def test_sentence_level_match_rejects_lossy_group_changes_before_writing(self):
        from maw.postprocess import OutputMode
        from maw.postprocess_match import ScriptMatchRequest, run_script_match

        source = {"schema": "moy.asr.project.v1.5", "subtitle_groups": {"color": [], "sticker": [
            {"id": "s1", "value": {"name": "cat"}}, {"id": "s2", "value": {"name": "dog"}}]},
            "segments": [{"id": text, "text": text, "start": index * 1000, "end": (index + 1) * 1000,
                          "sticker_group_id": "s1" if index == 0 else "s2"}
                         for index, text in enumerate("ABC")]}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = root / "input.mosp"
            script = root / "script.txt"
            project.write_text(json.dumps(source), encoding="utf8")
            script.write_text("AB\nC", encoding="utf8")
            before = project.read_bytes()
            request = ScriptMatchRequest(project, None, script, OutputMode.BOTH,
                                         output_directory=root / "output", match_mode="script")
            with self.assertRaisesRegex(ValueError, "独立分组"):
                run_script_match(request)
            self.assertFalse((root / "output").exists())
            self.assertEqual(project.read_bytes(), before)
