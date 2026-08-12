# pyright: reportAny=false, reportImplicitOverride=false, reportUninitializedInstanceVariable=false

from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import final
from unittest import mock

from maw.postprocess import (
    LlmPostprocessRequest,
    OutputMode,
    Replacement,
    ReplacementRequest,
    apply_llm_groups,
    run_fixed_replacement,
    run_llm_postprocess,
)
from maw.postprocess_ffmpeg import FfconcatRequest, parse_ffconcat, run_ffconcat_rebuild
from maw.postprocess_io import PostprocessFileError, _atomic_write, read_project, read_srt, render_srt
from maw.postprocess_llm import LlmClientError, LlmSettings, _chat_endpoint, _models_endpoint, _reasoning_parameters, complete_subtitle_groups, list_llm_models, normalize_reasoning_mode, test_llm_connection as check_llm_connection
from maw.project_preview import JsonDict


def sample_project(media: Path) -> JsonDict:
    return {
        "media": str(media),
        "language": "zh",
        "segments": [
            {
                "start": 100,
                "end": 900,
                "text": "酒很好喝",
                "items": [
                    {"start": 100, "end": 300, "text": "酒"},
                    {"start": 300, "end": 900, "text": "很好喝"},
                ],
                "speaker": "speaker-1",
            },
            {
                "start": 1200,
                "end": 2200,
                "text": "下一句",
                "color": {"name": "蓝色", "value": "#3366ff"},
            },
        ],
    }


def project_segments(project: JsonDict) -> list[JsonDict]:
    raw_segments = project.get("segments")
    if not isinstance(raw_segments, list):
        raise AssertionError("project must contain a segment array")
    segments: list[JsonDict] = []
    for segment in raw_segments:
        if not isinstance(segment, dict):
            raise AssertionError("all project segments must be objects")
        segments.append(segment)
    return segments


@final
class PostprocessTests(unittest.TestCase):
    temp_dir: tempfile.TemporaryDirectory[str]
    root: Path
    media: Path
    project_path: Path

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.media = self.root / "clip.mp4"
        _ = self.media.write_bytes(b"media")
        self.project_path = self.root / "clip.mosp"
        _ = self.project_path.write_text(
            json.dumps(sample_project(self.media), ensure_ascii=False),
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_fixed_replacement_preserves_timing_and_creates_chainable_outputs(self) -> None:
        request = ReplacementRequest(
            project_path=self.project_path,
            srt_path=None,
            output_mode=OutputMode.BOTH,
            replacements=(Replacement(source="酒", target="8+1"),),
        )

        first = run_fixed_replacement(request)
        if first.project_path is None or first.srt_path is None:
            self.fail("both output mode must create project and SRT files")
        second = run_fixed_replacement(
            ReplacementRequest(
                project_path=first.project_path,
                srt_path=first.srt_path,
                output_mode=OutputMode.BOTH,
                replacements=(Replacement(source="很好喝", target="饮用提示"),),
            )
        )

        first_segments = project_segments(read_project(first.project_path))
        source_segments = project_segments(read_project(self.project_path))
        self.assertEqual(first_segments[0]["text"], "8+1很好喝")
        self.assertEqual(first_segments[0]["start"], 100)
        self.assertEqual(first_segments[0]["end"], 900)
        self.assertNotIn("items", first_segments[0])
        self.assertEqual(first_segments[0]["speaker"], "speaker-1")
        self.assertEqual(first_segments[1]["color"], source_segments[1]["color"])
        self.assertEqual(source_segments[0]["text"], "酒很好喝")
        self.assertTrue(first.srt_path.is_file())
        self.assertIn("00:00:00,100 --> 00:00:00,900", first.srt_path.read_text(encoding="utf-8"))
        self.assertEqual(second.source_project_path, first.project_path)
        self.assertNotEqual(second.project_path, first.project_path)

    def test_srt_only_output_is_the_authoritative_next_input(self) -> None:
        first = run_fixed_replacement(
            ReplacementRequest(
                project_path=self.project_path,
                srt_path=None,
                output_mode=OutputMode.SRT,
                replacements=(Replacement(source="酒", target="饮料"),),
            )
        )
        if first.srt_path is None:
            self.fail("SRT output mode must create an SRT file")

        second = run_fixed_replacement(
            ReplacementRequest(
                project_path=None,
                srt_path=first.srt_path,
                output_mode=OutputMode.SRT,
                replacements=(Replacement(source="饮料", target="茶"),),
            )
        )

        if second.srt_path is None:
            self.fail("SRT output mode must create an SRT file")
        self.assertIn("茶很好喝", second.srt_path.read_text(encoding="utf-8"))
        self.assertNotIn("酒很好喝", second.srt_path.read_text(encoding="utf-8"))

    def test_llm_groups_can_redistribute_text_but_not_timing(self) -> None:
        project = sample_project(self.media)
        groups: JsonDict = {
            "groups": [
                {"id": "c0001", "text": "This belongs first", "start": 999999},
                {"id": "c0002", "text": "and this belongs second", "end": 1},
            ]
        }

        processed = apply_llm_groups(project, groups)

        source_segments = project_segments(project)
        result_segments = project_segments(processed)
        self.assertEqual(
            [(segment["start"], segment["end"]) for segment in result_segments],
            [(segment["start"], segment["end"]) for segment in source_segments],
        )
        self.assertEqual(result_segments[0]["text"], "This belongs first")
        self.assertNotIn("items", result_segments[0])
        self.assertEqual(result_segments[1]["color"], source_segments[1]["color"])

    def test_llm_groups_reject_missing_reordered_or_unknown_ids(self) -> None:
        project = sample_project(self.media)
        invalid_outputs: tuple[JsonDict, ...] = (
            {"groups": [{"id": "c0001", "text": "only one"}]},
            {"groups": [{"id": "c0002", "text": "two"}, {"id": "c0001", "text": "one"}]},
            {"groups": [{"id": "c0001", "text": "one"}, {"id": "c9999", "text": "bad"}]},
        )

        for output in invalid_outputs:
            with self.subTest(output=output):
                with self.assertRaises(ValueError):
                    _ = apply_llm_groups(project, output)

    def test_llm_noop_preserves_word_timings_and_segment_metadata(self) -> None:
        project = sample_project(self.media)
        first_segment = project_segments(project)[0]
        first_segment["note"] = "keep this"
        groups: JsonDict = {
            "groups": [
                {"id": "c0001", "text": "酒很好喝"},
                {"id": "c0002", "text": "下一句"},
            ]
        }

        processed = apply_llm_groups(project, groups)

        result = project_segments(processed)[0]
        self.assertEqual(result["items"], first_segment["items"])
        self.assertEqual(result["note"], "keep this")

    def test_llm_text_edit_preserves_unknown_metadata_but_drops_word_timings(self) -> None:
        project = sample_project(self.media)
        first_segment = project_segments(project)[0]
        first_segment["note"] = "keep this"

        processed = apply_llm_groups(project, {
            "groups": [
                {"id": "c0001", "text": "酒很适合饮用"},
                {"id": "c0002", "text": "下一句"},
            ]
        })

        result = project_segments(processed)[0]
        self.assertEqual(result["note"], "keep this")
        self.assertNotIn("items", result)

    def test_llm_regroup_removes_all_positional_visual_refs_and_word_timings(self) -> None:
        project = sample_project(self.media)
        segments = project_segments(project)
        segments[0]["color"] = {"name": "黄色", "value": "#ffcc00"}
        segments[1].pop("color", None)
        segments[1]["color_ref"] = {"headIdx": 0}
        segments.append({
            "start": 2400,
            "end": 3000,
            "text": "第三句",
            "items": [{"start": 2400, "end": 3000, "text": "第三句"}],
            "sticker_ref": {"headIdx": 0},
        })
        project["segments"] = segments

        processed = apply_llm_groups(project, {
            "groups": [
                {"source_ids": ["c0001", "c0002"], "text": "合并前两句"},
                {"id": "c0003", "text": "第三句"},
            ]
        })

        result = project_segments(processed)
        self.assertEqual([(item["start"], item["end"]) for item in result], [(100, 2200), (2400, 3000)])
        for segment in result:
            self.assertNotIn("items", segment)
            self.assertNotIn("color", segment)
            self.assertNotIn("color_ref", segment)
            self.assertNotIn("sticker", segment)
            self.assertNotIn("sticker_ref", segment)

    def test_llm_rejects_merging_enabled_and_disabled_cues(self) -> None:
        project = sample_project(self.media)
        project_segments(project)[1]["disabled"] = True

        with self.assertRaisesRegex(ValueError, "enabled and disabled"):
            _ = apply_llm_groups(project, {
                "groups": [{"source_ids": ["c0001", "c0002"], "text": "不可混合"}]
            })

    def test_srt_output_keeps_text_after_blank_lines(self) -> None:
        first_segment = project_segments(sample_project(self.media))[0]
        first_segment["text"] = "第一段\n\n第二段"
        _ = self.project_path.write_text(
            json.dumps(sample_project(self.media), ensure_ascii=False),
            encoding="utf-8",
        )
        project = read_project(self.project_path)
        project_segments(project)[0]["text"] = "第一段\n\n第二段"
        _ = self.project_path.write_text(json.dumps(project, ensure_ascii=False), encoding="utf-8")

        result = run_fixed_replacement(
            ReplacementRequest(
                project_path=self.project_path,
                srt_path=None,
                output_mode=OutputMode.SRT,
                replacements=(),
            )
        )

        if result.srt_path is None:
            self.fail("SRT output mode must create an SRT file")
        segments = project_segments(read_srt(result.srt_path))
        self.assertEqual(segments[0]["text"], "第一段\n第二段")

    def test_srt_export_omits_disabled_cues_and_renumbers_visible_cues(self) -> None:
        project = sample_project(self.media)
        segments = project_segments(project)
        segments[0]["disabled"] = True

        rendered = render_srt(project)

        self.assertNotIn("酒很好喝", rendered)
        self.assertIn("1\n00:00:01,200 --> 00:00:02,200\n下一句", rendered)
        self.assertNotIn("\n2\n", rendered)

    def test_srt_reader_rejects_a_block_without_timing(self) -> None:
        malformed = self.root / "malformed.srt"
        _ = malformed.write_text(
            "1\n00:00:00,000 --> 00:00:01,000\nfirst\n\n2\nnot a timestamp\nmissing\n",
            encoding="utf-8",
        )

        with self.assertRaisesRegex(PostprocessFileError, "cue 2 has no timing line"):
            _ = read_srt(malformed)

    def test_atomic_write_removes_temporary_file_after_encoding_failure(self) -> None:
        target = self.root / "result.json"

        with self.assertRaises(UnicodeEncodeError):
            _atomic_write(target, "invalid surrogate: \ud800")

        self.assertEqual(list(self.root.glob(".result.json.*.tmp")), [])

    def test_llm_api_rejects_plain_http_except_for_loopback(self) -> None:
        self.assertEqual(_chat_endpoint("http://127.0.0.1:11434/v1"), "http://127.0.0.1:11434/v1/chat/completions")
        self.assertEqual(_chat_endpoint("http://localhost:11434/v1"), "http://localhost:11434/v1/chat/completions")
        with self.assertRaises(LlmClientError):
            _ = _chat_endpoint("http://example.com/v1")

    def test_reasoning_modes_normalize_and_map_by_provider(self) -> None:
        self.assertEqual(LlmSettings("custom", "key", "https://example.com", "local").reasoning_mode, "off")
        self.assertEqual(normalize_reasoning_mode(None), "off")
        self.assertEqual(normalize_reasoning_mode("default"), "off")
        self.assertEqual(normalize_reasoning_mode("disabled"), "off")
        self.assertEqual(
            _reasoning_parameters(LlmSettings("qwen", "key", "https://example.com", "qwen3.7-plus", "low")),
            {"enable_thinking": True, "thinking_budget": 4096},
        )
        self.assertEqual(
            _reasoning_parameters(LlmSettings("zhipu", "key", "https://example.com", "glm-5.2", "off")),
            {"thinking": {"type": "disabled"}},
        )
        self.assertEqual(
            _reasoning_parameters(LlmSettings("deepseek", "key", "https://example.com", "deepseek-v4-flash", "high")),
            {"thinking": {"type": "enabled"}, "reasoning_effort": "high"},
        )
        self.assertEqual(_reasoning_parameters(LlmSettings("custom", "key", "https://example.com", "local", "off")), {})
        self.assertEqual(_reasoning_parameters(LlmSettings("custom", "key", "https://example.com", "local", "auto")), {})
        with self.assertRaises(ValueError):
            _ = normalize_reasoning_mode("maximum")

    def test_llm_streaming_separates_reasoning_and_json_content(self) -> None:
        settings = LlmSettings(
            provider_id="qwen",
            api_key="sk-test",
            base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
            model="qwen3.7-plus",
            reasoning_mode="medium",
        )
        response = mock.Mock()
        response.iter_lines.return_value = [
            f"data: {json.dumps({'choices': [{'delta': {'reasoning_content': '先检查字幕'}}]}, ensure_ascii=False)}",
            f"data: {json.dumps({'choices': [{'delta': {'content': '{\"groups\":['}}]}, ensure_ascii=False)}",
            f"data: {json.dumps({'choices': [{'delta': {'content': '{\"id\":\"c0001\",\"text\":\"完成\"}]'}}]}, ensure_ascii=False)}",
            f"data: {json.dumps({'choices': [{'delta': {'content': '}'}}]}, ensure_ascii=False)}",
            "data: [DONE]",
        ]
        session = mock.MagicMock()
        session.__enter__.return_value = session
        session.post.return_value = response
        deltas: list[tuple[str, str]] = []

        with mock.patch("maw.postprocess_llm.requests.Session", return_value=session):
            result = complete_subtitle_groups(
                settings,
                "Return JSON.",
                [{"id": "c0001", "text": "原文"}],
                on_delta=lambda kind, text: deltas.append((kind, text)),
            )

        self.assertEqual(result, {"groups": [{"id": "c0001", "text": "完成"}]})
        self.assertEqual(deltas[0], ("reasoning", "先检查字幕"))
        self.assertEqual("".join(text for kind, text in deltas if kind == "content"), '{"groups":[{"id":"c0001","text":"完成"}]}')
        request = session.post.call_args
        self.assertTrue(request.kwargs["stream"])
        self.assertEqual(request.kwargs["headers"]["X-DashScope-SSE"], "enable")
        self.assertTrue(request.kwargs["json"]["stream"])
        self.assertEqual(request.kwargs["json"]["thinking_budget"], 16384)
        response.close.assert_called_once_with()

    def test_llm_connection_sends_minimal_request(self) -> None:
        settings = LlmSettings(
            provider_id="custom",
            api_key="sk-test",
            base_url="https://example.com/v1",
            model="custom-model",
        )
        response = mock.Mock()
        session = mock.MagicMock()
        session.__enter__.return_value = session
        session.post.return_value = response

        with mock.patch("maw.postprocess_llm.requests.Session", return_value=session):
            check_llm_connection(settings)

        session.post.assert_called_once_with(
            "https://example.com/v1/chat/completions",
            headers={"Authorization": "Bearer sk-test"},
            json={
                "model": "custom-model",
                "messages": [{"role": "user", "content": "Reply with OK."}],
                "max_tokens": 1,
            },
            timeout=(10, 30),
        )
        response.raise_for_status.assert_called_once_with()

    def test_llm_model_listing_parses_openai_compatible_response(self) -> None:
        settings = LlmSettings(
            provider_id="custom",
            api_key="sk-test",
            base_url="https://example.com/v1",
            model="manual-model",
        )
        response = mock.Mock()
        response.json.return_value = {
            "data": [
                {"id": "model-b"},
                {"id": "model-a"},
                {"id": "model-b"},
            ]
        }
        session = mock.MagicMock()
        session.__enter__.return_value = session
        session.get.return_value = response

        with mock.patch("maw.postprocess_llm.requests.Session", return_value=session):
            models = list_llm_models(settings)

        self.assertEqual(models, ["model-b", "model-a"])
        self.assertEqual(_models_endpoint("https://example.com/v1"), "https://example.com/v1/models")
        session.get.assert_called_once_with(
            "https://example.com/v1/models",
            headers={"Authorization": "Bearer sk-test"},
            timeout=(10, 30),
        )
        response.raise_for_status.assert_called_once_with()

    def test_llm_model_listing_accepts_models_name_shape_and_rejects_empty(self) -> None:
        settings = LlmSettings("custom", "sk-test", "https://example.com/v1/chat/completions", "manual-model")
        response = mock.Mock()
        response.json.return_value = {"models": [{"name": "named-model"}, "string-model"]}
        session = mock.MagicMock()
        session.__enter__.return_value = session
        session.get.return_value = response

        with mock.patch("maw.postprocess_llm.requests.Session", return_value=session):
            self.assertEqual(list_llm_models(settings), ["named-model", "string-model"])
            response.json.return_value = {"data": []}
            with self.assertRaisesRegex(LlmClientError, "model list is empty"):
                _ = list_llm_models(settings)

    def test_llm_runner_batches_large_projects_before_provider_call(self) -> None:
        project = sample_project(self.media)
        project["segments"] = [
            {"start": index * 1000, "end": (index + 1) * 1000, "text": f"cue {index}"}
            for index in range(301)
        ]
        _ = self.project_path.write_text(json.dumps(project), encoding="utf-8")
        batches: list[list[dict[str, str]]] = []

        def complete(_system_prompt: str, cues: list[dict[str, str]]) -> JsonDict:
            batches.append(cues)
            return {"groups": [{"id": cue["id"], "text": cue["text"]} for cue in cues]}

        result = run_llm_postprocess(
            LlmPostprocessRequest(
                project_path=self.project_path,
                srt_path=None,
                output_mode=OutputMode.JSON,
                operation="proofread",
                custom_prompt="",
            ),
            complete=complete,
        )

        self.assertEqual([len(batch) for batch in batches], [300, 1])
        self.assertIn("分批", "".join(result.warnings))

    def test_llm_runner_reports_progress_stages(self) -> None:
        statuses: list[tuple[str, dict[str, int]]] = []

        def complete(_system_prompt: str, cues: list[dict[str, str]]) -> JsonDict:
            return {"groups": [{"id": cue["id"], "text": cue["text"]} for cue in cues]}

        _ = run_llm_postprocess(
            LlmPostprocessRequest(
                project_path=self.project_path,
                srt_path=None,
                output_mode=OutputMode.JSON,
                operation="proofread",
                custom_prompt="",
            ),
            complete=complete,
            on_status=lambda key, details: statuses.append((key, dict(details))),
        )

        self.assertEqual(
            [key for key, _details in statuses],
            [
                "toolbox_status_reading",
                "toolbox_status_preparing_llm",
                "toolbox_status_llm_batch",
                "toolbox_status_llm_batch_done",
                "toolbox_status_reorganizing",
                "toolbox_status_writing",
            ],
        )
        self.assertEqual(statuses[2][1], {"current": 1, "total": 1})

    def test_llm_runner_uses_visible_task_prompt_and_keeps_custom_prompt(self) -> None:
        prompts: list[str] = []

        def complete(system_prompt: str, cues: list[dict[str, str]]) -> JsonDict:
            prompts.append(system_prompt)
            return {"groups": [{"id": cue["id"], "text": cue["text"]} for cue in cues]}

        _ = run_llm_postprocess(
            LlmPostprocessRequest(
                project_path=self.project_path,
                srt_path=None,
                output_mode=OutputMode.JSON,
                operation="proofread",
                custom_prompt="保留口语表达。",
                task_prompt="只修正品牌名，不要翻译。",
            ),
            complete=complete,
        )

        self.assertEqual(len(prompts), 1)
        self.assertIn("任务：只修正品牌名，不要翻译。", prompts[0])
        self.assertIn("用户附加要求：保留口语表达。", prompts[0])

    def test_llm_translation_preserves_source_boundaries(self) -> None:
        prompts: list[str] = []

        def complete(system_prompt: str, cues: list[dict[str, str]]) -> JsonDict:
            prompts.append(system_prompt)
            return {
                "groups": [
                    {"id": cues[0]["id"], "text": "The wine is delicious."},
                    {"id": cues[1]["id"], "text": "The next sentence."},
                ]
            }

        result = run_llm_postprocess(
            LlmPostprocessRequest(
                project_path=self.project_path,
                srt_path=None,
                output_mode=OutputMode.BOTH,
                operation="translate_en",
                custom_prompt="",
            ),
            complete=complete,
        )

        if result.project_path is None or result.srt_path is None:
            self.fail("both output mode must create project and SRT files")
        source_segments = project_segments(read_project(self.project_path))
        translated_segments = project_segments(read_project(result.project_path))
        self.assertEqual(len(translated_segments), len(source_segments))
        self.assertEqual(
            [(segment["start"], segment["end"]) for segment in translated_segments],
            [(segment["start"], segment["end"]) for segment in source_segments],
        )
        self.assertEqual(
            [segment["text"] for segment in translated_segments],
            ["The wine is delicious.", "The next sentence."],
        )
        self.assertNotIn("items", translated_segments[0])
        self.assertEqual(translated_segments[0]["speaker"], "speaker-1")
        self.assertEqual(translated_segments[1]["color"], source_segments[1]["color"])
        self.assertIn("每组只能包含一个 source ID", prompts[0])

    def test_llm_translation_rejects_regrouping(self) -> None:
        def complete(_system_prompt: str, _cues: list[dict[str, str]]) -> JsonDict:
            return {"groups": [{"source_ids": ["c0001", "c0002"], "text": "Merged translation"}]}

        with self.assertRaisesRegex(ValueError, "translation output must preserve"):
            _ = run_llm_postprocess(
                LlmPostprocessRequest(
                    project_path=self.project_path,
                    srt_path=None,
                    output_mode=OutputMode.JSON,
                    operation="translate_zh",
                    custom_prompt="",
                ),
                complete=complete,
            )

    def test_llm_custom_operation_has_no_preset_task_prompt(self) -> None:
        prompts: list[str] = []

        def complete(system_prompt: str, cues: list[dict[str, str]]) -> JsonDict:
            prompts.append(system_prompt)
            return {"groups": [{"id": cue["id"], "text": cue["text"]} for cue in cues]}

        _ = run_llm_postprocess(
            LlmPostprocessRequest(
                project_path=self.project_path,
                srt_path=None,
                output_mode=OutputMode.JSON,
                operation="custom",
                custom_prompt="只保留口语表达。",
                task_prompt="",
            ),
            complete=complete,
        )

        self.assertEqual(len(prompts), 1)
        self.assertNotIn("\n任务：", prompts[0])
        self.assertIn("用户附加要求：只保留口语表达。", prompts[0])

    def test_llm_runner_writes_project_and_matching_srt(self) -> None:
        def complete(_system_prompt: str, cues: list[dict[str, str]]) -> JsonDict:
            return {"groups": [{"id": cue["id"], "text": f"校对：{cue['text']}"} for cue in cues]}

        result = run_llm_postprocess(
            LlmPostprocessRequest(
                project_path=self.project_path,
                srt_path=None,
                output_mode=OutputMode.BOTH,
                operation="proofread",
                custom_prompt="",
            ),
            complete=complete,
        )

        if result.project_path is None or result.srt_path is None:
            self.fail("both output mode must create project and SRT files")
        segments = project_segments(read_project(result.project_path))
        self.assertEqual(segments[0]["text"], "校对：酒很好喝")
        self.assertIn("校对：酒很好喝", result.srt_path.read_text(encoding="utf-8"))
        self.assertEqual(segments[0]["start"], 100)


@final
class FfconcatTests(unittest.TestCase):
    temp_dir: tempfile.TemporaryDirectory[str]
    root: Path
    media: Path
    concat: Path

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.media = self.root / "clip.mp4"
        _ = self.media.write_bytes(b"media")
        self.concat = self.root / "clip_gap-removed.ffconcat"
        normalized = self.media.as_posix().replace("'", "'\\''")
        concat_text = "".join(
            (
                f"ffconcat version 1.0\nfile '{normalized}'\ninpoint 0.100\noutpoint 0.900\n",
                f"file '{normalized}'\ninpoint 1.200\noutpoint 2.200\n",
            )
        )
        _ = self.concat.write_text(
            concat_text,
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_ffconcat_accepts_only_configured_media_and_known_directives(self) -> None:
        parse_ffconcat(self.concat, self.media)

        outside = self.root / "other.mp4"
        _ = outside.write_bytes(b"media")
        _ = self.concat.write_text(
            f"ffconcat version 1.0\nfile '{outside.as_posix()}'\n",
            encoding="utf-8",
        )
        with self.assertRaises(ValueError):
            _ = parse_ffconcat(self.concat, self.media)

        _ = self.concat.write_text(
            "ffconcat version 1.0\noption protocol_whitelist file,http\n",
            encoding="utf-8",
        )
        with self.assertRaises(ValueError):
            _ = parse_ffconcat(self.concat, self.media)

    def test_ffconcat_rebuild_uses_argument_vector_and_suffixed_output(self) -> None:
        completed = mock.Mock(returncode=0, stderr="")

        def create_output(command: list[str], **_kwargs: object) -> mock.Mock:
            _ = Path(command[-1]).write_bytes(b"rebuilt")
            return completed

        with mock.patch("maw.postprocess_ffmpeg.subprocess.run", side_effect=create_output) as run:
            result = run_ffconcat_rebuild(
                FfconcatRequest(media_path=self.media, ffconcat_path=self.concat),
                ffmpeg_path=Path("ffmpeg"),
            )

        command = run.call_args.args[0]
        self.assertIsInstance(command, list)
        self.assertIn("-safe", command)
        self.assertIn(str(self.concat.resolve()), command)
        self.assertEqual(result.media_path.name, "clip.gap-removed.mp4")

    def test_ffconcat_rebuild_rejects_success_without_output_file(self) -> None:
        completed = mock.Mock(returncode=0, stderr="")

        with mock.patch("maw.postprocess_ffmpeg.subprocess.run", return_value=completed):
            with self.assertRaisesRegex(RuntimeError, "did not produce"):
                _ = run_ffconcat_rebuild(
                    FfconcatRequest(media_path=self.media, ffconcat_path=self.concat),
                    ffmpeg_path=Path("ffmpeg"),
                )

    def test_ffconcat_timeout_removes_partial_output_and_returns_domain_error(self) -> None:
        def timeout(command: list[str], **_kwargs: object) -> None:
            _ = Path(command[-1]).write_bytes(b"partial")
            raise subprocess.TimeoutExpired(command, 86_400)

        with mock.patch("maw.postprocess_ffmpeg.subprocess.run", side_effect=timeout):
            with self.assertRaisesRegex(RuntimeError, "timed out"):
                _ = run_ffconcat_rebuild(
                    FfconcatRequest(media_path=self.media, ffconcat_path=self.concat),
                    ffmpeg_path=Path("ffmpeg"),
                )

        self.assertFalse((self.root / "clip.gap-removed.part.mp4").exists())


if __name__ == "__main__":
    _ = unittest.main()
