from __future__ import annotations

import copy
import json
import unittest

from maw.project import normalize_project, validate_project
from maw.project_io import serialize_mosp
from maw.project_tracks import get_main_track


class FpsSourceTests(unittest.TestCase):
    def test_round_trip_does_not_retime_or_invent_source(self):
        for unit, fps in (("milliseconds", 30), ("milliseconds", 23.976), ("frames", 30)):
            for source in (None, "auto", "user"):
                with self.subTest(unit=unit, fps=fps, source=source):
                    timebase = {"unit": unit, "fps": fps}
                    if source is not None:
                        timebase["fps_source"] = source
                    project = {"timebase": timebase, "segments": [{
                        "id": "s", "start": 101, "end": 899, "text": "hello",
                        "start_frame": 3, "end_frame": 27,
                        "items": [{"start": 101, "end": 899, "text": "hello",
                                   "start_frame": 3, "end_frame": 27}],
                    }], "custom_extension": {"offset": 17}}
                    before = copy.deepcopy(project)
                    result = json.loads(serialize_mosp(normalize_project(project)))
                    self.assertEqual(result["timebase"], timebase)
                    self.assertEqual(get_main_track(result)["segments"], project["segments"])
                    self.assertEqual(result["custom_extension"], project["custom_extension"])
                    self.assertEqual(project, before)

    def test_invalid_sources_are_rejected_at_exact_path(self):
        for source in (None, "", "AUTO", False, 0, [], {}):
            with self.subTest(source=source):
                result = validate_project({"segments": [], "timebase": {
                    "unit": "milliseconds", "fps": 30, "fps_source": source,
                }})
                self.assertFalse(result.ok)
                self.assertIn("$.timebase.fps_source", {error.path for error in result.errors})
