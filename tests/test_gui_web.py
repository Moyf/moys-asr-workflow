# pyright: reportAny=false, reportArgumentType=false, reportAttributeAccessIssue=false, reportImplicitOverride=false, reportIndexIssue=false, reportPrivateUsage=false, reportUnannotatedClassAttribute=false, reportUninitializedInstanceVariable=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnusedCallResult=false, reportUnusedParameter=false

from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import final
from unittest import mock
from urllib.error import URLError


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from maw.gui_web import EventPump, LauncherApi, LauncherPaths, PreflightError, SERVER_START_TIMEOUT, _emoji_font_urls, _find_mose_executable, _is_ffmpeg_start_failure, _is_ffprobe_start_failure, _port, _register_mosp_association, _request_from_payload, _route_dropped_path, _valid_emoji_font, default_paths, download_emoji_font, run_app  # noqa: E402
from maw.gui_workflow import TranscriptionProcessError, TranscriptionRequest, TranscriptionResult  # noqa: E402
from maw.local_models import LocalModelStatus  # noqa: E402


class FakeWindow:
    def __init__(self) -> None:
        self.scripts: list[str] = []

    def evaluate_js(self, script: str) -> None:
        self.scripts.append(script)


@final
class GuiWebBridgeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.env_path = self.root / ".env"
        self.example_path = self.root / ".env.example"
        _ = self.example_path.write_text("DASHSCOPE_API_KEY=\nDASHSCOPE_REGION=beijing\n", encoding="utf-8")
        self.paths = LauncherPaths(root=self.root, env_path=self.env_path, launcher_html=self.root / "launcher.html")
        self.window = FakeWindow()
        self.api = LauncherApi(paths=self.paths, window_getter=lambda: self.window)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_get_config_returns_registry_and_masked_key_when_env_exists(self) -> None:
        """Given local config, When JS asks for config, Then secrets are masked and registries return."""
        _ = self.env_path.write_text("DASHSCOPE_API_KEY=sk-secret-abcd\nDASHSCOPE_REGION=singapore\nMAW_GUI_LANG=en\n", encoding="utf-8")

        config = self.api.get_config()

        self.assertEqual(config["apiKey"], "sk-secret-abcd")
        self.assertEqual(config["maskedApiKey"], "sk-…abcd")
        self.assertEqual(config["region"], "singapore")
        self.assertEqual(config["guiLang"], "en")
        self.assertEqual(config["providerId"], "qwen")
        self.assertEqual(config["modelId"], "qwen-audio-3.0-asr-flash-filetrans")
        self.assertIsNone(config["lastModel"])
        self.assertIsNone(config["lastLanguage"])
        self.assertEqual(config["stickerDir"], "")
        self.assertIn(config["localRuntime"]["status"], {"missing", "broken", "ready"})
        self.assertIn(config["ocrRuntime"]["status"], {"missing", "broken", "ready"})
        self.assertEqual([model["id"] for model in config["ocrModels"]], ["pp-ocrv6-tiny", "pp-ocrv6-small"])
        self.assertEqual(config["providers"][0]["keyUrl"], "https://help.aliyun.com/zh/model-studio/get-api-key")
        self.assertEqual(len(config["providers"][0]["commonLanguages"]), 10)
        self.assertEqual(len(config["providers"][1]["commonLanguages"]), 8)
        self.assertEqual(config["models"][0]["id"], "qwen-audio-3.0-asr-flash-filetrans")
        self.assertEqual(config["models"][1]["id"], "fun-asr")
        self.assertEqual(config["models"][2]["id"], "qwen3-asr-flash-filetrans")
        self.assertTrue(config["models"][0]["supportsSpeaker"])
        self.assertTrue(config["models"][0]["supportsContext"])
        self.assertTrue(config["models"][0]["supportsHotwords"])
        self.assertTrue(config["models"][0]["supportsVocabulary"])
        self.assertEqual(config["models"][0]["languages"][0]["id"], "")
        self.assertFalse(config["models"][2]["supportsSpeaker"])
        self.assertEqual(config["languages"][0]["id"], "")

    def test_get_config_exposes_local_provider_and_runtime_status(self) -> None:
        config = self.api.get_config()

        local = next(provider for provider in config["providers"] if provider["id"] == "local")
        self.assertFalse(local["requiresApiKey"])
        self.assertEqual(local["kind"], "local")
        self.assertEqual(local["models"][0]["id"], "qwen3-asr-local")
        self.assertEqual(local["models"][1]["id"], "qwen3-asr-1.7b-local")
        self.assertEqual(local["models"][2]["id"], "fun-asr-nano-local")
        self.assertEqual(local["models"][3]["id"], "funasr-local")
        self.assertEqual(local["models"][4]["modelRef"], "iic/SenseVoiceSmall")
        self.assertIn(local["models"][0]["localStatus"]["status"], {"runtime_missing", "missing", "installed", "partial", "path_invalid", "broken"})
        self.assertEqual(config["modelCacheRoot"], "")

    def test_save_settings_accepts_custom_model_cache_root(self) -> None:
        cache_root = self.root / "models"

        result = self.api.save_settings({"modelCacheRoot": str(cache_root)})

        self.assertTrue(result["ok"])
        self.assertEqual(result["modelCacheRoot"], str(cache_root.resolve()))
        self.assertEqual(self.api.get_config()["modelCacheRoot"], str(cache_root.resolve()))
        self.assertIn(f"MAW_MODEL_CACHE_ROOT={cache_root.resolve()}", self.env_path.read_text(encoding="utf-8"))

    def test_ocr_settings_save_runtime_path_and_report_status(self) -> None:
        runtime_root = self.root / "ocr-runtime"

        result = self.api.save_ocr_settings({"runtimePath": str(runtime_root)})

        self.assertTrue(result["ok"])
        self.assertEqual(result["runtimePath"], str(runtime_root.resolve()))
        self.assertIn(f"MAW_OCR_RUNTIME_ROOT={runtime_root.resolve()}", self.env_path.read_text(encoding="utf-8"))
        self.assertEqual(self.api.get_ocr_runtime()["path"], str(runtime_root.resolve()))

    def test_ocr_settings_reject_file_runtime_path(self) -> None:
        runtime_file = self.root / "ocr-runtime.txt"
        runtime_file.write_text("not a directory", encoding="utf-8")

        result = self.api.save_ocr_settings({"runtimePath": str(runtime_file)})

        self.assertFalse(result["ok"])
        self.assertEqual(result["field"], "ocrRuntimePath")
        self.assertEqual(result["code"], "ocr_runtime_path_invalid")

    def test_save_settings_rejects_file_as_model_cache_root(self) -> None:
        cache_file = self.root / "models.txt"
        cache_file.write_text("not a directory", encoding="utf-8")

        result = self.api.save_settings({"modelCacheRoot": str(cache_file)})

        self.assertFalse(result["ok"])
        self.assertEqual(result["field"], "localModelCachePath")
        self.assertEqual(result["code"], "model_cache_path_invalid")

    def test_save_settings_for_local_provider_does_not_write_a_fake_api_key(self) -> None:
        result = self.api.save_settings({"providerId": "local", "modelId": "qwen3-asr-local", "apiKey": "", "guiLang": "zh"})

        self.assertTrue(result["ok"])
        self.assertEqual(result["maskedApiKey"], "")
        self.assertIn("DASHSCOPE_API_KEY=\n", self.env_path.read_text(encoding="utf-8"))

    def test_save_settings_writes_env_without_echoing_key(self) -> None:
        """Given form values, When saved, Then .env is updated and response masks the key."""
        result = self.api.save_settings({
            "modelId": "qwen3-asr-flash-filetrans",
            "apiKey": "sk-super-secret-9999",
            "region": "singapore",
            "language": "zh",
            "workspaceId": "ws-1",
            "guiLang": "en",
        })

        text = self.env_path.read_text(encoding="utf-8")
        self.assertIn("DASHSCOPE_API_KEY=sk-super-secret-9999", text)
        self.assertIn("DASHSCOPE_WORKSPACE_ID=ws-1", text)
        self.assertEqual(result["maskedApiKey"], "sk-…9999")
        self.assertNotIn("super-secret", result["message"])

    def test_save_prefs_writes_only_gui_memory_keys(self) -> None:
        self.env_path.write_text("# keep\nDASHSCOPE_REGION=beijing\nSTICKER_DIR=stickers\n", encoding="utf-8")

        result = self.api.save_prefs({"modelId": "stt-async-v5", "language": ""})

        self.assertTrue(result["ok"])
        self.assertEqual(
            self.env_path.read_text(encoding="utf-8"),
            "# keep\nDASHSCOPE_REGION=beijing\nSTICKER_DIR=stickers\nMAW_GUI_LAST_MODEL=stt-async-v5\nMAW_GUI_LAST_LANGUAGE=\n",
        )

    def test_postprocess_config_masks_keys_and_saves_provider_settings(self) -> None:
        self.env_path.write_text(
            "MAW_POSTPROCESS_DEEPSEEK_API_KEY=sk-deepseek-secret\n"
            "MAW_POSTPROCESS_DEEPSEEK_MODEL=deepseek-reasoner\n",
            encoding="utf-8",
        )

        config = self.api.get_config()
        result = self.api.save_postprocess_settings({
            "providerId": "qwen",
            "apiKey": "sk-qwen-private",
            "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
            "model": "qwen-plus",
            "reasoningMode": "medium",
        })

        raw_providers = config["postprocessProviders"]
        if not isinstance(raw_providers, list):
            self.fail("postprocessProviders must be a list")
        providers = {provider["id"]: provider for provider in raw_providers if isinstance(provider, dict)}
        self.assertEqual(providers["deepseek"]["maskedApiKey"], "sk-…cret")
        self.assertNotIn("apiKey", providers["deepseek"])
        self.assertEqual(providers["deepseek"]["model"], "deepseek-reasoner")
        self.assertEqual(result["maskedApiKey"], "sk-…vate")
        self.assertNotIn("qwen-private", str(result))
        self.assertIn("MAW_POSTPROCESS_QWEN_API_KEY=sk-qwen-private", self.env_path.read_text(encoding="utf-8"))
        self.assertIn("MAW_POSTPROCESS_QWEN_REASONING_MODE=medium", self.env_path.read_text(encoding="utf-8"))
        self.assertEqual(result["reasoningMode"], "medium")
        self.assertEqual(providers["deepseek"]["reasoningMode"], "off")

    def test_qwen_postprocess_reuses_dashscope_api_key(self) -> None:
        self.env_path.write_text("DASHSCOPE_API_KEY=sk-dashscope-shared\n", encoding="utf-8")

        with mock.patch.dict(os.environ, {"DASHSCOPE_API_KEY": ""}, clear=False):
            config = self.api.get_config()
            providers = {item["id"]: item for item in config["postprocessProviders"]}
            self.assertEqual(providers["qwen"]["maskedApiKey"], "sk-…ared")
            self.assertTrue(providers["qwen"]["hasApiKey"])

            with mock.patch("maw.gui_web.test_llm_connection") as check_connection:
                result = self.api.test_postprocess_connection({
                    "providerId": "qwen",
                    "apiKey": "",
                    "baseUrl": "",
                    "model": "",
                })

        self.assertTrue(result["ok"])
        settings = check_connection.call_args.args[0]
        self.assertEqual(settings.api_key, "sk-dashscope-shared")

    def test_postprocess_settings_keep_saved_key_when_key_field_is_blank(self) -> None:
        self.env_path.write_text(
            "MAW_POSTPROCESS_DEEPSEEK_API_KEY=sk-keep-this-key\n"
            "MAW_POSTPROCESS_DEEPSEEK_MODEL=deepseek-chat\n",
            encoding="utf-8",
        )

        result = self.api.save_postprocess_settings({
            "providerId": "deepseek",
            "apiKey": "",
            "baseUrl": "https://api.deepseek.com/v1",
            "model": "deepseek-reasoner",
        })

        saved = self.env_path.read_text(encoding="utf-8")
        self.assertTrue(result["ok"])
        self.assertIn("MAW_POSTPROCESS_DEEPSEEK_API_KEY=sk-keep-this-key", saved)
        self.assertIn("MAW_POSTPROCESS_DEEPSEEK_MODEL=deepseek-reasoner", saved)
        self.assertEqual(result["maskedApiKey"], "sk-…-key")

    def test_postprocess_provider_presets_include_zhipu_coding_plan(self) -> None:
        config = self.api.get_config()
        raw_providers = config["postprocessProviders"]
        if not isinstance(raw_providers, list):
            self.fail("postprocessProviders must be a list")
        providers = {provider["id"]: provider for provider in raw_providers if isinstance(provider, dict)}

        self.assertEqual(providers["deepseek"]["model"], "deepseek-v4-flash")
        self.assertEqual(providers["zhipu"]["label"], "智谱 Coding Plan")
        self.assertEqual(providers["zhipu"]["baseUrl"], "https://open.bigmodel.cn/api/coding/paas/v4")
        self.assertEqual(providers["zhipu"]["model"], "glm-5.2")

        result = self.api.save_postprocess_settings({
            "providerId": "zhipu",
            "apiKey": "sk-zhipu-private",
            "baseUrl": "https://open.bigmodel.cn/api/coding/paas/v4",
            "model": "glm-5.2",
        })
        self.assertTrue(result["ok"])
        self.assertNotIn("zhipu-private", str(result))
        self.assertIn("MAW_POSTPROCESS_ZHIPU_API_KEY=sk-zhipu-private", self.env_path.read_text(encoding="utf-8"))

    def test_postprocess_settings_return_field_error_for_injected_line_separator(self) -> None:
        result = self.api.save_postprocess_settings({
            "providerId": "custom",
            "apiKey": "sk-safe",
            "baseUrl": "https://example.com/v1",
            "model": "safe\u2028FFMPEG_PATH=payload",
        })

        self.assertFalse(result["ok"])
        self.assertEqual(result["field"], "postprocessModel")
        self.assertEqual(result["code"], "config_save_failed")
        self.assertFalse(self.env_path.exists())

    def test_postprocess_settings_reject_invalid_reasoning_mode(self) -> None:
        result = self.api.save_postprocess_settings({
            "providerId": "deepseek",
            "apiKey": "sk-safe",
            "baseUrl": "https://api.deepseek.com",
            "model": "deepseek-v4-flash",
            "reasoningMode": "maximum",
        })

        self.assertFalse(result["ok"])
        self.assertEqual(result["field"], "postprocessReasoningMode")
        self.assertEqual(result["code"], "invalid_reasoning_mode")
        self.assertFalse(self.env_path.exists())

    def test_custom_postprocess_display_name_is_saved_and_returned(self) -> None:
        result = self.api.save_postprocess_settings({
            "providerId": "custom",
            "apiKey": "sk-custom",
            "baseUrl": "https://example.com/v1",
            "model": "custom-model",
            "displayName": "本地模型",
        })

        self.assertTrue(result["ok"])
        self.assertEqual(result["label"], "本地模型")
        self.assertIn("MAW_POSTPROCESS_CUSTOM_DISPLAY_NAME=本地模型", self.env_path.read_text(encoding="utf-8"))
        providers = {item["id"]: item for item in self.api.get_config()["postprocessProviders"]}
        self.assertEqual(providers["custom"]["label"], "本地模型")
        self.assertEqual(providers["custom"]["displayName"], "本地模型")

    def test_postprocess_connection_uses_form_values_without_writing_config(self) -> None:
        with mock.patch("maw.gui_web.test_llm_connection") as check_connection:
            result = self.api.test_postprocess_connection({
                "providerId": "custom",
                "apiKey": "sk-entered",
                "baseUrl": "https://example.com/v1",
                "model": "custom-model",
            })

        self.assertTrue(result["ok"])
        settings = check_connection.call_args.args[0]
        self.assertEqual(settings.provider_id, "custom")
        self.assertEqual(settings.api_key, "sk-entered")
        self.assertEqual(settings.base_url, "https://example.com/v1")
        self.assertEqual(settings.model, "custom-model")
        self.assertFalse(self.env_path.exists())

    def test_postprocess_models_use_form_values_without_writing_config(self) -> None:
        with mock.patch("maw.gui_web.list_llm_models", return_value=["model-a", "model-b"]) as list_models:
            result = self.api.get_postprocess_models({
                "providerId": "custom",
                "apiKey": "sk-entered",
                "baseUrl": "https://example.com/v1",
                "model": "custom-model",
            })

        self.assertTrue(result["ok"])
        self.assertEqual(result["models"], ["model-a", "model-b"])
        settings = list_models.call_args.args[0]
        self.assertEqual(settings.provider_id, "custom")
        self.assertEqual(settings.api_key, "sk-entered")
        self.assertEqual(settings.base_url, "https://example.com/v1")
        self.assertEqual(settings.model, "custom-model")
        self.assertFalse(self.env_path.exists())

    def test_legacy_setting_bridges_return_structured_errors_for_invalid_values(self) -> None:
        settings = self.api.save_settings({
            "providerId": "qwen",
            "modelId": "qwen-audio-3.0-asr-flash-filetrans",
            "apiKey": "safe\x1cFFMPEG_PATH=payload",
        })
        prefs = self.api.save_prefs({"language": "safe\x85FFMPEG_PATH=payload"})
        ffmpeg = self.api.save_ffmpeg_path({"path": "safe\u2029FFMPEG_PATH=payload"})

        for result in (settings, prefs, ffmpeg):
            with self.subTest(result=result):
                self.assertFalse(result["ok"])
                self.assertEqual(result["code"], "config_save_failed")
        self.assertFalse(self.env_path.exists())

    def test_fixed_replacement_bridge_returns_chainable_project_and_srt_paths(self) -> None:
        project = self.root / "clip.mosp"
        project.write_text(
            json.dumps({"segments": [{"start": 0, "end": 1000, "text": "错字"}]}, ensure_ascii=False),
            encoding="utf-8",
        )

        result = self.api.run_fixed_replacement({
            "projectPath": str(project),
            "srtPath": "",
            "outputMode": "both",
            "replacements": [{"source": "错", "target": "正"}],
        })

        self.assertTrue(result["ok"])
        output_project = Path(str(result["projectPath"]))
        output_srt = Path(str(result["srtPath"]))
        self.assertTrue(output_project.is_file())
        self.assertTrue(output_srt.is_file())
        self.assertEqual(json.loads(output_project.read_text(encoding="utf-8"))["segments"][0]["text"], "正字")

    def test_script_match_bridge_returns_chainable_project_and_srt_paths(self) -> None:
        project = self.root / "clip.mosp"
        script = self.root / "script.txt"
        project.write_text(
            json.dumps({"segments": [{"start": 0, "end": 1000, "text": "旧句"}]}, ensure_ascii=False),
            encoding="utf-8",
        )
        script.write_text("旧句。", encoding="utf-8")

        result = self.api.run_script_match({
            "projectPath": str(project),
            "scriptPath": str(script),
            "outputMode": "both",
        })

        self.assertTrue(result["ok"])
        output_project = Path(str(result["projectPath"]))
        output_srt = Path(str(result["srtPath"]))
        self.assertTrue(output_project.is_file())
        self.assertTrue(output_srt.is_file())
        self.assertEqual(json.loads(output_project.read_text(encoding="utf-8"))["segments"][0]["text"], "旧句。")

    def test_ocr_dedup_bridge_forwards_video_region_threshold_and_report(self) -> None:
        project = self.root / "clip.mosp"
        video = self.root / "clip.mp4"
        ffmpeg = self.root / "ffmpeg.exe"
        video.write_bytes(b"video")
        ffmpeg.write_bytes(b"ffmpeg")
        project.write_text(
            json.dumps({"media": str(video), "segments": [{"start": 0, "end": 1000, "text": "字幕"}]}, ensure_ascii=False),
            encoding="utf-8",
        )
        fake = SimpleNamespace(
            source_project_path=project,
            source_srt_path=None,
            project_path=self.root / "clip.ocr-dedup.mosp",
            srt_path=self.root / "clip.ocr-dedup.srt",
            report_path=self.root / "clip.ocr-dedup.csv",
            warnings=("done",),
            newly_disabled_count=1,
            existing_disabled_count=0,
            processed_count=1,
            skipped_count=0,
            failed_count=0,
        )

        runtime = SimpleNamespace(ready=True, path=str(self.root / "ocr-runtime"), detail="")
        with mock.patch("maw.gui_web.managed_ocr_runtime_status", return_value=runtime):
            with mock.patch("maw.gui_web.find_ffmpeg", return_value=ffmpeg) as find_ffmpeg:
                with mock.patch("maw.gui_web.run_ocr_in_runtime", return_value={
                    "sourceProjectPath": str(project),
                    "sourceSrtPath": "",
                    "projectPath": str(fake.project_path),
                    "srtPath": str(fake.srt_path),
                    "reportPath": str(fake.report_path),
                    "warnings": list(fake.warnings),
                    "newlyDisabledCount": fake.newly_disabled_count,
                    "existingDisabledCount": fake.existing_disabled_count,
                    "processedCount": fake.processed_count,
                    "skippedCount": fake.skipped_count,
                    "failedCount": fake.failed_count,
                }) as process:
                    result = self.api.run_ocr_dedup({
                        "projectPath": str(project),
                        "outputMode": "both",
                        "modelId": "pp-ocrv6-small",
                        "videoPath": str(video),
                        "fallbackVideoPath": str(self.root / "current.mp4"),
                        "regionMode": "custom",
                        "regionX1": 5,
                        "regionY1": 60,
                        "regionX2": 95,
                        "regionY2": 100,
                        "threshold": 0,
                        "report": True,
                    })

        self.assertTrue(result["ok"])
        self.assertEqual(result["reportPath"], str(fake.report_path))
        find_ffmpeg.assert_called_once()
        request = process.call_args.args[0]
        self.assertEqual(request.video_path, video)
        self.assertEqual(request.fallback_video_path, self.root / "current.mp4")
        self.assertEqual(request.region.mode, "custom")
        self.assertEqual(request.region.y1, 0.6)
        self.assertEqual(request.threshold, 0.0)
        self.assertTrue(request.report)
        self.assertEqual(process.call_args.kwargs["model_id"], "pp-ocrv6-small")

    def test_llm_bridge_uses_stored_key_without_echoing_it(self) -> None:
        project = self.root / "clip.mosp"
        project.write_text(
            json.dumps({"segments": [{"start": 0, "end": 1000, "text": "待校对"}]}, ensure_ascii=False),
            encoding="utf-8",
        )
        self.env_path.write_text("MAW_POSTPROCESS_DEEPSEEK_API_KEY=sk-stored-secret\n", encoding="utf-8")

        with mock.patch("maw.gui_web.complete_subtitle_groups", return_value={"groups": [{"id": "c0001", "text": "已校对"}]}) as complete:
            result = self.api.run_llm_postprocess({
                "projectPath": str(project),
                "outputMode": "json",
                "operation": "proofread",
                "providerId": "deepseek",
                "apiKey": "",
                "baseUrl": "https://api.deepseek.com",
                "model": "deepseek-chat",
                "reasoningMode": "high",
                "customPrompt": "",
            })

        settings = complete.call_args.args[0]
        self.assertEqual(settings.api_key, "sk-stored-secret")
        self.assertEqual(settings.reasoning_mode, "high")
        self.assertTrue(result["ok"])
        self.assertNotIn("stored-secret", str(result))

    def test_llm_bridge_forwards_stream_deltas_to_event_pump(self) -> None:
        project = self.root / "clip.mosp"
        media = self.root / "clip.mp4"
        media.write_bytes(b"media")
        project.write_text(
            json.dumps({"segments": [{"start": 0, "end": 1000, "text": "待处理"}]}, ensure_ascii=False),
            encoding="utf-8",
        )

        def complete(_settings, _prompt, _cues, *, on_delta):
            on_delta("reset", "")
            on_delta("reasoning", "先检查")
            on_delta("content", '{"groups":[')
            on_delta("content", '{"id":"c0001","text":"完成"}]}')
            return {"groups": [{"id": "c0001", "text": "完成"}]}

        with mock.patch("maw.gui_web.complete_subtitle_groups", side_effect=complete):
            result = self.api.run_llm_postprocess({
                "projectPath": str(project),
                "mediaPath": str(media),
                "outputMode": "json",
                "operation": "proofread",
                "providerId": "deepseek",
                "apiKey": "sk-test",
                "baseUrl": "https://api.deepseek.com",
                "model": "deepseek-chat",
                "reasoningMode": "medium",
                "customPrompt": "",
            })

        self.api.pump.shutdown()
        scripts = "\n".join(self.window.scripts)
        self.assertTrue(result["ok"])
        output_project = Path(str(result["projectPath"]))
        self.assertEqual(json.loads(output_project.read_text(encoding="utf-8"))["media"], str(media.resolve()))
        self.assertIn('"type": "postprocess_stream"', scripts)
        self.assertIn('"kind": "reset"', scripts)
        self.assertIn('"kind": "reasoning"', scripts)
        self.assertIn('"kind": "content"', scripts)

    def test_llm_custom_bridge_rejects_empty_prompt_before_provider_call(self) -> None:
        with mock.patch("maw.gui_web.complete_subtitle_groups") as complete:
            result = self.api.run_llm_postprocess({
                "operation": "custom",
                "providerId": "deepseek",
                "customPrompt": "  \n",
            })

        self.assertFalse(result["ok"])
        self.assertEqual(result["field"], "postprocessPrompt")
        self.assertEqual(result["code"], "custom_prompt_required")
        complete.assert_not_called()

    def test_ffconcat_bridge_uses_configured_ffmpeg_and_returns_new_media_only(self) -> None:
        media = self.root / "clip.mp4"
        concat = self.root / "clip.ffconcat"
        ffmpeg_name = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
        ffprobe_name = "ffprobe.exe" if os.name == "nt" else "ffprobe"
        ffmpeg = self.root / ffmpeg_name
        ffprobe = self.root / ffprobe_name
        _ = media.write_bytes(b"media")
        _ = ffmpeg.write_bytes(b"exe")
        _ = ffprobe.write_bytes(b"exe")
        _ = concat.write_text(f"ffconcat version 1.0\nfile '{media.as_posix()}'\n", encoding="utf-8")
        _ = self.env_path.write_text(f"FFMPEG_PATH={self.root}\n", encoding="utf-8")

        with mock.patch("maw.gui_web.process_ffconcat_rebuild") as rebuild:
            rebuild.return_value = mock.Mock(
                source_media_path=media.resolve(),
                media_path=(self.root / "clip.gap-removed.mp4").resolve(),
                ffconcat_path=concat.resolve(),
            )
            result = self.api.run_ffconcat_rebuild({"mediaPath": str(media), "ffconcatPath": str(concat)})

        self.assertTrue(result["ok"])
        self.assertEqual(rebuild.call_args.kwargs["ffmpeg_path"], ffmpeg.resolve())
        self.assertEqual(result["mediaPath"], str((self.root / "clip.gap-removed.mp4").resolve()))
        self.assertNotIn("projectPath", result)

    def test_ffconcat_bridge_falls_back_to_bundled_ffmpeg(self) -> None:
        media = self.root / "clip.mp4"
        concat = self.root / "clip.ffconcat"
        bundled = self.root / "bundled"
        ffmpeg = bundled / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
        _ = bundled.mkdir()
        _ = media.write_bytes(b"media")
        _ = ffmpeg.write_bytes(b"exe")
        _ = concat.write_text(f"ffconcat version 1.0\nfile '{media.as_posix()}'\n", encoding="utf-8")

        with mock.patch("maw.gui_web.find_ffmpeg", return_value=None):
            with mock.patch("maw.gui_web._bundled_ffmpeg_directory", return_value=bundled):
                with mock.patch("maw.gui_web.process_ffconcat_rebuild") as rebuild:
                    rebuild.return_value = mock.Mock(
                        source_media_path=media.resolve(),
                        media_path=(self.root / "clip.gap-removed.mp4").resolve(),
                        ffconcat_path=concat.resolve(),
                    )
                    result = self.api.run_ffconcat_rebuild({"mediaPath": str(media), "ffconcatPath": str(concat)})

        self.assertTrue(result["ok"])
        self.assertEqual(rebuild.call_args.kwargs["ffmpeg_path"], ffmpeg.resolve())

    def test_get_config_exposes_last_language_empty_vs_absent(self) -> None:
        self.env_path.write_text("MAW_GUI_LAST_MODEL=stt-async-v5\nMAW_GUI_LAST_LANGUAGE=\n", encoding="utf-8")

        remembered = self.api.get_config()
        self.env_path.write_text("DASHSCOPE_DEFAULT_LANGUAGE=zh\n", encoding="utf-8")
        absent = self.api.get_config()

        self.assertEqual(remembered["lastModel"], "stt-async-v5")
        self.assertEqual(remembered["lastLanguage"], "")
        self.assertIsNone(absent["lastLanguage"])
        self.assertEqual(absent["language"], "zh")

    def test_start_server_builds_command_and_returns_localhost_url(self) -> None:
        """Given a project json, When server starts, Then it returns the localhost URL for the launcher link."""
        project = self.root / "project.json"
        media = self.root / "clip.mp4"
        project.write_text(json.dumps({"media": str(media), "segments": []}), encoding="utf-8")
        media.write_bytes(b"media")

        class FakeProcess:
            returncode = None

            def poll(self) -> int | None:
                return None

            def terminate(self) -> None:
                self.returncode = -15

            def wait(self, timeout: float | None = None) -> int:
                return self.returncode or 0

        with mock.patch("maw.gui_web.subprocess.Popen", return_value=FakeProcess()) as popen:
            with mock.patch("maw.gui_web._wait_for_server", side_effect=[False, True]) as wait_for_server:
                result = self.api.start_server({
                    "jsonPath": str(project),
                    "mediaPath": str(media),
                    "port": "9876",
                    "guiLang": "en",
                })

        command = popen.call_args.args[0]
        self.assertIn("serve.py", command[1])
        self.assertEqual(command[2], str(project))
        self.assertEqual(command[command.index("-m") + 1], str(media))
        self.assertEqual(command[command.index("--port") + 1], "9876")
        self.assertEqual(result["url"], "http://127.0.0.1:9876/?lang=en")
        self.assertEqual(
            wait_for_server.call_args_list,
            [
                mock.call("http://127.0.0.1:9876/", timeout=0.25),
                mock.call("http://127.0.0.1:9876/", timeout=SERVER_START_TIMEOUT),
            ],
        )
        self.assertNotIn("serverAlreadyRunning", result)

    def test_open_mose_passes_project_path_to_packaged_executable(self) -> None:
        project = self.root / "project.mosp"
        executable = self.root / "MOSE.exe"
        project.write_text("{}\n", encoding="utf-8")
        executable.write_bytes(b"exe")

        with mock.patch("maw.gui_web._find_mose_executable", return_value=executable):
            with mock.patch("maw.gui_web.subprocess.Popen") as popen:
                result = self.api.open_mose({"jsonPath": str(project)})

        self.assertTrue(result["ok"])
        self.assertTrue(result["usedMose"])
        self.assertEqual(popen.call_args.args[0], [str(executable), str(project.resolve())])
        self.assertEqual(popen.call_args.kwargs["cwd"], str(self.root))

    def test_open_file_opens_existing_chain_artifact(self) -> None:
        artifact = self.root / "clip.llm.mosp"
        artifact.write_text("{}\n", encoding="utf-8")

        with mock.patch("maw.gui_web._open_existing_path", return_value={"ok": True}) as open_path:
            result = self.api.open_file({"path": str(artifact)})

        self.assertTrue(result["ok"])
        open_path.assert_called_once_with(artifact)

    def test_open_file_rejects_missing_chain_artifact(self) -> None:
        with mock.patch("maw.gui_web._open_existing_path") as open_path:
            result = self.api.open_file({"path": str(self.root / "missing.mosp")})

        self.assertFalse(result["ok"])
        self.assertIn("File does not exist", result["error"])
        open_path.assert_not_called()

    def test_open_mose_forwards_bundled_ffmpeg_to_sibling_app(self) -> None:
        executable = self.root / "MOSE.exe"
        ffmpeg_dir = self.root / "ffmpeg" / "bin"
        executable.write_bytes(b"exe")
        ffmpeg_dir.mkdir(parents=True)

        with mock.patch("maw.gui_web._find_mose_executable", return_value=executable):
            with mock.patch("maw.gui_web._bundled_ffmpeg_directory", return_value=ffmpeg_dir):
                with mock.patch("maw.gui_web.subprocess.Popen") as popen:
                    result = self.api.open_mose({})

        self.assertTrue(result["ok"])
        child_path = popen.call_args.kwargs["env"]["PATH"].split(os.pathsep)
        self.assertEqual(child_path[0], str(ffmpeg_dir))

    def test_find_mose_prefers_executable_beside_frozen_maw(self) -> None:
        maw_executable = self.root / "MAW.exe"
        mose_executable = self.root / "MOSE.exe"
        maw_executable.write_bytes(b"exe")
        mose_executable.write_bytes(b"exe")

        with mock.patch.object(sys, "platform", "win32"):
            with mock.patch.object(sys, "frozen", True, create=True):
                with mock.patch.object(sys, "executable", str(maw_executable)):
                    self.assertEqual(_find_mose_executable(), mose_executable.resolve())

    def test_find_mose_resolves_macos_app_beside_frozen_maw(self) -> None:
        maw_executable = self.root / "MAW.app" / "Contents" / "MacOS" / "MAW"
        mose_executable = self.root / "MOSE.app" / "Contents" / "MacOS" / "mose"
        maw_executable.parent.mkdir(parents=True)
        mose_executable.parent.mkdir(parents=True)
        maw_executable.write_bytes(b"maw")
        mose_executable.write_bytes(b"mose")

        with mock.patch.object(sys, "platform", "darwin"):
            with mock.patch.object(sys, "frozen", True, create=True):
                with mock.patch.object(sys, "executable", str(maw_executable)):
                    self.assertEqual(_find_mose_executable(), mose_executable.resolve())

    def test_open_mose_reports_macos_app_when_no_desktop_editor_exists(self) -> None:
        project = self.root / "project.mosp"
        project.write_text("{}\n", encoding="utf-8")

        with mock.patch.object(sys, "platform", "darwin"):
            with mock.patch("maw.gui_web._find_mose_executable", return_value=None):
                result = self.api.open_mose({"jsonPath": str(project)})

        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "mose_not_found")
        self.assertEqual(result["detail"], "MOSE.app")
        self.assertTrue(result["searchPaths"])

    def test_register_mosp_association_points_to_mose_icon_and_command(self) -> None:
        executable = self.root / "MOSE.exe"
        executable.write_bytes(b"exe")

        class FakeKey:
            def __init__(self, path: str) -> None:
                self.path = path

            def __enter__(self) -> "FakeKey":
                return self

            def __exit__(self, *_args: object) -> None:
                return None

        class FakeWinreg:
            HKEY_CURRENT_USER = object()
            REG_SZ = 1

            def __init__(self) -> None:
                self.values: list[tuple[str, str | None, str]] = []
                self.read_values: dict[tuple[str, str], str] = {}

            def OpenKey(self, _root: object, path: str) -> FakeKey:
                return FakeKey(path)

            def QueryValueEx(self, key: FakeKey, name: str) -> tuple[str, int]:
                try:
                    return self.read_values[(key.path, name)], self.REG_SZ
                except KeyError as error:
                    raise OSError from error

            def CreateKey(self, _root: object, path: str) -> FakeKey:
                return FakeKey(path)

            def SetValueEx(self, key: FakeKey, name: str | None, _reserved: int, _kind: int, value: str) -> None:
                self.values.append((key.path, name, value))

        fake_winreg = FakeWinreg()
        with mock.patch.object(sys, "platform", "win32"):
            with mock.patch("maw.gui_web._find_mose_executable", return_value=executable):
                with mock.patch("ctypes.windll", create=True):
                    with mock.patch.dict(sys.modules, {"winreg": fake_winreg}):
                        self.assertTrue(_register_mosp_association())

        values = {path: value for path, name, value in fake_winreg.values if name is None}
        self.assertEqual(values[r"Software\Classes\.mosp"], "Moy.MOSE.Project")
        self.assertEqual(values[r"Software\Classes\Moy.MOSE.Project\DefaultIcon"], f'"{executable}",0')
        self.assertEqual(values[r"Software\Classes\Moy.MOSE.Project\shell\open\command"], f'"{executable}" "%1"')
        named_values = {(path, name): value for path, name, value in fake_winreg.values if name is not None}
        self.assertEqual(named_values[(r"Software\Moy\MOSE", "InstallPath")], str(self.root))
        self.assertEqual(named_values[(r"Software\Moy\MOSE", "ExecutablePath")], str(executable))
        self.assertEqual(named_values[(r"Software\Moy\MOSE", "Version")], "0.1.0")

    def test_find_mose_prefers_valid_registered_independent_installation(self) -> None:
        registered = self.root / "installed" / "MOSE.exe"
        bundled = self.root / "bundle" / "MOSE.exe"
        registered.parent.mkdir()
        bundled.parent.mkdir()
        registered.write_bytes(b"installed")
        bundled.write_bytes(b"bundled")
        maw_executable = bundled.parent / "MAW.exe"
        maw_executable.write_bytes(b"maw")

        class FakeKey:
            def __init__(self, path: str) -> None:
                self.path = path

            def __enter__(self) -> "FakeKey":
                return self

            def __exit__(self, *_args: object) -> None:
                return None

        class FakeWinreg:
            HKEY_CURRENT_USER = object()
            REG_SZ = 1

            def OpenKey(self, _root: object, path: str) -> FakeKey:
                return FakeKey(path)

            def QueryValueEx(self, key: FakeKey, name: str) -> tuple[str, int]:
                if key.path == r"Software\Moy\MOSE" and name == "ExecutablePath":
                    return str(registered), self.REG_SZ
                raise OSError

        with mock.patch.object(sys, "platform", "win32"):
            with mock.patch.object(sys, "frozen", True, create=True):
                with mock.patch.object(sys, "executable", str(maw_executable)):
                    with mock.patch.dict(sys.modules, {"winreg": FakeWinreg()}):
                        self.assertEqual(_find_mose_executable(), registered.resolve())

    def test_open_mose_reports_missing_project_before_starting(self) -> None:
        with mock.patch("maw.gui_web.subprocess.Popen") as popen:
            result = self.api.open_mose({"jsonPath": str(self.root / "missing.mosp")})

        self.assertFalse(result["ok"])
        self.assertEqual(result["field"], "jsonPath")
        self.assertEqual(result["code"], "json_not_found")
        popen.assert_not_called()

    def test_start_server_reports_failure_when_port_never_responds(self) -> None:
        """Given child starts but port stays closed, When starting server, Then browser is not opened."""
        project = self.root / "project.json"
        media = self.root / "clip.mp4"
        project.write_text(json.dumps({"media": str(media), "segments": []}), encoding="utf-8")
        media.write_bytes(b"media")

        class FakeProcess:
            returncode = None

            def poll(self) -> int | None:
                return None

            def terminate(self) -> None:
                self.returncode = -15

            def wait(self, timeout: float | None = None) -> int:
                return self.returncode or 0

        with mock.patch("maw.gui_web.subprocess.Popen", return_value=FakeProcess()):
            with mock.patch("maw.gui_web._wait_for_server", return_value=False):
                with mock.patch("maw.gui_web.webbrowser.open") as open_browser:
                    result = self.api.start_server({"jsonPath": str(project), "mediaPath": str(media), "port": "9876"})

        self.assertFalse(result["ok"])
        self.assertEqual(result["field"], "port")
        self.assertEqual(result["code"], "server_no_response")
        open_browser.assert_not_called()

    def test_start_server_exposes_child_startup_log_when_process_exits(self) -> None:
        project = self.root / "project.json"
        media = self.root / "clip.mp4"
        project.write_text(json.dumps({"media": str(media), "segments": []}), encoding="utf-8")
        media.write_bytes(b"media")

        class FailedProcess:
            def poll(self) -> int:
                return 2

        def spawn(*_args, **kwargs):
            kwargs["stdout"].write(b"Traceback: FLV conversion failed\r\nffmpeg is unavailable\r\n")
            kwargs["stdout"].flush()
            return FailedProcess()

        with mock.patch("maw.gui_web.subprocess.Popen", side_effect=spawn):
            with mock.patch("maw.gui_web._wait_for_server", return_value=False):
                result = self.api.start_server({"jsonPath": str(project), "mediaPath": str(media), "port": "9876"})

        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "server_start_failed")
        self.assertIn("进程退出码 2", result["detail"])
        self.assertIn("FLV conversion failed", result["detail"])

    def test_start_server_reports_code_when_project_json_is_missing(self) -> None:
        """Given missing project JSON, When starting server, Then json_not_found code is returned."""
        result = self.api.start_server({"jsonPath": str(self.root / "missing.json"), "mediaPath": "", "port": "8765"})

        self.assertFalse(result["ok"])
        self.assertEqual(result["field"], "jsonPath")
        self.assertEqual(result["code"], "json_not_found")

    def test_start_server_returns_url_after_wait_helper_passes(self) -> None:
        """Given wait helper passes, When starting server, Then it returns the URL after waiting."""
        project = self.root / "project.json"
        media = self.root / "clip.mp4"
        project.write_text(json.dumps({"media": str(media), "segments": []}), encoding="utf-8")
        media.write_bytes(b"media")
        calls: list[str] = []

        class FakeProcess:
            returncode = None

            def poll(self) -> int | None:
                return None

            def terminate(self) -> None:
                self.returncode = -15

            def wait(self, timeout: float | None = None) -> int:
                return self.returncode or 0

        def wait(_url: str, *, timeout: float) -> bool:
            calls.append("wait")
            return len(calls) > 1

        with mock.patch("maw.gui_web.subprocess.Popen", return_value=FakeProcess()):
            with mock.patch("maw.gui_web._wait_for_server", side_effect=wait):
                result = self.api.start_server({"jsonPath": str(project), "mediaPath": str(media), "port": "9876"})

        self.assertTrue(result["ok"])
        self.assertEqual(calls, ["wait", "wait"])

    def test_start_server_returns_existing_server_url_without_spawning(self) -> None:
        """Given a responding port, When starting server, Then it reports the existing server instead of spawning."""
        with mock.patch("maw.gui_web._wait_for_server", return_value=True):
            with mock.patch("maw.gui_web.subprocess.Popen") as popen:
                result = self.api.start_server({"port": "9876", "guiLang": "zh"})

        self.assertTrue(result["ok"])
        self.assertTrue(result["serverAlreadyRunning"])
        self.assertEqual(result["url"], "http://127.0.0.1:9876/?lang=zh")
        popen.assert_not_called()

    def test_stop_owned_server_releases_completed_process_tree_handle(self) -> None:
        process = mock.Mock()
        process.poll.return_value = 0
        self.api.server_process = process

        with mock.patch("maw.gui_web.release_process_tree") as release:
            self.assertFalse(self.api._stop_owned_server())

        release.assert_called_once_with(process)

    def test_start_server_restarts_owned_server_for_a_new_project(self) -> None:
        """Given an owned server, When another project opens, Then the server is rebound to that project."""
        project = self.root / "second.json"
        media = self.root / "second.mp4"
        project.write_text(json.dumps({"media": str(media), "segments": []}), encoding="utf-8")
        media.write_bytes(b"media")

        class RunningProcess:
            returncode = None

            def poll(self) -> int | None:
                return self.returncode

            def terminate(self) -> None:
                self.returncode = -15

            def wait(self, timeout: float | None = None) -> int:
                return self.returncode or 0

        previous_process = RunningProcess()
        replacement_process = RunningProcess()
        self.api.server_process = previous_process

        with mock.patch("maw.gui_web.subprocess.Popen", return_value=replacement_process) as popen:
            with mock.patch("maw.gui_web._wait_for_server", side_effect=[True, True]):
                result = self.api.start_server({
                    "jsonPath": str(project),
                    "port": "9876",
                    "guiLang": "zh",
                })

        self.assertTrue(result["ok"])
        self.assertEqual(previous_process.returncode, -15)
        self.assertIs(self.api.server_process, replacement_process)
        self.assertEqual(popen.call_args.args[0][2], str(project))
        self.assertNotIn("serverAlreadyRunning", result)

    def test_server_status_reports_only_a_verified_maw_server(self) -> None:
        with mock.patch("maw.gui_web._wait_for_server", return_value=True):
            with mock.patch("maw.gui_web._maw_server_process_id", return_value=4321):
                result = self.api.get_server_status({"port": "9876"})

        self.assertTrue(result["ok"])
        self.assertTrue(result["running"])
        self.assertEqual(result["pid"], 4321)
        self.assertEqual(result["url"], "http://127.0.0.1:9876/")

    def test_stop_server_can_stop_a_verified_external_maw_process(self) -> None:
        with mock.patch("maw.gui_web._wait_for_server", return_value=True):
            with mock.patch("maw.gui_web._stop_external_maw_server", return_value=True) as stop_external:
                result = self.api.stop_server({"port": "9876"})

        self.assertTrue(result["ok"])
        self.assertTrue(result["stopped"])
        stop_external.assert_called_once_with(9876)

    def test_stop_server_refuses_a_non_maw_external_listener(self) -> None:
        with mock.patch("maw.gui_web._wait_for_server", return_value=True):
            with mock.patch("maw.gui_web._stop_external_maw_server", return_value=False):
                with mock.patch("maw.gui_web._maw_server_process_id", return_value=None):
                    result = self.api.stop_server({"port": "9876"})

        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "server_stop_not_maw")

    def test_maw_server_pid_verifies_the_frozen_serve_command(self) -> None:
        with mock.patch("maw.gui_web._listening_process_id", return_value=4321):
            with mock.patch("maw.gui_web._process_command_line", return_value='"D:\\Tools\\MAW.exe" --serve --port 9876'):
                from maw.gui_web import _maw_server_process_id
                self.assertEqual(_maw_server_process_id(9876), 4321)

    def test_maw_server_pid_verifies_the_public_server_command(self) -> None:
        with mock.patch("maw.gui_web._listening_process_id", return_value=4321):
            with mock.patch("maw.gui_web._process_command_line", return_value='"D:\\Tools\\MAW.exe" --server 9876'):
                from maw.gui_web import _maw_server_process_id
                self.assertEqual(_maw_server_process_id(9876), 4321)

    def test_check_server_media_reports_existing_project_media(self) -> None:
        """Given JSON embeds existing media, When checked, Then media is usable."""
        media = self.root / "clip.mp4"
        project = self.root / "project.json"
        media.write_bytes(b"media")
        project.write_text(json.dumps({"media": str(media), "segments": []}), encoding="utf-8")

        result = self.api.check_server_media({"jsonPath": str(project)})

        self.assertTrue(result["hasMedia"])
        self.assertTrue(result["mediaExists"])
        self.assertEqual(Path(result["mediaPath"]).resolve(), media.resolve())

    def test_check_server_media_reports_missing_or_absent_media(self) -> None:
        """Given JSON lacks usable media, When checked, Then manual media is required."""
        project = self.root / "project.json"
        project.write_text('{"media": "D:/missing.mp4", "segments": []}\n', encoding="utf-8")

        missing = self.api.check_server_media({"jsonPath": str(project)})
        project.write_text('{"segments": []}\n', encoding="utf-8")
        absent = self.api.check_server_media({"jsonPath": str(project)})

        self.assertTrue(missing["hasMedia"])
        self.assertFalse(missing["mediaExists"])
        self.assertFalse(absent["hasMedia"])

    def test_check_server_media_handles_malformed_json(self) -> None:
        """Given malformed project JSON, When checked, Then result is structured not raised."""
        project = self.root / "bad.json"
        project.write_text("{bad", encoding="utf-8")

        result = self.api.check_server_media({"jsonPath": str(project)})

        self.assertFalse(result["ok"])
        self.assertFalse(result["hasMedia"])

    def test_start_server_requires_manual_media_when_project_media_missing(self) -> None:
        """Given project media is unusable, When no override is provided, Then server blocks."""
        project = self.root / "project.json"
        project.write_text('{"segments": []}\n', encoding="utf-8")

        result = self.api.start_server({"jsonPath": str(project), "mediaPath": "", "port": "8765"})

        self.assertFalse(result["ok"])
        self.assertEqual(result["field"], "serverMediaPath")
        self.assertEqual(result["code"], "server_media_missing")

    def test_open_blank_html_opens_repo_template_when_present(self) -> None:
        """Given blank editor exists, When opened, Then browser receives its file URL."""
        blank = self.root / "blank-editor.html"
        blank.write_text("<!doctype html>\n", encoding="utf-8")

        with mock.patch("maw.gui_web._open_existing_path", return_value={"ok": True}) as open_path:
            result = self.api.open_blank_html()

        self.assertTrue(result["ok"])
        open_path.assert_called_once_with(blank)

    def test_open_blank_html_reports_missing_template_without_raising(self) -> None:
        """Given blank editor is missing, When opened, Then JS receives structured failure."""
        with mock.patch("maw.gui_web.asset_path", return_value=self.root / "missing-blank-editor.html"):
            result = self.api.open_blank_html()

        self.assertFalse(result["ok"])
        self.assertIn("blank-editor.html", result["error"])

    def test_check_ffmpeg_reports_found_when_both_tools_exist(self) -> None:
        ffmpeg = self.root / "bin" / "ffmpeg.exe"
        ffprobe = self.root / "bin" / "ffprobe.exe"
        ffmpeg.parent.mkdir()
        ffmpeg.write_bytes(b"exe")
        ffprobe.write_bytes(b"exe")

        def which(name: str, *, path: str | None = None) -> str:
            return str(ffmpeg if name == "ffmpeg" else ffprobe)

        with mock.patch("maw.gui_web.shutil.which", side_effect=which):
            result = self.api.check_ffmpeg()

        self.assertTrue(result["found"])
        self.assertEqual(result["directory"], str(ffmpeg.parent))

    def test_check_ffmpeg_falls_back_to_bundled_tools(self) -> None:
        ffmpeg_dir = self.root / "ffmpeg" / "bin"
        ffmpeg_dir.mkdir(parents=True)
        ffmpeg = ffmpeg_dir / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
        ffprobe = ffmpeg_dir / ("ffprobe.exe" if os.name == "nt" else "ffprobe")
        ffmpeg.write_bytes(b"exe")
        ffprobe.write_bytes(b"exe")

        with mock.patch("maw.gui_web.shutil.which", return_value=None):
            with mock.patch("maw.gui_web._bundled_ffmpeg_directory", return_value=ffmpeg_dir):
                result = self.api.check_ffmpeg()

        self.assertTrue(result["found"])
        self.assertEqual(result["ffmpeg"], str(ffmpeg))
        self.assertEqual(result["ffprobe"], str(ffprobe))

    def test_check_ffmpeg_uses_macos_candidate_directories(self) -> None:
        ffmpeg_dir = self.root / "homebrew" / "bin"
        ffmpeg_dir.mkdir(parents=True)

        def which(name: str, *, path: str | None = None) -> str:
            assert path is not None
            self.assertIn(str(ffmpeg_dir), path.split(os.pathsep))
            return str(ffmpeg_dir / ("ffmpeg.exe" if name == "ffmpeg" else "ffprobe.exe"))

        with mock.patch.object(sys, "platform", "darwin"):
            with mock.patch("maw.gui_workflow.MACOS_FFMPEG_CANDIDATE_DIRECTORIES", (str(ffmpeg_dir),)):
                with mock.patch("maw.gui_web.shutil.which", side_effect=which):
                    result = self.api.check_ffmpeg()

        self.assertTrue(result["found"])
        self.assertEqual(result["directory"], str(ffmpeg_dir))

    def test_save_ffmpeg_path_invalid_stays_missing(self) -> None:
        result = self.api.save_ffmpeg_path({"path": str(self.root / "missing")})

        self.assertFalse(result["ok"])
        self.assertFalse(result["found"])

    def test_save_ffmpeg_path_reports_configuration_write_failure(self) -> None:
        with mock.patch("maw.gui_web.save_env", side_effect=PermissionError("read-only app bundle")):
            result = self.api.save_ffmpeg_path({"path": "/opt/homebrew/bin"})

        self.assertFalse(result["ok"])
        self.assertEqual(result["field"], "ffmpegPath")
        self.assertEqual(result["code"], "config_save_failed")
        self.assertIn("read-only app bundle", result["detail"])

    def test_save_ffmpeg_path_accepts_a_directory_with_both_macos_tools(self) -> None:
        ffmpeg_dir = self.root / "bin"
        ffmpeg_dir.mkdir()
        ffmpeg_name = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
        ffprobe_name = "ffprobe.exe" if os.name == "nt" else "ffprobe"
        (ffmpeg_dir / ffmpeg_name).write_bytes(b"executable")
        (ffmpeg_dir / ffprobe_name).write_bytes(b"executable")

        result = self.api.save_ffmpeg_path({"path": str(ffmpeg_dir)})

        self.assertTrue(result["ok"])
        self.assertTrue(result["found"])
        self.assertEqual(result["directory"], str(ffmpeg_dir))
        self.assertIn(f"FFMPEG_PATH={ffmpeg_dir}", self.env_path.read_text(encoding="utf-8"))

    def test_save_sticker_dir_rejects_missing_directory(self) -> None:
        result = self.api.save_sticker_dir({"path": str(self.root / "missing-stickers")})

        self.assertFalse(result["ok"])
        self.assertEqual(result["field"], "stickerDir")
        self.assertEqual(result["code"], "sticker_dir_invalid")

    def test_save_sticker_dir_writes_valid_directory_to_env(self) -> None:
        stickers = self.root / "stickers"
        stickers.mkdir()

        result = self.api.save_sticker_dir({"path": str(stickers)})

        self.assertTrue(result["ok"])
        self.assertEqual(result["stickerDir"], str(stickers))
        self.assertIn(f"STICKER_DIR={stickers}", self.env_path.read_text(encoding="utf-8"))

    @unittest.skipUnless(os.name == "nt", "os.startfile 仅 Windows 可用；os.name 补丁会让 pathlib 选择 WindowsPath")
    def test_open_output_folder_uses_startfile_on_windows(self) -> None:
        folder = self.root / "out"
        folder.mkdir()
        self.api.result = mock.Mock(srt_path=folder / "a.srt", html_path=None)

        with mock.patch("maw.gui_web.os.name", "nt"):
            with mock.patch("maw.gui_web.os.startfile", create=True) as startfile:
                result = self.api.open_output_folder()

        self.assertTrue(result["ok"])
        startfile.assert_called_once_with(str(folder))

    def test_open_html_missing_path_does_not_open(self) -> None:
        self.api.result = mock.Mock(srt_path=self.root / "a.srt", html_path=self.root / "missing.edit.html")

        with mock.patch("maw.gui_web.webbrowser.open") as open_browser:
            result = self.api.open_html()

        self.assertFalse(result["ok"])
        open_browser.assert_not_called()

    def test_cancel_transcription_sets_event(self) -> None:
        """Given a running cancellation token, When cancel is called, Then the event is set."""
        self.api.cancel_event = threading.Event()

        result = self.api.cancel_transcription()

        self.assertTrue(self.api.cancel_event.is_set())
        self.assertTrue(result["ok"])

    def test_cancel_local_model_sets_event_for_active_worker(self) -> None:
        self.api.local_prepare_cancel_event = threading.Event()
        self.api.local_prepare_worker = mock.Mock(is_alive=mock.Mock(return_value=True))

        result = self.api.cancel_local_model()

        self.assertTrue(self.api.local_prepare_cancel_event.is_set())
        self.assertTrue(result["ok"])
        self.assertTrue(result["cancelling"])

    def test_start_transcription_rejects_missing_media(self) -> None:
        """Given missing media, When transcription starts, Then validation fails before subprocess."""
        result = self.api.start_transcription({"mediaPath": str(self.root / "missing.mp3"), "srtPath": str(self.root / "out.srt")})

        self.assertFalse(result["ok"])
        self.assertEqual(result["field"], "mediaPath")
        self.assertEqual(result["code"], "media_not_found")
        self.assertIn("media", result["error"].lower())

    def test_local_request_skips_api_key_and_carries_engine_options(self) -> None:
        media = self.root / "clip.mp3"
        media.write_bytes(b"media")
        status = LocalModelStatus(
            model_id="qwen3-asr-local",
            engine="qwen-asr",
            model_ref="Qwen/Qwen3-ASR-0.6B",
            status="installed",
            runtime_available=True,
            installed=True,
            path=str(self.root / "qwen"),
            detail="ready",
            runtime_source="managed",
            runtime_python=str(self.root / "runtime" / "Scripts" / "python.exe"),
        )

        with mock.patch("maw.gui_web.inspect_local_model", return_value=status):
            request = _request_from_payload({
                "providerId": "local",
                "modelId": "qwen3-asr-local",
                "mediaPath": str(media),
                "srtPath": str(self.root / "out.srt"),
                "device": "cpu",
                "language": "zh",
            }, self.env_path)

        self.assertEqual(request.provider, "local")
        self.assertEqual(request.engine, "qwen-asr")
        self.assertEqual(request.model, "Qwen/Qwen3-ASR-0.6B")
        self.assertEqual(request.device, "cpu")
        self.assertEqual(request.api_key, "")
        self.assertEqual(request.runtime_python, str(self.root / "runtime" / "Scripts" / "python.exe"))

    def test_local_request_rejects_missing_model_before_subprocess(self) -> None:
        media = self.root / "clip.mp3"
        media.write_bytes(b"media")
        status = LocalModelStatus(
            model_id="qwen3-asr-local",
            engine="qwen-asr",
            model_ref="Qwen/Qwen3-ASR-0.6B",
            status="missing",
            runtime_available=True,
            installed=False,
            detail="missing",
        )

        with mock.patch("maw.gui_web.inspect_local_model", return_value=status):
            result = self.api.start_transcription({
                "providerId": "local",
                "modelId": "qwen3-asr-local",
                "mediaPath": str(media),
                "srtPath": str(self.root / "out.srt"),
            })

        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "local_model_missing")
        self.assertEqual(result["field"], "model")

    def test_start_transcription_rejects_empty_resolved_api_key(self) -> None:
        """Given media and output but no key anywhere, When starting, Then API key blocks."""
        media = self.root / "clip.mp3"
        media.write_bytes(b"media")

        result = self.api.start_transcription({"mediaPath": str(media), "srtPath": str(self.root / "out.srt"), "apiKey": ""})

        self.assertFalse(result["ok"])
        self.assertEqual(result["field"], "apiKey")
        self.assertEqual(result["code"], "api_key_missing")

    def test_start_transcription_accepts_api_key_from_env_file(self) -> None:
        """Given saved API key, When field is empty, Then resolved key is used."""
        media = self.root / "clip.mp3"
        media.write_bytes(b"media")
        self.env_path.write_text("DASHSCOPE_API_KEY=sk-from-env\n", encoding="utf-8")

        with mock.patch("maw.gui_web.run_transcription"):
            result = self.api.start_transcription({"mediaPath": str(media), "srtPath": str(self.root / "out.srt"), "apiKey": ""})

        self.assertTrue(result["ok"])
        self.api.cancel_transcription()

    def test_start_transcription_rejects_singapore_without_workspace(self) -> None:
        """Given Singapore region, When workspace is absent, Then workspace blocks."""
        media = self.root / "clip.mp3"
        media.write_bytes(b"media")

        result = self.api.start_transcription({
            "mediaPath": str(media),
            "srtPath": str(self.root / "out.srt"),
            "apiKey": "sk-test",
            "region": "singapore",
            "workspaceId": "",
        })

        self.assertFalse(result["ok"])
        self.assertEqual(result["field"], "workspaceId")
        self.assertEqual(result["code"], "workspace_missing")

    def test_start_transcription_rejects_missing_output_path_with_code(self) -> None:
        """Given media but no output path, When transcription starts, Then output_missing blocks."""
        media = self.root / "clip.mp3"
        media.write_bytes(b"media")

        result = self.api.start_transcription({"mediaPath": str(media), "srtPath": "", "apiKey": "sk-test"})

        self.assertFalse(result["ok"])
        self.assertEqual(result["field"], "srtPath")
        self.assertEqual(result["code"], "output_missing")

    def test_default_output_avoids_existing_srt_and_reports_rename(self) -> None:
        media = self.root / "clip.mp4"
        media.write_bytes(b"media")
        output = self.root / "clip.qwen-audio.srt"
        output.write_text("existing", encoding="utf-8")

        result = self.api.default_output({"mediaPath": str(media), "providerId": "qwen", "modelId": "qwen-audio-3.0-asr-flash-filetrans"})

        self.assertTrue(result["renamed"])
        self.assertEqual(result["path"], str(self.root / "clip.qwen-audio-1.srt"))

    def test_start_transcription_rechecks_output_collision_before_worker(self) -> None:
        media = self.root / "clip.mp3"
        media.write_bytes(b"media")
        output = self.root / "out.srt"
        output.write_text("existing", encoding="utf-8")
        result = TranscriptionResult(srt_path=self.root / "out-1.srt", json_path=self.root / "out-1.mosp", html_path=None)

        with mock.patch("maw.gui_web.run_transcription", return_value=result):
            started = self.api.start_transcription({"mediaPath": str(media), "srtPath": str(output), "apiKey": "sk-test"})
            self.assertTrue(started["ok"])
            self.assertTrue(started["outputRenamed"])
            self.assertEqual(started["outputPath"], str(self.root / "out-1.srt"))
            if self.api.worker:
                self.api.worker.join(timeout=1)

    def test_request_from_payload_test_run_overrides_manual_length_limit(self) -> None:
        media = self.root / "clip.mp3"
        media.write_bytes(b"media")

        request = _request_from_payload({
            "mediaPath": str(media),
            "srtPath": str(self.root / "out.srt"),
            "apiKey": "sk-test",
            "region": "beijing",
            "lengthLimit": "30m",
            "testRun": True,
            "debugRaw": True,
            "guiLang": "en",
        }, self.env_path)

        self.assertEqual(request.length_limit, "2m")
        self.assertEqual(request.srt_path.name, "out-test.srt")
        self.assertEqual(request.ui_language, "en")
        self.assertTrue(request.debug_raw)

    def test_request_from_payload_without_test_run_uses_manual_length_limit(self) -> None:
        media = self.root / "clip.mp3"
        media.write_bytes(b"media")

        request = _request_from_payload({
            "mediaPath": str(media),
            "srtPath": str(self.root / "out.srt"),
            "apiKey": "sk-test",
            "region": "beijing",
            "lengthLimit": "30m",
            "testRun": False,
        }, self.env_path)

        self.assertEqual(request.length_limit, "30m")

    def test_request_from_payload_passes_segmentation_options(self) -> None:
        media = self.root / "clip.mp3"
        media.write_bytes(b"media")

        request = _request_from_payload({
            "mediaPath": str(media),
            "srtPath": str(self.root / "out.srt"),
            "apiKey": "sk-test",
            "maxLen": "14",
            "minLen": "3",
            "gapSplit": "800",
        }, self.env_path)

        self.assertEqual(request.max_len, "14")
        self.assertEqual(request.min_len, "3")
        self.assertEqual(request.gap_split, "800")

    def test_request_from_payload_rejects_invalid_segmentation_options(self) -> None:
        media = self.root / "clip.mp3"
        media.write_bytes(b"media")
        base = {
            "mediaPath": str(media),
            "srtPath": str(self.root / "out.srt"),
            "apiKey": "sk-test",
        }

        with self.assertRaises(PreflightError) as raised:
            _request_from_payload({**base, "maxLen": "2", "minLen": "3"}, self.env_path)

        self.assertEqual(raised.exception.field, "maxLen")
        self.assertEqual(raised.exception.code, "segmentation_invalid")

    def test_request_from_payload_only_generates_html_when_requested(self) -> None:
        media = self.root / "clip.mp3"
        media.write_bytes(b"media")
        payload = {
            "mediaPath": str(media),
            "srtPath": str(self.root / "out.srt"),
            "apiKey": "sk-test",
        }

        self.assertFalse(_request_from_payload(payload, self.env_path).generate_html)
        self.assertTrue(_request_from_payload({**payload, "generateHtml": True}, self.env_path).generate_html)

    def test_request_from_payload_controls_spectral_generation(self) -> None:
        media = self.root / "clip.mp3"
        media.write_bytes(b"media")
        payload = {
            "mediaPath": str(media),
            "srtPath": str(self.root / "out.srt"),
            "apiKey": "sk-test",
        }

        self.assertFalse(_request_from_payload(payload, self.env_path).generate_spectral)
        self.assertTrue(
            _request_from_payload({**payload, "generateSpectral": True}, self.env_path).generate_spectral
        )

    def test_request_from_payload_enables_speaker_colors_only_for_selected_model(self) -> None:
        media = self.root / "clip.mp3"
        media.write_bytes(b"media")
        base = {
            "providerId": "qwen",
            "mediaPath": str(media),
            "srtPath": str(self.root / "out.srt"),
            "apiKey": "sk-test",
            "region": "beijing",
            "speakerColors": True,
        }

        qwen = _request_from_payload(
            {**base, "modelId": "qwen3-asr-flash-filetrans"},
            self.env_path,
        )
        funasr = _request_from_payload(
            {**base, "modelId": "fun-asr"},
            self.env_path,
        )

        self.assertFalse(qwen.speaker_colors)
        self.assertTrue(funasr.speaker_colors)

    def test_request_from_payload_passes_qwen_audio_options_without_persisting_them(self) -> None:
        media = self.root / "clip.mp3"
        media.write_bytes(b"media")
        request = _request_from_payload({
            "providerId": "qwen",
            "modelId": "qwen-audio-3.0-asr-flash-filetrans",
            "mediaPath": str(media),
            "srtPath": str(self.root / "out.srt"),
            "apiKey": "sk-test",
            "region": "beijing",
            "qwenAudioContext": "产品名和专业术语",
            "qwenAudioHotwords": "张三\n李四,阿里云",
            "qwenAudioVocabularyId": "vocab-qwen-audio",
            "qwenAudioHotwordWeight": "50",
        }, self.env_path)

        self.assertEqual(request.qwen_audio_context, "产品名和专业术语")
        self.assertEqual(request.qwen_audio_hotwords, "张三\n李四,阿里云")
        self.assertEqual(request.qwen_audio_vocabulary_id, "vocab-qwen-audio")
        self.assertEqual(request.qwen_audio_hotword_weight, "50")

    def test_request_from_payload_builds_soniox_context(self) -> None:
        media = self.root / "clip.mp3"
        media.write_bytes(b"media")
        request = _request_from_payload({
            "providerId": "soniox",
            "modelId": "stt-async-v5",
            "mediaPath": str(media),
            "srtPath": str(self.root / "out.srt"),
            "apiKey": "sk-soniox-test",
            "sonioxContextGeneral": "domain=Healthcare\ntopic=Diabetes management",
            "sonioxContextText": "A treatment consultation.",
            "sonioxContextTerms": "MRI\nAmoxicillin",
            "sonioxContextTranslationTerms": "MRI => 核磁共振",
        }, self.env_path)

        self.assertEqual(
            request.soniox_context,
            {
                "general": [
                    {"key": "domain", "value": "Healthcare"},
                    {"key": "topic", "value": "Diabetes management"},
                ],
                "text": "A treatment consultation.",
                "terms": ["MRI", "Amoxicillin"],
                "translation_terms": [{"source": "MRI", "target": "核磁共振"}],
            },
        )

    def test_request_from_payload_rejects_invalid_soniox_context(self) -> None:
        media = self.root / "clip.mp3"
        media.write_bytes(b"media")

        with self.assertRaises(PreflightError) as raised:
            _request_from_payload({
                "providerId": "soniox",
                "modelId": "stt-async-v5",
                "mediaPath": str(media),
                "srtPath": str(self.root / "out.srt"),
                "apiKey": "sk-soniox-test",
                "sonioxContextGeneral": "not a key value pair",
            }, self.env_path)

        self.assertEqual(raised.exception.field, "sonioxContextGeneral")
        self.assertEqual(raised.exception.code, "soniox_context_invalid")

    def test_request_from_payload_passes_qwen_audio_hotword_file_mode(self) -> None:
        media = self.root / "clip.mp3"
        media.write_bytes(b"media")
        hotwords = self.root / "hotwords.txt"
        hotwords.write_text("张三\n阿里云\n", encoding="utf-8")
        request = _request_from_payload({
            "providerId": "qwen",
            "modelId": "qwen-audio-3.0-asr-flash-filetrans",
            "mediaPath": str(media),
            "srtPath": str(self.root / "out.srt"),
            "apiKey": "sk-test",
            "region": "beijing",
            "qwenAudioHotwordsMode": "file",
            "qwenAudioHotwordsFile": str(hotwords),
            "qwenAudioHotwords": "不会被使用",
        }, self.env_path)

        self.assertEqual(request.qwen_audio_hotwords_file, str(hotwords))
        self.assertEqual(request.qwen_audio_hotwords, "")

    def test_request_from_payload_rejects_missing_qwen_audio_hotword_file(self) -> None:
        media = self.root / "clip.mp3"
        media.write_bytes(b"media")

        with self.assertRaisesRegex(PreflightError, "\\.txt"):
            _request_from_payload({
                "providerId": "qwen",
                "modelId": "qwen-audio-3.0-asr-flash-filetrans",
                "mediaPath": str(media),
                "srtPath": str(self.root / "out.srt"),
                "apiKey": "sk-test",
                "region": "beijing",
                "qwenAudioHotwordsMode": "file",
                "qwenAudioHotwordsFile": str(self.root / "missing.txt"),
            }, self.env_path)

    def test_read_hotword_file_returns_utf8_text(self) -> None:
        hotwords = self.root / "hotwords.txt"
        hotwords.write_text("张三\n阿里云\n", encoding="utf-8")

        result = self.api.read_hotword_file({"path": str(hotwords)})

        self.assertTrue(result["ok"])
        self.assertEqual(result["path"], str(hotwords))
        self.assertEqual(result["text"], "张三\n阿里云\n")

    def test_request_from_payload_rejects_qwen_audio_context_over_400_characters(self) -> None:
        media = self.root / "clip.mp3"
        media.write_bytes(b"media")

        with self.assertRaisesRegex(PreflightError, "400"):
            _request_from_payload({
                "providerId": "qwen",
                "modelId": "qwen-audio-3.0-asr-flash-filetrans",
                "mediaPath": str(media),
                "srtPath": str(self.root / "out.srt"),
                "apiKey": "sk-test",
                "region": "beijing",
                "qwenAudioContext": "x" * 401,
            }, self.env_path)

    def test_event_pump_batches_events_and_preserves_order(self) -> None:
        pump = EventPump(window_getter=lambda: self.window)
        pump.enqueue({"type": "log", "message": "one"})
        pump.enqueue({"type": "log", "message": "two"})

        pump.flush()

        self.assertEqual(len(self.window.scripts), 1)
        self.assertIn("onBackendEvents", self.window.scripts[0])
        self.assertLess(self.window.scripts[0].index("one"), self.window.scripts[0].index("two"))

    def test_ffprobe_start_failure_is_recognised_from_child_output(self) -> None:
        self.assertTrue(_is_ffprobe_start_failure([
            "subprocess.CalledProcessError: Command ['ffprobe', ...]",
            "returned non-zero exit status 3221225794.",
        ]))
        self.assertFalse(_is_ffprobe_start_failure([
            "subprocess.CalledProcessError: Command ['ffprobe', ...]",
            "returned non-zero exit status 1.",
        ]))

    def test_ffmpeg_start_failure_is_recognised_from_child_output(self) -> None:
        self.assertTrue(_is_ffmpeg_start_failure([
            "Traceback: Command ['ffmpeg', '-i', 'clip.mp4']",
            "returned non-zero exit status 3221225794.",
        ]))
        self.assertFalse(_is_ffmpeg_start_failure([
            "Command ['ffmpeg', ...]",
            "returned non-zero exit status 1.",
        ]))

    def test_launcher_api_queues_started_event_and_shutdown_flushes(self) -> None:
        self.api._emit({"type": "log", "message": "queued"})

        self.api.shutdown()

        self.assertTrue(self.window.scripts)
        self.assertIn("queued", self.window.scripts[-1])

    def test_worker_emits_done_with_json_when_optional_html_is_missing(self) -> None:
        request = TranscriptionRequest(
            media_path=self.root / "clip.wav",
            srt_path=self.root / "clip.srt",
        )
        result = TranscriptionResult(
            srt_path=self.root / "clip.srt",
            json_path=self.root / "clip.json",
            html_path=None,
        )

        with mock.patch("maw.gui_web.run_transcription", return_value=result):
            self.api._worker_main(request, threading.Event())

        self.assertEqual(self.api.result, result)
        self.assertTrue(self.window.scripts)
        event_script = self.window.scripts[-1]
        self.assertIn('"type": "done"', event_script)
        self.assertIn(str(result.json_path).replace("\\", "\\\\"), event_script)
        self.assertIn('"htmlPath": ""', event_script)
        self.assertIn('"rawPath": ""', event_script)

    def test_worker_emits_retryable_error_for_ffprobe_start_failure(self) -> None:
        request = TranscriptionRequest(
            media_path=self.root / "clip.wav",
            srt_path=self.root / "clip.srt",
        )

        def fail_with_ffprobe_output(*_args: object, **kwargs: object) -> None:
            callback = kwargs["on_event"]
            assert callable(callback)
            callback("subprocess.CalledProcessError: Command ['ffprobe', ...]")
            callback("returned non-zero exit status 3221225794.")
            raise TranscriptionProcessError(1)

        with mock.patch("maw.gui_web.run_transcription", side_effect=fail_with_ffprobe_output):
            self.api._worker_main(request, threading.Event())

        self.assertTrue(self.window.scripts)
        event_script = self.window.scripts[-1]
        self.assertIn('"code": "ffprobe_start_failed"', event_script)
        self.assertIn('"detail": "Transcription failed with exit code 1"', event_script)

    def test_worker_emits_retryable_error_for_ffmpeg_start_failure(self) -> None:
        request = TranscriptionRequest(
            media_path=self.root / "clip.mp4",
            srt_path=self.root / "clip.srt",
        )

        def fail_with_ffmpeg_output(*_args: object, **kwargs: object) -> None:
            callback = kwargs["on_event"]
            assert callable(callback)
            callback("Traceback: Command ['ffmpeg', '-i', 'clip.mp4']")
            callback("returned non-zero exit status 3221225794.")
            raise TranscriptionProcessError(1)

        with mock.patch("maw.gui_web.run_transcription", side_effect=fail_with_ffmpeg_output):
            self.api._worker_main(request, threading.Event())

        self.assertTrue(self.window.scripts)
        event_script = self.window.scripts[-1]
        self.assertIn('"code": "ffmpeg_start_failed"', event_script)
        self.assertIn('"detail": "Transcription failed with exit code 1"', event_script)

    def test_route_dropped_path_routes_json_media_and_hotword_file(self) -> None:
        """Given dropped paths, When routed, Then event type mirrors launcher drop behavior."""
        media = _route_dropped_path(r"D:\Videos\clip.MP4")
        project = _route_dropped_path(r"D:\Videos\clip.json")
        mosp_project = _route_dropped_path(r"D:\Videos\clip.mosp")
        subtitle = _route_dropped_path(r"D:\Videos\clip.srt")
        hotwords = _route_dropped_path(r"D:\Videos\clip.txt")

        self.assertEqual(media, {"type": "dropMedia", "path": r"D:\Videos\clip.MP4"})
        self.assertEqual(project, {"type": "dropJson", "path": r"D:\Videos\clip.json"})
        self.assertEqual(mosp_project, {"type": "dropJson", "path": r"D:\Videos\clip.mosp"})
        self.assertEqual(subtitle, {"type": "dropSubtitle", "path": r"D:\Videos\clip.srt"})
        self.assertEqual(hotwords, {"type": "dropHotwordFile", "path": r"D:\Videos\clip.txt"})


@final
class LauncherRuntimeTests(unittest.TestCase):
    def test_run_app_passes_debug_and_controls_automatic_devtools(self) -> None:
        paths = LauncherPaths(
            root=Path("launcher-root"),
            env_path=Path("launcher-root/.env"),
            launcher_html=Path("launcher-root/launcher.html"),
        )

        for debug, devtools in ((False, False), (True, False), (True, True)):
            fake_webview = mock.Mock()
            fake_webview.settings = {"OPEN_DEVTOOLS_IN_DEBUG": True}
            fake_webview.create_window.return_value = None
            fake_webview.start.return_value = None
            with (
                mock.patch.dict(sys.modules, {"webview": fake_webview}),
                mock.patch("maw.gui_web.default_paths", return_value=paths),
                mock.patch("maw.gui_web.LauncherApi"),
                mock.patch("maw.gui_web.asset_path", return_value=Path("missing.ico")),
            ):
                run_app(debug=debug, devtools=devtools)

            self.assertEqual(fake_webview.settings["OPEN_DEVTOOLS_IN_DEBUG"], devtools)
            self.assertEqual(fake_webview.start.call_args.kwargs["debug"], debug or devtools)
            fake_webview.reset_mock()


@final
class LauncherAssetContractTests(unittest.TestCase):
    def test_launcher_exposes_chainable_postprocess_toolbox(self) -> None:
        page = (ROOT / "web" / "launcher" / "index.html").read_text(encoding="utf-8")
        script = (ROOT / "web" / "launcher" / "postprocess.js").read_text(encoding="utf-8")
        launcher_script = (ROOT / "web" / "launcher" / "launcher.js").read_text(encoding="utf-8")
        stylesheet = (ROOT / "web" / "launcher" / "launcher.css").read_text(encoding="utf-8")

        for control in (
            "toolboxFab",
            "toolboxDrawer",
            "toolboxInputDropZone",
            "toolboxInputName",
            "toolboxInputPath",
            "pickToolboxInput",
            "toolboxChain",
            "toolboxChainList",
            "toolboxMatchPanel",
            "toolboxOcrPanel",
            "toolboxLlmPanel",
            "toolboxReplacePanel",
            "toolboxFfconcatPanel",
            "postprocessScriptPath",
            "postprocessProvider",
            "postprocessPrompt",
            "postprocessOutputMode",
            "postprocessFfconcatPath",
            "llmProvider",
            "llmApiKey",
            "llmBaseUrl",
            "llmModel",
            "llmModelOptions",
            "llmModelChoicesToggle",
            "llmModelStatus",
            "llmReasoningMode",
            "llmCustomDisplayName",
            "testLlmConnection",
            "getLlmModels",
            "llmSettingsSaveStatus",
            "openLlmSettings",
        ):
            self.assertIn(f'id="{control}"', page)
        self.assertIn('id="postprocessPromptError"', page)
        self.assertNotIn('id="postprocessApiKey"', page)
        self.assertNotIn('id="postprocessBaseUrl"', page)
        self.assertNotIn('id="postprocessModel"', page)
        self.assertIn('bridge("run_script_match"', script)
        self.assertIn('bridge("run_ocr_dedup"', script)
        self.assertIn("fallbackVideoPath", script)
        self.assertIn('mediaPath: $("mediaPath").value.trim()', script)
        self.assertIn('bridge("run_llm_postprocess"', script)
        self.assertIn('bridge("run_fixed_replacement"', script)
        self.assertIn('bridge("run_ffconcat_rebuild"', script)
        self.assertIn('bridge("save_postprocess_settings"', script)
        self.assertIn('bridge("test_postprocess_connection"', script)
        self.assertIn('bridge("get_postprocess_models"', script)
        self.assertIn('class="primary"', page)
        self.assertIn('llm_models_loaded: "已获取 {count} 个模型，可在上方快速选择"', launcher_script)
        self.assertIn('role="combobox"', page)
        self.assertIn('role="listbox"', page)
        self.assertNotIn(">⌄</button>", page)
        self.assertIn('data-i18n="llm_quick_actions">快捷功能</label>', page)
        self.assertNotIn('id="llmModelQuick"', page)
        self.assertNotIn("<datalist", page)
        self.assertIn('llm_reasoning_mode_hint">默认关闭；自动表示跟随模型默认。</p>', page)
        settings_grid = page.index('<div class="toolbox-grid settings-grid">')
        settings_actions = page.index('<div class="field settings-grid-actions">')
        model_status = page.index('id="llmModelStatus"')
        api_key = page.index('id="llmApiKey"')
        self.assertLess(settings_grid, settings_actions)
        self.assertLess(settings_actions, model_status)
        self.assertLess(settings_actions, api_key)
        self.assertIn('displayName: item.id === "custom" ? $("llmCustomDisplayName").value.trim() : ""', script)
        self.assertIn('bridge("choose_file", { kind: "script" })', script)
        self.assertIn('bridge("choose_file", { kind: "subtitle" })', script)
        self.assertIn('bridge("choose_file", { kind: "video" })', script)
        self.assertIn('setFieldError("toolboxInputPath", "");\n      syncOcrVideo();\n      syncInputName();', script)
        self.assertIn('openSettings("llmSettingsSection")', script)
        self.assertIn('$("jsonPath").value = result.projectPath', script)
        self.assertIn('$("srtPath").value = result.srtPath', script)
        self.assertIn('$("mediaPath").value = result.mediaPath', script)
        self.assertIn(".toolbox-fab", stylesheet)
        self.assertIn(".toolbox-drawer", stylesheet)
        self.assertIn(".toolbox-content", stylesheet)
        self.assertIn("max-height: 360px", stylesheet)
        self.assertIn("overflow-y: auto", stylesheet)
        self.assertIn('bindDropField("toolboxInputDropZone", "toolboxInput", "toolboxInputDropZone")', launcher_script)
        self.assertIn("addChainResult", script)
        self.assertIn("selectChainPath", script)
        self.assertIn('bridge("open_file", { path })', script)
        self.assertIn('addEventListener("dblclick"', script)
        self.assertIn('toolbox_chain_llm_translate: "[LLM 处理/翻译]"', launcher_script)
        self.assertNotIn("toolbox_chain_llm_translate: \"（LLM 处理/翻译）翻译产物\"", launcher_script)
        self.assertIn('data-tool-action="match"', page)
        self.assertIn('data-tool-action="ocr"', page)
        self.assertIn('data-tool-action="llm"', page)
        self.assertIn('data-tool-action="replace"', page)
        self.assertIn('class="toolbox-footer"', page)
        self.assertNotIn("toolbox-output-hint", page)
        self.assertNotIn("toolbox_beta_notice_prefix", page)
        self.assertIn('class="hint toolbox-panel-hint"', page)
        self.assertIn('class="hint toolbox-full-line-hint"', page)
        self.assertIn('document.querySelectorAll("[data-tool-action]")', script)
        self.assertIn('event.type === "postprocess_status"', launcher_script)
        self.assertIn('event.type === "postprocess_stream"', launcher_script)
        self.assertIn("onPostprocessStatus", launcher_script)
        self.assertIn("onPostprocessStream", script)
        self.assertIn('id="toolboxStreamOutput"', page)
        self.assertIn('id="toolboxThinkingOutput"', page)
        self.assertIn('id="toolboxModelOutput"', page)
        self.assertIn("function renderPostprocessStatus(event)", script)
        self.assertIn('event.kind === "reset"', script)
        self.assertIn('taskPrompt: taskPromptText(operation)', script)
        self.assertIn('const customPrompt = $("postprocessPrompt").value.trim()', script)
        self.assertIn("const TASK_PROMPT_KEYS", script)

    def test_custom_llm_task_requires_a_prompt(self) -> None:
        page = (ROOT / "web" / "launcher" / "index.html").read_text(encoding="utf-8")
        script = (ROOT / "web" / "launcher" / "postprocess.js").read_text(encoding="utf-8")

        self.assertIn('id="postprocessPromptError"', page)
        self.assertIn('operation === "custom" && !customPrompt', script)
        self.assertIn('const message = t("toolbox_custom_prompt_required")', script)
        self.assertIn('setFieldError("postprocessPrompt", message)', script)
        self.assertIn('$("postprocessPrompt").addEventListener("input"', script)

    def test_llm_task_prompt_order_and_switch_contract(self) -> None:
        page = (ROOT / "web" / "launcher" / "index.html").read_text(encoding="utf-8")
        script = (ROOT / "web" / "launcher" / "postprocess.js").read_text(encoding="utf-8")

        values = ("proofread", "translate_zh", "translate_en", "resegment", "custom")
        positions = [page.index(f'<option value="{value}"') for value in values]
        self.assertEqual(positions, sorted(positions))
        self.assertIn('id="postprocessTaskPrompt"', page)
        self.assertIn('data-i18n="toolbox_preset_prompt"', page)
        self.assertIn('data-i18n="toolbox_prompt_hint"', page)
        self.assertIn('id="autoPostprocessOptions" class="auto-postprocess-options hidden"', page)
        self.assertIn('id="autoPostprocessStepsCard" class="sub-accordion collapsed"', page)
        self.assertIn('id="autoPostprocessStepsToggle"', page)
        for step_id in ("Match", "Replace", "Proofread", "Resegment", "Ocr", "Translate"):
            self.assertIn(f'id="autoStep{step_id}Hint"', page)
        self.assertIn('$("postprocessOperation").addEventListener("change", () => switchLlmOperation($("postprocessOperation").value))', script)
        self.assertIn("const LLM_PROMPTS_KEY", script)
        self.assertIn("function getLlmPrompt", script)
        self.assertIn("customPrompt: getLlmPrompt(\"resegment\")", script)
        self.assertIn("customPrompt: getLlmPrompt(autoLlmOperation(\"translate\"))", script)
        self.assertIn("function renderTaskPrompt(operation", script)

    def test_empty_auto_postprocess_plan_guides_step_selection(self) -> None:
        script = (ROOT / "web" / "launcher" / "postprocess.js").read_text(encoding="utf-8")
        launcher_script = (ROOT / "web" / "launcher" / "launcher.js").read_text(encoding="utf-8")

        self.assertIn('auto_summary_empty: "请在下方「后处理步骤」中勾选需要的工序。"', launcher_script)
        self.assertIn('summary.textContent = t("auto_summary_empty")', script)
        self.assertIn('if ($("autoPostprocessEnabled").checked) setAutoStepsExpanded(true);', script)
        self.assertIn('if (plan.enabled && !AUTO_STEP_ORDER.some((stepId) => $(AUTO_STEP_CHECKBOXES[stepId]).checked)) setAutoStepsExpanded(true);', script)

    def test_toolbox_tabs_stay_above_scrollable_panels(self) -> None:
        page = (ROOT / "web" / "launcher" / "index.html").read_text(encoding="utf-8")
        script = (ROOT / "web" / "launcher" / "postprocess.js").read_text(encoding="utf-8")
        stylesheet = (ROOT / "web" / "launcher" / "launcher.css").read_text(encoding="utf-8")

        sticky = page.index('class="toolbox-sticky"')
        input_drop_zone = page.index('id="toolboxInputDropZone"')
        chain = page.index('id="toolboxChain"')
        chain_list = page.index('id="toolboxChainList"')
        tabs = page.index('<div class="toolbox-tabs"')
        content = page.index('class="toolbox-content"')
        progress = page.index('<div id="toolboxProgress"')
        result = page.index('<div id="toolboxResult"')
        match_panel = page.index('id="toolboxMatchPanel"')
        llm_panel = page.index('id="toolboxLlmPanel"')
        ffconcat_panel = page.index('id="toolboxFfconcatPanel"')
        ffconcat_end = page.index("</section>", ffconcat_panel)
        footer = page.index('class="toolbox-footer"')
        drawer_end = page.index("</aside>")

        self.assertLess(sticky, input_drop_zone)
        self.assertLess(input_drop_zone, chain)
        self.assertLess(chain, chain_list)
        self.assertLess(chain, tabs)
        self.assertLess(input_drop_zone, tabs)
        self.assertLess(tabs, content)
        self.assertLess(content, progress)
        self.assertLess(progress, result)
        self.assertIn('data-i18n="toolbox_chain_hint">每次生成新文件，并自动作为下一步输入；选择工具后运行。</p>', page)
        self.assertIn('id="toolboxResult" class="toolbox-result hidden"', page)
        self.assertIn('result.classList.remove("hidden")', script)
        self.assertLess(result, match_panel)
        self.assertLess(match_panel, llm_panel)
        self.assertLess(ffconcat_end, footer)
        self.assertLess(footer, drawer_end)

        # 输出选择与各工具执行按钮固定在抽屉底部，不随面板滚动。
        footer_html = page[footer:drawer_end]
        self.assertIn('id="postprocessOutputMode"', footer_html)
        for tool in ("match", "ocr", "llm", "replace", "ffconcat"):
            self.assertIn(f'data-tool-action="{tool}"', footer_html)
        for button in ("runScriptMatch", "runOcrDedup", "runLlmPostprocess", "runFixedReplacement", "runFfconcatRebuild"):
            self.assertIn(f'id="{button}"', footer_html)
        self.assertIn('id="toolboxMediaPath"', footer_html)

        # 自定义顶边 / 左边拖拽把手替代原生 resize。
        self.assertIn('id="toolboxResizeY" class="toolbox-resize-y" role="separator" aria-orientation="horizontal"', page)
        self.assertIn('id="toolboxResizeX" class="toolbox-resize-x" role="separator" aria-orientation="vertical"', page)
        self.assertIn('id="toolboxMatchTab" class="toolbox-tab active"', page)
        self.assertIn('id="toolboxFfconcatTab" class="toolbox-tab hidden"', page)
        self.assertIn("overflow-y: auto", stylesheet)
        self.assertNotIn("resize: both", stylesheet)
        self.assertIn("block-size: min(560px, calc(100dvh - 156px))", stylesheet)
        self.assertIn("min-inline-size: min(360px, calc(100vw - 24px))", stylesheet)
        self.assertIn(".toolbox-footer", stylesheet)
        self.assertIn(".toolbox-resize-y", stylesheet)
        self.assertIn(".toolbox-resize-x", stylesheet)
        self.assertIn("cursor: n-resize", stylesheet)
        self.assertIn("cursor: w-resize", stylesheet)
        self.assertIn(".toolbox-grid > .field", stylesheet)
        self.assertIn(".toolbox-input.drag-over", stylesheet)
        self.assertIn("grid-template-columns: repeat(4", stylesheet)
        self.assertIn("setPointerCapture", script)
        self.assertIn("maw.launcher.toolbox.size", script)
        self.assertIn("restoreToolboxSize", script)

    def test_toolbox_panels_are_grouped_into_titled_cards(self) -> None:
        page = (ROOT / "web" / "launcher" / "index.html").read_text(encoding="utf-8")
        launcher_script = (ROOT / "web" / "launcher" / "launcher.js").read_text(encoding="utf-8")
        stylesheet = (ROOT / "web" / "launcher" / "launcher.css").read_text(encoding="utf-8")

        for key in (
            "toolbox_group_ocr_video",
            "toolbox_group_ocr_region",
            "toolbox_group_ocr_output",
            "toolbox_group_llm_model",
            "toolbox_group_llm_prompt",
        ):
            self.assertIn(f'data-i18n="{key}"', page)
        self.assertIn('toolbox_group_ocr_video: "视频来源"', launcher_script)
        self.assertIn('toolbox_group_ocr_output: "判定与输出"', launcher_script)
        self.assertIn('toolbox_group_llm_prompt: "Prompts"', launcher_script)
        self.assertIn('id="ocrModel"', page)
        self.assertIn('toolbox_ocr_model_small: "PP-OCRv6 small（CPU）"', launcher_script)
        self.assertIn('id="openOcrSettings"', page)
        self.assertIn('class="field-spacer"', page)
        self.assertIn(".toolbox-static-value {\n  height: 34px;", stylesheet)
        self.assertIn(".field-spacer {\n  visibility: hidden;", stylesheet)
        self.assertIn(".toolbox-grid {\n  display: grid;\n  grid-template-columns: repeat(2, minmax(0, 1fr));\n  gap: 10px;\n  align-items: start;\n}", stylesheet)
        # 单字段的文稿匹配 / 固定替换面板不套分组卡片。
        match_panel = page[page.index('id="toolboxMatchPanel"'):page.index('id="toolboxOcrPanel"')]
        replace_panel = page[page.index('id="toolboxReplacePanel"'):page.index('id="toolboxFfconcatPanel"')]
        self.assertNotIn("adv-group", match_panel)
        self.assertNotIn("adv-group", replace_panel)

    def test_llm_save_feedback_is_local_and_transient(self) -> None:
        page = (ROOT / "web" / "launcher" / "index.html").read_text(encoding="utf-8")
        script = (ROOT / "web" / "launcher" / "postprocess.js").read_text(encoding="utf-8")
        launcher_script = (ROOT / "web" / "launcher" / "launcher.js").read_text(encoding="utf-8")
        stylesheet = (ROOT / "web" / "launcher" / "launcher.css").read_text(encoding="utf-8")

        self.assertIn('id="llmSettingsSaveStatus"', page)
        self.assertIn('setSettingsSaveStatus(t("toolbox_saved"), "success")', script)
        self.assertNotIn("toolbox_saved_test_hint", script)
        self.assertNotIn("toolbox_saved_test_hint", launcher_script)
        self.assertIn("window.setTimeout(() => setSettingsSaveStatus(\"\"), timeoutMs)", script)
        self.assertIn('toolbox_saved: "LLM 设置已保存。"', launcher_script)
        self.assertIn('toolbox_saved: "LLM settings saved."', launcher_script)
        self.assertIn("if (autoTest && enteredApiKey)", script)
        self.assertIn('await testConnection({ alreadySaved: true });', script)
        self.assertIn('$("saveLlmSettings").addEventListener("click", () => { void saveSettings({ autoTest: true }); });', script)
        pending_step = script[script.index("function maybeEnablePendingAutoStep()"):script.index("function applyAutoPostprocessPlan")]
        self.assertNotIn("closeSettings", pending_step)
        self.assertNotIn("setOpen(true)", pending_step)
        self.assertIn("font-size: 14px;", stylesheet)
        self.assertIn("font-size: 13px;", stylesheet)
        self.assertNotIn("font-size: 11px", stylesheet)
        self.assertNotIn("font: 11px", stylesheet)
        self.assertIn(".local-status-row > button", stylesheet)

    def test_launcher_message_url_stops_before_closing_punctuation(self) -> None:
        script = (ROOT / "web" / "launcher" / "launcher.js").read_text(encoding="utf-8")

        expected = r'''const urlPattern = /https?:\/\/[^\s<>"'|)\]}，。；：！？）】》」』]+/gi;'''
        self.assertIn(expected, script)

    def test_launcher_hero_shows_the_bundled_brand_icon(self) -> None:
        page = (ROOT / "web" / "launcher" / "index.html").read_text(encoding="utf-8")
        stylesheet = (ROOT / "web" / "launcher" / "launcher.css").read_text(encoding="utf-8")

        self.assertIn('<div class="hero-brand">', page)
        self.assertIn('<img class="hero-icon" src="../../assets/show.webp"', page)
        self.assertIn(".hero-icon {\n  width: 72px;\n  height: 72px;", stylesheet)

    def test_launcher_reports_media_drop_rejection_and_output_collision(self) -> None:
        page = (ROOT / "web" / "launcher" / "index.html").read_text(encoding="utf-8")
        script = (ROOT / "web" / "launcher" / "launcher.js").read_text(encoding="utf-8")

        self.assertIn('id="srtPathNotice" class="hint warn hidden"', page)
        self.assertIn("drop_reject_media", script)
        self.assertIn('drop_reject_media: "仅支持以下媒体文件类型：\\n{extensions}"', script)
        self.assertIn('function appendMessageText(container, text)', script)
        self.assertIn('setError("mediaPath", mediaDropError())', script)
        self.assertIn('output_collision: "检测到同名输出文件', script)
        self.assertIn("result.outputRenamed", script)

    def test_launcher_exposes_segmentation_controls_and_payload_fields(self) -> None:
        page = (ROOT / "web" / "launcher" / "index.html").read_text(encoding="utf-8")
        script = (ROOT / "web" / "launcher" / "launcher.js").read_text(encoding="utf-8")
        stylesheet = (ROOT / "web" / "launcher" / "launcher.css").read_text(encoding="utf-8")

        for control in ("segmentationField", "maxLen", "minLen", "gapSplit"):
            self.assertIn(f'id="{control}"', page)
        self.assertIn('id="generateSpectral" type="checkbox"', page)
        self.assertIn('id="generateSpectralField"', page)
        self.assertIn('maxLen: $("maxLen").value.trim()', script)
        self.assertIn('minLen: $("minLen").value.trim()', script)
        self.assertIn('gapSplit: $("gapSplit").value.trim()', script)
        self.assertIn('generateSpectral: $("generateSpectral").checked', script)
        self.assertIn('generate_spectral: "生成 ReaPeaks 频谱数据"', script)
        self.assertIn('generate_spectral: "Generate ReaPeaks spectral data"', script)
        self.assertIn('segmentation: "字幕切句"', script)
        self.assertIn(".segmentation-row", stylesheet)

    def test_sticker_picker_saves_immediately_without_a_separate_button(self) -> None:
        page = (ROOT / "web" / "launcher" / "index.html").read_text(encoding="utf-8")
        script = (ROOT / "web" / "launcher" / "launcher.js").read_text(encoding="utf-8")

        self.assertNotIn('id="saveStickerDir"', page)
        self.assertIn('if (result.ok) await saveStickerDirectory(result.path);', script)

    def test_ffmpeg_save_distinguishes_write_failure_from_missing_tools(self) -> None:
        script = (ROOT / "web" / "launcher" / "launcher.js").read_text(encoding="utf-8")

        self.assertIn("config_save_failed", script)
        self.assertIn("result.found === false", script)
        self.assertIn("if (!result.ok) { const message = ffmpegSaveError(result);", script)

    def test_default_editor_port_is_8250(self) -> None:
        page = (ROOT / "web" / "launcher" / "index.html").read_text(encoding="utf-8")

        self.assertEqual(_port({}), 8250)
        self.assertEqual(_port({"port": "invalid"}), 8250)
        self.assertIn('id="port" type="number" min="1" max="65535" value="8250"', page)
        self.assertIn('id="refreshServerStatus"', page)

    def test_single_file_editor_controls_are_opt_in_and_contextual(self) -> None:
        page = (ROOT / "web" / "launcher" / "index.html").read_text(encoding="utf-8")
        script = (ROOT / "web" / "launcher" / "launcher.js").read_text(encoding="utf-8")

        self.assertIn('id="generateHtml" type="checkbox"', page)
        self.assertIn('id="debugRaw" type="checkbox"', page)
        self.assertIn('data-i18n-title="debug_raw_title"', page)
        self.assertIn('data-i18n="test_run">快速测试', page)
        self.assertIn('data-i18n="test_run_override">快速测试已限定前 2 分钟', page)
        self.assertGreater(page.index('id="debugRaw"'), page.index('id="speakerColorsField"'))
        self.assertGreater(page.index('id="debugRawField"'), page.index('id="advancedCard"'))
        self.assertIn('data-i18n-title="generate_html_title"', page)
        self.assertIn('id="openHtml" class="hidden"', page)
        self.assertIn('generateHtml: $("generateHtml").checked', script)
        self.assertIn('debugRaw: $("debugRaw").checked', script)
        self.assertIn('test_run: "快速测试"', script)
        self.assertIn('test_run: "Quick test"', script)
        self.assertIn('function syncHtmlMenu()', script)
        self.assertIn('$("openHtml").classList.toggle("hidden", !enabled)', script)
        self.assertIn('$("openHtml").disabled = enabled && !state.result?.htmlPath', script)

    def test_server_status_uses_clickable_link_and_independent_stop_control(self) -> None:
        page = (ROOT / "web" / "launcher" / "index.html").read_text(encoding="utf-8")
        script = (ROOT / "web" / "launcher" / "launcher.js").read_text(encoding="utf-8")

        self.assertIn('function setServerStatus(url, alreadyRunning = false, prefix = "")', script)
        self.assertIn('bridge("open_url", { url })', script)
        self.assertIn('server_already_running', script)
        self.assertIn('get_server_status', script)
        self.assertIn('id="stopServer" class="ghost server-stop hidden"', page)
        self.assertIn('$("stopServer").addEventListener("click", stopEditorServer)', script)
        self.assertIn('bridge("stop_server", serverPayload())', script)
        self.assertIn('void checkExistingServer(t("done"));', script)
        self.assertIn('id="refreshServerStatus"', page)
        self.assertNotIn('state.serverRunning ? t("server_stop")', script)

    def test_workspace_requests_sync_server_config_from_response(self) -> None:
        script = (ROOT / "web" / "editor.js").read_text(encoding="utf-8")

        self.assertIn('async function updateServerWorkspaceSettings(payload)', script)
        self.assertIn('body: JSON.stringify(payload)', script)
        self.assertIn('SERVER_CONFIG.savedWorkspaces = result.savedWorkspaces || {};', script)
        self.assertIn("SERVER_CONFIG.activeWorkspaceName = result.activeWorkspaceName || '';", script)
        self.assertIn('SERVER_CONFIG.autoOpenLastProject = result.autoOpenLastProject !== false;', script)

    def test_saved_workspace_is_kept_in_the_current_select_list(self) -> None:
        script = (ROOT / "web" / "editor.js").read_text(encoding="utf-8")

        self.assertIn("SERVER_CONFIG.savedWorkspaces = { ...getSavedServerWorkspaces(), [name]: workspace };", script)
        self.assertIn("workspacePresetSelect.querySelector('optgroup[data-saved-workspaces]')?.remove();", script)
        self.assertNotIn("当前服务器版本不支持保存布局", script)

    def test_workspace_select_is_owned_by_editor_not_waveform(self) -> None:
        script = (ROOT / "web" / "editor.js").read_text(encoding="utf-8")
        waveform = (ROOT / "web" / "waveform.js").read_text(encoding="utf-8")

        self.assertNotIn('layoutPresetSelect', waveform)
        self.assertIn('const workspacePresetSelect = document.getElementById(\'workspace-preset\');', script)
        self.assertIn("workspacePresetSelect?.addEventListener('change', () => applyWorkspaceSelection(workspacePresetSelect.value));", script)

    def test_builtin_workspace_save_uses_its_visible_name(self) -> None:
        script = (ROOT / "web" / "editor.js").read_text(encoding="utf-8")

        self.assertIn('function currentWorkspaceDisplayName()', script)
        self.assertIn('const displayName = saveAs ? name : currentWorkspaceDisplayName();', script)
        self.assertIn('已保存工作区：${displayName}', script)
        self.assertIn('[currentBuiltinWorkspaceName]: workspace };', script)

    def test_html_editor_menu_uses_current_labels_and_closes_outside_the_menu(self) -> None:
        page = (ROOT / "web" / "launcher" / "index.html").read_text(encoding="utf-8")
        script = (ROOT / "web" / "launcher" / "launcher.js").read_text(encoding="utf-8")

        self.assertIn("打开该工程的 HTML 编辑器", page)
        self.assertIn("打开空的 HTML 编辑器", page)
        self.assertIn('event.target.closest(".split-wrap")', script)

    def test_launcher_uses_server_as_default_and_hides_mose_in_menu(self) -> None:
        page = (ROOT / "web" / "launcher" / "index.html").read_text(encoding="utf-8")
        script = (ROOT / "web" / "launcher" / "launcher.js").read_text(encoding="utf-8")

        self.assertIn('id="openMawe" class="ghost split-main" type="button" data-i18n="start_server_editor"', page)
        self.assertNotIn('id="openMose"', page)
        self.assertNotIn("在 MOSE 中打开", page)
        self.assertIn('$("openMawe").addEventListener("click", openServerEditor)', script)
        self.assertNotIn("openMose", script)
        self.assertNotIn("open_mose", script)
        self.assertIn('function openServerEditor()', script)
        self.assertIn('bridge("start_server"', script)

    def test_project_change_marks_server_editor_action_for_rebinding(self) -> None:
        script = (ROOT / "web" / "launcher" / "launcher.js").read_text(encoding="utf-8")

        self.assertIn('function setJsonPath(path)', script)
        self.assertIn('$("openMawe").classList.add("attention")', script)
        self.assertIn('state.serverProjectPath', script)

    def test_language_filter_hint_is_available_to_single_language_providers(self) -> None:
        page = (ROOT / "web" / "launcher" / "index.html").read_text(encoding="utf-8")
        script = (ROOT / "web" / "launcher" / "launcher.js").read_text(encoding="utf-8")

        self.assertIn('id="languageFilterHint"', page)
        self.assertIn('language_filter_hint: "默认仅显示常用语言', script)
        self.assertIn('$("languageFilterHint").classList.toggle("hidden", showRare || commons.length === 0);', script)
        self.assertIn("const selectedModel = () =>", script)
        self.assertIn("applyProviderLanguages(provider(), selectedModel())", script)

    def test_qwen_audio_launcher_exposes_one_shot_context_and_hotwords_only(self) -> None:
        page = (ROOT / "web" / "launcher" / "index.html").read_text(encoding="utf-8")
        script = (ROOT / "web" / "launcher" / "launcher.js").read_text(encoding="utf-8")

        for field in ("qwenAudioContext", "qwenAudioHotwordsMode", "qwenAudioHotwords", "qwenAudioHotwordsFile", "qwenAudioHotwordWeight"):
            self.assertIn(f'id="{field}"', page)
        self.assertIn('qwenAudioContext: $("qwenAudioContext").value.trim()', script)
        self.assertIn('qwenAudioHotwords: $("qwenAudioHotwords").value.trim()', script)
        self.assertIn('qwenAudioHotwordsMode: $("qwenAudioHotwordsMode").value', script)
        self.assertIn('qwenAudioHotwordsFile: $("qwenAudioHotwordsFile").value.trim()', script)
        self.assertIn('kind: "hotwords"', script)
        self.assertIn('read_hotword_file', script)
        self.assertIn('qwenAudioContextCount', page)
        self.assertIn('classList.toggle("over-limit", count > 400)', script)
        self.assertIn('qwenAudioHotwordsWarning', page)
        self.assertIn('qwen_audio_hotwords_weight_override_hint', script)
        self.assertIn('parseHotwordEntry', script)
        self.assertIn('MAX_SUPER_HOTWORDS = 50', script)
        self.assertNotIn('id="qwenAudioVocabularyId"', page)
        self.assertNotIn("qwenAudioVocabularyId", script)
        self.assertIn('supportsContext', script)

    def test_soniox_launcher_exposes_documented_context_sections(self) -> None:
        page = (ROOT / "web" / "launcher" / "index.html").read_text(encoding="utf-8")
        script = (ROOT / "web" / "launcher" / "launcher.js").read_text(encoding="utf-8")
        stylesheet = (ROOT / "web" / "launcher" / "launcher.css").read_text(encoding="utf-8")

        for field in (
            "sonioxContextGeneral",
            "sonioxContextText",
            "sonioxContextTerms",
            "sonioxContextTranslationTerms",
        ):
            self.assertIn(f'id="{field}"', page)
        self.assertIn('sonioxContextGeneral: $("sonioxContextGeneral").value.trim()', script)
        self.assertIn('sonioxContextTranslationTerms: $("sonioxContextTranslationTerms").value.trim()', script)
        self.assertIn("soniox_context_count", script)
        self.assertIn("soniox_context_too_long", script)
        self.assertIn('id="sonioxContextCount"', page)
        self.assertNotIn('id="sonioxContextTextCount"', page)
        self.assertNotIn('$("sonioxContextTextCount")', script)
        self.assertIn('soniox_context_text_hint: "适合会议摘要、脚本或参考文档。"', script)
        self.assertIn('soniox_context_text_hint: "Use for summaries, scripts, or reference documents."', script)
        self.assertIn('href="https://soniox.com/docs/stt/concepts/context"', page)
        self.assertIn('soniox_context_docs_link: "查看 context 文档 ↗"', script)
        self.assertIn(
            ".soniox-context-options-grid > .field:first-child {\n  margin-top: 10px;\n}",
            stylesheet,
        )
        self.assertIn(
            ".soniox-context-count {\n  margin-top: 10px;\n}",
            stylesheet,
        )

    def test_multilanguage_launcher_uses_full_width_language_layout(self) -> None:
        page = (ROOT / "web" / "launcher" / "index.html").read_text(encoding="utf-8")
        stylesheet = (ROOT / "web" / "launcher" / "launcher.css").read_text(encoding="utf-8")

        self.assertIn('class="language-layout"', page)
        self.assertIn('class="language-side"', page)
        self.assertIn('id="languageGroup" class="adv-group"', page)
        self.assertIn(
            ".adv-group {\n  grid-column: 1 / -1;\n  display: grid;",
            stylesheet,
        )
        self.assertIn(
            ".grid-two:not(.single-language) #languageField .language-layout {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr) minmax(220px, .8fr);",
            stylesheet,
        )
        self.assertIn(
            ".grid-two:not(.single-language) #languageField #language {\n  height: 132px;\n  max-height: 132px;\n}",
            stylesheet,
        )

    def test_advanced_options_are_grouped_into_titled_cards(self) -> None:
        page = (ROOT / "web" / "launcher" / "index.html").read_text(encoding="utf-8")
        script = (ROOT / "web" / "launcher" / "launcher.js").read_text(encoding="utf-8")
        stylesheet = (ROOT / "web" / "launcher" / "launcher.css").read_text(encoding="utf-8")

        self.assertIn('id="segmentationField" class="adv-group segmentation-field"', page)
        self.assertIn('id="advancedParamsGroup" class="adv-group"', page)
        self.assertIn("function syncAdvancedParamsGroup()", script)
        self.assertIn("syncWorkspace(); syncAdvancedParamsGroup();", script)
        self.assertIn('id="qwenAudioOptions" class="adv-group qwen-audio-options hidden"', page)
        self.assertIn('id="sonioxContextOptions" class="adv-group soniox-context-options hidden"', page)
        self.assertIn('data-i18n="advanced_params"', page)
        self.assertIn('data-i18n="advanced_misc"', page)
        self.assertIn('data-i18n="qwen_audio_options_title"', page)
        self.assertIn('advanced_params: "识别参数"', script)
        self.assertIn('advanced_misc: "其他"', script)
        self.assertIn('qwen_audio_options_title: "Qwen 上下文与热词"', script)
        self.assertIn('gap_split_placeholder: "默认 1500"', script)
        self.assertIn('gap_split_placeholder: "Default: 1500"', script)
        self.assertIn("停顿切句：云端 1500ms，本地 1000ms", script)
        self.assertIn("pause split: cloud 1500 ms, local 1000 ms", script)
        self.assertIn('$("languageGroup").classList.toggle("hidden", current.supportsLanguage === false)', script)
        self.assertIn(".advanced-col {\n  display: grid;\n  grid-template-columns: 1fr 1fr;", stylesheet)
        self.assertNotIn("display: contents", stylesheet)

    def test_regional_fields_are_temporarily_hidden_for_domestic_launcher(self) -> None:
        page = (ROOT / "web" / "launcher" / "index.html").read_text(encoding="utf-8")
        script = (ROOT / "web" / "launcher" / "launcher.js").read_text(encoding="utf-8")

        self.assertIn('id="regionField" class="field hidden"', page)
        self.assertIn('id="workspaceField" class="field hidden"', page)
        self.assertIn("北京地域选填（推荐），新加坡地域必填。", page)
        self.assertIn(
            "const SHOW_REGIONAL_FIELDS = false;",
            script,
        )
        self.assertIn(
            '$("regionField").classList.toggle("hidden", !SHOW_REGIONAL_FIELDS || current.regions.length === 0);',
            script,
        )
        self.assertIn(
            '$("workspaceField").classList.toggle("hidden", !SHOW_REGIONAL_FIELDS || provider().regions.length === 0);',
            script,
        )
        self.assertIn('data.region === "singapore" && !data.workspaceId', script)

    def test_launcher_section_titles_share_emoji_numbering_and_size(self) -> None:
        page = (ROOT / "web" / "launcher" / "index.html").read_text(encoding="utf-8")
        stylesheet = (ROOT / "web" / "launcher" / "launcher.css").read_text(encoding="utf-8")

        for expected in ("1️⃣ 媒体与输出", "2️⃣ 识别设置", "3️⃣ 转写后自动处理", "4️⃣ 日志", "5️⃣ 字幕编辑器设置"):
            self.assertIn(expected, page)
        self.assertIn(".card h2 {\n  margin: 0 0 12px;\n  color: var(--text-secondary);\n  font-size: 16px;", stylesheet)

    def test_server_start_button_exposes_disabled_starting_state(self) -> None:
        script = (ROOT / "web" / "launcher" / "launcher.js").read_text(encoding="utf-8")

        self.assertIn('const SERVER_STARTING_TEXT = { zh: "启动中……", en: "Starting…" };', script)
        self.assertIn("button.disabled = state.serverStarting;", script)
        self.assertIn("state.serverStarting = true;", script)
        self.assertIn("state.serverStarting = false;", script)
        self.assertIn("guiLang: state.lang", script)

    def test_local_model_preparation_exposes_progress_events_and_cache_heartbeat(self) -> None:
        script = (ROOT / "web" / "launcher" / "launcher.js").read_text(encoding="utf-8")
        local_models = (ROOT / "maw" / "local_models.py").read_text(encoding="utf-8")
        backend = (ROOT / "maw" / "gui_web.py").read_text(encoding="utf-8")

        self.assertIn('event.type === "modelProgress"', script)
        self.assertIn('event.type === "localPrepareCancelled"', script)
        self.assertIn("localProgressMessage", script)
        self.assertIn('bridge("cancel_local_model"', script)
        self.assertIn("已等待", local_models)
        self.assertIn("_prepare_progress_payload", local_models)
        self.assertIn("estimatedMinBytes", local_models)
        self.assertIn('"type": "modelProgress"', backend)
        self.assertIn('"type": "localPrepareCancelled"', backend)

    def test_local_model_paths_are_scoped_to_the_selected_model(self) -> None:
        script = (ROOT / "web" / "launcher" / "launcher.js").read_text(encoding="utf-8")

        self.assertIn("localModelPaths", script)
        self.assertIn("syncLocalModelPath(model)", script)
        self.assertIn('status.status === "path_mismatch"', script)

    def test_local_runtime_installation_has_separate_progress_and_repair_controls(self) -> None:
        page = (ROOT / "web" / "launcher" / "index.html").read_text(encoding="utf-8")
        script = (ROOT / "web" / "launcher" / "launcher.js").read_text(encoding="utf-8")
        backend = (ROOT / "maw" / "gui_web.py").read_text(encoding="utf-8")

        self.assertIn('id="installLocalRuntime"', page)
        self.assertIn('id="localRuntimeProgressBar"', page)
        self.assertIn('id="localModelProgress"', page)
        self.assertIn('id="localModelProgressBar"', page)
        self.assertIn('bridge("install_local_runtime"', script)
        self.assertIn('event.type === "localRuntimeProgress"', script)
        self.assertIn('event.type === "localRuntimeReady"', script)
        self.assertIn('def install_local_runtime(', backend)
        self.assertIn('def cancel_local_runtime(', backend)

    def test_model_cache_path_saves_without_a_separate_button(self) -> None:
        page = (ROOT / "web" / "launcher" / "index.html").read_text(encoding="utf-8")
        script = (ROOT / "web" / "launcher" / "launcher.js").read_text(encoding="utf-8")

        self.assertNotIn('id="saveLocalModelCache"', page)
        self.assertIn('$("localModelCachePath").addEventListener("change"', script)
        self.assertIn('saveLocalModelCache($("localModelCachePath").value)', script)

    def test_attention_button_keeps_amber_hover_style(self) -> None:
        stylesheet = (ROOT / "web" / "launcher" / "launcher.css").read_text(encoding="utf-8")

        self.assertIn(".ghost.attention:hover:not(:disabled)", stylesheet)
        self.assertIn("border-color: var(--amber-hover);", stylesheet)


@final
class DefaultPathsTests(unittest.TestCase):
    def test_default_paths_resolves_frozen_meipass_root(self) -> None:
        """Given PyInstaller 冻结环境, When 解析默认路径, Then 资源根为 _MEIPASS。"""
        with mock.patch.object(sys, "frozen", True, create=True), mock.patch.object(sys, "_MEIPASS", "/opt/app/_internal", create=True):
            paths = default_paths()
        self.assertEqual(paths.launcher_html, Path("/opt/app/_internal/web/launcher/index.html"))
        self.assertEqual(paths.root, Path("/opt/app/_internal"))

    def test_default_paths_uses_repo_root_when_not_frozen(self) -> None:
        """Given 源码运行, When 解析默认路径, Then 资源根为仓库根。"""
        self.assertFalse(getattr(sys, "frozen", False))
        paths = default_paths()
        self.assertEqual(paths.launcher_html, ROOT / "web" / "launcher" / "index.html")


class _FakeUrlResponse:
    def __init__(self, status: int, body: bytes) -> None:
        self.status = status
        self._body = body
        self._offset = 0

    def read(self, size: int = -1) -> bytes:
        if size is None or size < 0:
            chunk = self._body[self._offset :]
        else:
            chunk = self._body[self._offset : self._offset + size]
        self._offset += len(chunk)
        return chunk

    def __enter__(self) -> _FakeUrlResponse:
        return self

    def __exit__(self, *exc_info: object) -> bool:
        return False


@final
class EmojiFontTests(unittest.TestCase):
    """Linux keycap 表情字体（Noto Color Emoji）的下载、校验与 API 契约。"""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def _write(self, name: str, data: bytes) -> Path:
        path = self.root / name
        path.write_bytes(data)
        return path

    def test_valid_emoji_font_accepts_true_type_magic(self) -> None:
        """Given 足够大且带 TrueType 魔数的文件, When 校验, Then 判定为有效缓存。"""
        path = self._write("ok.ttf", b"\x00\x01\x00\x00" + b"\0" * 2_000_000)

        self.assertTrue(_valid_emoji_font(path))

    def test_valid_emoji_font_rejects_small_garbage_and_missing(self) -> None:
        """Given 过小 / HTML 错误页 / 不存在的文件, When 校验, Then 全部判定无效。"""
        small = self._write("small.ttf", b"\x00\x01\x00\x00" + b"\0" * 10)
        html = self._write("html.ttf", b"<html>error</html>" + b"\0" * 2_000_000)

        self.assertFalse(_valid_emoji_font(small))
        self.assertFalse(_valid_emoji_font(html))
        self.assertFalse(_valid_emoji_font(self.root / "missing.ttf"))

    def test_emoji_font_urls_default_order_and_env_override(self) -> None:
        """Given 默认配置, When 取下载地址, Then 主 CDN 在前；MAW_EMOJI_FONT_URL 可整体覆盖。"""
        with mock.patch.dict(os.environ, {}, clear=True):
            urls = _emoji_font_urls()
            self.assertIn("https://cdn.jsdelivr.net/gh/googlefonts/noto-emoji@main/fonts/NotoColorEmoji.ttf", urls)
            self.assertEqual(urls[0], "https://cdn.jsdelivr.net/gh/googlefonts/noto-emoji@main/fonts/NotoColorEmoji.ttf")

        with mock.patch.dict(os.environ, {"MAW_EMOJI_FONT_URL": "https://mirror.example/font.ttf"}, clear=True):
            urls = _emoji_font_urls()
            self.assertEqual(urls[0], "https://mirror.example/font.ttf")
            self.assertIn("https://cdn.jsdelivr.net/gh/googlefonts/noto-emoji@main/fonts/NotoColorEmoji.ttf", urls)

    def test_download_emoji_font_success_writes_cache(self) -> None:
        """Given 第一个 URL 返回 200 且体积足够, When 下载, Then 写入 dest 且清理 .part。"""
        dest = self.root / "cache" / "NotoColorEmoji.ttf"
        payload = b"\x00\x01\x00\x00" + b"\0" * 2_000_000

        with mock.patch("maw.gui_web.urlopen", side_effect=[_FakeUrlResponse(200, payload)]):
            result = download_emoji_font(["https://ok.example/font.ttf"], dest, timeout=1)

        self.assertEqual(result, dest)
        self.assertEqual(dest.read_bytes(), payload)
        self.assertFalse((self.root / "cache" / "NotoColorEmoji.ttf.part").exists())

    def test_download_emoji_font_falls_through_failed_urls(self) -> None:
        """Given 首个 URL 抛异常 / 404 / 体积不足, When 下载, Then 依次回退到可用 URL。"""
        dest = self.root / "cache" / "NotoColorEmoji.ttf"
        payload = b"\x00\x01\x00\x00" + b"\0" * 2_000_000

        with mock.patch(
            "maw.gui_web.urlopen",
            side_effect=[URLError("blocked"), _FakeUrlResponse(404, b"nope"), _FakeUrlResponse(200, payload)],
        ):
            result = download_emoji_font(
                ["https://a.example/font.ttf", "https://b.example/font.ttf", "https://c.example/font.ttf"],
                dest,
                timeout=1,
            )

        self.assertEqual(result, dest)
        self.assertEqual(dest.read_bytes(), payload)

    def test_download_emoji_font_all_fail_cleans_partial(self) -> None:
        """Given 所有 URL 都失败, When 下载, Then 返回 None 且不留 .part 残留。"""
        dest = self.root / "cache" / "NotoColorEmoji.ttf"

        with mock.patch("maw.gui_web.urlopen", side_effect=[URLError("blocked"), _FakeUrlResponse(404, b"nope")]):
            result = download_emoji_font(["https://a.example/font.ttf", "https://b.example/font.ttf"], dest, timeout=1)

        self.assertIsNone(result)
        self.assertFalse((self.root / "cache" / "NotoColorEmoji.ttf.part").exists())

    def test_get_emoji_font_path_non_linux_returns_empty(self) -> None:
        """Given Windows/macOS, When 询问字体路径, Then 返回空且不下载。"""
        api = LauncherApi()

        with mock.patch("maw.gui_web.sys.platform", "win32"), mock.patch.object(api, "_start_emoji_font_download") as start:
            result = api.get_emoji_font_path()

        self.assertEqual(result, {"ok": True, "path": ""})
        start.assert_not_called()

    def test_get_emoji_font_path_linux_with_cache_returns_uri(self) -> None:
        """Given Linux 且缓存已存在, When 询问字体路径, Then 直接返回 file:// URI。"""
        api = LauncherApi()
        dest = self.root / "cache" / "NotoColorEmoji.ttf"
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(b"\x00\x01\x00\x00" + b"\0" * 2_000_000)

        with mock.patch("maw.gui_web.sys.platform", "linux"), mock.patch("maw.gui_web._emoji_font_cache_path", return_value=dest):
            result = api.get_emoji_font_path()

        self.assertEqual(result, {"ok": True, "path": dest.as_uri()})

    def test_get_emoji_font_path_linux_missing_starts_background_download(self) -> None:
        """Given Linux 且缓存缺失, When 询问字体路径, Then 返回空并启动后台下载。"""
        api = LauncherApi()
        dest = self.root / "cache" / "NotoColorEmoji.ttf"

        with mock.patch("maw.gui_web.sys.platform", "linux"), mock.patch(
            "maw.gui_web._emoji_font_cache_path", return_value=dest
        ), mock.patch.object(api, "_start_emoji_font_download") as start:
            result = api.get_emoji_font_path()

        self.assertEqual(result, {"ok": True, "path": ""})
        start.assert_called_once_with(dest)

    def test_download_worker_enqueues_ready_event_on_success(self) -> None:
        """Given 下载成功, When 后台线程收尾, Then 向页面推送 emojiFontReady 事件。"""
        api = LauncherApi()
        dest = self.root / "cache" / "NotoColorEmoji.ttf"

        with mock.patch("maw.gui_web.download_emoji_font", return_value=dest):
            api._download_emoji_font_worker(dest)

        event = api.pump.events.get_nowait()
        self.assertEqual(event["type"], "emojiFontReady")
        self.assertEqual(event["path"], dest.as_uri())

    def test_download_worker_is_silent_on_failure(self) -> None:
        """Given 下载失败, When 后台线程收尾, Then 不推送事件（页面回退系统字体）。"""
        api = LauncherApi()

        with mock.patch("maw.gui_web.download_emoji_font", return_value=None):
            api._download_emoji_font_worker(self.root / "missing.ttf")

        self.assertTrue(api.pump.events.empty())

    def test_emoji_font_event_delivered_on_first_launch_when_pump_starts_after_download(self) -> None:
        """Given 首次启动时字体下载在 pump 启动前完成, When pump 启动, Then 事件被送达页面。

        这覆盖了首次 Linux 启动的场景：window loaded 事件触发前字体下载已完成，
        事件进入队列但 pump 尚未启动；loaded 触发后 pump.start() 被调用，
        队列中的事件应立即 flush 到前端。
        """
        window = FakeWindow()
        api = LauncherApi(window_getter=lambda: window)
        dest = self.root / "cache" / "NotoColorEmoji.ttf"

        # 模拟下载在 pump 启动前完成
        with mock.patch("maw.gui_web.download_emoji_font", return_value=dest):
            api._download_emoji_font_worker(dest)

        # 此时事件在队列中，但未送达页面
        self.assertFalse(api.pump.events.empty())
        self.assertEqual(len(window.scripts), 0)

        # 模拟 window.events.loaded 触发，启动 pump
        api.pump.start()

        # 等待 pump flush（pump 每 0.1 秒 flush 一次）
        import time
        deadline = time.time() + 2.0
        while time.time() < deadline and len(window.scripts) == 0:
            time.sleep(0.05)

        api.pump.shutdown()

        # 验证事件已送达页面
        self.assertGreater(len(window.scripts), 0)
        self.assertIn("emojiFontReady", window.scripts[-1])
        self.assertIn(dest.as_uri(), window.scripts[-1])


if __name__ == "__main__":
    unittest.main()
