"""Regrouping must not leave stale one-to-one links to extension subtitles."""

from __future__ import annotations

import copy
import unittest

from maw.postprocess import (
    _apply_llm_atom_groups_with_warnings,
    _apply_llm_groups_with_warnings,
)
from maw.project import ProjectValidationFailed, normalize_project


def bound_project():
    segments = [
        {"id": f"main-{i}", "start": i * 1000, "end": (i + 1) * 1000,
         "text": f"cue {i}", "items": [
             {"start": i * 1000, "end": i * 1000 + 500, "text": "cue "},
             {"start": i * 1000 + 500, "end": (i + 1) * 1000, "text": str(i)},
         ]}
        for i in range(3)
    ]
    return normalize_project({
        "segments": segments,
        "multi_subtitle": {
            "enabled": True,
            "tracks": [{"id": "translation", "role": "extension", "language": "zh",
                        "segments": [
                            {"id": f"ext-{i}", "start": i * 1000 + 50,
                             "end": (i + 1) * 1000 - 50, "text": f"译文 {i}"}
                            for i in range(3)
                        ]}],
            "bindings": [
                {"id": f"binding-{i}", "track_id": "translation",
                 "main_segment_ids": [f"main-{i}"], "extension_segment_ids": [f"ext-{i}"],
                 "start_offset_ms": 50, "end_offset_ms": -50}
                for i in range(3)
            ],
        },
    })


class PostprocessBindingTests(unittest.TestCase):
    def apply_groups(self, project, groups, *, atoms=False, **kwargs):
        before = copy.deepcopy(project)
        apply = _apply_llm_atom_groups_with_warnings if atoms else _apply_llm_groups_with_warnings
        result, warnings = apply(project, {"groups": groups}, **kwargs)
        self.assertEqual(project, before, "the source project must remain unchanged")
        self.assertEqual(result, normalize_project(result))
        if "multi_subtitle" in project:
            self.assertEqual(result["multi_subtitle"]["tracks"], project["multi_subtitle"]["tracks"])
        return result, warnings

    def test_cue_merge_releases_all_affected_links_but_keeps_other_links(self):
        project = bound_project()
        result, warnings = self.apply_groups(project, [
            {"source_ids": ["c0001", "c0002"], "text": "merged"},
            {"source_ids": ["c0003"], "text": "cue 2"},
        ])
        self.assertEqual(len(result["segments"]), 2)
        self.assertEqual(result["segments"][0]["id"], "main-0")
        self.assertEqual(result["segments"][0]["end"], 2000)
        self.assertEqual(result["multi_subtitle"]["bindings"], project["multi_subtitle"]["bindings"][2:])
        self.assertTrue(any("2 组" in warning and "主副字幕绑定" in warning for warning in warnings))

    def test_cue_split_releases_only_the_split_cue_link(self):
        project = bound_project()
        result, warnings = self.apply_groups(project, [
            {"source_ids": ["c0001"], "text": "first"},
            {"source_ids": ["c0001"], "text": "second"},
            {"source_ids": ["c0002"], "text": "cue 1"},
            {"source_ids": ["c0003"], "text": "cue 2"},
        ])
        self.assertEqual(len(result["segments"]), 4)
        self.assertEqual(result["multi_subtitle"]["bindings"], project["multi_subtitle"]["bindings"][1:])
        self.assertTrue(any("1 组" in warning and "主副字幕绑定" in warning for warning in warnings))

    def test_text_only_edit_and_translation_keep_all_links_and_offsets(self):
        for strict_translation in (False, True):
            with self.subTest(strict_translation=strict_translation):
                project = bound_project()
                result, warnings = self.apply_groups(project, [
                    {"source_ids": [f"c{i + 1:04d}"], "text": f"edited {i}"} for i in range(3)
                ], strict_translation=strict_translation)
                self.assertEqual(result["multi_subtitle"], project["multi_subtitle"])
                self.assertEqual(warnings, ())

    def test_atom_regroup_preserves_extension_cues_and_preserved_cue_link(self):
        project = bound_project()
        result, warnings = self.apply_groups(project, [
            {"atom_ids": ["c0001a0001"]},
            {"atom_ids": ["c0001a0002", "c0002a0001", "c0002a0002"]},
        ], atoms=True, skipped_source_ids={"c0003"}, preserve_skipped_source_ids={"c0003"})
        self.assertEqual(result["segments"][-1], project["segments"][-1])
        self.assertEqual(result["multi_subtitle"]["bindings"], project["multi_subtitle"]["bindings"][2:])
        self.assertTrue(any("2 组" in warning and "主副字幕绑定" in warning for warning in warnings))

    def test_disabled_multisubtitle_data_is_preserved_and_links_are_cleaned(self):
        project = bound_project()
        project["multi_subtitle"]["enabled"] = False
        result, _ = self.apply_groups(project, [
            {"source_ids": ["c0001", "c0002", "c0003"], "text": "merged"},
        ])
        self.assertFalse(result["multi_subtitle"]["enabled"])
        self.assertEqual(result["multi_subtitle"]["bindings"], [])

    def test_project_without_extension_tracks_still_regroups(self):
        project = bound_project()
        del project["multi_subtitle"]
        result, warnings = self.apply_groups(project, [
            {"source_ids": ["c0001", "c0002", "c0003"], "text": "merged"},
        ])
        self.assertNotIn("multi_subtitle", result)
        self.assertFalse(any("主副字幕绑定" in warning for warning in warnings))

    def test_preexisting_invalid_bindings_are_not_silently_discarded(self):
        for main_ids in ([], ["missing-main"]):
            with self.subTest(main_ids=main_ids):
                project = bound_project()
                project["multi_subtitle"]["bindings"][0]["main_segment_ids"] = main_ids
                with self.assertRaises(ProjectValidationFailed):
                    self.apply_groups(project, [
                        {"source_ids": [f"c{i + 1:04d}"], "text": f"edited {i}"} for i in range(3)
                    ])

    def test_preexisting_wrong_offset_is_still_rejected(self):
        for binding_index in (0, 2):
            with self.subTest(binding_index=binding_index):
                project = bound_project()
                project["multi_subtitle"]["bindings"][binding_index]["end_offset_ms"] = 123
                with self.assertRaises(ProjectValidationFailed):
                    self.apply_groups(project, [
                        {"source_ids": ["c0001", "c0002"], "text": "merged"},
                        {"source_ids": ["c0003"], "text": "cue 2"},
                    ])

    def test_affected_link_must_be_valid_before_it_can_be_released(self):
        for field, value in (("track_id", "missing-track"),
                             ("extension_segment_ids", ["missing-extension"]),
                             ("main_segment_ids", ["main-1"])):
            with self.subTest(field=field):
                project = bound_project()
                project["multi_subtitle"]["bindings"][0][field] = value
                with self.assertRaises(ProjectValidationFailed):
                    self.apply_groups(project, [
                        {"source_ids": ["c0001", "c0002"], "text": "merged"},
                        {"source_ids": ["c0003"], "text": "cue 2"},
                    ])


if __name__ == "__main__":
    unittest.main()
