from __future__ import annotations

from unittest import mock

from maw.postprocess import OutputMode
from maw.postprocess_ai_cleanup import AiCleanupRequest, llm_complete, run_ai_cleanup
from maw.postprocess_ai_cleanup_timeline import parse_timeline
from maw.postprocess_llm import LlmClientError, LlmSettings
from maw.postprocess_pipeline import normalize_plan
from tests.compact_assertions import CompactContainerAssertions
from tests.test_postprocess_ai_cleanup import AiCleanupTestCase, _project, _segment, _write_project


class CleanupDiagnosticsTest(CompactContainerAssertions, AiCleanupTestCase):
    def request_for(self, *, review=False):
        source = _write_project(self.directory, _project([
            _segment(0, 1000, "试麦听得到吗"), _segment(1000, 2000, "正式内容"),
        ]))
        return AiCleanupRequest(source, None, None, OutputMode.BOTH, review_enabled=review)

    def test_default_only_calls_first_pass_and_does_not_archive_success(self):
        request = self.request_for()
        calls = []
        def complete(prompt, rows):
            calls.append(rows)
            return {"timeline": "[c001] 试麦听得到吗\n[c002] 正式内容"}
        artifact = run_ai_cleanup(request, complete=complete)
        self.assertEqual(len(calls), 1)
        self.assertIsNone(artifact.diagnostic_path)
        self.assertFalse(list(self.directory.glob("*.md")))
        self.assertFalse(normalize_plan({})["steps"][1]["reviewEnabled"])
        self.assertTrue(normalize_plan({"steps": [{"id": "cleanup", "reviewEnabled": True}]})["steps"][1]["reviewEnabled"])

    def test_failed_scan_archives_first_pass_and_both_retries(self):
        request = self.request_for(review=True)
        original = request.project_path.read_bytes()
        # Known read-only rows can be ignored, but an unknown source ID still
        # fails the scan and archives both attempts without writing outputs.
        draft = "[c001] ~~试麦听得到吗~~ %删除：试麦%\n[c002] 正式内容"
        def complete(prompt, rows):
            return {"timeline": draft + ("\n[c999] 未知行" if "这是漏清扫描" in prompt else "")}
        with self.assertRaises(LlmClientError) as caught:
            run_ai_cleanup(request, complete=complete)
        self.assertIn("应输出 1 行，实际 2 行", str(caught.exception))
        self.assertIn("额外或只读 ID：c999", str(caught.exception))
        report = next(self.directory.glob("*.md")).read_text(encoding="utf-8")
        self.assertIn("首次整理本地校验", report)
        self.assertIn("请求 3：漏清扫描", report)
        self.assertIn('"validationError"', report)
        self.assertEqual(request.project_path.read_bytes(), original)
        self.assertEqual(len(list(self.directory.glob("*.mosp"))), 1)
        self.assertFalse(list(self.directory.glob("*.srt")))

    def test_echoed_readonly_scan_rows_do_not_restore_or_extend_their_deletion(self):
        request = self.request_for(review=True)
        def complete(prompt, rows):
            if "proposed" in rows[0]:
                return {"reviews": []}
            return {"timeline": "[c001] ~~试麦听得到吗~~ %删除：试麦%\n[c002] 正式内容"}
        artifact = run_ai_cleanup(request, complete=complete)
        self.assertEqual(artifact.stats["removed"], 1)
        self.assertEqual(artifact.stats["pendingReview"], 0)
        self.assertFalse(list(self.directory.glob("*.md")))

    def test_successful_review_keeps_evidence_in_memory_only(self):
        request = self.request_for(review=True)
        def complete(prompt, rows):
            self.assertFalse(list(self.directory.glob("*.md")))
            if "第二道工序" in prompt:
                return {"reviews": []}
            if "这是漏清扫描" in prompt:
                return {"timeline": "\n".join(row["currentTimeline"] for row in rows if row.get("contextOnly") != "true")}
            return {"timeline": "[c001] 试麦听得到吗\n[c002] 正式内容"}
        artifact = run_ai_cleanup(request, complete=complete)
        self.assertIsNone(artifact.diagnostic_path)
        self.assertFalse(list(self.directory.glob("*.md")))

    def test_transport_error_and_report_write_error_preserve_cause(self):
        request = self.request_for()
        def fail(_prompt, _rows):
            raise LlmClientError("model failed token=example-secret", category="protocol")
        with self.assertRaises(LlmClientError) as caught:
            run_ai_cleanup(request, complete=fail)
        self.assertEqual(caught.exception.category, "protocol")
        record = next(self.directory.glob("*.md")).read_text(encoding="utf-8")
        self.assertNotIn("example-secret", record)
        with mock.patch("maw.postprocess_ai_cleanup_diagnostics._atomic_write", side_effect=OSError("disk full")):
            with self.assertRaises(LlmClientError) as caught:
                run_ai_cleanup(request, complete=fail)
        self.assertIn("记录保存失败", str(caught.exception))
        self.assertIn("model failed", str(caught.exception))

    def test_missing_ids_diagnostic_keeps_strict_parser(self):
        rows = [{"id": "c001", "asrText": "甲"}, {"id": "c002", "asrText": "乙"}]
        with self.assertRaisesRegex(ValueError, "缺少 ID：c002"):
            parse_timeline("[c001] 甲", rows, {})

    def test_raw_audit_syntax_retry_is_also_archived(self):
        request = self.request_for(review=True)
        contents = iter([
            "[c001] 试麦听得到吗\n[c002] 正式内容",
            "[c001] 试麦听得到吗\n[c002] 正式内容",
            "invalid-audit-json", "still-invalid", "invalid-again", "still-invalid",
        ])
        with mock.patch("maw.postprocess_ai_cleanup._request_completion", side_effect=lambda *_a, **_k: {"choices": [{"message": {"content": next(contents)}}]}):
            with self.assertRaises(LlmClientError):
                run_ai_cleanup(request, complete=llm_complete(LlmSettings("custom", "", "http://localhost:1234/v1", "test")))
        record = next(self.directory.glob("*.md")).read_text(encoding="utf-8")
        self.assertIn("invalid-audit-json", record)
        self.assertIn('"rawResponses"', record)

    def test_output_write_failure_is_recorded_without_reclassifying_file_error(self):
        request = self.request_for()
        with mock.patch("maw.postprocess_ai_cleanup.write_artifacts", side_effect=OSError("disk full")):
            with self.assertRaisesRegex(OSError, "disk full"):
                run_ai_cleanup(request, complete=lambda _p, _r: {"timeline": "[c001] 试麦听得到吗\n[c002] 正式内容"})
        record = next(self.directory.glob("*.md")).read_text(encoding="utf-8")
        self.assertIn("状态：写出失败", record)
        self.assertIn("disk full", record)
