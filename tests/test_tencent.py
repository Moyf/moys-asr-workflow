from __future__ import annotations

import base64
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from maw.tencent import build_tc3_headers, parse_result, poll_task, submit_task


class TencentProviderTests(unittest.TestCase):
    def test_tc3_headers_use_signed_payload_and_required_scope(self) -> None:
        headers = build_tc3_headers(
            '{"TaskId":1}', action="DescribeTaskStatus", secret_id="id", secret_key="key",
            region="ap-guangzhou", timestamp=1_700_000_000,
        )

        self.assertTrue(headers["Authorization"].startswith("TC3-HMAC-SHA256 Credential=id/"))
        self.assertIn("SignedHeaders=content-type;host", headers["Authorization"])
        self.assertEqual(headers["X-TC-Action"], "DescribeTaskStatus")

    def test_parse_result_maps_sentence_and_word_milliseconds(self) -> None:
        result = parse_result({
            "ResultDetail": [{
                "FinalSentence": "你好。",
                "StartMs": 10,
                "EndMs": 800,
                "SpeakerId": 2,
                "Words": [
                    {"Word": "你", "OffsetStartMs": 10, "OffsetEndMs": 300},
                    {"Word": "好。", "OffsetStartMs": 300, "OffsetEndMs": 800},
                ],
            }],
        })

        self.assertEqual(result["text"], "你好。")
        self.assertEqual(result["items"], [
            {"text": "你", "start": 10, "end": 300, "speaker": "2"},
            {"text": "好。", "start": 300, "end": 800, "speaker": "2"},
        ])
        self.assertEqual(result["sentences"][0]["speaker"], "2")

    def test_submit_task_uses_base64_for_small_local_audio(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            audio = Path(temp_dir) / "clip.wav"
            audio.write_bytes(b"wav")
            config = {
                "secret_id": "id", "secret_key": "key", "app_id": "app",
                "region": "ap-guangzhou", "engine": "16k_zh_en_2.0",
            }
            with mock.patch("maw.tencent._request", return_value={"Response": {"Data": {"TaskId": 7}}}) as request:
                self.assertEqual(submit_task(str(audio), config), 7)

            payload = request.call_args.args[1]
            self.assertEqual(payload["SourceType"], 1)
            self.assertEqual(base64.b64decode(payload["Data"]), b"wav")

    def test_poll_task_reads_success_from_response_data(self) -> None:
        config = {"poll_timeout": 1, "poll_interval": 1}
        response = {
            "Response": {
                "Data": {
                    "Status": 2,
                    "StatusStr": "success",
                    "ResultDetail": [],
                }
            }
        }
        with mock.patch("maw.tencent._request", return_value=response):
            result = poll_task(7, config, on_status=lambda _message: None)
        self.assertEqual(result, response["Response"]["Data"])

    def test_poll_task_raises_for_failure_from_response_data(self) -> None:
        config = {"poll_timeout": 1, "poll_interval": 1}
        response = {
            "Response": {
                "Data": {
                    "Status": 3,
                    "StatusStr": "failed",
                    "ErrorMsg": "bad audio",
                }
            }
        }
        with mock.patch("maw.tencent._request", return_value=response):
            with self.assertRaisesRegex(RuntimeError, "bad audio"):
                poll_task(7, config, on_status=lambda _message: None)

    def test_poll_task_times_out_when_status_never_completes(self) -> None:
        config = {"poll_timeout": 1, "poll_interval": 1}
        response = {"Response": {"Data": {"Status": 0, "StatusStr": "wait"}}}
        with (
            mock.patch("maw.tencent._request", return_value=response),
            mock.patch("maw.tencent.time.monotonic", side_effect=[0, 2]),
        ):
            with self.assertRaisesRegex(TimeoutError, "task_id=7"):
                poll_task(7, config, on_status=lambda _message: None)


if __name__ == "__main__":
    unittest.main()
