from __future__ import annotations

import unittest

from maw.language import (
    infer_language_code,
    normalize_language_code,
    normalize_timestamp_range,
    resolve_language,
    split_mode_for_text,
    timestamp_granularity_for_items,
)


class LanguageContractTests(unittest.TestCase):
    def test_normalize_language_aliases_to_project_codes(self) -> None:
        self.assertEqual(normalize_language_code("English"), "en")
        self.assertEqual(normalize_language_code("zh-Hant"), "zh")
        self.assertEqual(normalize_language_code("Tagalog"), "fil")
        self.assertEqual(normalize_language_code("AF"), "af")
        self.assertEqual(normalize_language_code("auto"), "")

    def test_resolve_language_records_provenance(self) -> None:
        self.assertEqual(resolve_language("English", "zh", "hello"), ("en", "detected"))
        self.assertEqual(resolve_language("", "Chinese", "hello"), ("zh", "hint"))
        self.assertEqual(resolve_language("", None, "你好"), ("zh", "inferred"))
        self.assertEqual(resolve_language("", None, "hello world"), ("", "unknown"))

    def test_missing_language_uses_script_for_split_mode_without_claiming_latin_id(self) -> None:
        self.assertEqual(infer_language_code("你好"), "zh")
        self.assertEqual(split_mode_for_text("你好", ""), "continuous")
        self.assertEqual(split_mode_for_text("hello world", ""), "word")

    def test_segment_only_timestamp_metadata_is_not_word_granular(self) -> None:
        self.assertEqual(
            timestamp_granularity_for_items([], "word", has_segments=True),
            "segment",
        )

    def test_timestamp_range_rejects_negative_and_overflowed_ranges(self) -> None:
        self.assertIsNone(normalize_timestamp_range(-0.1, 0.2, scale=1000))
        self.assertIsNone(normalize_timestamp_range(1, 2, scale=1e308))
        self.assertEqual(normalize_timestamp_range(0.1, 0.2, scale=1000), (100, 200))
        self.assertEqual(
            timestamp_granularity_for_items([{"text": "hello"}], "word", explicit_items=False, has_segments=True),
            "segment",
        )
        self.assertEqual(
            timestamp_granularity_for_items([{"text": "hello"}], "word", has_segments=True),
            "segment",
        )


if __name__ == "__main__":
    unittest.main()
