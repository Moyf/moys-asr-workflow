from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from generate_subtitle_qwen_api import extract_audio
from generate_subtitle_local import build_parser, default_output_path, load_hotword_files
from maw.local_asr import (
    FUNASR_DEFAULT_MODEL,
    QWEN_DEFAULT_CHUNK_SECONDS,
    QWEN_DEFAULT_FORCED_ALIGNER,
    QWEN_DEFAULT_MODEL,
    FunAsrEngine,
    LocalTranscription,
    QwenAsrEngine,
    build_local_segments,
    create_local_engine,
    funasr_output_to_transcription,
    items_from_timestamps,
    prepared_audio,
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

    def test_sensevoice_sentence_field_is_normalized(self) -> None:
        result = funasr_output_to_transcription(
            [{
                "sentence_info": [{
                    "sentence": "Hello world.",
                    "start": 200,
                    "end": 1200,
                }],
                "lang": "en",
            }],
            "iic/SenseVoiceSmall",
        )

        self.assertEqual(result.text, "Hello world.")
        self.assertEqual(result.language, "en")
        self.assertEqual(result.segments[0]["text"], "Hello world.")
        self.assertEqual(result.segments[0]["items"][0]["start"], 200)

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
    def test_extract_audio_passes_duration_limit_to_ffmpeg(self) -> None:
        with mock.patch("generate_subtitle_qwen_api.subprocess.run") as run:
            extract_audio("clip.mp4", "clip.wav", duration_limit=2.0)

        command = run.call_args.args[0]
        self.assertEqual(command[command.index("-t") + 1], "2.0")

    def test_length_limit_is_applied_during_initial_audio_extraction(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            input_path = Path(temp_dir) / "clip.mp4"
            input_path.write_bytes(b"video")
            calls: list[tuple[str, str, float | None]] = []

            def fake_extract(source: str, target: str, duration_limit: float | None = None) -> None:
                calls.append((source, target, duration_limit))
                Path(target).write_bytes(b"wav")

            with mock.patch("maw.local_asr.extract_audio", side_effect=fake_extract):
                with mock.patch("maw.local_asr.get_duration_sec", return_value=30.0):
                    with mock.patch("maw.local_asr.subprocess.run") as ffmpeg:
                        with prepared_audio(input_path, 2.0) as (_audio_path, duration_ms):
                            self.assertEqual(duration_ms, 2000)

            self.assertEqual(calls[0][2], 2.0)
            ffmpeg.assert_not_called()

    def test_prepared_audio_reports_model_preparation_after_extraction(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            input_path = Path(temp_dir) / "clip.mp4"
            input_path.write_bytes(b"video")
            events: list[str] = []

            def fake_extract(source: str, target: str, duration_limit: float | None = None) -> None:
                Path(target).write_bytes(b"wav")

            with mock.patch("maw.local_asr.extract_audio", side_effect=fake_extract):
                with mock.patch("maw.local_asr.get_duration_sec", return_value=30.0):
                    with prepared_audio(input_path, 2.0, on_event=events.append):
                        pass

            self.assertEqual(events, ["[local] 正在准备加载模型……"])

    def test_qwen_seconds_timestamps_are_normalized_to_milliseconds(self) -> None:
        class FakeAlignResult:
            def __init__(self, items):
                self.items = items

            def __iter__(self):
                return iter(self.items)

        class FakeRuntime:
            def transcribe(self, **kwargs):
                self.kwargs = kwargs
                return [SimpleNamespace(
                    text="你好",
                    language="Chinese",
                    time_stamps=FakeAlignResult([
                        SimpleNamespace(text="你", start_time=0.123, end_time=0.456),
                        SimpleNamespace(text="好", start_time=0.456, end_time=0.9),
                    ]),
                )]

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

    def test_qwen_english_alignment_items_restore_spaces(self) -> None:
        class FakeRuntime:
            def transcribe(self, **kwargs):
                return [SimpleNamespace(
                    text="Hello, world. Next sentence works!",
                    language="English",
                    time_stamps=[
                        SimpleNamespace(text="Hello", start_time=0.0, end_time=0.4),
                        SimpleNamespace(text="world", start_time=0.4, end_time=0.9),
                        SimpleNamespace(text="Next", start_time=1.0, end_time=1.3),
                        SimpleNamespace(text="sentence", start_time=1.3, end_time=1.8),
                        SimpleNamespace(text="works", start_time=1.8, end_time=2.0),
                    ],
                )]

        engine = QwenAsrEngine(forced_aligner="test-aligner")
        engine._runtime = FakeRuntime()

        result = engine.transcribe(Path("sample.wav"), language="en")

        self.assertEqual(
            [item["text"] for item in result.items],
            ["Hello,", " world.", " Next", " sentence", " works!"],
        )
        self.assertEqual(
            [segment["text"] for segment in build_local_segments(result, duration_ms=2200)],
            ["Hello, world.", " Next sentence works!"],
        )

    def test_qwen_long_audio_is_split_and_timestamps_are_shifted(self) -> None:
        class FakeRuntime:
            def __init__(self) -> None:
                self.calls: list[str] = []

            def transcribe(self, **kwargs):
                self.calls.append(kwargs["audio"])
                return [SimpleNamespace(
                    text="hello",
                    language="English",
                    time_stamps=[SimpleNamespace(text="hello", start_time=1.0, end_time=2.0)],
                )]

        with tempfile.TemporaryDirectory() as temp_dir:
            audio_path = Path(temp_dir) / "long.wav"
            audio_path.write_bytes(b"wav")
            runtime = FakeRuntime()
            events: list[str] = []
            engine = QwenAsrEngine(forced_aligner="test-aligner")
            engine._runtime = runtime

            with mock.patch("maw.local_asr.get_duration_sec", return_value=65.0):
                with mock.patch("maw.local_asr.subprocess.run") as run:
                    result = engine.transcribe(
                        audio_path,
                        language="en",
                        batch_size_s=QWEN_DEFAULT_CHUNK_SECONDS,
                        on_event=events.append,
                    )

        self.assertEqual(len(runtime.calls), 3)
        self.assertEqual(run.call_count, 3)
        self.assertEqual(
            [(item["start"], item["end"]) for item in result.items],
            [(1000, 2000), (31000, 32000), (61000, 62000)],
        )
        self.assertEqual(result.text, "hello hello hello")
        self.assertTrue(any("将分为 3 段识别" in event for event in events))
        self.assertTrue(any("长音频分块识别完成" in event for event in events))

    def test_engine_factory_does_not_import_optional_runtime(self) -> None:
        qwen = create_local_engine("qwen-asr")
        funasr = create_local_engine("funasr")

        self.assertEqual(qwen.model, QWEN_DEFAULT_MODEL)
        self.assertEqual(qwen.forced_aligner, QWEN_DEFAULT_FORCED_ALIGNER)
        self.assertEqual(funasr.model, FUNASR_DEFAULT_MODEL)

    def test_engine_factory_supports_qwen_17b_and_funasr_model_defaults(self) -> None:
        qwen = create_local_engine("qwen-asr", model="Qwen/Qwen3-ASR-1.7B")
        sensevoice = create_local_engine("funasr", model="iic/SenseVoiceSmall")
        nano = create_local_engine("funasr", model="FunAudioLLM/Fun-ASR-Nano-2512")

        self.assertEqual(qwen.model, "Qwen/Qwen3-ASR-1.7B")
        self.assertEqual(qwen.forced_aligner, QWEN_DEFAULT_FORCED_ALIGNER)
        self.assertEqual(sensevoice.vad_model, "fsmn-vad")
        self.assertTrue(sensevoice.rich_postprocess)
        self.assertEqual(sensevoice.vad_max_single_segment_time, 30000)
        self.assertTrue(nano.trust_remote_code)
        self.assertEqual(nano.vad_model, "fsmn-vad")
        self.assertEqual(nano.vad_max_single_segment_time, 30000)

    def test_sensevoice_requests_sentence_timestamps_and_preserves_cues(self) -> None:
        class FakeRuntime:
            def generate(self, **kwargs):
                self.kwargs = kwargs
                return [{
                    "text": "First sentence. Second sentence.",
                    "lang": "en",
                    "sentence_info": [
                        {"sentence": "First sentence.", "start": 100, "end": 900},
                        {"sentence": "Second sentence.", "start": 1100, "end": 2100},
                    ],
                }]

        engine = create_local_engine("funasr", model="iic/SenseVoiceSmall")
        runtime = FakeRuntime()
        engine._runtime = runtime

        result = engine.transcribe(Path("sample.wav"), language="en")

        self.assertTrue(runtime.kwargs["sentence_timestamp"])
        self.assertTrue(runtime.kwargs["use_itn"])
        self.assertTrue(runtime.kwargs["merge_vad"])
        self.assertEqual(runtime.kwargs["merge_length_s"], 15)
        self.assertEqual([segment["text"] for segment in result.segments], [
            "First sentence.",
            "Second sentence.",
        ])

    def test_fun_asr_nano_uses_vad_and_splits_character_timestamps(self) -> None:
        class FakeRuntime:
            def generate(self, **kwargs):
                self.kwargs = kwargs
                text = "First sentence works here. Second sentence works too."
                return [{
                    "text": text,
                    "lang": "en",
                    "timestamps": [
                        {
                            "token": char,
                            "start_time": index * 0.05,
                            "end_time": (index + 1) * 0.05,
                        }
                        for index, char in enumerate(text)
                    ],
                }]

        engine = create_local_engine(
            "funasr",
            model="FunAudioLLM/Fun-ASR-Nano-2512",
        )
        runtime = FakeRuntime()
        engine._runtime = runtime

        result = engine.transcribe(Path("sample.wav"), language="en")

        self.assertEqual(runtime.kwargs["batch_size_s"], 300)
        self.assertTrue(runtime.kwargs["sentence_timestamp"])
        segments = build_local_segments(result, duration_ms=2000)
        self.assertEqual([segment["text"] for segment in segments], [
            "First sentence works here.",
            " Second sentence works too.",
        ])

    def test_fun_asr_runtime_import_is_lazy(self) -> None:
        engine = FunAsrEngine()

        with mock.patch.dict("sys.modules", {"funasr": None}):
            with self.assertRaisesRegex(RuntimeError, "funasr"):
                engine._load()

    def test_resolve_device_auto_without_torch_falls_back_to_cpu(self) -> None:
        with mock.patch.dict("sys.modules", {"torch": None}):
            self.assertEqual(resolve_device("auto"), "cpu")

    def test_resolve_device_auto_prefers_available_cuda(self) -> None:
        class FakeCuda:
            @staticmethod
            def is_available() -> bool:
                return True

        class FakeTorch:
            cuda = FakeCuda()

        with mock.patch.dict("sys.modules", {"torch": FakeTorch()}):
            self.assertEqual(resolve_device("auto"), "cuda")

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

    def test_hotword_files_support_comments_and_deduplication(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "terms.txt"
            path.write_text("\ufeff# comment\nMAW\n\nQwen3-ASR\nMAW\n", encoding="utf-8")

            self.assertEqual(load_hotword_files([str(path)]), ["MAW", "Qwen3-ASR"])


if __name__ == "__main__":
    unittest.main()
