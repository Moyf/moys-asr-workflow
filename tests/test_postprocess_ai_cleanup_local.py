"""Local AI removal uses explicit source items, never estimated timestamps."""
from __future__ import annotations

import copy
import json
import tempfile
import unittest
from pathlib import Path

from maw.postprocess import OutputMode
from maw.postprocess_ai_cleanup import AiCleanupRequest, build_clips, run_ai_cleanup, _build_clips, _build_gap_remove
from maw.postprocess_ai_cleanup_items import scoped_item_ranges, verified_scope_indices
from maw.postprocess_io import read_project, render_srt
from maw.script_alignment import _gap_ranges_from_provenance, _normalize_gap_provenance
from tests.track_helpers import main_segments
from tests.track_helpers import extension_tracks


def cue(rows, *, text=None):
    return {"id": "main-001", "start": 0, "end": 2000,
            "text": text if text is not None else "".join(row[0] for row in rows),
            "items": [{"text": text, "start": start, "end": end} for text, start, end in rows]}


PREFIX = [("啊，", 0, 210), ("我这……", 220, 770), ("我这个功能呢", 900, 2000)]
MULTI = [("我", 0, 110), ("我这个", 130, 430), ("功能", 500, 800),
         ("嗯", 810, 930), ("很好", 1000, 1200), ("呢", 1300, 2000)]


class LocalCleanupTests(unittest.TestCase):
    def run_case(self, segment, decision, script, *, review=False, extras=None, flags=None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "input.mosp"
            project = {"segments": [segment], **(extras or {})}
            original = json.dumps(project, ensure_ascii=False)
            source.write_text(original, encoding="utf-8")
            manuscript = root / "script.txt"
            manuscript.write_text(script, encoding="utf-8")
            calls = []
            def complete(prompt, rows):
                calls.append((prompt, rows))
                if "proposed" in rows[0]:
                    return {"reviews": flags or []}
                return {"decisions": [{"id": "c001", "decision": "discard", "scriptLine": rows[0]["scriptLine"], **decision}]}
            artifact = run_ai_cleanup(AiCleanupRequest(source, None, manuscript, OutputMode.BOTH, review_enabled=review), complete=complete)
            self.assertEqual(source.read_text(encoding="utf-8"), original)
            output = read_project(artifact.project_path)
            self.assertEqual(render_srt(output), artifact.srt_path.read_text(encoding="utf-8-sig"))
            return output, artifact.stats, calls

    def test_prefix_keeps_original_enabled_and_exports_retained_words(self):
        original = cue(PREFIX)
        output, stats, calls = self.run_case(original, {"removeItemIds": ["c001:i001", "c001:i002"], "evidence": "啊，我这……"}, "我这个功能呢", review=True)
        self.assertEqual(main_segments(output)[0], original)
        scope = output["gap_remove"]["provenance"]["sources"]["ai_cleanup"][0]
        self.assertEqual((scope["start"], scope["end"]), (0, 770))
        self.assertEqual(scope["cleanup_scope"], {"segment_id": "main-001", "item_start": 0, "item_end": 2, "text": "啊，我这……"})
        self.assertEqual((output["markers"]["items"][0]["start"], output["markers"]["items"][0]["end"]), (0, 770))
        self.assertEqual(stats["removed"], 1)
        review_rows = next(rows for _prompt, rows in calls if "proposed" in rows[0])
        self.assertEqual(review_rows[0]["retainedText"], "我这个功能呢")
        self.assertEqual(review_rows[0]["proposed"], "partial")
        self.assertIn("00:00:00,900 --> 00:00:02,000\n我这个功能呢", render_srt(output))
        self.assertNotIn("我这……", render_srt(output))
        items = json.loads(calls[0][1][0]["items"])
        self.assertEqual(set(items[0]), {"id", "text"})

    def test_repeated_local_cleanup_maps_filtered_items_back_to_source_and_restores_old_cuts(self):
        cases = [
            ([("啊", 0, 200), ("嗯", 200, 400), ("介绍功能", 400, 1200)], [0], [1], "啊介绍功能"),
            ([("啊", 0, 200), ("嗯", 200, 400), ("呃", 400, 600), ("哦", 600, 800), ("介绍功能", 800, 1200)], [0, 2], [1, 3], "啊呃介绍功能"),
        ]
        for rows, old_deleted, new_deleted, restored_text in cases:
            for wire_key in ("removeItemIds", "removeItemRanges"):
                with self.subTest(old_deleted=old_deleted, wire_key=wire_key):
                    segment = cue(rows)
                    initial = {"segments": [segment]}
                    gap = _build_gap_remove(initial, scoped_item_ranges(segment, old_deleted))
                    clips = _build_clips([segment], ["介绍功能"], project={**initial, "gap_remove": gap})
                    self.assertEqual(clips[0].source_item_indices[:-1], new_deleted)
                    ids = [f"c001:i{index + 1:03d}" for index in range(len(new_deleted))]
                    removed_text = "".join(segment["items"][index]["text"] for index in new_deleted)
                    decision = {wire_key: ids if wire_key == "removeItemIds" else [ids], "evidence": removed_text}
                    output, stats, calls = self.run_case(segment, decision, "介绍功能", extras={"gap_remove": gap})
                    self.assertEqual(main_segments(output)[0], segment)
                    self.assertEqual(stats["removed"], 1)
                    self.assertEqual(calls[0][1][0]["asrText"], removed_text + "介绍功能")
                    scopes = output["gap_remove"]["provenance"]["sources"]["ai_cleanup"]
                    self.assertTrue(all(list(verified_scope_indices(scope, segment)) for scope in scopes))
                    actual_indices = sorted(index for scope in scopes for index in verified_scope_indices(scope, segment))
                    self.assertEqual(actual_indices, sorted(old_deleted + new_deleted))
                    new_scopes = [scope for scope in scopes if scope["cleanup_scope"]["item_start"] in new_deleted]
                    self.assertEqual(len(new_scopes), len(new_deleted))
                    marker_ranges = sorted((marker["start"], marker["end"], marker["name"]) for marker in output["markers"]["items"])
                    self.assertEqual(marker_ranges, sorted((scope["start"], scope["end"], scope["cleanup_scope"]["text"]) for scope in new_scopes))
                    self.assertIn("介绍功能", render_srt(output))
                    self.assertNotIn(removed_text + "介绍功能", render_srt(output))
                    # An additional keep pass sees only retained text and preserves cuts.
                    kept, keep_stats, keep_calls = self.run_case(segment, {"decision": "keep"}, "介绍功能", extras={"gap_remove": output["gap_remove"], "markers": output["markers"]})
                    self.assertEqual(keep_calls[0][1][0]["asrText"], "介绍功能")
                    self.assertEqual(keep_stats["removed"], 0)
                    self.assertEqual(kept["gap_remove"], output["gap_remove"])
                    self.assertIn("介绍功能", render_srt(kept))
                    restored = copy.deepcopy(output)
                    provenance = restored["gap_remove"]["provenance"]
                    provenance["manual_overrides"].extend({"start": segment["items"][index]["start"], "end": segment["items"][index]["end"], "removed": False} for index in old_deleted)
                    restored["gap_remove"]["gaps"] = _gap_ranges_from_provenance(provenance)
                    self.assertIn(restored_text, render_srt(restored))
                    provenance["manual_overrides"].extend({"start": segment["items"][index]["start"], "end": segment["items"][index]["end"], "removed": False} for index in new_deleted)
                    restored["gap_remove"]["gaps"] = _gap_ranges_from_provenance(provenance)
                    self.assertIn(segment["text"], render_srt(restored))

    def test_two_nonadjacent_groups_and_readthrough_restore_all(self):
        decision = {"removeItemRanges": [["c001:i001"], ["c001:i004"]], "evidence": "我嗯"}
        output, _, calls = self.run_case(cue(MULTI), decision, "我这个功能很好呢", review=True)
        self.assertEqual(len(output["gap_remove"]["provenance"]["sources"]["ai_cleanup"]), 2)
        review_rows = next(rows for _prompt, rows in calls if "proposed" in rows[0])
        self.assertEqual(review_rows[0]["retainedText"], "我这个功能很好呢")
        self.assertIn("我这个功能很好呢", render_srt(output))
        restored, stats, _ = self.run_case(cue(MULTI), decision, "我这个功能很好呢", review=True, flags=[{"id": "c001", "reason": "承接不确定"}])
        self.assertNotIn("gap_remove", restored)
        self.assertEqual(stats["pendingReview"], 1)
        self.assertEqual(main_segments(restored)[0]["text"], cue(MULTI)["text"])

    def test_invalid_references_and_one_invalid_group_downgrade_whole_clip(self):
        decisions = [
            {"removeItemIds": ["c002:i001"]}, {"removeItemIds": ["c001:i001", "c001:i003"]},
            {"removeItemIds": ["c001:i002", "c001:i001"]}, {"removeItemIds": ["c001:i001", "c001:i001"]},
            {"removeItemIds": []}, {"removeItemRanges": [["c001:i001"], ["c001:i001"]]},
            {"removeItemRanges": [["c001:i001"], ["bogus"]]},
            {"removeItemRanges": [["c001:i004"], ["c001:i001"]]},
            {"removeItemIds": ["c001:i001"], "removeItemRanges": [["c001:i004"]]},
        ]
        for decision in decisions:
            with self.subTest(decision=decision):
                output, stats, _ = self.run_case(cue(MULTI), {"evidence": "我嗯", **decision}, "我这个功能很好呢")
                self.assertNotIn("gap_remove", output)
                self.assertEqual(stats["pendingReview"], 1)

    def test_unreliable_item_mapping_downgrades(self):
        variants = []
        for field, value in [("start", 220.5), ("start", 100), ("end", 3000), ("end", 220), ("text", "另词")]:
            item = cue(PREFIX)
            item["items"][1][field] = value
            variants.append(item)
        # Float timings are rejected at the project boundary rather than guessed.
        self.assertEqual(build_clips([variants[0]], ["我这个功能呢"]), [])
        for item in variants[1:]:
            with self.subTest(item=item):
                self.assertEqual(_build_clips([item], ["我这个功能呢"]), [])

    def test_numbers_unique_information_and_empty_remainder_are_protected(self):
        cases = [
            ([('3', 0, 200), ('3个功能', 300, 2000)], ["c001:i001"], "3", "3个功能"),
            ([('三', 0, 200), ('三个功能', 300, 2000)], ["c001:i001"], "三", "三个功能"),
            ([('不能', 0, 200), ('不能删除', 300, 2000)], ["c001:i001"], "不能", "不能删除"),
            (PREFIX, ["c001:i002"], "我这……", "我这我这个功能呢"),
            ([('独有步骤', 0, 200), ('正文', 300, 2000)], ["c001:i001"], "独有步骤", "正文"),
            (PREFIX, ["c001:i001", "c001:i002", "c001:i003"], "啊，我这……我这个功能呢", "我这个功能呢"),
        ]
        for rows, ids, evidence, script in cases:
            with self.subTest(rows=rows):
                output, stats, _ = self.run_case(cue(rows), {"removeItemIds": ids, "evidence": evidence}, script)
                self.assertNotIn("gap_remove", output)
                self.assertEqual(stats["pendingReview"], 1)

    def test_manual_restore_other_sources_and_stale_scope(self):
        extras = {"gap_remove": {"provenance": {"sources": {"audio_gate": [{"start": 1800, "end": 1900}], "ai_cleanup_review": [{"start": 0, "end": 400, "review_marker_id": "manual-1"}]}, "manual_overrides": [{"start": 0, "end": 770, "removed": False}]}}}
        output, _, _ = self.run_case(cue(PREFIX), {"removeItemIds": ["c001:i001", "c001:i002"], "evidence": "啊，我这……"}, "我这个功能呢", extras=extras)
        normalized = _normalize_gap_provenance(output["gap_remove"]["provenance"])
        self.assertIn("cleanup_scope", normalized["sources"]["ai_cleanup"][0])
        self.assertEqual(normalized["sources"]["ai_cleanup_review"][0]["review_marker_id"], "manual-1")
        self.assertIn("啊，我这……我这个功能呢", render_srt(output))
        output["gap_remove"]["provenance"]["manual_overrides"] = []
        self.assertNotIn("我这……", render_srt(output))
        output["gap_remove"]["provenance"]["sources"]["ai_cleanup"] = []
        self.assertIn("我这……", render_srt(output))
        stale = copy.deepcopy(output)
        stale["gap_remove"]["provenance"]["sources"]["ai_cleanup"] = [{"start": 0, "end": 770, "cleanup_scope": {"segment_id": "main-001", "item_start": 0, "item_end": 2, "text": "不匹配"}}]
        self.assertIn("我这……", render_srt(stale))
        for invalid_start in (0.2, "0", -0.2, False):
            exact = copy.deepcopy(stale)
            gap = exact["gap_remove"]["provenance"]["sources"]["ai_cleanup"][0]
            gap["start"] = invalid_start
            gap["cleanup_scope"]["text"] = "啊，我这……"
            with self.subTest(invalid_start=invalid_start):
                self.assertTrue(all("cleanup_scope" not in entry for entry in _normalize_gap_provenance(exact["gap_remove"]["provenance"])["sources"]["ai_cleanup"]))
                self.assertIn("我这……", render_srt(exact))

    def test_bound_extension_and_overlay_are_preserved(self):
        extension = {"id": "ext-001", "start": 0, "end": 2000, "text": "translated body"}
        extras = {"multi_subtitle": {"schema": "moy.asr.multi_subtitle.v1", "enabled": True, "tracks": [{"id": "ext", "segments": [extension]}], "bindings": [{"track_id": "ext", "main_segment_ids": ["main-001"], "extension_segment_ids": ["ext-001"], "start_offset_ms": 0, "end_offset_ms": 0}]}, "overlay_track": {"enabled": True, "segments": [{"start": 0, "end": 2000, "text": "overlay untouched"}]}}
        output, _, _ = self.run_case(cue(PREFIX), {"removeItemIds": ["c001:i001", "c001:i002"], "evidence": "啊，我这……"}, "我这个功能呢", extras=extras)
        self.assertEqual(extension_tracks(output)[0]["segments"][0], extension)
        self.assertIn("overlay untouched", render_srt(output))


if __name__ == "__main__":
    unittest.main()
