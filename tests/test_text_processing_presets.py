import json
import tempfile
import unittest
from pathlib import Path

from maw.text_processing_presets import SCHEMA, load_library, save_library


class TextProcessingPresetTests(unittest.TestCase):
    def test_roundtrip_and_reject_invalid_without_overwriting(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'presets.json'
            library = {'schema': SCHEMA, 'presets': [{
                'id': 'one', 'name': '游戏', 'scope': 'selected', 'operations': {'trim': True},
                'rules': [{'find': '嗯', 'replace': '', 'regex': False, 'caseSensitive': False, 'enabled': True}],
            }]}
            self.assertEqual(load_library(path)['presets'], [])
            save_library(library, path)
            self.assertEqual(load_library(path), library)
            bad = json.loads(json.dumps(library))
            bad['presets'][0]['scope'] = 'unexpected'
            with self.assertRaises(ValueError):
                save_library(bad, path)
            self.assertEqual(load_library(path), library)
            bad = json.loads(json.dumps(library))
            bad['presets'][0]['operations']['wraps'] = [None]
            with self.assertRaises(ValueError):
                save_library(bad, path)
            self.assertEqual(load_library(path), library)

    def test_corrupt_file_is_reported(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'presets.json'
            path.write_text('{broken', encoding='utf-8')
            with self.assertRaises(json.JSONDecodeError):
                load_library(path)


if __name__ == '__main__':
    unittest.main()
