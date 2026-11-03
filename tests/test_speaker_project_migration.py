import copy
import unittest

from maw.project import ProjectValidationFailed
from maw.project_tracks import import_project, make_project, validate_tracks_project
from maw.speaker_identity import can_merge_speaker_segments, resolve_project_speaker


def _mixed(identifier, *, second_start=100, first_end=100):
    return {"id": identifier, "start": 0, "end": 200, "text": "甲乙", "vendor": {"keep": 1},
            "items": [{"text": "甲", "start": 0, "end": first_end, "speaker": "source-A"},
                      {"text": "乙", "start": second_start, "end": 200, "speaker": "source-B"}]}


def _core(main, secondary=None):
    tracks = [{"id": "main", "name": "主字幕", "role": "main", "enabled": True, "segments": main}]
    bilingual = {"display_mode": "both"}
    if secondary is not None:
        tracks.append({"id": "secondary", "name": "副字幕", "role": "secondary", "enabled": True, "segments": secondary})
        bilingual["active_track_id"] = "secondary"
    return {"schema": "moy.asr.project.v2", "tracks": tracks, "bilingual": bilingual, "bindings": [],
            "subtitle_groups": {"next_id": 1, "color": [], "sticker": []}, "vendor": {"preserve": True}}


def _binding(identifier="bind", source="a", target="b"):
    return {"id": identifier, "source": {"track_id": "main", "segment_id": source},
            "target": {"track_id": "secondary", "segment_id": target},
            "start_offset_ms": 0, "end_offset_ms": 0, "vendor": {"preserve": True}}


class SpeakerProjectMigrationTests(unittest.TestCase):
    def test_strict_validation_requires_identity_table_but_import_upgrades_old_v2(self):
        source = _core([{"id": "a", "start": 0, "end": 100, "text": "x", "speaker": "provider-A"}])
        original = copy.deepcopy(source)
        strict = validate_tracks_project(source)
        self.assertFalse(strict.ok)
        self.assertIn("$.speakers", [error.path for error in strict.errors])
        migrated = import_project(source).project
        self.assertEqual(source, original)
        self.assertEqual(migrated["speakers"][0]["id"], "spk-001")
        self.assertEqual(migrated["tracks"][0]["segments"][0]["speaker"], "spk-001")
        self.assertTrue(validate_tracks_project(migrated).ok)

    def test_legacy_v1_and_v15_upgrade_without_mutating_source(self):
        for schema in ("moy.asr.project.v1", "moy.asr.project.v1.5"):
            with self.subTest(schema=schema):
                source = {"schema": schema, "segments": [_mixed("a")], "vendor": {"keep": True}}
                if schema.endswith("v1.5"):
                    source["subtitle_groups"] = {"next_id": 2, "color": [{"id": "c", "value": {"name": "yellow", "value": "#f9ca1f"}}], "sticker": []}
                    source["segments"][0]["color_group_id"] = "c"
                else:
                    source["segments"][0]["color"] = {"name": "yellow", "value": "#f9ca1f", "start": 0, "end": 200}
                original = copy.deepcopy(source)
                imported = import_project(source)
                project = imported.project
                self.assertEqual(source, original)
                self.assertEqual(project["schema"], "moy.asr.project.v2")
                self.assertEqual(project["annotation_mode"], "color")
                self.assertEqual(project["palette_size"], 5)
                cues = project["tracks"][0]["segments"]
                self.assertEqual([cue["text"] for cue in cues], ["甲", "乙"])
                self.assertEqual([cue["speaker"] for cue in cues], ["spk-001", "spk-002"])
                self.assertEqual(cues[0]["color_group_id"], cues[1]["color_group_id"])
                self.assertTrue(all("speaker" not in item for cue in cues for item in cue["items"]))
                self.assertEqual(project["vendor"], original["vendor"])
                self.assertTrue(imported.changes)
                self.assertEqual(import_project(project).changes, ())

    def test_old_core_v2_keeps_five_colors_and_reserves_all_cue_ids(self):
        source = _core([_mixed("a"), {"id": "a-speaker-1", "start": 200, "end": 300, "text": "z", "speaker": "source-C"}])
        source["tracks"][0]["segments"] += [
            {"id": f"cue-{index}", "start": index * 100, "end": (index + 1) * 100, "text": "x", "speaker": f"source-{index}"}
            for index in range(3, 8)
        ]
        project = import_project(source).project
        self.assertEqual(project["tracks"][0]["segments"][1]["id"], "a-speaker-2")
        self.assertEqual(project["palette_size"], 5)
        self.assertEqual(len(project["speaker_shortcuts"]), 5)
        self.assertEqual(len(project["speakers"]), 8)
        self.assertEqual(len({speaker["id"] for speaker in project["speakers"]}), 8)

    def test_existing_palette_and_shortcuts_map_source_ids_and_remain_saved(self):
        source = _core([_mixed("a")])
        source.update(annotation_mode="speaker", palette_size=9, speaker_shortcuts={"6": "source-B"})
        project = import_project(source).project
        self.assertEqual(project["annotation_mode"], "speaker")
        self.assertEqual(project["palette_size"], 9)
        self.assertEqual(project["speaker_shortcuts"], {"6": "spk-002"})
        source["speaker_shortcuts"]["6"] = "missing"
        with self.assertRaises(ProjectValidationFailed) as caught:
            import_project(source)
        self.assertEqual(caught.exception.errors[0].path, "$.speaker_shortcuts.6")

    def test_existing_identity_table_is_authoritative_and_never_reassigned(self):
        project = make_project([{"start": 0, "end": 100, "text": "x", "speaker": "source-A"}])
        project["tracks"][0]["segments"][0]["speaker"] = None
        self.assertEqual(import_project(project).project, project)
        self.assertIsNone(resolve_project_speaker(project, project["tracks"][0]["segments"][0]))
        project["tracks"][0]["segments"][0]["items"] = [{"text": "x", "start": 0, "end": 100, "speaker": "source-A"}]
        with self.assertRaises(ProjectValidationFailed):
            import_project(project)

    def test_unchanged_bound_cues_keep_exact_binding_and_unknown_fields(self):
        source = _core([{"id": "a", "start": 0, "end": 200, "text": "甲", "speaker": "A"}],
                       [{"id": "b", "start": 0, "end": 200, "text": "乙", "speaker": "B"}])
        source["bindings"] = [_binding()]
        project = import_project(source).project
        self.assertEqual(project["bindings"], source["bindings"])
        self.assertTrue(validate_tracks_project(project).ok)

    def test_paired_absolute_splits_remap_bindings_and_reserve_binding_ids(self):
        source = _core([_mixed("a"), {"id": "c", "start": 200, "end": 300, "text": "c"}],
                       [_mixed("b"), {"id": "d", "start": 200, "end": 300, "text": "d"}])
        source["bindings"] = [_binding(), _binding("bind-speaker-1", "c", "d")]
        project = import_project(source).project
        self.assertEqual([binding["id"] for binding in project["bindings"]], ["bind", "bind-speaker-2", "bind-speaker-1"])
        self.assertEqual(project["bindings"][1]["source"]["segment_id"], "a-speaker-1")
        self.assertEqual(project["bindings"][1]["target"]["segment_id"], "b-speaker-1")
        self.assertTrue(all(binding["vendor"]["preserve"] for binding in project["bindings"]))
        self.assertTrue(validate_tracks_project(project).ok)

    def test_independent_or_misaligned_splits_release_binding_and_report_change(self):
        for target in ({"id": "b", "start": 0, "end": 200, "text": "乙", "speaker": "B"},
                       _mixed("b", second_start=120, first_end=120)):
            with self.subTest(target=target):
                source = _core([_mixed("a")], [target])
                source["bindings"] = [_binding()]
                before = copy.deepcopy(source)
                imported = import_project(source)
                self.assertEqual(source, before)
                self.assertEqual(imported.project["bindings"], [])
                self.assertEqual("".join(cue["text"] for cue in imported.project["tracks"][0]["segments"]), "甲乙")
                self.assertTrue(any(change["path"] == "$.bindings" and change["before"] == before["bindings"] and change["after"] == []
                                    for change in imported.changes))
                self.assertTrue(validate_tracks_project(imported.project).ok)

    def test_shared_merge_boundary_never_uses_name_color_or_word_fallbacks(self):
        self.assertTrue(can_merge_speaker_segments([{}, {"speaker": None}]))
        self.assertTrue(can_merge_speaker_segments([{"speaker": "p1"}, {"speaker": "p1"}]))
        self.assertFalse(can_merge_speaker_segments([{"speaker": "p1"}, {"speaker": "p2"}]))
        self.assertFalse(can_merge_speaker_segments([{"speaker": "p1"}, {}]))
        self.assertFalse(can_merge_speaker_segments([]))

    def test_split_cue_ids_fit_160_unicode_codepoints_and_check_truncated_collisions(self):
        symbol = "𠮷"
        original_id = symbol * 160
        occupied = symbol * 150 + "-speaker-1"
        source = _core([_mixed(original_id), {"id": occupied, "start": 200, "end": 300, "text": "z"}],
                       [_mixed(symbol * 159 + "a")])
        before = copy.deepcopy(source)
        project = import_project(source).project
        self.assertEqual(source, before)
        main_ids = [cue["id"] for cue in project["tracks"][0]["segments"]]
        secondary_ids = [cue["id"] for cue in project["tracks"][1]["segments"]]
        self.assertEqual(main_ids, [original_id, symbol * 150 + "-speaker-2", occupied])
        self.assertEqual(secondary_ids, [symbol * 159 + "a", symbol * 150 + "-speaker-3"])
        self.assertTrue(all(len(identifier) <= 160 for identifier in main_ids + secondary_ids))
        self.assertTrue(validate_tracks_project(project).ok)

    def test_paired_split_binding_ids_fit_160_codepoints_without_changing_original(self):
        original_id = "𠮷" * 160
        occupied = "𠮷" * 150 + "-speaker-1"
        source = _core([_mixed("a"), {"id": "c", "start": 200, "end": 300, "text": "c"}],
                       [_mixed("b"), {"id": "d", "start": 200, "end": 300, "text": "d"}])
        source["bindings"] = [_binding(original_id), _binding(occupied, "c", "d")]
        before = copy.deepcopy(source)
        project = import_project(source).project
        self.assertEqual(source, before)
        self.assertEqual([binding["id"] for binding in project["bindings"]],
                         [original_id, "𠮷" * 150 + "-speaker-2", occupied])
        self.assertTrue(validate_tracks_project(project).ok)

    def test_bom_id_edges_are_rejected_like_javascript(self):
        for identity in ("\ufeffp1", "p1\ufeff"):
            project = make_project([], project_fields={"speakers": [{"id": "p1", "name": "x", "color": "#969fab"}]})
            project["speakers"][0]["id"] = identity
            self.assertFalse(validate_tracks_project(project).ok)

    def test_legacy_binding_release_has_explicit_canonical_change_once(self):
        for schema in ("moy.asr.project.v1", "moy.asr.project.v1.5"):
            with self.subTest(schema=schema):
                source = {"schema": schema, "segments": [_mixed("a")], "multi_subtitle": {
                    "enabled": True, "tracks": [{"id": "secondary", "segments": [
                        {"id": "b", "start": 0, "end": 200, "text": "translated"}]}],
                    "bindings": [{"id": "bind", "track_id": "secondary", "main_segment_ids": ["a"],
                                  "extension_segment_ids": ["b"], "vendor": {"preserve": True}}],
                }}
                if schema.endswith("v1.5"):
                    source["subtitle_groups"] = {"next_id": 1, "color": [], "sticker": []}
                imported = import_project(source)
                binding_changes = [change for change in imported.changes if change["path"] == "$.bindings"]
                self.assertEqual(binding_changes, [{"path": "$.bindings", "kind": "replace",
                                                   "before": [_binding()], "after": []}])
                self.assertEqual(imported.project["bindings"], [])
                self.assertEqual(len(imported.project["tracks"][0]["segments"]), 2)

    def test_old_core_v2_rejects_invalid_settings_and_shortcuts_with_paths(self):
        mutations = [({"palette_size": None}, "$.palette_size"),
                     ({"palette_size": True}, "$.palette_size"),
                     ({"annotation_mode": None}, "$.annotation_mode"),
                     ({"speaker_shortcuts": None}, "$.speaker_shortcuts"),
                     ({"speaker_shortcuts": []}, "$.speaker_shortcuts"),
                     ({"speaker_shortcuts": {"0": "source-A"}}, "$.speaker_shortcuts.0"),
                     ({"speaker_shortcuts": {"1": None}}, "$.speaker_shortcuts.1"),
                     ({"speaker_shortcuts": {"1": "missing"}}, "$.speaker_shortcuts.1"),
                     ({"speaker_shortcuts": {"1": "\ufeffsource-A"}}, "$.speaker_shortcuts.1"),
                     ({"speakers": None}, "$.speakers")]
        for fields, path in mutations:
            with self.subTest(fields=fields):
                source = {**_core([_mixed("a")]), **fields}
                before = copy.deepcopy(source)
                with self.assertRaises(ProjectValidationFailed) as caught:
                    import_project(source)
                self.assertIn(path, [error.path for error in caught.exception.errors])
                self.assertEqual(source, before)


if __name__ == "__main__":
    unittest.main()
