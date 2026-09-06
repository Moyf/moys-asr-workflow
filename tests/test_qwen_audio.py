from __future__ import annotations

import io
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

from generate_subtitle_qwen_api import (
    FILETRANS_MODEL,
    FUNASR_MODEL,
    QWEN3_ASR_FILETRANS_MODEL,
    QWEN_AUDIO_FILETRANS_MODEL,
    build_segments_from_api_sentences,
    build_qwen_audio_context,
    is_qwen_audio_model,
    load_hotwords,
    main,
    parse_funasr_transcription_result,
    parse_transcription_result,
    poll_task,
    submit_filetrans,
    supports_speaker_diarization,
)
from maw.qwen_audio import parse_qwen_audio_hotwords


class QwenAudioAdapterTests(unittest.TestCase):
    def test_qwen_audio_is_the_default_filetrans_model(self) -> None:
        self.assertEqual(FILETRANS_MODEL, QWEN_AUDIO_FILETRANS_MODEL)

    def test_load_hotwords_accepts_an_explicit_text_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "custom.txt"
            path.write_text("张三\n# 注释\n\n阿里云\n", encoding="utf-8")

            self.assertEqual(load_hotwords(path), ["张三", "阿里云"])

    def test_model_detection_and_speaker_support(self) -> None:
        self.assertTrue(is_qwen_audio_model(QWEN_AUDIO_FILETRANS_MODEL))
        self.assertTrue(supports_speaker_diarization(QWEN_AUDIO_FILETRANS_MODEL))
        self.assertFalse(is_qwen_audio_model("qwen3-asr-flash-filetrans"))

    def test_qwen_standard_mixed_timestamps_preserve_sentence_fallback(self) -> None:
        result = parse_transcription_result({
            "language": "en",
            "transcripts": [{
                "text": "Hello world. Fallback sentence.",
                "sentences": [
                    {
                        "begin_time": 0,
                        "end_time": 1000,
                        "text": "Hello world.",
                        "words": [
                            {"begin_time": 0, "end_time": 400, "text": "Hello", "punctuation": ""},
                            {"begin_time": 400, "end_time": 1000, "text": "world", "punctuation": "."},
                        ],
                    },
                    {
                        "begin_time": 1200,
                        "end_time": 2000,
                        "text": "Fallback sentence.",
                    },
                ],
            }],
        })

        self.assertEqual(result["timestamp_granularity"], "segment")
        self.assertEqual(len(result["items"]), 2)
        self.assertEqual(result["segments"][0]["items"], result["items"])
        self.assertNotIn("items", result["segments"][1])

    def test_qwen_standard_sentence_range_contains_word_items(self) -> None:
        result = parse_transcription_result({
            "language": "zh",
            "transcripts": [{
                "text": "范围修复。句级回退。",
                "sentences": [
                    {
                        "begin_time": 200,
                        "end_time": 700,
                        "text": "范围修复。",
                        "words": [
                            {"begin_time": 100, "end_time": 400, "text": "范围"},
                            {"begin_time": 400, "end_time": 900, "text": "修复", "punctuation": "。"},
                        ],
                    },
                    {
                        "begin_time": 1000,
                        "end_time": 1300,
                        "text": "句级回退。",
                    },
                ],
            }],
        })

        sentence = result["segments"][0]
        self.assertEqual((sentence["start"], sentence["end"]), (100, 900))
        self.assertTrue(
            all(sentence["start"] <= item["start"] < item["end"] <= sentence["end"]
                for item in sentence["items"])
        )

    def test_qwen_standard_derives_missing_transcript_text(self) -> None:
        result = parse_transcription_result({
            "language": "zh",
            "transcripts": [{
                "sentences": [{
                    "begin_time": 0,
                    "end_time": 500,
                    "words": [{
                        "begin_time": 0,
                        "end_time": 500,
                        "text": "你好",
                        "punctuation": "。",
                    }],
                }],
            }],
        })

        self.assertEqual(result["text"], "你好。")
        self.assertEqual(result["timestamp_granularity"], "word")

    @mock.patch("generate_subtitle_qwen_api.requests.post")
    def test_submit_uses_qwen3_file_url_contract(self, post: mock.Mock) -> None:
        response = mock.Mock()
        response.json.return_value = {
            "output": {"task_id": "task-qwen3", "task_status": "PENDING"}
        }
        post.return_value = response

        task_id = submit_filetrans(
            "https://dashscope.aliyuncs.com",
            "secret",
            "oss://temporary/audio.wav",
            language=None,
            enable_words=True,
            enable_itn=False,
            model=QWEN3_ASR_FILETRANS_MODEL,
        )

        self.assertEqual(task_id, "task-qwen3")
        payload = post.call_args.kwargs["json"]
        self.assertEqual(payload["model"], QWEN3_ASR_FILETRANS_MODEL)
        self.assertEqual(payload["input"], {"file_url": "oss://temporary/audio.wav"})
        self.assertEqual(
            payload["parameters"],
            {"channel_id": [0], "enable_words": True, "enable_itn": False},
        )

    @mock.patch("generate_subtitle_qwen_api.time.sleep")
    @mock.patch("generate_subtitle_qwen_api.requests.get")
    def test_poll_completes_qwen3_after_pending_and_running(
        self,
        get: mock.Mock,
        sleep: mock.Mock,
    ) -> None:
        responses = []
        for status in ("PENDING", "RUNNING"):
            response = mock.Mock()
            response.json.return_value = {"output": {"task_status": status}}
            responses.append(response)
        response = mock.Mock()
        response.json.return_value = {
            "output": {
                "task_status": "SUCCEEDED",
                "result": {"transcription_url": "https://result.example/qwen3.json"},
            },
            "usage": {"seconds": 179},
        }
        responses.append(response)
        get.side_effect = responses

        result_url, usage = poll_task(
            "https://dashscope.aliyuncs.com",
            "secret",
            "task-qwen3",
            interval=0,
            timeout=10,
            model=QWEN3_ASR_FILETRANS_MODEL,
        )

        self.assertEqual(result_url, "https://result.example/qwen3.json")
        self.assertEqual(usage, {"seconds": 179})
        self.assertEqual(get.call_count, 3)
        self.assertEqual(sleep.call_count, 2)

    def test_hotwords_support_individual_weights_and_filter_invalid_entries(self) -> None:
        entries, issues = parse_qwen_audio_hotwords([
            "厄尔尼诺",
            "obsidian: 50",
            "布洛芬：5",
            "这是一条超过十五个字符的中文热词",
            "one two three four five six seven eight",
            "坏词: 6",
        ], 4)

        self.assertEqual(
            [(entry.text, entry.weight) for entry in entries],
            [("厄尔尼诺", 4), ("obsidian", 50), ("布洛芬", 5)],
        )
        self.assertEqual(
            [issue.code for issue in issues],
            ["text_too_long", "too_many_ascii_words", "invalid_weight"],
        )

    def test_context_uses_rest_messages_shape_and_400_character_limit(self) -> None:
        context = build_qwen_audio_context("词表" + ("x" * 500))

        self.assertEqual(context[0]["role"], "user")
        content = context[0]["content"][0]
        self.assertEqual(content["type"], "input_text")
        self.assertEqual(len(content["text"]), 400)

    @mock.patch("generate_subtitle_qwen_api.requests.post")
    def test_submit_sends_qwen_audio_file_urls_vocabulary_and_context(
        self,
        post: mock.Mock,
    ) -> None:
        response = mock.Mock()
        response.json.return_value = {
            "output": {"task_id": "task-qwen-audio", "task_status": "PENDING"}
        }
        post.return_value = response

        task_id = submit_filetrans(
            "https://dashscope.aliyuncs.com",
            "secret",
            "oss://temporary/audio.wav",
            language="zh",
            enable_words=True,
            enable_itn=False,
            model=QWEN_AUDIO_FILETRANS_MODEL,
            enable_speaker=True,
            vocabulary_id="vocab-qwen-audio",
            hotwords=["张三", "李四"],
            hotword_weight=5,
            context=build_qwen_audio_context("领域词表"),
        )

        self.assertEqual(task_id, "task-qwen-audio")
        payload = post.call_args.kwargs["json"]
        self.assertEqual(payload["model"], QWEN_AUDIO_FILETRANS_MODEL)
        self.assertEqual(payload["input"]["file_urls"], ["oss://temporary/audio.wav"])
        self.assertEqual(payload["input"]["messages"][0]["role"], "user")
        self.assertNotIn("context", payload["input"])
        self.assertEqual(payload["parameters"]["language_hints"], ["zh"])
        self.assertTrue(payload["parameters"]["diarization_enabled"])
        self.assertEqual(payload["parameters"]["vocabulary_id"], "vocab-qwen-audio")
        self.assertEqual(payload["parameters"]["vocabulary"], {"张三": 5, "李四": 5})
        self.assertNotIn("enable_words", payload["parameters"])
        self.assertNotIn("enable_itn", payload["parameters"])
        response.raise_for_status.assert_called_once_with()

    @mock.patch("generate_subtitle_qwen_api.requests.post")
    def test_submit_uses_individual_hotword_weights_and_ignores_invalid_entries(
        self,
        post: mock.Mock,
    ) -> None:
        response = mock.Mock()
        response.json.return_value = {
            "output": {"task_id": "task-weighted", "task_status": "PENDING"}
        }
        post.return_value = response

        submit_filetrans(
            "https://dashscope.aliyuncs.com",
            "secret",
            "oss://temporary/audio.wav",
            language="zh",
            enable_words=True,
            enable_itn=False,
            model=QWEN_AUDIO_FILETRANS_MODEL,
            hotwords=["厄尔尼诺", "obsidian: 50", "坏词: 6"],
            hotword_weight=4,
        )

        payload = post.call_args.kwargs["json"]
        self.assertEqual(payload["parameters"]["vocabulary"], {"厄尔尼诺": 4, "obsidian": 50})

    @mock.patch("generate_subtitle_qwen_api.requests.get")
    def test_poll_reads_qwen_audio_subtask_result(self, get: mock.Mock) -> None:
        response = mock.Mock()
        response.json.return_value = {
            "output": {
                "task_status": "SUCCEEDED",
                "results": [
                    {
                        "subtask_status": "SUCCEEDED",
                        "transcription_url": "https://result.example/qwen-audio.json",
                    }
                ],
            },
            "usage": {"duration": 12},
        }
        get.return_value = response

        result_url, usage = poll_task(
            "https://dashscope.aliyuncs.com",
            "secret",
            "task-qwen-audio",
            interval=0,
            timeout=1,
            model=QWEN_AUDIO_FILETRANS_MODEL,
        )

        self.assertEqual(result_url, "https://result.example/qwen-audio.json")
        self.assertEqual(usage, {"duration": 12})

    @mock.patch(
        "generate_subtitle_qwen_api.time.monotonic",
        side_effect=[0, 0, 0, 0, 16, 16, 16, 16],
    )
    @mock.patch("generate_subtitle_qwen_api.requests.get")
    def test_poll_reports_heartbeat_when_status_does_not_change(self, get: mock.Mock, _monotonic: mock.Mock) -> None:
        responses = []
        for status in ("RUNNING", "RUNNING"):
            response = mock.Mock()
            response.json.return_value = {"output": {"task_status": status}}
            responses.append(response)
        response = mock.Mock()
        response.json.return_value = {
            "output": {
                "task_status": "SUCCEEDED",
                "results": [{
                    "subtask_status": "SUCCEEDED",
                    "transcription_url": "https://result.example/heartbeat.json",
                }],
            },
            "usage": {},
        }
        responses.append(response)
        get.side_effect = responses
        statuses: list[str] = []

        result_url, _usage = poll_task(
            "https://dashscope.aliyuncs.com",
            "secret",
            "task-heartbeat",
            interval=0,
            timeout=100,
            model=QWEN_AUDIO_FILETRANS_MODEL,
            on_status=statuses.append,
        )

        self.assertEqual(result_url, "https://result.example/heartbeat.json")
        self.assertTrue(any("任务仍在处理中" in status for status in statuses))

    def test_parse_maps_qwen_audio_sentence_speaker_to_items(self) -> None:
        result = parse_funasr_transcription_result(
            {
                "transcripts": [
                    {
                        "text": "你好。",
                        "sentences": [
                            {
                                "language": "zh",
                                "speaker_id": 2,
                                "words": [
                                    {
                                        "begin_time": 100,
                                        "end_time": 300,
                                        "text": "你好",
                                        "punctuation": "。",
                                    }
                                ],
                            }
                        ],
                    }
                ]
            }
        )

        self.assertEqual(result["language"], "zh")
        self.assertEqual(result["items"], [])
        self.assertEqual(result["timestamp_granularity"], "segment")
        self.assertEqual(result["sentences"], [{
            "text": "你好。",
            "start": 100,
            "end": 300,
            "speaker": "2",
        }])

    def test_parse_qwen_audio_derives_missing_transcript_text(self) -> None:
        result = parse_funasr_transcription_result({
            "transcripts": [{
                "sentences": [{
                    "begin_time": 100,
                    "end_time": 300,
                    "words": [{
                        "begin_time": 100,
                        "end_time": 300,
                        "text": "你好",
                        "punctuation": "。",
                    }],
                }],
            }],
        })

        self.assertEqual(result["text"], "你好。")
        self.assertEqual(result["sentences"][0]["text"], "你好。")

    def test_qwen_audio_mixed_word_and_sentence_timestamps_are_segment_granular(self) -> None:
        result = parse_funasr_transcription_result(
            {
                "transcripts": [{
                    "text": "精确时间码。句级回退。",
                    "sentences": [
                        {
                            "begin_time": 0,
                            "end_time": 500,
                            "text": "精确时间码。",
                            "words": [
                                {"begin_time": 0, "end_time": 200, "text": "精确", "punctuation": ""},
                                {"begin_time": 200, "end_time": 500, "text": "时间码。", "punctuation": ""},
                            ],
                        },
                        {
                            "begin_time": 800,
                            "end_time": 1300,
                            "text": "句级回退。",
                        },
                    ],
                }]
            }
        )

        self.assertEqual(result["timestamp_granularity"], "segment")
        self.assertEqual(len(result["items"]), 2)
        self.assertEqual(result["sentences"][0]["items"], result["items"])
        self.assertNotIn("items", result["sentences"][1])
        self.assertEqual(
            [segment["text"] for segment in build_segments_from_api_sentences(
                result["sentences"], max_len=18, min_len=5, gap_split_ms=800,
            )],
            ["精确时间码。", "句级回退。"],
        )

    def test_parse_qwen_audio_sentence_range_contains_word_items(self) -> None:
        result = parse_funasr_transcription_result({
            "transcripts": [{
                "text": "范围修复。句级回退。",
                "sentences": [
                    {
                        "begin_time": 200,
                        "end_time": 700,
                        "text": "范围修复。",
                        "words": [
                            {"begin_time": 100, "end_time": 400, "text": "范围"},
                            {"begin_time": 400, "end_time": 900, "text": "修复", "punctuation": "。"},
                        ],
                    },
                    {
                        "begin_time": 1000,
                        "end_time": 1300,
                        "text": "句级回退。",
                    },
                ],
            }],
        })

        sentence = result["sentences"][0]
        self.assertEqual((sentence["start"], sentence["end"]), (100, 900))
        self.assertTrue(
            all(sentence["start"] <= item["start"] < item["end"] <= sentence["end"]
                for item in sentence["items"])
        )

    def test_funasr_main_preserves_sentence_fallback_boundaries(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            media_path = Path(directory) / "input.wav"
            output_path = Path(directory) / "output.srt"
            media_path.write_bytes(b"audio")
            result = {
                "text": "精确时间码。句级回退。",
                "language": "zh",
                "items": [
                    {"text": "精确", "start": 0, "end": 200},
                    {"text": "时间码。", "start": 200, "end": 500},
                ],
                "sentences": [
                    {
                        "text": "精确时间码。",
                        "start": 0,
                        "end": 500,
                        "items": [
                            {"text": "精确", "start": 0, "end": 200},
                            {"text": "时间码。", "start": 200, "end": 500},
                        ],
                    },
                    {"text": "句级回退。", "start": 800, "end": 1300},
                ],
                "timestamp_granularity": "segment",
            }
            with (
                mock.patch("sys.argv", [
                    "generate_subtitle_qwen_api.py",
                    str(media_path),
                    "--model",
                    FUNASR_MODEL,
                    "-o",
                    str(output_path),
                ]),
                mock.patch("generate_subtitle_qwen_api.resolve_ffmpeg_tools"),
                mock.patch("generate_subtitle_qwen_api.get_duration_sec", return_value=2.0),
                mock.patch("generate_subtitle_qwen_api.transcribe", return_value=result),
                redirect_stdout(io.StringIO()),
            ):
                main()

            self.assertEqual(
                output_path.read_text(encoding="utf-8").splitlines(),
                [
                    "1",
                    "00:00:00,000 --> 00:00:00,500",
                    "精确时间码",
                    "",
                    "2",
                    "00:00:00,800 --> 00:00:01,300",
                    "句级回退",
                ],
            )

    def test_qwen_audio_keeps_sentence_boundaries_without_punctuation(self) -> None:
        result = parse_funasr_transcription_result(
            {
                "transcripts": [{
                    "text": "受够了AI识别的劣质字幕又不想花那么多钱开会员想给自己的字幕制作省点力气给我3分钟解决你的字幕难题",
                    "sentences": [
                        {
                            "begin_time": 160,
                            "end_time": 1680,
                            "text": "受够了AI识别的劣质字幕",
                            "words": [{
                                "begin_time": 200,
                                "end_time": 1600,
                                "text": "受够了AI识别的劣质字幕",
                                "punctuation": "",
                            }],
                        },
                        {
                            "begin_time": 1840,
                            "end_time": 3760,
                            "text": "又不想花那么多钱开会员",
                            "words": [{
                                "begin_time": 1900,
                                "end_time": 3700,
                                "text": "又不想花那么多钱开会员",
                                "punctuation": "",
                            }],
                        },
                        {
                            "begin_time": 3840,
                            "end_time": 5920,
                            "text": "想给自己的字幕制作省点力气",
                            "words": [{
                                "begin_time": 3900,
                                "end_time": 5860,
                                "text": "想给自己的字幕制作省点力气",
                                "punctuation": "",
                            }],
                        },
                        {
                            "begin_time": 6160,
                            "end_time": 8080,
                            "text": "给我3分钟解决你的字幕难题",
                            "words": [{
                                "begin_time": 6200,
                                "end_time": 8020,
                                "text": "给我3分钟解决你的字幕难题",
                                "punctuation": "",
                            }],
                        },
                    ],
                }]
            }
        )

        segments = build_segments_from_api_sentences(
            result["sentences"], max_len=21, min_len=5, gap_split_ms=1500,
        )

        self.assertEqual(
            [segment["text"] for segment in segments],
            [
                "受够了AI识别的劣质字幕",
                "又不想花那么多钱开会员",
                "想给自己的字幕制作省点力气",
                "给我3分钟解决你的字幕难题",
            ],
        )
        self.assertEqual(
            [(segment["start"], segment["end"]) for segment in segments],
            [(160, 1680), (1840, 3760), (3840, 5920), (6160, 8080)],
        )

    def test_qwen_audio_natural_split_uses_phrase_boundaries(self) -> None:
        word_texts = [
            "受", "够了", "AI", "识别", "的", "劣质", "字幕",
            "又不", "想", "花", "那么多", "钱", "开", "会员",
            "想", "给自己的", "字幕", "制作", "省", "点", "力气",
            "给我", "3", "分钟", "解决", "你的", "字幕", "难题",
        ]
        items = [
            {"text": text, "start": index * 100, "end": (index + 1) * 100}
            for index, text in enumerate(word_texts)
        ]

        segments = build_segments_from_api_sentences(
            [{
                "start": 0,
                "end": len(word_texts) * 100,
                "text": "".join(word_texts),
                "items": items,
            }],
            max_len=21,
            min_len=5,
            gap_split_ms=1500,
        )

        self.assertEqual(
            [segment["text"] for segment in segments],
            [
                "受够了AI识别的劣质字幕",
                "又不想花那么多钱开会员",
                "想给自己的字幕制作省点力气",
                "给我3分钟解决你的字幕难题",
            ],
        )
        self.assertTrue(all(len(segment["text"]) <= 21 for segment in segments))

    def test_qwen_audio_ignores_whitespace_only_sentences(self) -> None:
        segments = build_segments_from_api_sentences(
            [
                {
                    "start": 100,
                    "end": 110,
                    "text": " ",
                    "items": [{"start": 100, "end": 110, "text": " "}],
                },
                {
                    "start": 200,
                    "end": 800,
                    "text": "有效字幕",
                    "items": [{"start": 200, "end": 800, "text": "有效字幕"}],
                },
            ],
            max_len=21,
            min_len=5,
            gap_split_ms=1500,
        )

        self.assertEqual([segment["text"] for segment in segments], ["有效字幕"])
        self.assertEqual((segments[0]["start"], segments[0]["end"]), (200, 800))

    def test_build_segments_keeps_valid_item_range_when_another_item_is_invalid(self) -> None:
        segments = build_segments_from_api_sentences(
            [{
                "text": "保留有效范围",
                "items": [
                    {"text": "保留", "start": 100, "end": 300},
                    {"text": "有效", "start": 300},
                ],
            }],
            max_len=21,
            min_len=5,
            gap_split_ms=800,
        )

        self.assertEqual(segments, [{
            "start": 100,
            "end": 300,
            "text": "保留有效范围",
        }])


if __name__ == "__main__":
    _ = unittest.main()
