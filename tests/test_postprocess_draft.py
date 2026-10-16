from __future__ import annotations

import unittest

from maw.postprocess_ai_cleanup_timeline import parse_timeline
from maw.postprocess_draft import draft_lines
from maw.postprocess_resegment import parse_boundaries, source_units, limit_groups


class DraftEnvelopeTests(unittest.TestCase):
    def test_closed_reasoning_fences_and_blank_lines_are_transport_noise(self):
        units = [unit for index, text in enumerate(("甲", "乙")) for unit in source_units({"start": index * 1000, "end": (index + 1) * 1000, "text": text}, index)]
        groups = parse_boundaries({"draft": "<think>检查边界</think>\n```text\n[c0001]\n\n[c0002]\n```"}, units)
        self.assertEqual([[unit.id for unit in group] for group in groups], [["c0001"], ["c0002"]])
        rows = [{"id": "c001", "asrText": "甲"}]
        parsed = parse_timeline("<think>分析</think>\n```markdown\n[c001] 甲\n```", rows, {"c001": [{"text": "甲"}]})
        self.assertEqual(parsed["decisions"][0]["decision"], "keep")

    def test_unclosed_reasoning_is_not_an_answer_and_source_tags_are_literal(self):
        with self.assertRaisesRegex(ValueError, "未完成"):
            draft_lines("<think>尚在思考\n[c001] 甲")
        text = "<think>这是转写文字</think>"
        parsed = parse_timeline("[c001] " + text, [{"id": "c001", "asrText": text}], {"c001": [{"text": char} for char in text]})
        self.assertEqual(parsed["decisions"][0]["decision"], "keep")

    def test_existing_english_and_quantity_cue_boundaries_remain_legal(self):
        for texts in (("Hello", "world"), ("60", "fps"), ("1920", "像素")):
            with self.subTest(texts=texts):
                units = [unit for index, text in enumerate(texts) for unit in source_units({"start": index * 1000, "end": (index + 1) * 1000, "text": text}, index)]
                groups = parse_boundaries({"draft": "[c0001]\n[c0002]"}, units)
                self.assertEqual([group[0].text for group in groups], list(texts))
                limited, _ = limit_groups(units, 5)
                self.assertEqual("".join(unit.text for group in limited for unit in group), "".join(texts))

    def test_new_cuts_inside_a_source_word_still_fail(self):
        units = source_units({"start": 0, "end": 1000, "text": "Hello", "items": [{"text": "Hel", "start": 0, "end": 500}, {"text": "lo", "start": 500, "end": 1000}]}, 0)
        with self.assertRaisesRegex(ValueError, "连续英文"):
            parse_boundaries({"draft": f"[{units[0].id}]\n[{units[1].id}]"}, units)

    def test_local_length_limit_does_not_reintroduce_a_numeric_unit_cut(self):
        units = [unit for index, text in enumerate(("60", "fps")) for unit in source_units({"start": index * 1000, "end": (index + 1) * 1000, "text": text}, index)]
        # Keeping the original boundary is valid recovery, but when the model
        # joins it, local length enforcement must not split the unit again.
        groups, over = limit_groups(units, 3)
        self.assertEqual(["".join(unit.text for unit in group) for group in groups], ["60fps"])
        self.assertTrue(over)
