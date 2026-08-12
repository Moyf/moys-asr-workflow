from __future__ import annotations

import csv
import json
import tempfile
import unittest
from pathlib import Path

from maw.postprocess import OutputMode
from maw.postprocess_ocr import OcrDedupRequest, OcrRegion, match, run_ocr_dedup
from maw.postprocess_io import read_project


class FakeImage:
    def __init__(self, width: int = 1920, height: int = 1080) -> None:
        self.width = width
        self.height = height
        self.resize_calls: list[tuple[int, int]] = []

    def __enter__(self) -> "FakeImage":
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def convert(self, _mode: str) -> "FakeImage":
        return self

    def crop(self, box: tuple[int, int, int, int]) -> "FakeImage":
        return FakeImage(box[2] - box[0], box[3] - box[1])

    def resize(self, size: tuple[int, int]) -> "FakeImage":
        self.resize_calls.append(size)
        return FakeImage(*size)


class OcrPostprocessTests(unittest.TestCase):
    def test_match_uses_the_highest_reference_similarity(self) -> None:
        result = match("你好，世界", "你好世界 NPC")

        self.assertEqual(result.containment, 1.0)
        self.assertGreaterEqual(result.maximum, result.jaccard)
        self.assertGreaterEqual(result.maximum, result.levenshtein)

    def test_ocr_dedup_preserves_disabled_union_and_writes_srt_report(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            video = root / "clip.mp4"
            ffmpeg = root / "ffmpeg.exe"
            project_path = root / "clip.mosp"
            _ = video.write_bytes(b"video")
            _ = ffmpeg.write_bytes(b"ffmpeg")
            _ = project_path.write_text(
                json.dumps(
                    {
                        "media": str(video),
                        "segments": [
                            {"start": 0, "end": 1000, "text": "画面台词"},
                            {"start": 1100, "end": 2100, "text": "独有字幕"},
                            {"start": 2200, "end": 3200, "text": "人工禁用", "disabled": True},
                        ],
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            recognitions = iter(([("画面台词", 0.99)], [("其他文字", 0.99)]))

            def recognize(_image: object) -> list[tuple[str, float]]:
                return next(recognitions)

            result = run_ocr_dedup(
                OcrDedupRequest(
                    project_path=project_path,
                    srt_path=None,
                    video_path=None,
                    output_mode=OutputMode.BOTH,
                    report=True,
                    phash_threshold=-1,
                ),
                ffmpeg_path=ffmpeg,
                recognizer=recognize,
                frame_extractor=lambda _ffmpeg, _video, _timestamp, _output: True,
                image_loader=lambda _path: FakeImage(),
            )

            if result.project_path is None or result.srt_path is None or result.report_path is None:
                self.fail("OCR deduplication should create both subtitle artifacts and a report")
            processed = read_project(result.project_path)
            segments = processed["segments"]
            self.assertIsInstance(segments, list)
            self.assertTrue(segments[0]["disabled"])
            self.assertNotIn("disabled", segments[1])
            self.assertTrue(segments[2]["disabled"])
            srt = result.srt_path.read_text(encoding="utf-8")
            self.assertIn("1\n00:00:01,100 --> 00:00:02,100\n独有字幕", srt)
            self.assertNotIn("画面台词", srt)
            self.assertNotIn("人工禁用", srt)
            self.assertTrue(result.report_path.read_bytes().startswith(b"\xef\xbb\xbf"))
            with result.report_path.open(encoding="utf-8", newline="") as handle:
                rows = list(csv.DictReader(handle))
            self.assertEqual([row["status"] for row in rows], ["disabled", "kept", "existing_disabled"])
            self.assertEqual(result.newly_disabled_count, 1)
            self.assertEqual(result.existing_disabled_count, 1)
            self.assertEqual(result.processed_count, 2)
            self.assertEqual(result.skipped_count, 1)

    def test_srt_input_requires_explicit_video_when_no_project_media_exists(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            srt_path = root / "captions.srt"
            ffmpeg = root / "ffmpeg.exe"
            _ = srt_path.write_text("1\n00:00:00,000 --> 00:00:01,000\n字幕\n", encoding="utf-8")
            _ = ffmpeg.write_bytes(b"ffmpeg")

            with self.assertRaisesRegex(ValueError, "需要一个视频画面"):
                _ = run_ocr_dedup(
                    OcrDedupRequest(
                        project_path=None,
                        srt_path=srt_path,
                        video_path=None,
                        output_mode=OutputMode.SRT,
                        phash_threshold=-1,
                    ),
                    ffmpeg_path=ffmpeg,
                    recognizer=lambda _image: [],
                    frame_extractor=lambda _ffmpeg, _video, _timestamp, _output: True,
                    image_loader=lambda _path: FakeImage(),
                )

    def test_regions_keep_aspect_ratio_for_full_frame_and_bottom_thirty_percent(self) -> None:
        full = OcrRegion("full").crop(FakeImage())
        bottom = OcrRegion("bottom30").crop(FakeImage())

        self.assertEqual((full.width, full.height), (1920, 1080))
        self.assertEqual((bottom.width, bottom.height), (1920, 324))
