from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from tests.compact_assertions import CompactContainerAssertions
from maw.postprocess import merge_bilingual_project
from maw.postprocess_comparison import render_comparison
from maw.postprocess_io import read_project, write_artifacts
from maw.postprocess_translation_review import translation_review
from maw.project import normalize_project
from tests.track_helpers import main_segments


class TranslationReviewTest(CompactContainerAssertions, unittest.TestCase):
    def test_bilingual_review_matches_existing_writer_for_whitespace_and_empty_text(self):
        for original, translated in ((" API ", "API"), ("API", " API "),
                                     ("源文", " "), (" ", "Translated."),
                                     ("源文", "Translated."), (" ", " ")):
            for order in ("original_first", "translation_first"):
                with self.subTest(original=original, translated=translated, order=order):
                    source = normalize_project({"segments": [{"id": "s1", "start": 0, "end": 1000, "text": original}]})
                    target = normalize_project({"segments": [{"id": "s1", "start": 0, "end": 1000, "text": translated}]})
                    result = merge_bilingual_project(source, target, translation_target="en", line_order=order)
                    review = translation_review(source, target, result, "translate_en-bilingual", order, "checked.mosp")
                    packet = json.loads(review["snapshot"])
                    self.assertEqual(packet["result"], result)

    def test_whitespace_bilingual_comparison_does_not_block_project_or_srt_output(self):
        source = normalize_project({"segments": [{"id": "s1", "start": 0, "end": 1000, "text": " API "}]})
        translated = normalize_project({"segments": [{"id": "s1", "start": 0, "end": 1000, "text": "API"}]})
        result = merge_bilingual_project(source, translated, translation_target="en")
        with tempfile.TemporaryDirectory() as directory:
            artifact = write_artifacts(result, source_project_path=Path(directory) / "source.mosp",
                                       source_srt_path=None, operation="translate_en-bilingual",
                                       write_project=True, write_srt=True,
                                       comparison_source=source, comparison_translation=translated)
            self.assertEqual(main_segments(read_project(artifact.project_path))[0]["text"], " API ")
            self.assertTrue(artifact.srt_path.is_file())
            self.assertTrue(artifact.comparison_path.is_file())

    def test_literal_template_markers_roundtrip_in_actual_html_json(self):
        data = {"operation": "proofread", "before": "{{REVIEW_SCRIPT}} {{DATA}}",
                "after": "<script>window.__bad=true</script>", "rows": [
                    {"notes": ["{{REVIEW_SCRIPT}} and {{DATA}}"], "text": "\"\\\n"}]}
        html = render_comparison(data)
        payload = html.split('<script id="comparison-data" type="application/json">', 1)[1].split("</script>", 1)[0]
        self.assertEqual(json.loads(payload), data)
        self.assertNotIn("<script>window.__bad=true</script>", payload)


if __name__ == "__main__":
    unittest.main()
