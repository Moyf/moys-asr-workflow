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
                              ({"pos": {"x": 1}}, ".pos.y"), ({"pos": {"x": "1", "y": 2}}, ".pos.x"),
                              ({"pos": {"x": float("inf"), "y": 2}}, ".pos.x"),
                              ({"pos": {"x": 10**1000, "y": 2}}, ".pos.x"),
                              ({"pos": {"x": 1, "y": float("nan")}}, ".pos.y")]:
            with self.subTest(value=value):
                result = validate_project(self.project(value))
                self.assertFalse(result.ok)
                self.assertIn("$.segments[0].assOverride" + suffix, {error.path for error in result.errors})
