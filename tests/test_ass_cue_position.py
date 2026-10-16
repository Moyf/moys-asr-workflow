from __future__ import annotations

import json
import unittest

from maw.project import normalize_project, validate_project
from maw.project_io import serialize_mosp


class AssCuePositionTests(unittest.TestCase):
    def project(self, override):
        return {"segments": [{"start": 0, "end": 1000, "text": "Cue", "assOverride": override}]}

    def test_optional_old_project_and_empty_override(self):
        for value in ({"segments": [{"start": 0, "end": 1000, "text": "Old"}]}, self.project({})):
            normalized = normalize_project(value)
            self.assertNotIn("assOverride", normalized["segments"][0])

    def test_scale_is_rounded_to_two_decimals_and_default_is_omitted(self):
        for value, expected in [(1, None), (1.005, None), (1.125, 1.13), (1.375, 1.38), (1.225, 1.23), (2.675, 2.67)]:
            with self.subTest(value=value):
                normalized = normalize_project(self.project({"scale": value}))
                override = normalized["segments"][0].get("assOverride")
                if expected is None:
                    self.assertIsNone(override)
                else:
                    self.assertEqual(override, {"scale": expected})
        preserved = normalize_project(self.project({"scale": 1.22, "pos": {"x": 331.5, "y": -161.5}}))
        self.assertEqual(preserved["segments"][0]["assOverride"],
                         {"scale": 1.22, "pos": {"x": 331.5, "y": -161.5}})

    def test_finite_unclamped_coordinates_round_trip(self):
        override = {"pos": {"x": -123.125, "y": 1200.5}}
        original = self.project(override)
        normalized = normalize_project(original)
        reopened = normalize_project(json.loads(serialize_mosp(normalized)))
        self.assertEqual(reopened["segments"][0]["assOverride"], override)
        reopened["segments"][0]["assOverride"]["pos"]["x"] = 8
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
