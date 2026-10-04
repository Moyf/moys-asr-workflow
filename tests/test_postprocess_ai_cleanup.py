# pyright: reportAny=false, reportArgumentType=false, reportUnknownVariableType=false, reportReturnType=false, reportAttributeAccessIssue=false

"""AI 口播整理（postprocess_ai_cleanup）的行为测试。

覆盖任务要求的场景：重录、局部口误、改说、额外信息、独有数字、
缺失文稿行、无有效 items、无效 LLM 响应；以及 gap_remove 的
ai_cleanup 来源层与复核 markers 字段。
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from maw.postprocess import OutputMode
from maw.postprocess_ai_cleanup import (
    AiCleanupRequest,
    build_clips,
    run_ai_cleanup,
)
from maw.postprocess_llm import LlmClientError


def _segment(start_ms: int, end_ms: int, text: str, *, with_items: bool = True) -> dict[str, object]:
    segment: dict[str, object] = {"start": start_ms, "end": end_ms, "text": text}
    if with_items:
        span = max(1, (end_ms - start_ms) // max(1, len(text)))
        segment["items"] = [
            {"text": char, "start": start_ms + index * span, "end": start_ms + (index + 1) * span}
            for index, char in enumerate(text)
        ]
    return segment


def _project(segments: list[dict[str, object]], **extra: object) -> dict[str, object]:
    project: dict[str, object] = {"schema": "moy.asr.project.v1", "segments": segments}
    project.update(extra)
    return project


def _write_project(directory: Path, project: dict[str, object]) -> Path:
    path = directory / "input.mosp"
    path.write_text(json.dumps(project, ensure_ascii=False), encoding="utf-8")
    return path


def _write_script(directory: Path, lines: list[str]) -> Path:
    path = directory / "script.txt"
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


def _run(directory: Path, project_path: Path, script_path: Path, decisions: list[dict[str, object]]):
    calls: list[list[dict[str, str]]] = []

    def complete(_prompt: str, clips: list[dict[str, str]]) -> dict[str, object]:
        calls.append(clips)
        return {"decisions": decisions}

    request = AiCleanupRequest(
        project_path=project_path,
        srt_path=None,
        script_path=script_path,
        output_mode=OutputMode.BOTH,
        output_directory=directory,
        review_enabled=False,
    )
    artifact = run_ai_cleanup(request, complete=complete)
    output_project = json.loads(
        (artifact.project_path or Path()).read_text(encoding="utf-8"),
    )
    return artifact, output_project, calls


def _decisions(**per_clip: dict[str, object]) -> list[dict[str, object]]:
    return [{"id": clip_id, **decision} for clip_id, decision in per_clip.items()]


class AiCleanupTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.directory = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def request(self, project: dict[str, object], script_lines: list[str]) -> tuple[Path, Path]:
        return (
            _write_project(self.directory, project),
            _write_script(self.directory, script_lines),
        )


class ExistingMarkersPreservationTest(AiCleanupTestCase):
    def test_ai_notes_have_one_prefix_and_outcome_operation(self) -> None:
        from maw.postprocess_ai_cleanup import _ai_annotation
        segment = _segment(100, 900, "原文")
        deletion = _ai_annotation(segment, "删除", "[AI] [AI] 删除: 口误", pending=False)
        self.assertEqual(deletion["note"], "[AI] 删除：口误")
        self.assertNotIn("review", deletion)
        uncertain = _ai_annotation(segment, "替代项", "删除：版本尚不能覆盖原句")
        self.assertEqual(uncertain["note"], "[AI] 替代项：版本尚不能覆盖原句")
        self.assertEqual(uncertain["end"], 900)
        self.assertEqual(uncertain["review"]["status"], "pending")

    def test_new_review_markers_preserve_existing_annotations_and_ids(self) -> None:
        existing = {
            "schema": "moy.asr.markers.v1", "custom": {"keep": True},
            "items": [
                {"id": "marker-001", "start": 100, "end": 200, "name": "人工区段",
                 "color": "#3366ff", "note": "不要丢失", "custom": 7},
                {"id": "marker-003", "start": 500, "name": "已复核",
                 "review": {"status": "confirmed", "reason": "人工确认"}},
            ],
        }
        project_path, script_path = self.request(
            _project([_segment(0, 1000, "需要复核")], markers=existing), ["需要复核"])
        _artifact, output, _calls = _run(self.directory, project_path, script_path, _decisions(
            c001={"decision": "review", "scriptLine": "需要复核", "reason": "请试听"}))
        markers = output["markers"]
        self.assertEqual(markers["items"][:2], existing["items"])
        self.assertEqual(markers["custom"], existing["custom"])
        self.assertEqual(markers["items"][2]["id"], "marker-002")
        self.assertEqual(markers["items"][2]["review"]["status"], "pending")
        self.assertEqual(json.loads(project_path.read_text(encoding="utf-8"))["markers"], existing)


class RetakeRemovalTest(AiCleanupTestCase):
    def test_alt_take_must_preserve_facts_conditions_and_steps(self) -> None:
        cases = [
            ("这个方案最多支持10个人同时使用", "这个方案最多支持100个人同时使用"),
            ("这个方案最多支持十个人同时使用", "这个方案最多支持一百个人同时使用"),
            ("这个方案的成功率是10%", "这个方案的成功率是10"),
            ("这个方案不支持离线使用", "这个方案支持离线使用"),
            ("这个方案可能适合初学者使用", "这个方案适合初学者使用"),
            ("找到客户后先确认预算再安排演示", "找到客户后先安排演示"),
            ("This method supports offline use", "This method does not support offline use"),
        ]
        for source, replacement in cases:
            with self.subTest(source=source):
                project_path, script_path = self.request(_project([
                    _segment(0, 2000, source), _segment(2000, 4000, replacement),
                ]), [source, replacement])
                artifact, output, _ = _run(self.directory, project_path, script_path, _decisions(
                    c001={"decision": "discard", "scriptLine": source, "reason": "重录", "altTakeId": "c002"},
                    c002={"decision": "keep", "scriptLine": replacement, "reason": "保留"},
                ))
                self.assertFalse(output["segments"][0].get("disabled"))
                self.assertEqual(artifact.stats["pendingReview"], 1)
                self.assertTrue(output["markers"]["items"][0]["note"].startswith("[AI] 替代项："))

    def test_matching_number_with_only_filler_removed_is_safe(self) -> None:
        source, replacement = "最多支持10个人同时使用啊", "最多支持10个人同时使用"
        project_path, script_path = self.request(_project([
            _segment(0, 2000, source), _segment(2000, 4000, replacement),
        ]), [replacement])
        artifact, output, _ = _run(self.directory, project_path, script_path, _decisions(
            c001={"decision": "discard", "scriptLine": replacement, "reason": "重录", "altTakeId": "c002"},
            c002={"decision": "keep", "scriptLine": "", "reason": "保留"},
        ))
        self.assertTrue(output["segments"][0].get("disabled"))
        self.assertEqual(artifact.stats["removed"], 1)

    def test_discard_with_similar_alt_take_removes_segment(self) -> None:
        script = [
            "今天我们来讲一个非常重要的知识点",
            "这个功能可以大大提升效率",
            "这个功能可以大大地提升效率",
        ]
        segments = [
            _segment(0, 4000, script[0]),
            _segment(4000, 8000, script[1] + "啊"),
            _segment(8000, 12000, script[2]),
        ]
        project_path, script_path = self.request(_project(segments), script)
        artifact, output, calls = _run(self.directory, project_path, script_path, _decisions(
            c001={"decision": "keep", "scriptLine": script[0], "reason": "对应文稿"},
            c002={"decision": "discard", "scriptLine": script[1], "reason": "废片", "altTakeId": "c003"},
            c003={"decision": "keep", "scriptLine": script[2], "reason": "更好的重录"},
        ))
        out_segments = output["segments"]
        self.assertFalse(out_segments[0].get("disabled"))
        self.assertTrue(out_segments[1].get("disabled"))
        self.assertFalse(out_segments[2].get("disabled"))
        gap_remove = output["gap_remove"]
        self.assertEqual(gap_remove["schema"], "moy.asr.gap_remove.v1")
        ai_ranges = gap_remove["provenance"]["sources"]["ai_cleanup"]
        self.assertEqual([(item["start"], item["end"]) for item in ai_ranges], [(4000, 8000)])
        self.assertTrue(any(gap["start"] == 4000 and gap["end"] == 8000 for gap in gap_remove["gaps"]))
        annotation = output["markers"]["items"][0]
        self.assertEqual((annotation["start"], annotation["end"]), (4000, 8000))
        self.assertTrue(annotation["note"].startswith("[AI] 删除："))
        self.assertIn("替代字幕", annotation["note"])
        self.assertNotIn("review", annotation)
        stats = artifact.stats
        assert stats is not None
        self.assertEqual(stats["removed"], 1)
        self.assertEqual(stats["pendingReview"], 0)
        self.assertTrue(any("自动移除 1 段" in warning for warning in artifact.warnings))


class MicTestRemovalTest(AiCleanupTestCase):
    def test_discard_disables_only_its_bound_translation_even_when_hidden(self) -> None:
        for enabled in (True, False):
            with self.subTest(enabled=enabled):
                segments = [
                    {**_segment(0, 2000, "试麦试麦听得到吗"), "id": "trial"},
                    {**_segment(2000, 6000, "大家好欢迎回到我的频道"), "id": "kept"},
                    {**_segment(6000, 8000, "这一句请再听一下"), "id": "review"},
                ]
                translations = [
                    {"id": "ext-trial", "start": 100, "end": 1900, "text": "Mic test"},
                    {"id": "ext-kept", "start": 2000, "end": 6000, "text": "Welcome", "disabled": True},
                    {"id": "ext-review", "start": 6000, "end": 8000, "text": "Please review"},
                    {"id": "ext-free", "start": 8000, "end": 9000, "text": "Independent"},
                ]
                multi = {
                    "schema": "moy.asr.multi_subtitle.v1", "enabled": enabled, "display_mode": "both",
                    "tracks": [
                        {"id": "translation", "role": "extension", "name": "译文",
                         "split_mode": "word", "segments": translations},
                        {"id": "independent", "role": "extension", "name": "独立副轨",
                         "split_mode": "word", "segments": [
                             {"id": "overlapping", "start": 0, "end": 2000, "text": "Independent"}]},
                    ],
                    "bindings": [
                        {"id": f"binding-{main}", "track_id": "translation",
                         "main_segment_ids": [main], "extension_segment_ids": [extension]}
                        for main, extension in (("trial", "ext-trial"), ("kept", "ext-kept"), ("review", "ext-review"))
                    ],
                }
                source = _project(segments, multi_subtitle=multi)
                project_path, script_path = self.request(source, [segments[1]["text"]])
                artifact, output, _ = _run(self.directory, project_path, script_path, _decisions(
                    c001={"decision": "discard", "scriptLine": "", "reason": "试麦", "evidence": "听得到吗"},
                    c002={"decision": "keep", "scriptLine": segments[1]["text"], "reason": "对应文稿"},
                    c003={"decision": "review", "scriptLine": "", "reason": "请试听"},
                ))
                self.assertTrue(output["segments"][0]["disabled"])
                result = output["multi_subtitle"]["tracks"][0]["segments"]
                self.assertEqual(result[0], {**translations[0], "disabled": True})
                self.assertEqual(result[1:], translations[1:])
                self.assertEqual(output["multi_subtitle"]["tracks"][1]["segments"], multi["tracks"][1]["segments"])
                self.assertEqual(output["multi_subtitle"]["enabled"], enabled)
                self.assertEqual(len(output["multi_subtitle"]["bindings"]), 3)
                self.assertEqual(json.loads(project_path.read_text(encoding="utf-8")), source)
                self.assertEqual(artifact.stats["removed"], 1)

    def test_process_talk_discard_with_evidence_is_removed(self) -> None:
        script = ["大家好欢迎回到我的频道"]
        segments = [
            _segment(0, 2000, "试麦试麦听得到吗"),
            _segment(2000, 6000, script[0]),
        ]
        project_path, script_path = self.request(_project(segments), script)
        artifact, output, _ = _run(self.directory, project_path, script_path, _decisions(
            c001={"decision": "discard", "scriptLine": "", "reason": "试麦", "evidence": "听得到吗"},
            c002={"decision": "keep", "scriptLine": script[0], "reason": "对应文稿"},
        ))
        self.assertTrue(output["segments"][0].get("disabled"))
        self.assertFalse(output["segments"][1].get("disabled"))
        stats = artifact.stats
        assert stats is not None
        self.assertEqual(stats["removed"], 1)
        self.assertEqual(stats["extrasKept"], 0)
        self.assertEqual(output["markers"]["items"][0]["note"], "[AI] 删除：试麦")


class RephraseKeptTest(AiCleanupTestCase):
    def test_rephrased_line_is_kept_and_counted(self) -> None:
        script = ["换一种思路来看这件事其实会更简单"]
        said = "换个思路来说这件事呢其实就更简单了"
        segments = [_segment(0, 6000, said)]
        project_path, script_path = self.request(_project(segments), script)
        clips = build_clips(_project(segments)["segments"], script)  # type: ignore[arg-type]
        self.assertEqual(clips[0]["scriptMatch"], "rephrased")
        artifact, output, _ = _run(self.directory, project_path, script_path, _decisions(
            c001={"decision": "keep", "scriptLine": script[0], "reason": "改说"},
        ))
        self.assertFalse(output["segments"][0].get("disabled"))
        stats = artifact.stats
        assert stats is not None
        self.assertEqual(stats["rephrased"], 1)
        self.assertEqual(stats["removed"], 0)


class LocalSlipKeptTest(AiCleanupTestCase):
    def test_small_slip_counts_as_matched_line(self) -> None:
        script = ["今天我们来讲一个非常重要的知识点"]
        said = "今天我们来讲一个非常重要地知识点"
        segments = [_segment(0, 5000, said)]
        project_path, script_path = self.request(_project(segments), script)
        artifact, output, _ = _run(self.directory, project_path, script_path, _decisions(
            c001={"decision": "keep", "scriptLine": script[0], "reason": "口误但内容一致"},
        ))
        self.assertFalse(output["segments"][0].get("disabled"))
        stats = artifact.stats
        assert stats is not None
        self.assertEqual(stats["matchedLines"], 1)


class UnsafeDiscardDowngradeTest(AiCleanupTestCase):
    def test_repetition_cannot_remove_every_copy_of_information(self) -> None:
        text = "先确认预算然后安排演示"
        project, script = self.request(_project([
            _segment(0, 2000, text), _segment(2000, 4000, text),
        ]), ["其他参考文稿"])
        artifact, output, _ = _run(self.directory, project, script, _decisions(
            c001={"decision": "discard", "scriptLine": "", "reason": "重复", "evidence": text},
            c002={"decision": "discard", "scriptLine": "", "reason": "重复", "evidence": text},
        ))
        self.assertTrue(any(not segment.get("disabled") for segment in output["segments"]))
        self.assertGreaterEqual(artifact.stats["pendingReview"], 1)

    def test_tangent_without_local_pattern_becomes_review(self) -> None:
        # 额外信息：LLM 想删，但 evidence 命中不了本地流程模式 → 降级复核。
        script = ["大家好欢迎回到我的频道"]
        segments = [
            _segment(0, 4000, script[0]),
            _segment(4000, 9000, "顺便说一下我上个周末去爬山看到了日出"),
        ]
        project_path, script_path = self.request(_project(segments), script)
        artifact, output, _ = _run(self.directory, project_path, script_path, _decisions(
            c001={"decision": "keep", "scriptLine": script[0], "reason": "对应文稿"},
            c002={"decision": "discard", "scriptLine": "", "reason": "题外话", "evidence": "去爬山"},
        ))
        self.assertFalse(output["segments"][1].get("disabled"))
        self.assertNotIn("gap_remove", output)
        markers = output["markers"]
        self.assertEqual(markers["schema"], "moy.asr.markers.v1")
        self.assertEqual(len(markers["items"]), 1)
        marker = markers["items"][0]
        self.assertEqual(marker["id"], "marker-001")
        self.assertEqual(marker["start"], 4000)
        self.assertEqual(marker["color"], "#f5a623")
        self.assertEqual(marker["review"]["status"], "pending")
        stats = artifact.stats
        assert stats is not None
        self.assertEqual(stats["pendingReview"], 1)
        self.assertEqual(stats["removed"], 0)

    def test_discard_with_digits_becomes_review(self) -> None:
        # 独有数字：即使命中流程模式（报遍数），含数字也必须人工确认。
        script = ["大家好欢迎回到我的频道"]
        segments = [
            _segment(0, 4000, script[0]),
            _segment(4000, 8000, "第3遍我们的用户量已经有30500了"),
        ]
        project_path, script_path = self.request(_project(segments), script)
        artifact, output, _ = _run(self.directory, project_path, script_path, _decisions(
            c001={"decision": "keep", "scriptLine": script[0], "reason": "对应文稿"},
            c002={"decision": "discard", "scriptLine": "", "reason": "报遍数", "evidence": "第3遍"},
        ))
        self.assertFalse(output["segments"][1].get("disabled"))
        marker = output["markers"]["items"][0]
        self.assertEqual(marker["review"]["reason"], "片段包含数字，需要人工确认")
        stats = artifact.stats
        assert stats is not None
        self.assertEqual(stats["pendingReview"], 1)

    def test_dissimilar_alt_take_becomes_review(self) -> None:
        script = ["大家好欢迎回到我的频道"]
        segments = [
            _segment(0, 4000, script[0]),
            _segment(4000, 8000, "顺便说一下我上个周末去爬山看到了日出"),
        ]
        project_path, script_path = self.request(_project(segments), script)
        artifact, output, _ = _run(self.directory, project_path, script_path, _decisions(
            c001={"decision": "discard", "scriptLine": script[0], "reason": "废片", "altTakeId": "c002"},
            c002={"decision": "keep", "scriptLine": "", "reason": "题外话"},
        ))
        self.assertFalse(output["segments"][0].get("disabled"))
        marker = output["markers"]["items"][0]
        self.assertEqual(marker["review"]["reason"], "备用片段与当前片段相似度过低")
        stats = artifact.stats
        assert stats is not None
        self.assertEqual(stats["pendingReview"], 1)
        self.assertEqual(stats["removed"], 0)

    def test_discard_without_evidence_becomes_review(self) -> None:
        script = ["大家好欢迎回到我的频道"]
        segments = [_segment(0, 4000, script[0])]
        project_path, script_path = self.request(_project(segments), script)
        artifact, output, _ = _run(self.directory, project_path, script_path, _decisions(
            c001={"decision": "discard", "scriptLine": script[0], "reason": "感觉多余"},
        ))
        self.assertFalse(output["segments"][0].get("disabled"))
        marker = output["markers"]["items"][0]
        self.assertEqual(marker["review"]["reason"], "证据引用未在原文中找到")
        stats = artifact.stats
        assert stats is not None
        self.assertEqual(stats["pendingReview"], 1)


class MissingScriptLineTest(AiCleanupTestCase):
    def test_clip_without_script_line_can_still_be_removed_by_pattern(self) -> None:
        # 缺失文稿行：该段不在文稿中，但属于可本地验证的流程用语。
        script = ["大家好欢迎回到我的频道"]
        segments = [
            _segment(0, 1500, "等一下我重新来一遍"),
            _segment(1500, 5000, script[0]),
        ]
        project_path, script_path = self.request(_project(segments), script)
        artifact, output, _ = _run(self.directory, project_path, script_path, _decisions(
            c001={"decision": "discard", "scriptLine": "", "reason": "重录预告", "evidence": "重新来一遍"},
            c002={"decision": "keep", "scriptLine": script[0], "reason": "对应文稿"},
        ))
        self.assertTrue(output["segments"][0].get("disabled"))
        stats = artifact.stats
        assert stats is not None
        self.assertEqual(stats["removed"], 1)
        self.assertEqual(stats["matchedLines"], 1)


class NoItemsSegmentTest(AiCleanupTestCase):
    def test_segment_without_items_is_kept_and_flagged_for_review(self) -> None:
        script = ["大家好欢迎回到我的频道"]
        segments = [
            _segment(0, 2000, "这段没有字词时间", with_items=False),
            _segment(2000, 5000, script[0]),
        ]
        project_path, script_path = self.request(_project(segments), script)
        artifact, output, calls = _run(self.directory, project_path, script_path, _decisions(
            c001={"decision": "keep", "scriptLine": script[0], "reason": "对应文稿"},
        ))
        self.assertEqual(len(calls[0]), 1)
        self.assertEqual(calls[0][0]["id"], "c001")
        self.assertFalse(output["segments"][0].get("disabled"))
        marker = output["markers"]["items"][0]
        self.assertEqual(marker["start"], 0)
        self.assertEqual(marker["review"]["reason"], "缺少字词时间，无法安全移除")
        stats = artifact.stats
        assert stats is not None
        self.assertEqual(stats["pendingReview"], 1)


class ClipPayloadPrivacyTest(AiCleanupTestCase):
    def test_payload_carries_temp_ids_and_text_only(self) -> None:
        script = ["大家好欢迎回到我的频道"]
        segments = [_segment(0, 4000, script[0])]
        clips = build_clips(_project(segments)["segments"], script)  # type: ignore[arg-type]
        self.assertEqual(clips[0]["id"], "c001")
        self.assertEqual(
            set(clips[0]),
            {"id", "asrText", "scriptLine", "prevScriptLine", "nextScriptLine", "scriptMatch"},
        )
        joined = json.dumps(clips, ensure_ascii=False)
        self.assertNotIn("/Users/", joined)
        self.assertNotIn("start", joined)
        self.assertNotIn("end", joined)


class BatchContextTest(AiCleanupTestCase):
    def test_neighboring_takes_are_read_only_but_can_be_referenced(self) -> None:
        from unittest import mock
        from maw import postprocess_ai_cleanup as cleanup
        lines = ["开始讲这个功能", "这个功能提升效率啊", "这个功能提升效率", "继续讲使用方法", "最后总结"]
        project, script = self.request(_project([
            _segment(i * 1000, (i + 1) * 1000, text) for i, text in enumerate(lines)
        ]), lines)
        batches = []

        def complete(_prompt, rows):
            batches.append(rows)
            return {"decisions": [
                {"id": row["id"], "scriptLine": row["scriptLine"], "reason": "保留",
                 **({"decision": "discard", "altTakeId": "c003"} if row["id"] == "c002" else {"decision": "keep"})}
                for row in rows if row.get("contextOnly") != "true"
            ]}

        with mock.patch.object(cleanup, "CLIPS_PER_REQUEST", 2):
            artifact = run_ai_cleanup(AiCleanupRequest(
                project_path=project, srt_path=None, script_path=script,
                output_mode=OutputMode.BOTH, output_directory=self.directory, review_enabled=False), complete=complete)
        self.assertEqual([[row["id"] for row in rows if row.get("contextOnly") != "true"]
                          for rows in batches], [["c001", "c002"], ["c003", "c004"], ["c005"]])
        self.assertEqual([row["id"] for row in batches[0] if row.get("contextOnly") == "true"], ["c003", "c004", "c005"])
        self.assertEqual([row["id"] for row in batches[-1] if row.get("contextOnly") == "true"], ["c002", "c003", "c004"])
        self.assertTrue(json.loads(artifact.project_path.read_text(encoding="utf-8"))["segments"][1]["disabled"])
        self.assertTrue(all("start" not in row and "speaker" not in row for rows in batches for row in rows))

    def test_deciding_a_context_row_is_rejected_without_output(self) -> None:
        from unittest import mock
        from maw import postprocess_ai_cleanup as cleanup
        project, script = self.request(_project([
            _segment(i * 1000, (i + 1) * 1000, "保留内容") for i in range(3)
        ]), ["保留内容"])

        def complete(_prompt, rows):
            return {"decisions": [{"id": row["id"], "decision": "keep", "scriptLine": row["scriptLine"]}
                                   for row in rows]}

        with mock.patch.object(cleanup, "CLIPS_PER_REQUEST", 2), self.assertRaises(LlmClientError):
            run_ai_cleanup(AiCleanupRequest(project_path=project, srt_path=None, script_path=script,
                                           output_mode=OutputMode.BOTH), complete=complete)
        self.assertEqual(list(self.directory.glob("*.mosp")), [project])


class InvalidResponseTest(AiCleanupTestCase):
    def test_invalid_protocol_retries_then_fails_without_output(self) -> None:
        script = ["大家好欢迎回到我的频道"]
        segments = [_segment(0, 4000, script[0])]
        project_path, script_path = self.request(_project(segments), script)
        attempts: list[list[dict[str, str]]] = []

        def complete(_prompt: str, clips: list[dict[str, str]]) -> dict[str, object]:
            attempts.append(clips)
            return {"decisions": [{"id": "c999", "decision": "keep", "scriptLine": ""}]}

        request = AiCleanupRequest(
            project_path=project_path,
            srt_path=None,
            script_path=script_path,
            output_mode=OutputMode.BOTH,
            output_directory=self.directory,
        )
        with self.assertRaises(LlmClientError):
            run_ai_cleanup(request, complete=complete)
        self.assertEqual(len(attempts), 2)
        self.assertEqual(list(self.directory.glob("*.mosp")), [project_path])

    def test_protocol_retry_recovers_on_second_response(self) -> None:
        script = ["大家好欢迎回到我的频道"]
        segments = [_segment(0, 4000, script[0])]
        project_path, script_path = self.request(_project(segments), script)
        responses = [
            {"decisions": []},
            {"decisions": [{"id": "c001", "decision": "keep", "scriptLine": script[0], "reason": "ok"}]},
        ]
        calls: list[int] = []

        def complete(_prompt: str, _clips: list[dict[str, str]]) -> dict[str, object]:
            calls.append(1)
            return responses[len(calls) - 1]

        request = AiCleanupRequest(
            project_path=project_path,
            srt_path=None,
            script_path=script_path,
            output_mode=OutputMode.BOTH,
            output_directory=self.directory,
        )
        artifact = run_ai_cleanup(request, complete=complete)
        self.assertEqual(len(calls), 2)
        stats = artifact.stats
        assert stats is not None
        self.assertEqual(stats["matchedLines"], 1)

    def test_empty_script_is_rejected(self) -> None:
        from maw.postprocess_io import PostprocessFileError

        segments = [_segment(0, 4000, "大家好")]
        project_path, script_path = self.request(_project(segments), ["　"])
        request = AiCleanupRequest(
            project_path=project_path,
            srt_path=None,
            script_path=script_path,
            output_mode=OutputMode.BOTH,
            output_directory=self.directory,
        )
        with self.assertRaises(PostprocessFileError):
            run_ai_cleanup(request, complete=lambda _p, _c: {"decisions": []})


class ExistingGapRemoveTest(AiCleanupTestCase):
    def test_existing_audio_gate_layer_is_preserved(self) -> None:
        script = ["大家好欢迎回到我的频道"]
        existing_gap_remove = {
            "schema": "moy.asr.gap_remove.v1",
            "detector": "audio_gate",
            "minimum_ms": 900,
            "skip_playback": True,
            "gaps": [{"start": 20000, "end": 24000, "removed": True}],
            "provenance": {
                "schema": "moy.asr.gap_provenance.v1",
                "sources": {
                    "script_alignment": [],
                    "audio_gate": [{"start": 20000, "end": 24000}],
                },
                "manual_overrides": [],
                "legacy": [],
            },
        }
        segments = [
            _segment(0, 2000, "试麦试麦听得到吗"),
            _segment(2000, 5000, script[0]),
        ]
        project_path, script_path = self.request(
            _project(segments, gap_remove=existing_gap_remove), script,
        )
        artifact, output, _ = _run(self.directory, project_path, script_path, _decisions(
            c001={"decision": "discard", "scriptLine": "", "reason": "试麦", "evidence": "听得到吗"},
            c002={"decision": "keep", "scriptLine": script[0], "reason": "对应文稿"},
        ))
        provenance = output["gap_remove"]["provenance"]["sources"]
        self.assertEqual(
            [(item["start"], item["end"]) for item in provenance["audio_gate"]],
            [(20000, 24000)],
        )
        self.assertEqual(
            [(item["start"], item["end"]) for item in provenance["ai_cleanup"]],
            [(0, 2000)],
        )
        gaps = output["gap_remove"]["gaps"]
        self.assertTrue(any(gap["start"] == 20000 and gap["end"] == 24000 for gap in gaps))
        self.assertTrue(any(gap["start"] == 0 and gap["end"] == 2000 for gap in gaps))
        self.assertEqual(output["gap_remove"]["minimum_ms"], 900)
        stats = artifact.stats
        assert stats is not None
        self.assertEqual(stats["removed"], 1)


class MarkersRoundTripTest(AiCleanupTestCase):
    def test_review_markers_survive_project_normalization(self) -> None:
        from maw.project import normalize_project

        script = ["大家好欢迎回到我的频道"]
        segments = [
            _segment(0, 4000, script[0]),
            _segment(4000, 9000, "顺便说一下我上个周末去爬山看到了日出"),
        ]
        project_path, script_path = self.request(_project(segments), script)
        _artifact, output, _ = _run(self.directory, project_path, script_path, _decisions(
            c001={"decision": "keep", "scriptLine": script[0], "reason": "对应文稿"},
            c002={"decision": "review", "scriptLine": "", "reason": "题外话待确认"},
        ))
        normalized = normalize_project(output)
        markers = normalized["markers"]
        self.assertEqual(markers["schema"], "moy.asr.markers.v1")
        self.assertEqual(markers["items"][0]["review"], {"status": "pending", "reason": "题外话待确认"})


class LlmCompleteTransportTest(unittest.TestCase):
    def test_llm_complete_calls_transport_with_signature_and_retries_json(self) -> None:
        """llm_complete 走真实传输闭包：on_delta 以关键字传递，坏 JSON 重试一次。"""

        import maw.postprocess_ai_cleanup as cleanup_module
        from maw.postprocess_llm import LlmSettings

        seen: list[dict[str, object]] = []

        def fake_completion(settings, prompt, cues, *, on_delta):
            attempt = len(seen)
            seen.append({"prompt": prompt, "cues": cues, "onDelta": on_delta})
            content = '{"decisions": []}' if attempt else "{not json"
            return {"choices": [{"message": {"content": content}}]}

        settings = LlmSettings(provider_id="custom", api_key="key", base_url="https://example.invalid/v4", model="demo")
        original = cleanup_module._request_completion
        cleanup_module._request_completion = fake_completion
        try:
            result = cleanup_module.llm_complete(settings)("system prompt", [{"id": "c001", "asrText": "文字"}])
        finally:
            cleanup_module._request_completion = original
        self.assertEqual(result, {"decisions": []})
        self.assertEqual(len(seen), 2)
        self.assertIsNone(seen[0]["onDelta"])
        self.assertIsNone(seen[1]["onDelta"])
        self.assertNotIn("未通过本地协议校验", str(seen[0]["prompt"]))
        self.assertIn("未通过本地协议校验", str(seen[1]["prompt"]))


class CleanupNotesTest(AiCleanupTestCase):
    def test_notes_survive_batches_and_protocol_retry_without_changing_recording(self) -> None:
        from unittest import mock
        from maw import postprocess_ai_cleanup as cleanup
        original = [_segment(0, 1000, "第一句"), _segment(1000, 2000, "第二句")]
        project, script = self.request(_project(original), ["第一句", "第二句"])
        prompts = []

        def complete(prompt, clips):
            prompts.append(prompt)
            if len(prompts) == 1:
                return {"decisions": []}
            return {"decisions": [{"id": row["id"], "decision": "keep", "reason": "保留", "scriptLine": row["scriptLine"]}
                                  for row in clips if row.get("contextOnly") != "true"]}

        with mock.patch.object(cleanup, "CLIPS_PER_REQUEST", 1):
            artifact = run_ai_cleanup(AiCleanupRequest(
                project_path=project, srt_path=None, script_path=script, output_mode=OutputMode.BOTH,
                output_directory=self.directory, notes="  保留所有数字\n去除试麦  "), complete=complete)
        self.assertEqual(len(prompts), 3)
        for prompt in prompts:
            self.assertIn("保留所有数字\n去除试麦", prompt)
            self.assertIn("不得据此改写、翻译或总结任何文字", prompt)
        output = json.loads(artifact.project_path.read_text(encoding="utf-8"))
        for before, after in zip(original, output["segments"], strict=True):
            for key in ("text", "start", "end", "items"):
                self.assertEqual(before[key], after[key])

    def test_blank_notes_keep_the_default_prompt(self) -> None:
        from maw.postprocess_ai_cleanup import _system_prompt
        self.assertEqual(_system_prompt(" \n "), _system_prompt())


if __name__ == "__main__":
    unittest.main()
