"""Canonical ASS manual layers must remain selectable by logical track."""
import unittest
import shutil
import subprocess
import tempfile
from pathlib import Path
from unittest.mock import patch

from maw.fcp7_png import prepare_render_plan, render_png_assets
from tests.test_fcp7_png import HEADER as RENDER_HEADER, event as render_event


HEADER = """[Script Info]
ScriptType: v4.00+
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def event(layer, role):
    return f"Dialogue: {layer},0:00:00.00,0:00:01.00,Default,maw:{role}:0,0,0,0,,{role}-{layer}\n"


class V2ImageLayerTests(unittest.TestCase):
    def setUp(self):
        self.ass = HEADER + ''.join(event(layer, role) for layer, role in (
            (0, 'main'), (1, 'extension'), (2, 'overlay'),
            (3, 'main'), (4, 'extension'), (5, 'overlay'),
        ))

    def plan(self, selected):
        with patch('maw.fcp7_png.normalize_ass_text_fontnames', side_effect=lambda value: (value, [])):
            return prepare_render_plan(self.ass, fps='25', width=320, height=180,
                                       duration_ms=2000, selected_layers=selected)

    def test_each_logical_track_selects_both_automatic_and_manual_layers(self):
        for selected in (0, 1, 2):
            with self.subTest(selected=selected):
                tracks = self.plan([selected])['tracks']
                self.assertEqual([track['layer'] for track in tracks], [selected, selected + 3])
                self.assertIn(f'Dialogue: {selected},', tracks[0]['ass'])
                self.assertIn(f'Dialogue: {selected + 3},', tracks[1]['ass'])

    def test_all_tracks_keep_physical_layer_order(self):
        self.assertEqual([track['layer'] for track in self.plan([0, 1, 2])['tracks']], list(range(6)))

    @unittest.skipUnless(shutil.which('ffmpeg'), 'real FFmpeg unavailable')
    def test_real_png_render_keeps_automatic_and_manual_main_cues(self):
        class Job:
            def check_cancelled(self): pass
            def update(self, *_args): pass
            def run_command(self, args, timeout, cwd):
                return subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout)

        ass = (RENDER_HEADER + render_event(text='AUTO', name='maw:main:0', layer=0)
               + render_event(text=r'{\pos(160,120)}MANUAL', name='maw:main:1', layer=3))
        with tempfile.TemporaryDirectory() as temporary:
            job = Job()
            job.directory = Path(temporary)
            job.output = job.directory / 'manifest.json'
            plan = prepare_render_plan(ass, fps='25', width=320, height=180,
                                       duration_ms=3000, selected_layers=[0])
            result = render_png_assets(job, plan, Path(shutil.which('ffmpeg')), job.directory / 'package')
            self.assertEqual([track['layer'] for track in result['tracks']], [0, 3])
            self.assertTrue(all(track['clips'] for track in result['tracks']))
