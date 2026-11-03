from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import unittest

from maw.project import PROJECT_SCHEMA, ProjectValidationFailed, normalize_project, validate_project, repair_project_timing_ranges
from maw.project_tracks import (
    get_main_track, get_track, get_tracks_by_role, import_project, iter_segments,
    make_project, migrate_project_tracks, validate_tracks_project,
)


def cue(identifier="cue-1", start=1000, end=2000, **fields):
    return {"id": identifier, "start": start, "end": end, "text": "hello", **fields}


def track(identifier="main", role="main", segments=None, **fields):
    return {"id": identifier, "role": role, "name": role, "enabled": True,
            "segments": [cue()] if segments is None else segments, **fields}


def canonical():
    return {"schema": PROJECT_SCHEMA, "tracks": [track()], "bindings": [],
            "bilingual": {"display_mode": "both"},
            "subtitle_groups": {"next_id": 1, "color": [], "sticker": []}}


class ProjectTracksTests(unittest.TestCase):
    def assertRejected(self, value, path):
        original = copy.deepcopy(value)
        result = validate_project(value)
        self.assertFalse(result.ok)
        self.assertIsNone(result.project)
        self.assertIn(path, [error.path for error in result.errors])
        self.assertEqual(value, original)

    def test_shared_track_options(self):
        options = json.loads((Path(__file__).parent / "fixtures" / "project-tracks" / "track-options.json").read_text(encoding="utf-8"))
        for schema in ("moy.asr.project.v1", "moy.asr.project.v1.5"):
            raw = copy.deepcopy(options["legacy"])
            raw["schema"] = schema
            if schema.endswith("v1.5"):
                raw["subtitle_groups"] = {"color": [], "sticker": []}
            before = copy.deepcopy(raw)
            project = import_project(raw).project
            self.assertEqual(raw, before)
            main, overlay, secondary = project["tracks"]
            self.assertEqual((main["preview_visible"], main["variant"], main["export"]), (True, "plain", {"enabled": True}))
            self.assertFalse(overlay["enabled"])
            self.assertFalse(overlay["preview_visible"])
            self.assertEqual(overlay["variant"], "future-overlay")
            self.assertEqual(overlay["export"], before["overlay_track"]["export"])
            self.assertFalse(secondary["enabled"])
            self.assertEqual(secondary["export"], {"enabled": True, "vendor": []})
            self.assertEqual(import_project(project).project, project)
        for case in options["invalid"]:
            with self.subTest(case=case):
                project = canonical()
                project["tracks"][0][case["field"]] = case["value"]
                self.assertRejected(project, case["path"])
                legacy = copy.deepcopy(options["legacy"])
                legacy["overlay_track"][case["field"]] = case["value"]
                self.assertRejected(legacy, case["path"].replace("tracks[0]", "tracks[1]"))

    def test_shared_migration_fixtures(self):
        folder = Path(os.environ.get("MAW_TRACKS_FIXTURES", Path(__file__).parent / "fixtures" / "project-tracks"))
        paths = sorted(folder.glob("*.input.json"))
        self.assertTrue(paths, "Shared Python/JS migration fixtures are required")
        for path in paths:
            with self.subTest(fixture=path.name):
                raw = json.loads(path.read_text(encoding="utf-8"))
                original = copy.deepcopy(raw)
                if len((raw.get("multi_subtitle") or {}).get("tracks") or []) > 1:
                    self.assertRejected(raw, "$.tracks")
                    continue
                expected = json.loads(path.with_name(path.name.replace(".input.", ".expected.")).read_text(encoding="utf-8"))
                actual = import_project(raw)
                self.assertEqual(actual.project, expected)
                self.assertEqual(raw, original)
                self.assertEqual(import_project(actual.project).project, expected)
                self.assertEqual(import_project(actual.project).changes, ())

    def test_shared_rejection_fixtures(self):
        folder = Path(os.environ.get("MAW_TRACKS_FIXTURES", Path(__file__).parent / "fixtures" / "project-tracks"))
        cases = json.loads((folder / "invalid.json").read_text(encoding="utf-8"))
        for case in cases:
            with self.subTest(fixture=case["name"]):
                self.assertRejected(case["input"], case["error_path"])

    def test_v2_validation_preserves_all_fields_and_returns_detached_copy(self):
        project = canonical()
        project["tracks"][0]["metadata"] = {"zero": 0, "false": False, "empty": [], "object": {}}
        project["tracks"][0]["segments"][0].update(
            vendor={"one": 1}, assOverride={"scale": 1.234, "vendor": {"a": False}},
            items=[{"text": "!", "start": 2000, "end": 2000, "vendor": 0}],
        )
        normalized = normalize_project(project)
        self.assertEqual(normalized, project)
        normalized["tracks"][0]["segments"][0]["vendor"]["one"] = 2
        self.assertEqual(project["tracks"][0]["segments"][0]["vendor"]["one"], 1)

    def test_legacy_defaults_and_source_metadata_move_once(self):
        raw = {"segments": [], "language": "en", "model": "test", "preserve_punctuation": False,
               "multi_subtitle": {"main_split_mode": "word"}, "vendor": {"x": 0}}
        project = migrate_project_tracks(raw)
        self.assertEqual(project["schema"], PROJECT_SCHEMA)
        main = get_main_track(project)
        self.assertEqual(main["language"], "en")
        self.assertEqual(main["split_mode_override"], "word")
        self.assertFalse(main["preserve_punctuation"])
        self.assertEqual(project["vendor"], {"x": 0})
        for field in ("segments", "multi_subtitle", "overlay_track", "language", "model"):
            self.assertNotIn(field, project)
        self.assertTrue(import_project(raw).changes)

    def test_missing_ids_reserve_explicit_ids_before_generation(self):
        project = normalize_project({"segments": [
            {"start": 0, "end": 100, "text": "a"}, cue("main-cue-1", 100, 200),
        ], "overlay_track": {"segments": [cue("main-cue-1", 0, 100)]}})
        ids = [item["id"] for item in iter_segments(project)]
        self.assertEqual(ids, ["main-cue-1-2", "main-cue-1", "overlay-cue-1"])

    def test_legacy_bindings_resolve_implicit_ids_without_overwriting_explicit_cue_ids(self):
        raw = {"segments": [{"start": 0, "end": 100, "text": "generated"}, cue("main-001", 100, 200)],
               "multi_subtitle": {"enabled": True, "active_track_id": "extension-001",
                   "tracks": [{"segments": [{"start": 0, "end": 100, "text": "translation"}]}],
                   "bindings": [{"track_id": "extension-001", "main_segment_ids": ["main-001-generated"],
                                 "extension_segment_ids": ["extension-001-segment-001"]}]}}
        original = copy.deepcopy(raw)
        project = normalize_project(raw)
        self.assertEqual(raw, original)
        self.assertEqual(project["bilingual"]["active_track_id"], "extension-1")
        binding = project["bindings"][0]
        self.assertEqual(binding["source"], {"track_id": "main", "segment_id": "main-cue-1"})
        self.assertEqual(binding["target"], {"track_id": "extension-1", "segment_id": "extension-1-cue-1"})
        self.assertEqual(get_main_track(project)["segments"][1]["id"], "main-001")
        self.assertEqual(get_tracks_by_role(project, "secondary")[0]["id"], "extension-1")
        self.assertEqual(normalize_project(project), project)
        binding["source"]["segment_id"] = "main-001-generated"
        self.assertRejected(project, "$.bindings[0].source.segment_id")

    def test_track_ids_reserve_legacy_extension_ids(self):
        for secondary_id, expected in (("main", ["main-2", "overlay", "main"]),
                                       ("overlay", ["main", "overlay-2", "overlay"])):
            with self.subTest(secondary_id=secondary_id):
                project = normalize_project({"segments": [], "overlay_track": {},
                                            "multi_subtitle": {"tracks": [{"id": secondary_id, "segments": []}]}})
                self.assertEqual([item["id"] for item in project["tracks"]], expected)

    def test_v15_group_membership_keeps_id_and_value_metadata(self):
        project = normalize_project({"schema": "moy.asr.project.v1.5", "segments": [cue(color_group_id="g")],
                                     "subtitle_groups": {"color": [{"id": "g", "value": {"name": "red", "vendor": 0}}], "sticker": [], "vendor": False}})
        self.assertEqual(get_main_track(project)["segments"][0]["color_group_id"], "g")
        self.assertEqual(project["subtitle_groups"]["color"][0]["value"]["vendor"], 0)
        self.assertFalse(project["subtitle_groups"]["vendor"])

    def test_v15_upstream_groups_and_binding_migrate_without_data_loss(self):
        folder = Path(__file__).parent / "fixtures" / "project-tracks"
        source = json.loads((folder / "v2-cross-track.input.json").read_text(encoding="utf-8"))
        source["schema"] = "moy.asr.project.v1.5"
        original = copy.deepcopy(source)
        expected = json.loads((folder / "v2-cross-track.expected.json").read_text(encoding="utf-8"))
        self.assertEqual(import_project(source).project, expected)
        self.assertEqual(source, original)

    def test_v15_duplicate_cross_track_ids_are_rejected(self):
        raw = {"schema": "moy.asr.project.v1.5", "segments": [cue()],
               "overlay_track": {"segments": [cue()]}, "subtitle_groups": {"color": [], "sticker": []}}
        self.assertRejected(raw, "$.tracks[1].segments[0].id")

    def test_v15_requires_global_ids_and_never_repairs_group_references(self):
        raw = {"schema": "moy.asr.project.v1.5", "segments": [cue()], "overlay_track": {"segments": [cue()]},
               "subtitle_groups": {"color": [], "sticker": []}}
        self.assertRejected(raw, "$.tracks[1].segments[0].id")
        raw["overlay_track"]["segments"] = []
        raw["segments"][0]["color_group_id"] = "missing"
        self.assertRejected(raw, "$.tracks[0].segments[0].color_group_id")

    def test_v15_rejects_legacy_group_fields_even_null(self):
        raw = {"schema": "moy.asr.project.v1.5", "segments": [cue(color=None)],
               "subtitle_groups": {"color": [], "sticker": []}}
        self.assertRejected(raw, "$.tracks[0].segments[0].color")

    def test_legacy_groups_resolve_before_disabled_filtering(self):
        project = normalize_project({"segments": [cue("a", 0, 100, disabled=True, color={"name": "red", "start": 0, "end": 200}),
                                                   cue("b", 100, 200, color_ref={"headIdx": 0, "name": "red", "extra": {"z": False}})]})
        first, second = get_main_track(project)["segments"]
        self.assertEqual(first["color_group_id"], second["color_group_id"])
        self.assertEqual(second["color_group_metadata"], {"extra": {"z": False}})
        self.assertEqual(project["subtitle_groups"]["color"][0]["value"], {"name": "red"})

    def test_explicit_bad_legacy_ids_and_refs_reject_without_repair(self):
        self.assertRejected({"segments": [cue("x", 0, 100), cue("x", 100, 200)]}, "$.tracks[0].segments[1].id")
        self.assertRejected({"segments": [cue(color_ref={"headIdx": 1})]}, "$.tracks[0].segments[0].color_ref.headIdx")
        self.assertRejected({"segments": [cue(None)]}, "$.tracks[0].segments[0].id")

    def test_future_and_mixed_versions_reject_before_mutation(self):
        self.assertRejected({"schema": "moy.asr.project.v4", "segments": []}, "$.schema")
        self.assertRejected({"schema": None, "segments": []}, "$.schema")
        self.assertRejected({"schema": PROJECT_SCHEMA, "segments": []}, "$.segments")
        self.assertRejected({"segments": [], "tracks": []}, "$.tracks")

    def test_v2_track_invariants(self):
        for modify, path in (
            (lambda p: p["tracks"].clear(), "$.tracks"),
            (lambda p: p["tracks"].append(track("second", segments=[])), "$.tracks"),
            (lambda p: p["tracks"][0].update(enabled=False), "$.tracks[0].enabled"),
            (lambda p: p["tracks"][0].update(role="video"), "$.tracks[0].role"),
            (lambda p: p["tracks"][0].update(id=" main "), "$.tracks[0].id"),
            (lambda p: p["tracks"].append(track("overlay", "overlay")), "$.tracks[1].segments[0].id"),
            (lambda p: p["bilingual"].update(active_track_id="main"), "$.bilingual.active_track_id"),
        ):
            with self.subTest(path=path):
                project = canonical()
                modify(project)
                self.assertRejected(project, path)

    def test_one_source_cannot_bind_twice_to_secondary(self):
        project = canonical()
        for language in ("en",):
            project["tracks"].append(track(language, "secondary", [cue(language)]))
            project["bindings"].append({"id": f"bind-{language}", "source": {"track_id": "main", "segment_id": "cue-1"},
                                        "target": {"track_id": language, "segment_id": language},
                                        "start_offset_ms": 0, "end_offset_ms": 0})
        project["bilingual"]["active_track_id"] = "en"
        self.assertTrue(validate_tracks_project(project).ok)
        duplicate = {**project["bindings"][0], "id": "duplicate"}
        project["bindings"].append(duplicate)
        self.assertRejected(project, "$.bindings[1]")

    def test_binding_offset_and_membership_validate_on_v2(self):
        project = canonical()
        project["tracks"].append(track("en", "secondary", [cue("en", 1050, 2050)]))
        project["bilingual"]["active_track_id"] = "en"
        binding = {"id": "b", "source": {"track_id": "main", "segment_id": "cue-1"},
                   "target": {"track_id": "en", "segment_id": "en"}, "start_offset_ms": 0, "end_offset_ms": 50}
        project["bindings"] = [binding]
        self.assertRejected(project, "$.bindings[0].start_offset_ms")
        binding["start_offset_ms"] = 50
        binding["target"]["segment_id"] = "cue-1"
        self.assertRejected(project, "$.bindings[0].target.segment_id")

    def test_failure_never_mutates_source_or_returns_partial_project(self):
        raw = {"segments": [cue()], "multi_subtitle": {"tracks": [{"id": "en", "segments": [cue("en")]}],
               "bindings": [{"main_segment_ids": ["missing"], "extension_segment_ids": ["en"]}]}}
        original = copy.deepcopy(raw)
        with self.assertRaises(ProjectValidationFailed):
            import_project(raw)
        self.assertEqual(raw, original)

    def test_helpers_return_canonical_entities(self):
        project = canonical()
        self.assertIs(get_main_track(project), project["tracks"][0])
        self.assertIs(get_track(project, "main"), project["tracks"][0])
        self.assertEqual(get_tracks_by_role(project, "secondary"), [])
        self.assertEqual(list(iter_segments(project)), project["tracks"][0]["segments"])

    def test_factory_creates_native_v2_and_preserves_input_payloads(self):
        segments = [{"start": 0, "end": 100, "text": "hi", "vendor": {"x": False}}, cue("main-cue-1", 100, 200)]
        original = copy.deepcopy(segments)
        project = make_project(segments, main_fields={"language": "en"}, project_fields={"media": "clip.wav"})
        self.assertEqual([c["id"] for c in iter_segments(project)], ["main-cue-1-2", "main-cue-1"])
        self.assertEqual(project["media"], "clip.wav")
        self.assertEqual(get_main_track(project)["language"], "en")
        self.assertEqual(segments, original)
        self.assertNotIn("segments", project)
        with self.assertRaises(ProjectValidationFailed):
            make_project([], project_fields={"schema": "future"})

    def test_explicit_timing_repair_preserves_zero_length_punctuation_in_v2(self):
        project = canonical()
        get_main_track(project)["segments"][0]["items"] = [{"text": "!", "start": 2000, "end": 2000}]
        self.assertEqual(repair_project_timing_ranges(project), 0)
        self.assertTrue(validate_tracks_project(project).ok)

    def test_timestamps_fit_javascript_safe_integers(self):
        project = canonical()
        get_main_track(project)["segments"][0]["end"] = 9007199254740992
        self.assertRejected(project, "$.tracks[0].segments[0].end")

    def test_legacy_optional_nulls_keep_previous_import_defaults(self):
        raw = {"segments": [cue()], "overlay_track": {"enabled": None, "segments": None},
               "multi_subtitle": {"schema": None, "enabled": None, "display_mode": None,
                                  "main_split_mode": None, "tracks": [{"id": "en", "role": None,
                                     "split_mode": None, "segments": [cue("en", 1050, 2050)]}],
                                  "bindings": [{"track_id": None, "main_segment_ids": None, "main_segment_id": "cue-1",
                                      "extension_segment_ids": ["en"], "start_offset_ms": None, "end_offset_ms": None}]}}
        project = normalize_project(raw)
        self.assertFalse(get_tracks_by_role(project, "overlay")[0]["enabled"])
        self.assertFalse(get_tracks_by_role(project, "secondary")[0]["enabled"])
        self.assertEqual(get_tracks_by_role(project, "secondary")[0]["split_mode"], "word")
        self.assertEqual(project["bindings"][0]["start_offset_ms"], 50)
        self.assertEqual(project["bilingual"]["display_mode"], "both")
        self.assertNotIn("split_mode_override", get_main_track(project))
        self.assertEqual(normalize_project({"segments": [], "multi_subtitle": {"tracks": None, "bindings": None}})["bindings"], [])

    def test_v2_rejects_duplicate_bilingual_enabled_flag(self):
        project = canonical()
        project["bilingual"]["enabled"] = True
        self.assertRejected(project, "$.bilingual.enabled")

    def test_timing_repair_does_not_turn_overlapping_positive_item_into_punctuation(self):
        project = canonical()
        get_main_track(project)["segments"][0]["items"] = [
            {"start": 1000, "end": 1500, "text": "first"},
            {"start": 1400, "end": 1500, "text": "second"},
        ]
        repair_project_timing_ranges(project)
        second = get_main_track(project)["segments"][0]["items"][1]
        self.assertEqual((second["start"], second["end"]), (1500, 1600))

    def test_root_setting_names_are_opaque_unknown_fields_when_nested_on_track(self):
        project = canonical()
        project["tracks"][0]["timed_text_edit_view"] = "vendor-specific"
        self.assertEqual(normalize_project(project), project)

    def test_v15_trims_explicit_ids_before_project_wide_uniqueness_check(self):
        raw = {"schema": "moy.asr.project.v1.5", "segments": [cue(" cue-1 ")],
               "subtitle_groups": {"color": [], "sticker": []}}
        self.assertEqual(get_main_track(normalize_project(raw))["segments"][0]["id"], "cue-1")
        raw["overlay_track"] = {"segments": [cue("cue-1")]}
        self.assertRejected(raw, "$.tracks[1].segments[0].id")

    def test_multiple_secondary_tracks_are_rejected_without_mutating_input(self):
        project = canonical()
        project["tracks"][0]["segments"] = [cue("c", 0, 100), cue("b:c", 100, 200)]
        project["tracks"].extend([track("a:b", "secondary", [cue("target-1", 0, 100)]),
                                  track("a", "secondary", [cue("target-2", 100, 200)])])
        project["bilingual"]["active_track_id"] = "a:b"
        project["bindings"] = [{"id": f"binding-{index}", "source": {"track_id": "main", "segment_id": source},
            "target": {"track_id": target, "segment_id": f"target-{index}"}, "start_offset_ms": 0, "end_offset_ms": 0}
            for index, (target, source) in enumerate((("a:b", "c"), ("a", "b:c")), 1)]
        self.assertRejected(project, "$.tracks")

    def test_opaque_ids_with_separators_remain_distinct_with_one_secondary(self):
        project = canonical()
        project["tracks"][0]["segments"] = [cue("c", 0, 100), cue("b:c", 100, 200)]
        project["tracks"].append(track("a:b", "secondary", [cue("target-1", 0, 100), cue("target-2", 100, 200)]))
        project["bilingual"]["active_track_id"] = "a:b"
        project["bindings"] = [{"id": f"binding-{index}", "source": {"track_id": "main", "segment_id": source},
            "target": {"track_id": "a:b", "segment_id": f"target-{index}"}, "start_offset_ms": 0, "end_offset_ms": 0}
            for index, source in enumerate(("c", "b:c"), 1)]
        self.assertTrue(validate_tracks_project(project).ok)

    def test_invalid_timebase_enum_type_returns_validation_error(self):
        project = canonical()
        project["timebase"] = {"unit": [], "fps": 30}
        self.assertRejected(project, "$.timebase.unit")

    def test_timebase_fps_source_preserves_v2_auto_user_contract(self):
        for source in ("auto", "user"):
            raw = {"segments": [], "timebase": {"unit": "frames", "fps": 25, "fps_source": source}}
            self.assertEqual(normalize_project(raw)["timebase"], raw["timebase"])
        raw["timebase"]["fps_source"] = "other"
        self.assertRejected(raw, "$.timebase.fps_source")

    def test_legacy_explicit_repair_preserves_valid_zero_punctuation_by_default(self):
        raw = {"segments": [cue(items=[{"start": 2000, "end": 2000, "text": "."}])]}
        self.assertEqual(repair_project_timing_ranges(raw), 0)
        normalized = normalize_project(raw)
        self.assertEqual(get_main_track(normalized)["segments"][0]["items"][0]["end"], 2000)


if __name__ == "__main__":
    unittest.main()
