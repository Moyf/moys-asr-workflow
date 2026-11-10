"""term_extract.ai_filter：协议校验、重试与失败路径（假 LLM，无网络）。"""

from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools" / "term-extract"))

from maw.postprocess_llm import LlmSettings  # noqa: E402
from term_extract.ai_filter import (  # noqa: E402
    TermAiFilterError,
    _parse_verdicts,
    _strip_json_fence,
    build_settings,
    filter_candidates,
)

SETTINGS = LlmSettings(
    provider_id="custom",
    api_key="test-key",
    base_url="http://127.0.0.1:9",
    model="test-model",
)


def candidate(word: str, **overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "word": word,
        "typeGuess": "",
        "variants": [],
        "eventCount": 2,
        "hitCount": 9,
        "avgConf": 0.9,
        "contexts": [f"前往{word}"],
    }
    base.update(overrides)
    return base


def response(*items: dict[str, str]) -> str:
    return json.dumps({"terms": list(items)}, ensure_ascii=False)


class ParseTests(unittest.TestCase):
    def test_valid_response_parsed(self) -> None:
        verdicts = _parse_verdicts(
            response(
                {"word": "星核", "verdict": "keep", "type": "地名", "reason": "地点名"},
                {"word": "保存", "verdict": "reject", "type": "非术语", "reason": "界面词"},
            ),
            ["星核", "保存"],
        )
        self.assertEqual(verdicts["星核"]["verdict"], "keep")
        self.assertEqual(verdicts["保存"]["type"], "非术语")

    def test_missing_word_raises_protocol_error(self) -> None:
        with self.assertRaises(Exception):
            _parse_verdicts(response({"word": "星核", "verdict": "keep", "type": "地名", "reason": ""}), ["星核", "保存"])

    def test_bad_verdict_raises(self) -> None:
        with self.assertRaises(Exception):
            _parse_verdicts(
                response({"word": "星核", "verdict": "maybe", "type": "地名", "reason": ""}),
                ["星核"],
            )

    def test_fence_and_prose_stripped(self) -> None:
        fenced = "```json\n" + response({"word": "星核", "verdict": "keep", "type": "地名", "reason": "ok"}) + "\n```"
        self.assertIn("星核", _strip_json_fence(fenced))


class FilterTests(unittest.TestCase):
    def test_retry_recovers_from_protocol_error(self) -> None:
        calls: list[str] = []

        def complete(system_prompt: str, rows: list[dict[str, object]]) -> str:
            calls.append(system_prompt)
            if len(calls) == 1:
                return "not-json"
            return response(
                *(
                    {"word": str(row["word"]), "verdict": "keep", "type": "其他专名", "reason": "ok"}
                    for row in rows
                )
            )

        verdicts = filter_candidates([candidate("星核"), candidate("真希")], SETTINGS, complete=complete)
        self.assertEqual(len(calls), 2)
        self.assertIn("违反协议", calls[1])
        self.assertEqual(verdicts["真希"]["verdict"], "keep")

    def test_persistent_failure_raises_after_one_retry(self) -> None:
        def complete(_system: str, rows: list[dict[str, object]]) -> str:
            return response()  # 永远漏词

        with self.assertRaises(TermAiFilterError):
            filter_candidates([candidate("星核")], SETTINGS, complete=complete)

    def test_batches_respect_size(self) -> None:
        seen_sizes: list[int] = []

        def complete(_system: str, rows: list[dict[str, object]]) -> str:
            seen_sizes.append(len(rows))
            return response(
                *(
                    {"word": str(row["word"]), "verdict": "reject", "type": "非术语", "reason": "x"}
                    for row in rows
                )
            )

        candidates = [candidate(f"词{index}") for index in range(7)]
        filter_candidates(candidates, SETTINGS, complete=complete, batch_size=3)
        self.assertEqual(seen_sizes, [3, 3, 1])


class SettingsTests(unittest.TestCase):
    def test_preset_with_env_key(self) -> None:
        env = {"MAW_POSTPROCESS_ZHIPU_API_KEY": "zk"}
        with mock.patch.dict(os.environ, env, clear=False):
            settings = build_settings(preset_id="zhipu")
        self.assertEqual(settings.provider_id, "zhipu")
        self.assertEqual(settings.api_key, "zk")
        self.assertEqual(settings.model, "glm-5.2")

    def test_explicit_overrides_beat_preset(self) -> None:
        settings = build_settings(preset_id="zhipu", model="glm-5.3", api_key="k")
        self.assertEqual(settings.model, "glm-5.3")

    def test_missing_everything_raises(self) -> None:
        env = {key: "" for key in ("MAW_TERMS_LLM_API_KEY", "MAW_POSTPROCESS_ZHIPU_API_KEY")}
        with mock.patch.dict(os.environ, env, clear=False):
            with self.assertRaises(ValueError):
                build_settings(preset_id="zhipu")

    def test_no_preset_needs_base_url_and_model(self) -> None:
        with self.assertRaises(ValueError):
            build_settings(api_key="k")


if __name__ == "__main__":
    _ = unittest.main()
