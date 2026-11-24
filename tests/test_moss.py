from __future__ import annotations

import io
import json
import re as _re
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from requests.exceptions import ConnectionError as RequestsConnectionError

from tests.compact_assertions import CompactContainerAssertions

from maw.moss import (
    AUDIO_BITRATE,
    AUDIO_FORMAT,
    DEFAULT_MODEL,
    DEFAULT_POLL_INTERVAL,
    DEFAULT_POLL_TIMEOUT,
    MAX_AUDIO_SECONDS,
    MAX_KEYTERM_CHARS,
    MAX_KEYTERMS,
    MAX_UPLOAD_BYTES,
    build_request_data,
    MAX_AUDIO_SECONDS_TOLERANCE,
    load_config,
    normalize_keyterms,
    parse_result,
    poll_task,
    query_task,
    submit_task,
    transcribe,
    validate_keyterms,
)


def _fake_response(
    *,
    status_code: int = 200,
    body: dict | None = None,
    text: str = "",
):
    def _json():
        if body is None:
            raise ValueError("no json")
        return body

    return SimpleNamespace(
        ok=status_code < 400,
        status_code=status_code,
        text=text,
        json=_json,
    )


class MossConfigTests(CompactContainerAssertions, unittest.TestCase):
    def test_load_config_defaults(self) -> None:
        with mock.patch.dict("os.environ", {}, clear=True), \
             mock.patch("maw.moss._load_env_file", return_value={}):
            config = load_config()

        self.assertEqual(config["api_key"], "")
        self.assertEqual(config["model"], DEFAULT_MODEL)
        self.assertEqual(config["poll_interval"], str(DEFAULT_POLL_INTERVAL))
        self.assertEqual(config["poll_timeout"], str(DEFAULT_POLL_TIMEOUT))

    def test_load_config_prefers_environment_over_env_file(self) -> None:
        with mock.patch.dict("os.environ", {"MOSS_API_KEY": "env-key"}), \
             mock.patch("maw.moss._load_env_file", return_value={"MOSS_API_KEY": "file-key"}):
            config = load_config()

        self.assertEqual(config["api_key"], "env-key")

    def test_limit_constants_match_official_contract(self) -> None:
        self.assertEqual(MAX_UPLOAD_BYTES, 512 * 1024 * 1024)
        self.assertEqual(MAX_AUDIO_SECONDS, 60 * 60)
        # 恰好等于上限的素材不因转码舍入被拒（3600s → ffprobe 3600.006s）
        self.assertLess(MAX_AUDIO_SECONDS_TOLERANCE, 1.0)
        self.assertGreater(MAX_AUDIO_SECONDS_TOLERANCE, 0.0)
        self.assertEqual(MAX_KEYTERMS, 20)
        self.assertEqual(MAX_KEYTERM_CHARS, 30)
        self.assertEqual(AUDIO_FORMAT, "ogg")
        self.assertEqual(AUDIO_BITRATE, "24k")

    def test_cli_punctuation_defaults_follow_unified_contract(self) -> None:
        # 统一 CLI 契约（docs/user/CLI.md）：未配置时保留全部句尾标点，
        # 删除必须显式传入；MOSS 适配器与各供应商一致，不得自带删除默认值
        import maw.asr.moss as moss_cli

        source = Path(moss_cli.__file__).read_text(encoding="utf-8")
        match = _re.search(
            r'--strip-tail-punct", default="([^"]*)"', source
        )
        self.assertIsNotNone(match)
        self.assertEqual(match.group(1), "")

    def test_cli_duration_limit_uses_tolerance(self) -> None:
        # 恰好 3600s（转码后读出 3600.006s）的素材不得被 60 分钟上限拒绝
        import maw.asr.moss as moss_cli

        source = Path(moss_cli.__file__).read_text(encoding="utf-8")
        self.assertIn(
            "MAX_AUDIO_SECONDS + MAX_AUDIO_SECONDS_TOLERANCE",
            source,
        )


class MossKeytermTests(unittest.TestCase):
    def test_normalize_keyterms_strips_dedupes_and_keeps_order(self) -> None:
        self.assertEqual(
            normalize_keyterms([" 热词A ", "热词B", "热词A", "", None]),
            ["热词A", "热词B"],
        )
        self.assertEqual(normalize_keyterms(None), [])
        self.assertEqual(normalize_keyterms([]), [])

    def test_validate_keyterms_rejects_too_many(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "20"):
            validate_keyterms([f"词{i}" for i in range(MAX_KEYTERMS + 1)])

    def test_validate_keyterms_rejects_overlong_entry(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "30"):
            validate_keyterms(["字" * (MAX_KEYTERM_CHARS + 1)])

    def test_build_request_data_always_requests_async_diarize_json(self) -> None:
        data = build_request_data(DEFAULT_MODEL)

        self.assertEqual(
            data,
            [
                ("model", DEFAULT_MODEL),
                ("diarize", "true"),
                ("response_format", "json"),
                ("async", "true"),
            ],
        )

    def test_build_request_data_encodes_keyterms_as_json_string(self) -> None:
        data = build_request_data(DEFAULT_MODEL, keyterms=["MOSS", "SGLang", " "])

        keyterm_values = [value for key, value in data if key == "keyterms"]
        self.assertEqual(len(keyterm_values), 1)
        self.assertEqual(json.loads(keyterm_values[0]), ["MOSS", "SGLang"])

    def test_build_request_data_rejects_invalid_keyterms_before_submit(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "keyterm"):
            build_request_data(DEFAULT_MODEL, keyterms=["x" * 99])


class MossApiTests(unittest.TestCase):
    def test_submit_task_returns_task_body(self) -> None:
        response = _fake_response(body={"id": "task-1", "task_id": "task-1", "retry_after": 5})
        with tempfile.TemporaryDirectory() as temp_dir:
            audio = Path(temp_dir) / "clip.ogg"
            audio.write_bytes(b"ogg-bytes")
            with mock.patch("maw.moss.requests.post", return_value=response) as post:
                task = submit_task(audio, api_key="key-1")

        self.assertEqual(task["task_id"], "task-1")
        kwargs = post.call_args.kwargs
        self.assertEqual(kwargs["headers"]["Authorization"], "Bearer key-1")
        self.assertEqual(
            post.call_args.args[0],
            "https://api.mosi.cn/v1/audio/transcriptions",
        )
        self.assertEqual(kwargs["data"][0], ("model", DEFAULT_MODEL))
        self.assertEqual(kwargs["files"]["file"][0], "clip.ogg")

    def test_submit_task_raises_with_error_code_and_message(self) -> None:
        response = _fake_response(
            status_code=400,
            body={"error": {"code": "invalid_keyterms", "message": "too many keyterms"}},
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            audio = Path(temp_dir) / "clip.ogg"
            audio.write_bytes(b"ogg-bytes")
            with mock.patch("maw.moss.requests.post", return_value=response):
                with self.assertRaisesRegex(RuntimeError, "invalid_keyterms"):
                    submit_task(audio, api_key="key-1")

    def test_submit_task_requires_task_id(self) -> None:
        response = _fake_response(body={"status": "PENDING"})
        with tempfile.TemporaryDirectory() as temp_dir:
            audio = Path(temp_dir) / "clip.ogg"
            audio.write_bytes(b"ogg-bytes")
            with mock.patch("maw.moss.requests.post", return_value=response):
                with self.assertRaisesRegex(RuntimeError, "task_id"):
                    submit_task(audio, api_key="key-1")

    def test_query_task_returns_body(self) -> None:
        response = _fake_response(body={"status": "PROCESSING"})
        with mock.patch("maw.moss.requests.get", return_value=response) as get:
            body = query_task("task-9", api_key="key-1")

        self.assertEqual(body, {"status": "PROCESSING"})
        self.assertEqual(
            get.call_args.args[0],
            "https://api.mosi.cn/v1/audio/tasks/task-9",
        )

    def test_query_task_raises_on_http_error(self) -> None:
        response = _fake_response(
            status_code=404,
            body={"error": {"code": "task_not_found", "message": "no such task"}},
        )
        with mock.patch("maw.moss.requests.get", return_value=response):
            with self.assertRaisesRegex(RuntimeError, "task_not_found"):
                query_task("task-404", api_key="key-1")

    def test_poll_task_waits_through_pending_and_processing(self) -> None:
        bodies = [
            {"status": "PENDING"},
            {"status": "PROCESSING"},
            {"status": "SUCCESS", "text": "你好"},
        ]
        statuses: list[str] = []
        with mock.patch("maw.moss.query_task", side_effect=bodies), \
             mock.patch("maw.moss.time.sleep") as sleep:
            body = poll_task(
                "task-1", api_key="key-1", interval=3, timeout=60,
                on_status=statuses.append,
            )

        self.assertEqual(body, {"status": "SUCCESS", "text": "你好"})
        self.assertEqual(sleep.call_count, 2)

    def test_poll_task_prefers_retry_after_over_interval(self) -> None:
        with mock.patch(
            "maw.moss.query_task",
            side_effect=[
                {"status": "PROCESSING"},
                {"status": "SUCCESS", "text": "你好"},
            ],
        ), mock.patch("maw.moss.time.sleep") as sleep:
            poll_task(
                "task-1", api_key="key-1", interval=3, timeout=60, retry_after=8,
                on_status=lambda _message: None,
            )

        # 等待间隔取 retry_after(8) 与 interval(3) 的较大值
        sleep.assert_called_once_with(8)

    def test_poll_task_raises_for_failed_task_with_detail(self) -> None:
        with mock.patch(
            "maw.moss.query_task",
            return_value={
                "status": "FAILED",
                "error": {"code": "audio_too_long", "message": "audio exceeds 60 minutes"},
            },
        ), mock.patch("maw.moss.time.sleep"):
            with self.assertRaisesRegex(RuntimeError, "audio exceeds 60 minutes"):
                poll_task("task-1", api_key="key-1", on_status=lambda _message: None)

    def test_poll_task_raises_for_unknown_status(self) -> None:
        with mock.patch(
            "maw.moss.query_task",
            return_value={"status": "WEIRD"},
        ), mock.patch("maw.moss.time.sleep"):
            with self.assertRaisesRegex(RuntimeError, "WEIRD"):
                poll_task("task-1", api_key="key-1", on_status=lambda _message: None)

    def test_poll_task_times_out_when_status_never_completes(self) -> None:
        with (
            mock.patch("maw.moss.query_task", return_value={"status": "PROCESSING"}),
            mock.patch("maw.moss.time.sleep"),
            mock.patch("maw.moss.time.monotonic", side_effect=[0, 0, 10]),
        ):
            with self.assertRaisesRegex(TimeoutError, "task_id=task-1"):
                poll_task(
                    "task-1", api_key="key-1", interval=3, timeout=5,
                    on_status=lambda _message: None,
                )

    def test_poll_task_gives_up_after_consecutive_network_errors(self) -> None:
        with mock.patch(
            "maw.moss.query_task",
            side_effect=RequestsConnectionError("boom"),
        ), mock.patch("maw.moss.time.sleep"):
            with self.assertRaisesRegex(RuntimeError, "网络失败"):
                poll_task("task-1", api_key="key-1", on_status=lambda _message: None)


class MossParseTests(unittest.TestCase):
    def test_parse_result_keeps_speaker_turns_when_one_has_zero_duration(self) -> None:
        result = parse_result({
            "text": "你好世界",
            "segments": [
                {"start": 0.1, "end": 0.5, "text": "你好", "speaker": "S01"},
                {"start": 0.5, "end": 0.5, "text": "世界", "speaker": "S02"},
            ],
        })

        self.assertEqual(result["timestamp_granularity"], "segment")
        self.assertEqual(result["segments"], [
            {"start": 100, "end": 500, "text": "你好", "speaker": "S01"},
            {"start": 500, "end": 600, "text": "世界", "speaker": "S02"},
        ])

    def test_parse_result_maps_segments_with_speakers(self) -> None:
        result = parse_result({
            "task": "transcribe",
            "duration": 5.18,
            "text": "欢迎使用 MOSS API。",
            "segments": [
                {
                    "type": "transcript.text.segment",
                    "id": "seg_001",
                    "start": 0.16,
                    "end": 5.18,
                    "text": "欢迎使用 MOSS API。",
                    "speaker": "S01",
                },
            ],
        })

        self.assertEqual(result["text"], "欢迎使用 MOSS API。")
        self.assertEqual(result["items"], [])
        self.assertEqual(result["timestamp_granularity"], "segment")
        self.assertEqual(result["duration_ms"], 5180)
        self.assertEqual(result["segments"], [
            {"start": 160, "end": 5180, "text": "欢迎使用 MOSS API。", "speaker": "S01"},
        ])

    def test_parse_result_skips_empty_text_segments(self) -> None:
        result = parse_result({
            "duration": 2.0,
            "text": "你好",
            "segments": [
                {"start": 0, "end": 1, "text": "你好", "speaker": "S01"},
                {"start": 1, "end": 2, "text": "   ", "speaker": "S02"},
            ],
        })

        self.assertEqual(len(result["segments"]), 1)
        self.assertEqual(result["segments"][0]["speaker"], "S01")

    def test_parse_result_builds_text_from_segments_when_missing(self) -> None:
        result = parse_result({
            "duration": 3.5,
            "segments": [
                {"start": 0.5, "end": 1.5, "text": "甲说话。", "speaker": "S01"},
                {"start": 1.6, "end": 3.5, "text": "乙回话。", "speaker": "S02"},
            ],
        })

        self.assertEqual(result["text"], "甲说话。乙回话。")
        self.assertEqual([seg["speaker"] for seg in result["segments"]], ["S01", "S02"])

    def test_parse_result_falls_back_to_single_cue_on_unranged_segment(self) -> None:
        result = parse_result({
            "duration": 9.5,
            "text": "完整文本。",
            "segments": [
                {"start": 0.5, "end": 4.5, "text": "完整文本。", "speaker": "S01"},
                {"text": "缺时间码的段落", "speaker": "S02"},
            ],
        })

        # 任一段缺时间码：整单退化为全文单条兜底，不丢文本也不伪造段级范围
        self.assertEqual(result["segments"], [
            {"start": 0, "end": 9500, "text": "完整文本。"},
        ])
        self.assertEqual(result["timestamp_granularity"], "segment")

    def test_parse_result_errors_without_ranges_or_duration(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "时间戳"):
            parse_result({
                "text": "只有文本",
                "segments": [{"text": "只有文本"}],
            })

    def test_parse_result_accepts_empty_segment_list_with_duration_fallback(self) -> None:
        # 官方文档：短音频或无有效分段时 segments 可为空，但 text 完整——
        # 必须兜底整段单条，绝不静默产出 0 条字幕
        result = parse_result({
            "duration": 1.2,
            "text": "短音频可能没有分段",
            "segments": [],
        })

        self.assertEqual(result["text"], "短音频可能没有分段")
        self.assertEqual(result["segments"], [
            {"start": 0, "end": 1200, "text": "短音频可能没有分段"},
        ])
        self.assertEqual(result["timestamp_granularity"], "segment")

    def test_parse_result_text_without_segments_key_falls_back_to_duration(self) -> None:
        result = parse_result({
            "status": "SUCCESS",
            "duration": 120.0,
            "text": "整段文本，没有任何分段",
        })

        self.assertEqual(result["segments"], [
            {"start": 0, "end": 120000, "text": "整段文本，没有任何分段"},
        ])
        self.assertEqual(result["timestamp_granularity"], "segment")

    def test_parse_result_text_without_timestamps_or_duration_errors(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "时间码"):
            parse_result({
                "status": "SUCCESS",
                "text": "既没有分段也没有时长",
            })

    def test_parse_result_without_top_level_text_keeps_unranged_segment_text(self) -> None:
        # Greptile P1：无顶层 text 且部分段缺时间码时，缺时间码段的文字
        # 不能被丢掉——整段兜底必须包含全部文本
        result = parse_result({
            "duration": 9.5,
            "segments": [
                {"start": 0.5, "end": 4.5, "text": "第一位先说。", "speaker": "S01"},
                {"text": "第二位没时间码的补充。", "speaker": "S02"},
            ],
        })

        self.assertEqual(result["text"], "第一位先说。第二位没时间码的补充。")
        self.assertEqual(result["segments"], [
            {"start": 0, "end": 9500, "text": "第一位先说。第二位没时间码的补充。"},
        ])

    def test_parse_result_millisecond_rounding(self) -> None:
        # 0.0167s → 16.7ms → 17：验证四舍五入而非截断；避开 .5 平局的银行家舍入
        result = parse_result({
            "duration": 1.2349,
            "text": "x",
            "segments": [{"start": 0.0167, "end": 1.2346, "text": "x", "speaker": "S01"}],
        })

        self.assertEqual(result["segments"][0]["start"], 17)
        self.assertEqual(result["segments"][0]["end"], 1235)
        self.assertEqual(result["duration_ms"], 1235)


class MossSegmentationTests(unittest.TestCase):
    """超长句段按标点/字数二次拆分（维护者实测 94 字长句触发）。"""

    # 维护者实测（仙术杯开场，moss-transcribe-diarize-pro）：整段 94 字、
    # 14.27 秒的说话人长句——不拆分完全不可读。
    LONG_TURN = (
        "好的，各位亲爱的观众朋友们，大家下午好，欢迎来到咱们的本次明日方舟"
        "新出杯S9决赛第三日比赛现场，感谢各位选手，各位观众准时的守候与收看。"
    )

    def test_overlong_turn_is_split_within_cue_length_limits(self) -> None:
        from maw.asr.moss import build_subtitle_segments

        segments, boundaries = build_subtitle_segments(
            [{"start": 9340, "end": 23610, "text": self.LONG_TURN, "speaker": "S01"}],
            max_len=18, min_len=5, gap_split_ms=500,
        )

        self.assertGreater(len(segments), 3)
        for piece in segments:
            self.assertLessEqual(len(piece["text"]), 18)
            # 拆分产物不得携带 items：插值时间不能冒充词级精度
            self.assertNotIn("items", piece)
            self.assertEqual(piece["speaker"], "S01")
        # 时间包络对齐原段范围且单调递增
        self.assertEqual(segments[0]["start"], 9340)
        self.assertEqual(segments[-1]["end"], 23610)
        for previous, current in zip(segments, segments[1:]):
            self.assertGreaterEqual(current["start"], previous["end"])
        # 拆分产生的新起点被标记为插值切点（供能量谷吸附）
        self.assertTrue(boundaries)

    def test_short_segments_pass_through_unchanged(self) -> None:
        from maw.asr.moss import build_subtitle_segments

        original = [
            {"start": 5050, "end": 5650, "text": "嗯，喂", "speaker": "S01"},
            {"start": 5980, "end": 6450, "text": "喂喂喂", "speaker": "S01"},
        ]

        segments, boundaries = build_subtitle_segments(
            [dict(segment) for segment in original],
            max_len=18, min_len=5, gap_split_ms=500,
        )

        self.assertEqual(segments, original)
        self.assertFalse(boundaries)

    def test_western_turn_splits_by_word_count(self) -> None:
        from maw.asr.moss import build_subtitle_segments

        text = " ".join(f"word{i}" for i in range(20))
        segments, _boundaries = build_subtitle_segments(
            [{"start": 0, "end": 20000, "text": text, "speaker": "S02"}],
            max_len=18, min_len=5, gap_split_ms=500, split_mode="word",
            max_words=6, min_words=2,
        )

        self.assertGreater(len(segments), 1)
        for piece in segments:
            self.assertLessEqual(len(piece["text"].split()), 6)


class MossTranscribeTests(unittest.TestCase):
    def test_transcribe_requires_api_key(self) -> None:
        with self.assertRaises(SystemExit):
            transcribe("clip.ogg", {"api_key": ""})

    def test_transcribe_rejects_audio_over_upload_limit(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            audio = Path(temp_dir) / "clip.ogg"
            audio.write_bytes(b"xxxx")
            with mock.patch("maw.moss.MAX_UPLOAD_BYTES", 2):
                with self.assertRaisesRegex(SystemExit, "512MB"):
                    transcribe(str(audio), {"api_key": "key"})

    def test_transcribe_submits_polls_and_parses(self) -> None:
        parsed = {
            "text": "你好。",
            "language": "",
            "items": [],
            "segments": [{"start": 0, "end": 900, "text": "你好。", "speaker": "S01"}],
            "timestamp_granularity": "segment",
            "duration_ms": 900,
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            audio = Path(temp_dir) / "clip.ogg"
            audio.write_bytes(b"ogg-bytes")
            with mock.patch(
                "maw.moss.submit_task",
                return_value={"task_id": "task-1", "retry_after": 5},
            ) as submit, \
                 mock.patch(
                     "maw.moss.poll_task",
                     return_value={"status": "SUCCESS", "text": "你好。"},
                 ) as poll, \
                 mock.patch("maw.moss.parse_result", return_value=dict(parsed)):
                result = transcribe(
                    str(audio),
                    {"api_key": "key-1", "model": DEFAULT_MODEL,
                     "poll_interval": 3, "poll_timeout": 60},
                    keyterms=["MOSS"],
                    capture_raw=True,
                )

        self.assertEqual(result["text"], "你好。")
        self.assertEqual(result["_raw_response"], {"status": "SUCCESS", "text": "你好。"})
        self.assertEqual(submit.call_args.kwargs["keyterms"], ["MOSS"])
        self.assertEqual(poll.call_args.kwargs["retry_after"], 5)
        self.assertEqual(poll.call_args.args[0], "task-1")

    def test_transcribe_rejects_invalid_keyterms_before_submit(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            audio = Path(temp_dir) / "clip.ogg"
            audio.write_bytes(b"ogg-bytes")
            with mock.patch("maw.moss.submit_task") as submit:
                with self.assertRaisesRegex(RuntimeError, "30"):
                    transcribe(
                        str(audio),
                        {"api_key": "key-1"},
                        keyterms=["x" * 99],
                    )

        self.assertFalse(submit.called)


class MossCliBehaviorTests(unittest.TestCase):
    """驱动 main() 全流程的契约行为测试（媒体层与转写均 mock）。

    两条源码字符串断言（默认标点 / 容差）守不住行为反转——见 PR #433
    Greptile 意见；本类用真实输出对行为钉桩。
    """

    def _run_main(self, extra_args: list[str], *, duration: float):
        """返回 (exit, system_exit, srt 内容或 None, stdout, stderr, transcribe)。

        输出在 TemporaryDirectory 仍在作用域内时读取；main() 以 SystemExit
        退出时其 code 记录在 system_exit。工程/HTML 路径经 --json/--no-html
        关闭，SRT 写到临时目录。
        """
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            media = root / "clip.mp3"
            media.write_bytes(b"media")
            output = root / "out.srt"
            stdout = io.StringIO()
            stderr = io.StringIO()
            result = {
                "text": "您好。",
                "language": "",
                "items": [],
                "segments": [{"start": 0, "end": 900, "text": "您好。"}],
                "timestamp_granularity": "segment",
                "duration_ms": 900,
            }
            argv = [
                "maw.asr.moss", str(media), "-o", str(output),
                "--json", "--no-html", "--no-model-tag",
                *extra_args,
            ]
            captured: dict[str, object] = {"code": None, "content": None}
            with mock.patch("sys.argv", argv), \
                 mock.patch("maw.asr.moss.load_config", return_value={"api_key": "key", "model": "moss-transcribe-diarize-pro"}), \
                 mock.patch(
                     "maw.asr.moss._resolve_media_tool",
                     side_effect=lambda tool, _path=None: tool,
                 ), \
                 mock.patch("maw.asr.moss.resolve_default_audio_track", return_value=0), \
                 mock.patch("maw.asr.moss.get_duration_sec", return_value=duration), \
                 mock.patch("maw.asr.moss.extract_audio_ogg"), \
                 mock.patch("maw.asr.moss.snap_cue_boundaries", return_value=0), \
                 mock.patch("maw.asr.moss.transcribe", return_value=result) as transcribe, \
                 redirect_stdout(stdout), redirect_stderr(stderr):
                from maw.asr.moss import main

                captured["code"] = None
                try:
                    captured["code"] = main()
                except SystemExit as exit_error:
                    captured["exit"] = exit_error.code
                captured["content"] = (
                    output.read_text(encoding="utf-8") if output.is_file() else None
                )
            return (
                captured.get("code"),
                captured.get("exit"),
                captured["content"],
                stdout.getvalue(),
                stderr.getvalue(),
                transcribe,
            )

    def test_default_run_keeps_trailing_punctuation(self) -> None:
        code, exit_code, content, _stdout, _stderr, transcribe = self._run_main([], duration=1000.0)

        self.assertEqual(code, 0)
        self.assertIsNone(exit_code)
        self.assertIn("您好。", content)
        # 默认路径必须发起真实转写（未被前置校验拦截）
        transcribe.assert_called_once()

    def test_explicit_strip_removes_trailing_punctuation(self) -> None:
        code, _exit_code, content, _stdout, _stderr, _transcribe = self._run_main(
            ["--strip-tail-punct", "，。；,.;"], duration=1000.0,
        )

        self.assertEqual(code, 0)
        self.assertNotIn("您好。", content)
        self.assertIn("您好", content)

    def test_keep_punct_overrides_explicit_strip(self) -> None:
        code, _exit_code, content, _stdout, _stderr, _transcribe = self._run_main(
            ["--strip-tail-punct", "，。；,.;", "--keep-punct"], duration=1000.0,
        )

        self.assertEqual(code, 0)
        self.assertIn("您好。", content)

    def test_exactly_60_minutes_passes_after_transcode_rounding(self) -> None:
        # 3600s 素材经 ogg/opus 转码读出 3600.006s：不得被上限拒绝
        code, _exit_code, content, _stdout, _stderr, transcribe = self._run_main(
            [], duration=3600.0065,
        )

        self.assertEqual(code, 0)
        self.assertIn("您好。", content)
        transcribe.assert_called_once()

    def test_slightly_over_60_minutes_is_rejected_before_submit(self) -> None:
        # 明显超限（> 0.1s 容差）的素材在提交前被拒，不发起网络转写
        code, exit_code, content, _stdout, _stderr, transcribe = self._run_main(
            [], duration=3600.2,
        )

        self.assertIsNone(code)  # main() 以 SystemExit 退出，未返回
        # CLI 的用法错误 SystemExit 携带错误信息字符串（argparse 同款语义）
        self.assertIn("超过 MOSS 单次任务上限", str(exit_code))
        self.assertIsNone(content)
        transcribe.assert_not_called()


if __name__ == "__main__":
    unittest.main()
