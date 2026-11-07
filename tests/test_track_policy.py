import unittest

from maw.track_policy import is_track_enabled, select_tracks, unsupported_variant


class TrackPolicyTest(unittest.TestCase):
    def test_surfaces_and_unknown_variant(self):
        for enabled in (True, False):
            for preview in (None, True, False):
                for exported in (None, True, False):
                    track = {"role": "overlay", "enabled": enabled}
                    if preview is not None:
                        track["preview_visible"] = preview
                    if exported is not None:
                        track["export"] = {"enabled": exported}
                    self.assertEqual(is_track_enabled(track, "preview"), enabled and preview is not False)
                    self.assertEqual(is_track_enabled(track, "export"), enabled and exported is not False)
        track = {"role": "overlay", "enabled": True, "variant": "future", "data": {"keep": True}}
        self.assertTrue(unsupported_variant(track))
        self.assertFalse(is_track_enabled(track, "preview"))
        self.assertFalse(is_track_enabled(track, "export"))
        self.assertEqual(track["data"], {"keep": True})

    def test_selection(self):
        main = {"id": "m", "role": "main", "enabled": True}
        overlay = {"id": "o", "role": "overlay", "enabled": True, "preview_visible": False}
        secondary = {"id": "s", "role": "secondary", "enabled": True, "export": {"enabled": False}}
        project = {"tracks": [main, overlay, secondary], "bilingual": {"active_track_id": "s"}}
        self.assertEqual(select_tracks(project), [main, overlay])
        self.assertEqual(select_tracks(project, "all", "preview"), [main, secondary])
        self.assertEqual(select_tracks(project, "extension", "export"), [])
        overlay["variant"] = "future"
        self.assertEqual(select_tracks(project), [main])


if __name__ == "__main__":
    unittest.main()
