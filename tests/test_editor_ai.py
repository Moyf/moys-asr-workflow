# pyright: reportAny=false, reportUnknownVariableType=false, reportUnknownMemberType=false

"""编辑器 AI 辅助后端测试：共享 LLM 设置读写与后台任务注册表。"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from maw import editor_ai
from maw.gui_config import load_env, save_env
from maw.postprocess_llm import LlmClientError, PRESETS


ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "server-editor" / "serve.py"
SPEC = importlib.util.spec_from_file_location("asr_local_editor_server_ai", SERVER_PATH)
assert SPEC and SPEC.loader
server_editor = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = server_editor
SPEC.loader.exec_module(server_editor)


class EditorAiSettingsTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.env_path = Path(self._tmp.name) / ".env"

    def tearDown(self) -> None:
        for key in list(os.environ):
            if key.startswith("MAW_POSTPROCESS_") or key == "DASHSCOPE_API_KEY":
                os.environ.pop(key, None)

    def test_read_settings_defaults_to_deepseek_and_lists_all_presets(self) -> None:
        payload = editor_ai.read_settings(self.env_path)
        self.assertEqual(payload["providerId"], "deepseek")
        self.assertEqual([provider["id"] for provider in payload["providers"]],
                         [preset.id for preset in PRESETS])
        self.assertFalse(payload["hasApiKey"])
        self.assertTrue(payload["apiKeyRequired"])

    def test_write_settings_round_trip_without_echoing_api_key(self) -> None:
        payload = editor_ai.write_settings(self.env_path, {
            "providerId": "custom",
            "baseUrl": "http://127.0.0.1:1234/v1",
            "model": "qwen3-32b",
            "apiKey": "sk-secret-value-42",
            "reasoningMode": "high",
        })
        self.assertEqual(payload["providerId"], "custom")
        self.assertEqual(payload["baseUrl"], "http://127.0.0.1:1234/v1")
        self.assertEqual(payload["model"], "qwen3-32b")
        self.assertEqual(payload["reasoningMode"], "high")
        # 掩码可以带前后缀，但绝不能携带完整 key。
        self.assertNotIn("sk-secret-value-42", json.dumps(payload, ensure_ascii=False))
        self.assertTrue(payload["hasApiKey"])

        stored = load_env(self.env_path)
        prefix = "MAW_POSTPROCESS_CUSTOM"
        self.assertEqual(stored.get(f"{prefix}_API_KEY"), "sk-secret-value-42")
        self.assertEqual(stored.get(f"{prefix}_BASE_URL"), "http://127.0.0.1:1234/v1")
        self.assertEqual(stored.get(f"{prefix}_MODEL"), "qwen3-32b")
        self.assertEqual(stored.get(f"{prefix}_REASONING_MODE"), "high")
        self.assertEqual(stored.get(editor_ai.LAST_PROVIDER_ENV_KEY), "custom")

    def test_write_settings_empty_api_key_keeps_existing_and_clear_flag_removes(self) -> None:
        editor_ai.write_settings(self.env_path, {"providerId": "deepseek", "apiKey": "sk-first-key-1"})
        editor_ai.write_settings(self.env_path, {"providerId": "deepseek", "apiKey": ""})
        self.assertEqual(load_env(self.env_path).get("MAW_POSTPROCESS_DEEPSEEK_API_KEY"), "sk-first-key-1")
        editor_ai.write_settings(self.env_path, {"providerId": "deepseek", "clearApiKey": True})
        self.assertEqual(load_env(self.env_path).get("MAW_POSTPROCESS_DEEPSEEK_API_KEY", ""), "")

    def test_write_settings_rejects_unknown_provider_and_bad_reasoning(self) -> None:
        with self.assertRaises(ValueError):
            editor_ai.write_settings(self.env_path, {"providerId": "nope"})
        with self.assertRaises(ValueError):
            editor_ai.write_settings(self.env_path, {"providerId": "deepseek", "reasoningMode": "ultra"})

    def test_resolve_llm_settings_builds_call_settings_from_env(self) -> None:
        save_env(self.env_path, {
            "MAW_POSTPROCESS_ZHIPU_API_KEY": "key-zhipu-9",
            "MAW_POSTPROCESS_ZHIPU_MODEL": "glm-5.2",
            "MAW_POSTPROCESS_ZHIPU_REASONING_MODE": "medium",
            editor_ai.LAST_PROVIDER_ENV_KEY: "zhipu",
        })
        settings = editor_ai.resolve_llm_settings(self.env_path)
        self.assertEqual(settings.provider_id, "zhipu")
        self.assertEqual(settings.api_key, "key-zhipu-9")
        self.assertEqual(settings.model, "glm-5.2")
        self.assertEqual(settings.reasoning_mode, "medium")
        override = editor_ai.resolve_llm_settings(self.env_path, "deepseek")
        self.assertEqual(override.provider_id, "deepseek")

    def test_provider_payload_marks_custom_slots_and_loopback_key_optional(self) -> None:
        editor_ai.write_settings(self.env_path, {
            "providerId": "custom2",
            "baseUrl": "http://localhost:8080/v1",
        })
        providers = {provider["id"]: provider for provider in editor_ai.provider_payloads(self.env_path)}
        self.assertTrue(providers["custom2"]["custom"])
        self.assertFalse(providers["custom2"]["apiKeyRequired"])
        self.assertTrue(providers["custom2"]["selected"])
        self.assertFalse(providers["deepseek"]["custom"])
        self.assertFalse(providers["deepseek"]["selected"])
        self.assertTrue(providers["deepseek"]["apiKeyRequired"])


class _EditorAiTaskTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.env_path = Path(self._tmp.name) / ".env"


class EditorAiTaskManagerTests(_EditorAiTaskTestBase):
    def test_submit_unknown_kind_is_rejected(self) -> None:
        manager = editor_ai.AiTaskManager(self.env_path)
        with self.assertRaises(editor_ai.AiTaskError):
            manager.submit("nope", {})

    def test_successful_task_transitions_to_done_with_result(self) -> None:
        runner = mock.Mock(return_value={"ok": True})
        manager = editor_ai.AiTaskManager(self.env_path, runners={"test-connection": runner})
        snapshot = manager.submit("test-connection", {"providerId": "deepseek"})
        self.assertEqual(snapshot["status"], "queued")
        self.assertTrue(manager.wait_until_idle())
        final = manager.snapshot(snapshot["id"])
        self.assertEqual(final["status"], "done")
        self.assertEqual(final["result"], {"ok": True})
        self.assertEqual(final["percent"], 100)
        runner.assert_called_once()
        env_path, payload, _report, cancel = runner.call_args.args
        self.assertEqual(env_path, self.env_path)
        self.assertEqual(payload, {"providerId": "deepseek"})
        self.assertFalse(cancel())

    def test_task_payload_is_not_exposed_in_snapshot(self) -> None:
        captured: dict[str, object] = {}

        def runner(env_path, payload, report, cancel):  # noqa: ANN001, ANN202
            captured.update(payload)
            report("working", 55)
            # 运行中抓一次全量快照：percent 应已记录，payload 不应外泄。
            captured["runningSnapshot"] = manager.snapshot()
            return {}

        manager = editor_ai.AiTaskManager(self.env_path, runners={"probe": runner})
        snapshot = manager.submit("probe", {"secretValue": "x"})
        manager.wait_until_idle()
        self.assertNotIn("payload", json.dumps(snapshot))
        self.assertNotIn("secretValue", json.dumps(manager.snapshot()))
        self.assertEqual(captured["secretValue"], "x")
        running_task = captured["runningSnapshot"]["tasks"][0]
        self.assertEqual(running_task["status"], "running")
        self.assertEqual(running_task["percent"], 55)

    def test_llm_error_becomes_error_state_with_message(self) -> None:
        def runner(env_path, payload, report, cancel):  # noqa: ANN001, ANN202
            raise LlmClientError("LLM provider returned HTTP 401.")

        manager = editor_ai.AiTaskManager(self.env_path, runners={"test-connection": runner})
        snapshot = manager.submit("test-connection", {})
        manager.wait_until_idle()
        final = manager.snapshot(snapshot["id"])
        self.assertEqual(final["status"], "error")
        self.assertIn("401", final["error"])
        self.assertEqual(final["result"], None)

    def test_cancel_marks_cancelled_task_and_runner_sees_event(self) -> None:
        started = threading.Event()
        release = threading.Event()

        def runner(env_path, payload, report, cancel):  # noqa: ANN001, ANN202
            started.set()
            release.wait(5)
            return {"cancelledSeen": cancel()}

        manager = editor_ai.AiTaskManager(self.env_path, runners={"slow": runner})
        snapshot = manager.submit("slow", {})
        self.assertTrue(started.wait(5))
        self.assertTrue(manager.cancel(snapshot["id"]))
        release.set()
        manager.wait_until_idle()
        final = manager.snapshot(snapshot["id"])
        self.assertEqual(final["status"], "cancelled")
        self.assertFalse(manager.cancel(snapshot["id"]))

    def test_history_is_pruned_to_limit_and_drops_finished_first(self) -> None:
        manager = editor_ai.AiTaskManager(self.env_path, runners={"noop": lambda *args: {}}, history_limit=3)
        ids = [manager.submit("noop", {})["id"] for _ in range(5)]
        manager.wait_until_idle()
        tasks = manager.snapshot()["tasks"]
        self.assertLessEqual(len(tasks), 3)
        self.assertIn(ids[-1], [task["id"] for task in tasks])

    def test_snapshot_of_missing_task_raises(self) -> None:
        manager = editor_ai.AiTaskManager(self.env_path)
        with self.assertRaises(editor_ai.AiTaskError):
            manager.snapshot("missing-id")


class EditorAiHandlerTests(_EditorAiTaskTestBase):
    def _handler(self, request: dict) -> object:
        handler = object.__new__(server_editor.EditorRequestHandler)
        handler.server = mock.Mock()
        handler.server.request_token = "test-token"
        handler.server.ai_tasks = mock.Mock()
        handler.server.ai_tasks.submit = mock.Mock(return_value={"ok": True, "id": "t1", "status": "queued"})
        handler.server.ai_tasks.cancel = mock.Mock(return_value=True)
        handler.send_json = mock.Mock()
        handler.read_json_request = mock.Mock(return_value=request)
        return handler

    def test_task_poll_sends_only_one_response(self) -> None:
        handler = self._handler({})
        handler.path = "/api/ai/tasks"
        handler.server.ai_tasks.snapshot.return_value = {"ok": True, "tasks": []}
        handler.send_localized_error = mock.Mock()
        handler.handle_request(include_body=True)
        handler.send_json.assert_called_once_with(200, {"ok": True, "tasks": []})
        handler.send_localized_error.assert_not_called()

    def test_update_ai_settings_requires_token(self) -> None:
        handler = self._handler({"requestToken": "wrong", "providerId": "deepseek"})
        handler.update_ai_settings()
        self.assertEqual(handler.send_json.call_args.args[0], 403)

    def test_update_ai_settings_rejects_unknown_provider(self) -> None:
        handler = self._handler({"requestToken": "test-token", "providerId": "nope"})
        handler.update_ai_settings()
        status, payload = handler.send_json.call_args.args
        self.assertEqual(status, 400)
        self.assertFalse(payload["ok"])

    def test_update_ai_settings_writes_and_returns_payload(self) -> None:
        handler = self._handler({
            "requestToken": "test-token",
            "providerId": "custom",
            "baseUrl": "http://127.0.0.1:1234/v1",
            "model": "test-model",
            "apiKey": "sk-handler-key-1",
        })
        with mock.patch.object(server_editor, "DEFAULT_ENV_PATH", self.env_path):
            handler.update_ai_settings()
        status, payload = handler.send_json.call_args.args
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertNotIn("sk-handler-key-1", json.dumps(payload))
        stored = load_env(self.env_path)
        self.assertEqual(stored.get("MAW_POSTPROCESS_CUSTOM_MODEL"), "test-model")

    def test_start_ai_task_requires_token_and_kind(self) -> None:
        handler = self._handler({"requestToken": "wrong", "kind": "test-connection"})
        handler.start_ai_task()
        self.assertEqual(handler.send_json.call_args.args[0], 403)

        handler = self._handler({"requestToken": "test-token"})
        handler.start_ai_task()
        self.assertEqual(handler.send_json.call_args.args[0], 400)

    def test_start_ai_task_submits_and_returns_snapshot(self) -> None:
        handler = self._handler({"requestToken": "test-token", "kind": "test-connection",
                                 "payload": {"providerId": "qwen"}})
        handler.start_ai_task()
        status, payload = handler.send_json.call_args.args
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["task"]["status"], "queued")
        handler.server.ai_tasks.submit.assert_called_once_with("test-connection", {"providerId": "qwen"})

    def test_start_ai_task_rejects_unknown_kind(self) -> None:
        handler = self._handler({"requestToken": "test-token", "kind": "missing-kind"})
        handler.server.ai_tasks.submit = mock.Mock(side_effect=editor_ai.AiTaskError("未知的 AI 任务类型"))
        handler.start_ai_task()
        self.assertEqual(handler.send_json.call_args.args[0], 400)

    def test_cancel_ai_task_requires_token_and_reports_result(self) -> None:
        handler = self._handler({"requestToken": "wrong", "id": "t1"})
        handler.cancel_ai_task()
        self.assertEqual(handler.send_json.call_args.args[0], 403)

        handler = self._handler({"requestToken": "test-token", "id": "t1"})
        handler.cancel_ai_task()
        status, payload = handler.send_json.call_args.args
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])


class EditorAiTextTaskTests(_EditorAiTaskTestBase):
    """ai-bold / ai-translate / ai-emoji 共用 runner 的行为契约。"""

    def _write_custom_slot(self) -> None:
        # custom 槽位回环地址免密钥，测试无需真实 Key。
        editor_ai.write_settings(self.env_path, {
            "providerId": "custom",
            "baseUrl": "http://127.0.0.1:1234/v1",
            "model": "test-model",
        })

    def _run_kind(self, kind: str, payload: dict) -> tuple[object, object]:
        self._write_custom_slot()
        captured: dict[str, object] = {}

        def fake_complete(settings, prompt, cues, **kwargs):  # noqa: ANN001, ANN202
            captured["settings"] = settings
            captured["prompt"] = prompt
            captured["cues"] = cues
            captured["cancel"] = kwargs.get("is_cancelled")
            return {"groups": [
                {"source_ids": ["c1"], "text": "**你好**"},
                {"source_ids": ["c2"], "text": "hello world"},
            ]}

        with mock.patch("maw.postprocess_llm.complete_subtitle_groups", fake_complete):
            manager = editor_ai.AiTaskManager(self.env_path)
            snapshot = manager.submit(kind, payload)
            self.assertTrue(manager.wait_until_idle())
            return manager.snapshot(snapshot["id"]), captured

    def test_bold_task_returns_text_map_without_leaking_prompt(self) -> None:
        final, captured = self._run_kind("ai-bold", {"cues": [
            {"id": "c1", "text": "你好世界"},
            {"id": "c2", "text": "hello world"},
        ]})
        self.assertEqual(final["status"], "done")
        self.assertEqual(final["result"], {"texts": {"c1": "**你好**", "c2": "hello world"}})
        # 默认使用 zh 预设；payload 里的字幕快照原样进入 LLM 调用。
        self.assertIn("字幕排版助手", captured["prompt"])
        self.assertEqual(captured["cues"], [
            {"id": "c1", "text": "你好世界"},
            {"id": "c2", "text": "hello world"},
        ])
        settings = captured["settings"]
        self.assertEqual(settings.provider_id, "custom")
        self.assertEqual(settings.model, "test-model")

    def test_text_task_uses_custom_prompt_over_preset_and_lang_variant(self) -> None:
        _, captured = self._run_kind("ai-emoji", {
            "cues": [{"id": "c1", "text": "测试"}],
            "lang": "zh",
            "customPrompt": "MY CUSTOM PROMPT",
        })
        self.assertEqual(captured["prompt"], "MY CUSTOM PROMPT")

        _, captured = self._run_kind("ai-translate", {
            "cues": [{"id": "c1", "text": "hello"}],
            "lang": "en",
        })
        self.assertIn("spoken English", captured["prompt"])

    def test_text_task_reports_progress_stages(self) -> None:
        self._write_custom_slot()
        stages: list[str] = []

        def fake_complete(settings, prompt, cues, **kwargs):  # noqa: ANN001, ANN202
            return {"groups": [{"source_ids": ["c1"], "text": "x"}]}

        def runner(env_path, payload, report, cancel):  # noqa: ANN001, ANN202
            return editor_ai.run_ai_text_task("ai-bold", env_path, payload, 
                                              lambda stage, percent: stages.append(stage), cancel)

        with mock.patch("maw.postprocess_llm.complete_subtitle_groups", fake_complete):
            manager = editor_ai.AiTaskManager(self.env_path, runners={"ai-bold": runner})
            snapshot = manager.submit("ai-bold", {"cues": [{"id": "c1", "text": "文本"}]})
            manager.wait_until_idle()
        final = manager.snapshot(snapshot["id"])
        self.assertEqual(final["status"], "done")
        self.assertEqual(stages, ["connecting", "waiting_provider", "done"])

    def test_text_task_rejects_empty_and_over_limit_cues(self) -> None:
        self._write_custom_slot()
        manager = editor_ai.AiTaskManager(self.env_path)
        snapshot = manager.submit("ai-bold", {"cues": []})
        manager.wait_until_idle()
        final = manager.snapshot(snapshot["id"])
        self.assertEqual(final["status"], "error")
        self.assertIn("没有可处理的字幕文本", final["error"])

        snapshot = manager.submit("ai-bold", {
            "cues": [{"id": f"c{i}", "text": f"t{i}"} for i in range(editor_ai.TEXT_TASK_MAX_CUES + 1)],
        })
        manager.wait_until_idle()
        final = manager.snapshot(snapshot["id"])
        self.assertEqual(final["status"], "error")
        self.assertIn(str(editor_ai.TEXT_TASK_MAX_CUES), final["error"])

    def test_collect_group_texts_ignores_multi_source_unknown_and_empty(self) -> None:
        texts = editor_ai.collect_group_texts({"groups": [
            {"source_ids": ["c1"], "text": "ok"},
            {"source_ids": ["c1", "c2"], "text": "merged"},
            {"source_ids": ["ghost"], "text": "unknown"},
            {"source_ids": ["c2"], "text": "   "},
            "not-a-group",
        ]}, [{"id": "c1", "text": "a"}, {"id": "c2", "text": "b"}])
        self.assertEqual(texts, {"c1": "ok"})


class EditorAiStructureTaskTests(_EditorAiTaskTestBase):
    """ai-smart-merge / ai-suggest-split / ai-timecode-items 的行为契约。"""

    def _write_custom_slot(self) -> None:
        editor_ai.write_settings(self.env_path, {
            "providerId": "custom",
            "baseUrl": "http://127.0.0.1:1234/v1",
            "model": "test-model",
        })

    def _run_kind(self, kind: str, payload: dict) -> tuple[object, object]:
        captured: dict[str, object] = {}

        def fake_complete(settings, prompt, cues, **kwargs):  # noqa: ANN001, ANN202
            captured["settings"] = settings
            captured["prompt"] = prompt
            captured["cues"] = cues
            text = "Hello World" if kind == "ai-smart-merge" else "缝合结果"
            return {"groups": [{"source_ids": [cues[0]["id"]], "text": text}]}

        with mock.patch("maw.postprocess_llm.complete_subtitle_groups", fake_complete):
            manager = editor_ai.AiTaskManager(self.env_path)
            snapshot = manager.submit(kind, payload)
            self.assertTrue(manager.wait_until_idle())
            return manager.snapshot(snapshot["id"]), captured

    def test_smart_merge_prompt_contains_parts_and_returns_polished_text(self) -> None:
        self._write_custom_slot()
        final, captured = self._run_kind("ai-smart-merge", {
            "mergedId": "m1",
            "mergedText": "HelloWorld",
            "parts": ["Hello", "World"],
            "lang": "en",
        })
        self.assertEqual(final["status"], "done")
        self.assertEqual(final["result"], {"texts": {"m1": "Hello World"}})
        self.assertIn("Original subtitles in order:", captured["prompt"])
        self.assertIn("1. Hello", captured["prompt"])
        self.assertIn("2. World", captured["prompt"])
        self.assertIn("HelloWorld", captured["prompt"])
        # cues 负载只携带合并后的单条字幕。
        self.assertEqual(captured["cues"], [{"id": "m1", "text": "HelloWorld"}])

    def test_smart_merge_keeps_original_when_model_rewrites_words(self) -> None:
        self._write_custom_slot()
        payload = {"mergedId": "m1", "mergedText": "HelloWorld", "parts": ["Hello", "World"], "lang": "en"}
        with mock.patch("maw.postprocess_llm.complete_subtitle_groups", return_value={
            "groups": [{"source_ids": ["m1"], "text": "Hello there"}],
        }):
            manager = editor_ai.AiTaskManager(self.env_path)
            snapshot = manager.submit("ai-smart-merge", payload)
            self.assertTrue(manager.wait_until_idle())
            final = manager.snapshot(snapshot["id"])
        self.assertEqual(final["status"], "error")
        self.assertIn("已保留普通合并结果", final["error"])

    def test_smart_merge_rejects_missing_parts_and_merged_text(self) -> None:
        self._write_custom_slot()
        manager = editor_ai.AiTaskManager(self.env_path)
        snapshot = manager.submit("ai-smart-merge", {"mergedId": "m1", "mergedText": "x", "parts": ["只一条"]})
        manager.wait_until_idle()
        final = manager.snapshot(snapshot["id"])
        self.assertEqual(final["status"], "error")
        self.assertIn("智能合并至少需要两条原始字幕", final["error"])

        snapshot = manager.submit("ai-smart-merge", {"parts": ["a", "b"]})
        manager.wait_until_idle()
        final = manager.snapshot(snapshot["id"])
        self.assertEqual(final["status"], "error")
        self.assertIn("缺少合并后的字幕信息", final["error"])

    def test_suggest_split_uses_marker_preset_prompt(self) -> None:
        self._write_custom_slot()
        final, captured = self._run_kind("ai-suggest-split", {
            "cues": [{"id": "c1", "text": "今天天气很好我们一起去公园散步"}],
            "lang": "zh",
        })
        self.assertEqual(final["status"], "done")
        self.assertIn("⎪", captured["prompt"])
        self.assertIn("断句", captured["prompt"])

    def test_timecode_alignment_forwards_to_local_runtime(self) -> None:
        """时间码→字词必须走独立运行环境子进程，不在编辑器进程内对齐（#347 #7）。"""
        self._write_custom_slot()
        media_path = Path(self._tmp.name) / "media.mp4"
        media_path.write_bytes(b"")
        captured: dict[str, object] = {}
        output_project = {
            "schema": 2,
            "tracks": [{"id": "main", "role": "main", "enabled": True, "language": "zh", "segments": [
                {"id": "c1", "text": "你好世界", "start": 1000, "end": 3000, "items": [
                    {"text": "你", "start": 1000, "end": 2000},
                    {"text": "好世界", "start": 2000, "end": 3000},
                ]},
            ]}],
            "bilingual": {"display_mode": "both", "active_track_id": None},
            "bindings": [],
        }

        def fake_runtime(**kwargs):  # noqa: ANN001, ANN202
            captured.update(kwargs)
            input_project = json.loads(Path(str(kwargs["project_path"])).read_text(encoding="utf-8"))
            captured["input_main"] = input_project
            output_path = Path(str(kwargs["project_path"])).parent / "output.json"
            output_path.write_text(json.dumps(output_project, ensure_ascii=False), encoding="utf-8")
            kwargs["on_event"]("已对齐 1 条")
            return {
                "artifact": {"projectPath": str(output_path), "warnings": ["提示A"]},
                "report": {"alignedSegments": 1, "failedSegments": 0, "warnings": ["提示A"]},
            }

        reports: list[tuple[str, int | None]] = []
        with mock.patch("maw.local_runtime.run_timestamp_alignment_in_runtime", fake_runtime), mock.patch(
            "maw.timestamp_alignment.align_project",
            side_effect=AssertionError("不得在编辑器进程内调用 align_project"),
        ):
            result = editor_ai.run_timecode_alignment(
                self.env_path,
                {"cues": [{"id": "c1", "text": "你好世界", "start": 1000, "end": 3000}],
                 "lang": "zh", "mediaPath": str(media_path)},
                lambda stage, percent: reports.append((stage, percent)),
                lambda: False,
            )
        self.assertEqual(result["items"], {"c1": [
            {"text": "你", "start": 1000, "end": 2000},
            {"text": "好世界", "start": 2000, "end": 3000},
        ]})
        self.assertEqual(result["aligned"], 1)
        self.assertEqual(result["failed"], 0)
        self.assertEqual(result["warnings"], ["提示A"])
        self.assertEqual(captured["media_path"], media_path)
        self.assertEqual(captured["output_mode"], "json")
        self.assertEqual(captured["alignment_mode"], "fill")
        self.assertEqual(captured["model_id"], "qwen3-forced-aligner-0.6b")
        self.assertTrue(hasattr(captured["cancel_event"], "is_set"))
        self.assertFalse(captured["cancel_event"].is_set())
        self.assertTrue(callable(captured["on_event"]))
        input_main = captured["input_main"]["tracks"]
        main = [track for track in input_main if track.get("role") == "main"][0]
        self.assertEqual([segment["id"] for segment in main["segments"]], ["c1"])
        self.assertEqual(main["language"], "zh")
        stages = [stage for stage, _percent in reports]
        self.assertEqual(stages[0], "loading_model")
        self.assertTrue(any(stage.startswith("对齐中") for stage in stages))
        self.assertEqual(stages[-1], "done")

    def test_timecode_alignment_surfaces_runtime_errors_and_cancel(self) -> None:
        """运行环境错误/取消映射为面向编辑器的 AiTaskError 提示。"""
        from maw.local_runtime import LocalRuntimeCancelled, LocalRuntimeError

        media_path = Path(self._tmp.name) / "media.mp4"
        media_path.write_bytes(b"")
        payload = {"cues": [{"id": "c1", "text": "你好", "start": 1000, "end": 3000}],
                   "mediaPath": str(media_path)}
        with mock.patch("maw.local_runtime.run_timestamp_alignment_in_runtime",
                        mock.Mock(side_effect=LocalRuntimeError("本地模型运行环境未就绪"))):
            with self.assertRaises(editor_ai.AiTaskError) as ctx:
                editor_ai.run_timecode_alignment(self.env_path, payload, lambda *args: None, lambda: False)
        self.assertIn("时间码对齐失败", str(ctx.exception))
        self.assertIn("本地模型运行环境未就绪", str(ctx.exception))

        with mock.patch("maw.local_runtime.run_timestamp_alignment_in_runtime",
                        mock.Mock(side_effect=LocalRuntimeCancelled("字词时间码生成已取消。"))):
            with self.assertRaises(editor_ai.AiTaskError) as ctx:
                editor_ai.run_timecode_alignment(self.env_path, payload, lambda *args: None, lambda: False)
        self.assertIn("已取消", str(ctx.exception))

    def test_timecode_alignment_rejects_missing_media_and_bad_cues(self) -> None:
        self._write_custom_slot()
        manager = editor_ai.AiTaskManager(self.env_path)
        snapshot = manager.submit("ai-timecode-items", {"cues": [
            {"id": "c1", "text": "你好", "start": 1000, "end": 3000},
        ]})
        manager.wait_until_idle()
        final = manager.snapshot(snapshot["id"])
        self.assertEqual(final["status"], "error")
        self.assertIn("媒体文件不可用", final["error"])

        snapshot = manager.submit("ai-timecode-items", {"cues": [
            {"id": "c1", "text": "你好", "start": 3000, "end": 1000},
        ], "mediaPath": "does-not-matter"})
        manager.wait_until_idle()
        final = manager.snapshot(snapshot["id"])
        self.assertEqual(final["status"], "error")
        self.assertIn("时间范围无效", final["error"])


if __name__ == "__main__":
    unittest.main()
