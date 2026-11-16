import json
from pathlib import Path
import tempfile
import unittest

from scripts.ci_setup_benchmark_summary import STAGES, summarize


class SetupBenchmarkSummaryTests(unittest.TestCase):
    def test_missing_evidence_is_never_a_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            text = summarize(Path(tmp))
        self.assertEqual(text.count('Missing or ambiguous evidence'), len(STAGES))
        self.assertIn('not guaranteed cold/warm pairs', text)

    def test_bom_image_and_failed_stage_are_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'image.json').write_text(json.dumps({
                'runner': 'windows-2022', 'image': 'example', 'sample': 1,
                'mediaFeatureInstalled': False}), encoding='utf-8-sig')
            stage = root / 'media-foundation' / 'run'
            stage.mkdir(parents=True)
            (stage / 'result.json').write_text(json.dumps({
                'duration_seconds': 193.1, 'status': 'completed', 'exit_code': 1}), encoding='utf-8')
            text = summarize(root)
        self.assertIn('initially installed: False', text)
        self.assertIn('| media-foundation | 193.1 | completed, exit 1 |', text)
        self.assertNotIn('exit 0', text)

    def test_duplicate_evidence_is_not_summed_or_selected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for run in ('one', 'two'):
                path = root / 'chromium' / run
                path.mkdir(parents=True)
                (path / 'result.json').write_text('{}', encoding='utf-8')
            self.assertIn('| chromium | — | Missing or ambiguous evidence |', summarize(root))


if __name__ == '__main__':
    unittest.main()
