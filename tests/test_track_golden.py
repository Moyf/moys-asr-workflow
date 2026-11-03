"""P0 output baselines captured before the read adapter exists."""
import copy
import json
import unittest
from unittest.mock import patch
from pathlib import Path
from maw.project import normalize_project
from maw.project_io import serialize_mosp
from maw.project_ass_export import render_project_ass
from maw.postprocess_io import render_srt

FIXTURES = Path(__file__).parent / 'fixtures' / 'track-access'

def python_outputs(project):
    normalized = normalize_project(project)
    # Freeze the captured platform default, not the host's installed fonts.
    with patch('maw.project_ass_export.default_ass_font_name', return_value='PingFang SC'):
        ass = render_project_ass(normalized, title='track-golden', play_resolution=(1920,1080))
    return dict(project=json.loads(serialize_mosp(normalized)), ass=ass, srt=render_srt(normalized))

class TrackGoldenTests(unittest.TestCase):
    def test_v1_python_outputs_and_reopening(self):
        for path in sorted(FIXTURES.glob('*.input.json')):
            with self.subTest(fixture=path.name):
                source = json.loads(path.read_text())
                before = copy.deepcopy(source)
                expected = json.loads(path.with_name(path.name.replace('.input.', '.python.')).read_text())
                actual = python_outputs(source)
                legacy_project = copy.deepcopy(expected['project'])
                for index, segment in enumerate(source.get('segments', [])):
                    if 'id' not in segment:
                        legacy_project['segments'][index].pop('id', None)
                self.assertEqual(actual['project'], normalize_project(legacy_project))
                self.assertEqual(actual['ass'], expected['ass'])
                self.assertEqual(actual['srt'], expected['srt'])
                self.assertEqual(source, before)
                self.assertEqual(python_outputs(actual['project']), actual)
