import copy
import json
from pathlib import Path
import unittest

from maw.speaker_identity import allocate_source_speaker_ids, distinct_speaker_ids, prepare_asr_speaker_segments, migrate_speaker_segments, validate_project_speakers
from maw.speaker import apply_project_speaker_colors, speaker_color_summary


class SpeakerIdentityTests(unittest.TestCase):
    def test_counts_distinct_nonempty_source_ids_in_first_seen_order(self):
        segments = [{"speaker": value} for value in ("6", "1", "6", "", "  ", None, "0")]
        segments.append({})
        self.assertEqual(distinct_speaker_ids(segments), ["6", "1", "0"])

    def test_asr_summary_uses_valid_distinct_identities(self):
        segments = [{"speaker": value} for value in ("6", "1", "6", "", "  ", None)]
        summary = speaker_color_summary(segments)
        self.assertEqual(summary["speakers"], ["6", "1"])
        self.assertEqual(summary["colored_segments"], 3)
        self.assertFalse(summary["overflow"])

    def test_blank_source_identity_is_not_assigned_a_color_group(self):
        segments = [{"speaker": "  "}, {"speaker": "6"}]
        project = {"tracks": [{"id": "main", "role": "main", "segments": segments}],
                   "subtitle_groups": {"next_id": 1, "color": [], "sticker": []}}
        self.assertEqual(apply_project_speaker_colors(project)["speakers"], ["6"])
        self.assertNotIn("color_group_id", segments[0])
        self.assertIn("color_group_id", segments[1])

    def test_cleaned_segments_keep_word_timing_but_only_store_segment_identity(self):
        source = [{"id": "cue-1", "text": "你好", "start": 0, "end": 200,
                   "speaker": "provider-1", "items": [
                       {"text": "你", "start": 0, "end": 100, "speaker": "provider-1"},
                       {"text": "好", "start": 100, "end": 200, "speaker": "provider-1"}]}]
        original = repr(source)
        result = prepare_asr_speaker_segments(source, {"provider-1": "spk-1"})
        self.assertEqual(result[0]["speaker"], "spk-1")
        self.assertEqual(result[0]["items"], [
            {"text": "你", "start": 0, "end": 100}, {"text": "好", "start": 100, "end": 200}])
        self.assertEqual(repr(source), original)

    def test_shared_legacy_migration_fixture(self):
        fixture = json.loads((Path(__file__).parent / "fixtures/speaker-migration.json").read_text(encoding="utf-8"))
        source = copy.deepcopy(fixture["segments"])
        result, mappings = migrate_speaker_segments(source, fixture["mapping"], reserved_segment_ids=fixture["reserved_ids"])
        self.assertEqual(result, fixture["expected"])
        self.assertEqual(mappings, fixture["expected_mappings"])
        self.assertEqual(source, fixture["segments"])
        again, _ = migrate_speaker_segments(result, {"p6": "p6", "p01": "p01", "pold": "pold"})
        self.assertEqual(again, result)
        punctuation = fixture["punctuation"]
        self.assertEqual(migrate_speaker_segments(punctuation["segments"], fixture["mapping"])[0],
                         punctuation["expected"])

    def test_invalid_split_data_and_unmapped_identity_fail_without_guessing(self):
        source = [{"id": "a", "text": "ab", "start": 0, "end": 2,
                   "items": [{"text": "a", "start": 0, "end": 1, "speaker": "one"},
                             {"text": "b", "start": 1, "end": 2, "speaker": "two"}]}]
        mapping = {"one": "p1", "two": "p2"}
        bad = copy.deepcopy(source)
        bad[0]["text"] = "changed"
        with self.assertRaisesRegex(ValueError, "matching item text"):
            migrate_speaker_segments(bad, mapping)
        bad = copy.deepcopy(source)
        del bad[0]["items"][1]["start"]
        with self.assertRaisesRegex(ValueError, "integer item timestamps"):
            migrate_speaker_segments(bad, mapping)
        bad = copy.deepcopy(source)
        bad[0].update(start_frame=0, end_frame=2)
        with self.assertRaisesRegex(ValueError, "item frame boundaries"):
            migrate_speaker_segments(bad, mapping)
        with self.assertRaisesRegex(ValueError, "unmapped source speaker"):
            prepare_asr_speaker_segments([{"speaker": "one"}], {})
        with self.assertRaisesRegex(ValueError, "duplicate segment id"):
            migrate_speaker_segments([{"id": "a"}, {"id": "a"}], {})

    def test_word_identity_can_supply_unambiguous_segment_identity(self):
        source = [{"items": [{"text": "Hi", "speaker": "one"}, {"text": "!"}]}]
        result = prepare_asr_speaker_segments(source, {"one": "spk-1"})
        self.assertEqual(result[0]["speaker"], "spk-1")
        self.assertNotIn("speaker", result[0]["items"][0])

    def test_allocation_supports_word_only_source_identity(self):
        source = [{"items": [{"text": "Hi", "speaker": "one"}, {"text": "!"}]}]
        mapping = allocate_source_speaker_ids(source, reserved_ids=set())
        result = prepare_asr_speaker_segments(source, mapping)
        self.assertEqual(result[0]["speaker"], mapping["one"])
        self.assertEqual(result[0]["items"], [{"text": "Hi"}, {"text": "!"}])

    def test_v2_identity_contract_preserves_distinct_people_with_same_name_and_color(self):
        project = {"speakers": [{"id": "p1", "name": "主持人", "color": "#f9ca1f"},
                                {"id": "p2", "name": "主持人", "color": "#f9ca1f"}],
                   "tracks": [{"segments": [{"speaker": "p1"}, {"speaker": "p2"}, {"speaker": None}]}]}
        self.assertEqual(validate_project_speakers(project), [])

    def test_v2_identity_contract_rejects_dangling_ids_and_item_speakers(self):
        project = {"speakers": [{"id": "p1", "name": "一", "color": "#f9ca1f"}],
                   "tracks": [{"segments": [{"speaker": "missing", "items": [{"speaker": "p1"}]}]}]}
        paths = {error["path"] for error in validate_project_speakers(project)}
        self.assertEqual(paths, {"$.tracks[0].segments[0].speaker", "$.tracks[0].segments[0].items[0].speaker"})

    def test_v2_identity_contract_rejects_duplicate_ids_and_invalid_display_values(self):
        project = {"speakers": [{"id": "p1", "name": "一", "color": "#f9ca1f"},
                                {"id": "p1", "name": "bad\nname", "color": "grey"}], "tracks": []}
        paths = {error["path"] for error in validate_project_speakers(project)}
        self.assertEqual(paths, {"$.speakers[1].id", "$.speakers[1].name", "$.speakers[1].color"})

    def test_v2_identity_contract_reports_invalid_project_shape(self):
        self.assertEqual([error["path"] for error in validate_project_speakers(None)], ["$"])
        self.assertEqual([error["path"] for error in validate_project_speakers({})], ["$.speakers", "$.tracks"])

    def test_unicode_only_whitespace_ids_are_not_valid_identities(self):
        for identifier in ("\u0085", "\ufeff", "\u001c"):
            with self.subTest(identifier=repr(identifier)):
                project = {"speakers": [{"id": identifier, "name": "x", "color": "#f9ca1f"}], "tracks": []}
                self.assertEqual([error["path"] for error in validate_project_speakers(project)], ["$.speakers[0].id"])
                self.assertEqual(distinct_speaker_ids([{"speaker": identifier}]), [])

    def test_source_identifiers_are_mapped_to_fresh_project_identities(self):
        segments = [{"speaker": "6"}, {"speaker": "6"}, {"speaker": "1"}, {"speaker": ""}]
        reserved = {"spk-001", "spk-003"}
        mapping = allocate_source_speaker_ids(segments, reserved_ids=reserved)
        self.assertEqual(mapping, {"6": "spk-002", "1": "spk-004"})
        next_mapping = allocate_source_speaker_ids(segments, reserved_ids=reserved | set(mapping.values()))
        self.assertTrue((reserved | set(mapping.values())).isdisjoint(next_mapping.values()),
                        "independent ASR sources must not be silently treated as the same people")


if __name__ == "__main__":
    unittest.main()
