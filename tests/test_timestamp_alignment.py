import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from maw.timestamp_alignment import (
    ALIGNMENT_MODE_FILL,
    ALIGNMENT_MODE_GENERATE,
    FireRedCtcBackend,
    TimedToken,
    TimestampAlignmentRequest,
    align_project,
    firered_tokens_to_items,
    run_timestamp_alignment,
    _segment_has_complete_items,
    _split_text_for_duration,
    _timed_tokens_from_raw,
)


class TimestampAlignmentTests(unittest.TestCase):
    def test_qwen_object_outputs_are_read_as_timed_tokens(self) -> None:
        raw = [[
            SimpleNamespace(text="你", start_time=0.0, end_time=0.2),
            SimpleNamespace(text="好", start_time=0.2, end_time=0.5),
        ]]

        items = _timed_tokens_from_raw(raw)

        self.assertEqual(
            [(item.text, item.start, item.end) for item in items],
            [("你", 0, 200), ("好", 200, 500)],
        )

    def test_firered_ctc_tokens_map_back_to_known_text(self) -> None:
        items = firered_tokens_to_items(
            "你好 world",
            ["你", "好", " ", "w", "o", "r", "l", "d"],
            [[0.0, 0.2], [0.2, 0.4], [0.4, 0.5], [0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.0]],
            1000,
        )

        self.assertEqual("".join(item.text for item in items), "你好 world")
        self.assertEqual(items[0].start, 0)
        self.assertEqual(items[-1].end, 1000)
        self.assertTrue(all(left.end <= right.start for left, right in zip(items, items[1:])))

    def test_firered_decode_skips_silent_audio_before_sherpa_decode(self) -> None:
        class SilentChannel:
            size = 16000

            def __len__(self) -> int:
                return self.size

            def max(self) -> float:
                return 0.0

            def min(self) -> float:
                return 0.0

        class SilentAudio:
            ndim = 2

            def __len__(self) -> int:
                return 16000

            def __getitem__(self, key: tuple[slice, int]) -> SilentChannel:
                del key
                return SilentChannel()

        fake_soundfile = SimpleNamespace(read=lambda *_args, **_kwargs: (SilentAudio(), 16000))
        backend = FireRedCtcBackend(model_path="D:/models/firered")
        with mock.patch.dict("sys.modules", {"soundfile": fake_soundfile}):
            with mock.patch.object(backend, "_load", side_effect=AssertionError("must not decode silence")):
                result = backend.decode(Path("silent.wav"))

        self.assertEqual(result.text, "")
        self.assertEqual(result.tokens, ())
        self.assertEqual(result.duration_ms, 1000)

    def test_fill_skips_complete_cues_and_generate_replaces_them(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            media = Path(temp_dir) / "clip.wav"
            media.write_bytes(b"placeholder")
            project = {
                "segments": [
                    {"start": 0, "end": 1000, "text": "你好"},
                    {
                        "start": 1000,
                        "end": 2000,
                        "text": "世界",
                        "items": [
                            {"start": 1000, "end": 1500, "text": "世"},
                            {"start": 1500, "end": 2000, "text": "界"},
                        ],
                    },
                ],
                "language": "zh",
            }

            class FakeBackend:
                def align(self, _audio_path: Path, text: str, *, language: str | None = None) -> list[TimedToken]:
                    del language
                    midpoint = 500
                    return [TimedToken(text[0], 0, midpoint), TimedToken(text[1], midpoint, 1000)]

            with mock.patch("maw.timestamp_alignment.create_alignment_backend", return_value=FakeBackend()):
                with mock.patch("maw.timestamp_alignment._extract_audio_span"):
                    fill_report = align_project(
                        project,
                        media_path=media,
                        model_id="qwen3-forced-aligner-0.6b",
                        mode=ALIGNMENT_MODE_FILL,
                    )
                    generate_report = align_project(
                        project,
                        media_path=media,
                        model_id="qwen3-forced-aligner-0.6b",
                        mode=ALIGNMENT_MODE_GENERATE,
                    )

            self.assertEqual(fill_report.skipped_segments, 1)
            self.assertEqual(fill_report.aligned_segments, 1)
            self.assertEqual(generate_report.skipped_segments, 0)
            self.assertEqual(generate_report.aligned_segments, 2)
            self.assertEqual(
                [(item["text"], item["start"], item["end"]) for item in project["segments"][1]["items"]],
                [("世", 1000, 1500), ("界", 1500, 2000)],
            )

    def test_srt_toolbox_writes_new_project_and_srt_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            srt = root / "clip.srt"
            media = root / "clip.wav"
            media.write_bytes(b"placeholder")
            srt.write_text(
                "1\n00:00:00,000 --> 00:00:01,000\n你好\n",
                encoding="utf-8-sig",
            )

            class FakeBackend:
                def align(self, _audio_path: Path, text: str, *, language: str | None = None) -> list[TimedToken]:
                    del language
                    return [TimedToken(text[0], 0, 500), TimedToken(text[1], 500, 1000)]

            with mock.patch("maw.timestamp_alignment.create_alignment_backend", return_value=FakeBackend()):
                with mock.patch("maw.timestamp_alignment._extract_audio_span"):
                    artifact, report = run_timestamp_alignment(
                        TimestampAlignmentRequest(
                            project_path=None,
                            srt_path=srt,
                            media_path=media,
                            model_id="qwen3-forced-aligner-0.6b",
                        )
                    )

            self.assertEqual(report.aligned_segments, 1)
            self.assertIsNotNone(artifact.project_path)
            self.assertIsNotNone(artifact.srt_path)
            project = json.loads(Path(artifact.project_path).read_text(encoding="utf-8"))
            self.assertEqual([item["text"] for item in project["segments"][0]["items"]], ["你", "好"])
            self.assertIn("00:00:00,000 --> 00:00:01,000", Path(artifact.srt_path).read_text(encoding="utf-8-sig"))

    def test_fill_does_not_treat_invalid_items_as_complete(self) -> None:
        self.assertFalse(
            _segment_has_complete_items(
                {
                    "text": "你好",
                    "items": [
                        {"text": "你", "start": 0, "end": 500},
                        "not-an-item",
                    ],
                }
            )
        )

    def test_partial_alignment_keeps_segment_granularity(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            media = Path(temp_dir) / "clip.wav"
            media.write_bytes(b"placeholder")
            project = {
                "segments": [
                    {"start": 0, "end": 1000, "text": "你好"},
                    {"start": 1000, "end": 2000, "text": "世界"},
                ],
                "language": "zh",
            }

            class PartiallyFailingBackend:
                def align(self, _audio_path: Path, text: str, *, language: str | None = None) -> list[TimedToken]:
                    del language
                    if text == "世界":
                        raise RuntimeError("synthetic alignment failure")
                    return [TimedToken(text[0], 0, 500), TimedToken(text[1], 500, 1000)]

            with mock.patch("maw.timestamp_alignment.create_alignment_backend", return_value=PartiallyFailingBackend()):
                with mock.patch("maw.timestamp_alignment._extract_audio_span"):
                    report = align_project(
                        project,
                        media_path=media,
                        model_id="qwen3-forced-aligner-0.6b",
                    )

        self.assertEqual(report.aligned_segments, 1)
        self.assertEqual(report.failed_segments, 1)
        self.assertEqual(project["timestamp_granularity"], "segment")

    def test_long_single_unit_keeps_the_whole_audio_span(self) -> None:
        chunks = _split_text_for_duration("hello", 150_000)

        self.assertEqual(chunks, [("hello", 150_000)])


if __name__ == "__main__":
    unittest.main()
