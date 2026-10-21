from __future__ import annotations

import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from maw.postprocess import LlmPostprocessRequest, OutputMode, apply_llm_groups, run_llm_postprocess
from maw.postprocess_io import read_project, read_srt, render_srt
from maw.postprocess_translation import attach_translation_project
from maw.project import normalize_project
from maw.project_ass_export import render_project_ass
from maw.project_io import serialize_mosp, write_mosp
from maw.project_mutations import replace_main_segments
from maw.project_preview import clamped_preview
from maw.project_tracks import get_main_track, get_track, make_project
from maw.speaker import apply_project_speaker_colors
from maw.local_asr import LocalTranscription, write_local_outputs
from maw.timestamp_alignment import TimedToken, align_project


def cue(identifier="a", text="原文", start=5000, end=6000, **fields):
    return {"id": identifier, "start": start, "end": end, "text": text, **fields}


def multi_project():
    project = make_project([cue(custom={"false": False, "zero": 0}, speaker="speaker-1")],
                           main_fields={"language": "ja", "model": "fixture"},
                           project_fields={"custom_project": {"keep": []}})
    project["tracks"].extend([
        {"id": "first", "role": "extension", "enabled": False, "name": "Other",
         "segments": [cue("first-cue", "其他译文")], "language": "fr"},
        {"id": "second", "role": "extension", "enabled": True, "name": "Active", "metadata": {"keep": False},
         "segments": [cue("second-cue", "旧译文", speaker="speaker-2")], "language": "zh"},
        {"id": "overlay", "role": "overlay", "enabled": True, "name": "Overlay",
         "segments": [cue("overlay-cue", "叠加", start=5500, end=6500, disabled=True)]},
    ])
    project["bilingual"] = {"display_mode": "both", "active_track_id": "second"}
    project["bindings"] = [{"id": "existing-binding", "source_track_id": "main", "target_track_id": "second",
                            "source_segment_ids": ["a"], "target_segment_ids": ["second-cue"],
                            "start_offset_ms": 0, "end_offset_ms": 0, "custom": {"keep": True}}]
    return normalize_project(project)


class TracksConsumerTests(unittest.TestCase):
    def assert_canonical(self, project):
        self.assertEqual(project["schema"], "moy.asr.project.v3")
        self.assertFalse({"segments", "multi_subtitle", "overlay_track"}.intersection(project))
        self.assertEqual(normalize_project(project), project)

    def test_save_roundtrip_preserves_tracks_metadata_and_source(self):
        source = multi_project()
        source["waveform"] = {"cache": True}
        source["tracks"][0]["segments"][0]["_dirty"] = True
        original = copy.deepcopy(source)
        saved = json.loads(serialize_mosp(source))
        self.assert_canonical(saved)
        self.assertEqual(len(saved["tracks"]), 4)
        self.assertEqual(get_main_track(saved)["segments"][0]["custom"], {"false": False, "zero": 0})
        self.assertNotIn("_dirty", get_main_track(saved)["segments"][0])
        self.assertNotIn("waveform", saved)
        self.assertEqual(source, original)

    def test_invalid_future_save_does_not_touch_existing_file(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "source.mosp"
            target.write_text("original\n", encoding="utf-8")
            with self.assertRaises(ValueError):
                write_mosp(target, {"schema": "moy.asr.project.v99", "tracks": []})
            self.assertEqual(target.read_text(encoding="utf-8"), "original\n")

    def test_srt_overlap_import_and_export_use_canonical_tracks(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.srt"
            source.write_text("1\n00:00:05,000 --> 00:00:06,000\n主轨\n\n2\n00:00:05,500 --> 00:00:06,500\n叠加\n", encoding="utf-8")
            project = read_srt(source)
            self.assert_canonical(project)
            self.assertEqual([track["role"] for track in project["tracks"]], ["main", "overlay"])
            self.assertIn("00:00:05,000", render_srt(project))
            self.assertIn("叠加", render_srt(project))
            project["tracks"][1]["enabled"] = False
            self.assertNotIn("叠加", render_srt(project))

    def test_translation_replaces_active_track_and_keeps_global_relations(self):
        source = multi_project()
        original = copy.deepcopy(source)
        translated = copy.deepcopy(source)
        get_main_track(translated)["segments"][0]["text"] = "新译文"
        result = attach_translation_project(source, translated, target="zh")
        self.assert_canonical(result)
        self.assertEqual(get_track(result, "first"), get_track(source, "first"))
        self.assertEqual(get_track(result, "second")["metadata"], {"keep": False})
        self.assertEqual(get_track(result, "second")["segments"][0]["id"], "second-cue")
        self.assertEqual(get_track(result, "second")["segments"][0]["custom"], {"false": False, "zero": 0})
        self.assertEqual(result["bindings"][0]["id"], "existing-binding")
        self.assertEqual(result["bindings"][0]["custom"], {"keep": True})
        self.assertEqual(source, original)

    def test_mutation_rejects_relation_and_group_loss_atomically(self):
        source = multi_project()
        original = copy.deepcopy(source)
        with self.assertRaisesRegex(ValueError, "bindings"):
            replace_main_segments(source, [cue("replacement")])
        self.assertEqual(source, original)
        source["bindings"] = []
        source["subtitle_groups"]["color"].append({"id": "shared", "value": {"name": "green"}})
        get_main_track(source)["segments"][0]["color_group_id"] = "shared"
        original = copy.deepcopy(source)
        with self.assertRaisesRegex(ValueError, "membership"):
            replace_main_segments(source, [cue("a")])
        self.assertEqual(source, original)

    def test_retranslation_preserves_target_cue_attributes_without_stale_items(self):
        source = multi_project()
        target = get_track(source, "second")["segments"][0]
        target.update({"review_note": {"keep": False, "zero": 0}, "disabled": True,
                       "items": [{"text": "旧译文", "start": 5000, "end": 6000}]})
        original = copy.deepcopy(source)
        translated = copy.deepcopy(source)
        get_main_track(translated)["segments"][0]["text"] = "新译文"
        result = attach_translation_project(source, translated, target="zh")
        output = get_track(result, "second")["segments"][0]
        self.assert_canonical(result)
        self.assertEqual(output["text"], "新译文")
        self.assertEqual(output["review_note"], {"keep": False, "zero": 0})
        self.assertTrue(output["disabled"])
        self.assertNotIn("items", output)
        self.assertEqual(source, original)

    def test_mutation_reserves_other_tracks_and_refreshes_offsets(self):
        source = multi_project()
        replace_main_segments(source, [cue(start=5100, end=6100),
                                       {"start": 7000, "end": 8000, "text": "new"}])
        self.assertEqual(source["bindings"][0]["start_offset_ms"], -100)
        self.assertEqual(source["bindings"][0]["end_offset_ms"], -100)
        self.assert_canonical(source)

    def test_invalid_cue_replacement_leaves_current_project_intact(self):
        source = make_project([cue()])
        original = copy.deepcopy(source)
        with self.assertRaises(ValueError):
            replace_main_segments(source, [cue(start=6000, end=5000)])
        self.assertEqual(source, original)

    def test_preview_clamps_every_track_and_keeps_consistent_bindings(self):
        source = multi_project()
        preview = clamped_preview(source, 5750)
        self.assertTrue(all(segment["end"] <= 5750 for track in preview["tracks"] for segment in track["segments"]))
        self.assert_canonical(preview)
        self.assertEqual(get_main_track(source)["segments"][0]["end"], 6000)

    def test_ass_migrates_v2_groups_and_keeps_source_media_time(self):
        source = {"schema": "moy.asr.project.v2", "segments": [cue(color_group_id="green")],
                  "overlay_track": {"enabled": True, "segments": [cue("overlay", "Overlay", 5500, 6500, color_group_id="green")]},
                  "subtitle_groups": {"next_id": 2, "color": [{"id": "green", "value": {"name": "green"}}], "sticker": []}}
        original = copy.deepcopy(source)
        ass = render_project_ass(source, title="tracks", play_resolution=(1920, 1080))
        self.assertIn("Dialogue: 0,0:00:05.00,0:00:06.00,GREEN", ass)
        self.assertIn("Overlay GREEN", ass)
        self.assertEqual(source, original)

    def test_speaker_colors_write_group_table_without_legacy_fields(self):
        source = make_project([cue(speaker="a"), cue("b", start=7000, end=8000, speaker="a")])
        result = apply_project_speaker_colors(source)
        self.assertEqual(result["colored_segments"], 2)
        self.assertEqual(len(source["subtitle_groups"]["color"]), 1)
        self.assertTrue(all("color_group_id" in segment and "color" not in segment and "color_ref" not in segment
                            for segment in get_main_track(source)["segments"]))
        self.assert_canonical(source)

    def test_asr_writer_creates_v3_tracks_with_speaker_groups(self):
        with tempfile.TemporaryDirectory() as directory:
            media = Path(directory) / "input.wav"
            media.write_bytes(b"unchanged source")
            segments = [cue(speaker="one")]
            transcription = LocalTranscription("原文", "zh", [], segments, "fixture",
                                               "detected", "continuous", "segment")
            with patch("maw.project_io.probe_video_fps", return_value=None), patch("maw.project_io.probe_audio_tracks", return_value=None):
                result = write_local_outputs(input_path=media, output_srt=media.with_suffix(".srt"),
                                             transcription=transcription, segments=segments, write_json=True,
                                             generate_html=False, with_waveform=False, speaker_colors=True)
            saved = read_project(result.json)
            self.assert_canonical(saved)
            self.assertEqual(get_main_track(saved)["model"], "fixture")
            self.assertIn("color_group_id", get_main_track(saved)["segments"][0])
            self.assertEqual(media.read_bytes(), b"unchanged source")

    def test_alignment_visits_all_tracks_and_keeps_per_track_language(self):
        project = multi_project()
        visited = []
        def align(_backend, _media, text, start, end, *, language, **_kwargs):
            visited.append((text, language))
            return [TimedToken(text, start, end)]
        with tempfile.TemporaryDirectory() as directory:
            media = Path(directory) / "input.wav"
            media.write_bytes(b"fixture")
            with patch("maw.timestamp_alignment.create_alignment_backend", return_value=object()), \
                    patch("maw.timestamp_alignment._align_span", side_effect=align):
                report = align_project(project, media_path=media, model_id="qwen3-forced-aligner-0.6b", mode="generate")
        self.assertEqual(report.aligned_segments, 4)
        self.assertEqual(visited, [("原文", "ja"), ("其他译文", "fr"), ("旧译文", "zh"), ("叠加", "ja")])
        self.assertTrue(all(track["timestamp_granularity"] == "char" for track in project["tracks"]))
        self.assert_canonical(project)

    def test_llm_changes_only_canonical_main_content(self):
        source = make_project([cue(custom={"keep": False})])
        result = apply_llm_groups(source, {"groups": [{"id": "c0001", "text": "改文"}]})
        self.assertEqual(get_main_track(result)["segments"][0]["text"], "改文")
        self.assertEqual(get_main_track(result)["segments"][0]["custom"], {"keep": False})
        self.assert_canonical(result)

    def test_split_keeps_first_id_groups_and_avoids_other_track_ids(self):
        project = make_project([cue(custom={"keep": False})])
        project["subtitle_groups"]["color"].append({"id": "green", "value": {"name": "green"}})
        get_main_track(project)["segments"][0]["color_group_id"] = "green"
        project["tracks"].append({"id": "overlay", "name": "Overlay", "enabled": False, "role": "overlay",
                                  "segments": [cue("a-part-002", "keep")]})
        result = apply_llm_groups(project, {"groups": [{"source_ids": ["c0001"], "text": "原"},
                                                       {"source_ids": ["c0001"], "text": "文"}]})
        segments = get_main_track(result)["segments"]
        self.assertEqual(segments[0]["id"], "a")
        self.assertNotEqual(segments[1]["id"], "a-part-002")
        self.assertTrue(all(segment["color_group_id"] == "green" and segment["custom"] == {"keep": False}
                            for segment in segments))
        self.assert_canonical(result)

    def test_translation_writer_reopens_only_v3_and_preserves_source(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "source.mosp"
            source = make_project([cue(text="今日はいい天気ですね。")])
            target.write_text(json.dumps(source, ensure_ascii=False), encoding="utf-8")
            request = LlmPostprocessRequest(target, None, OutputMode.BOTH, "translate_zh", "", merge_bilingual=True)
            with patch("maw.output_naming.subfolder_prefs", return_value=(False, False)):
                artifact = run_llm_postprocess(request, complete=lambda _prompt, cues: {
                    "groups": [{"id": value["id"], "text": "今天天气很好。"} for value in cues]})
            saved = read_project(artifact.project_path)
            self.assert_canonical(saved)
            self.assertEqual(get_main_track(saved), get_main_track(source))
            self.assertEqual(saved["tracks"][1]["segments"][0]["text"], "今天天气很好。")
            self.assertEqual(read_project(target), source)


if __name__ == "__main__":
    unittest.main()
