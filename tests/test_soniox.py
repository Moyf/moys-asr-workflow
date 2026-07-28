from __future__ import annotations

import json
import unittest
from unittest import mock

import requests

from maw import soniox
from maw.project import validate_project

BASE = "https://api.soniox.com"
KEY = "test-key"


def _token(text, start, end, speaker=None, language=None):
    token = {"text": text, "start_ms": start, "end_ms": end}
    if speaker is not None:
        token["speaker"] = speaker
    if language is not None:
        token["language"] = language
    return token


def _response(payload, status=200):
    resp = mock.Mock()
    resp.ok = status < 400
    resp.status_code = status
    resp.json.return_value = payload
    resp.text = json.dumps(payload, ensure_ascii=False)
    return resp


def _segment(start, end, text, speaker=None):
    seg = {
        "start": start,
        "end": end,
        "text": text,
        "items": [{"text": text, "start": start, "end": end}],
    }
    if speaker is not None:
        seg["speaker"] = speaker
    return seg


class TokenMappingTests(unittest.TestCase):
    def test_tokens_to_items_preserves_ms_text_and_speaker(self) -> None:
        tokens = [
            _token("大", 0, 300, speaker="1"),
            _token("家", 300, 620, speaker="1"),
            _token("好", 620, 1000, speaker="2"),
        ]

        items = soniox.tokens_to_items(tokens)

        self.assertEqual(
            items,
            [
                {"text": "大", "start": 0, "end": 300, "speaker": "1"},
                {"text": "家", "start": 300, "end": 620, "speaker": "1"},
                {"text": "好", "start": 620, "end": 1000, "speaker": "2"},
            ],
        )

    def test_tokens_to_items_defends_missing_or_inverted_timestamps(self) -> None:
        tokens = [
            _token("a", 100, 200),
            {"text": "b"},  # 缺时间戳 → 零宽落在前一个 end
            {"text": "c", "start_ms": 500, "end_ms": 400},  # 倒挂 → 零宽
            {"text": ""},  # 空文本跳过
        ]

        items = soniox.tokens_to_items(tokens)

        self.assertEqual(items[1], {"text": "b", "start": 200, "end": 200})
        self.assertEqual(items[2], {"text": "c", "start": 200, "end": 200})
        self.assertEqual(len(items), 3)

    def test_tokens_to_items_omits_blank_speaker(self) -> None:
        items = soniox.tokens_to_items([_token("a", 0, 100, speaker="  ")])

        self.assertNotIn("speaker", items[0])


class SpeakerSplitTests(unittest.TestCase):
    def test_split_items_by_speaker_hard_splits_on_change(self) -> None:
        items = [
            {"text": "a", "start": 0, "end": 100, "speaker": "1"},
            {"text": "b", "start": 100, "end": 200, "speaker": "1"},
            {"text": "c", "start": 200, "end": 300, "speaker": "2"},
            {"text": "d", "start": 300, "end": 400, "speaker": "1"},
        ]

        runs = soniox.split_items_by_speaker(items)

        self.assertEqual([len(run) for run in runs], [2, 1, 1])

    def test_split_items_by_speaker_missing_speaker_follows_previous(self) -> None:
        items = [
            {"text": "a", "start": 0, "end": 100, "speaker": "1"},
            {"text": "b", "start": 100, "end": 200},  # 缺 speaker → 跟随 "1"
            {"text": "c", "start": 200, "end": 300, "speaker": "2"},
        ]

        runs = soniox.split_items_by_speaker(items)

        self.assertEqual([len(run) for run in runs], [2, 1])

    def test_split_items_by_speaker_no_speaker_single_run(self) -> None:
        items = [{"text": "a", "start": 0, "end": 100}]

        runs = soniox.split_items_by_speaker(items)

        self.assertEqual(len(runs), 1)


class BuildSegmentsTests(unittest.TestCase):
    FIXTURE = [
        _token("大", 0, 300, speaker="1"),
        _token("家", 300, 600, speaker="1"),
        _token("好", 600, 900, speaker="1"),
        _token("。", 900, 1000, speaker="1"),
        _token("你", 2000, 2300, speaker="2"),
        _token("好", 2300, 2600, speaker="2"),
        _token("。", 2600, 2700, speaker="2"),
    ]

    def test_build_segments_splits_by_speaker_and_tags_segments(self) -> None:
        items = soniox.tokens_to_items(self.FIXTURE)

        segments = soniox.build_segments(
            items, max_len=21, min_len=5, gap_split_ms=1500
        )

        self.assertEqual(len(segments), 2)
        self.assertEqual(segments[0]["speaker"], "1")
        self.assertEqual(segments[1]["speaker"], "2")
        self.assertEqual(segments[0]["text"], "大家好。")
        self.assertEqual(segments[1]["text"], "你好。")

    def test_build_segments_output_passes_project_validation(self) -> None:
        items = soniox.tokens_to_items(self.FIXTURE)
        segments = soniox.build_segments(
            items, max_len=21, min_len=5, gap_split_ms=1500
        )
        project = {"media": "clip.wav", "language": "zh", "segments": segments}

        result = validate_project(project)

        self.assertTrue(result.ok, msg=str([e.to_json() for e in result.errors]))

    def test_build_segments_without_speaker_leaves_segments_untagged(self) -> None:
        items = soniox.tokens_to_items([
            _token("你", 0, 300),
            _token("好", 300, 600),
        ])

        segments = soniox.build_segments(
            items, max_len=21, min_len=5, gap_split_ms=1500
        )

        self.assertNotIn("speaker", segments[0])


class SpeakerColorTests(unittest.TestCase):
    def test_colors_snapshot_head_and_ref(self) -> None:
        segments = [
            _segment(0, 100, "a", speaker="1"),
            _segment(100, 200, "b", speaker="1"),
            _segment(200, 300, "c", speaker="2"),
        ]

        stats = soniox.apply_speaker_colors(segments)

        self.assertEqual(segments[0]["color"], {
            "name": "red", "value": "#e74c3c", "start": 0, "end": 200,
        })
        self.assertEqual(segments[1]["color_ref"], {"name": "red", "headIdx": 0})
        self.assertEqual(segments[2]["color"], {
            "name": "yellow", "value": "#f1c40f", "start": 200, "end": 300,
        })
        self.assertEqual(stats["speakers"], ["1", "2"])
        self.assertEqual(stats["colored_segments"], 3)
        self.assertFalse(stats["overflow"])

        result = validate_project({"segments": segments})
        self.assertTrue(result.ok, msg=str([e.to_json() for e in result.errors]))

    def test_colors_repeat_speaker_gets_new_head_each_block(self) -> None:
        segments = [
            _segment(0, 100, "a", speaker="1"),
            _segment(100, 200, "b", speaker="2"),
            _segment(200, 300, "c", speaker="1"),
        ]

        soniox.apply_speaker_colors(segments)

        # A B A 三个块各自成 head；同一 speaker 复用同一颜色名
        self.assertEqual(segments[0]["color"]["name"], "red")
        self.assertEqual(segments[1]["color"]["name"], "yellow")
        self.assertEqual(segments[2]["color"]["name"], "red")
        self.assertNotIn("color_ref", segments[2])

        result = validate_project({"segments": segments})
        self.assertTrue(result.ok, msg=str([e.to_json() for e in result.errors]))

    def test_colors_overflow_cycles_palette_and_flags(self) -> None:
        segments = [
            _segment(i * 100, i * 100 + 100, f"s{i}", speaker=str(i + 1))
            for i in range(6)
        ]

        stats = soniox.apply_speaker_colors(segments)

        self.assertTrue(stats["overflow"])
        self.assertEqual(len(stats["speakers"]), 6)
        # 第 6 个 speaker 循环回第 1 个颜色
        self.assertEqual(segments[5]["color"]["name"], segments[0]["color"]["name"])

    def test_colors_no_speakers_is_noop(self) -> None:
        segments = [_segment(0, 100, "a")]

        stats = soniox.apply_speaker_colors(segments)

        self.assertEqual(stats["speakers"], [])
        self.assertNotIn("color", segments[0])


class MajorityLanguageTests(unittest.TestCase):
    def test_majority_language_picks_most_common(self) -> None:
        tokens = [
            _token("a", 0, 1, language="zh"),
            _token("b", 1, 2, language="en"),
            _token("c", 2, 3, language="zh"),
        ]

        self.assertEqual(soniox.majority_language(tokens), "zh")

    def test_majority_language_empty_without_tags(self) -> None:
        self.assertEqual(soniox.majority_language([_token("a", 0, 1)]), "")


class ApiClientTests(unittest.TestCase):
    def test_create_transcription_payload(self) -> None:
        with mock.patch("maw.soniox.requests") as req:
            req.post.return_value = _response({"id": "t1"}, status=201)

            tid = soniox.create_transcription(
                BASE, KEY,
                model="stt-async-v5", file_id="f1",
                language_hints=["zh"], enable_speaker_diarization=True,
            )

        self.assertEqual(tid, "t1")
        payload = req.post.call_args.kwargs["json"]
        self.assertEqual(payload["model"], "stt-async-v5")
        self.assertEqual(payload["file_id"], "f1")
        self.assertNotIn("audio_url", payload)  # file_id 与 audio_url 互斥
        self.assertEqual(payload["language_hints"], ["zh"])
        self.assertIs(payload["enable_speaker_diarization"], True)
        self.assertIs(payload["enable_language_identification"], True)

    def test_create_transcription_omits_optional_flags_by_default(self) -> None:
        with mock.patch("maw.soniox.requests") as req:
            req.post.return_value = _response({"id": "t1"}, status=201)

            soniox.create_transcription(BASE, KEY, model="stt-async-v5", file_id="f1")

        payload = req.post.call_args.kwargs["json"]
        self.assertNotIn("language_hints", payload)
        self.assertNotIn("enable_speaker_diarization", payload)

    def test_poll_transcription_returns_on_completed(self) -> None:
        with mock.patch("maw.soniox.requests") as req:
            req.get.side_effect = [
                _response({"status": "queued"}),
                _response({"status": "processing"}),
                _response({"status": "completed"}),
            ]
            statuses = []

            soniox.poll_transcription(
                BASE, KEY, "t1", interval=0, timeout=60,
                on_status=statuses.append,
            )

        self.assertEqual(req.get.call_count, 3)
        self.assertTrue(any("completed" in s for s in statuses))

    def test_poll_transcription_raises_on_error_state(self) -> None:
        with mock.patch("maw.soniox.requests") as req:
            req.get.return_value = _response({
                "status": "error",
                "error_type": "invalid_request",
                "error_message": "bad audio",
            })

            with self.assertRaises(RuntimeError) as raised:
                soniox.poll_transcription(BASE, KEY, "t1", interval=0, timeout=60)

        self.assertIn("invalid_request", str(raised.exception))
        self.assertIn("bad audio", str(raised.exception))

    def test_poll_transcription_raises_on_failed_state_defensively(self) -> None:
        # 通用错误文档把失败终态写作 failed（与 API Reference 的 error 不一致）
        with mock.patch("maw.soniox.requests") as req:
            req.get.return_value = _response({"status": "failed"})

            with self.assertRaises(RuntimeError):
                soniox.poll_transcription(BASE, KEY, "t1", interval=0, timeout=60)

    def test_poll_transcription_raises_on_unknown_state(self) -> None:
        with mock.patch("maw.soniox.requests") as req:
            req.get.return_value = _response({"status": "melted"})

            with self.assertRaises(RuntimeError) as raised:
                soniox.poll_transcription(BASE, KEY, "t1", interval=0, timeout=60)

        self.assertIn("未知任务状态", str(raised.exception))

    def test_raise_for_status_surfaces_structured_error(self) -> None:
        resp = _response(
            {"error_type": "unauthenticated", "message": "Incorrect API key provided."},
            status=401,
        )

        with self.assertRaises(RuntimeError) as raised:
            soniox._raise_for_status(resp)

        self.assertIn("401", str(raised.exception))
        self.assertIn("unauthenticated", str(raised.exception))
        self.assertIn("Incorrect API key", str(raised.exception))

    def test_delete_transcription_is_best_effort(self) -> None:
        with mock.patch("maw.soniox.requests") as req:
            req.delete.side_effect = requests.RequestException("boom")

            # 不抛异常，只警告
            soniox.delete_transcription(BASE, KEY, "t1", on_status=lambda _m: None)

    def test_delete_transcription_uses_documented_endpoint(self) -> None:
        with mock.patch("maw.soniox.requests") as req:
            req.delete.return_value = _response({}, status=204)

            soniox.delete_transcription(BASE, KEY, "t1", on_status=lambda _m: None)

        self.assertEqual(req.delete.call_args.args[0], f"{BASE}/v1/transcriptions/t1")


if __name__ == "__main__":
    unittest.main()
