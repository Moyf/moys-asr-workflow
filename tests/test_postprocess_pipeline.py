from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from threading import Event
from unittest import mock

from maw.gui_web import LauncherApi, LauncherPaths, _request_from_payload
from maw.postprocess_io import SubtitleArtifact
from maw.postprocess_pipeline import (
    PostprocessCancelled,
    PostprocessPipelineError,
    default_postprocess_plan,
    is_llm_verified,
    load_postprocess_config,
    record_llm_verification,
    run_postprocess_pipeline,
    save_postprocess_plan,
    snapshot_postprocess_llm_settings,
    _publish_final,
    _attach_translation_track,
    validate_plan,
)


class PostprocessPipelineTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.env_path = self.root / ".env"
        self.media = self.root / "clip.mp3"
        self.media.write_bytes(b"audio")
        self.project = self.root / "clip.mosp"
        self.srt = self.root / "clip.srt"
        project = {"segments": [{"start": 0, "end": 1000, "text": "错字"}, {"start": 1100, "end": 2000, "text": "保留"}]}
        self.project.write_text(json.dumps(project, ensure_ascii=False), encoding="utf-8")
        self.srt.write_text(
            "1\n00:00:00,000 --> 00:00:01,000\n错字\n\n2\n00:00:01,100 --> 00:00:02,000\n保留\n",
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def plan(self, *steps: dict[str, object], retain: bool = False) -> dict[str, object]:
        plan = default_postprocess_plan()
        plan["enabled"] = True
        plan["retainIntermediate"] = retain
        plan["steps"] = list(steps)
        return plan

    def replace_step(self, enabled: bool = True) -> dict[str, object]:
        return {"id": "replace", "enabled": enabled, "replacements": [{"source": "错", "target": "正"}]}

    def match_step(self, enabled: bool = True) -> dict[str, object]:
        script = self.root / "script.txt"
        script.write_text("正字\n保留\n", encoding="utf-8")
        return {"id": "match", "enabled": enabled, "scriptPath": str(script)}

    def test_default_plan_is_disabled_and_ordered(self) -> None:
        plan = default_postprocess_plan()

        self.assertFalse(plan["enabled"])
        self.assertFalse(plan["retainIntermediate"])
        self.assertEqual([step["id"] for step in plan["steps"]], ["match", "replace", "proofread", "resegment", "ocr", "translate"])

    def test_translation_keeps_main_track_and_adds_extension_track(self) -> None:
        source_payload = {
            "segments": [
                {"id": "main-001", "start": 0, "end": 1000, "text": "原文一", "items": [{"text": "原文一", "start": 0, "end": 1000}]},
                {"id": "main-002", "start": 1100, "end": 2000, "text": "原文二"},
            ],
        }
        translated_payload = {
            "segments": [
                {"id": "main-001", "start": 0, "end": 1000, "text": "Translation one"},
                {"id": "main-002", "start": 1100, "end": 2000, "text": "Translation two"},
            ],
        }
        self.project.write_text(json.dumps(source_payload, ensure_ascii=False), encoding="utf-8")
        translated_project = self.root / "translated.mosp"
        translated_srt = self.root / "translated.srt"
        translated_project.write_text(json.dumps(translated_payload, ensure_ascii=False), encoding="utf-8")
        translated_srt.write_text(
            "1\n00:00:00,000 --> 00:00:01,000\nTranslation one\n\n2\n00:00:01,100 --> 00:00:02,000\nTranslation two\n",
            encoding="utf-8",
        )

        result = _attach_translation_track(
            source_project_path=self.project,
            source_srt_path=self.srt,
            translated_artifact=SubtitleArtifact(self.project, self.srt, translated_project, translated_srt),
            target="en",
            output_directory=self.root / "run",
        )
        combined = json.loads(result.project_path.read_text(encoding="utf-8"))

        self.assertEqual([segment["text"] for segment in combined["segments"]], ["原文一", "原文二"])
        self.assertEqual(combined["segments"][0]["items"][0]["text"], "原文一")
        self.assertTrue(combined["multi_subtitle"]["enabled"])
        track = combined["multi_subtitle"]["tracks"][0]
        self.assertEqual(track["language"], "en")
        self.assertEqual([segment["text"] for segment in track["segments"]], ["Translation one", "Translation two"])
        self.assertEqual(len(combined["multi_subtitle"]["bindings"]), 2)
        self.assertIn("原文一", result.srt_path.read_text(encoding="utf-8"))
        self.assertNotIn("Translation one", result.srt_path.read_text(encoding="utf-8"))
        self.assertEqual(result.translated_srt_path.read_text(encoding="utf-8").count("Translation"), 2)

        final_project, final_srt, final_translated_srt = _publish_final(
            self.project,
            self.srt,
            result.project_path,
            result.srt_path,
            translated_srt=result.translated_srt_path,
            translation_target="en",
        )
        self.assertEqual(final_project.name, "clip.postprocess.mosp")
        self.assertEqual(final_srt.name, "clip.postprocess.srt")
        self.assertEqual(final_translated_srt.name, "clip.postprocess.translate-en.srt")
        self.assertIn("Translation one", final_translated_srt.read_text(encoding="utf-8"))

    def test_validation_requires_a_step_and_checks_ocr_dependencies(self) -> None:
        empty_plan = default_postprocess_plan()
        empty_plan["enabled"] = True
        _, empty_errors = validate_plan(empty_plan, env_path=self.env_path, media_path=self.media, ffmpeg_path=None)
        self.assertEqual(empty_errors[0]["field"], "autoPostprocessEnabled")

        ocr = {"id": "ocr", "enabled": True, "videoPath": str(self.root / "clip.mp4"), "regionMode": "custom", "regionX1": 80, "regionY1": 0, "regionX2": 20, "regionY2": 100, "threshold": 0.5}
        _, errors = validate_plan(self.plan(ocr), env_path=self.env_path, media_path=self.media, ffmpeg_path=None)
        fields = [error["field"] for error in errors]
        self.assertEqual(fields[0], "ocrVideoPath")
        self.assertIn("ocrRegionX2", fields)
        self.assertIn("ocrVideoPath", fields)

    def test_llm_verification_is_fingerprinted_without_storing_key(self) -> None:
        self.env_path.write_text(
            "MAW_POSTPROCESS_CUSTOM_API_KEY=sk-private\n"
            "MAW_POSTPROCESS_CUSTOM_BASE_URL=https://example.test/v1\n"
            "MAW_POSTPROCESS_CUSTOM_MODEL=demo\n",
            encoding="utf-8",
        )
        self.assertFalse(is_llm_verified(self.env_path, "custom"))
        record_llm_verification(self.env_path, "custom")
        self.assertTrue(is_llm_verified(self.env_path, "custom"))
        config_text = (self.root / "maw-postprocess.json").read_text(encoding="utf-8")
        self.assertNotIn("sk-private", config_text)
        self.assertNotIn("https://example.test", config_text)
        self.assertIn("verification", config_text)

        self.env_path.write_text(
            "MAW_POSTPROCESS_CUSTOM_API_KEY=sk-new\n"
            "MAW_POSTPROCESS_CUSTOM_BASE_URL=https://example.test/v1\n"
            "MAW_POSTPROCESS_CUSTOM_MODEL=demo\n",
            encoding="utf-8",
        )
        self.assertFalse(is_llm_verified(self.env_path, "custom"))

    def test_save_plan_keeps_only_versioned_plan_and_verification(self) -> None:
        plan = save_postprocess_plan(self.env_path, self.plan(self.replace_step()))
        config = load_postprocess_config(self.root / "maw-postprocess.json")

        self.assertEqual(plan["version"], 1)
        self.assertTrue(config["plan"]["enabled"])
        self.assertNotIn("apiKey", json.dumps(config, ensure_ascii=False))

    def test_llm_run_snapshot_is_immutable_and_contains_no_plan_secret(self) -> None:
        self.env_path.write_text(
            "MAW_POSTPROCESS_CUSTOM_API_KEY=sk-private\n"
            "MAW_POSTPROCESS_CUSTOM_BASE_URL=https://example.test/v1\n"
            "MAW_POSTPROCESS_CUSTOM_MODEL=demo\n",
            encoding="utf-8",
        )
        record_llm_verification(self.env_path, "custom")
        plan = self.plan({"id": "proofread", "enabled": True, "providerId": "custom"})

        snapshot = snapshot_postprocess_llm_settings(self.env_path, plan)
        self.assertEqual(snapshot["custom"]["apiKey"], "sk-private")
        self.assertEqual(snapshot["custom"]["baseUrl"], "https://example.test/v1")
        self.assertEqual(snapshot["custom"]["model"], "demo")
        self.assertEqual(snapshot["custom"]["verified"], "1")

        self.env_path.write_text(
            "MAW_POSTPROCESS_CUSTOM_API_KEY=sk-changed\n"
            "MAW_POSTPROCESS_CUSTOM_BASE_URL=https://changed.test/v1\n"
            "MAW_POSTPROCESS_CUSTOM_MODEL=changed\n",
            encoding="utf-8",
        )
        _normalized, errors = validate_plan(
            plan,
            env_path=self.env_path,
            media_path=self.media,
            ffmpeg_path=None,
            llm_settings=snapshot,
        )
        self.assertEqual(errors, ())
        self.assertNotIn("apiKey", json.dumps(plan, ensure_ascii=False))

    def test_pipeline_publishes_final_and_removes_successful_workspace_by_default(self) -> None:
        events: list[dict[str, object]] = []
        result = run_postprocess_pipeline(
            self.plan(self.replace_step()),
            media_path=self.media,
            project_path=self.project,
            srt_path=self.srt,
            env_path=self.env_path,
            ffmpeg_path=None,
            cancel_event=Event(),
            on_event=events.append,
        )

        self.assertTrue(result.project_path.is_file())
        self.assertTrue(result.srt_path.is_file())
        self.assertIsNone(result.translated_srt_path)
        self.assertFalse(result.run_directory.exists())
        self.assertIn('"text": "错字"', self.project.read_text(encoding="utf-8"))
        self.assertIn("正字", result.srt_path.read_text(encoding="utf-8"))
        self.assertEqual([event["stage"] for event in events if event["stage"] in {"step_start", "step_done"}], ["step_start", "step_done"])

    def test_pipeline_retains_workspace_and_can_resume_after_failure(self) -> None:
        plan = self.plan(self.replace_step(), self.match_step(), retain=True)
        original_replace = __import__("maw.postprocess_pipeline", fromlist=["run_fixed_replacement"]).run_fixed_replacement
        with mock.patch("maw.postprocess_pipeline.run_fixed_replacement", side_effect=RuntimeError("mock replace failure")):
            with self.assertRaises(PostprocessPipelineError) as raised:
                run_postprocess_pipeline(
                    plan,
                    media_path=self.media,
                    project_path=self.project,
                    srt_path=self.srt,
                    env_path=self.env_path,
                    ffmpeg_path=None,
                    cancel_event=Event(),
                )
        error = raised.exception
        self.assertEqual(error.failed_index, 1, str(error))
        self.assertTrue(error.run_directory.is_dir())
        self.assertTrue(error.current_project.is_file())

        with mock.patch("maw.postprocess_pipeline.run_fixed_replacement", side_effect=original_replace):
            result = run_postprocess_pipeline(
                plan,
                media_path=self.media,
                project_path=self.project,
                srt_path=self.srt,
                env_path=self.env_path,
                ffmpeg_path=None,
                cancel_event=Event(),
                resume_directory=error.run_directory,
                resume_from=error.failed_index,
                resume_project_path=error.current_project,
                resume_srt_path=error.current_srt,
            )
        self.assertTrue(result.run_directory.is_dir())
        self.assertTrue(result.project_path.is_file())
        self.assertIn("正字", result.srt_path.read_text(encoding="utf-8"))

    def test_pipeline_keeps_workspace_when_cancelled(self) -> None:
        cancel = Event()
        cancel.set()
        with self.assertRaises(PostprocessCancelled):
            run_postprocess_pipeline(
                self.plan(self.replace_step()),
                media_path=self.media,
                project_path=self.project,
                srt_path=self.srt,
                env_path=self.env_path,
                ffmpeg_path=None,
                cancel_event=cancel,
            )
        workspace = self.root / "MAW-Postprocess"
        self.assertTrue(workspace.is_dir())
        self.assertEqual(len(tuple(workspace.iterdir())), 1)


class PostprocessPreflightTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.env_path = self.root / ".env"
        self.media = self.root / "clip.mp3"
        self.media.write_bytes(b"audio")
        self.paths = LauncherPaths(root=self.root, env_path=self.env_path, launcher_html=self.root / "launcher.html")
        self.api = LauncherApi(paths=self.paths, window_getter=lambda: None)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_preflight_returns_step_for_frontend_focus(self) -> None:
        plan = default_postprocess_plan()
        plan["enabled"] = True
        plan["steps"] = [{"id": "match", "enabled": True, "scriptPath": str(self.root / "missing.txt")}]

        result = self.api.start_transcription({
            "providerId": "qwen",
            "modelId": "qwen-audio-3.0-asr-flash-filetrans",
            "apiKey": "sk-asr",
            "mediaPath": str(self.media),
            "srtPath": str(self.root / "out.srt"),
            "autoPostprocess": plan,
        })

        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "postprocess_config_invalid")
        self.assertEqual(result["postprocessStep"], "match")
        self.assertEqual(result["field"], "postprocessScriptPath")

    def test_saved_llm_settings_are_verified_only_after_a_real_connection_check(self) -> None:
        with mock.patch("maw.gui_web.test_llm_connection") as check_connection:
            saved = self.api.save_postprocess_settings({
                "providerId": "custom",
                "apiKey": "sk-private",
                "baseUrl": "https://example.test/v1",
                "model": "demo",
            })
            self.assertFalse(saved["verified"])
            checked = self.api.test_postprocess_connection({
                "providerId": "custom",
                "apiKey": "sk-private",
                "baseUrl": "https://example.test/v1",
                "model": "demo",
            })

        self.assertTrue(checked["ok"])
        self.assertTrue(checked["verified"])
        check_connection.assert_called_once()
        config_text = (self.root / "maw-postprocess.json").read_text(encoding="utf-8")
        self.assertNotIn("sk-private", config_text)
        self.assertNotIn("example.test", config_text)

    def test_preflight_keeps_valid_auto_plan_in_request(self) -> None:
        script = self.root / "script.txt"
        script.write_text("字幕", encoding="utf-8")
        plan = default_postprocess_plan()
        plan["enabled"] = True
        plan["steps"] = [{"id": "match", "enabled": True, "scriptPath": str(script)}]

        request = _request_from_payload({
            "providerId": "qwen",
            "modelId": "qwen-audio-3.0-asr-flash-filetrans",
            "apiKey": "sk-asr",
            "mediaPath": str(self.media),
            "srtPath": str(self.root / "out.srt"),
            "autoPostprocess": plan,
        }, self.env_path)

        self.assertIsNotNone(request.postprocess_plan)
        self.assertEqual(request.postprocess_plan["steps"][0]["id"], "match")
