from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from generate_subtitle_local import build_parser, default_output_path
from maw.local_asr import (
    FUNASR_DEFAULT_MODEL,
    QWEN_DEFAULT_MODEL,
    FunAsrEngine,
    LocalTranscription,
    QwenAsrEngine,
    build_local_segments,
    create_local_engine,
    funasr_output_to_transcription,
    items_from_timestamps,
    resolve_device,
    write_local_outputs,
)


class LocalAsrNormalizationTests(unittest.TestCase):
    def test_fun_asr_character_timestamps_preserve_text(self) -> None:
        result = funasr_output_to_transcription(
            [{
                "text": "你好。",
                "lang": "zh",
                "sentence_info": [{
                    "text": "你好。",
                    "start": 100,
                    "end": 500,
                    "timestamp": [[100, 220], [220, 400], [400, 500]],
                }],
            }],
            "paraformer-zh",
        )

        self.assertEqual(result.language, "zh")
        self.assertEqual("".join(item["text"] for item in result.items), "你好。")
        self.assertEqual(result.segments[0]["start"], 100)
        self.assertEqual(result.segments[0]["end"], 500)

    def test_fun_asr_unknown_timestamp_granularity_keeps_sentence_item(self) -> None:
        result = funasr_output_to_transcription(
            [{
                "text": "hello world",
                "sentence_info": [{
                    "text": "hello world",
                    "start": 0,
                    "end": 1000,
                    "timestamp": [[0, 500], [500, 1000], [1000, 1100]],
                }],
            }],
            "paraformer-zh",
        )

        self.assertEqual(result.segments[0]["items"][0]["text"], "hello world")
        self.assertEqual(result.segments[0]["items"][0]["start"], 0)

    def test_items_from_timestamps_supports_word_units_with_spaces(self) -> None:
        items = items_from_timestamps("hello world", [[0, 400], [400, 900]])

        self.assertEqual([item["text"] for item in items], ["hello", " world"])
        self.assertEqual(items[-1]["end"], 900)

    def test_build_segments_falls_back_to_one_segment_without_timestamps(self) -> None:
        result = LocalTranscription("没有时间戳", "zh", [], [], "test-model")

        segments = build_local_segments(result, duration_ms=1200)

        self.assertEqual(segments, [{
            "start": 0,
            "end": 1200,
            "text": "没有时间戳",
            "items": [],
        }])


class LocalAsrFlowTests(unittest.TestCase):
    def test_qwen_seconds_timestamps_are_normalized_to_milliseconds(self) -> None:
        class FakeRuntime:
            def transcribe(self, **kwargs):
                self.kwargs = kwargs
                return [{
                    "text": "你好",
                    "language": "Chinese",
                    "time_stamps": [
                        {"text": "你", "start_time": 0.123, "end_time": 0.456},
                        {"text": "好", "start_time": 0.456, "end_time": 0.9},
                    ],
                }]

        engine = QwenAsrEngine(forced_aligner="test-aligner")
        runtime = FakeRuntime()
        engine._runtime = runtime

        result = engine.transcribe(Path("sample.wav"), language="zh")

        self.assertEqual([(item["start"], item["end"]) for item in result.items], [
            (123, 456),
            (456, 900),
        ])
        self.assertEqual(runtime.kwargs["audio"], "sample.wav")
        self.assertEqual(runtime.kwargs["language"], "Chinese")

    def test_engine_factory_does_not_import_optional_runtime(self) -> None:
        qwen = create_local_engine("qwen-asr")
        funasr = create_local_engine("funasr")

        self.assertEqual(qwen.model, QWEN_DEFAULT_MODEL)
        self.assertEqual(funasr.model, FUNASR_DEFAULT_MODEL)

    def test_fun_asr_runtime_import_is_lazy(self) -> None:
        engine = FunAsrEngine()

        with mock.patch.dict("sys.modules", {"funasr": None}):
            with self.assertRaisesRegex(RuntimeError, "funasr"):
                engine._load()

    def test_resolve_device_auto_without_torch_falls_back_to_cpu(self) -> None:
        with mock.patch.dict("sys.modules", {"torch": None}):
            self.assertEqual(resolve_device("auto"), "cpu")

    def test_default_output_uses_engine_tag(self) -> None:
        path = default_output_path(Path("D:/media/sample.mp4"), "funasr")

        self.assertEqual(path.name, "sample.funasr-local.srt")

    def test_write_local_outputs_writes_mosp_without_editing_media(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            media = root / "sample.wav"
            media.write_bytes(b"not decoded by this unit test")
            output = root / "sample.funasr-local.srt"
            result = LocalTranscription(
                "你好",
                "zh",
                [],
                [],
                "paraformer-zh",
            )
            segments = [{"start": 0, "end": 1000, "text": "你好", "items": []}]

            paths = write_local_outputs(
                input_path=media,
                output_srt=output,
                transcription=result,
                segments=segments,
                write_json=True,
                generate_html=False,
                with_waveform=False,
            )

            self.assertEqual(paths.json, root / "sample.funasr-local.mosp")
            self.assertEqual(json.loads(paths.json.read_text(encoding="utf-8"))["model"], "paraformer-zh")
            self.assertEqual(media.read_bytes(), b"not decoded by this unit test")


class LocalCliParserTests(unittest.TestCase):
    def test_parser_accepts_both_engines_and_local_options(self) -> None:
        args = build_parser().parse_args([
            "sample.mp4", "--engine", "funasr", "--device", "cpu",
            "--model", "paraformer-zh", "--hotword", "MAW", "--length-limit", "2m",
        ])

        self.assertEqual(args.engine, "funasr")
        self.assertEqual(args.length_limit, 120.0)
        self.assertEqual(args.hotword, ["MAW"])


if __name__ == "__main__":
    unittest.main()
