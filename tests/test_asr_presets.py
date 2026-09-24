from html.parser import HTMLParser
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import Mock, patch

from maw.asr_presets import BOOL_FIELDS, TEXT_FIELDS, read_preset, write_preset
from maw.gui_config import load_env
from maw.gui_web import LauncherApi, LauncherPaths


class RecognitionPresetTests(unittest.TestCase):
    def test_native_dialog_filters_pass_pywebview_validation(self):
        from webview.util import parse_file_type
        from maw.gui_web import OPEN_DIALOG, SAVE_DIALOG

        def validate_dialog(_dialog_type, **kwargs):
            for file_type in kwargs['file_types']:
                self.assertEqual(parse_file_type(file_type), ('ASR presets', '*.json'))
            return None

        dialog = Mock(side_effect=validate_dialog)
        window = SimpleNamespace(create_file_dialog=dialog)
        with patch('webview.windows', [window]), patch('maw.gui_web.application_directory', return_value=self.root):
            for action, dialog_type in (('save', SAVE_DIALOG), ('load', OPEN_DIALOG)):
                with self.subTest(action=action):
                    result = self.api.recognition_preset({'action': action, 'options': self.options})
                    self.assertEqual(result, {'ok': True, 'cancelled': True})
                    self.assertEqual(dialog.call_args.args, (dialog_type,))
                    if action == 'save':
                        self.assertEqual(dialog.call_args.kwargs['save_filename'], 'Untitled.json')

    def test_every_advanced_input_is_in_the_preset(self):
        class Inputs(HTMLParser):
            def __init__(self):
                super().__init__()
                self.ids = set()

            def handle_starttag(self, tag, attrs):
                if tag in ('input', 'select', 'textarea'):
                    self.ids.add(dict(attrs)['id'])

        html = (Path(__file__).resolve().parents[1] / 'web/launcher/index.html').read_text(encoding='utf-8')
        advanced = html.split('id="advancedCard"', 1)[1].split('</section>', 1)[0]
        parser = Inputs()
        parser.feed(advanced)
        self.assertFalse(parser.ids - set(TEXT_FIELDS + BOOL_FIELDS))

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = self.root / '.env'
        self.api = LauncherApi(paths=LauncherPaths(self.root, self.env, self.root / 'index.html'))
        self.options = dict.fromkeys(TEXT_FIELDS, '') | dict.fromkeys(BOOL_FIELDS, False)
        self.options.update(localDevice='auto', fireRedPunc='ct-punc',
                            qwenAudioHotwordsMode='text', qwenAudioHotwordWeight='50',
                            qwenAudioContext='领域背景\n保留第二行', qwenAudioHotwords='术语: 50\n产品',
                            debugRaw=True, testRun=True, qwenAudioKeepDialect=True, language='zh,en')

    def test_older_preset_defaults_to_standard_dialect_behavior(self):
        from maw.asr_presets import validate_options

        legacy = dict(self.options)
        del legacy['qwenAudioKeepDialect']
        restored = validate_options(legacy)
        self.assertFalse(restored['qwenAudioKeepDialect'])
        self.assertEqual(restored, legacy | {'qwenAudioKeepDialect': False})

    def test_roundtrip_and_shared_directory_after_restart(self):
        other = self.root / 'custom'
        other.mkdir()
        path = other / '访谈.json'
        with patch('maw.gui_web.application_directory', return_value=self.root), patch('maw.gui_web._file_dialog', return_value=(str(path),)) as dialog:
            result = self.api.recognition_preset({'action': 'save', 'options': self.options})
            self.assertTrue(result['ok'], result)
            self.assertEqual(dialog.call_args.kwargs['directory'], str(self.root / 'asr-presets'))
        self.assertEqual(read_preset(path), self.options)
        self.assertNotIn(b'\r\n', path.read_bytes())
        restarted = LauncherApi(paths=self.api.paths)
        with patch('maw.gui_web._file_dialog', return_value=(str(path),)) as dialog:
            result = restarted.recognition_preset({'action': 'load'})
            self.assertEqual(result['options'], self.options)
            self.assertEqual(dialog.call_args.kwargs['directory'], str(other))
        self.assertEqual(load_env(self.env)['MAW_ASR_PRESET_DIRECTORY'], str(other))

    def test_cancel_and_invalid_file_do_not_remember_directory(self):
        path = self.root / 'bad.json'
        path.write_text('{"schema":"other","options":{}}', encoding='utf-8')
        with patch('maw.gui_web._file_dialog', return_value=None):
            self.assertTrue(self.api.recognition_preset({'action': 'load'})['cancelled'])
        with patch('maw.gui_web._file_dialog', return_value=(str(path),)):
            self.assertFalse(self.api.recognition_preset({'action': 'load'})['ok'])
        self.assertFalse(self.env.exists())

    def test_invalid_fields_rejected_before_overwriting(self):
        path = self.root / 'preset.json'
        write_preset(path, self.options)
        original = path.read_bytes()
        for update in ({'apiKey': 'secret'}, {'debugRaw': 'false'}, {'qwenAudioHotwordsMode': 'bad'}):
            with self.assertRaises(ValueError):
                write_preset(path, self.options | update)
            self.assertEqual(path.read_bytes(), original)

    def test_missing_hotword_file_is_warning_not_load_failure(self):
        path = self.root / 'preset.json'
        write_preset(path, self.options | {'qwenAudioHotwordsFile': str(self.root / 'missing.txt'),
                                           'qwenAudioHotwordsMode': 'file'})
        with patch('maw.gui_web._file_dialog', return_value=(str(path),)):
            result = self.api.recognition_preset({'action': 'load'})
        self.assertTrue(result['ok'])
        self.assertTrue(result['missingHotwords'])
        write_preset(path, self.options | {'qwenAudioHotwordsFile': str(self.root / 'missing.txt'),
                                           'qwenAudioHotwordsMode': 'text'})
        with patch('maw.gui_web._file_dialog', return_value=(str(path),)):
            result = self.api.recognition_preset({'action': 'load'})
        self.assertFalse(result['missingHotwords'])

    def test_successful_overwrite_replaces_preset(self):
        path = self.root / 'preset.json'
        write_preset(path, self.options)
        updated = self.options | {'qwenAudioContext': '新的背景'}
        write_preset(path, updated)
        self.assertEqual(read_preset(path), updated)
        self.assertNotIn(b'\r\n', path.read_bytes())
        self.assertEqual(list(self.root.iterdir()), [path])

    def test_failed_save_preserves_previous_preset(self):
        path = self.root / 'preset.json'
        write_preset(path, self.options)
        original = path.read_bytes()
        original_open = tempfile.NamedTemporaryFile

        def failing_open(*args, **kwargs):
            stream = original_open(*args, **kwargs)
            if kwargs.get('mode') == 'w':
                def partial_write(text):
                    stream.write(text[:10])
                    raise OSError('Disk full')
                wrapper = Mock(wraps=stream)
                wrapper.name = stream.name
                wrapper.write.side_effect = partial_write
                context = Mock()
                context.__enter__ = Mock(return_value=wrapper)
                context.__exit__ = Mock(side_effect=lambda *exc: stream.close())
                return context
            return stream

        for failure in (
            patch('maw.asr_presets.tempfile.NamedTemporaryFile', failing_open),
            patch('maw.asr_presets.os.fsync', side_effect=OSError('Flush failed')),
            patch('maw.asr_presets.os.replace', side_effect=PermissionError('File locked')),
        ):
            with failure, self.assertRaises(OSError):
                write_preset(path, self.options | {'qwenAudioContext': '新的背景'})
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(read_preset(path), self.options)
            self.assertEqual(list(self.root.iterdir()), [path])

    def test_unwritable_default_directory_falls_back(self):
        blocked = self.root / 'blocked'
        blocked.write_text('not a directory', encoding='utf-8')
        target = self.root / 'user' / 'asr-presets' / 'saved.json'
        with patch('maw.gui_web.application_directory', return_value=blocked), patch('maw.gui_web.default_app_data_root', return_value=self.root / 'user'), patch('maw.gui_web._file_dialog', return_value=(str(target),)):
            result = self.api.recognition_preset({'action': 'save', 'options': self.options})
        self.assertTrue(result['ok'], result)
        self.assertTrue(result['fallback'])


if __name__ == '__main__':
    unittest.main()
