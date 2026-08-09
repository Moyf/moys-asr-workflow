from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import requests

from maw import bcut, gui_config, gui_workflow
from maw.project import validate_project

# 必剪 result 字段的原始 JSON 字符串样板：
# utterances[] = {transcript, start_time, end_time, words[] = {label, start_time, end_time}}
def _result_json(utterances):
    return json.dumps({"utterances": utterances, "version": "1"}, ensure_ascii=False)


def _utterance(text, start, end, words=None):
    seg = {"transcript": text, "start_time": start, "end_time": end}
    if words is not None:
        seg["words"] = words
    return seg


def _word(label, start, end):
    return {"label": label, "start_time": start, "end_time": end}


def _response(payload, status=200):
    resp = mock.Mock()
    resp.ok = status < 400
    resp.status_code = status
    resp.json.return_value = payload
    resp.text = json.dumps(payload, ensure_ascii=False)
    resp.headers = {}
    return resp


def _data_response(data, status=200):
    return _response({"code": 0, "data": data, "message": "", "ttl": 1}, status=status)


class ItemMappingTests(unittest.TestCase):
    def test_words_become_char_level_items(self) -> None:
        utterances = [
            _utterance("大家好。", 0, 1000, [
                _word("大", 0, 300), _word("家", 300, 620),
                _word("好", 620, 900), _word("。", 900, 1000),
            ]),
        ]

        items = bcut.utterances_to_items(utterances)

        self.assertEqual(
            items,
            [
                {"text": "大", "start": 0, "end": 300},
                {"text": "家", "start": 300, "end": 620},
                {"text": "好", "start": 620, "end": 900},
                {"text": "。", "start": 900, "end": 1000},
            ],
        )

    def test_missing_words_falls_back_to_utterance_level(self) -> None:
        utterances = [
            _utterance("整句没有逐字。", 100, 2000),  # 无 words 字段
            _utterance("空 words 也回退。", 2100, 3000, []),
        ]

        items = bcut.utterances_to_items(utterances)

        self.assertEqual(items[0], {"text": "整句没有逐字。", "start": 100, "end": 2000})
        self.assertEqual(items[1], {"text": "空 words 也回退。", "start": 2100, "end": 3000})

    def test_defends_missing_or_inverted_timestamps(self) -> None:
        utterances = [
            _utterance("ab", 0, 200, [
                _word("a", 100, 200),
                {"label": "b"},                      # 缺时间戳 → 零宽落在前一个 end
                {"label": "c", "start_time": 500, "end_time": 400},  # 倒挂 → 零宽
                {"label": ""},                       # 空文本跳过
                "not-a-dict",                        # 异常结构跳过
            ]),
        ]

        items = bcut.utterances_to_items(utterances)

        self.assertEqual([it["text"] for it in items], ["a", "b", "c"])
        self.assertEqual(items[1], {"text": "b", "start": 200, "end": 200})
        self.assertEqual(items[2], {"text": "c", "start": 200, "end": 200})


class ParseResultTests(unittest.TestCase):
    def test_parse_result_payload_builds_text_language_items(self) -> None:
        raw = _result_json([
            _utterance("大家好。", 0, 1000, [_word("大", 0, 300)]),
            _utterance("我是字幕。", 1500, 3000, [_word("我", 1500, 1800)]),
        ])

        result = bcut.parse_result_payload(raw)

        self.assertEqual(result["text"], "大家好。我是字幕。")
        self.assertEqual(result["language"], "zh")
        self.assertEqual(len(result["items"]), 2)

    def test_parse_result_payload_western_language_not_forced_zh(self) -> None:
        raw = _result_json([
            _utterance("hello world", 0, 900, [
                _word("hello", 0, 400), _word(" world", 400, 900),
            ]),
        ])

        result = bcut.parse_result_payload(raw)

        self.assertEqual(result["language"], "")

    def test_parse_result_payload_rejects_invalid_json(self) -> None:
        with self.assertRaises(bcut.BcutApiError):
            bcut.parse_result_payload("not-json")

    def test_parse_result_payload_rejects_non_dict(self) -> None:
        with self.assertRaises(bcut.BcutApiError):
            bcut.parse_result_payload("[1, 2]")

    def test_segments_built_from_items_pass_project_validation(self) -> None:
        raw = _result_json([
            _utterance("大家好。", 0, 1000, [
                _word("大", 0, 300), _word("家", 300, 600),
                _word("好", 600, 900), _word("。", 900, 1000),
            ]),
            _utterance("欢迎回来。", 2500, 4000, [
                _word("欢", 2500, 2800), _word("迎", 2800, 3100),
                _word("回", 3100, 3400), _word("来", 3400, 3700), _word("。", 3700, 4000),
            ]),
        ])
        result = bcut.parse_result_payload(raw)

        segments = bcut.build_segments(
            result["items"], max_len=21, min_len=5, gap_split_ms=1500
        )

        self.assertEqual(len(segments), 2)
        check = validate_project({"media": "clip.wav", "language": "zh", "segments": segments})
        self.assertTrue(check.ok, msg=str([e.to_json() for e in check.errors]))


class ConfigTests(unittest.TestCase):
    def test_defaults(self) -> None:
        with mock.patch.dict("os.environ", {}, clear=False), \
             mock.patch.object(bcut, "ENV_FILE", Path("does-not-exist.env")):
            config = bcut.load_config()

        self.assertEqual(config["poll_interval"], bcut.DEFAULT_POLL_INTERVAL)
        self.assertEqual(config["poll_timeout"], bcut.DEFAULT_POLL_TIMEOUT)
        self.assertEqual(config["max_audio_seconds"], bcut.DEFAULT_MAX_AUDIO_SECONDS)

    def test_poll_interval_has_hard_floor(self) -> None:
        # 上限管理：配置低于下限的轮询间隔会被抬回 MIN_POLL_INTERVAL
        with mock.patch.dict("os.environ", {"BCUT_POLL_INTERVAL": "0"}), \
             mock.patch.object(bcut, "ENV_FILE", Path("does-not-exist.env")):
            config = bcut.load_config()

        self.assertEqual(config["poll_interval"], bcut.MIN_POLL_INTERVAL)

    def test_timeout_and_audio_limit_have_positive_floors(self) -> None:
        with mock.patch.dict(
            "os.environ",
            {"BCUT_POLL_TIMEOUT": "0", "BCUT_MAX_AUDIO_SECONDS": "-10"},
        ), mock.patch.object(bcut, "ENV_FILE", Path("does-not-exist.env")):
            config = bcut.load_config()

        self.assertEqual(config["poll_timeout"], bcut.MIN_POLL_TIMEOUT)
        self.assertEqual(config["max_audio_seconds"], bcut.MIN_MAX_AUDIO_SECONDS)


class ApiClientTests(unittest.TestCase):
    def test_request_upload_payload_and_response(self, ) -> None:
        upload_data = {
            "in_boss_key": "k", "resource_id": "r", "upload_id": "u",
            "upload_urls": ["https://up/1", "https://up/2"], "per_size": 1024,
            "size": 1500, "title": "a.wav", "type": 2,
        }
        with mock.patch("maw.bcut.requests") as req, \
             mock.patch.object(Path, "stat") as stat:
            stat.return_value = mock.Mock(st_size=1500)
            req.post.return_value = _data_response(upload_data)

            upload = bcut.request_upload("a.wav", on_status=lambda _m: None)

        payload = req.post.call_args.kwargs["json"]
        self.assertEqual(payload["ResourceFileType"], "wav")
        self.assertEqual(payload["name"], "a.wav")
        self.assertEqual(payload["size"], 1500)
        self.assertEqual(payload["model_id"], bcut.MODEL_ID_CREATE)
        self.assertEqual(upload["upload_urls"], ["https://up/1", "https://up/2"])
        self.assertEqual(upload["per_size"], 1024)

    def test_request_upload_raises_on_business_error_code(self) -> None:
        with mock.patch("maw.bcut.requests") as req, \
             mock.patch.object(Path, "stat") as stat:
            stat.return_value = mock.Mock(st_size=10)
            req.post.return_value = _response({"code": -400, "message": "bad request"})

            with self.assertRaises(bcut.BcutApiError) as raised:
                bcut.request_upload("a.wav", on_status=lambda _m: None)

        self.assertIn("-400", str(raised.exception))

    def test_request_upload_412_gets_risk_hint(self) -> None:
        with mock.patch("maw.bcut.requests") as req, \
             mock.patch.object(Path, "stat") as stat:
            stat.return_value = mock.Mock(st_size=10)
            req.post.return_value = _response({}, status=412)

            with self.assertRaises(bcut.BcutApiError) as raised:
                bcut.request_upload("a.wav", on_status=lambda _m: None)

        self.assertIn("412", str(raised.exception))
        self.assertIn("非官方接口", str(raised.exception))

    def test_request_upload_rejects_missing_parts_info(self) -> None:
        with mock.patch("maw.bcut.requests") as req, \
             mock.patch.object(Path, "stat") as stat:
            stat.return_value = mock.Mock(st_size=10)
            req.post.return_value = _data_response({"upload_urls": [], "per_size": 0})

            with self.assertRaises(bcut.BcutApiError):
                bcut.request_upload("a.wav", on_status=lambda _m: None)

    def test_request_upload_rejects_missing_resource_identifiers(self) -> None:
        with mock.patch("maw.bcut.requests") as req, \
             mock.patch.object(Path, "stat") as stat:
            stat.return_value = mock.Mock(st_size=10)
            req.post.return_value = _data_response(
                {"upload_urls": ["https://up/1"], "per_size": 10}
            )

            with self.assertRaises(bcut.BcutApiError) as raised:
                bcut.request_upload("a.wav", on_status=lambda _m: None)

        self.assertIn("资源标识", str(raised.exception))

    def test_upload_parts_sends_chunks_sequentially_and_collects_etags(self) -> None:
        upload = {"upload_urls": ["https://up/1", "https://up/2"], "per_size": 4}
        responses = []
        for i in (1, 2):
            resp = mock.Mock()
            resp.ok = True
            resp.headers = {"Etag": f"tag{i}"}
            responses.append(resp)
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "a.wav"
            path.write_bytes(b"abcdefgh")
            with mock.patch("maw.bcut.requests") as req:
                req.put.side_effect = responses

                etags = bcut.upload_parts(upload, str(path), on_status=lambda _m: None)

        self.assertEqual(etags, ["tag1", "tag2"])
        chunks = [call.kwargs["data"] for call in req.put.call_args_list]
        self.assertEqual(chunks, [b"abcd", b"efgh"])

    def test_upload_parts_retries_same_url_without_rereading_whole_file(self) -> None:
        upload = {"upload_urls": ["https://up/1"], "per_size": 4}
        response = mock.Mock(ok=True, headers={"Etag": "tag1"})
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "a.wav"
            path.write_bytes(b"abcdefgh")
            with mock.patch("maw.bcut.requests") as req, \
                 mock.patch("maw.bcut.time.sleep"):
                req.put.side_effect = [requests.exceptions.ConnectionError("boom"), response]

                with self.assertRaises(bcut.BcutApiError) as raised:
                    bcut.upload_parts(upload, str(path), on_status=lambda _m: None)

        self.assertIn("少于文件内容", str(raised.exception))
        self.assertEqual(req.put.call_count, 2)
        self.assertEqual(
            [call.kwargs["data"] for call in req.put.call_args_list],
            [b"abcd", b"abcd"],
        )

    def test_upload_parts_rejects_invalid_part_size(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "a.wav"
            path.write_bytes(b"abcd")
            with mock.patch("maw.bcut.requests") as req:
                with self.assertRaises(bcut.BcutApiError):
                    bcut.upload_parts(
                        {"upload_urls": ["https://up/1"], "per_size": 0},
                        str(path),
                        on_status=lambda _m: None,
                    )

        req.put.assert_not_called()

    def test_upload_parts_rejects_url_count_shorter_than_file(self) -> None:
        response = mock.Mock(ok=True, headers={"Etag": "tag1"})
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "a.wav"
            path.write_bytes(b"abcdefgh")
            with mock.patch("maw.bcut.requests") as req:
                req.put.return_value = response
                with self.assertRaises(bcut.BcutApiError) as raised:
                    bcut.upload_parts(
                        {"upload_urls": ["https://up/1"], "per_size": 4},
                        str(path),
                        on_status=lambda _m: None,
                    )

        self.assertIn("少于文件内容", str(raised.exception))
        req.put.assert_called_once()

    def test_commit_upload_returns_download_url(self) -> None:
        with mock.patch("maw.bcut.requests") as req:
            req.post.return_value = _data_response(
                {"resource_id": "r", "download_url": "https://dl/audio"}
            )

            url = bcut.commit_upload(
                {"in_boss_key": "k", "resource_id": "r", "upload_id": "u"},
                ["t1", "t2"],
            )

        self.assertEqual(url, "https://dl/audio")
        payload = req.post.call_args.kwargs["json"]
        self.assertEqual(payload["Etags"], "t1,t2")
        self.assertEqual(payload["InBossKey"], "k")

    def test_poll_task_waits_through_queue_and_running(self) -> None:
        with mock.patch("maw.bcut.requests") as req, \
             mock.patch.object(bcut, "MIN_POLL_INTERVAL", 0):
            req.get.side_effect = [
                _data_response({"task_id": "t", "state": 0, "remark": ""}),
                # 识别中 result 字段整个缺失（上游 issue #18），必须容忍
                _data_response({"task_id": "t", "state": 1, "remark": "50%"}),
                _data_response({
                    "task_id": "t", "state": 4,
                    "result": _result_json([_utterance("好。", 0, 100)]),
                    "remark": "",
                }),
            ]
            statuses = []

            raw = bcut.poll_task(
                "t", interval=0, timeout=60, on_status=statuses.append
            )

        self.assertEqual(req.get.call_count, 3)
        self.assertTrue(any("排队中" in s for s in statuses))
        self.assertTrue(any("识别中" in s for s in statuses))
        self.assertIn("utterances", raw)

    def test_poll_task_raises_on_error_state_with_remark(self) -> None:
        with mock.patch("maw.bcut.requests") as req:
            req.get.return_value = _data_response(
                {"task_id": "t", "state": 3, "remark": "音频无法识别"}
            )

            with self.assertRaises(bcut.TranscriptionFailedError) as raised:
                bcut.poll_task("t", interval=0, timeout=60, on_status=lambda _m: None)

        self.assertIn("音频无法识别", str(raised.exception))

    def test_poll_task_raises_on_unknown_state(self) -> None:
        with mock.patch("maw.bcut.requests") as req:
            req.get.return_value = _data_response({"task_id": "t", "state": 9})

            with self.assertRaises(RuntimeError) as raised:
                bcut.poll_task("t", interval=0, timeout=60, on_status=lambda _m: None)

        self.assertIn("未知任务状态", str(raised.exception))

    def test_poll_task_retries_transient_network_errors(self) -> None:
        with mock.patch("maw.bcut.requests") as req, \
             mock.patch.object(bcut, "MIN_POLL_INTERVAL", 0):
            req.get.side_effect = [
                requests.exceptions.ReadTimeout("boom"),
                _data_response({
                    "task_id": "t", "state": 4,
                    "result": _result_json([]), "remark": "",
                }),
            ]
            warnings = []

            bcut.poll_task("t", interval=0, timeout=60, on_status=warnings.append)

        self.assertEqual(req.get.call_count, 2)
        self.assertTrue(any("重试" in w for w in warnings))

    def test_poll_task_retries_transient_http_errors(self) -> None:
        with mock.patch("maw.bcut.requests") as req, \
             mock.patch.object(bcut, "MIN_POLL_INTERVAL", 0):
            req.get.side_effect = [
                _data_response({}, status=503),
                _data_response({
                    "task_id": "t", "state": 4,
                    "result": _result_json([]), "remark": "",
                }),
            ]
            warnings = []

            bcut.poll_task("t", interval=0, timeout=60, on_status=warnings.append)

        self.assertEqual(req.get.call_count, 2)
        self.assertTrue(any("HTTP 503" in w for w in warnings))

    def test_poll_task_raises_after_consecutive_network_failures(self) -> None:
        with mock.patch("maw.bcut.requests") as req, \
             mock.patch.object(bcut, "MIN_POLL_INTERVAL", 0):
            req.get.side_effect = requests.exceptions.ReadTimeout("boom")

            with self.assertRaises(RuntimeError) as raised:
                bcut.poll_task("t", interval=0, timeout=60, on_status=lambda _m: None)

        self.assertIn("连续", str(raised.exception))
        self.assertEqual(req.get.call_count, bcut.MAX_CONSECUTIVE_NETWORK_ERRORS)

    def test_poll_task_clamps_interval_to_floor(self) -> None:
        with mock.patch("maw.bcut.requests") as req, \
             mock.patch("maw.bcut.time.sleep") as sleep:
            req.get.return_value = _data_response({
                "task_id": "t", "state": 4,
                "result": _result_json([]), "remark": "",
            })

            bcut.poll_task("t", interval=0, timeout=60, on_status=lambda _m: None)

        # 第一次请求即完成时不会 sleep；再造一轮识别中验证 sleep 用下限值
        if sleep.call_count:
            self.assertEqual(sleep.call_args.args[0], bcut.MIN_POLL_INTERVAL)
        with mock.patch("maw.bcut.requests") as req, \
             mock.patch("maw.bcut.time.sleep") as sleep:
            req.get.side_effect = [
                _data_response({"task_id": "t", "state": 1, "remark": ""}),
                _data_response({
                    "task_id": "t", "state": 4,
                    "result": _result_json([]), "remark": "",
                }),
            ]

            bcut.poll_task("t", interval=0, timeout=60, on_status=lambda _m: None)

        sleep.assert_any_call(bcut.MIN_POLL_INTERVAL)


class TranscribeRetryTests(unittest.TestCase):
    def _config(self):
        return {"poll_interval": 0, "poll_timeout": 60, "max_audio_seconds": 7200}

    def test_transcribe_retries_initial_network_failure_then_succeeds(self) -> None:
        raw = _result_json([_utterance("你好。", 0, 500, [_word("你", 0, 250)])])
        with mock.patch.object(
            bcut, "request_upload",
            side_effect=[requests.exceptions.ConnectionError("boom"),
                         {"in_boss_key": "k", "resource_id": "r", "upload_id": "u",
                          "upload_urls": ["https://up/1"], "per_size": 1024}],
        ) as request_upload, \
             mock.patch.object(bcut, "upload_parts", return_value=["t"]), \
             mock.patch.object(bcut, "commit_upload", return_value="https://dl/a"), \
             mock.patch.object(bcut, "create_task", return_value="task-1"), \
             mock.patch.object(bcut, "poll_task", return_value=raw), \
             mock.patch("maw.bcut.time.sleep"):
            result = bcut.transcribe("a.wav", self._config(), on_status=lambda _m: None)

        self.assertEqual(request_upload.call_count, 2)
        self.assertEqual(result["text"], "你好。")
        self.assertEqual(result["language"], "zh")
        self.assertEqual(result["items"], [{"text": "你", "start": 0, "end": 250}])

    def test_transcribe_does_not_retry_non_network_upload_error(self) -> None:
        with mock.patch.object(
            bcut, "request_upload",
            side_effect=bcut.BcutApiError("接口错误"),
        ) as request_upload:
            with self.assertRaises(bcut.BcutApiError):
                bcut.transcribe("a.wav", self._config(), on_status=lambda _m: None)

        self.assertEqual(request_upload.call_count, 1)

    def test_transcribe_does_not_restart_upload_after_commit_network_error(self) -> None:
        upload = {
            "in_boss_key": "k", "resource_id": "r", "upload_id": "u",
            "upload_urls": ["https://up/1"], "per_size": 1024,
        }
        with mock.patch.object(bcut, "request_upload", return_value=upload) as request_upload, \
             mock.patch.object(bcut, "upload_parts", return_value=["tag"]), \
             mock.patch.object(
                 bcut, "commit_upload", side_effect=requests.exceptions.ConnectionError("boom")
             ), \
             mock.patch.object(bcut, "create_task") as create_task:
            with self.assertRaises(RuntimeError) as raised:
                bcut.transcribe("a.wav", self._config(), on_status=lambda _m: None)

        self.assertIn("结果未知", str(raised.exception))
        request_upload.assert_called_once()
        create_task.assert_not_called()

    def test_transcribe_rejects_unsupported_format_before_upload(self) -> None:
        with mock.patch.object(bcut, "request_upload") as request_upload:
            with self.assertRaises(RuntimeError) as raised:
                bcut.transcribe("a.ogg", self._config(), on_status=lambda _m: None)

        self.assertIn("转码", str(raised.exception))
        request_upload.assert_not_called()


class BcutCliAudioPreparationTests(unittest.TestCase):
    def test_length_limit_crops_supported_audio_before_max_check(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            input_path = Path(tmpdir) / "long.mp3"
            output_path = Path(tmpdir) / "out.srt"
            input_path.write_bytes(b"media")
            durations = []

            def duration_for(path: str) -> float:
                durations.append(path)
                return 10800.0 if Path(path).suffix.lower() == ".mp3" else 600.0

            result = {"text": "测试", "language": "zh", "items": []}
            with mock.patch(
                "sys.argv",
                [
                    "generate_subtitle_bcut_api.py",
                    str(input_path),
                    "-ll", "10m",
                    "-o", str(output_path),
                ],
            ), mock.patch(
                "generate_subtitle_bcut_api.load_config",
                return_value={
                    "poll_interval": 2,
                    "poll_timeout": 60,
                    "max_audio_seconds": 7200,
                },
            ), mock.patch(
                "generate_subtitle_bcut_api.get_duration_sec",
                side_effect=duration_for,
            ), mock.patch("generate_subtitle_bcut_api.extract_audio") as extract_audio, \
                 mock.patch("generate_subtitle_bcut_api.shutil.copy2") as copy2, \
                 mock.patch("generate_subtitle_bcut_api.transcribe", return_value=result) as transcribe:
                from generate_subtitle_bcut_api import main

                main()

            extract_audio.assert_called_once_with(
                str(input_path), mock.ANY, duration_limit=600.0
            )
            copy2.assert_not_called()
            self.assertEqual(len(durations), 1)
            self.assertTrue(durations[0].lower().endswith("audio.wav"))
            self.assertTrue(transcribe.call_args.args[0].lower().endswith("audio.wav"))
            self.assertTrue(output_path.exists())


class BcutCliExitContractTests(unittest.TestCase):
    def test_missing_input_exits_nonzero(self) -> None:
        """缺失输入文件属于调用方错误，必须以非零退出码失败。"""
        from generate_subtitle_bcut_api import main

        with mock.patch("sys.argv", ["generate_subtitle_bcut_api.py", "does-not-exist.mp3"]):
            with self.assertRaises(SystemExit) as raised:
                main()
        self.assertEqual(raised.exception.code, 1)


class GuiRegistrationTests(unittest.TestCase):
    def test_bcut_is_registered_last_with_risk_flags(self) -> None:
        provider = gui_config.PROVIDERS[-1]

        self.assertEqual(provider.id, "bcut")
        self.assertFalse(provider.requires_api_key)
        self.assertFalse(provider.supports_language)
        self.assertFalse(provider.supports_speaker)
        self.assertTrue(provider.note)  # 风险标注必须存在
        self.assertEqual(provider.regions, ())
        self.assertEqual(provider.models[0].env_key, "")

    def test_provider_for_model_maps_bcut_model(self) -> None:
        self.assertEqual(gui_config.provider_for_model("bcut-asr").id, "bcut")

    def test_api_key_for_bcut_is_empty_string(self) -> None:
        self.assertEqual(
            gui_config.api_key_for_provider("bcut", path=Path("does-not-exist.env")),
            "",
        )

    def test_qwen_remains_default_provider(self) -> None:
        self.assertEqual(gui_config.PROVIDERS[0].id, "qwen")
        self.assertEqual(gui_config.provider_by_id("unknown"), gui_config.PROVIDERS[0])


class GuiWorkflowTests(unittest.TestCase):
    def _request(self):
        return gui_workflow.TranscriptionRequest(
            media_path=Path("clip.mp4"),
            srt_path=Path("clip.bcut.srt"),
            model="bcut-asr",
            provider="bcut",
            length_limit="2m",
        )

    def test_default_srt_path_uses_bcut_tag(self) -> None:
        path = gui_workflow.default_srt_path(Path("clip.mp4"), provider="bcut", model="bcut-asr")

        self.assertEqual(path.name, "clip.bcut.srt")

    def test_build_command_uses_bcut_script_without_language_or_model(self) -> None:
        command = gui_workflow.build_transcribe_command(
            self._request(), executable="python", frozen=False
        )

        self.assertIn("generate_subtitle_bcut_api.py", command[1])
        self.assertNotIn("--language", command)
        self.assertNotIn("--model", command)
        self.assertNotIn("--region", command)
        self.assertNotIn("--speaker-colors", command)
        # 测试运行的时长上限仍然下发
        self.assertIn("--length-limit", command)

    def test_build_command_frozen_entry(self) -> None:
        command = gui_workflow.build_transcribe_command(
            self._request(), executable="MAW.exe", frozen=True
        )

        self.assertEqual(command[:3], ["MAW.exe", "--transcribe-bcut", str(Path("clip.mp4"))])

    def test_child_environment_skips_credentials_for_bcut(self) -> None:
        env = gui_workflow._child_environment({}, api_key="ignored", provider="bcut")

        self.assertNotIn("DASHSCOPE_API_KEY", env)
        self.assertNotIn("SONIOX_API_KEY", env)


if __name__ == "__main__":
    unittest.main()
