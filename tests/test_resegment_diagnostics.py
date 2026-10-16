from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from threading import Event
from unittest import mock

from maw.postprocess import LlmPostprocessRequest, OutputMode, run_llm_postprocess
from maw.gui_web import LauncherApi, LauncherPaths
from maw.postprocess_resegment import BoundaryValidationError, parse_boundaries, source_units
from maw.postprocess_pipeline import run_postprocess_pipeline
from tests.compact_assertions import CompactContainerAssertions
from tests.test_postprocess_resegment import timed


class ResegmentDiagnosticsTests(CompactContainerAssertions, unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "input.mosp"

    def run_case(self, segments, complete, **kwargs):
        self.source.write_text(json.dumps({"segments": segments}, ensure_ascii=False), encoding="utf-8")
        return run_llm_postprocess(LlmPostprocessRequest(
            project_path=self.source, srt_path=None, operation="resegment", output_mode=OutputMode.BOTH, custom_prompt="",
        ), complete=complete, **kwargs)

    def test_error_locates_original_numeric_boundary_and_archives_both_attempts(self):
        with self.assertRaises(ValueError) as caught:
            self.run_case([timed("60fps", ["60", "fps"])], lambda _p, _r: {"draft": "[c0001a0001]\n[c0001a0002]"})
        error = str(caught.exception)
        for needle in ("第 1 批", "[c0001a0001]", "[c0001a0002]", "原字幕 1 → 1", '左侧 "60"', '右侧 "fps"', "数字与单位", "重新断句阶段记录："):
            self.assertIn(needle, error)
        report = next(self.root.glob("*.md")).read_text(encoding="utf-8")
        self.assertIn("第 1 批 · 第 2 次请求", report)
        self.assertIn('"response"', report)
        self.assertIn('"issues"', report)
        self.assertIn("状态：失败", report)
        self.assertFalse(list(self.root.glob("*.srt")))
        self.assertEqual(len(list(self.root.glob("*.mosp"))), 1)

    def test_retry_status_uses_same_batch_and_success_leaves_no_record(self):
        calls = []
        statuses = []
        def complete(prompt, rows):
            calls.append(rows)
            if len(calls) == 1:
                return {"draft": "[c0001a0001]"}
            if len(calls) == 2:
                self.assertFalse(list(self.root.glob("*.md")))
            return {"draft": f"[{rows[-1]['items'][-1]['id']}]"}
        with mock.patch("maw.postprocess.MAX_LLM_CUES_PER_REQUEST", 1):
            artifact = self.run_case([timed("演示方法", ["演示", "方法"]), timed("结束", ["结束"], 500)], complete,
                                     on_status=lambda key, details: statuses.append((key, details)))
        attempts = [(d["current"], d["attempt"]) for k, d in statuses if k == "toolbox_status_llm_batch" and "attempt" in d]
        self.assertEqual(attempts, [(1, 1), (1, 2), (2, 1)])
        self.assertIsNone(artifact.diagnostic_path)
        self.assertFalse(list(self.root.glob("*.md")))

    def test_english_reason_is_explicit_and_full_report_keeps_all_invalid_boundaries(self):
        units = source_units(timed("xxxxxxxx", ["x"] * 8), 0)
        response = {"draft": "\n".join(f"[{u.id}]" for u in units)}
        with self.assertRaises(BoundaryValidationError) as caught:
            parse_boundaries(response, units)
        self.assertEqual(len(caught.exception.issues), 7)
        self.assertIn("连续英文字母", str(caught.exception))
        self.assertIn("另有 2 处", str(caught.exception))
        self.assertIn("c0001a0007", caught.exception.issues[-1])

    def test_archive_failure_warns_without_hiding_validation_error(self):
        with mock.patch("maw.postprocess_resegment_diagnostics._atomic_write", side_effect=OSError("disk full")):
            with self.assertRaises(ValueError) as caught:
                self.run_case([timed("60fps", ["60", "fps"])], lambda _p, _r: {"draft": "[c0001a0001]\n[c0001a0002]"})
        self.assertIn("数字与单位", str(caught.exception))
        self.assertIn("阶段记录保存失败", str(caught.exception))

    def test_report_redacts_secrets_and_keeps_model_fences_as_data(self):
        def complete(_p, _r):
            return {"draft": "```wrong\ntoken=private-token\n```"}
        with self.assertRaises(ValueError):
            self.run_case([timed("内容", ["内容"])], complete)
        report = next(self.root.glob("*.md")).read_text(encoding="utf-8")
        self.assertNotIn("private-token", report)
        self.assertIn("\\u0060", report)

    def test_resegment_retry_stream_retains_logical_batch_number(self):
        self.source.write_text(json.dumps({"segments": [timed("演示方法", ["演示", "方法"])]}, ensure_ascii=False), encoding="utf-8")
        api = LauncherApi(paths=LauncherPaths(root=self.root, env_path=self.root / ".env", launcher_html=self.root / "launcher.html"), window_getter=lambda: None)
        self.addCleanup(api.pump.shutdown)
        calls = []
        def complete(_settings, _prompt, _rows, **kwargs):
            calls.append(_rows)
            draft = "[c0001a0001]" if len(calls) == 1 else "[c0001a0002]"
            kwargs["on_delta"]("reset", "")
            kwargs["on_delta"]("content", draft)
            return {"draft": draft}
        with mock.patch("maw.postprocess_resegment.complete_boundaries", side_effect=complete), mock.patch.object(api, "_emit_postprocess_stream") as stream:
            result = api.run_llm_postprocess({"projectPath": str(self.source), "operation": "resegment", "providerId": "deepseek", "apiKey": "test-key", "baseUrl": "https://example.test/v1", "model": "test"})
        self.assertTrue(result["ok"], result)
        content = [call for call in stream.call_args_list if call.args[0] == "content"]
        self.assertEqual([(call.args[2], call.kwargs["attempt"]) for call in content], [(1, 1), (1, 2)])
        self.assertFalse(result.get("diagnosticPath"))

    def test_pipeline_success_leaves_no_record_when_intermediates_are_discarded(self):
        self.source.write_text(json.dumps({"segments": [timed("演示方法", ["演示", "方法"])]}, ensure_ascii=False), encoding="utf-8")
        srt = self.root / "input.srt"
        srt.write_text("1\n00:00:00,000 --> 00:00:00,400\n演示方法\n", encoding="utf-8")
        media = self.root / "clip.wav"
        media.write_bytes(b"test")
        def complete(_settings, _prompt, rows, **kwargs):
            return {"draft": f"[{rows[-1]['items'][-1]['id']}]"}
        with mock.patch("maw.output_naming.subfolder_prefs", return_value=(False, False)), mock.patch("maw.postprocess_pipeline.complete_boundaries", side_effect=complete):
            result = run_postprocess_pipeline(
                {"enabled": True, "retainIntermediate": False, "steps": [{"id": "resegment", "enabled": True, "providerId": "deepseek"}]},
                media_path=media, project_path=self.source, srt_path=srt, env_path=self.root / ".env", ffmpeg_path=None, cancel_event=Event(),
                llm_settings={"deepseek": {"apiKey": "test-key", "baseUrl": "https://example.test/v1", "model": "test", "verified": "1"}},
            )
        self.assertFalse(result.run_directory.exists())
        records = list(self.root.glob("*.resegment-record*.md"))
        self.assertEqual(records, [])
        self.assertFalse(any("阶段记录" in warning for warning in result.warnings))
