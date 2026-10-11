"""Guard the LM Studio reasoning/JSON-constraint workarounds.

Needle-style assertions only: a failure must print the missing fragment, not
an entire response container.
"""

from __future__ import annotations

import json
from threading import Event
import unittest
from unittest import mock

import requests

from maw.postprocess_llm import (
    LlmClientError,
    LlmSettings,
    _close_truncated_json,
    _json_constraint_support,
    _loads_with_trailing_repair,
    _record_json_constraint_mode,
    _record_json_constraint_support,
    _strip_json_fence,
    complete_subtitle_groups,
    json_constraint_supported,
)

_NEEDLE_PROTOCOL = '{"protocol":"maw-subtitle-translations-v1","groups":[{"id":"c0001","text":"你好"}]}'
_NEEDLE_PAYLOAD = {
    "protocol": "maw-subtitle-translations-v1",
    "groups": [{"id": "c0001", "text": "你好"}],
}


def _completion_body(content: str) -> dict:
    return {"choices": [{"message": {"content": content}}]}


def _make_settings(base_url: str = "http://127.0.0.1:1234/v1") -> LlmSettings:
    return LlmSettings(
        provider_id="custom",
        api_key="",
        base_url=base_url,
        model="qwen3.5-9b",
    )


def _mock_session(post_side_effect) -> mock.MagicMock:
    session = mock.MagicMock()
    session.__enter__.return_value = session
    session.post.side_effect = post_side_effect
    return session


class StripJsonFenceTests(unittest.TestCase):
    def test_plain_json_passes_through(self) -> None:
        self.assertEqual(_strip_json_fence('{"groups":[]}'), '{"groups":[]}')

    def test_json_fence_is_stripped(self) -> None:
        self.assertEqual(
            _strip_json_fence('```json\n{"groups":[]}\n```'), '{"groups":[]}'
        )

    def test_closed_think_block_is_removed(self) -> None:
        content = '<think>先想一下 {"bad": true}</think>\n{"groups":[{"id":"c1"}]}'
        self.assertEqual(_strip_json_fence(content), '{"groups":[{"id":"c1"}]}')

    def test_unclosed_think_block_is_not_a_final_answer(self) -> None:
        self.assertEqual(_strip_json_fence('<think>示例 {"groups": []}'), "")
        self.assertEqual(_strip_json_fence('<THINK>{"groups": []}'), "")

    def test_trailing_prose_and_braces_in_strings(self) -> None:
        content = '{"text":"brace } stays in string"} 完成。'
        self.assertEqual(
            _strip_json_fence(content), '{"text":"brace } stays in string"}'
        )

    def test_multiple_objects_are_not_silently_accepted(self) -> None:
        content = '{"groups": []} {"groups": [{"id":"unexpected"}]}'
        self.assertEqual(_strip_json_fence(content), content)

    def test_think_block_with_fence(self) -> None:
        content = '<think>x</think>\n```json\n{"groups":[]}\n```'
        self.assertEqual(_strip_json_fence(content), '{"groups":[]}')

    def test_prose_wrapped_json_is_extracted(self) -> None:
        content = '好的，以下是结果：\n{"groups":[]}\n完成。'
        self.assertEqual(_strip_json_fence(content), '{"groups":[]}')

    def test_empty_content_stays_empty(self) -> None:
        self.assertEqual(_strip_json_fence(""), "")


class JsonConstraintDowngradeTests(unittest.TestCase):
    def setUp(self) -> None:
        _json_constraint_support.clear()

    def tearDown(self) -> None:
        _json_constraint_support.clear()

    def test_rejected_json_object_falls_back_to_schema_then_prompt(self) -> None:
        settings = _make_settings()
        payloads: list[dict] = []

        def post_effect(url, json: dict | None = None, **_kwargs):
            assert json is not None
            payloads.append(json)
            if "response_format" in json:
                return _rejection_response_mock()
            return _response_mock(_completion_body(_NEEDLE_PROTOCOL))

        with mock.patch(
            "maw.postprocess_llm.requests.Session",
            return_value=_mock_session(post_effect),
        ):
            result = complete_subtitle_groups(
                settings, "Return JSON.", [{"id": "c0001", "text": "原文"}]
            )

        self.assertEqual(json_constraint_supported(settings), False)
        self.assertEqual(
            len(payloads),
            3,
            f"期望 对象→schema→无约束 共 3 次请求，实际 {len(payloads)}",
        )
        self.assertEqual(
            payloads[0].get("response_format", {}).get("type"), "json_object"
        )
        self.assertEqual(
            payloads[1].get("response_format", {}).get("type"), "json_schema"
        )
        self.assertNotIn("response_format", payloads[2])
        missing = [k for k, v in _NEEDLE_PAYLOAD.items() if result.get(k) != v]
        self.assertEqual(missing, [], f"缺少：{missing}")

    def test_schema_constraint_alone_is_accepted(self) -> None:
        settings = _make_settings()
        payloads: list[dict] = []

        def post_effect(url, json: dict | None = None, **_kwargs):
            assert json is not None
            payloads.append(json)
            fmt = json.get("response_format")
            if fmt is not None and fmt.get("type") == "json_object":
                return _rejection_response_mock()
            return _response_mock(_completion_body(_NEEDLE_PROTOCOL))

        with mock.patch(
            "maw.postprocess_llm.requests.Session",
            return_value=_mock_session(post_effect),
        ):
            complete_subtitle_groups(
                settings, "Return JSON.", [{"id": "c0001", "text": "原文"}]
            )

        self.assertEqual(json_constraint_supported(settings), True)
        self.assertEqual(len(payloads), 2)
        schema_format = payloads[1]["response_format"]
        self.assertEqual(schema_format["type"], "json_schema")
        self.assertEqual(schema_format["json_schema"]["schema"]["required"], ["groups"])

    def test_cached_schema_endpoint_sends_json_schema_upfront(self) -> None:
        settings = _make_settings()
        _record_json_constraint_mode(settings, "schema")
        payloads: list[dict] = []

        def post_effect(url, json: dict | None = None, **_kwargs):
            assert json is not None
            payloads.append(json)
            return _response_mock(_completion_body(_NEEDLE_PROTOCOL))

        with mock.patch(
            "maw.postprocess_llm.requests.Session",
            return_value=_mock_session(post_effect),
        ):
            complete_subtitle_groups(
                settings, "Return JSON.", [{"id": "c0001", "text": "原文"}]
            )

        self.assertEqual(len(payloads), 1)
        self.assertEqual(payloads[0]["response_format"]["type"], "json_schema")

    def test_empty_content_under_constraint_downgrades_then_diagnoses(self) -> None:
        settings = _make_settings()
        payloads: list[dict] = []

        def post_effect(url, json: dict | None = None, **_kwargs):
            assert json is not None
            payloads.append(json)
            return _response_mock(_completion_body(""))

        with mock.patch(
            "maw.postprocess_llm.requests.Session",
            return_value=_mock_session(post_effect),
        ):
            with self.assertRaises(LlmClientError) as raised:
                complete_subtitle_groups(
                    settings, "Return JSON.", [{"id": "c0001", "text": "原文"}]
                )

        self.assertEqual(json_constraint_supported(settings), False)
        self.assertEqual(
            len(payloads), 2, f"期望无约束重试一次（共 2 次请求），实际 {len(payloads)}"
        )
        self.assertNotIn("response_format", payloads[1])
        message = str(raised.exception)
        for needle in ("空内容", "#1773"):
            self.assertIn(needle, message, f"诊断报错缺少关键字：{needle}")

    def test_constraint_success_is_cached(self) -> None:
        settings = _make_settings()
        with mock.patch(
            "maw.postprocess_llm.requests.Session",
            return_value=_mock_session(
                lambda *_a, **_k: _response_mock(_completion_body(_NEEDLE_PROTOCOL))
            ),
        ):
            result = complete_subtitle_groups(
                settings, "Return JSON.", [{"id": "c0001", "text": "原文"}]
            )
        self.assertEqual(json_constraint_supported(settings), True)
        missing = [k for k, v in _NEEDLE_PAYLOAD.items() if result.get(k) != v]
        self.assertEqual(missing, [], f"缺少：{missing}")

    def test_known_bad_endpoint_skips_response_format_upfront(self) -> None:
        settings = _make_settings()
        _record_json_constraint_support(settings, False)
        payloads: list[dict] = []

        def post_effect(url, json: dict | None = None, **_kwargs):
            assert json is not None
            payloads.append(json)
            return _response_mock(_completion_body(_NEEDLE_PROTOCOL))

        with mock.patch(
            "maw.postprocess_llm.requests.Session",
            return_value=_mock_session(post_effect),
        ):
            complete_subtitle_groups(
                settings, "Return JSON.", [{"id": "c0001", "text": "原文"}]
            )
        self.assertEqual(len(payloads), 1, f"期望单次请求，实际 {len(payloads)}")
        self.assertNotIn("response_format", payloads[0])

    def test_downgrade_after_invalid_json_preserves_protocol_retry(self) -> None:
        settings = _make_settings()
        responses = [
            _response_mock(_completion_body("invalid")),
            _rejection_response_mock(),
            _response_mock(_completion_body(_NEEDLE_PROTOCOL)),
        ]
        session = _mock_session(responses)
        with mock.patch("maw.postprocess_llm.requests.Session", return_value=session):
            result = complete_subtitle_groups(settings, "Return JSON.", [])
        self.assertEqual(result["protocol"], "maw-subtitle-translations-v1")
        self.assertEqual(session.post.call_count, 3)
        self.assertEqual(
            session.post.call_args.kwargs["json"]["response_format"]["type"],
            "json_schema",
        )

    def test_rejected_object_and_schema_drop_to_prompt(self) -> None:
        settings = _make_settings()
        responses = [
            _rejection_response_mock(),
            _rejection_response_mock(),
            _response_mock(_completion_body(_NEEDLE_PROTOCOL)),
        ]
        session = _mock_session(responses)
        with mock.patch("maw.postprocess_llm.requests.Session", return_value=session):
            result = complete_subtitle_groups(settings, "Return JSON.", [])
        self.assertEqual(result["protocol"], "maw-subtitle-translations-v1")
        self.assertEqual(session.post.call_count, 3)
        self.assertNotIn("response_format", session.post.call_args.kwargs["json"])
        self.assertEqual(json_constraint_supported(settings), False)

    def test_cleanup_shares_bounded_downgrade(self) -> None:
        from maw.postprocess_ai_cleanup import llm_complete

        session = _mock_session(
            [
                _response_mock(_completion_body("invalid")),
                _rejection_response_mock(),
                _response_mock(_completion_body('{"decisions":[]}')),
            ]
        )
        with mock.patch("maw.postprocess_llm.requests.Session", return_value=session):
            result = llm_complete(_make_settings())("Return JSON.", [])
        self.assertEqual(result, {"decisions": []})
        self.assertEqual(session.post.call_count, 3)

    def test_cleanup_schema_follows_decision_and_readthrough_payloads(self) -> None:
        from maw.postprocess_ai_cleanup import llm_complete
        from maw.postprocess_ai_cleanup_review import review_decisions

        payloads: list[dict] = []

        def post_effect(url, json: dict | None = None, **_kwargs):
            assert json is not None
            payloads.append(json)
            fmt = json.get("response_format")
            if fmt is None or fmt["type"] == "json_object":
                return _rejection_response_mock()
            # A grammar-enforcing endpoint emits only the required envelope.
            required = fmt["json_schema"]["schema"]["required"]
            content = '{"reviews":[]}' if required == ["reviews"] else '{"decisions":[]}'
            return _response_mock(_completion_body(content))

        transport = llm_complete(_make_settings())
        with mock.patch(
            "maw.postprocess_llm.requests.Session",
            return_value=_mock_session(post_effect),
        ):
            self.assertEqual(transport("Return decisions.", [{"id": "c001", "asrText": "test"}]), {"decisions": []})
            flags = review_decisions(transport, [{"id": "c001", "asrText": "test", "proposed": "discard"}])
            self.assertEqual(flags, {})
            self.assertEqual(transport("Return decisions.", [{"id": "c002", "asrText": "next"}]), {"decisions": []})
        self.assertEqual(len(payloads), 4)
        envelopes = [payload["response_format"]["json_schema"]["schema"]["required"] for payload in payloads[1:]]
        self.assertEqual(envelopes, [["decisions"], ["reviews"], ["decisions"]])

    def test_unrelated_400_does_not_retry_or_poison_cache(self) -> None:
        response = _rejection_response_mock()
        response.json.return_value = {"error": {"message": "unsupported model"}}
        session = _mock_session([response])
        settings = _make_settings()
        with mock.patch("maw.postprocess_llm.requests.Session", return_value=session):
            with self.assertRaises(LlmClientError):
                complete_subtitle_groups(settings, "Return JSON.", [])
        self.assertEqual(session.post.call_count, 1)
        self.assertIsNone(json_constraint_supported(settings))

    def test_cache_isolated_by_model_and_endpoint_path(self) -> None:
        from dataclasses import replace

        settings = _make_settings()
        _record_json_constraint_support(settings, False)
        self.assertIsNone(
            json_constraint_supported(replace(settings, model="another-model"))
        )
        self.assertIsNone(
            json_constraint_supported(
                replace(settings, base_url="http://127.0.0.1:1234/other/v1")
            )
        )

    def test_cancelled_stream_retains_controls_after_every_constraint_downgrade(self) -> None:
        # Exercise the actual transport rather than mocking its keyword args:
        # cancellation must reject late SSE text and close the observed handle
        # on both schema and unconstrained fallback paths, including cache hits.
        for cached_mode, rejections, expected_requests in (
            (None, 1, 2), (None, 2, 3), ("schema", 0, 1), ("none", 0, 1),
        ):
            with self.subTest(cached_mode=cached_mode, rejections=rejections):
                _json_constraint_support.clear()
                settings = _make_settings()
                if cached_mode is not None:
                    _record_json_constraint_mode(settings, cached_mode)
                cancelled = Event()
                observer_cleared = Event()
                observer_calls: list[object | None] = []
                deltas: list[tuple[str, str]] = []
                response = _response_mock({})

                def lines(**_kwargs):
                    cancelled.set()
                    yield b'data: {"choices":[{"delta":{"content":"late"}}]}'

                response.iter_lines.side_effect = lines
                session = _mock_session([*[_rejection_response_mock() for _ in range(rejections)], response])

                def observe(handle):
                    observer_calls.append(handle)
                    if handle is response or (handle is not None and getattr(handle, "response", None) is response):
                        observer_cleared.clear()
                    elif handle is None:
                        observer_cleared.set()

                with mock.patch("maw.postprocess_llm.requests.Session", return_value=session):
                    with self.assertRaises(LlmClientError) as raised:
                        complete_subtitle_groups(
                            settings, "Return JSON.", [],
                            on_delta=lambda kind, text: deltas.append((kind, text)),
                            is_cancelled=cancelled.is_set, on_response=observe,
                        )
                self.assertEqual(raised.exception.category, "cancelled")
                self.assertEqual(session.post.call_count, expected_requests)
                self.assertFalse(any(kind == "content" for kind, _ in deltas))
                self.assertTrue(observer_cleared.wait(1))
                self.assertEqual(len([handle for handle in observer_calls if handle is not None]), expected_requests)
                self.assertIsNone(observer_calls[-1])
                response.close.assert_called_once()

    def test_think_polluted_content_is_parsed(self) -> None:
        settings = _make_settings()
        content = f"<think>推理过程</think>\n```json\n{_NEEDLE_PROTOCOL}\n```"
        with mock.patch(
            "maw.postprocess_llm.requests.Session",
            return_value=_mock_session(
                lambda *_a, **_k: _response_mock(_completion_body(content))
            ),
        ):
            result = complete_subtitle_groups(
                settings, "Return JSON.", [{"id": "c0001", "text": "原文"}]
            )
        missing = [k for k, v in _NEEDLE_PAYLOAD.items() if result.get(k) != v]
        self.assertEqual(missing, [], f"缺少：{missing}")


class TruncatedJsonRepairTests(unittest.TestCase):
    def test_missing_final_brace_is_closed(self) -> None:
        content = '{"groups":[{"id":"c0001","text":"你好"}]'
        self.assertEqual(_close_truncated_json(content), content + "}")

    def test_trailing_comma_before_closers_is_dropped(self) -> None:
        repaired = json.loads(_close_truncated_json('{"groups":[{"id":"c1",'))
        self.assertEqual(repaired, {"groups": [{"id": "c1"}]})

    def test_trailing_comma_with_complete_closers_is_dropped(self) -> None:
        content = '{"groups":[{"id":"c1","text":"literal ,]} stays"}, ]}'
        self.assertEqual(
            _loads_with_trailing_repair(content),
            {"groups": [{"id": "c1", "text": "literal ,]} stays"}]},
        )

    def test_comma_without_previous_value_is_not_repaired(self) -> None:
        for content in ('{,}', '{"groups":[,]}'):
            with self.subTest(content=content), self.assertRaises(json.JSONDecodeError):
                _loads_with_trailing_repair(content)

    def test_nested_missing_brackets_are_closed_in_order(self) -> None:
        repaired = json.loads(_close_truncated_json('{"a":[{"b":1'))
        self.assertEqual(repaired, {"a": [{"b": 1}]})

    def test_unterminated_string_is_not_repaired(self) -> None:
        self.assertIsNone(_close_truncated_json('{"groups":[{"text":"写到一半'))

    def test_unescaped_quote_break_is_not_repaired(self) -> None:
        content = '{"groups":[{"text":"嗯喂!!喂喂喂嗯<<"喂喂好的"}]'
        self.assertIsNone(_close_truncated_json(content))

    def test_mismatched_closer_is_not_repaired(self) -> None:
        self.assertIsNone(_close_truncated_json('{"a":1]'))

    def test_balanced_content_has_nothing_to_repair(self) -> None:
        self.assertIsNone(_close_truncated_json('{"a":1}'))

    def test_repair_rejects_garbage_suffix(self) -> None:
        with self.assertRaises(json.JSONDecodeError):
            _loads_with_trailing_repair('{"a":1} 尾随文字')

    def test_complete_subtitle_groups_repairs_truncated_response(self) -> None:
        settings = _make_settings()
        truncated = _NEEDLE_PROTOCOL[:-1]
        session = _mock_session(
            lambda *_a, **_k: _response_mock(_completion_body(truncated))
        )
        with mock.patch("maw.postprocess_llm.requests.Session", return_value=session):
            result = complete_subtitle_groups(
                settings, "Return JSON.", [{"id": "c0001", "text": "原文"}]
            )
        self.assertEqual(session.post.call_count, 1)
        missing = [k for k, v in _NEEDLE_PAYLOAD.items() if result.get(k) != v]
        self.assertEqual(missing, [], f"缺少：{missing}")

    def test_cleanup_llm_complete_repairs_truncated_response(self) -> None:
        from maw.postprocess_ai_cleanup import llm_complete

        truncated = '{"decisions":[{"id":"c001","decision":"keep"}]'
        session = _mock_session(
            lambda *_a, **_k: _response_mock(_completion_body(truncated))
        )
        with mock.patch("maw.postprocess_llm.requests.Session", return_value=session):
            result = llm_complete(_make_settings())("Return JSON.", [])
        self.assertEqual(result, {"decisions": [{"id": "c001", "decision": "keep"}]})


def _rejection_response_mock() -> mock.Mock:
    response = mock.Mock(spec=["status_code", "json", "raise_for_status"])
    response.status_code = 400
    response.json.return_value = {
        "error": {
            "message": "'response_format.type' must be one of 'json_schema' or 'text'"
        },
    }
    response.raise_for_status.side_effect = requests.HTTPError("400 Client Error")
    return response


def _response_mock(body: dict) -> mock.Mock:
    response = mock.Mock()
    response.status_code = 200
    response.json.return_value = body
    response.raise_for_status.return_value = None
    return response


if __name__ == "__main__":
    unittest.main()
