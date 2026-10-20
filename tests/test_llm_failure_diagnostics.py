from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from maw.postprocess import LlmPostprocessRequest, OutputMode, PostprocessStepError, run_llm_postprocess
from maw.postprocess_llm import LlmClientError, LlmSettings, complete_subtitle_groups
from tests.compact_assertions import CompactContainerAssertions


class LlmFailureDiagnosticsTests(CompactContainerAssertions, unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "input.mosp"
        self.source.write_text(json.dumps({"segments": [{"start": 0, "end": 1000, "text": "你好"}]}, ensure_ascii=False), encoding="utf-8")
        self.request = LlmPostprocessRequest(project_path=self.source, srt_path=None, operation="proofread", output_mode=OutputMode.BOTH, custom_prompt="")

    def test_success_leaves_no_record(self):
        artifact = run_llm_postprocess(self.request, complete=lambda _p, _r: {"groups": [{"id": "c0001", "text": "你好"}]})
        self.assertTrue(artifact.project_path.is_file())
        self.assertFalse(list(self.root.glob("*.md")))

    def test_raw_invalid_json_retries_are_preserved_on_failure(self):
        replies = iter(["first-broken", "second-broken token=private-token"])
        settings = LlmSettings("custom", "", "http://127.0.0.1:1234/v1", "test")
        with mock.patch("maw.postprocess_llm._request_completion", side_effect=lambda *_a, **_k: {"choices": [{"message": {"content": next(replies)}}]}):
            with self.assertRaises(PostprocessStepError) as caught:
                run_llm_postprocess(self.request, complete=lambda prompt, rows: complete_subtitle_groups(settings, prompt, rows))
        self.assertIn("AI 失败记录：", str(caught.exception))
        report = next(self.root.glob("*.md")).read_text(encoding="utf-8")
        self.assertIn("first-broken", report)
        self.assertIn("second-broken", report)
        self.assertNotIn("private-token", report)
        self.assertFalse(list(self.root.glob("*.srt")))

    def test_record_write_failure_preserves_provider_classification(self):
        def fail(_p, _r):
            raise LlmClientError("HTTP 401", category="provider_response", status_code=401)
        with mock.patch("maw.postprocess_llm_diagnostics._atomic_write", side_effect=OSError("disk full")):
            with self.assertRaises(PostprocessStepError) as caught:
                run_llm_postprocess(self.request, complete=fail)
        self.assertEqual(caught.exception.status_code, 401)
        self.assertEqual(caught.exception.category, "provider_response")
        self.assertIn("记录保存失败", str(caught.exception))
