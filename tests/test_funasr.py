from __future__ import annotations

import io
import unittest
from contextlib import redirect_stdout
from unittest import mock

import requests

from generate_subtitle_qwen_api import (
    _compute_base_url,
    build_segments_preserving_speakers,
    is_funasr_model,
    parse_funasr_transcription_result,
    poll_task,
    submit_filetrans,
)


class FunAsrAdapterTests(unittest.TestCase):
    def test_beijing_workspace_uses_dedicated_domain_when_configured(self) -> None:
        self.assertEqual(
            _compute_base_url("beijing", "llm-example"),
            "https://llm-example.cn-beijing.maas.aliyuncs.com",
        )
        self.assertEqual(
            _compute_base_url("beijing", ""),
            "https://dashscope.aliyuncs.com",
        )

    def test_model_detection_accepts_stable_and_snapshot_ids(self) -> None:
        self.assertTrue(is_funasr_model("fun-asr"))
        self.assertTrue(is_funasr_model("fun-asr-2025-11-07"))
        self.assertTrue(is_funasr_model("fun-asr-mtl"))
        self.assertFalse(is_funasr_model("qwen3-asr-flash-filetrans"))

    @mock.patch("generate_subtitle_qwen_api.requests.post")
    def test_submit_uses_funasr_file_urls_language_hints_and_diarization(
        self,
        post: mock.Mock,
    ) -> None:
        response = mock.Mock()
        response.json.return_value = {
            "output": {"task_id": "task-fun", "task_status": "PENDING"}
        }
        post.return_value = response

        task_id = submit_filetrans(
            "https://dashscope.aliyuncs.com",
            "secret",
            "oss://temporary/audio.wav",
            language="zh",
            enable_words=True,
            enable_itn=False,
            model="fun-asr",
            enable_speaker=True,
            vocabulary_id="vocab-fun",
        )

        self.assertEqual(task_id, "task-fun")
        payload = post.call_args.kwargs["json"]
        self.assertEqual(payload["input"], {"file_urls": ["oss://temporary/audio.wav"]})
        self.assertEqual(payload["parameters"]["language_hints"], ["zh"])
        self.assertTrue(payload["parameters"]["diarization_enabled"])
        self.assertEqual(payload["parameters"]["vocabulary_id"], "vocab-fun")
        self.assertNotIn("enable_words", payload["parameters"])
        self.assertNotIn("enable_itn", payload["parameters"])
        self.assertEqual(
            post.call_args.kwargs["headers"]["X-DashScope-OssResourceResolve"],
            "enable",
        )
        response.raise_for_status.assert_called_once_with()

    @mock.patch("generate_subtitle_qwen_api.requests.post")
    def test_submit_preserves_dashscope_403_business_code_and_hint(
        self,
        post: mock.Mock,
    ) -> None:
        response = mock.Mock()
        response.status_code = 403
        response.json.return_value = {
            "code": "AllocationQuota.FreeTierOnly",
            "message": "Free quota exhausted.",
            "request_id": "request-403",
        }
        response.raise_for_status.side_effect = requests.HTTPError("403 Forbidden")
        post.return_value = response

        with self.assertRaises(RuntimeError) as raised:
            submit_filetrans(
                "https://dashscope.aliyuncs.com",
                "secret",
                "oss://temporary/audio.wav",
                language=None,
                enable_words=True,
                enable_itn=False,
                model="fun-asr",
                enable_speaker=True,
            )

        message = str(raised.exception)
        self.assertIn("AllocationQuota.FreeTierOnly", message)
        self.assertIn("request_id=request-403", message)
        self.assertIn("仅使用免费额度", message)

    @mock.patch("generate_subtitle_qwen_api.requests.post")
    def test_submit_explains_api_key_model_restrictions(
        self,
        post: mock.Mock,
    ) -> None:
        response = mock.Mock()
        response.status_code = 403
        response.json.return_value = {
            "code": "AccessDenied",
            "message": "Access denied by API-Key restrictions.",
            "request_id": "request-key-scope",
        }
        response.raise_for_status.side_effect = requests.HTTPError("403 Forbidden")
        post.return_value = response

        with self.assertRaises(RuntimeError) as raised:
            submit_filetrans(
                "https://dashscope.aliyuncs.com",
                "secret",
                "oss://temporary/audio.wav",
                language=None,
                enable_words=True,
                enable_itn=False,
                model="fun-asr",
                enable_speaker=True,
            )

        message = str(raised.exception)
        self.assertIn("自定义权限", message)
        self.assertIn("可访问模型中加入 fun-asr", message)
        self.assertIn("IP 白名单", message)

    @mock.patch("generate_subtitle_qwen_api.requests.get")
    def test_poll_reads_successful_funasr_subtask(self, get: mock.Mock) -> None:
        response = mock.Mock()
        response.json.return_value = {
            "output": {
                "task_status": "SUCCEEDED",
                "results": [
                    {
                        "subtask_status": "SUCCEEDED",
                        "transcription_url": "https://result.example/fun.json",
                    }
                ],
            },
            "usage": {"duration": 12},
        }
        get.return_value = response

        result_url, usage = poll_task(
            "https://dashscope.aliyuncs.com",
            "secret",
            "task-fun",
            interval=0,
            timeout=1,
            model="fun-asr",
        )

        self.assertEqual(result_url, "https://result.example/fun.json")
        self.assertEqual(usage, {"duration": 12})

    @mock.patch("generate_subtitle_qwen_api.requests.get")
    def test_poll_reports_funasr_subtask_failure(self, get: mock.Mock) -> None:
        response = mock.Mock()
        response.json.return_value = {
            "output": {
                "task_status": "SUCCEEDED",
                "results": [
                    {
                        "subtask_status": "FAILED",
                        "code": "FILE_DOWNLOAD_FAILED",
                        "message": "cannot download",
                    }
                ],
            }
        }
        get.return_value = response

        with self.assertRaisesRegex(RuntimeError, "FILE_DOWNLOAD_FAILED"):
            poll_task(
                "https://dashscope.aliyuncs.com",
                "secret",
                "task-fun",
                interval=0,
                timeout=1,
                model="fun-asr",
            )

    def test_parse_maps_sentence_speaker_to_each_word(self) -> None:
        result = parse_funasr_transcription_result(
            {
                "transcripts": [
                    {
                        "text": "你好。世界！",
                        "sentences": [
                            {
                                "begin_time": 100,
                                "end_time": 500,
                                "text": "你好。",
                                "speaker_id": 0,
                                "words": [
                                    {
                                        "begin_time": 100,
                                        "end_time": 260,
                                        "text": "你",
                                        "punctuation": "",
                                    },
                                    {
                                        "begin_time": 260,
                                        "end_time": 500,
                                        "text": "好",
                                        "punctuation": "。",
                                    },
                                ],
                            },
                            {
                                "begin_time": 600,
                                "end_time": 1000,
                                "text": "世界！",
                                "speaker_id": 1,
                                "words": [
                                    {
                                        "begin_time": 600,
                                        "end_time": 800,
                                        "text": "世",
                                        "punctuation": "",
                                    },
                                    {
                                        "begin_time": 800,
                                        "end_time": 1000,
                                        "text": "界",
                                        "punctuation": "！",
                                    },
                                ],
                            },
                        ],
                    }
                ]
            }
        )

        self.assertEqual(result["text"], "你好。世界！")
        self.assertEqual(
            [(item["text"], item["speaker"]) for item in result["items"]],
            [("你", "0"), ("好。", "0"), ("世", "1"), ("界！", "1")],
        )

    def test_segmentation_never_merges_different_speakers(self) -> None:
        segments = build_segments_preserving_speakers(
            [
                {"text": "你好。", "start": 0, "end": 500, "speaker": "0"},
                {"text": "嗯。", "start": 500, "end": 500, "speaker": "1"},
                {"text": "继续。", "start": 500, "end": 1000, "speaker": "1"},
            ],
            max_len=21,
            min_len=1,
            gap_split_ms=1500,
        )

        self.assertEqual([segment["speaker"] for segment in segments], ["0", "1"])
        self.assertEqual(segments[1]["text"], "嗯。继续。")
        self.assertTrue(all(segment["end"] > segment["start"] for segment in segments))


class FunAsrPartialSentenceLossTests(unittest.TestCase):
    """与 parse_transcription_result 同策略：坏句子只丢自己，好句子保留。"""

    def _sentence(self, text: str, start: int, speaker: int = 0) -> dict:
        words = []
        for index, char in enumerate(text):
            if char in "，。？！":
                words.append({"begin_time": start + index * 400, "end_time": start + (index + 1) * 400, "text": "", "punctuation": char})
            else:
                words.append({"begin_time": start + index * 400, "end_time": start + (index + 1) * 400, "text": char, "punctuation": ""})
        return {"begin_time": start, "end_time": start + len(text) * 400, "text": text, "speaker_id": speaker, "words": words}

    def test_zero_duration_sentence_kept_as_segment(self) -> None:
        result = parse_funasr_transcription_result({
            "transcripts": [{
                "text": "你好。嗯？",
                "sentences": [
                    self._sentence("你好。", 0),
                    {"begin_time": 600640, "end_time": 600640, "text": "嗯？", "speaker_id": 0, "words": []},
                ],
            }],
        })
        self.assertEqual(len(result["sentences"]), 2)
        zero = result["sentences"][1]
        self.assertEqual((zero["start"], zero["end"]), (600640, 600640))

    def test_unranged_sentence_skipped_and_warned(self) -> None:
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            result = parse_funasr_transcription_result({
                "transcripts": [{
                    "text": "你好。嗯？",
                    "sentences": [
                        self._sentence("你好。", 0),
                        {"text": "嗯？", "words": []},
                    ],
                }],
            })
        self.assertEqual(len(result["sentences"]), 1)
        self.assertEqual(result["sentences"][0]["text"], "你好。")
        self.assertIn("缺少有效时间范围", buffer.getvalue())

    def test_text_mismatch_warns_without_dropping_timestamps(self) -> None:
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            result = parse_funasr_transcription_result({
                "transcripts": [{
                    "text": "你好。再见",  # "再见"没有对应句子
                    "sentences": [self._sentence("你好。", 0)],
                }],
            })
        self.assertGreater(len(result["sentences"]), 0)
        self.assertIn("不一致", buffer.getvalue())


if __name__ == "__main__":
    unittest.main()
