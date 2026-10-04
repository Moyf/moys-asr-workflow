from __future__ import annotations

import json
from threading import Event
from unittest import mock

from maw.postprocess import OutputMode
from maw.postprocess_ai_cleanup import AiCleanupRequest, run_ai_cleanup
from maw.postprocess_ai_cleanup_review import readthrough_batches
from maw.postprocess_llm import LlmClientError
from maw.postprocess_pipeline import PostprocessCancelled, _run_ai_cleanup_step
from tests.test_postprocess_ai_cleanup import AiCleanupTestCase, _project, _segment


class ReadthroughTest(AiCleanupTestCase):
    def execute(self, response, *, enabled=True, discard=True, untimed=False, on_status=None):
        segments = [_segment(0, 1000, "试麦听得到吗"), _segment(1000, 2000, "这是关键方法")]
        if untimed:
            segments.append(_segment(2000, 3000, "所以有这个结果", with_items=False))
        self.source, script = self.request(_project(segments), ["这是关键方法"])
        self.calls = []

        def complete(prompt, rows):
            self.calls.append((prompt, rows))
            if "第二道工序" in prompt:
                return response(rows) if callable(response) else response
            return {"decisions": [
                {"id": "c001", "decision": "discard" if discard else "keep", "scriptLine": "",
                 "reason": "删除：试麦", "evidence": "试麦"},
                {"id": "c002", "decision": "keep", "scriptLine": "这是关键方法", "reason": "保留：有效内容"},
            ]}

        return run_ai_cleanup(AiCleanupRequest(
            project_path=self.source, srt_path=None, script_path=script, output_mode=OutputMode.BOTH,
            output_directory=self.directory, review_enabled=enabled, notes="保留必要的前后承接",
        ), complete=complete, on_status=on_status)

    def test_default_pass_restores_unsafe_cut_and_flags_kept_content(self):
        status = []
        artifact = self.execute({"reviews": [
            {"id": "c001", "reason": "复核：前文仍需试听确认"},
            {"id": "c002", "reason": "复核：检查承接"},
        ]}, untimed=True, on_status=status.append)
        output = json.loads(artifact.project_path.read_text(encoding="utf-8"))
        self.assertTrue(AiCleanupRequest.__dataclass_fields__["review_enabled"].default)
        self.assertEqual(len(self.calls), 2)
        self.assertIn("toolbox_status_ai_cleanup_review", status)
        rows = self.calls[-1][1]
        self.assertEqual([row["asrText"] for row in rows], ["试麦听得到吗", "这是关键方法", "所以有这个结果"])
        self.assertEqual(rows[-1]["contextOnly"], "true")
        self.assertTrue(all("start" not in row and "speaker" not in row for row in rows))
        self.assertIn("保留必要的前后承接", self.calls[-1][0])
        self.assertFalse(any(segment.get("disabled") for segment in output["segments"]))
        self.assertNotIn("gap_remove", output)
        self.assertEqual(artifact.stats["pendingReview"], 3)
        self.assertEqual(output["segments"][1]["text"], "这是关键方法")

    def test_sparse_empty_review_keeps_proposed_cut(self):
        artifact = self.execute({"reviews": []})
        output = json.loads(artifact.project_path.read_text(encoding="utf-8"))
        self.assertEqual(len(self.calls), 2)
        self.assertTrue(output["segments"][0]["disabled"])
        self.assertEqual(artifact.stats["removed"], 1)

    def test_internal_off_switch_and_no_cut_skip_second_request(self):
        for enabled, discard in ((False, True), (True, False)):
            with self.subTest(enabled=enabled, discard=discard):
                self.execute({"reviews": []}, enabled=enabled, discard=discard)
                self.assertEqual(len(self.calls), 1)

    def test_invalid_second_pass_never_writes_partial_output(self):
        for response in (
            {"reviews": [{"id": "c999", "reason": "复核：未知段"}]},
            {"reviews": [{"id": "c001", "reason": "删除：扩删", "decision": "discard"}]},
            {"decisions": []},
        ):
            with self.subTest(response=response), self.assertRaises(LlmClientError):
                self.execute(response)
            self.assertEqual(len(self.calls), 3)
            self.assertEqual(list(self.directory.glob("*.mosp")), [self.source])
            self.assertFalse(json.loads(self.source.read_text(encoding="utf-8"))["segments"][0].get("disabled"))

    def test_second_pass_cannot_flag_read_only_neighbor(self):
        with mock.patch("maw.postprocess_ai_cleanup_review.READTHROUGH_BATCH_SIZE", 1):
            with self.assertRaises(LlmClientError):
                self.execute({"reviews": [{"id": "c002", "reason": "复核：越界"}]})
        self.assertEqual(list(self.directory.glob("*.mosp")), [self.source])

    def test_readthrough_context_skips_deleted_run_to_show_real_join(self):
        rows = [{"id": f"c{i}", "asrText": str(i), "proposed": "discard" if 1 <= i <= 4 else "keep"}
                for i in range(6)]
        with mock.patch("maw.postprocess_ai_cleanup_review.READTHROUGH_BATCH_SIZE", 2):
            batches = readthrough_batches(rows)
        self.assertEqual([row["id"] for row in batches[1]], ["c0", "c2", "c3", "c5"])
        self.assertEqual(batches[1][0]["contextOnly"], "true")
        self.assertEqual(batches[1][-1]["contextOnly"], "true")

    def test_cancel_at_readthrough_leaves_source_and_outputs_untouched(self):
        def status(key):
            if key == "toolbox_status_ai_cleanup_review":
                raise RuntimeError("cancelled")
        with self.assertRaisesRegex(RuntimeError, "cancelled"):
            self.execute({"reviews": []}, on_status=status)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(list(self.directory.glob("*.mosp")), [self.source])

    def test_pipeline_cancel_during_final_readthrough_does_not_write_artifacts(self):
        source, script = self.request(_project([
            _segment(0, 1000, "试麦听得到吗"),
            _segment(1000, 2000, "这是关键方法"),
        ]), ["这是关键方法"])
        original = source.read_bytes()
        cancelled = Event()
        calls = []

        def transport(prompt, rows):
            calls.append(rows)
            if "第二道工序" in prompt:
                cancelled.set()
                return {"reviews": []}
            return {"decisions": [
                {"id": "c001", "decision": "discard", "scriptLine": "",
                 "reason": "删除：试麦", "evidence": "试麦"},
                {"id": "c002", "decision": "keep", "scriptLine": "这是关键方法",
                 "reason": "保留：有效内容"},
            ]}

        with mock.patch("maw.postprocess_pipeline.llm_complete", return_value=transport):
            with self.assertRaises(PostprocessCancelled):
                _run_ai_cleanup_step(
                    {"scriptPath": str(script)}, project_path=source,
                    srt_path=self.directory / "input.srt", media_path=self.directory / "media.wav",
                    env_path=self.directory / "unused.env", output_directory=self.directory,
                    cancel_event=cancelled, on_event=None,
                    llm_settings={"deepseek": {"apiKey": "test", "baseUrl": "https://example.com", "model": "test"}},
                )
        self.assertEqual(len(calls), 2)
        self.assertEqual(source.read_bytes(), original)
        self.assertEqual(list(self.directory.glob("*.mosp")), [source])
        self.assertFalse(list(self.directory.glob("*.srt")))
