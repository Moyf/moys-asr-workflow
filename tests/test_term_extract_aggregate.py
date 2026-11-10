"""term_extract.aggregate：事件聚合、变体分组与模板抽取。"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools" / "term-extract"))

from term_extract.aggregate import (  # noqa: E402
    aggregate_events,
    extract_candidates,
    group_variants,
)


def block(text: str, t_ms: int, score: float = 0.9, box: tuple[int, int, int, int] = (10, 10, 100, 30), frame: str | None = None) -> dict[str, object]:
    return {"text": text, "score": score, "box": list(box), "tMs": t_ms, "frame": frame}


class EventTests(unittest.TestCase):
    def test_contiguous_hits_collapse_into_one_event(self) -> None:
        events = aggregate_events(
            [block("前往星核", 10_000), block("前往星核", 11_000), block("前往星核", 12_000)],
            fps=1.0,
        )
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["hits"], 3)
        self.assertEqual(events[0]["startMs"], 10_000)
        self.assertEqual(events[0]["endMs"], 12_000)

    def test_far_apart_hits_are_separate_events(self) -> None:
        events = aggregate_events(
            [block("真希", 10_000), block("真希", 600_000)],
            fps=1.0,
        )
        self.assertEqual(len(events), 2)
        self.assertEqual(events[0]["hits"], 1)

    def test_moved_position_stays_one_event(self) -> None:
        # 位置框变化不拆分事件：弹幕滚动/画面轻微变化仍是同一连续显示时段。
        events = aggregate_events(
            [block("任务栏", 10_000, box=(0, 0, 100, 20)), block("任务栏", 11_000, box=(500, 500, 620, 530))],
            fps=1.0,
        )
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["hits"], 2)

    def test_scrolling_danmaku_is_one_event(self) -> None:
        # 弹幕横向滚动：每帧位置都不同，时间连续即同一事件，不虚增独立事件数。
        blocks = [
            block("好可爱", t, box=(1_600 - t // 20, 40, 1_700 - t // 20, 80))
            for t in range(10_000, 14_000, 1_000)
        ]
        events = aggregate_events(blocks, fps=1.0)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["hits"], 4)

    def test_short_keys_are_dropped(self) -> None:
        events = aggregate_events([block("是", 1_000), block("B", 2_000)], fps=1.0)
        self.assertEqual(events, [])


class VariantTests(unittest.TestCase):
    def test_near_writings_grouped_with_all_variants_kept(self) -> None:
        blocks = [block("星核", t) for t in range(0, 9_000, 1_000)] + [block("星孩", 20_000), block("星孩", 21_000)]
        events = aggregate_events(blocks, fps=1.0)
        groups = group_variants(events)
        self.assertEqual(len(groups), 1)
        canonical = groups[0]["canonical"]
        variants = groups[0]["members"]
        self.assertEqual(canonical["text"], "星核")
        self.assertEqual(len(variants), 2)

    def test_distinct_models_not_merged(self) -> None:
        events = aggregate_events(
            [block("LJ-84", 1_000), block("LJ-85", 2_000), block("LJ-84", 3_000)],
            fps=1.0,
        )
        groups = group_variants(events)
        self.assertEqual(len(groups), 2)


class CandidateTests(unittest.TestCase):
    def test_template_extraction_attaches_type_and_context(self) -> None:
        blocks = [
            block("前往星核", 10_000),
            block("与真希交谈", 20_000),
            block("获得 LJ-84", 30_000),
            block('解锁技能「热情似火」', 40_000),
            block("想要保存更改吗", 50_000),
        ]
        candidates = {c["word"]: c for c in extract_candidates(blocks, fps=1.0)}
        self.assertIn("星核", candidates)
        self.assertEqual(candidates["星核"]["typeGuess"], "地点")
        self.assertIn("真希", candidates)
        self.assertEqual(candidates["真希"]["typeGuess"], "人物")
        self.assertIn("LJ-84", candidates)
        self.assertEqual(candidates["LJ-84"]["typeGuess"], "型号")
        self.assertIn("热情似火", candidates)
        self.assertEqual(candidates["热情似火"]["typeGuess"], "技能")
        # 完整对白句也会成为候选（供人工/AI 排除），但保留上下文供筛选。
        self.assertTrue(candidates["想要保存更改吗"]["contexts"])

    def test_candidate_keeps_event_evidence(self) -> None:
        blocks = [
            block("星核", 10_000, frame="frame-a.jpg"),
            block("星核", 11_000, frame="frame-a.jpg"),
            block("星核", 300_000, frame="frame-b.jpg"),
        ]
        candidates = {c["word"]: c for c in extract_candidates(blocks, fps=1.0)}
        candidate = candidates["星核"]
        self.assertEqual(candidate["eventCount"], 2)
        self.assertEqual(candidate["hitCount"], 3)
        frames = {frame for event in candidate["events"] for frame in event["frames"]}
        self.assertEqual(frames, {"frame-a.jpg", "frame-b.jpg"})
        # 证据条目按 (帧, 文字框) 成对保留，确认页据此画框；同帧多次命中各留一条。
        self.assertEqual(
            candidate["events"][0]["evidence"],
            [
                {"frame": "frame-a.jpg", "box": [10, 10, 100, 30]},
                {"frame": "frame-a.jpg", "box": [10, 10, 100, 30]},
            ],
        )
        self.assertEqual(
            candidate["events"][1]["evidence"],
            [{"frame": "frame-b.jpg", "box": [10, 10, 100, 30]}],
        )

    def test_template_only_candidate_keeps_source_evidence(self) -> None:
        blocks = [block("前往虚空回廊", 5_000, frame="frame-c.jpg")]
        candidates = {c["word"]: c for c in extract_candidates(blocks, fps=1.0)}
        candidate = candidates["虚空回廊"]
        self.assertEqual(candidate["events"][0]["evidence"], [{"frame": "frame-c.jpg", "box": [10, 10, 100, 30]}])

    def test_template_dedup_same_block_matched_by_multiple_templates(self) -> None:
        # 「解锁技能「热情似火」」同时命中 unlock-skill 与 quoted 两个模板，
        # 同一来源块只算一次出现，不虚增伪事件数。
        blocks = [
            block("解锁技能「热情似火」", 18_000, frame="frame-d.jpg"),
            block("解锁技能「热情似火」", 19_000, frame="frame-e.jpg"),
        ]
        candidates = {c["word"]: c for c in extract_candidates(blocks, fps=1.0)}
        candidate = candidates["热情似火"]
        self.assertEqual(candidate["eventCount"], 1)
        self.assertEqual(candidate["hitCount"], 2)


if __name__ == "__main__":
    _ = unittest.main()
