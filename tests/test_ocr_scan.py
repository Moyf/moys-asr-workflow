"""maw.ocr_scan：采样计划、平均哈希去重与整段扫描流程（全部注入假件）。"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from maw.ocr_scan import (  # noqa: E402
    OcrScanRequest,
    average_hash,
    clamp_fps,
    run_ocr_scan,
    sampling_timestamps,
)
from maw.postprocess_ocr import OcrRegion  # noqa: E402


class SamplingTests(unittest.TestCase):
    def test_one_fps_sampling_per_second(self) -> None:
        self.assertEqual(sampling_timestamps(10_000, 1.0), [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000])

    def test_half_fps_sampling_every_two_seconds(self) -> None:
        self.assertEqual(sampling_timestamps(5_000, 0.5), [0, 2000, 4000])

    def test_max_frames_caps_the_plan(self) -> None:
        timestamps = sampling_timestamps(1_000_000, 1.0, max_frames=5)
        self.assertEqual(len(timestamps), 5)

    def test_zero_duration_returns_empty(self) -> None:
        self.assertEqual(sampling_timestamps(0, 1.0), [])

    def test_fps_bounds_are_enforced(self) -> None:
        self.assertEqual(clamp_fps(1.0), 1.0)
        self.assertEqual(clamp_fps(0.2), 0.2)
        with self.assertRaises(ValueError):
            clamp_fps(0.1)
        with self.assertRaises(ValueError):
            clamp_fps(2.5)


class AverageHashTests(unittest.TestCase):
    def test_uniform_images_hash_equal(self) -> None:
        self.assertEqual(average_hash(_FakeImage(0)), average_hash(_FakeImage(0)))

    def test_different_images_hash_differently(self) -> None:
        self.assertNotEqual(average_hash(_FakeImage(1)), average_hash(_FakeImage(2)))


class RunOcrScanTests(unittest.TestCase):
    def setUp(self) -> None:
        import tempfile

        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.video = self.root / "clip.mp4"
        self.video.write_bytes(b"video")
        self.ffmpeg = self.root / "ffmpeg.exe"
        self.ffmpeg.write_bytes(b"ffmpeg")
        self.frames: list[_FakeImage] = []

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _request(self, **overrides: object) -> OcrScanRequest:
        kwargs: dict[str, object] = {
            "video_path": self.video,
            "ffmpeg_path": self.ffmpeg,
            "duration_ms": 6_000,
            "fps": 1.0,
            "region": OcrRegion(),
            "model_type": "tiny",
            "frames_dir": None,
        }
        kwargs.update(overrides)
        return OcrScanRequest(**kwargs)  # type: ignore[arg-type]

    def _fakes(self, tags: list[int], texts_by_tag: dict[int, list[str]]) -> dict[str, object]:
        def extract(_ffmpeg: Path, _video: Path, timestamp: float, output: Path) -> bool:
            output.write_bytes(b"frame")
            index = int(timestamp)
            if index >= len(tags):
                return False
            self.frames.append(_FakeImage(tags[index]))
            return True

        def load_image(_path: Path) -> _FakeImage:
            return self.frames.pop(0)

        def recognize(image: _FakeImage) -> list[tuple[str, float, tuple[int, int, int, int]]]:
            return [
                (text, 0.9, (1, 2, 3, 4))
                for text in texts_by_tag.get(image.tag, [])
            ]

        return {"frame_extractor": extract, "image_loader": load_image, "recognizer": recognize}

    def test_scan_emits_blocks_and_summary(self) -> None:
        received: list[tuple[int, str | None, list[tuple[str, float, tuple[int, int, int, int]]]]] = []

        def collect(t_ms: int, frame: str | None, hits: list[tuple[str, float, tuple[int, int, int, int]]]) -> None:
            received.append((t_ms, frame, hits))

        summary = run_ocr_scan(
            self._request(),
            on_blocks=collect,
            **self._fakes(tags=[1, 2, 3, 4, 5, 6], texts_by_tag={1: ["前往星核"], 3: ["获得 LJ-84"]}),  # type: ignore[arg-type]
        )
        self.assertEqual(summary["framesTotal"], 6)
        self.assertEqual(summary["framesScanned"], 6)
        self.assertEqual(summary["blocksTotal"], 2)
        self.assertEqual(len(received), 2)
        self.assertEqual(received[0][0], 0)
        self.assertEqual(received[0][2][0][0], "前往星核")

    def test_scan_skips_duplicate_static_frames(self) -> None:
        received: list[tuple[int, str | None, list[tuple[str, float, tuple[int, int, int, int]]]]] = []

        def collect(t_ms: int, frame: str | None, hits: list[tuple[str, float, tuple[int, int, int, int]]]) -> None:
            received.append((t_ms, frame, hits))

        summary = run_ocr_scan(
            self._request(),
            on_blocks=collect,
            **self._fakes(tags=[1, 1, 1, 2], texts_by_tag={1: ["任务栏"], 2: ["任务栏"]}),  # type: ignore[arg-type]
        )
        self.assertEqual(summary["framesSkippedDuplicate"], 2)
        self.assertEqual(summary["framesScanned"], 2)
        self.assertEqual(summary["blocksTotal"], 2)

    def test_scan_counts_failed_extractions(self) -> None:
        summary = run_ocr_scan(
            self._request(duration_ms=3_000),
            **self._fakes(tags=[1], texts_by_tag={}),  # type: ignore[arg-type]
        )
        self.assertEqual(summary["framesFailed"], 2)
        self.assertEqual(summary["framesTotal"], 3)


class _FakeImage:
    """最小图像假件：支持 crop/convert/resize/tobytes/save 与宽高。"""

    width = 100
    height = 50

    def __init__(self, tag: int) -> None:
        self.tag = tag

    def crop(self, _box: object) -> "_FakeImage":
        return self

    def convert(self, _mode: str) -> "_FakeImage":
        return self

    def resize(self, _size: object) -> "_FakeImage":
        return self

    def tobytes(self) -> bytes:
        return bytes((index * (self.tag + 1)) % 256 for index in range(256))

    def save(self, path: Path, quality: int | None = None) -> None:
        Path(path).write_bytes(b"jpg")

    def __enter__(self) -> "_FakeImage":
        return self

    def __exit__(self, *_exc: object) -> bool:
        return False


if __name__ == "__main__":
    _ = unittest.main()
