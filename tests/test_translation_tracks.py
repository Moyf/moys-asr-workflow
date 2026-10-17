from __future__ import annotations

import copy
import json
import tempfile
import unittest
from pathlib import Path
from threading import Event
from unittest.mock import patch

from tests.compact_assertions import CompactContainerAssertions

from maw.postprocess import LlmPostprocessRequest, OutputMode, run_llm_postprocess
from maw.postprocess_io import read_project
from maw.postprocess_pipeline import default_postprocess_plan, run_postprocess_pipeline
from maw.postprocess_translation import attach_translation_project
from maw.project import normalize_project


class TranslationTracksTests(CompactContainerAssertions, unittest.TestCase):
    def source(self, text):
        return normalize_project({
            "segments": [{"id": "source", "start": 0, "end": 1000, "text": text,
                          "items": [{"start": 0, "end": 1000, "text": text}],
                          "speaker": "speaker-1", "custom": {"keep": True}}],
            "user_metadata": {"keep": True},
        })

    def test_pipeline_keeps_editable_intermediate_and_final_projects(self):
        for original, target, translation in (
            ("今日はいい天気ですね。", "zh", "今天天气很好。"),
            ("The weather is nice today.", "zh", "今天天气很好。"),
            ("今天天气很好。", "en", "The weather is nice today."),
        ):
            for merge, order in ((False, ""), (True, "translation_first"), (True, "original_first")):
                with self.subTest(original=original, merge=merge, order=order), tempfile.TemporaryDirectory() as directory:
                    root = Path(directory)
                    source = self.source(original)
                    source["multi_subtitle"] = {"enabled": True, "tracks": [{"id": "translation-zh",
                        "segments": [{"id": "old", "start": 0, "end": 1000, "text": "旧译文"}]}],
                        "bindings": [{"id": "old-binding", "track_id": "translation-zh",
                            "main_segment_ids": ["source"], "extension_segment_ids": ["old"],
                            "start_offset_ms": 0, "end_offset_ms": 0}]}
                    source = normalize_project(source)
                    project, srt, media = root / "input.mosp", root / "input.srt", root / "media.mp3"
                    project.write_text(json.dumps(source, ensure_ascii=False), encoding="utf-8")
                    srt.write_text(f"1\n00:00:00,000 --> 00:00:01,000\n{original}\n", encoding="utf-8")
                    media.write_bytes(b"fixture")
                    plan = default_postprocess_plan()
                    plan.update(enabled=True, retainIntermediate=True, steps=[{
                        "id": "translate", "enabled": True, "target": target, "mergeBilingual": merge,
                        "bilingualLineOrder": order, "providerId": "deepseek", "generateComparison": True,
                    }])
                    def complete(_settings, _prompt, cues):
                        return {"groups": [{"id": cue["id"], "text": translation} for cue in cues]}
                    with patch("maw.output_naming.subfolder_prefs", return_value=(False, False)), patch(
                        "maw.postprocess_pipeline.complete_subtitle_groups", side_effect=complete
                    ):
                        result = run_postprocess_pipeline(
                            plan, media_path=media, project_path=project, srt_path=srt,
                            env_path=root / "unused.env", ffmpeg_path=None, cancel_event=Event(), ui_language="en",
                            llm_settings={"deepseek": {"apiKey": "fixture", "baseUrl": "https://example.test", "model": "fixture", "verified": "1"}},
                        )
                    self.assertEqual(result.skipped_steps, ())
                    manifest = json.loads((result.run_directory / "manifest.json").read_text(encoding="utf-8"))
                    stage = manifest["steps"][0]
                    for path in (result.project_path, Path(stage["projectPath"]), Path(stage["translationIntermediateProjectPath"])):
                        saved = read_project(path)
                        self.assertEqual(saved["segments"], source["segments"])
                        self.assertEqual(saved["user_metadata"], source["user_metadata"])
                        multi = saved["multi_subtitle"]
                        self.assertEqual(multi["tracks"][0], source["multi_subtitle"]["tracks"][0])
                        self.assertEqual(multi["bindings"], source["multi_subtitle"]["bindings"])
                        self.assertEqual(multi["active_track_id"], multi["tracks"][-1]["id"])
                        self.assertEqual(multi["display_mode"], "both")
                        self.assertEqual([s["text"] for s in multi["tracks"][-1]["segments"]], [translation])
                        self.assertEqual(multi["bindings"][0]["main_segment_ids"], ["source"])
                    text = result.srt_path.read_text(encoding="utf-8-sig")
                    expected = (f"{translation}\n{original}" if order == "translation_first" else f"{original}\n{translation}") if merge else original
                    self.assertIn(expected, text)
                    intermediate_srt = Path(stage["translationIntermediateSrtPath"]).read_text(encoding="utf-8-sig")
                    self.assertIn(translation, intermediate_srt)
                    self.assertNotIn(original, intermediate_srt)

    def test_toolbox_review_keeps_old_tracks_bindings_and_source_items(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = self.source("今日はいい天気ですね。")
            source["multi_subtitle"] = {
                "enabled": True, "display_mode": "main",
                "tracks": [{"id": "translation-zh", "segments": [{"id": "old", "start": 0, "end": 1000, "text": "旧副轨"}]}],
                "bindings": [{"id": "old-binding", "track_id": "translation-zh", "main_segment_ids": ["source"], "extension_segment_ids": ["old"], "start_offset_ms": 0, "end_offset_ms": 0}],
            }
            source = normalize_project(source)
            original = copy.deepcopy(source)
            path = root / "input.mosp"
            path.write_text(json.dumps(source, ensure_ascii=False), encoding="utf-8")
            artifact = run_llm_postprocess(LlmPostprocessRequest(
                path, None, OutputMode.BOTH, "translate_zh", "", merge_bilingual=True, generate_comparison=True,
            ), complete=lambda _prompt, cues: {"groups": [{"id": cue["id"], "text": "今天天气很好。"} for cue in cues]})
            saved = read_project(artifact.project_path)
            self.assertEqual(saved["segments"], original["segments"])
            self.assertEqual(saved["multi_subtitle"]["tracks"][0], original["multi_subtitle"]["tracks"][0])
            self.assertEqual(saved["multi_subtitle"]["bindings"], original["multi_subtitle"]["bindings"])
            self.assertEqual(saved["multi_subtitle"]["tracks"][-1]["id"], "translation-zh-2")
            self.assertEqual(saved["multi_subtitle"]["active_track_id"], "translation-zh-2")
            html = artifact.comparison_path.read_text(encoding="utf-8")
            data = json.loads(html.split('<script id="comparison-data" type="application/json">', 1)[1].split('</script>', 1)[0])
            packet = json.loads(data["translationReview"]["snapshot"])
            self.assertEqual(packet["mode"], "tracks")
            self.assertEqual(packet["translationTrackId"], "translation-zh-2")
            self.assertEqual(packet["entries"][0]["targetId"], "translation-zh-2-segment-001")
            self.assertEqual(packet["result"]["segments"], source["segments"])
            self.assertEqual(data["after"], "今天天气很好。")
            self.assertEqual(read_project(path), original)

    def test_retranslation_activates_each_new_track_without_mutating_prior_tracks(self):
        source = self.source("Original")
        translated = copy.deepcopy(source)
        for index, text in enumerate(("第一版", "第二版", "Original"), 1):
            previous = copy.deepcopy(source)
            translated["segments"][0]["text"] = text
            source = attach_translation_project(source, translated, target="zh")
            multi = source["multi_subtitle"]
            self.assertEqual(multi["active_track_id"], "translation-zh" + (f"-{index}" if index > 1 else ""))
            self.assertEqual(multi["tracks"][:-1], previous.get("multi_subtitle", {}).get("tracks", []))
            self.assertEqual(source["segments"], previous["segments"])
        # Even a fully filtered new translation must not reactivate an old one.
        self.assertEqual(source["multi_subtitle"]["tracks"][-1]["segments"], [])
