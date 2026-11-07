import copy
import unittest

from maw.project_tracks import import_project
from maw.postprocess_ai_cleanup_items import cleaned_srt_segments


class SpeakerCleanupMigrationTests(unittest.TestCase):
    def test_saved_swapped_secondary_scope_survives_speaker_upgrade(self):
        items = [{"text": text, "start": i * 500, "end": (i + 1) * 500,
                  "speaker": "a" if i == 0 else "b"} for i, text in enumerate("ABC")]
        cue = {"id": "original", "start": 0, "end": 1500, "text": "ABC", "items": items}
        for stale in (False, True):
            entry = {"start": 500, "end": 1000, "cleanup_scope": {"segment_id": "original",
                     "item_start": 1, "item_end": 2, "text": "stale" if stale else "B"}}
            saved = {"schema": "moy.asr.project.v2", "tracks": [
                {"id": "translation", "role": "main", "name": "Translation", "enabled": True,
                 "segments": [{"id": "translation-cue", "start": 0, "end": 1500, "text": "translation", "items": []}]},
                {"id": "original-track", "role": "secondary", "name": "Original", "enabled": True, "segments": [cue]}],
                "bindings": [], "bilingual": {"active_track_id": "original-track", "display_mode": "both"},
                "subtitle_groups": {"next_id": 1, "color": [], "sticker": []},
                "gap_remove": {"gaps": [{"start": 500, "end": 1000, "removed": True}],
                               "provenance": {"sources": {"ai_cleanup": [entry]}}}}
            expected = "".join(c["text"] for c in cleaned_srt_segments(saved, [cue]))
            after = import_project(copy.deepcopy(saved)).project
            secondary = next(track for track in after["tracks"] if track["role"] == "secondary")
            self.assertEqual("".join(c["text"] for c in cleaned_srt_segments(after, secondary["segments"])), expected)
            self.assertEqual(expected, "ABC" if stale else "AC")
            self.assertEqual(after["tracks"][0]["segments"][0]["text"], "translation")
            ranges = after["gap_remove"]["provenance"]["sources"]["ai_cleanup"]
            self.assertEqual((ranges[0]["start"], ranges[-1]["end"]), (500, 1000))
            if stale:
                self.assertNotIn("cleanup_scope", ranges[0])

    def test_scopes_split_without_losing_audio_or_authorizing_stale_words(self):
        items = [{"text": text, "start": i * 600, "end": i * 600 + 500, "speaker": "a" if not i else "b"}
                 for i, text in enumerate(("A", " B", "，C"))]
        for first, last, stale in ((1, 2, False), (0, 2, False), (1, 2, True)):
            cue = {"id": "cue", "start": 0, "end": 1700, "text": "A B，C", "items": items,
                   "assStyle": {"font": "x"}, "vendor": 3}
            scope = {"segment_id": "cue", "item_start": first, "item_end": last,
                     "text": "stale" if stale else "".join(item["text"] for item in items[first:last]), "vendor": 9}
            entry = {"id": "cut", "start": items[first]["start"], "end": items[last - 1]["end"], "cleanup_scope": scope}
            before = {"schema": "moy.asr.project.v2", "tracks": [{"id": "main", "role": "main", "name": "Main", "enabled": True, "segments": [cue]}], "bindings": [],
                      "bilingual": {"display_mode": "both"}, "subtitle_groups": {"next_id": 1, "color": [], "sticker": []},
                      "processing_overrides": {"text": []}, "styles": {"vendor": True},
                      "gap_remove": {"gaps": [{"start": entry["start"], "end": entry["end"], "removed": True}],
                                     "provenance": {"sources": {"ai_cleanup": [entry]}}}}
            after = import_project(copy.deepcopy(before)).project
            old_text = "".join(c["text"] for c in cleaned_srt_segments(before, [cue]))
            new_text = "".join(c["text"] for c in cleaned_srt_segments(after, after["tracks"][0]["segments"]))
            self.assertEqual(old_text, new_text)
            self.assertEqual(after["processing_overrides"], before["processing_overrides"])
            self.assertEqual(after["styles"], before["styles"])
            self.assertTrue(all(c["assStyle"] == {"font": "x"} and c["vendor"] == 3 for c in after["tracks"][0]["segments"]))
            ranges = after["gap_remove"]["provenance"]["sources"]["ai_cleanup"]
            self.assertEqual((ranges[0]["start"], ranges[-1]["end"]), (entry["start"], entry["end"]))
            self.assertTrue(all(a["end"] == b["start"] for a, b in zip(ranges, ranges[1:])))
            if stale:
                self.assertNotIn("cleanup_scope", ranges[0])

    def test_punctuation_and_dangling_scope(self):
        for text in ("A，BC", "A B C"):
            items = [{"text": value, "start": i * 600, "end": i * 600 + 500, "speaker": "a" if not i else "b"}
                     for i, value in enumerate(("A", "B", "C"))]
            cue = {"id": "cue", "start": 0, "end": 1700, "text": text, "items": items}
            entry = {"start": 600, "end": 1100, "cleanup_scope": {"segment_id": "cue", "item_start": 1, "item_end": 2, "text": "B"}}
            before = {"schema": "moy.asr.project.v2", "tracks": [{"id": "main", "role": "main", "name": "Main", "enabled": True, "segments": [cue]}],
                      "bindings": [], "bilingual": {"display_mode": "both"}, "subtitle_groups": {"next_id": 1, "color": [], "sticker": []},
                      "gap_remove": {"gaps": [{"start": 600, "end": 1100, "removed": True}], "provenance": {"sources": {"ai_cleanup": [entry]}}}}
            after = import_project(before).project
            self.assertNotIn("B", "".join(c["text"] for c in cleaned_srt_segments(after, after["tracks"][0]["segments"])))
            entry["cleanup_scope"]["segment_id"] = "cue-speaker-1"
            after = import_project(before).project
            self.assertNotEqual(after["tracks"][0]["segments"][1]["id"], "cue-speaker-1")
            self.assertIn("B", "".join(c["text"] for c in cleaned_srt_segments(after, after["tracks"][0]["segments"])))

    def test_edge_token_whitespace_does_not_lose_cleanup(self):
        for values in ((" A", " B", " C"), ("A", " B", " C ")):
            items = [{"text": value, "start": i * 600, "end": i * 600 + 500, "speaker": "a" if not i else "b"}
                     for i, value in enumerate(values)]
            cue = {"id": "cue", "start": 0, "end": 1700, "text": "A B C", "items": items}
            entry = {"start": 600, "end": 1100, "cleanup_scope": {"segment_id": "cue", "item_start": 1, "item_end": 2, "text": " B"}}
            before = {"schema": "moy.asr.project.v2", "tracks": [{"id": "main", "role": "main", "name": "Main", "enabled": True, "segments": [cue]}],
                      "bindings": [], "bilingual": {"display_mode": "both"}, "subtitle_groups": {"next_id": 1, "color": [], "sticker": []},
                      "gap_remove": {"gaps": [{"start": 600, "end": 1100, "removed": True}], "provenance": {"sources": {"ai_cleanup": [entry]}}}}
            self.assertEqual(cleaned_srt_segments(before, [cue])[0]["text"], "A C")
            after = import_project(before).project
            self.assertEqual("".join(c["text"] for c in after["tracks"][0]["segments"]), "A B C")
            self.assertNotIn("B", "".join(c["text"] for c in cleaned_srt_segments(after, after["tracks"][0]["segments"])))


if __name__ == "__main__":
    unittest.main()
