from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock


from generate_subtitle_openai_api import (
    DEFAULT_BASE_URL,
    DEFAULT_MODEL,
    normalize_base_url,
    parse_timestamped_response,
    request_transcription,
    transcription_url,
)


class OpenAiAsrTests(unittest.TestCase):
    def test_official_openai_defaults(self) -> None:
        self.assertEqual(DEFAULT_BASE_URL, "https://api.openai.com/v1")
        self.assertEqual(DEFAULT_MODEL, "gpt-4o-transcribe")
        self.assertEqual(normalize_base_url(""), DEFAULT_BASE_URL)

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
        self.assertEqual(result["items"][0]["start"], 100)
        self.assertEqual(result["items"][1]["end"], 1200)

    def test_parse_timestamped_segments_without_words(self) -> None:
        result = parse_timestamped_response({
            "text": "hello",
            "segments": [{"start": 0, "end": 2.5, "text": "hello"}],
        })

        self.assertEqual(result["segments"], [{"start": 0, "end": 2500, "text": "hello", "items": []}])

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
