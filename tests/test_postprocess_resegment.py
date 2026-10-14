from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from maw.postprocess import LlmPostprocessRequest, OutputMode, run_llm_postprocess
from maw.postprocess_io import read_project
from maw.postprocess_io import render_srt
from maw.postprocess_ai_cleanup import AiCleanupRequest, run_ai_cleanup
from maw.postprocess_ai_cleanup_items import cleaned_srt_segments
from maw.script_alignment import _gap_ranges_from_provenance
from maw.postprocess_llm import LlmClientError, LlmSettings
from maw.postprocess_resegment import (
    char_count,
    complete_boundaries,
    normalize_max_chars,
    remap_cleanup_scopes,
    source_units,
)


def timed(text, parts, start=0, **metadata):
    return {
        "start": start,
        "end": start + len(parts) * 200,
        "text": text,
        "items": [
            {"start": start + i * 200, "end": start + (i + 1) * 200, "text": p}
            for i, p in enumerate(parts)
        ],
        **metadata,
    }


class ResegmentTests(unittest.TestCase):
    def test_unsplittable_limits_are_pending_regions_without_modifying_source(self):
        _, artifact = self.run_case(
            [timed("完整名称不能拆", ["完整名称不能拆"])],
            lambda _prompt, _rows: {"draft": "[c0001a0001]"}, max_chars=3,
        )
        project = read_project(artifact.project_path)
        marker = project["markers"]["items"][0]
        self.assertEqual(marker["review"]["status"], "pending")
        self.assertEqual(marker["ai"]["task"], "resegment")
        self.assertEqual((marker["start"], marker["end"]), (0, 200))
        self.assertTrue(marker["note"].startswith("[AI] 待核查："))
        self.assertEqual(project["segments"][0]["text"], "完整名称不能拆")
        self.assertTrue(artifact.warnings)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "input.mosp"

    def run_case(self, segments, complete, max_chars=0, **kwargs):
        self.source.write_text(
            json.dumps({"segments": segments}, ensure_ascii=False), encoding="utf-8"
        )
        original = self.source.read_bytes()
        artifact = run_llm_postprocess(
            LlmPostprocessRequest(
                project_path=self.source,
                srt_path=None,
                output_mode=OutputMode.BOTH,
                operation="resegment",
                custom_prompt="",
                max_chars=max_chars,
                **kwargs,
            ),
            complete=complete,
        )
        self.assertEqual(original, self.source.read_bytes())
        return read_project(artifact.project_path)["segments"], artifact

    def last_boundary(self, _prompt, rows):
        return {"draft": f"[{rows[-1]['items'][-1]['id']}]"}

    def test_itemless_cue_cannot_remove_cut_cue_word_bindings(self):
        import copy
        from maw.postprocess_ai_cleanup import _build_gap_remove
        from maw.postprocess_ai_cleanup_items import scoped_item_ranges
        source = timed("这个这个方法", list("这个这个方法"), id="cut-cue")
        itemless = {"start": 1300, "end": 2500, "text": "没有词级时间", "id": "plain-cue"}
        project = {"segments": [source, itemless]}
        project["gap_remove"] = _build_gap_remove(project, scoped_item_ranges(source, [0, 1]))
        self.source.write_text(json.dumps(project, ensure_ascii=False), encoding="utf-8")
        calls = []
        def complete(_prompt, rows):
            calls.append(rows)
            return self.last_boundary(_prompt, rows)
        artifact = run_llm_postprocess(
            LlmPostprocessRequest(project_path=self.source, srt_path=None, output_mode=OutputMode.BOTH, operation="resegment", custom_prompt=""),
            complete=complete,
        )
        after = read_project(artifact.project_path)
        self.assertEqual(len(calls), 2)
        self.assertEqual([s["id"] for s in after["segments"]], ["cut-cue", "plain-cue"])
        self.assertNotIn("这个这个方法", render_srt(after))
        self.assertIn("这个方法", render_srt(after))
        self.assertIn("没有词级时间", render_srt(after))
        by_source = {i: source_units(segment, i) for i, segment in enumerate(project["segments"])}
        # A future caller must fail safely if it bypasses the separate batches.
        mixed = [{"id": "mixed", "start": 0, "end": 2500, "text": source["text"] + itemless["text"]}]
        with self.assertRaisesRegex(ValueError, "词项绑定"):
            remap_cleanup_scopes(copy.deepcopy(project), project["segments"], mixed, [[*by_source[0], *by_source[1]]], by_source)

    def test_bound_main_cue_is_preserved_while_unbound_cues_resegment_and_reopen(self):
        source = timed("绑定正文", ["绑定", "正文"], 700, id="bound-main")
        project = {
            "segments": [timed("介绍方法", ["介绍", "方法"], id="first"), source, timed("后续内容", ["后续", "内容"], 2000, id="last")],
            "multi_subtitle": {"schema": "moy.asr.multi_subtitle.v1", "enabled": False, "display_mode": "both", "tracks": [
                {"id": "english", "role": "extension", "segments": [{"id": "translated", "text": "Bound text", "start": 700, "end": 1100}]}
            ], "bindings": [{"id": "one-to-one", "track_id": "english", "main_segment_ids": ["bound-main"], "extension_segment_ids": ["translated"], "start_offset_ms": 0, "end_offset_ms": 0}]},
        }
        self.source.write_text(json.dumps(project, ensure_ascii=False), encoding="utf-8")
        calls = []
        def complete(_prompt, rows):
            calls.append(rows)
            return self.last_boundary(_prompt, rows)
        artifact = run_llm_postprocess(
            LlmPostprocessRequest(project_path=self.source, srt_path=None, output_mode=OutputMode.BOTH, operation="resegment", custom_prompt="", max_chars=2),
            complete=complete,
        )
        reopened = read_project(artifact.project_path)
        self.assertEqual([row["id"] for batch in calls for row in batch], ["c0001", "c0003"])
        self.assertEqual(next(segment for segment in reopened["segments"] if segment["id"] == "bound-main"), source)
        self.assertEqual([s["text"] for s in reopened["segments"]], ["介绍", "方法", "绑定正文", "后续", "内容"])
        self.assertEqual(reopened["multi_subtitle"], read_project(self.source)["multi_subtitle"])
        self.assertTrue(any("一对一" in warning and "超过最大 2 字" in warning for warning in artifact.warnings))
        self.assertIn("绑定正文", artifact.srt_path.read_text(encoding="utf-8-sig"))

    def test_cleanup_split_merge_and_manual_restore_preserve_words_and_audio(self):
        source = timed("这个这个这个方法", list("这个这个这个方法"), id="original")
        for item in source["items"]:
            item["end"] -= 80  # A cut spanning a split must retain internal pauses.
        self.source.write_text(json.dumps({"segments": [source]}, ensure_ascii=False), encoding="utf-8")
        cleanup = run_ai_cleanup(
            AiCleanupRequest(project_path=self.source, srt_path=None, script_path=None, output_mode=OutputMode.BOTH, review_enabled=False),
            complete=lambda _p, _r: {"timeline": "[c001] ~~这个这个~~这个方法"},
        )
        cleaned = read_project(cleanup.project_path)
        self.assertEqual("".join(s["text"] for s in cleaned_srt_segments(cleaned, cleaned["segments"])), "这个方法")
        original_gaps = cleaned["gap_remove"]["gaps"]
        split = run_llm_postprocess(
            LlmPostprocessRequest(project_path=cleanup.project_path, srt_path=None, output_mode=OutputMode.BOTH, operation="resegment", custom_prompt=""),
            complete=lambda _p, _r: {"draft": "[c0001a0001]\n[c0001a0003]\n[c0001a0008]"},
        )
        split_project = read_project(split.project_path)
        self.assertEqual("".join(s["text"] for s in split_project["segments"]), source["text"])
        self.assertEqual("".join(s["text"] for s in cleaned_srt_segments(split_project, split_project["segments"])), "这个方法")
        provenance = split_project["gap_remove"]["provenance"]
        cuts = provenance["sources"]["ai_cleanup"]
        self.assertEqual(len([r for r in cuts if r.get("cleanup_scope")]), 3)
        self.assertEqual(len([r for r in cuts if not r.get("cleanup_scope")]), 2)
        self.assertEqual(_gap_ranges_from_provenance(provenance), _gap_ranges_from_provenance(cleaned["gap_remove"]["provenance"]))
        self.assertEqual(split_project["gap_remove"]["gaps"], original_gaps)
        self.assertIn("这个方法", split.srt_path.read_text(encoding="utf-8-sig"))
        # Re-running cleanup sees retained words, rather than resurrected ones.
        seen_text = []
        def keep_remaining(_prompt, rows):
            seen_text.extend(row["asrText"] for row in rows)
            return {"timeline": "\n".join(f"[{row['id']}] {row['asrText']}" for row in rows)}
        run_ai_cleanup(
            AiCleanupRequest(project_path=split.project_path, srt_path=None, script_path=None, output_mode=OutputMode.BOTH, review_enabled=False),
            complete=keep_remaining,
        )
        self.assertEqual("".join(seen_text), "这个方法")
        merged = run_llm_postprocess(
            LlmPostprocessRequest(project_path=split.project_path, srt_path=None, output_mode=OutputMode.BOTH, operation="resegment", custom_prompt=""),
            complete=self.last_boundary,
        )
        merged_project = read_project(merged.project_path)
        self.assertEqual("".join(s["text"] for s in cleaned_srt_segments(merged_project, merged_project["segments"])), "这个方法")
        gap_remove = merged_project["gap_remove"]
        gap_remove["provenance"]["manual_overrides"].append({"id": "restore", "start": 0, "end": 720, "removed": False})
        gap_remove["gaps"] = _gap_ranges_from_provenance(gap_remove["provenance"])
        self.assertIn(source["text"], render_srt(merged_project))

    def test_sparse_draft_preserves_punctuation_and_item_times(self):
        source = timed("介绍，方法。", ["介绍", "方法"])
        result, _ = self.run_case(
            [source], lambda _p, _r: {"draft": "[c0001a0001]\n[c0001a0002]"}
        )
        self.assertEqual([r["text"] for r in result], ["介绍，", "方法。"])
        self.assertEqual([r["items"][0] for r in result], source["items"])
        self.assertEqual(
            [(r["start"], r["end"]) for r in result], [(0, 200), (200, 400)]
        )

    def test_maximum_is_enforced_when_model_returns_one_long_group(self):
        text = "先介绍这个工具然后演示不同功能最后保存结果"
        result, artifact = self.run_case(
            [timed(text, list(text))], self.last_boundary, 8, generate_comparison=True
        )
        self.assertTrue(all(char_count(r["text"]) <= 8 for r in result))
        self.assertEqual("".join(r["text"] for r in result), text)
        self.assertEqual(sum(len(r["items"]) for r in result), len(text))
        self.assertTrue(artifact.comparison_path.is_file())

    def test_missing_word_times_do_not_downgrade_other_cues(self):
        segments = [
            timed("演示这个功能", list("演示这个功能")),
            {"start": 1500, "end": 3000, "text": "这个段没有词级时间"},
            timed("最后保存结果", list("最后保存结果"), 3200),
        ]
        result, artifact = self.run_case(segments, self.last_boundary, 4)
        untimed = next(r for r in result if r["start"] == 1500)
        self.assertEqual(untimed["text"], segments[1]["text"])
        self.assertTrue(all("items" in r for r in result if r is not untimed))
        self.assertTrue(any("无法安全" in w for w in artifact.warnings))

    def test_overlong_word_and_numeric_quantity_are_kept_and_reported(self):
        for text, parts in [
            ("完整产品名称", ["完整产品名称"]),
            ("20公斤", ["20", "公斤"]),
        ]:
            with self.subTest(text=text):
                result, artifact = self.run_case(
                    [timed(text, parts)], self.last_boundary, 2
                )
                self.assertEqual([r["text"] for r in result], [text])
                self.assertTrue(any("无法安全" in w for w in artifact.warnings))

    def test_rewrite_truncation_unknown_and_reordered_boundaries_abort(self):
        for response in [
            {"draft": "[c0001a0001]"},
            {"draft": "[unknown]"},
            {"draft": "[c0001a0002]\n[c0001a0001]"},
            {"groups": [{"source_ids": ["c0001"], "text": "改写"}]},
        ]:
            with self.subTest(response=response):
                calls = []

                def complete(prompt, rows):
                    calls.append(prompt)
                    return response

                with self.assertRaises(ValueError):
                    self.run_case([timed("介绍方法", ["介绍", "方法"])], complete)
                self.assertEqual(len(calls), 2)
                self.assertFalse(list(self.root.glob("*.srt")))

    def test_disabled_speaker_and_long_pause_are_barriers(self):
        sources = [
            timed("第一句", ["第一句"], speaker="A"),
            timed("停用", ["停用"], 250, disabled=True),
            timed("第二句", ["第二句"], 500, speaker="A"),
            timed("回答", ["回答"], 750, speaker="B"),
            timed("另一节", ["另一节"], 3000, speaker="B"),
        ]
        calls = []

        def complete(prompt, rows):
            calls.append(rows)
            return self.last_boundary(prompt, rows)

        result, _ = self.run_case(sources, complete)
        self.assertEqual(len(calls), 4)
        self.assertEqual([r["text"] for r in result], [s["text"] for s in sources])
        self.assertTrue(result[1]["disabled"])

    def test_batch_context_is_read_only_and_not_time_metadata(self):
        seen = []

        def complete(prompt, rows):
            seen.append(rows)
            return self.last_boundary(prompt, rows)

        with mock.patch("maw.postprocess.MAX_LLM_CUES_PER_REQUEST", 1):
            result, _ = self.run_case(
                [timed("介绍", ["介绍"]), timed("方法", ["方法"], 200)], complete
            )
        self.assertEqual(seen[0][0]["contextAfter"], "方法")
        self.assertEqual(seen[1][0]["contextBefore"], "介绍")
        self.assertNotIn("start", seen[0][0]["items"][0])
        self.assertEqual(len(result), 2)

    def test_transient_failure_retains_original_metadata_and_words(self):
        calls = 0

        def complete(prompt, rows):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise LlmClientError("offline", category="network")
            return self.last_boundary(prompt, rows)

        sources = [
            timed("第一句", ["第一句"], note="保留"),
            timed("第二句", ["第二句"], 200),
        ]
        with mock.patch("maw.postprocess.MAX_LLM_CUES_PER_REQUEST", 1):
            result, artifact = self.run_case(sources, complete)
        self.assertEqual(result[0]["note"], "保留")
        self.assertEqual(result[0]["items"], sources[0]["items"])
        self.assertTrue(any("网络" in w for w in artifact.warnings))

    def test_cancellation_before_commit_creates_no_outputs(self):
        self.source.write_text(
            json.dumps({"segments": [timed("介绍", ["介绍"])]}), encoding="utf-8"
        )
        with self.assertRaises(LlmClientError):
            run_llm_postprocess(
                LlmPostprocessRequest(
                    self.source, None, OutputMode.BOTH, "resegment", ""
                ),
                complete=self.last_boundary,
                begin_commit=lambda: False,
            )
        self.assertFalse(list(self.root.glob("*.srt")))

    def test_limits_count_visible_characters_and_reject_invalid_values(self):
        self.assertEqual(char_count("中文 AI，\n"), 5)
        self.assertEqual(normalize_max_chars("18"), 18)
        for value in (-1, 501, 1.5, True, "abc"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                normalize_max_chars(value)

    def test_decimal_percentage_and_english_word_are_not_split_by_local_limit(self):
        for text, parts in [("3.5%", ["3", ".", "5", "%"]), ("OpenAI", ["Open", "AI"])]:
            with self.subTest(text=text):
                result, artifact = self.run_case(
                    [timed(text, parts)], self.last_boundary, 2
                )
                self.assertEqual([r["text"] for r in result], [text])
                self.assertTrue(any("无法安全" in w for w in artifact.warnings))

    def test_fragmented_ratios_fractions_and_thousands_are_not_split(self):
        for text, parts in [
            ("16:9", ["16", ":", "9"]),
            ("16：9", ["16", "：", "9"]),
            ("1/2", ["1", "/", "2"]),
            ("1,000", ["1", ",", "000"]),
        ]:
            with self.subTest(text=text):
                source = timed(text, parts)
                result, artifact = self.run_case([source], self.last_boundary, 2)
                self.assertEqual([r["text"] for r in result], [text])
                self.assertEqual(result[0]["items"], source["items"])
                self.assertTrue(any("无法安全" in w for w in artifact.warnings))

    def test_model_cannot_cut_either_side_of_numeric_separator(self):
        for cut in (1, 2):
            with self.subTest(cut=cut), self.assertRaisesRegex(ValueError, "比例"):
                self.run_case(
                    [timed("16:9", ["16", ":", "9"])],
                    lambda _p, _r: {"draft": f"[c0001a{cut:04d}]\n[c0001a0003]"},
                )

    def test_punctuation_after_number_still_allows_sentence_break(self):
        result, _ = self.run_case(
            [timed("选择方案1，接下来演示。", ["选择方案", "1", "接下来", "演示"])],
            lambda _p, _r: {"draft": "[c0001a0002]\n[c0001a0004]"},
        )
        self.assertEqual([r["text"] for r in result], ["选择方案1，", "接下来演示。"])

    def test_varying_limits_preserve_merged_words_punctuation_and_gap_times(self):
        sources = [
            timed("先介绍，", ["先", "介绍"], 100),
            timed("然后演示。", ["然后", "演示"], 800),
        ]
        source_items = [item for source in sources for item in source["items"]]
        for maximum in range(2, 11):
            with self.subTest(maximum=maximum):
                result, _ = self.run_case(sources, self.last_boundary, maximum)
                self.assertEqual(
                    "".join(r["text"] for r in result), "先介绍，然后演示。"
                )
                self.assertEqual(
                    [item for r in result for item in r["items"]], source_items
                )
                for segment in result:
                    self.assertEqual(segment["start"], segment["items"][0]["start"])
                    self.assertEqual(segment["end"], segment["items"][-1]["end"])
                    if char_count(segment["text"]) > maximum:
                        self.assertEqual(len(segment["items"]), 1)

    def test_transport_returns_raw_boundary_draft_without_json_constraint(self):
        settings = LlmSettings("custom", "key", "https://example.test/v1", "model")
        with mock.patch(
            "maw.postprocess_resegment._request_completion",
            return_value={"choices": [{"message": {"content": "[c0001a0001]"}}]},
        ) as call:
            self.assertEqual(
                complete_boundaries(settings, "prompt", []), {"draft": "[c0001a0001]"}
            )
        self.assertFalse(call.call_args.kwargs["use_json_format"])

    def test_numeric_video_units_are_protected_in_model_and_local_cuts(self):
        for text, parts in [
            ("1,000帧", ["1", ",", "000", "帧"]),
            ("36像素", ["36", "像素"]),
            ("60fps", ["60", "fps"]),
        ]:
            with self.subTest(text=text):
                result, artifact = self.run_case(
                    [timed(text, parts)], self.last_boundary, 2
                )
                self.assertEqual([s["text"] for s in result], [text])
                self.assertTrue(any("无法安全" in w for w in artifact.warnings))
                with self.assertRaisesRegex(ValueError, "数字与单位"):
                    self.run_case(
                        [timed(text, parts)],
                        lambda _p, _r: {
                            "draft": f"[c0001a{len(parts) - 1:04d}]\n[c0001a{len(parts):04d}]"
                        },
                    )

    def test_dangling_model_boundary_is_rebalanced_within_limit(self):
        parts = [
            "因为",
            "“以后还能改”",
            "的",
            "前提",
            "是",
            "时间码、",
            "原文",
            "和",
            "编辑",
            "决定",
            "都",
            "还在。",
        ]
        text = "".join(parts)
        result, _ = self.run_case(
            [timed(text, parts)],
            lambda _p, _r: {"draft": "[c0001a0005]\n[c0001a0012]"},
            24,
        )
        self.assertEqual("".join(s["text"] for s in result), text)
        self.assertTrue(all(char_count(s["text"]) <= 24 for s in result))
        self.assertFalse(
            any(s["text"].endswith(("是", "的", "和")) for s in result[:-1])
        )
        self.assertEqual(
            [i for s in result for i in s["items"]], timed(text, parts)["items"]
        )

    def test_complete_short_answer_and_good_model_boundaries_are_preserved(self):
        parts = [
            "可以。",
            "前者",
            "用于",
            "后续",
            "修改，",
            "后者",
            "用于",
            "直接",
            "播放。",
        ]
        result, _ = self.run_case(
            [timed("".join(parts), parts)],
            lambda _p, _r: {"draft": "[c0001a0001]\n[c0001a0005]\n[c0001a0009]"},
            14,
        )
        self.assertEqual(
            [s["text"] for s in result],
            ["可以。", "前者用于后续修改，", "后者用于直接播放。"],
        )

    def test_quantifier_boundary_does_not_break_following_modifier_phrase(self):
        parts = [
            "今天",
            "我们",
            "只",
            "讲",
            "一个",
            "容易",
            "被",
            "误解",
            "的",
            "问题：",
        ]
        for draft in ("[c0001a0005]\n[c0001a0010]", "[c0001a0010]"):
            with self.subTest(draft=draft):
                result, _ = self.run_case(
                    [timed("".join(parts), parts)],
                    lambda _p, _r: {"draft": draft},
                    14,
                )
                self.assertEqual(
                    [s["text"] for s in result],
                    ["今天我们只讲一个", "容易被误解的问题："],
                )

    def test_local_limit_does_not_leave_short_section_label_alone(self):
        parts = [
            "第二，",
            "把",
            "起始",
            "偏移",
            "设为",
            "1.5",
            "秒，",
            "而不是",
            "15",
            "秒。",
        ]
        result, _ = self.run_case(
            [timed("".join(parts), parts)],
            lambda _p, _r: {"draft": "[c0001a0001]\n[c0001a0010]"},
            14,
        )
        self.assertFalse(any(s["text"] == "第二，" for s in result))
        self.assertTrue(all(char_count(s["text"]) <= 14 for s in result))
