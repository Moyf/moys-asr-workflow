from __future__ import annotations

import copy
import json
import tempfile
import unittest
from pathlib import Path
from threading import Event
from unittest.mock import patch

from maw.postprocess import LlmPostprocessRequest, OutputMode, PostprocessStepError, run_llm_postprocess
from maw.postprocess_io import read_project
from maw.postprocess_llm import LlmClientError
from maw.postprocess_pipeline import PostprocessCancelled, default_postprocess_plan, run_postprocess_pipeline
from maw.project import normalize_project
from tests.compact_assertions import CompactContainerAssertions


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
                        self.assertEqual(multi["display_mode"], "both")
                        self.assertEqual([s["text"] for s in multi["tracks"][-1]["segments"]], [translation])
                        self.assertEqual(multi["bindings"][0]["main_segment_ids"], ["source"])
                    text = result.srt_path.read_text(encoding="utf-8-sig")
                    expected = (f"{translation}\n{original}" if order == "translation_first" else f"{original}\n{translation}") if merge else original
                    self.assertIn(expected, text)
                    intermediate_srt = Path(stage["translationIntermediateSrtPath"]).read_text(encoding="utf-8-sig")
                    self.assertIn(translation, intermediate_srt)
                    self.assertNotIn(original, intermediate_srt)

    def test_toolbox_review_replaces_fixed_track_and_preserves_source_and_binding_identity(self):
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
            self.assertEqual(len(saved["multi_subtitle"]["tracks"]), 1)
            self.assertEqual(saved["multi_subtitle"]["tracks"][0]["id"], "translation-zh")
            self.assertEqual(saved["multi_subtitle"]["tracks"][0]["segments"][0]["text"], "今天天气很好。")
            self.assertEqual(saved["multi_subtitle"]["bindings"][0]["id"], "old-binding")
            self.assertEqual(saved["multi_subtitle"]["bindings"][0]["main_segment_ids"], ["source"])
            html = artifact.comparison_path.read_text(encoding="utf-8")
            data = json.loads(html.split('<script id="comparison-data" type="application/json">', 1)[1].split('</script>', 1)[0])
            packet = json.loads(data["translationReview"]["snapshot"])
            self.assertEqual(packet["mode"], "tracks")
            self.assertEqual(packet["translationTrackId"], "translation-zh")
            self.assertEqual(packet["entries"][0]["targetId"], "translation-zh-segment-001")
            self.assertEqual(packet["result"]["segments"], source["segments"])
            self.assertEqual(data["after"], "今天天气很好。")
            self.assertEqual(read_project(path), original)

    def existing_source(self, count=3):
        source = self.source("今日はいい天気ですね。")
        source["segments"][0]["color"] = {"name": "自定义", "value": "#3366ff"}
        source["multi_subtitle"] = {
            "enabled": True, "tracks": [{"id": "fixed-secondary", "name": "自定义译文", "presentation": {"color": "#abcdef"},
                "segments": [{"id": f"old-{i}", "start": i * 1200, "end": i * 1200 + 1000, "text": f"旧译文{i}"} for i in range(count)]}],
            "bindings": [{"id": "old-binding", "track_id": "fixed-secondary", "main_segment_ids": ["source"],
                          "extension_segment_ids": ["old-0"], "start_offset_ms": 0, "end_offset_ms": 0}],
        }
        return normalize_project(source)

    def test_retranslation_reads_main_and_overwrites_all_old_rows_without_adding_tracks(self):
        for old_count in (1, 3):
            with self.subTest(old_count=old_count), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source = self.existing_source(old_count)
                if old_count == 1:
                    source["segments"].append({"id": "source-2", "start": 1200, "end": 2200, "text": "次の文章です。"})
                source = normalize_project(source)
                path = root / "input.translate-zh-bilingual.mosp"
                path.write_text(json.dumps(source, ensure_ascii=False), encoding="utf-8")
                for translation in ("新译文", "再次翻译"):
                    requested = []
                    def complete(_prompt, cues):
                        requested.extend(row["text"] for row in cues)
                        return {"groups": [{"id": row["id"], "text": translation + row["id"]} for row in cues]}
                    result = run_llm_postprocess(LlmPostprocessRequest(path, None, OutputMode.BOTH, "translate_zh", "", merge_bilingual=True), complete=complete)
                    saved = read_project(result.project_path)
                    self.assertEqual(requested, [s["text"] for s in source["segments"]])
                    self.assertEqual(saved["segments"], source["segments"])
                    multi = saved["multi_subtitle"]
                    self.assertEqual(len(multi["tracks"]), 1)
                    track = multi["tracks"][0]
                    self.assertEqual(track["id"], "fixed-secondary")
                    self.assertEqual(track["presentation"], {"color": "#abcdef"})
                    self.assertEqual(len(track["segments"]), len(source["segments"]))
                    self.assertTrue(all(s["text"].startswith(translation) for s in track["segments"]))
                    self.assertEqual(multi["bindings"][0]["id"], "old-binding")
                    self.assertEqual(read_project(path)["segments"], source["segments"])
                    path = result.project_path

    def test_failed_incomplete_and_cancelled_translations_leave_existing_track_untouched(self):
        for failure in ("network", "incomplete", "cancelled", "before-commit", "partial-network"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source = self.existing_source()
                if failure == "partial-network":
                    source["segments"].append({"id": "source-2", "start": 1200, "end": 2200, "text": "次の文章です。"})
                path = root / "input.mosp"
                path.write_text(json.dumps(source, ensure_ascii=False), encoding="utf-8")
                before = path.read_bytes()
                calls = 0
                def complete(_prompt, cues):
                    nonlocal calls
                    calls += 1
                    if failure in ("network", "cancelled") or failure == "partial-network" and calls == 2:
                        raise LlmClientError("fixture", category="network" if failure == "partial-network" else failure)
                    return {"groups": [] if failure == "incomplete" else [{"id": row["id"], "text": "新译文"} for row in cues]}
                with patch("maw.postprocess.MAX_LLM_CUES_PER_REQUEST", 1):
                    with self.assertRaises((ValueError, LlmClientError, PostprocessStepError)):
                        run_llm_postprocess(LlmPostprocessRequest(path, None, OutputMode.BOTH, "translate_zh", ""),
                            complete=complete, begin_commit=(lambda: False) if failure == "before-commit" else None)
                self.assertEqual(path.read_bytes(), before)
                self.assertEqual(list(root.glob("*.mosp")), [path])

    def test_pipeline_failure_and_cancel_keep_old_secondary_in_source_and_snapshots(self):
        for cancelled in (False, True):
            with self.subTest(cancelled=cancelled), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source = self.existing_source()
                project, srt, media = root / "input.mosp", root / "input.srt", root / "media.mp3"
                project.write_text(json.dumps(source, ensure_ascii=False), encoding="utf-8")
                srt.write_text("1\n00:00:00,000 --> 00:00:01,000\n原文\n", encoding="utf-8")
                media.write_bytes(b"fixture")
                event = Event()
                plan = default_postprocess_plan()
                plan.update(enabled=True, retainIntermediate=True, steps=[{"id": "translate", "enabled": True, "target": "zh", "providerId": "deepseek"}])
                def complete(*_args):
                    if cancelled:
                        event.set()
                    raise LlmClientError("fixture", category="network")
                with patch("maw.output_naming.subfolder_prefs", return_value=(False, False)), patch("maw.postprocess_pipeline.complete_subtitle_groups", side_effect=complete):
                    def run():
                        return run_postprocess_pipeline(plan, media_path=media, project_path=project, srt_path=srt,
                            env_path=root / "unused.env", ffmpeg_path=None, cancel_event=event,
                            llm_settings={"deepseek": {"apiKey": "fixture", "baseUrl": "https://example.test", "model": "fixture", "verified": "1"}})
                    if cancelled:
                        with self.assertRaises(PostprocessCancelled):
                            run()
                    else:
                        result = run()
                        self.assertEqual(result.skipped_steps, ("translate",))
                        self.assertEqual(read_project(result.project_path)["multi_subtitle"], source["multi_subtitle"])
                self.assertEqual(read_project(project)["multi_subtitle"], source["multi_subtitle"])
