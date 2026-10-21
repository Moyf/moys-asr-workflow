from __future__ import annotations

import json
import unittest

from maw.project import normalize_project, validate_project
from maw.project_io import serialize_mosp
from maw.project_tracks import get_main_track, get_tracks_by_role, make_project


class AssCuePositionTests(unittest.TestCase):
    def project(self, override):
        return {"segments": [{"start": 0, "end": 1000, "text": "Cue", "assOverride": override}]}

    def test_optional_old_project_and_empty_override(self):
        for value in ({"segments": [{"start": 0, "end": 1000, "text": "Old"}]}, self.project({})):
            normalized = normalize_project(value)
            self.assertNotIn("assOverride", get_main_track(normalized)["segments"][0])

    def test_scale_is_rounded_to_two_decimals_and_default_is_omitted(self):
        for value, expected in [(1, None), (1.005, None), (1.125, 1.13), (1.375, 1.38), (1.225, 1.23), (2.675, 2.67)]:
            with self.subTest(value=value):
                normalized = normalize_project(self.project({"scale": value}))
                override = get_main_track(normalized)["segments"][0].get("assOverride")
                if expected is None:
                    self.assertIsNone(override)
                else:
                    self.assertEqual(override, {"scale": expected})
        preserved = normalize_project(self.project({"scale": 1.22, "pos": {"x": 331.5, "y": -161.5}}))
        self.assertEqual(get_main_track(preserved)["segments"][0]["assOverride"],
                         {"scale": 1.22, "pos": {"x": 331.5, "y": -161.5}})

    def test_finite_unclamped_coordinates_round_trip(self):
        override = {"pos": {"x": -123.125, "y": 1200.5}}
        original = self.project(override)
        normalized = normalize_project(original)
        reopened = normalize_project(json.loads(serialize_mosp(normalized)))
        self.assertEqual(get_main_track(reopened)["segments"][0]["assOverride"], override)
        get_main_track(reopened)["segments"][0]["assOverride"]["pos"]["x"] = 8
        self.assertEqual(original["segments"][0]["assOverride"], override)

    def test_invalid_values_are_rejected_at_qualified_paths(self):
        for value, suffix in [(None, ""), ({"an": 2}, ".an"), ([], ""), ({"an": True}, ".an"), ({"an": 1.5}, ".an"),
                              ({"an": 10}, ".an"), ({"an": "2"}, ".an"), ({"pos": None}, ".pos"),
                              ({"scale": None}, ".scale"), ({"scale": True}, ".scale"), ({"scale": "1.2"}, ".scale"),
                              ({"scale": float("nan")}, ".scale"), ({"scale": float("inf")}, ".scale"),
                              ({"scale": 0.09}, ".scale"), ({"scale": 5.01}, ".scale"),
                              ({"pos": {"x": 1}}, ".pos.y"), ({"pos": {"x": "1", "y": 2}}, ".pos.x"),
                              ({"pos": {"x": float("inf"), "y": 2}}, ".pos.x"),
                              ({"pos": {"x": 10**1000, "y": 2}}, ".pos.x"),
                              ({"pos": {"x": 1, "y": float("nan")}}, ".pos.y")]:
            with self.subTest(value=value):
                result = validate_project(self.project(value))
                self.assertFalse(result.ok)
                self.assertIn("$.segments[0].assOverride" + suffix, {error.path for error in result.errors})

    def test_overlay_track_normalizes_and_rejects_ass_override(self):
        def overlay_project(override):
            return {"segments": [{"start": 2000, "end": 3000, "text": "主"}],
                    "overlay_track": {"enabled": True, "segments": [
                        {"start": 0, "end": 1000, "text": "叠", "assOverride": override}]}}

        normalized = normalize_project(overlay_project({"scale": 1.225, "pos": {"x": -12.5, "y": 1300.25}}))
        self.assertEqual(get_tracks_by_role(normalized, "overlay")[0]["segments"][0]["assOverride"],
                         {"scale": 1.23, "pos": {"x": -12.5, "y": 1300.25}})
        self.assertNotIn("assOverride", get_tracks_by_role(normalize_project(overlay_project({})), "overlay")[0]["segments"][0])
        for value, suffix in [({"an": 2}, ".an"), ({"scale": 0.09}, ".scale"), ({"pos": {"x": 1}}, ".pos.y")]:
            with self.subTest(value=value):
                result = validate_project(overlay_project(value))
                self.assertFalse(result.ok)
                self.assertIn("$.overlay_track.segments[0].assOverride" + suffix,
                              {error.path for error in result.errors})

    def test_legacy_known_scale_normalization_preserves_unknown_override_and_position_fields(self):
        override = {"scale": 1.125, "pos": {"x": -12, "y": 1300, "anchor": "vendor"}, "vendor": {"enabled": False}}
        original = self.project(override)
        normalized = normalize_project(original)
        saved = get_main_track(normalized)["segments"][0]["assOverride"]
        self.assertEqual(saved, {**override, "scale": 1.13})
        self.assertEqual(original["segments"][0]["assOverride"]["scale"], 1.125)

    def test_canonical_override_validation_does_not_repeat_legacy_normalization(self):
        project = make_project([{ "start": 0, "end": 1000, "text": "Cue", "assOverride": {"scale": 2.675} }])
        self.assertEqual(normalize_project(project), project)
        self.assertEqual(get_main_track(project)["segments"][0]["assOverride"]["scale"], 2.675)

    def test_extension_position_errors_report_the_input_schema_path(self):
        legacy = {"segments": [], "multi_subtitle": {"tracks": [{"id": "en", "segments": [
            {"start": 0, "end": 1000, "text": "Cue", "assOverride": {"scale": 0.09}}]}]}}
        result = validate_project(legacy)
        self.assertFalse(result.ok)
        self.assertIn("$.multi_subtitle.tracks[0].segments[0].assOverride.scale", {error.path for error in result.errors})
        legacy["multi_subtitle"]["tracks"][0]["segments"][0]["assOverride"] = {"scale": 1.5}
        project = normalize_project(legacy)
        get_tracks_by_role(project, "extension")[0]["segments"][0]["assOverride"]["scale"] = 0.09
        result = validate_project(project)
        self.assertFalse(result.ok)
        self.assertIn("$.tracks[1].segments[0].assOverride.scale", {error.path for error in result.errors})
