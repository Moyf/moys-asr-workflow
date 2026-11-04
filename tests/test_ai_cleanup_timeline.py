from __future__ import annotations

import json
import re

from maw.postprocess import LlmPostprocessRequest, OutputMode, run_llm_postprocess
from maw.postprocess_ai_cleanup import AiCleanupRequest, build_clips, run_ai_cleanup
from maw.postprocess_ai_cleanup_items import cleaned_srt_segments, collapse_echo, remaining_text
from maw.postprocess_ai_cleanup_timeline import draft_line, escape_source_text, parse_timeline
from maw.postprocess_comparison import comparison_data, render_comparison
from maw.postprocess_io import render_srt
from maw.postprocess_llm import LlmClientError
from maw.postprocess_pipeline import normalize_plan
from tests.compact_assertions import CompactContainerAssertions
from tests.test_postprocess_ai_cleanup import AiCleanupTestCase, _project, _segment, _write_project


class TimelineCleanupTest(CompactContainerAssertions, AiCleanupTestCase):
    def test_mixed_retakes_cannot_keep_old_tail_and_cut_new_tail(self):
        artifact, project, _ = self.execute(
            ["我也可以只我也可以只显示图片", "但是不说话", "我也可以只显示图片", "但是不说话"],
            "[c001] ~~我也可以只我也可以只显示图片~~ %删除：旧版%\n[c002] 但是不说话\n"
            "[c003] 我也可以只显示图片\n[c004] ~~但是不说话~~ %删除：重复%",
        )
        self.assertEqual([bool(segment.get("disabled")) for segment in project["segments"]], [True, True, False, False])
        self.assertEqual(artifact.stats["removed"], 2)
        self.assertEqual(artifact.stats["pendingReview"], 0)

    def test_take_continuity_does_not_discard_unique_old_tail(self):
        _, project, _ = self.execute(
            ["演示这个功能", "但是不能导出", "演示这个功能", "但是不能预览"],
            "[c001] ~~演示这个功能~~\n[c002] 但是不能导出\n[c003] 演示这个功能\n[c004] 但是不能预览",
        )
        self.assertFalse(project["segments"][1].get("disabled"))
        self.assertFalse(project["segments"][3].get("disabled"))

    def test_literal_restart_with_only_keeps_one_complete_qualified_expression(self):
        artifact, _project, _ = self.execute(["我也可以只我也可以只显示图片"], "[c001] ~~我也可以只~~我也可以只显示图片 %删除：重复起头%")
        self.assertEqual(artifact.stats["removedItems"], 5)
        self.assertEqual(artifact.stats["pendingReview"], 0)
        self.assertIn("我也可以只显示图片", artifact.srt_path.read_text(encoding="utf-8-sig"))
        self.assertNotIn("我也可以只我也可以只", artifact.srt_path.read_text(encoding="utf-8-sig"))

    def test_retake_keeps_later_complete_pair_including_its_repeated_ending(self):
        artifact, project, _ = self.execute(
            ["我也可以只我也可以只显示图片", "但是不说话", "我也可以只显示图片", "但是不说话"],
            "[c001] ~~我也可以只我也可以只显示图片~~ %删除：旧版，后面完整重录%\n"
            "[c002] ~~但是不说话~~ %删除：旧版收尾%\n"
            "[c003] 我也可以只显示图片\n[c004] 但是不说话",
        )
        self.assertEqual([bool(segment.get("disabled")) for segment in project["segments"]], [True, True, False, False])
        self.assertEqual([segment["text"] for segment in cleaned_srt_segments(project, project["segments"]) if not segment.get("disabled")], ["我也可以只显示图片", "但是不说话"])
        self.assertNotIn("我也可以只我也可以只", artifact.srt_path.read_text(encoding="utf-8-sig"))

    def execute(self, texts, draft, *, scan=None, reviews=(), comparison=False):
        source = _write_project(self.directory, _project([_segment(i * 2000, (i + 1) * 2000, text) for i, text in enumerate(texts)]))
        original = source.read_bytes()
        calls = []
        def complete(prompt, rows):
            calls.append((prompt, rows))
            if "第二道工序" in prompt:
                return {"reviews": list(reviews)}
            if "这是漏清扫描" in prompt:
                return {"timeline": scan if scan is not None else "\n".join(row["currentTimeline"] for row in rows if row.get("contextOnly") != "true")}
            return {"timeline": draft}
        artifact = run_ai_cleanup(AiCleanupRequest(project_path=source, srt_path=None, script_path=None, output_mode=OutputMode.BOTH, output_directory=self.directory, generate_comparison=comparison, review_enabled=True), complete=complete)
        self.assertEqual(source.read_bytes(), original)
        return artifact, json.loads(artifact.project_path.read_text(encoding="utf-8")), calls

    def test_partial_deletion_is_gap_and_pending_note_is_region(self):
        artifact, project, calls = self.execute(["我可以我可以显示画面", "接着演示"], "[c001] ~~我可以~~我可以显示画面\n[c002] 接着演示 %待确认：原声需核实%", comparison=True)
        self.assertEqual(len(calls), 3)
        self.assertEqual(project["segments"][0]["text"], "我可以我可以显示画面")
        self.assertEqual(len(project["segments"][0]["items"]), 10)
        self.assertEqual(artifact.stats["removedItems"], 3)
        ai_range = project["gap_remove"]["provenance"]["sources"]["ai_cleanup"][0]
        self.assertEqual((ai_range["start"], ai_range["end"]), (0, 600))
        self.assertEqual(ai_range["cleanup_scope"], {
            "segment_id": project["segments"][0]["id"],
            "item_start": 0, "item_end": 3, "text": "我可以",
        })
        self.assertIn("我可以显示画面", artifact.srt_path.read_text(encoding="utf-8-sig"))
        self.assertNotIn("我可以我可以", artifact.srt_path.read_text(encoding="utf-8-sig"))
        self.assertEqual(project["markers"]["items"][-1]["review"]["status"], "pending")
        html = artifact.comparison_path.read_text(encoding="utf-8")
        data = json.loads(re.search(r'<script id="comparison-data" type="application/json">(.*?)</script>', html, re.S)[1])
        self.assertEqual(data["rows"][0]["after"], "我可以显示画面")
        self.assertTrue(data["rows"][1]["review"])

    def test_markdown_cut_scope_cannot_remove_words_from_an_overlapping_cue(self):
        _, project, _ = self.execute(["这个这个方法"], "[c001] ~~这个~~这个方法")
        source = project["segments"][0]
        other = {**source, "id": "overlapping-other"}
        self.assertEqual(cleaned_srt_segments(project, [source, other])[1]["text"], source["text"])
        project["gap_remove"]["provenance"]["sources"]["ai_cleanup"][0]["cleanup_scope"]["text"] = "旧文本"
        self.assertEqual(cleaned_srt_segments(project, [source])[0]["text"], source["text"])

    def test_missed_scan_can_cut_even_if_first_pass_has_no_deletion(self):
        artifact, project, _ = self.execute(["演示这个功能", "演示这个功能"], "[c001] 演示这个功能\n[c002] 演示这个功能", scan="[c001] ~~演示这个功能~~ %删除：重复旧版%\n[c002] 演示这个功能")
        self.assertTrue(project["segments"][0]["disabled"])
        self.assertFalse(project["segments"][1].get("disabled"))
        self.assertEqual(artifact.stats["removed"], 1)

    def test_multicue_retained_expression_covers_earlier_take(self):
        _, project, _ = self.execute(["介绍这个功能", "介绍这个", "功能"], "[c001] ~~介绍这个功能~~\n[c002] 介绍这个\n[c003] 功能")
        self.assertTrue(project["segments"][0]["disabled"])

    def test_unique_negation_is_restored_with_review(self):
        artifact, project, _ = self.execute(["这不能公开"], "[c001] 这~~不~~能公开")
        self.assertEqual(artifact.stats["removedItems"], 0)
        self.assertNotIn("gap_remove", project)
        self.assertEqual(project["markers"]["items"][0]["review"]["status"], "pending")

    def test_repeated_digits_and_negation_are_not_echo_shortcuts(self):
        for value in ("1212元", "１２１２元", "十二十二元", "不能不能公开", "not not available"):
            with self.subTest(value=value):
                self.assertEqual(collapse_echo(value), value)
        self.assertEqual(collapse_echo("这个这个方法"), "这个方法")
        source = _write_project(self.directory, _project([{
            "start": 0, "end": 600, "text": "1212元",
            "items": [{"start": 0, "end": 200, "text": "12"}, {"start": 200, "end": 400, "text": "12"}, {"start": 400, "end": 600, "text": "元"}],
        }]))
        artifact = run_ai_cleanup(
            AiCleanupRequest(project_path=source, srt_path=None, script_path=None, output_mode=OutputMode.BOTH, review_enabled=False),
            complete=lambda _p, _r: {"timeline": "[c001] ~~12~~12元"},
        )
        project = json.loads(artifact.project_path.read_text(encoding="utf-8"))
        self.assertEqual(artifact.stats["removedItems"], 0)
        self.assertNotIn("gap_remove", project)
        self.assertIn("1212元", artifact.srt_path.read_text(encoding="utf-8-sig"))
        self.assertEqual(project["markers"]["items"][0]["review"]["status"], "pending")
        artifact, project, _ = self.execute(["这不能不能公开"], "[c001] 这~~不能~~不能公开")
        self.assertEqual(artifact.stats["removedItems"], 0)
        self.assertNotIn("gap_remove", project)

    def test_final_audit_can_restore_partial_cut(self):
        artifact, project, _ = self.execute(["这个这个方法"], "[c001] ~~这个~~这个方法", reviews=[{"id": "c001", "reason": "复核：可能是强调，请回听"}])
        self.assertEqual(artifact.stats["editedSegments"], 0)
        self.assertNotIn("gap_remove", project)

    def test_truncated_or_rewritten_draft_never_creates_output(self):
        for draft in ("[c001] 内容", "[c001] 改写\n[c002] 其他", "[c002] 其他\n[c001] 内容"):
            with self.subTest(draft=draft), self.assertRaises(LlmClientError):
                self.execute(["内容", "其他"], draft, comparison=True)
            self.assertEqual(len(list(self.directory.glob("*.mosp"))), 1)
            self.assertFalse(list(self.directory.glob("*.srt")))
            self.assertFalse(list(self.directory.glob("*.html")))

    def test_malformed_draft_retry_keeps_the_markdown_protocol(self):
        source = _write_project(self.directory, _project([_segment(0, 1000, "内容")]))
        prompts = []
        def complete(prompt, rows):
            prompts.append(prompt)
            return {"timeline": "[c001] 改写" if len(prompts) == 1 else "[c001] 内容"}
        artifact = run_ai_cleanup(AiCleanupRequest(project_path=source, srt_path=None, script_path=None, output_mode=OutputMode.BOTH, review_enabled=False), complete=complete)
        self.assertEqual(len(prompts), 2)
        self.assertIn("只输出完整类 Markdown 编辑稿", prompts[1])
        self.assertNotIn("只输出一个严格有效的 JSON 对象", prompts[1])
        self.assertTrue(artifact.project_path.is_file())

    def test_word_boundary_and_source_punctuation(self):
        items = [{"text": "介绍", "start": 0, "end": 100}, {"text": "方法", "start": 100, "end": 200}]
        rows = [{"id": "c001", "asrText": "介绍，方法。", "scriptLine": ""}]
        unsafe = parse_timeline("[c001] ~~介~~绍，方法。", rows, {"c001": items})["decisions"][0]
        self.assertEqual(unsafe["decision"], "review")
        self.assertIn("没有词项内部时间码", unsafe["reason"])
        self.assertNotIn("deleteItems", unsafe)
        parsed = parse_timeline("[c001] ~~介绍~~，方法。", rows, {"c001": items})
        self.assertEqual(parsed["decisions"][0]["deleteItems"], [0])
        self.assertEqual(remaining_text(rows[0]["asrText"], items, [0]), "，方法。")

    def test_literal_markers_and_backslashes_roundtrip_with_inserted_deletions(self):
        for text in ("原文~~强调~~保留", "100% %待确认：这是原文%", r"路径\new\文件~~", "第一行\n第二行"):
            with self.subTest(text=text):
                items = [{"text": char} for char in text]
                rows = [{"id": "c001", "asrText": text, "scriptLine": ""}]
                kept = parse_timeline(draft_line("c001", text), rows, {"c001": items})
                self.assertEqual(kept["decisions"][0]["decision"], "keep")
                edited = parse_timeline(draft_line("c001", text, [0], items), rows, {"c001": items})
                self.assertEqual(edited["decisions"][0]["deleteItems"], [0])
                review = parse_timeline(draft_line("c001", text) + " %待确认：人工核查%", rows, {"c001": items})
                self.assertEqual(review["decisions"][0]["reason"], "人工核查")
        literal = "~~原文格式~~"
        artifact, project, calls = self.execute([literal], "[c001] " + escape_source_text(literal))
        self.assertEqual(project["segments"][0]["text"], literal)
        self.assertEqual(calls[0][1][0]["sourceLine"], draft_line("c001", literal))
        self.assertIn(literal, artifact.srt_path.read_text(encoding="utf-8-sig"))

    def test_same_manuscript_line_supports_multiple_short_cues(self):
        rows = build_clips([_segment(0, 1000, "先介绍工具"), _segment(1000, 2000, "再讲操作")], ["先介绍工具再讲操作"])
        self.assertEqual([row["scriptLine"] for row in rows], ["先介绍工具再讲操作"] * 2)

    def test_restored_gap_and_audio_gate_do_not_remove_words(self):
        segment = _segment(0, 1000, "介绍方法")
        gap = {"start": 0, "end": 250, "removed": False}
        project = _project([segment], gap_remove={"gaps": [gap], "provenance": {"sources": {"ai_cleanup": [{"start": 0, "end": 250}]}}})
        self.assertEqual(cleaned_srt_segments(project, [segment])[0]["text"], "介绍方法")
        project["gap_remove"]["gaps"][0]["removed"] = True
        project["gap_remove"]["provenance"]["sources"] = {"audio_gate": [{"start": 0, "end": 250}]}
        self.assertIn("介绍方法", render_srt(project))

    def test_html_escapes_source_script_and_generic_ai_opt_in(self):
        before = _project([_segment(0, 2000, "原文</script><script>alert(1)</script>")])
        html = render_comparison(comparison_data(before, before, "proofread"))
        self.assertNotIn("原文</script>", html)
        self.assertIn("\\u003c/script\\u003e", html)
        source = _write_project(self.directory, _project([_segment(0, 1000, "错字")]))
        artifact = run_llm_postprocess(LlmPostprocessRequest(project_path=source, srt_path=None, output_mode=OutputMode.BOTH, operation="proofread", custom_prompt="", generate_comparison=True), complete=lambda _prompt, rows: {"groups": [{"id": rows[0]["id"], "text": "正字"}]})
        self.assertTrue(artifact.comparison_path.is_file())
        artifact = run_llm_postprocess(LlmPostprocessRequest(project_path=source, srt_path=None, output_mode=OutputMode.BOTH, operation="proofread", custom_prompt=""), complete=lambda _prompt, rows: {"groups": [{"id": rows[0]["id"], "text": "正字"}]})
        self.assertIsNone(artifact.comparison_path)

    def test_legacy_plan_migrates_to_independent_optional_reference_task(self):
        plan = normalize_plan({"enabled": True, "steps": [{"id": "match", "enabled": True, "aiCleanup": True, "aiCleanupNotes": "保留步骤", "scriptPath": ""}]})
        self.assertFalse(plan["steps"][0]["enabled"])
        self.assertTrue(plan["steps"][1]["enabled"])
        self.assertEqual(plan["steps"][1]["customPrompt"], "保留步骤")
        self.assertEqual(plan["steps"][1]["scriptPath"], "")

    def test_repeated_cleanup_preserves_existing_cut_and_uses_effective_text(self):
        first, before, _ = self.execute(["这个这个方法方法"], "[c001] ~~这个~~这个方法方法")
        seen = []
        def complete(prompt, rows):
            seen.append(rows)
            if "第二道工序" in prompt:
                return {"reviews": []}
            return {"timeline": "[c001] 这个~~方法~~方法"}
        second = run_ai_cleanup(AiCleanupRequest(project_path=first.project_path, srt_path=None, script_path=None, output_mode=OutputMode.BOTH, output_directory=self.directory, generate_comparison=True), complete=complete)
        project = json.loads(second.project_path.read_text(encoding="utf-8"))
        self.assertEqual(seen[0][0]["asrText"], "这个方法方法")
        self.assertEqual(project["segments"][0], before["segments"][0])
        self.assertIn("这个方法", second.srt_path.read_text(encoding="utf-8-sig"))
        self.assertEqual(len(project["gap_remove"]["provenance"]["sources"]["ai_cleanup"]), 2)
        data = comparison_data(before, project, "ai_cleanup")
        self.assertEqual(data["before"], "这个方法方法")
        self.assertEqual(data["after"], "这个方法")

    def test_cli_comparison_marks_deleted_source_without_annotations(self):
        before = _project([_segment(0, 1000, "旧版"), _segment(1000, 2000, "保留")])
        after = _project([{**before["segments"][0], "disabled": True}, before["segments"][1]])
        self.assertTrue(comparison_data(before, after, "ai_cleanup")["rows"][0]["parts"][0]["deleted"])

    def test_explicit_cleanup_takes_priority_over_legacy_ai_match(self):
        plan = normalize_plan({"steps": [{"id": "match", "enabled": True, "aiCleanup": True}, {"id": "cleanup", "enabled": True, "customPrompt": "新版设置"}]})
        self.assertFalse(plan["steps"][0]["enabled"])
        self.assertEqual(plan["steps"][1]["customPrompt"], "新版设置")
