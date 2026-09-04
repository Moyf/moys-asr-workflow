from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from generate_subtitle_qwen_api import extract_audio
from generate_subtitle_local import build_parser, default_output_path, load_hotword_files
from maw.local_asr import (
    FUNASR_DEFAULT_MODEL,
    MOSS_DEFAULT_MODEL,
    MOSS_DEFAULT_REVISION,
    MOSS_MAX_NEW_TOKENS,
    QWEN_DEFAULT_CHUNK_SECONDS,
    QWEN_DEFAULT_FORCED_ALIGNER,
    QWEN_DEFAULT_MODEL,
    WHISPER_DEFAULT_MODEL,
    WHISPER_DEFAULT_VAD_MIN_SILENCE_MS,
    FunAsrEngine,
    LocalAsrError,
    LocalTranscription,
    QwenAsrEngine,
    WhisperEngine,
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
        self.assertEqual(result.language_source, "detected")
        self.assertEqual(result.split_mode, "continuous")
        self.assertEqual(result.timestamp_granularity, "char")
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
        self.assertEqual(result.timestamp_granularity, "segment")

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
        self.assertEqual(result.language_source, "detected")
        self.assertEqual(result.split_mode, "word")
        self.assertEqual(result.timestamp_granularity, "segment")
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


class LocalSegmentationTuningTests(unittest.TestCase):
    """切分设置作用于可重组的引擎分段；段级-only 输出保留原始边界。"""

    def test_segment_only_transcription_is_not_hard_split(self) -> None:
        text = "The editing process. Now, don't get me wrong, I really enjoy it."
        source = {
            "start": 1000,
            "end": 11500,
            "text": text,
            "speaker": "S01",
        }
        result = LocalTranscription(
            text,
            "",
            [],
            [source],
            "moss-test",
            "unknown",
            "word",
            "segment",
        )

        segments = build_local_segments(
            result,
            duration_ms=12_000,
            max_len=4,
            min_len=1,
            max_words=2,
            min_words=1,
            gap_split_ms=1,
        )

        self.assertEqual(segments, [source])
        self.assertNotIn("items", segments[0])

    def test_oversized_coarse_segment_resplits_within_max_len(self) -> None:
        text = "本地模型，AI校准和翻译，双语字幕，免费ASR，这些功能全都加上了。这么长一句话！"
        coarse = {
            "start": 1000,
            "end": 11500,
            "text": text,
            "items": [{"text": text, "start": 1000, "end": 11500, "speaker": "S01"}],
            "speaker": "S01",
        }
        result = LocalTranscription(text, "zh", [], [coarse], "moss-test")

        segments = build_local_segments(result, duration_ms=12_000, max_len=15, min_len=5, gap_split_ms=300)

        self.assertEqual([seg["text"] for seg in segments], [
            "本地模型，AI校准和翻译",
            "双语字幕，免费ASR",
            "这些功能全都加上了",
            "这么长一句话！",
        ])
        self.assertTrue(all(len(seg["text"]) <= 15 for seg in segments))
        self.assertTrue(all(seg.get("speaker") == "S01" for seg in segments))
        self.assertTrue(all(seg["items"] and seg["items"][0].get("speaker") == "S01" for seg in segments))
        # 块首尾真实时间保持不变，中间为整数毫秒单调插值且互不重叠。
        self.assertEqual(segments[0]["start"], 1000)
        self.assertEqual(segments[-1]["end"], 11_500)
        for previous, current in zip(segments, segments[1:]):
            self.assertLessEqual(previous["end"], current["start"])
            self.assertLess(current["start"], current["end"])

    def test_trailing_full_width_punct_is_stripped(self) -> None:
        text = "这是结尾。"
        coarse = {"start": 0, "end": 2000, "text": text, "items": [{"text": text, "start": 0, "end": 2000}]}
        result = LocalTranscription(text, "zh", [], [coarse], "test-model")

        segments = build_local_segments(result, duration_ms=2000)

        self.assertEqual(len(segments), 1)
        self.assertEqual(segments[0]["text"], "这是结尾")
        self.assertEqual(segments[0]["items"][-1]["text"], "这是结尾")

    def test_strip_tail_punct_empty_disables_stripping(self) -> None:
        # 共享保留符号配置把 ，。 全部保留时，转写侧剥尾整体禁用。
        text = "这是结尾，"
        coarse = {"start": 0, "end": 2000, "text": text, "items": [{"text": text, "start": 0, "end": 2000}]}
        result = LocalTranscription(text, "zh", [], [coarse], "test-model")

        segments = build_local_segments(result, duration_ms=2000, strip_tail_punct="")

        self.assertEqual(segments[0]["text"], "这是结尾，")

    def test_short_engine_segments_pass_through_without_resplit(self) -> None:
        short_a = {"start": 0, "end": 1200, "text": "你好呀", "items": [{"text": "你好呀", "start": 0, "end": 1200}]}
        short_b = {"start": 5000, "end": 6000, "text": "再见啦", "items": [{"text": "再见啦", "start": 5000, "end": 6000}]}
        result = LocalTranscription("你好呀再见啦", "zh", [], [short_a, short_b], "test-model")

        segments = build_local_segments(result, duration_ms=7000, max_len=15)

        self.assertEqual([seg["text"] for seg in segments], ["你好呀", "再见啦"])
        self.assertEqual([seg["start"] for seg in segments], [0, 5000])
        self.assertEqual([seg["end"] for seg in segments], [1200, 6000])

    def test_word_level_timestamps_are_kept_when_resplitting(self) -> None:
        text = "哈哈哈哈，呵呵呵呵"
        word_items = [
            {"text": "哈哈哈哈，", "start": 100, "end": 900},
            {"text": "呵呵呵呵", "start": 900, "end": 1800},
        ]
        coarse = {"start": 100, "end": 1800, "text": text, "items": word_items}
        result = LocalTranscription(text, "zh", [], [coarse], "test-model")

        segments = build_local_segments(result, duration_ms=2000, max_len=7)

        self.assertEqual([seg["text"] for seg in segments], ["哈哈哈哈", "呵呵呵呵"])
        # 切分边界来自真实词级时间码，而不是字符插值估计。
        self.assertEqual(segments[0]["start"], 100)
        self.assertEqual(segments[0]["end"], 900)
        self.assertEqual(segments[1]["start"], 900)
        self.assertEqual(segments[1]["end"], 1800)

    def test_word_limit_applies_even_when_character_limit_is_not_reached(self) -> None:
        text = "one two three"
        word_items = [
            {"text": "one", "start": 0, "end": 300},
            {"text": " two", "start": 300, "end": 600},
            {"text": " three", "start": 600, "end": 900},
        ]
        source = {"start": 0, "end": 900, "text": text, "items": word_items}
        result = LocalTranscription(
            text,
            "en",
            [],
            [source],
            "test-model",
            "detected",
            "word",
            "word",
        )

        segments = build_local_segments(
            result,
            duration_ms=1000,
            max_len=100,
            min_len=1,
            max_words=2,
            min_words=1,
        )

        self.assertEqual([segment["text"] for segment in segments], ["one two", " three"])
        self.assertEqual([len(segment["items"]) for segment in segments], [2, 1])

    def test_max_len_setting_changes_output(self) -> None:
        text = "一句特别特别长的中文台词需要被整理"
        coarse = {"start": 0, "end": 4000, "text": text, "items": [{"text": text, "start": 0, "end": 4000}]}
        result = LocalTranscription(text, "zh", [], [coarse], "test-model")

        loose = build_local_segments(result, duration_ms=4000, max_len=40)
        strict = build_local_segments(result, duration_ms=4000, max_len=8)

        self.assertEqual([seg["text"] for seg in loose], [text])
        self.assertGreater(len(strict), 1)
        self.assertTrue(all(len(seg["text"]) <= 8 for seg in strict))


class LocalAsrFlowTests(unittest.TestCase):
    def test_extract_audio_passes_duration_limit_to_ffmpeg(self) -> None:
        with mock.patch("generate_subtitle_qwen_api.subprocess.run") as run:
            extract_audio("clip.mp4", "clip.wav", duration_limit=2.0, ffmpeg_path="ffmpeg")

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
                        ffmpeg_path="ffmpeg",
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

    def test_engine_factory_supports_moss(self) -> None:
        moss = create_local_engine("moss")

        self.assertEqual(moss.model, MOSS_DEFAULT_MODEL)

    def test_engine_factory_supports_whisper(self) -> None:
        engine = create_local_engine("whisper")

        self.assertIsInstance(engine, WhisperEngine)
        self.assertEqual(engine.model, WHISPER_DEFAULT_MODEL)
        self.assertEqual(engine.model_path, WHISPER_DEFAULT_MODEL)

        local_dir = "D:/models/faster-whisper-large-v3-ct2"
        local = create_local_engine("whisper", model=local_dir)
        self.assertEqual(local.model, local_dir)
        self.assertEqual(local.model_path, local_dir)

    def test_whisper_runtime_import_is_lazy(self) -> None:
        engine = create_local_engine("whisper")

        with mock.patch.dict("sys.modules", {"faster_whisper": None}):
            with self.assertRaisesRegex(RuntimeError, "faster-whisper"):
                engine._load()

    def test_whisper_download_root_follows_cache_env_for_model_ids(self) -> None:
        captured: dict[str, object] = {}
        model_refs: list[str] = []

        def fake_whisper_model(model_ref: str, **kwargs: object) -> object:
            model_refs.append(model_ref)
            captured.update(kwargs)
            return object()

        faster_whisper_module = SimpleNamespace(WhisperModel=fake_whisper_model)
        with tempfile.TemporaryDirectory() as temp_dir:
            cache_root = Path(temp_dir) / "model-cache"
            cache_root.mkdir()
            hub_cache = cache_root / "huggingface" / "hub"
            with mock.patch.dict("sys.modules", {"faster_whisper": faster_whisper_module}):
                with mock.patch("maw.local_asr.resolve_device", return_value="cpu"):
                    # 运行时环境同时注入两个变量（model_cache_environment）；
                    # 显式 download_root 必须与 HF_HUB_CACHE 的 hub 目录一致，
                    # 而不是 MAW_MODEL_CACHE_ROOT 裸根——否则 models--* 仓库
                    # 会落在缓存根本体，偏离统一的缓存发现布局。
                    with mock.patch.dict(os.environ, {
                        "MAW_MODEL_CACHE_ROOT": str(cache_root),
                        "HF_HUB_CACHE": str(hub_cache),
                    }):
                        create_local_engine("whisper")._load()
                        self.assertEqual(model_refs, [WHISPER_DEFAULT_MODEL])
                        self.assertEqual(captured.get("download_root"), str(hub_cache))

                    # 只注入裸根时按约定派生 hub 子目录。
                    with mock.patch.dict(os.environ, {
                        "MAW_MODEL_CACHE_ROOT": str(cache_root),
                        "HF_HUB_CACHE": "",
                        "HUGGINGFACE_HUB_CACHE": "",
                    }):
                        captured.clear()
                        create_local_engine("whisper")._load()
                        self.assertEqual(captured.get("download_root"), str(hub_cache))

                    captured.clear()
                    create_local_engine("whisper", model=str(cache_root))._load()
                    self.assertNotIn("download_root", captured)

    def test_whisper_auto_falls_back_to_cpu_when_cuda_runtime_is_unavailable(self) -> None:
        calls: list[dict[str, object]] = []
        events: list[str] = []

        def fake_whisper_model(model_ref: str, **kwargs: object) -> object:
            del model_ref
            calls.append(kwargs)
            if kwargs["device"] == "cuda":
                raise RuntimeError("Library cublas64_12.dll is not found or cannot be loaded")
            return object()

        faster_whisper_module = SimpleNamespace(WhisperModel=fake_whisper_model)
        with mock.patch.dict("sys.modules", {"faster_whisper": faster_whisper_module}):
            with mock.patch("maw.local_asr.resolve_device", return_value="cuda"):
                runtime = create_local_engine("whisper", device="auto")._load(events.append)

        self.assertIsNotNone(runtime)
        self.assertEqual([call["device"] for call in calls], ["cuda", "cpu"])
        self.assertEqual([call["compute_type"] for call in calls], ["float16", "int8"])
        self.assertTrue(any("自动回退到 CPU" in event for event in events))

    def test_whisper_explicit_cuda_does_not_fall_back(self) -> None:
        calls: list[dict[str, object]] = []

        def fake_whisper_model(model_ref: str, **kwargs: object) -> object:
            del model_ref
            calls.append(kwargs)
            raise RuntimeError("Library cublas64_12.dll is not found or cannot be loaded")

        faster_whisper_module = SimpleNamespace(WhisperModel=fake_whisper_model)
        with mock.patch.dict("sys.modules", {"faster_whisper": faster_whisper_module}):
            with mock.patch("maw.local_asr.resolve_device", return_value="cuda"):
                with self.assertRaisesRegex(LocalAsrError, "模型加载失败"):
                    create_local_engine("whisper", device="cuda")._load()

        self.assertEqual([call["device"] for call in calls], ["cuda"])

    def test_whisper_word_timestamps_are_normalized_to_milliseconds(self) -> None:
        class FakeRuntime:
            def __init__(self) -> None:
                self.audio = ""
                self.kwargs: dict[str, object] = {}

            def transcribe(self, audio: str, **kwargs: object):
                self.audio = audio
                self.kwargs = kwargs
                segment = SimpleNamespace(
                    start=0.1,
                    end=0.9,
                    text=" 你好。",
                    words=[
                        SimpleNamespace(word="你", start=0.123, end=0.456),
                        SimpleNamespace(word="好。", start=0.456, end=0.9),
                    ],
                )
                return [segment], SimpleNamespace(language="zh")

        engine = create_local_engine("whisper")
        runtime = FakeRuntime()
        engine._runtime = runtime

        result = engine.transcribe(Path("sample.wav"), language="zh", hotwords=["MAW"])

        self.assertEqual([(item["start"], item["end"]) for item in result.items], [
            (123, 456),
            (456, 900),
        ])
        self.assertEqual(result.text, "你好。")
        self.assertEqual(result.language, "zh")
        self.assertEqual(runtime.audio, "sample.wav")
        self.assertTrue(runtime.kwargs["word_timestamps"])
        self.assertTrue(runtime.kwargs["vad_filter"])
        self.assertFalse(runtime.kwargs["condition_on_previous_text"])
        self.assertEqual(
            runtime.kwargs["vad_parameters"],
            {"min_silence_duration_ms": WHISPER_DEFAULT_VAD_MIN_SILENCE_MS},
        )
        self.assertEqual(runtime.kwargs["language"], "zh")
        self.assertEqual(runtime.kwargs["hotwords"], "MAW")

    def test_whisper_english_items_keep_inter_word_spacing(self) -> None:
        class FakeRuntime:
            def transcribe(self, audio: str, **kwargs: object):
                segments = [
                    SimpleNamespace(
                        start=0.0,
                        end=0.9,
                        text="Hello, world.",
                        words=[
                            SimpleNamespace(word="Hello,", start=0.0, end=0.4),
                            SimpleNamespace(word="world.", start=0.4, end=0.9),
                        ],
                    ),
                    SimpleNamespace(
                        start=1.0,
                        end=2.0,
                        text="Next sentence works!",
                        words=[
                            SimpleNamespace(word="Next", start=1.0, end=1.3),
                            SimpleNamespace(word="sentence", start=1.3, end=1.6),
                            SimpleNamespace(word="works!", start=1.6, end=2.0),
                        ],
                    ),
                ]
                return segments, SimpleNamespace(language="en")

        engine = create_local_engine("whisper")
        engine._runtime = FakeRuntime()

        result = engine.transcribe(Path("sample.wav"))

        # 跨 Whisper 句段边界也要保留英文单词间的前导空格（与 Qwen 对齐路径一致）。
        self.assertEqual([item["text"] for item in result.items], [
            "Hello,", " world.", " Next", " sentence", " works!",
        ])
        self.assertEqual(result.text, "Hello, world. Next sentence works!")
        self.assertEqual(
            [segment["text"] for segment in build_local_segments(result, duration_ms=2000)],
            ["Hello, world.", " Next sentence works!"],
        )

    def test_whisper_segment_without_words_keeps_sentence_item(self) -> None:
        class FakeRuntime:
            def transcribe(self, audio: str, **kwargs: object):
                segments = [
                    SimpleNamespace(
                        start=0.0,
                        end=1.0,
                        text=" 只有句子级时间戳。",
                        words=None,
                    ),
                ]
                return segments, SimpleNamespace(language="zh")

        engine = create_local_engine("whisper")
        engine._runtime = FakeRuntime()

        result = engine.transcribe(Path("sample.wav"))

        self.assertEqual(result.items[0]["text"], "只有句子级时间戳。")
        self.assertEqual((result.items[0]["start"], result.items[0]["end"]), (0, 1000))

    def test_moss_default_revision_is_pinned(self) -> None:
        self.assertRegex(MOSS_DEFAULT_REVISION, r"^[0-9a-f]{40}$")

    def test_moss_default_revision_is_forwarded_to_model_and_processor(self) -> None:
        engine = create_local_engine("moss")
        model = mock.Mock()
        model.to.return_value = model
        model.eval.return_value = model
        processor = object()
        auto_model = mock.Mock()
        auto_model.from_pretrained.return_value = model
        auto_processor = mock.Mock()
        auto_processor.from_pretrained.return_value = processor
        torch = SimpleNamespace(
            bfloat16="bfloat16",
            float32="float32",
            device=lambda value: SimpleNamespace(type=value),
        )
        attention = mock.Mock(return_value=(model, {}))
        with mock.patch.dict("sys.modules", {
            "torch": torch,
            "transformers": SimpleNamespace(
                AutoModelForCausalLM=auto_model,
                AutoProcessor=auto_processor,
            ),
            "moss_transcribe_diarize.attention": SimpleNamespace(
                load_model_with_attention_fallback=attention,
            ),
        }):
            with mock.patch("maw.local_asr.resolve_device", return_value="cpu"):
                engine._load()

        model_loader = attention.call_args.kwargs["model_loader"]
        model_loader("model-path")
        self.assertEqual(auto_model.from_pretrained.call_args.kwargs["revision"], MOSS_DEFAULT_REVISION)
        self.assertEqual(auto_processor.from_pretrained.call_args.kwargs["revision"], MOSS_DEFAULT_REVISION)

    def test_moss_transcript_is_normalized_to_speaker_segments(self) -> None:
        class FakeModel:
            def parameters(self):
                return iter([SimpleNamespace(device="cpu", dtype="float32")])

        engine = create_local_engine("moss")
        engine._runtime = (FakeModel(), object(), {})
        parsed = [
            SimpleNamespace(start=0.5, end=1.25, speaker="S01", text="你好"),
            SimpleNamespace(start=1.5, end=2.0, speaker="S02", text="世界"),
        ]
        with mock.patch("maw.local_asr.get_duration_sec", return_value=2.0):
            with mock.patch.dict("sys.modules", {
                "moss_transcribe_diarize": SimpleNamespace(parse_transcript=mock.Mock(return_value=parsed)),
                "moss_transcribe_diarize.inference_utils": SimpleNamespace(
                    build_transcription_messages=mock.Mock(return_value=[]),
                    generate_transcription=mock.Mock(return_value={"text": "你好世界"}),
                ),
            }):
                with mock.patch("maw.local_asr.MossDiarizeEngine._load", return_value=engine._runtime):
                    result = engine.transcribe(Path("sample.wav"))

        self.assertEqual(result.items, [])
        self.assertEqual(result.language, "zh")
        self.assertEqual(result.language_source, "inferred")
        self.assertEqual(result.split_mode, "continuous")
        self.assertEqual(result.timestamp_granularity, "segment")
        self.assertEqual([segment["speaker"] for segment in result.segments], ["S01", "S02"])
        self.assertTrue(all("items" not in segment for segment in result.segments))

    def test_moss_warns_when_generation_reaches_output_limit(self) -> None:
        class FakeModel:
            def parameters(self):
                return iter([SimpleNamespace(device="cpu", dtype="float32")])

        engine = create_local_engine("moss")
        engine._runtime = (FakeModel(), object(), {})
        events: list[str] = []
        with mock.patch("maw.local_asr.get_duration_sec", return_value=2.0):
            with mock.patch.dict("sys.modules", {
                "moss_transcribe_diarize": SimpleNamespace(parse_transcript=lambda _text: []),
                "moss_transcribe_diarize.inference_utils": SimpleNamespace(
                    build_transcription_messages=lambda _path: [],
                    generate_transcription=lambda *_args, **_kwargs: {
                        "text": "", "generated_tokens": MOSS_MAX_NEW_TOKENS,
                    },
                ),
            }):
                engine.transcribe(Path("sample.wav"), on_event=events.append)

        self.assertTrue(any("达到最大 token 数" in event for event in events))

    def test_moss_reports_generation_progress_when_runtime_supports_callbacks(self) -> None:
        class FakeModel:
            def parameters(self):
                return iter([SimpleNamespace(device="cpu", dtype="float32")])

        calls: dict[str, object] = {}

        def fake_generate(
            *_args: object,
            input_callback=None,
            token_callback=None,
            **_kwargs: object,
        ) -> dict[str, object]:
            calls["input_callback"] = input_callback
            calls["token_callback"] = token_callback
            if input_callback:
                input_callback(12)
            if token_callback:
                token_callback(32)
            return {"text": "", "generated_tokens": 32}

        engine = create_local_engine("moss")
        engine._runtime = (FakeModel(), object(), {})
        events: list[str] = []
        with mock.patch("maw.local_asr.get_duration_sec", return_value=2.0):
            with mock.patch.dict("sys.modules", {
                "moss_transcribe_diarize": SimpleNamespace(parse_transcript=lambda _text: []),
                "moss_transcribe_diarize.inference_utils": SimpleNamespace(
                    build_transcription_messages=lambda _path: [],
                    generate_transcription=fake_generate,
                ),
            }):
                engine.transcribe(Path("sample.wav"), on_event=events.append)

        self.assertIsNotNone(calls["input_callback"])
        self.assertIsNotNone(calls["token_callback"])
        self.assertTrue(any("音频特征已准备" in event for event in events))
        self.assertTrue(any("已生成 32 tokens" in event for event in events))
        self.assertTrue(any("生成完成：共 32 tokens" in event for event in events))

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

        self.assertEqual(default_output_path(Path("D:/media/sample.mp4"), "moss").name, "sample.moss-local.srt")
        self.assertEqual(default_output_path(Path("D:/media/sample.mp4"), "whisper").name, "sample.whisper-local.srt")

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
                "detected",
                "continuous",
                "char",
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
            project = json.loads(paths.json.read_text(encoding="utf-8"))
            self.assertEqual(project["model"], "paraformer-zh")
            self.assertEqual(
                {field: project[field] for field in (
                    "language", "language_source", "split_mode", "timestamp_granularity"
                )},
                {
                    "language": "zh",
                    "language_source": "detected",
                    "split_mode": "continuous",
                    "timestamp_granularity": "char",
                },
            )
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
        self.assertEqual(args.max_words, 13)
        self.assertEqual(args.min_words, 3)

    def test_parser_accepts_whisper_engine(self) -> None:
        args = build_parser().parse_args(["sample.mp4", "--engine", "whisper"])

        self.assertEqual(args.engine, "whisper")

    def test_hotword_files_support_comments_and_deduplication(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "terms.txt"
            path.write_text("\ufeff# comment\nMAW\n\nQwen3-ASR\nMAW\n", encoding="utf-8")

            self.assertEqual(load_hotword_files([str(path)]), ["MAW", "Qwen3-ASR"])


if __name__ == "__main__":
    unittest.main()
