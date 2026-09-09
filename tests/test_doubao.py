from __future__ import annotations

import base64
import io
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from maw.doubao import (
    MAX_INLINE_BYTES,
    build_headers,
    build_hotwords_context,
    build_submit_payload,
    build_segments,
    doubao_language_code,
    load_config,
    parse_result,
    poll_task,
    query_task,
    submit_task,
    transcribe,
)


def _fake_response(*, status_code: str, logid: str = "", text: str = "", body: dict | None = None):
    headers = {"X-Api-Status-Code": status_code, "X-Api-Message": "OK"}
    if logid:
        headers["X-Tt-Logid"] = logid
    return SimpleNamespace(headers=headers, text=text, json=lambda: body if body is not None else {})


class DoubaoConfigTests(unittest.TestCase):
    def test_load_config_defaults(self) -> None:
        with mock.patch.dict("os.environ", {}, clear=True), \
             mock.patch("maw.doubao._load_env_file", return_value={}):
            config = load_config()

        self.assertEqual(config["api_key"], "")
        self.assertEqual(config["resource_id"], "volc.seedasr.auc")
        self.assertEqual(config["poll_interval"], 3)
        self.assertEqual(config["poll_timeout"], 1800)

    def test_load_config_prefers_environment_over_env_file(self) -> None:
        with mock.patch.dict("os.environ", {"VOLC_API_KEY": "env-key"}), \
             mock.patch("maw.doubao._load_env_file", return_value={"VOLC_API_KEY": "file-key"}):
            config = load_config()

        self.assertEqual(config["api_key"], "env-key")

    def test_doubao_language_code_mapping(self) -> None:
        self.assertEqual(doubao_language_code("en"), "en-US")
        self.assertEqual(doubao_language_code("FIL"), "fil-PH")
        # 中文/粤语由豆包自动识别，不传显式 language
        self.assertIsNone(doubao_language_code("zh"))
        self.assertIsNone(doubao_language_code("yue"))
        self.assertIsNone(doubao_language_code(""))
        self.assertIsNone(doubao_language_code(None))

    def test_build_headers_carries_key_resource_and_task(self) -> None:
        headers = build_headers(
            "key-1", "volc.seedasr.auc", "task-1",
            sequence="-1", logid="log-1",
        )

        self.assertEqual(headers["X-Api-Key"], "key-1")
        self.assertEqual(headers["X-Api-Resource-Id"], "volc.seedasr.auc")
        self.assertEqual(headers["X-Api-Request-Id"], "task-1")
        self.assertEqual(headers["X-Api-Sequence"], "-1")
        self.assertEqual(headers["X-Tt-Logid"], "log-1")

    def test_build_hotwords_context_dedupes_and_strips(self) -> None:
        context = build_hotwords_context([" 热词A ", "热词B", "热词A", ""])

        self.assertIsNotNone(context)
        self.assertEqual(
            context,
            '{"hotwords": [{"word": "热词A"}, {"word": "热词B"}]}',
        )
        self.assertIsNone(build_hotwords_context([]))
        self.assertIsNone(build_hotwords_context(None))

    def test_build_submit_payload_uses_base64_and_bigmodel_request(self) -> None:
        payload = build_submit_payload(
            "YWJj",
            language="en",
            enable_speaker=True,
            hotwords=["热词A"],
        )

        self.assertEqual(payload["user"], {"uid": "maw"})
        self.assertEqual(
            payload["audio"],
            {"data": "YWJj", "format": "ogg", "codec": "opus", "language": "en-US"},
        )
        request = payload["request"]
        self.assertEqual(request["model_name"], "bigmodel")
        self.assertTrue(request["enable_itn"])
        self.assertTrue(request["enable_punc"])
        self.assertTrue(request["show_utterances"])
        self.assertTrue(request["enable_speaker_info"])
        self.assertEqual(
            request["corpus"],
            {"context": '{"hotwords": [{"word": "热词A"}]}'},
        )

    def test_build_submit_payload_omits_optionals_when_unset(self) -> None:
        payload = build_submit_payload("YWJj", audio_codec=None, language="zh")

        self.assertNotIn("codec", payload["audio"])
        self.assertNotIn("language", payload["audio"])
        self.assertNotIn("enable_speaker_info", payload["request"])
        self.assertNotIn("corpus", payload["request"])


class DoubaoApiTests(unittest.TestCase):
    def test_submit_task_returns_task_id_and_logid(self) -> None:
        response = _fake_response(status_code="20000000", logid="log-9")
        with mock.patch("maw.doubao.requests.post", return_value=response) as post, \
             mock.patch("maw.doubao.uuid.uuid4", return_value="fixed-uuid"):
            task_id, logid = submit_task(
                "key-1", {"request": {}}, resource_id="volc.seedasr.auc",
            )

        self.assertEqual((task_id, logid), ("fixed-uuid", "log-9"))
        self.assertEqual(post.call_args.kwargs["headers"]["X-Api-Request-Id"], "fixed-uuid")
        self.assertEqual(post.call_args.kwargs["headers"]["X-Api-Sequence"], "-1")

    def test_submit_task_raises_with_status_and_message_on_failure(self) -> None:
        response = _fake_response(status_code="45000001", text="bad request")
        with mock.patch("maw.doubao.requests.post", return_value=response), \
             mock.patch("maw.doubao.uuid.uuid4", return_value="fixed-uuid"):
            with self.assertRaisesRegex(RuntimeError, "45000001"):
                submit_task("key-1", {})

    def test_query_task_parses_body_and_headers(self) -> None:
        response = _fake_response(
            status_code="20000000",
            text='{"result": {"text": "你好"}}',
            body={"result": {"text": "你好"}},
        )
        with mock.patch("maw.doubao.requests.post", return_value=response) as post:
            status, message, body = query_task(
                "key-1", "volc.seedasr.auc", "task-1", logid="log-1",
            )

        self.assertEqual(status, "20000000")
        self.assertEqual(message, "OK")
        self.assertEqual(body, {"result": {"text": "你好"}})
        headers = post.call_args.kwargs["headers"]
        self.assertEqual(headers["X-Api-Request-Id"], "task-1")
        self.assertEqual(headers["X-Tt-Logid"], "log-1")
        self.assertNotIn("X-Api-Sequence", headers)

    def test_poll_task_waits_through_processing_statuses(self) -> None:
        bodies = [
            ("20000002", "queued", {}),
            ("20000001", "processing", {}),
            ("20000000", "OK", {"result": {"text": "你好"}}),
        ]
        with mock.patch("maw.doubao.query_task", side_effect=bodies), \
             mock.patch("maw.doubao.time.sleep") as sleep:
            body = poll_task(
                "key-1", "volc.seedasr.auc", "task-1",
                interval=3, timeout=60, on_status=lambda _message: None,
            )

        self.assertEqual(body, {"result": {"text": "你好"}})
        self.assertEqual(sleep.call_count, 2)

    def test_poll_task_raises_for_silent_audio(self) -> None:
        with mock.patch(
            "maw.doubao.query_task",
            return_value=("20000003", "silent", {}),
        ), mock.patch("maw.doubao.time.sleep"):
            with self.assertRaisesRegex(RuntimeError, "静音"):
                poll_task(
                    "key-1", "volc.seedasr.auc", "task-1",
                    interval=3, timeout=60, on_status=lambda _message: None,
                )

    def test_poll_task_raises_for_terminal_failure(self) -> None:
        with mock.patch(
            "maw.doubao.query_task",
            return_value=("45000151", "bad format", {}),
        ), mock.patch("maw.doubao.time.sleep"):
            with self.assertRaisesRegex(RuntimeError, "45000151"):
                poll_task(
                    "key-1", "volc.seedasr.auc", "task-1",
                    interval=3, timeout=60, on_status=lambda _message: None,
                )

    def test_poll_task_times_out_when_status_never_completes(self) -> None:
        with (
            mock.patch("maw.doubao.query_task", return_value=("20000001", "processing", {})),
            mock.patch("maw.doubao.time.sleep"),
            mock.patch("maw.doubao.time.monotonic", side_effect=[0, 0, 10]),
        ):
            with self.assertRaisesRegex(TimeoutError, "task_id=task-1"):
                poll_task(
                    "key-1", "volc.seedasr.auc", "task-1",
                    interval=3, timeout=5, on_status=lambda _message: None,
                )


class DoubaoParseTests(unittest.TestCase):
    def test_parse_result_maps_utterance_words_to_items(self) -> None:
        result = parse_result({
            "audio_info": {"duration": 3696},
            "result": {
                "text": "这是字节跳动，今日头条母公司。",
                "utterances": [
                    {
                        "definite": True,
                        "start_time": 0,
                        "end_time": 1705,
                        "text": "这是字节跳动，",
                        "additions": {"speaker": "1"},
                        "words": [
                            {"text": "这", "start_time": 740, "end_time": 860},
                            {"text": "是", "start_time": 860, "end_time": 1020},
                            {"text": "字节跳动", "start_time": 1020, "end_time": 1705},
                        ],
                    },
                    {
                        "definite": True,
                        "start_time": 2110,
                        "end_time": 3696,
                        "text": "今日头条母公司。",
                        "additions": {"speaker": "1"},
                        "words": [
                            {"text": "今日头条", "start_time": 2110, "end_time": 3070},
                            {"text": "母公司", "start_time": 3070, "end_time": 3696},
                        ],
                    },
                ],
            },
        })

        self.assertEqual(result["text"], "这是字节跳动，今日头条母公司。")
        # 标点只出现在句文本里、words 没有，覆盖率校验必须忽略标点
        self.assertEqual(result["items"], [
            {"text": "这", "start": 740, "end": 860, "speaker": "1"},
            {"text": "是", "start": 860, "end": 1020, "speaker": "1"},
            {"text": "字节跳动", "start": 1020, "end": 1705, "speaker": "1"},
            {"text": "今日头条", "start": 2110, "end": 3070, "speaker": "1"},
            {"text": "母公司", "start": 3070, "end": 3696, "speaker": "1"},
        ])
        self.assertEqual(result["segments"], [])
        self.assertEqual(result["timestamp_granularity"], "char")

    def test_parse_result_reads_speaker_id_fallback(self) -> None:
        result = parse_result({
            "result": {
                "text": "你好。",
                "utterances": [{
                    "start_time": 10,
                    "end_time": 800,
                    "text": "你好。",
                    "speaker_id": "3",
                    "words": [
                        {"text": "你", "start_time": 10, "end_time": 400},
                        {"text": "好", "start_time": 400, "end_time": 800},
                    ],
                }],
            },
        })

        self.assertTrue(all(item["speaker"] == "3" for item in result["items"]))
        self.assertEqual(result["segments"], [])
        self.assertEqual(result["timestamp_granularity"], "char")

    def test_parse_result_restores_word_spaces_from_whitespace_tokens(self) -> None:
        # 真机响应（2026-09，volc.seedasr.auc）：英文词间为时间码 -1 的空白 token
        result = parse_result({
            "result": {
                "text": "Hello, this is a smoke test.",
                "utterances": [{
                    "start_time": 160,
                    "end_time": 4520,
                    "text": "Hello, this is a smoke test.",
                    "words": [
                        {"text": "Hello", "start_time": 160, "end_time": 480},
                        {"text": " ", "start_time": -1, "end_time": -1},
                        {"text": "this", "start_time": 920, "end_time": 1160},
                        {"text": " ", "start_time": -1, "end_time": -1},
                        {"text": "is", "start_time": 1160, "end_time": 1360},
                        {"text": " ", "start_time": -1, "end_time": -1},
                        {"text": "a", "start_time": 1360, "end_time": 1600},
                        {"text": " ", "start_time": -1, "end_time": -1},
                        {"text": "smoke", "start_time": 1680, "end_time": 2000},
                        {"text": " ", "start_time": -1, "end_time": -1},
                        {"text": "test", "start_time": 4080, "end_time": 4520},
                    ],
                }],
            },
        })

        self.assertEqual(
            [item["text"] for item in result["items"]],
            ["Hello", " this", " is", " a", " smoke", " test"],
        )
        self.assertEqual(result["segments"], [])
        self.assertEqual(result["timestamp_granularity"], "word")

    def test_parse_result_falls_back_to_sentence_cues_on_invalid_word(self) -> None:
        result = parse_result({
            "result": {
                "text": "整句回退。",
                "utterances": [{
                    "start_time": 100,
                    "end_time": 900,
                    "text": "整句回退。",
                    "words": [
                        {"text": "整句", "start_time": 100, "end_time": 500},
                        "malformed-word",
                        {"text": "回退", "start_time": 500, "end_time": 900},
                    ],
                }],
            },
        })

        self.assertEqual(result["items"], [])
        self.assertEqual(result["timestamp_granularity"], "segment")
        self.assertEqual(result["segments"], [{
            "start": 100,
            "end": 900,
            "text": "整句回退。",
        }])

    def test_parse_result_falls_back_when_words_do_not_cover_text(self) -> None:
        result = parse_result({
            "result": {
                "text": "你好世界。",
                "utterances": [{
                    "start_time": 0,
                    "end_time": 800,
                    "text": "你好世界。",
                    "words": [
                        {"text": "你", "start_time": 0, "end_time": 400},
                        {"text": "好", "start_time": 400, "end_time": 800},
                    ],
                }],
            },
        })

        self.assertEqual(result["items"], [])
        self.assertEqual(result["timestamp_granularity"], "segment")
        self.assertEqual(len(result["segments"]), 1)

    def test_parse_result_without_utterances_keeps_text_only(self) -> None:
        result = parse_result({"result": {"text": "仅文本"}})

        self.assertEqual(result["text"], "仅文本")
        self.assertEqual(result["items"], [])
        self.assertEqual(result["segments"], [])
        self.assertEqual(result["timestamp_granularity"], "unknown")

    def test_parse_result_expands_sentence_range_to_contain_word_items(self) -> None:
        result = parse_result({
            "result": {
                "text": "范围修复。",
                "utterances": [{
                    "start_time": 200,
                    "end_time": 700,
                    "text": "范围修复。",
                    "words": [
                        {"text": "范围", "start_time": 100, "end_time": 400},
                        {"text": "修复", "start_time": 400, "end_time": 900},
                    ],
                }],
            },
        })

        self.assertEqual(
            [(item["start"], item["end"]) for item in result["items"]],
            [(100, 400), (400, 900)],
        )


class DoubaoTranscribeTests(unittest.TestCase):
    def test_transcribe_requires_api_key(self) -> None:
        with self.assertRaises(SystemExit):
            transcribe("clip.ogg", {"api_key": ""})

    def test_transcribe_rejects_audio_over_base64_limit(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            audio = Path(temp_dir) / "clip.ogg"
            audio.write_bytes(b"xxxx")
            with mock.patch("maw.doubao.MAX_INLINE_BYTES", 2):
                with self.assertRaisesRegex(SystemExit, "25MB"):
                    transcribe(str(audio), {"api_key": "key"})

    def test_transcribe_submits_base64_and_returns_parsed_result(self) -> None:
        parsed = {
            "text": "你好。",
            "language": "",
            "items": [{"text": "你", "start": 0, "end": 400}],
            "segments": [],
            "timestamp_granularity": "char",
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            audio = Path(temp_dir) / "clip.ogg"
            audio.write_bytes(b"ogg-bytes")
            with mock.patch(
                "maw.doubao.submit_task", return_value=("task-1", "log-1")
            ) as submit, \
                 mock.patch("maw.doubao.poll_task", return_value={"result": {}}) as poll, \
                 mock.patch("maw.doubao.parse_result", return_value=dict(parsed)):
                result = transcribe(
                    str(audio),
                    {"api_key": "key-1", "resource_id": "volc.seedasr.auc",
                     "poll_interval": 3, "poll_timeout": 60},
                    enable_speaker=True,
                    hotwords=["热词A"],
                    capture_raw=True,
                )

        self.assertEqual(result["text"], "你好。")
        self.assertEqual(result["_raw_response"], {"result": {}})
        payload = submit.call_args.args[1]
        self.assertEqual(base64.b64decode(payload["audio"]["data"]), b"ogg-bytes")
        self.assertTrue(payload["request"]["enable_speaker_info"])
        poll.assert_called_once()
        self.assertEqual(poll.call_args.kwargs["logid"], "log-1")
        self.assertEqual(poll.call_args.args[2], "task-1")


class DoubaoSegmentTests(unittest.TestCase):
    def test_build_segments_keeps_speaker_runs(self) -> None:
        segments = build_segments(
            [
                {"text": "甲", "start": 0, "end": 100, "speaker": "1"},
                {"text": "乙", "start": 100, "end": 200, "speaker": "2"},
            ],
            max_len=18, min_len=5, gap_split_ms=800,
        )

        self.assertEqual(segments[0]["speaker"], "1")
        self.assertEqual(segments[-1]["speaker"], "2")

    def test_limit_constants_match_official_base64_contract(self) -> None:
        self.assertEqual(MAX_INLINE_BYTES, 25 * 1024 * 1024)
        from maw.doubao import MAX_AUDIO_SECONDS

        self.assertEqual(MAX_AUDIO_SECONDS, 120 * 60)


class DoubaoCliOutputTests(unittest.TestCase):
    """豆包 CLI：默认名附加 doubao 段；MAW_STAT 与 debug-raw 落盘。"""

    def _run(self, extra_args, *, debug_raw=False):
        debug_raw = debug_raw or "--debug-raw" in extra_args
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            media = root / "20-走廊.mp3"
            media.write_bytes(b"media")
            result = {"text": "测试", "language": "", "items": [], "segments": [],
                      "timestamp_granularity": "segment"}
            if debug_raw:
                result["_raw_response"] = {"result": {}}
            argv = ["generate_subtitle_doubao_api.py", str(media)]
            argv += extra_args
            stdout = io.StringIO()
            stderr = io.StringIO()
            values = [1000.0, 1123.0]

            def fake_perf():
                return values.pop(0) if values else 0.0

            config = {"api_key": "key", "resource_id": "volc.seedasr.auc"}
            with mock.patch("sys.argv", argv), \
                 mock.patch("generate_subtitle_doubao_api.load_config", return_value=config), \
                 mock.patch(
                     "generate_subtitle_doubao_api._resolve_media_tool",
                     side_effect=lambda tool, _path=None: tool,
                 ), \
                 mock.patch("generate_subtitle_doubao_api.get_duration_sec", return_value=1000.0), \
                 mock.patch("generate_subtitle_doubao_api.extract_audio_ogg"), \
                 mock.patch("generate_subtitle_doubao_api.transcribe", return_value=result), \
                 mock.patch("generate_subtitle_doubao_api.time.perf_counter", side_effect=fake_perf), \
                 redirect_stdout(stdout), redirect_stderr(stderr):
                from generate_subtitle_doubao_api import main

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

    def test_default_name_carries_doubao_tag_and_stat_is_emitted(self) -> None:
        names, stdout = self._run([])

        self.assertEqual(len(names), 1)
        self.assertTrue(names[0].endswith("20-走廊.doubao.srt"))
        self.assertEqual(self._stat_line(stdout), "MAW_STAT rtf=0.123")

    def test_debug_raw_writes_response_next_to_output(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            media = root / "20-走廊.mp3"
            media.write_bytes(b"media")
            output = root / "out.srt"
            stdout = io.StringIO()
            stderr = io.StringIO()
            values = [1000.0, 1123.0]

            def fake_perf():
                return values.pop(0) if values else 0.0

            config = {"api_key": "key", "resource_id": "volc.seedasr.auc"}
            result = {"text": "测试", "language": "", "items": [], "segments": [],
                      "timestamp_granularity": "segment", "_raw_response": {"result": {}}}
            with mock.patch(
                "sys.argv",
                ["generate_subtitle_doubao_api.py", str(media), "-o", str(output), "--debug-raw"],
            ), mock.patch("generate_subtitle_doubao_api.load_config", return_value=config), \
                 mock.patch(
                     "generate_subtitle_doubao_api._resolve_media_tool",
                     side_effect=lambda tool, _path=None: tool,
                 ), \
                 mock.patch("generate_subtitle_doubao_api.get_duration_sec", return_value=1000.0), \
                 mock.patch("generate_subtitle_doubao_api.extract_audio_ogg"), \
                 mock.patch("generate_subtitle_doubao_api.transcribe", return_value=result), \
                 mock.patch("generate_subtitle_doubao_api.time.perf_counter", side_effect=fake_perf), \
                 redirect_stdout(stdout), redirect_stderr(stderr):
                from generate_subtitle_doubao_api import main

                self.assertEqual(main(), 0)

            self.assertTrue((root / "out.srt").is_file())
            raw_files = sorted(root.glob("out.asr-response.json"))
            self.assertEqual(len(raw_files), 1)


if __name__ == "__main__":
    unittest.main()
