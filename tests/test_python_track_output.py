import contextlib
import copy
import io
import json
import tempfile
import unittest
from pathlib import Path

from maw.postprocess_io import render_srt, write_artifacts
from maw.project_ass_export import ProjectSubtitleError, render_project_ass
from scripts.mosp_match_text import main as match_main


def project():
    value = json.loads((Path(__file__).parent / 'fixtures/project-tracks/canonical.json').read_text(encoding='utf-8'))
    overlay = value['tracks'][2]
    overlay.update(enabled=True, variant='plain', segments=[{'id': 'cue-overlay', 'start': 1300, 'end': 2000, 'text': 'overlay'}])
    return value


class PythonTrackOutputTests(unittest.TestCase):
    def test_export_switches_apply_to_srt_and_ass_not_preview(self):
        for enabled in (False, True):
            for export in (False, True):
                for visible in (False, True):
                    with self.subTest(enabled=enabled, export=export, visible=visible):
                        p = project()
                        overlay = p['tracks'][2]
                        overlay.update(enabled=enabled, preview_visible=visible, export={'enabled': export})
                        before = copy.deepcopy(p)
                        srt = render_srt(p)
                        ass = render_project_ass(p, title='t', play_resolution=(1920, 1080))
                        self.assertEqual('overlay' in srt, enabled and export)
                        self.assertEqual('overlay' in ass, enabled and export)
                        self.assertNotIn('Hello', srt)
                        self.assertNotIn('Hello', ass)
                        self.assertEqual(p, before)

    def test_main_export_off_and_explicit_secondary(self):
        p = project()
        p['tracks'][0]['export'] = {'enabled': False}
        p['tracks'][1]['preview_visible'] = False
        self.assertNotIn('你好', render_srt(p))
        self.assertIn('overlay', render_srt(p))
        output = render_srt(p, mode='main_and_extension')
        self.assertIn('Hello', output)
        self.assertNotIn('你好', output)
        ass = render_project_ass(p, title='t', play_resolution=(1920, 1080), mode='main_and_extension')
        self.assertIn('Hello', ass)
        self.assertNotIn('你好', ass)
        p['tracks'][1]['export'] = {'enabled': False}
        self.assertNotIn('Hello', render_srt(p, mode='main_and_extension'))

    def test_unknown_overlay_is_not_rendered_as_plain(self):
        p = project()
        p['tracks'][2]['variant'] = 'future'
        with self.assertRaisesRegex(ValueError, 'Unsupported overlay variant'):
            render_srt(p)
        with self.assertRaisesRegex(ProjectSubtitleError, 'Unsupported overlay variant'):
            render_project_ass(p, title='t', play_resolution=(1920, 1080))
        p['tracks'][2]['export'] = {'enabled': False}
        self.assertIn('你好', render_srt(p))
        self.assertNotIn('overlay', render_srt(p))

    def test_sidecar_respects_export_flags_but_project_keeps_all_tracks(self):
        p = project()
        p['tracks'][2]['export'] = {'enabled': False}
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            original = root / 'input.mosp'
            original.write_text(json.dumps(p), encoding='utf-8')
            artifact = write_artifacts(p, source_project_path=original, source_srt_path=None,
                                       operation='replace', write_project=True, write_srt=True, output_directory=root)
            saved = json.loads(artifact.project_path.read_text(encoding='utf-8'))
            srt = artifact.srt_path.read_text(encoding='utf-8-sig')
            self.assertEqual(len(saved['tracks']), 3)
            self.assertEqual(saved['tracks'][2]['segments'][0]['text'], 'overlay')
            self.assertNotIn('overlay', srt)
            self.assertIn('你好', srt)

    def test_script_matching_cli_exports_selected_tracks_without_dropping_source(self):
        p = project()
        p['tracks'][0]['export'] = {'enabled': False}
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, manuscript = root / 'source.mosp', root / 'script.txt'
            srt, mosp = root / 'out.srt', root / 'out.mosp'
            source.write_text(json.dumps(p), encoding='utf-8')
            manuscript.write_text('你好', encoding='utf-8')
            with contextlib.redirect_stdout(io.StringIO()):
                status = match_main(['-m', str(source), '-t', str(manuscript), '--os', str(srt), '--om', str(mosp)])
            self.assertEqual(status, 0)
            self.assertIn('overlay', srt.read_text(encoding='utf-8'))
            self.assertNotIn('你好', srt.read_text(encoding='utf-8'))
            saved = json.loads(mosp.read_text(encoding='utf-8'))
            self.assertEqual(len(saved['tracks']), 3)
            self.assertEqual(saved['tracks'][0]['segments'][0]['text'], '你好')

    def test_unknown_variant_fails_before_writing_any_sidecar(self):
        p = project()
        p['tracks'][2]['variant'] = 'future'
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / 'source.mosp'
            source.write_text(json.dumps(p), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'Unsupported overlay variant'):
                write_artifacts(p, source_project_path=source, source_srt_path=None, operation='replace',
                                write_project=True, write_srt=True, output_directory=root)
            self.assertEqual([path.name for path in root.iterdir()], ['source.mosp'])
