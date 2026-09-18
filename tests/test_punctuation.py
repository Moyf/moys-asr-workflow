from __future__ import annotations

import io
import json
import sys
import tempfile
import types
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from maw.local_asr import FireRedAsrEngine, build_local_segments
from maw.local_runtime_worker import main as worker_main
from maw.local_models import _find_modelscope_model
from maw.punctuation import PunctuationError, punctuate_text, punctuate_timed_tokens
from maw.punctuation_runtime import punctuate_text_in_runtime


class PunctuationMappingTests(unittest.TestCase):
    def test_punctuation_is_attached_without_changing_ctc_ranges(self) -> None:
        tokens = [
            {"text": "你", "start": 100, "end": 220},
            {"text": "好", "start": 220, "end": 360},
            {"text": "Hello", "start": 500, "end": 700},
            {"text": " world", "start": 700, "end": 900},
        ]

        result = punctuate_timed_tokens(
            tokens,
            runner=lambda _text, **_kwargs: "你好。Hello world!",
        )

        self.assertEqual([segment["text"] for segment in result], ["你好。", "Hello world!"])
        self.assertEqual(
            [(item["text"], item["start"], item["end"]) for item in result[0]["items"]],
            [("你", 100, 220), ("好。", 220, 360)],
        )
        self.assertEqual(
            [(item["text"], item["start"], item["end"]) for item in result[1]["items"]],
            [("Hello", 500, 700), (" world!", 700, 900)],
        )

    def test_existing_punctuation_item_is_not_duplicated(self) -> None:
        tokens = [
            {"text": "你好", "start": 0, "end": 100},
            {"text": "，", "start": 100, "end": 120},
            {"text": "世界", "start": 120, "end": 200},
        ]

        result = punctuate_timed_tokens(
            tokens,
            runner=lambda _text, **_kwargs: "你好，世界。",
        )

        self.assertEqual(result[0]["text"], "你好，世界。")
        self.assertEqual([item["text"] for item in result[0]["items"]], ["你好", "，", "世界。"])

    def test_text_runner_and_content_guard(self) -> None:
        self.assertEqual(
            punctuate_text("你好世界", runner=lambda _text, **_kwargs: {"text": "你好，世界。"}),
            "你好，世界。",
        )
        with self.assertRaisesRegex(PunctuationError, "改变了原始文字"):
            punctuate_text("你好", runner=lambda _text, **_kwargs: "你好世界。")

    def test_incomplete_punctuation_result_fails_loudly(self) -> None:
        with self.assertRaisesRegex(PunctuationError, "无效结果"):
            punctuate_text(
                "你好",
                runner=lambda _text, **_kwargs: None,
            )


class FireRedAsrPipelineTests(unittest.TestCase):
    def test_debug_writer_receives_ctc_and_punctuation_stages(self) -> None:
        captured: list[tuple[str, object]] = []
        engine = FireRedAsrEngine(debug_writer=lambda stage, payload: captured.append((stage, payload)))
        decoded = SimpleNamespace(
            text="你好世界",
            tokens=("你", "好", "世", "界"),
            timestamps=((0, 100), (100, 200), (200, 300), (300, 400)),
            duration_ms=400,
        )
        punc_segments = [{
            "start": 0,
            "end": 400,
            "text": "你好世界。",
            "items": [
                {"text": "你", "start": 0, "end": 100},
                {"text": "好", "start": 100, "end": 200},
                {"text": "世", "start": 200, "end": 300},
                {"text": "界。", "start": 300, "end": 400},
            ],
        }]

        with mock.patch.object(engine, "_load", return_value=SimpleNamespace(decode=lambda _path: decoded)):
            with mock.patch("maw.local_asr._media_duration_seconds", return_value=0.4):
                with mock.patch("maw.timestamp_alignment.firered_tokens_to_items") as to_items:
                    to_items.return_value = [
                        SimpleNamespace(text=char, start=index * 100, end=(index + 1) * 100)
                        for index, char in enumerate("你好世界")
                    ]
                    with mock.patch("maw.local_asr.punctuate_timed_tokens", return_value=punc_segments):
                        engine.transcribe(Path("sample.wav"), batch_size_s=1)

        stages = {stage: payload for stage, payload in captured}
        self.assertEqual(set(stages), {"firered-ctc", "firered-punctuated"})
        self.assertEqual(stages["firered-ctc"]["chunks"][0]["rawText"], "你好世界")
        self.assertEqual(stages["firered-punctuated"]["chunks"][0]["punctuated"]["text"], "你好世界。")

    def test_asr_calls_ct_punc_before_segmentation_and_preserves_punctuation(self) -> None:
        engine = FireRedAsrEngine()
        decoded = SimpleNamespace(
            text="你好世界",
            tokens=("你", "好", "世", "界"),
            timestamps=((0, 100), (100, 200), (200, 300), (300, 400)),
            duration_ms=400,
        )
        punc_segments = [
            {
                "start": 0,
                "end": 200,
                "text": "你好。",
                "items": [
                    {"text": "你", "start": 0, "end": 100},
                    {"text": "好。", "start": 100, "end": 200},
                ],
            },
            {
                "start": 200,
                "end": 400,
                "text": "世界！",
                "items": [
                    {"text": "世", "start": 200, "end": 300},
                    {"text": "界！", "start": 300, "end": 400},
                ],
            },
        ]

        with mock.patch("maw.timestamp_alignment.FireRedCtcBackend", create=True):
            with mock.patch("maw.timestamp_alignment.firered_tokens_to_items") as to_items:
                to_items.return_value = [
                    SimpleNamespace(text="你", start=0, end=100),
                    SimpleNamespace(text="好", start=100, end=200),
                    SimpleNamespace(text="世", start=200, end=300),
                    SimpleNamespace(text="界", start=300, end=400),
                ]
                with mock.patch("maw.local_asr.punctuate_timed_tokens", return_value=punc_segments) as punc:
                    result = engine._decode_one(
                        SimpleNamespace(decode=lambda _path: decoded),
                        Path("sample.wav"),
                        language="zh",
                        on_event=None,
                    )

        punc.assert_called_once()
        self.assertEqual(result.text, "你好。世界！")
        self.assertTrue(result.preserve_punctuation)
        segments = build_local_segments(result, duration_ms=400)
        self.assertEqual([segment["text"] for segment in segments], ["你好。", "世界！"])

    def test_empty_ctc_chunk_skips_punctuation_model(self) -> None:
        engine = FireRedAsrEngine()
        decoded = SimpleNamespace(
            text="",
            tokens=(),
            timestamps=(),
            duration_ms=400,
        )

        with mock.patch("maw.timestamp_alignment.firered_tokens_to_items", return_value=[]):
            with mock.patch("maw.local_asr.punctuate_timed_tokens") as punc:
                result = engine._decode_one(
                    SimpleNamespace(decode=lambda _path: decoded),
                    Path("silence.wav"),
                    language="zh",
                    on_event=None,
                )

        punc.assert_not_called()
        self.assertEqual(result.text, "")
        self.assertEqual(result.items, [])
        self.assertTrue(result.preserve_punctuation)

    def test_can_skip_ct_punc_and_keep_raw_ctc_items(self) -> None:
        engine = FireRedAsrEngine(use_punc=False)
        decoded = SimpleNamespace(
            text="你好世界",
            tokens=("你", "好", "世", "界"),
            timestamps=((0, 100), (100, 200), (200, 300), (300, 400)),
            duration_ms=400,
        )

        with mock.patch("maw.timestamp_alignment.firered_tokens_to_items") as to_items:
            to_items.return_value = [
                SimpleNamespace(text=char, start=index * 100, end=(index + 1) * 100)
                for index, char in enumerate("你好世界")
            ]
            with mock.patch("maw.local_asr.punctuate_timed_tokens") as punc:
                result = engine._decode_one(
                    SimpleNamespace(decode=lambda _path: decoded),
                    Path("sample.wav"),
                    language="zh",
                    on_event=None,
                )

        punc.assert_not_called()
        self.assertEqual(result.text, "你好世界")
        self.assertEqual(result.segments, [])
        self.assertEqual([item["text"] for item in result.items], list("你好世界"))
        self.assertFalse(result.preserve_punctuation)


class CtPuncWorkerTests(unittest.TestCase):
    def test_cpu_worker_uses_cpu_when_requested(self) -> None:
        captured: dict[str, object] = {}

        class FakeCuda:
            @staticmethod
            def is_available() -> bool:
                return False

        fake_torch = types.ModuleType("torch")
        fake_torch.cuda = FakeCuda()

        class FakeModel:
            def __init__(self, **kwargs: object) -> None:
                captured.update(kwargs)

            def generate(self, *, input: str) -> list[dict[str, str]]:
                return [{"text": f"{input}。"}]

        fake_funasr = types.ModuleType("funasr")
        fake_funasr.AutoModel = FakeModel

        with tempfile.TemporaryDirectory() as temp_dir:
            input_path = Path(temp_dir) / "text.json"
            input_path.write_text(json.dumps({"text": "你好"}, ensure_ascii=False), encoding="utf-8")
            stdout = io.StringIO()
            with mock.patch.dict(sys.modules, {"torch": fake_torch, "funasr": fake_funasr}):
                with redirect_stdout(stdout):
                    exit_code = worker_main([
                        "punctuate",
                        "--model-path",
                        temp_dir,
                        "--input",
                        str(input_path),
                        "--device",
                        "cpu",
                    ])

        self.assertEqual(exit_code, 0)
        self.assertEqual(captured.get("device"), "cpu")
        payload = json.loads(stdout.getvalue().strip())
        self.assertEqual(payload, {"type": "result", "text": "你好。"})


class CtPuncModelDiscoveryTests(unittest.TestCase):
    def test_runtime_runner_receives_process_error_mapping(self) -> None:
        captured: dict[str, object] = {}

        def run(_command: list[str], **kwargs: object) -> int:
            captured.update(kwargs)
            callback = kwargs.get("on_line")
            assert callable(callback)
            callback(json.dumps({"type": "result", "text": "你好。"}, ensure_ascii=False))
            return 0

        with tempfile.TemporaryDirectory() as temp_dir:
            model_path = Path(temp_dir)
            with mock.patch("maw.local_models._find_modelscope_model", return_value=model_path):
                with mock.patch(
                    "maw.punctuation_runtime._resolve_worker",
                    return_value=("python", model_path / "worker.py", {}, str(model_path), run),
                ):
                    result = punctuate_text_in_runtime("你好", model_cache_root=model_path)

        self.assertEqual(result, "你好。")
        self.assertEqual(captured["error_class"].__name__, "LocalRuntimeError")
        self.assertEqual(captured["cancelled_class"].__name__, "LocalRuntimeCancelled")
        self.assertEqual(captured["message_prefix"], "本地标点模型")

    def test_modelscope_ct_punc_cache_is_detected(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            snapshot = root / "models" / "iic--punc_ct-transformer_cn-en-common-vocab471067-large" / "snapshots" / "main"
            snapshot.mkdir(parents=True)
            (snapshot / "model.pt").write_bytes(b"weights")

            with mock.patch("maw.local_models._modelscope_cache_roots", return_value=[root]):
                found = _find_modelscope_model(
                    "iic/punc_ct-transformer_cn-en-common-vocab471067-large",
                    root,
                )

        self.assertEqual(found, snapshot)


if __name__ == "__main__":
    unittest.main()
