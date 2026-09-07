from __future__ import annotations

import base64
import io
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from maw.speaker import apply_speaker_colors
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
        self.assertEqual(result["timestamp_granularity"], "char")
        self.assertEqual(result["sentences"][0]["speaker"], "2")

    def test_parse_result_derives_word_granularity_for_latin_text(self) -> None:
        result = parse_result({
            "ResultDetail": [{
                "FinalSentence": "hello world",
                "StartMs": 0,
                "EndMs": 800,
                "Words": [
                    {"Word": "hello", "OffsetStartMs": 0, "OffsetEndMs": 400},
                    {"Word": " world", "OffsetStartMs": 400, "OffsetEndMs": 800},
                ],
            }],
        })

        self.assertEqual(result["timestamp_granularity"], "word")

    def test_parse_result_marks_non_mapping_word_as_sentence_fallback(self) -> None:
        result = parse_result({
            "ResultDetail": [{
                "FinalSentence": "整句回退",
                "StartMs": 100,
                "EndMs": 900,
                "Words": [
                    {"Word": "整句", "OffsetStartMs": 100, "OffsetEndMs": 500},
                    "malformed-word",
                    {"Word": "回退", "OffsetStartMs": 500, "OffsetEndMs": 900},
                ],
            }],
        })

        self.assertEqual(result["items"], [])
        self.assertEqual(result["timestamp_granularity"], "segment")
        self.assertEqual(result["sentences"], [{
            "start": 100,
            "end": 900,
            "text": "整句回退",
        }])

    def test_parse_result_expands_sentence_range_to_contain_word_items(self) -> None:
        result = parse_result({
            "ResultDetail": [{
                "FinalSentence": "范围修复",
                "StartMs": 200,
                "EndMs": 700,
                "Words": [
                    {"Word": "范围", "OffsetStartMs": 100, "OffsetEndMs": 400},
                    {"Word": "修复", "OffsetStartMs": 400, "OffsetEndMs": 900},
                ],
            }],
        })

        sentence = result["sentences"][0]
        self.assertEqual((sentence["start"], sentence["end"]), (100, 900))
        self.assertTrue(
            all(sentence["start"] <= item["start"] < item["end"] <= sentence["end"]
                for item in sentence["items"])
        )

    def test_parse_result_does_not_drop_unranged_mixed_sentence(self) -> None:
        result = parse_result({
            "ResultDetail": [
                {
                    "FinalSentence": "有时间码",
                    "StartMs": 0,
                    "EndMs": 600,
                    "Words": [
                        {"Word": "有", "OffsetStartMs": 0, "OffsetEndMs": 300},
                        {"Word": "时间码", "OffsetStartMs": 300, "OffsetEndMs": 600},
                    ],
                },
                {"FinalSentence": "没有可用范围", "Words": [{"Word": "没有"}]},
            ],
        })

        self.assertEqual(result["text"], "有时间码没有可用范围")
        self.assertEqual(result["items"], [])
        self.assertEqual(result["sentences"], [])
        self.assertEqual(result["timestamp_granularity"], "unknown")

    def test_submit_task_uses_base64_for_small_local_audio(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            audio = Path(temp_dir) / "clip.wav"
            audio.write_bytes(b"wav")
            config = {
                "secret_id": "id", "secret_key": "key", "app_id": "app",
                "region": "ap-guangzhou", "engine": "16k_zh_en_2.0",
            }
            with mock.patch("maw.tencent._request", return_value={"Response": {"Data": {"TaskId": 7}}}) as request:
                self.assertEqual(submit_task(str(audio), config, speaker_diarization=True), 7)

            payload = request.call_args.args[1]
            self.assertEqual(payload["SourceType"], 1)
            self.assertEqual(payload["SpeakerDiarization"], 1)
            self.assertEqual(base64.b64decode(payload["Data"]), b"wav")

    def test_submit_task_rejects_missing_data_without_attribute_error(self) -> None:
        config = {
            "secret_id": "id", "secret_key": "key", "app_id": "app",
            "region": "ap-guangzhou", "engine": "16k_zh_en_2.0",
        }
        with mock.patch("maw.tencent._request", return_value={"Response": {"Data": None}}):
            with self.assertRaisesRegex(RuntimeError, "TaskId"):
                submit_task("", config, "https://example.test/audio.wav")

    def test_apply_speaker_colors_writes_snapshot_for_tencent_segments(self) -> None:
        segments = [
            {"start": 0, "end": 100, "text": "甲", "speaker": "1", "items": []},
            {"start": 100, "end": 200, "text": "乙", "speaker": "2", "items": []},
            {"start": 200, "end": 300, "text": "甲", "speaker": "1", "items": []},
        ]

        summary = apply_speaker_colors(segments)

        self.assertEqual(summary["speakers"], ["1", "2"])
        self.assertEqual(segments[0]["color"]["name"], "yellow")
        self.assertEqual(segments[1]["color"]["name"], "green")
        self.assertEqual(segments[2]["color"]["name"], "yellow")

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


class TencentCliOutputNamingTests(unittest.TestCase):
    """腾讯云 CLI：默认名不注入段；MAW_STAT/debug-raw。"""

    def _run(self, extra_args, *, debug_raw=False, explicit_output=None):
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            media = root / "20-走廊.mp3"
            media.write_bytes(b"media")
            result = {"text": "测试", "language": "zh"}
            if debug_raw:
                result["_raw_response"] = {"Result": []}
            argv = ["generate_subtitle_tencent_api.py", str(media)]
            if explicit_output is not None:
                argv += ["-o", str(explicit_output)]
            argv += extra_args
            stdout = io.StringIO()
            stderr = io.StringIO()
            values = [1000.0, 1123.0]

            def fake_perf():
                return values.pop(0) if values else 0.0

            config = {"secret_id": "id", "secret_key": "key", "engine": "16k_zh"}
            with mock.patch("sys.argv", argv), \
                 mock.patch("generate_subtitle_tencent_api.load_config", return_value=config), \
                 mock.patch(
                     "generate_subtitle_tencent_api.resolve_ffmpeg_tools",
                     return_value=SimpleNamespace(ffmpeg="ffmpeg", ffprobe="ffprobe"),
                 ), \
                 mock.patch("generate_subtitle_tencent_api.get_duration_sec", return_value=1000.0), \
                 mock.patch("generate_subtitle_tencent_api.shutil.copy2"), \
                 mock.patch("generate_subtitle_tencent_api.transcribe", return_value=result), \
                 mock.patch("generate_subtitle_tencent_api.time.perf_counter", side_effect=fake_perf), \
                 redirect_stdout(stdout), redirect_stderr(stderr):
                from generate_subtitle_tencent_api import main

                code = main()
                names = sorted(path.name for path in root.glob("*.srt"))
            self.assertEqual(code, 0)
            return names, stdout.getvalue()

    @staticmethod
    def _stat_line(stdout):
        for line in stdout.splitlines():
            if line.startswith("MAW_STAT rtf="):
                return line
        return None

    def test_default_name_stays_plain_and_stat_is_emitted(self) -> None:
        names, stdout = self._run([])

        self.assertEqual(names, ["20-走廊.srt"])
        self.assertEqual(self._stat_line(stdout), "MAW_STAT rtf=0.123")

    def test_debug_raw_default_goes_into_maw_dir(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            media = root / "20-走廊.mp3"
            media.write_bytes(b"media")
            result = {"text": "测试", "language": "zh", "_raw_response": {"Result": []}}
            stdout = io.StringIO()
            stderr = io.StringIO()
            values = [1000.0, 1123.0]

            def fake_perf():
                return values.pop(0) if values else 0.0

            config = {"secret_id": "id", "secret_key": "key", "engine": "16k_zh"}
            with mock.patch(
                "sys.argv", ["generate_subtitle_tencent_api.py", str(media), "--debug-raw"]
            ), mock.patch("generate_subtitle_tencent_api.load_config", return_value=config), \
                 mock.patch(
                     "generate_subtitle_tencent_api.resolve_ffmpeg_tools",
                     return_value=SimpleNamespace(ffmpeg="ffmpeg", ffprobe="ffprobe"),
                 ), \
                 mock.patch("generate_subtitle_tencent_api.get_duration_sec", return_value=1000.0), \
                 mock.patch("generate_subtitle_tencent_api.shutil.copy2"), \
                 mock.patch("generate_subtitle_tencent_api.transcribe", return_value=result), \
                 mock.patch("generate_subtitle_tencent_api.time.perf_counter", side_effect=fake_perf), \
                 mock.patch("maw.output_naming.subfolder_prefs", return_value=(False, False)), \
                 redirect_stdout(stdout), redirect_stderr(stderr):
                from generate_subtitle_tencent_api import main

                self.assertEqual(main(), 0)

            maw_dir = root / "_maw"
            raw_files = sorted(maw_dir.glob("*.asr-response.json")) if maw_dir.exists() else []
            self.assertEqual(len(raw_files), 1)
            self.assertIn(".asr-response.json", raw_files[0].name)


if __name__ == "__main__":
    unittest.main()
