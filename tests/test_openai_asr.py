from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


from generate_subtitle_openai_api import (
    DEFAULT_BASE_URL,
    DEFAULT_MODEL,
    _segments_from_result,
    load_cli_config,
    normalize_base_url,
    parse_timestamped_response,
    request_transcription,
    _strip_trailing_punct,
    transcription_url,
)


class OpenAiAsrTests(unittest.TestCase):
    def test_generator_accepts_shared_debug_flag(self) -> None:
        result = subprocess.run(
            [sys.executable, str(Path(__file__).parents[1] / "generate_subtitle_openai_api.py"), "--help"],
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0)
        self.assertIn("--debug", result.stdout)

    def test_official_openai_defaults(self) -> None:
        self.assertEqual(DEFAULT_BASE_URL, "https://api.openai.com/v1")
        self.assertEqual(DEFAULT_MODEL, "whisper-1")
        self.assertEqual(normalize_base_url(""), DEFAULT_BASE_URL)

    def test_cli_config_reads_dotenv_and_process_environment_wins(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            env_path = Path(temp_dir) / ".env"
            env_path.write_text(
                "MAW_OPENAI_ASR_API_KEY=file-key\n"
                "MAW_OPENAI_ASR_BASE_URL=https://file.test/v1\n"
                "MAW_OPENAI_ASR_MODEL=file-model\n"
                "FFMPEG_PATH=/file/ffmpeg\n",
                encoding="utf-8",
            )

            config = load_cli_config(
                env_path,
                {"MAW_OPENAI_ASR_API_KEY": "process-key"},
            )

        self.assertEqual(config["api_key"], "process-key")
        self.assertEqual(config["base_url"], "https://file.test/v1")
        self.assertEqual(config["model"], "file-model")
        self.assertEqual(config["ffmpeg_path"], "/file/ffmpeg")

    def test_normalize_base_url_accepts_root_v1_and_endpoint_urls(self) -> None:
        self.assertEqual(normalize_base_url("https://example.test"), "https://example.test/v1")
        self.assertEqual(normalize_base_url("https://example.test/v1/"), "https://example.test/v1")
        self.assertEqual(
            normalize_base_url("https://example.test/v1/audio/transcriptions"),
            "https://example.test/v1",
        )
        self.assertEqual(
            transcription_url("https://example.test/v1"),
            "https://example.test/v1/audio/transcriptions",
        )

    def test_parse_timestamped_words(self) -> None:
        result = parse_timestamped_response({
            "text": "你好世界",
            "language": "zh",
            "segments": [{
                "start": 0.1,
                "end": 1.2,
                "text": "你好世界",
                "words": [
                    {"word": "你好", "start": 0.1, "end": 0.6},
                    {"word": "世界", "start": 0.7, "end": 1.2},
                ],
            }],
        })

        self.assertEqual(result["language"], "zh")
        self.assertEqual(result["timestamp_granularity"], "word")
        self.assertEqual(result["items"][0]["start"], 100)
        self.assertEqual(result["items"][1]["end"], 1200)

    def test_western_words_keep_spaces_in_generated_segments(self) -> None:
        result = parse_timestamped_response({
            "text": "The beach was quiet.",
            "language": "English",
            "words": [
                {"word": "The", "start": 0.0, "end": 0.2},
                {"word": "beach", "start": 0.2, "end": 0.5},
                {"word": "was", "start": 0.5, "end": 0.7},
                {"word": "quiet.", "start": 0.7, "end": 1.0},
            ],
        })

        self.assertEqual(result["language"], "en")
        self.assertEqual(result["timestamp_granularity"], "word")
        segments = _segments_from_result(result, max_len=18, min_len=3, gap_split=800)

        self.assertEqual(segments[0]["text"], "The beach was quiet.")
        self.assertEqual([item["text"] for item in segments[0]["items"]], ["The", " beach", " was", " quiet."])

    def test_parse_timestamped_segments_without_words(self) -> None:
        result = parse_timestamped_response({
            "text": "hello",
            "segments": [{"start": 0, "end": 2.5, "text": "hello"}],
        })

        self.assertEqual(result["segments"], [{"start": 0, "end": 2500, "text": "hello"}])
        self.assertEqual(result["timestamp_granularity"], "segment")

    def test_parse_timestamped_long_seconds_and_explicit_milliseconds(self) -> None:
        result = parse_timestamped_response({
            "segments": [
                {"start": 10_799.5, "end": 10_800, "text": "last seconds"},
                {"start_ms": 10_800_000, "end_ms": 10_800_500, "text": "explicit ms"},
            ],
        })

        self.assertEqual(
            result["segments"],
            [
                {"start": 10_799_500, "end": 10_800_000, "text": "last seconds"},
                {"start": 10_800_000, "end": 10_800_500, "text": "explicit ms"},
            ],
        )
        self.assertEqual(result["timestamp_granularity"], "segment")

    def test_parse_timestamped_mixed_segments_preserves_sentence_fallback(self) -> None:
        result = parse_timestamped_response({
            "text": "Hello world. Fallback sentence.",
            "segments": [
                {
                    "start": 0,
                    "end": 1,
                    "text": "Hello world.",
                    "words": [
                        {"word": "Hello", "start": 0, "end": 0.4},
                        {"word": "world.", "start": 0.4, "end": 1},
                    ],
                },
                {"start": 1.2, "end": 2, "text": "Fallback sentence."},
            ],
        })

        self.assertEqual(result["timestamp_granularity"], "segment")
        self.assertEqual(len(result["items"]), 2)
        self.assertEqual(result["segments"][0]["items"], result["items"])
        self.assertNotIn("items", result["segments"][1])
        self.assertEqual(
            [segment["text"] for segment in _segments_from_result(
                result, max_len=18, min_len=3, gap_split=800,
            )],
            ["Hello world.", "Fallback sentence."],
        )

    def test_parse_timestamped_segment_range_contains_nested_words(self) -> None:
        result = parse_timestamped_response({
            "text": "范围修复 后续回退",
            "segments": [
                {
                    "start": 0.2,
                    "end": 0.7,
                    "text": "范围修复",
                    "words": [
                        {"word": "范围", "start": 0.1, "end": 0.4},
                        {"word": "修复", "start": 0.4, "end": 0.9},
                    ],
                },
                {"start": 1.0, "end": 1.2, "text": "后续回退"},
            ],
        })

        sentence = result["segments"][0]
        self.assertEqual((sentence["start"], sentence["end"]), (100, 900))
        self.assertTrue(
            all(sentence["start"] <= item["start"] < item["end"] <= sentence["end"]
                for item in sentence["items"])
        )

    def test_parse_timestamped_invalid_top_level_word_uses_valid_envelope(self) -> None:
        result = parse_timestamped_response({
            "text": "The missing word",
            "words": [
                {"word": "The", "start": 0, "end": 0.3},
                {"word": "missing", "start": 0.3, "end": 0.3},
                {"word": "word", "start": 0.6, "end": 0.9},
            ],
        })

        self.assertEqual(result["items"], [])
        self.assertEqual(result["segments"], [{
            "start": 0,
            "end": 900,
            "text": "The missing word",
        }])
        self.assertEqual(result["timestamp_granularity"], "segment")

    def test_parse_timestamped_unranged_mixed_segment_preserves_all_text(self) -> None:
        result = parse_timestamped_response({
            "text": "The timed word The unranged sentence",
            "segments": [
                {
                    "start": 0,
                    "end": 1,
                    "text": "The timed word",
                    "words": [{"word": "The", "start": 0, "end": 1}],
                },
                {"text": "The unranged sentence"},
            ],
        })

        self.assertEqual(result["text"], "The timed word The unranged sentence")
        self.assertEqual(result["items"], [])
        self.assertEqual(result["segments"], [{
            "start": 0,
            "end": 1000,
            "text": "The timed word The unranged sentence",
        }])
        self.assertEqual(result["timestamp_granularity"], "segment")

    def test_parse_timestamped_response_derives_missing_top_level_text(self) -> None:
        result = parse_timestamped_response({
            "words": [
                {"word": "The", "start": 0, "end": 0.2},
                {"word": "beach", "start": 0.2, "end": 0.5},
            ],
        })

        self.assertEqual(result["text"], "The beach")

    def test_parse_timestamped_response_derives_all_sentence_text_when_top_level_text_is_missing(self) -> None:
        result = parse_timestamped_response({
            "segments": [
                {
                    "start": 0,
                    "end": 1,
                    "text": "Hello world.",
                    "words": [
                        {"word": "Hello", "start": 0, "end": 0.4},
                        {"word": "world.", "start": 0.4, "end": 1},
                    ],
                },
                {"start": 1.2, "end": 2, "text": "Fallback sentence."},
            ],
        })

        self.assertEqual(result["text"], "Hello world. Fallback sentence.")

    def test_strip_trailing_punct_removes_punctuation_only_items(self) -> None:
        segments = [{
            "start": 0,
            "end": 1000,
            "text": "你好。",
            "items": [
                {"text": "你好", "start": 0, "end": 900},
                {"text": "。", "start": 900, "end": 1000},
            ],
        }]

        _strip_trailing_punct(segments, "，。")

        self.assertEqual(segments[0]["text"], "你好")
        self.assertEqual(segments[0]["items"], [{"text": "你好", "start": 0, "end": 900}])

    def test_parse_text_only_response_is_rejected(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "没有返回 segments/words 时间戳"):
            parse_timestamped_response({"text": "只有文本"})

    def test_request_transcription_keeps_raw_response_for_debugging(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            audio_path = Path(temp_dir) / "clip.wav"
            audio_path.write_bytes(b"audio")
            response_body = {
                "text": "hello",
                "segments": [{"start": 0, "end": 1, "text": "hello"}],
            }
            response = mock.Mock(ok=True)
            response.json.return_value = response_body

            with mock.patch("generate_subtitle_openai_api.requests.post", return_value=response) as post:
                result = request_transcription(
                    audio_path,
                    base_url="https://relay.test",
                    api_key="sk-test",
                    model="test-asr",
                    language="en",
                )

            self.assertEqual(result["_raw_response"], response_body)
            self.assertEqual(post.call_args.args[0], "https://relay.test/v1/audio/transcriptions")
            data = post.call_args.kwargs["data"]
            self.assertIn(("response_format", "verbose_json"), data)
            self.assertEqual(
                [value for key, value in data if key == "timestamp_granularities[]"],
                ["segment", "word"],
            )
            self.assertEqual(post.call_args.kwargs["headers"]["Authorization"], "Bearer sk-test")


if __name__ == "__main__":
    unittest.main()
