from __future__ import annotations

import base64
import json
import unittest
from pathlib import Path

from maw.script_alignment import (
    align_project_to_script,
    apply_alignment_to_project,
    detect_waveform_gaps,
    make_selection_manifest,
)


def segment(segment_id: str, start: int, end: int, text: str) -> dict[str, object]:
    return {
        "id": segment_id,
        "start": start,
        "end": end,
        "text": text,
        "items": [{"text": text, "start": start, "end": end}],
    }


def gap_shape(gap: dict[str, object]) -> tuple[int, int, bool]:
    return int(gap["start"]), int(gap["end"]), gap.get("removed") is not False


class ScriptAlignmentTests(unittest.TestCase):
    def setUp(self) -> None:
        self.project = {
            "media": "demo.wav",
            "segments": [
                segment("s1", 0, 400, "um"),
                segment("s2", 400, 900, "hello"),
                segment("s3", 900, 1400, "world"),
                segment("s4", 1500, 1800, "hello"),
                segment("s5", 1800, 2300, "world"),
                segment("s6", 2400, 2800, "great"),
                segment("s7", 3000, 3500, "good"),
                segment("s8", 3500, 4000, "bye"),
            ],
        }

    def test_default_path_prefers_latest_complete_take_and_classifies_gaps(self) -> None:
        alignment = align_project_to_script(self.project, "hello world\ngood bye")

        candidates_by_id = {
            candidate["id"]: candidate
            for line_candidates in alignment["candidatesByLine"]
            for candidate in line_candidates
        }
        self.assertEqual(
            [
                (
                    candidates_by_id[candidate_id]["sourceStartOrdinal"],
                    candidates_by_id[candidate_id]["sourceEndOrdinal"],
                )
                for candidate_id in alignment["defaultSelection"].values()
            ],
            [(3, 5), (6, 8)],
        )
        extras = alignment["extras"]
        self.assertEqual(
            [(item["kind"], item["reasonCode"], item["sourceText"]) for item in extras],
            [
                ("extra", "extra", "um"),
                ("skip-source", "alternative", "hello / world"),
                ("extra", "extra", "great"),
            ],
        )

    def test_extra_ranges_split_at_source_cue_boundaries(self) -> None:
        project = {
            "segments": [
                segment("s1", 0, 500, "hello"),
                segment("s2", 500, 1000, "side note one"),
                segment("s3", 1000, 1500, "side note two"),
                segment("s4", 1500, 2000, "world"),
            ],
        }
        alignment = align_project_to_script(project, "hello\nworld")
        selection = make_selection_manifest(alignment, alignment["defaultSelection"])

        extras = [item for item in selection["extraRanges"] if item["kind"] == "extra"]
        self.assertEqual(
            [(item["start"], item["end"], item["sourceText"]) for item in extras],
            [
                (500, 1000, "side note one"),
                (1000, 1500, "side note two"),
            ],
        )
        self.assertEqual([len(item["sourceSlices"]) for item in extras], [1, 1])

        discarded = make_selection_manifest(
            alignment,
            alignment["defaultSelection"],
            extra_actions={extras[0]["id"]: "discard"},
        )
        output = apply_alignment_to_project(project, alignment, discarded, detect_audio_gaps=False)
        self.assertTrue(next(item for item in output["segments"] if item["id"] == "s2")["disabled"])
        self.assertIsNone(next(item for item in output["segments"] if item["id"] == "s3").get("disabled"))

    def test_output_disables_unselected_take_and_keeps_extra_by_default(self) -> None:
        alignment = align_project_to_script(self.project, "hello world\ngood bye")
        selection = make_selection_manifest(alignment, alignment["defaultSelection"])
        output = apply_alignment_to_project(self.project, alignment, selection, detect_audio_gaps=False)

        self.assertTrue(selection["readyForMediaTrim"])
        self.assertEqual(
            [item["id"] for item in output["segments"] if item.get("disabled") is True],
            ["s2", "s3"],
        )
        self.assertEqual(output["gap_remove"]["schema"], "moy.asr.gap_remove.v1")
        self.assertEqual(
            output["gap_remove"]["gaps"],
            [
                {"start": 400, "end": 1500, "removed": True, "source": "script_alignment", "origins": ["script_alignment"]},
                {"start": 2300, "end": 2400, "removed": True, "source": "script_alignment", "origins": ["script_alignment"]},
                {"start": 2800, "end": 3000, "removed": True, "source": "script_alignment", "origins": ["script_alignment"]},
            ],
        )

    def test_alignment_gap_output_records_script_alignment_provenance(self) -> None:
        alignment = align_project_to_script(self.project, "hello world\ngood bye")
        selection = make_selection_manifest(alignment, alignment["defaultSelection"])
        output = apply_alignment_to_project(self.project, alignment, selection, detect_audio_gaps=False)

        self.assertEqual(
            output["gap_remove"]["provenance"]["schema"],
            "moy.asr.gap_provenance.v1",
        )
        self.assertEqual(
            [(gap["start"], gap["end"]) for gap in output["gap_remove"]["provenance"]["sources"]["script_alignment"]],
            [(400, 1500), (2300, 2400), (2800, 3000)],
        )
        self.assertTrue(all(
            gap["source"] == "script_alignment"
            and gap["origins"] == ["script_alignment"]
            for gap in output["gap_remove"]["gaps"]
        ))

    def test_alignment_replaces_script_layer_but_preserves_manual_and_audio_layers(self) -> None:
        project = {
            "segments": [segment("s1", 0, 1000, "hello")],
            "gap_remove": {
                "provenance": {
                    "schema": "moy.asr.gap_provenance.v1",
                    "sources": {
                        "script_alignment": [{"id": "old-align", "start": 0, "end": 50}],
                        "audio_gate": [{"id": "silence", "start": 200, "end": 300}],
                    },
                    "manual_overrides": [{"id": "hand", "start": 400, "end": 500, "removed": True}],
                    "legacy": [],
                },
            },
        }
        alignment = align_project_to_script(project, "hello")
        selection = make_selection_manifest(alignment, alignment["defaultSelection"])
        output = apply_alignment_to_project(project, alignment, selection, detect_audio_gaps=False)
        provenance = output["gap_remove"]["provenance"]

        self.assertEqual(provenance["sources"]["script_alignment"], [])
        self.assertEqual(
            [(item["start"], item["end"]) for item in provenance["sources"]["audio_gate"]],
            [(200, 300)],
        )
        self.assertEqual(
            [(item["start"], item["end"], item["removed"]) for item in provenance["manual_overrides"]],
            [(400, 500, True)],
        )
        self.assertEqual(
            [(gap["start"], gap["end"], gap["source"]) for gap in output["gap_remove"]["gaps"]],
            [(200, 300, "audio_gate"), (400, 500, "manual")],
        )

    def test_alignment_migrates_legacy_gap_ranges_to_audio_gate(self) -> None:
        project = {
            "segments": [segment("s1", 0, 1000, "hello")],
            "gap_remove": {
                "gaps": [
                    {"start": 200, "end": 300, "removed": True},
                    {"start": 400, "end": 500, "removed": False},
                ],
            },
        }
        alignment = align_project_to_script(project, "hello")
        selection = make_selection_manifest(alignment, alignment["defaultSelection"])
        output = apply_alignment_to_project(project, alignment, selection, detect_audio_gaps=False)
        provenance = output["gap_remove"]["provenance"]

        self.assertEqual(provenance["legacy"], [])
        self.assertEqual(
            [(item["start"], item["end"], item["removed"])
            for item in provenance["sources"]["audio_gate"]],
            [(200, 300, True)],
        )
        self.assertEqual(
            [(item["start"], item["end"], item["removed"])
            for item in provenance["manual_overrides"]],
            [(400, 500, False)],
        )
        self.assertEqual(
            [(gap["start"], gap["end"], gap["removed"], gap["source"])
            for gap in output["gap_remove"]["gaps"]],
            [(200, 300, True, "audio_gate"), (400, 500, False, "manual")],
        )

    def test_discarding_extra_disables_its_subtitle_and_removes_its_range(self) -> None:
        alignment = align_project_to_script(self.project, "hello world\ngood bye")
        default = alignment["defaultSelection"]
        preview = make_selection_manifest(alignment, default)
        extra_id = next(item["id"] for item in preview["extraRanges"] if item["sourceText"] == "great")
        selection = make_selection_manifest(
            alignment,
            default,
            extra_actions={extra_id: "discard"},
        )
        output = apply_alignment_to_project(self.project, alignment, selection, detect_audio_gaps=False)

        self.assertIn("s6", [item["id"] for item in output["segments"] if item.get("disabled") is True])
        self.assertIn(
            (2300, 3000, True),
            [gap_shape(gap) for gap in output["gap_remove"]["gaps"]],
        )

    def test_incomplete_and_missing_script_are_not_ready(self) -> None:
        project = {"segments": [segment("s1", 0, 500, "hello")]}
        alignment = align_project_to_script(project, "hello world\ncompletely absent")
        selection = make_selection_manifest(alignment, alignment["defaultSelection"])

        self.assertEqual(selection["incompleteLineIds"], ["line-001"])
        self.assertEqual(selection["missingLineIds"], ["line-002"])
        self.assertFalse(selection["readyForMediaTrim"])
        output = apply_alignment_to_project(project, alignment, selection, detect_audio_gaps=False)
        self.assertTrue(output["segments"][0]["disabled"])

    def test_manual_enable_overrides_auto_disabled_incomplete_take(self) -> None:
        project = {"segments": [segment("s1", 0, 500, "hello")]}
        alignment = align_project_to_script(project, "hello world")
        candidate = alignment["candidatesByLine"][0][0]

        selection = make_selection_manifest(
            alignment,
            alignment["defaultSelection"],
            candidate_actions={candidate["id"]: "keep"},
        )
        self.assertEqual(selection["incompleteLineIds"], ["line-001"])
        self.assertEqual(selection["blockedIncompleteLineIds"], [])
        self.assertEqual(selection["manuallyEnabledCandidateIds"], [candidate["id"]])
        self.assertTrue(selection["selected"][0]["manualEnabled"])
        self.assertTrue(selection["readyForMediaTrim"])

        output = apply_alignment_to_project(project, alignment, selection, detect_audio_gaps=False)
        self.assertIsNone(output["segments"][0].get("disabled"))
        self.assertEqual(
            output["script_alignment"]["manuallyEnabledCandidateIds"],
            [candidate["id"]],
        )

    def test_manual_disable_overrides_selected_complete_take(self) -> None:
        project = {"segments": [segment("s1", 0, 500, "hello")]}
        alignment = align_project_to_script(project, "hello")
        candidate = alignment["candidatesByLine"][0][0]
        self.assertEqual(candidate["status"], "match")

        selection = make_selection_manifest(
            alignment,
            alignment["defaultSelection"],
            candidate_actions={candidate["id"]: "discard"},
        )
        self.assertEqual(selection["candidateActions"], {candidate["id"]: "discard"})
        self.assertTrue(selection["selected"][0]["manualDisabled"])
        self.assertEqual(selection["manuallyDisabledCandidateIds"], [candidate["id"]])
        self.assertEqual(selection["manuallyDisabledLineIds"], ["line-001"])
        self.assertTrue(selection["readyForMediaTrim"])

        output = apply_alignment_to_project(
            project,
            alignment,
            selection,
            detect_audio_gaps=False,
        )
        self.assertTrue(output["segments"][0]["disabled"])
        self.assertIn((0, 500, True), [gap_shape(gap) for gap in output["gap_remove"]["gaps"]])

    def test_suffix_aligned_partial_take_is_retained_as_incomplete(self) -> None:
        project = {"segments": [segment("s1", 0, 500, "world")]}
        alignment = align_project_to_script(project, "hello world")

        candidates = alignment["candidatesByLine"][0]
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]["status"], "incomplete")
        self.assertGreaterEqual(candidates[0]["suffixMatch"], 3)

    def test_waveform_gap_detector_matches_mawe_gate_shape(self) -> None:
        # 10 peaks/s: loud, a long silent run, loud.  The middle gap is
        # trimmed by the same lead-in/lead-out policy as MAWE.
        raw = bytearray()
        for index in range(20):
            value = 100 if index in {0, 12, 13, 19} else 0
            raw.extend((0, value))
        waveform = {
            "schema": "moy.asr.waveform.v1",
            "encoding": "i8-minmax-base64",
            "peaks_per_second": 10,
            "duration_ms": 2000,
            "data": base64.b64encode(raw).decode("ascii"),
        }

        self.assertEqual(
            detect_waveform_gaps(waveform, minimum_ms=500, lead_in_ms=40, lead_out_ms=80),
            [{"start": 140, "end": 1120}],
        )

    def test_item_boundary_splits_valid_prefix_from_extra_tail(self) -> None:
        target = "目前支持画面上的这些模型"
        tail = "之后还会继续增加"
        items: list[dict[str, object]] = []
        cursor = 0
        for text in target:
            items.append({"text": text, "start": cursor, "end": cursor + 100})
            cursor += 100
        target_end = cursor
        cursor += 280
        tail_start = cursor
        for text in tail:
            items.append({"text": text, "start": cursor, "end": cursor + 100})
            cursor += 100
        project = {
            "segments": [{
                "id": "s1",
                "start": 0,
                "end": cursor,
                "text": target + tail,
                "items": items,
            }],
        }

        alignment = align_project_to_script(project, target + "！")
        candidate = alignment["candidatesByLine"][0][0]
        self.assertEqual((candidate["start"], candidate["end"], candidate["status"]), (0, target_end, "match"))
        self.assertEqual(candidate["sourceSlices"][0]["itemEnd"], len(target))

        selection = make_selection_manifest(alignment, alignment["defaultSelection"])
        extra = next(item for item in selection["extraRanges"] if item["sourceText"] == tail)
        self.assertEqual((extra["start"], extra["end"], extra["kind"]), (tail_start, cursor, "extra"))

        kept_output = apply_alignment_to_project(project, alignment, selection, detect_audio_gaps=False)
        self.assertEqual(
            [
                (segment["id"], segment["start"], segment["end"], segment["text"], segment.get("disabled"))
                for segment in kept_output["segments"]
            ],
            [
                ("s1", 0, target_end, target, None),
                ("s1--align-002", tail_start, cursor, tail, None),
            ],
        )
        self.assertIn(
            (target_end, tail_start, True),
            [gap_shape(gap) for gap in kept_output["gap_remove"]["gaps"]],
        )

        discarded_selection = make_selection_manifest(
            alignment,
            alignment["defaultSelection"],
            extra_actions={extra["id"]: "discard"},
        )
        discarded_output = apply_alignment_to_project(
            project,
            alignment,
            discarded_selection,
            detect_audio_gaps=False,
        )
        self.assertIsNone(discarded_output["segments"][0].get("disabled"))
        self.assertTrue(discarded_output["segments"][1]["disabled"])
        self.assertIn(
            (target_end, cursor, True),
            [gap_shape(gap) for gap in discarded_output["gap_remove"]["gaps"]],
        )

        compact_items = [
            {"text": item["text"], "start": index * 100, "end": (index + 1) * 100}
            for index, item in enumerate(items)
        ]
        compact_project = {
            "segments": [{
                "id": "s1",
                "start": 0,
                "end": cursor,
                "text": target + tail,
                "items": compact_items,
            }],
        }
        compact_alignment = align_project_to_script(compact_project, target)
        self.assertEqual(compact_alignment["candidatesByLine"][0], [])

    def test_internal_repetition_is_not_an_alternative_and_is_removed(self) -> None:
        project = {
            "segments": [
                segment("s1", 0, 1000, "本地模型、AI校准和翻译、"),
                segment("s2", 1100, 2000, "双语字幕、"),
                segment("s3", 2200, 3100, "双语字幕、"),
                segment("s4", 3300, 4300, "免费ASR、"),
                segment("s5", 4500, 5500, "这些功能全都加上了"),
            ],
        }
        script = "本地模型、AI校准和翻译、双语字幕、免费ASR、这些功能全都加上了"

        alignment = align_project_to_script(project, script)
        candidate = next(
            item
            for item in alignment["candidatesByLine"][0]
            if item["sourceStartOrdinal"] == 0
            and item["sourceEndOrdinal"] == 5
        )
        self.assertEqual(candidate["status"], "match")
        self.assertEqual(
            [item["sourceText"] for item in candidate["internalSkips"]],
            ["双语字幕、"],
        )

        selection = make_selection_manifest(alignment, alignment["defaultSelection"])
        repetition = next(
            item for item in selection["extraRanges"]
            if item["reasonCode"] == "repetition"
        )
        self.assertEqual(
            (repetition["kind"], repetition["sourceText"], repetition["defaultAction"]),
            ("skip-source", "双语字幕、", "discard"),
        )

        output = apply_alignment_to_project(
            project,
            alignment,
            selection,
            detect_audio_gaps=False,
        )
        self.assertTrue(next(item for item in output["segments"] if item["id"] == "s2")["disabled"])
        self.assertIsNone(next(item for item in output["segments"] if item["id"] == "s3").get("disabled"))
        self.assertIn(
            (1000, 2200, True),
            [gap_shape(gap) for gap in output["gap_remove"]["gaps"]],
        )

    def test_distant_match_stays_outside_local_alternative_group(self) -> None:
        project = {
            "segments": [
                segment("s1", 0, 900, "双语字幕"),
                segment("s2", 9000, 9900, "双语字幕"),
                segment("s3", 10500, 11400, "双语字幕"),
                segment("s4", 50000, 50900, "双语字幕"),
            ],
        }

        alignment = align_project_to_script(project, "双语字幕")
        candidates = alignment["candidatesByLine"][0]
        self.assertEqual(
            [candidate["alternativeGroupSize"] for candidate in candidates],
            [3, 3, 3, 1],
        )
        self.assertEqual(
            len({candidate["alternativeGroupId"] for candidate in candidates[:3]}),
            1,
        )
        self.assertNotEqual(
            candidates[2]["alternativeGroupId"],
            candidates[3]["alternativeGroupId"],
        )
        self.assertEqual(
            alignment["defaultSelection"]["line-001"],
            candidates[2]["id"],
        )

        selection = make_selection_manifest(alignment, alignment["defaultSelection"])
        self.assertTrue(any(
            extra["kind"] == "skip-source"
            and extra["reasonCode"] == "alternative"
            and extra["sourceStartOrdinal"] == 0
            for extra in selection["extraRanges"]
        ))
        self.assertTrue(any(
            extra["kind"] == "extra"
            and extra["reasonCode"] == "distant-match"
            and extra["sourceStartOrdinal"] == 3
            and extra["defaultAction"] == "keep"
            for extra in selection["extraRanges"]
        ))

    def test_pre_retake_extra_is_auto_discarded_as_incomplete(self) -> None:
        project = {
            "segments": [
                segment("s1", 0, 3040, "鼠标位置也会常态显示一个指针cursor"),
                segment("s2", 4000, 5280, "鼠标位置也会尝试显"),
                segment("s3", 6000, 9200, "鼠标位置也会常态显示一个cursor方便"),
                segment("s4", 9200, 10000, "辨认波形"),
            ],
        }
        script = "鼠标位置会常态显示一个指针，方便辨认波形。"

        alignment = align_project_to_script(project, script)
        selection = make_selection_manifest(alignment, alignment["defaultSelection"])
        by_text = {
            item["sourceText"]: item
            for item in selection["extraRanges"]
            if item["sourceText"] in {
                "鼠标位置也会常态显示一个指针cursor",
                "鼠标位置也会尝试显",
            }
        }

        self.assertEqual(
            by_text["鼠标位置也会尝试显"]["kind"],
            "skip-source",
        )
        self.assertEqual(
            by_text["鼠标位置也会尝试显"]["reasonCode"],
            "incomplete",
        )
        self.assertEqual(
            {
                text: item["defaultAction"]
                for text, item in by_text.items()
            },
            {
                "鼠标位置也会常态显示一个指针cursor": "discard",
                "鼠标位置也会尝试显": "discard",
            },
        )

    def test_real_mosp_keeps_only_real_take_boundaries(self) -> None:
        root = Path(__file__).resolve().parents[1]
        project_path = root / "examples" / "MAW-1.4更新说明.bcut.mosp"
        script_path = root / "examples" / "MAW-1.4更新说明-文稿.txt"
        if not project_path.is_file() or not script_path.is_file():
            self.skipTest("real alignment example is not available")

        project = json.loads(project_path.read_text(encoding="utf-8"))
        alignment = align_project_to_script(
            project,
            script_path.read_text(encoding="utf-8"),
        )

        # Source #1-#3 and #5-#9 are two complete recordings of the first
        # script line.  Adjacent sliding windows must not become extra takes.
        self.assertEqual(
            [
                (candidate["sourceStartOrdinal"], candidate["sourceEndOrdinal"], candidate["status"])
                for candidate in alignment["candidatesByLine"][0]
            ],
            [(0, 3, "match"), (4, 9, "match")],
        )
        latest_take = alignment["candidatesByLine"][0][1]
        self.assertEqual(
            [item["sourceText"] for item in latest_take["internalSkips"]],
            ["双语字幕"],
        )

        # The two line-40 candidates have the same score; the default path
        # should still prefer the later local take.
        line_40 = alignment["candidatesByLine"][39]
        self.assertEqual(
            alignment["defaultSelection"]["line-040"],
            max(line_40, key=lambda candidate: candidate["sourceStartOrdinal"])["id"],
        )

        # Source #28 is a failed prefix; source #29-#30 is the restarted,
        # complete version of script line 15.
        line_15 = alignment["candidatesByLine"][14]
        self.assertIn((27, 28, "incomplete"), [
            (candidate["sourceStartOrdinal"], candidate["sourceEndOrdinal"], candidate["status"])
            for candidate in line_15
        ])
        self.assertIn((28, 30, "match"), [
            (candidate["sourceStartOrdinal"], candidate["sourceEndOrdinal"], candidate["status"])
            for candidate in line_15
        ])
        self.assertTrue(any(
            extra["kind"] == "skip-source"
            and extra["reasonCode"] == "incomplete"
            and extra["sourceStartOrdinal"] == 27
            and extra["sourceEndOrdinal"] == 28
            for extra in alignment["extras"]
        ))

        # The exact Linux title must not inherit the preceding line's
        # "游戏实况超好用" cue, and the following sentence must use only its
        # own two source cues.
        self.assertEqual(
            [
                (candidate["sourceStartOrdinal"], candidate["sourceEndOrdinal"], candidate["sourceText"])
                for candidate in alignment["candidatesByLine"][26]
            ],
            [(56, 57, "LINUX客户端")],
        )
        self.assertEqual(
            [
                (candidate["sourceStartOrdinal"], candidate["sourceEndOrdinal"], candidate["status"])
                for candidate in alignment["candidatesByLine"][27]
            ],
            [(57, 59, "match")],
        )

        # The source segment #20 contains the complete script line followed
        # by an extra sentence.  Item timestamps must expose the two ranges
        # separately instead of turning the script line into missing-script.
        line_9 = alignment["candidatesByLine"][8]
        self.assertEqual(
            [
                (candidate["start"], candidate["end"], candidate["sourceText"], candidate["status"])
                for candidate in line_9
            ],
            [(46390, 48230, "目前支持画面上的这些模型", "match")],
        )
        selection = make_selection_manifest(alignment, alignment["defaultSelection"])
        near_repeat_candidate = next(
            candidate
            for line_candidates in alignment["candidatesByLine"]
            for candidate in line_candidates
            if candidate["sourceStartOrdinal"] == 122
            and candidate["sourceEndOrdinal"] == 125
        )
        self.assertEqual(
            [
                (item["reasonCode"], item["sourceText"])
                for item in near_repeat_candidate["internalSkips"]
            ],
            [("repetition", "现在距离这些发布功能")],
        )
        self.assertTrue(any(
            extra["kind"] == "skip-source"
            and extra["reasonCode"] == "repetition"
            and extra["sourceText"] == "按Z或者X可以快速的将字幕块的前后位置"
            for extra in selection["extraRanges"]
        ))
        self.assertTrue(any(
            extra["kind"] == "extra"
            and extra["sourceText"] == "按Z或者X可以快速的将字幕的起始或结束位置"
            for extra in selection["extraRanges"]
        ))
        self.assertTrue(any(
            extra["kind"] == "skip-source"
            and extra["reasonCode"] == "repetition"
            and extra["sourceText"] == "双语字幕"
            for extra in selection["extraRanges"]
        ))
        self.assertTrue(any(
            extra["kind"] == "extra"
            and extra["sourceText"] == "之后还会继续增加"
            and extra["start"] == 48510
            and extra["end"] == 49750
            for extra in selection["extraRanges"]
        ))
        pre_retake = {
            extra["sourceStartOrdinal"]: extra
            for extra in selection["extraRanges"]
            if extra.get("sourceStartOrdinal") in {115, 116}
        }
        self.assertEqual(
            [
                (pre_retake[index]["kind"], pre_retake[index]["reasonCode"], pre_retake[index]["defaultAction"])
                for index in (115, 116)
            ],
            [
                ("skip-source", "repetition", "discard"),
                ("skip-source", "incomplete", "discard"),
            ],
        )
        output = apply_alignment_to_project(project, alignment, selection, detect_audio_gaps=False)
        self.assertEqual(
            [
                (segment.get("start"), segment.get("end"), segment.get("text"), segment.get("disabled"))
                for segment in output["segments"]
                if isinstance(segment, dict) and 46000 <= int(segment.get("start") or 0) < 50000
            ],
            [
                (46390, 48230, "目前支持画面上的这些模型", None),
                (48510, 49750, "之后还会继续增加", None),
            ],
        )


if __name__ == "__main__":
    unittest.main()
