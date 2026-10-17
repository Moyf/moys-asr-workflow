from __future__ import annotations

import tempfile
import unittest
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from maw.media_export_video import prepare_video_copy, removed_gap_diagnostics

TEMP_ROOT = Path(__file__).resolve().parents[1] / ".artifacts" / "video-gap-diagnostics"


class FakeInspector:
    accepted = True
    exhaust_on_first = False
    instances = []

    def __init__(self, *_args, **_kwargs):
        self.stats = {"points": 0, "bytes_read": 0, "cache_hits": 0, "elapsed_ms": 0, "exhausted": False}
        self.instances.append(self)

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        pass

    def classify(self, **_kwargs):
        self.stats["points"] += 1
        if self.exhaust_on_first:
            self.stats["exhausted"] = True
            return SimpleNamespace(safe=None, reason="budget_exhausted")
        return SimpleNamespace(safe=self.accepted, reason="idr" if self.accepted else "h264_recovery")


class GapDiagnosticTests(unittest.TestCase):
    def plan(self, intervals, *, accepted=True, exhaust=False):
        TEMP_ROOT.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as temporary:
            directory = Path(temporary)
            def scan(_source, destination, *_args):
                destination.write_text("\n".join(
                    f"stream_index=0|pts_time={time}|dts_time={time}|duration_time=1|pos={time * 100}|size=20|flags={'K' if time % 4 == 0 else '_'}"
                    for time in range(12)))
            with mock.patch.object(FakeInspector, "accepted", accepted), \
                    mock.patch.object(FakeInspector, "exhaust_on_first", exhaust), \
                    mock.patch("maw.media_export_video.scan_packets", side_effect=scan):
                return prepare_video_copy(directory / "source.mp4", intervals, ["video"], Decimal(0), directory,
                                          None, None, inspector_factory=FakeInspector)

    def test_leading_internal_and_trailing_requested_deletions_are_measured_separately(self):
        requested = [(Decimal(2), Decimal(4)), (Decimal(6), Decimal(8))]
        actual = [(Decimal(1), Decimal(5)), (Decimal(6), Decimal(9))]
        result = removed_gap_diagnostics(requested, actual, Decimal(0), Decimal(10),
                                         [({"h264_recovery"}, set()), (set(), {"budget_exhausted"})])
        self.assertEqual((result["requestedRemovedMs"], result["actualRemovedMs"], result["retainedGapMs"]),
                         (6000, 3000, 3000))
        self.assertEqual((result["unremovedGapCount"], result["internalUnremovedGapCount"]), (3, 1))
        self.assertEqual([gap["position"] for gap in result["gaps"]], ["leading", "internal", "trailing"])
        self.assertEqual(result["gaps"][0]["reasons"], ["h264_recovery"])
        self.assertEqual(result["gaps"][1]["reasons"], ["keyframe_alignment"])

    def test_idr_proof_is_required_even_when_timestamp_groups_look_closed(self):
        result = self.plan([(1000, 2000), (8500, 9500)], accepted=False).timeline
        self.assertEqual(result["actualRemovedMs"], 0)
        self.assertGreater(result["retainedGapMs"], 0)
        self.assertIn("h264_recovery", result["diagnosis"]["reasonCounts"])
        self.assertTrue(any("h264_recovery" in row["reasons"] for row in result["gaps"]))
        self.assertEqual(result["gaps"][0]["reasons"], ["keyframe_alignment"])

    def test_only_candidate_edges_are_inspected_and_repeated_searches_use_cache(self):
        result = self.plan([(100, 200), (300, 400)]).timeline
        self.assertEqual(result["diagnosis"]["candidateChecks"], 1)
        self.assertEqual(result["diagnosis"]["points"], 1)
        self.assertEqual(result["actualRemovedMs"], 8000)

    def test_exhausted_diagnosis_is_unknown_and_does_not_keep_inspecting_all_keys(self):
        result = self.plan([(1000, 2000), (8500, 9500)], exhaust=True).timeline
        self.assertEqual(result["actualRemovedMs"], 0)
        self.assertEqual(result["diagnosis"]["candidateChecks"], 1)
        self.assertEqual(result["diagnosis"]["points"], 1)
        self.assertIn("budget_exhausted", result["diagnosis"]["reasonCounts"])

    def test_internal_gaps_retained_but_requested_trims_removed_is_not_no_output(self):
        result = removed_gap_diagnostics([(Decimal(1), Decimal(4)), (Decimal(6), Decimal(9))],
                                         [(Decimal(1), Decimal(9))], Decimal(0), Decimal(10),
                                         [(set(), set()), (set(), set())])
        self.assertEqual(result["actualRemovedMs"], 2000)
        self.assertEqual(result["retainedGapMs"], 2000)
        self.assertEqual(result["internalUnremovedGapCount"], 1)
