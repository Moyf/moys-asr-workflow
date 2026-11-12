from __future__ import annotations

import copy
import unittest

from maw.postprocess_translation import attach_translation_project
from maw.project import normalize_project
from maw.project_tracks import get_main_track, get_tracks_by_role


class TranslationTrackMetadataTests(unittest.TestCase):
    def test_translation_keeps_secondary_groups_independent_of_main(self):
        source = normalize_project({
            "segments": [{"id": "source", "start": 0, "end": 1000, "text": "Hello",
                          "color": {"name": "main color"}, "sticker": {"name": "main sticker"}}],
            "multi_subtitle": {
                "enabled": True,
                "tracks": [{"id": "secondary", "segments": [
                    {"id": "target", "start": 0, "end": 1000, "text": "旧译文",
                     "color": {"name": "secondary color"}, "sticker": {"name": "secondary sticker"}},
                ]}],
                "bindings": [{"id": "binding", "track_id": "secondary",
                              "main_segment_ids": ["source"], "extension_segment_ids": ["target"]}],
            },
        })
        source["speakers"] = [
            {"id": "main speaker", "name": "Main", "color": "#112233"},
            {"id": "secondary speaker", "name": "Secondary", "color": "#445566"},
        ]
        get_main_track(source)["segments"][0]["assOverride"] = {"scale": 1.5}
        get_main_track(source)["segments"][0]["disabled"] = False
        get_main_track(source)["segments"][0]["speaker"] = "main speaker"
        get_tracks_by_role(source, "secondary")[0]["segments"][0]["assOverride"] = {"scale": 0.7}
        get_tracks_by_role(source, "secondary")[0]["segments"][0]["disabled"] = True
        get_tracks_by_role(source, "secondary")[0]["segments"][0]["speaker"] = "secondary speaker"
        get_main_track(source)["segments"][0]["color_group_metadata"] = {"origin": "main"}
        get_tracks_by_role(source, "secondary")[0]["segments"][0]["color_group_metadata"] = {"origin": "secondary"}
        original_secondary = copy.deepcopy(get_tracks_by_role(source, "secondary")[0]["segments"][0])
        translated = copy.deepcopy(source)
        get_main_track(translated)["segments"][0]["text"] = "新译文"

        result = attach_translation_project(source, translated, target="zh")
        secondary = get_tracks_by_role(result, "secondary")[0]["segments"][0]
        self.assertEqual(secondary["text"], "新译文")
        for field in ("color_group_id", "sticker_group_id"):
            self.assertEqual(secondary[field], original_secondary[field])
            self.assertNotEqual(secondary[field], get_main_track(result)["segments"][0][field])
        self.assertEqual(secondary["color_group_metadata"], {"origin": "secondary"})
        self.assertEqual(secondary["assOverride"], {"scale": 0.7})
        self.assertTrue(secondary["disabled"])
        self.assertEqual(secondary["speaker"], "secondary speaker")

        del get_tracks_by_role(source, "secondary")[0]["segments"][0]["disabled"]
        del get_tracks_by_role(source, "secondary")[0]["segments"][0]["speaker"]
        result = attach_translation_project(source, translated, target="zh")
        secondary = get_tracks_by_role(result, "secondary")[0]["segments"][0]
        self.assertNotIn("disabled", secondary)
        self.assertNotIn("speaker", secondary)

    def test_new_translation_does_not_join_main_groups(self):
        source = normalize_project({"segments": [{"id": "source", "start": 0, "end": 1000,
            "text": "Hello", "color": {"name": "main color"}, "sticker": {"name": "main sticker"}}]})
        source["speakers"] = [{"id": "main speaker", "name": "Main", "color": "#112233"}]
        translated = copy.deepcopy(source)
        get_main_track(translated)["segments"][0]["assOverride"] = {"scale": 1.5}
        get_main_track(translated)["segments"][0]["speaker"] = "main speaker"
        get_main_track(translated)["segments"][0]["disabled"] = True
        get_main_track(translated)["segments"][0]["text"] = "译文"

        result = attach_translation_project(source, translated, target="zh")
        secondary = get_tracks_by_role(result, "secondary")[0]["segments"][0]
        self.assertNotIn("color_group_id", secondary)
        self.assertNotIn("sticker_group_id", secondary)
        self.assertNotIn("assOverride", secondary)
        self.assertEqual(secondary["speaker"], "main speaker")
        self.assertTrue(secondary["disabled"])


if __name__ == "__main__":
    unittest.main()
