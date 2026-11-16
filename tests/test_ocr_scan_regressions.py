"""Synthetic pixel, continuity, retry, coverage and bounded-disk regressions.

No real media, inference models or ffmpeg processes are used.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools" / "term-extract"))

from maw import ocr_scan  # noqa: E402
from maw.postprocess_ocr import OCR_TARGET_WIDTH, _prepare_image  # noqa: E402
from term_extract.aggregate import extract_candidates  # noqa: E402
from term_extract.score import score_candidate  # noqa: E402


def synthetic_frame(label: str = "item A", background: int = 0) -> Image.Image:
    image = Image.new("RGB", (OCR_TARGET_WIDTH, 720), (background, background, background))
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, OCR_TARGET_WIDTH, 359), fill="white")
    draw.text((20, 680), label, fill="white")
    return image


class ScanRegressions(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.received: list[tuple[int, str | None, list]] = []
        self.extracted_paths: list[Path] = []
        self.temporary_counts: list[int] = []
        self.recognize_calls = 0

    def scan(self, *, count=6, image_at=None, recognize=None, failed_indices=(),
             frames_dir=None, max_frames=20_000, observer=None, duration_ms=None, fps=1.0):
        def extract(_ffmpeg, _video, timestamp, output):
            index = round(timestamp * fps)
            self.extracted_paths.append(output)
            image = image_at(index) if image_at else synthetic_frame()
            try:
                image.save(output, format="PNG")
            finally:
                image.close()
            self.temporary_counts.append(len(list(output.parent.glob("*.jpg"))))
            return index not in failed_indices

        def recognize_frame(image):
            self.recognize_calls += 1
            return recognize(image) if recognize else [("星核", 0.6, (1, 2, 30, 40))]

        def collect(t_ms, frame, hits):
            self.received.append((t_ms, frame, hits))
            if observer:
                observer(t_ms, frame, hits)

        return ocr_scan.run_ocr_scan(
            ocr_scan.OcrScanRequest(self.root / "synthetic.mp4", self.root / "ffmpeg",
                                   duration_ms if duration_ms is not None else round(count * 1000 / fps),
                                   fps=fps, frames_dir=frames_dir, max_frames=max_frames),
            frame_extractor=extract, recognizer=recognize_frame, on_blocks=collect,
        )

    def test_real_pil_ahash_collision_still_recognizes_changed_text(self) -> None:
        with synthetic_frame("item A") as left, synthetic_frame("item B") as right:
            self.assertEqual(ocr_scan.average_hash(_prepare_image(left)),
                             ocr_scan.average_hash(_prepare_image(right)))
            self.assertNotEqual(left.tobytes(), right.tobytes())
        summary = self.scan(count=2, image_at=lambda i: synthetic_frame(f"item {'AB'[i]}"))
        self.assertEqual(summary["framesScanned"], 2)
        self.assertEqual(summary["framesSkippedDuplicate"], 0)

    def test_exact_fingerprint_includes_dimensions_and_mode(self) -> None:
        with Image.new("RGB", (2, 3)) as first, Image.new("RGB", (3, 2)) as dimensions, \
                Image.new("YCbCr", (2, 3)) as mode:
            self.assertEqual(first.tobytes(), dimensions.tobytes())
            self.assertEqual(first.tobytes(), mode.tobytes())
            self.assertNotEqual(ocr_scan._pixel_fingerprint(first), ocr_scan._pixel_fingerprint(dimensions))
            self.assertNotEqual(ocr_scan._pixel_fingerprint(first), ocr_scan._pixel_fingerprint(mode))

    def test_static_reuse_preserves_120_second_display_continuity(self) -> None:
        def background_changes(index):
            image = synthetic_frame()
            # Large spatial changes deliberately produce distinct aHashes:
            # this regression isolates duplicate callback continuity from
            # the separate small-text hash-collision regression above.
            x = 10 + (index // 10) * 75
            ImageDraw.Draw(image).rectangle((x, 400, x + 65, 620), fill="white")
            return image

        digests = set()
        for index in range(0, 120, 10):
            with background_changes(index) as image:
                digests.add(ocr_scan.average_hash(image))
        self.assertEqual(len(digests), 12)
        summary = self.scan(count=120, image_at=background_changes)
        blocks = [{"tMs": t, "frame": frame, "text": text, "score": score, "box": list(box)}
                  for t, frame, hits in self.received for text, score, box in hits]
        candidate = extract_candidates(blocks, 1.0)[0]
        self.assertEqual(summary["framesScanned"], 12)
        self.assertEqual(summary["framesSkippedDuplicate"], 108)
        self.assertEqual(candidate["eventCount"], 1)
        self.assertEqual(summary["blocksTotal"], 120)
        self.assertEqual(candidate["hitCount"], 120)
        self.assertEqual(candidate["events"][0]["endMs"], 119_000)
        reason_keys = {reason["key"] for reason in score_candidate(candidate)["reasons"]}
        self.assertFalse({"event_count", "hit_count"} & reason_keys)

    def test_only_one_extraction_jpeg_exists_during_scan(self) -> None:
        self.scan(count=32, image_at=lambda i: synthetic_frame(background=i))
        self.assertEqual(max(self.temporary_counts), 1)
        self.assertEqual(len(set(self.extracted_paths)), 1)
        self.assertFalse(self.extracted_paths[0].parent.exists())

    def test_duplicate_reuses_evidence_and_does_not_mutate_cache(self) -> None:
        frames = self.root / "evidence"

        def observer(_t_ms, _frame, hits):
            hits.clear()

        summary = self.scan(frames_dir=frames, observer=observer)
        self.assertEqual(summary["framesScanned"], 1)
        self.assertEqual(summary["blocksTotal"], 6)
        self.assertEqual(summary["blocksRecognized"], 1)
        self.assertEqual(len(self.received), 6)
        self.assertEqual({item[1] for item in self.received}, {"frame-000000000000.jpg"})
        self.assertEqual(len(list(frames.glob("*.jpg"))), 1)

    def test_successful_empty_result_is_reused_and_emitted(self) -> None:
        frames = self.root / "evidence"
        summary = self.scan(count=4, recognize=lambda _image: [], frames_dir=frames)
        self.assertEqual(summary["framesScanned"], 1)
        self.assertEqual(summary["framesSkippedDuplicate"], 3)
        self.assertEqual(summary["blocksTotal"], 0)
        self.assertEqual([item[0] for item in self.received], [0, 1000, 2000, 3000])
        self.assertEqual(list(frames.iterdir()), [])

    def test_failed_ocr_does_not_seed_duplicate_cache(self) -> None:
        def recognize(_image):
            if self.recognize_calls == 1:
                raise RuntimeError("synthetic OCR failure")
            return [("星核", 0.9, (1, 2, 30, 40))]

        summary = self.scan(count=3, recognize=recognize)
        self.assertEqual(summary["framesFailed"], 1)
        self.assertEqual(summary["framesScanned"], 1)
        self.assertEqual(summary["framesSkippedDuplicate"], 1)
        self.assertEqual([item[0] for item in self.received], [1000, 2000])

    def test_failed_extraction_invalidates_previous_success(self) -> None:
        summary = self.scan(count=3, failed_indices={1})
        self.assertEqual(summary["framesFailed"], 1)
        self.assertEqual(summary["framesScanned"], 2)
        self.assertEqual(summary["framesSkippedDuplicate"], 0)

    def test_failed_ocr_invalidates_previous_success(self) -> None:
        def recognize(_image):
            if self.recognize_calls == 2:
                raise RuntimeError("synthetic OCR failure")
            return [("星核", 0.9, (1, 2, 30, 40))]

        summary = self.scan(count=3, image_at=lambda i: synthetic_frame(background=1 if i == 1 else 0),
                            recognize=recognize)
        self.assertEqual(summary["framesFailed"], 1)
        self.assertEqual(summary["framesScanned"], 2)
        self.assertEqual(summary["framesSkippedDuplicate"], 0)

    def test_all_extractions_failed_raises_instead_of_success(self) -> None:
        with self.assertRaises(ValueError):
            self.scan(count=3, failed_indices={0, 1, 2})

    def test_all_ocr_calls_failed_raises_instead_of_success(self) -> None:
        def fail(_image):
            raise RuntimeError("synthetic OCR failure")

        with self.assertRaises(ValueError):
            self.scan(count=3, recognize=fail)
        self.assertEqual(self.recognize_calls, 3)

    def test_truncated_plan_and_last_attempt_are_reported(self) -> None:
        summary = self.scan(count=120, max_frames=5, failed_indices={4})
        self.assertEqual(summary["framesTotal"], 5)
        self.assertEqual(summary["framesPlanned"], 120)
        self.assertTrue(summary["truncated"])
        self.assertEqual(summary["sampledThroughMs"], 4000)
        self.assertEqual(summary["durationMs"], 120_000)
        self.assertEqual(summary["fps"], 1.0)
        self.assertEqual(summary["framesScanned"] + summary["framesSkippedDuplicate"] +
                         summary["framesFailed"], summary["framesTotal"])

    def test_untruncated_plan_respects_rounded_endpoint(self) -> None:
        summary = self.scan(duration_ms=10_000, fps=0.7)
        self.assertEqual(summary["framesPlanned"], len(ocr_scan.sampling_timestamps(10_000, 0.7)))
        self.assertFalse(summary["truncated"])

    def test_planned_count_matches_sampling_rounding_boundaries(self) -> None:
        for fps in (0.2, 0.3, 0.7, 1.0, 1.1, 2.0):
            for duration in (1, 499, 500, 501, 1428, 1429, 1430, 9999, 10_000, 10_001):
                with self.subTest(fps=fps, duration=duration):
                    self.assertEqual(ocr_scan._planned_frame_count(duration, fps),
                                     len(ocr_scan.sampling_timestamps(duration, fps)))

    def test_observer_interrupt_removes_task_temporary_frame(self) -> None:
        def interrupt(*_args):
            raise KeyboardInterrupt()

        with self.assertRaises(KeyboardInterrupt):
            self.scan(observer=interrupt)
        self.assertFalse(self.extracted_paths[0].parent.exists())


if __name__ == "__main__":
    unittest.main()
