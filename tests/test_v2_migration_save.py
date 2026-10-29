from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from maw.project import PROJECT_SCHEMA
from tests.test_local_editor_server import server_editor


class MigrationSaveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.enterContext(mock.patch.object(server_editor.EditorServer, 'persist_settings'))
        self.enterContext(mock.patch.object(server_editor.EditorServer, '_thumbnail_base_ready', return_value=False))

    def load(self, path):
        return server_editor.load_project(path, None, str(self.root), no_waveform=True, peaks_per_second=100)

    def legacy(self, schema):
        project = {'segments': [{'id': 'cue', 'start': 0, 'end': 100, 'text': 'text'}]}
        if schema is not None:
            project['schema'] = schema
        if schema == 'moy.asr.project.v1.5':
            project['subtitle_groups'] = {'next_id': 1, 'color': [], 'sticker': []}
        return project

    def test_legacy_requires_new_save_as_then_normal_save(self):
        for index, schema in enumerate((None, 'moy.asr.project.v1', 'moy.asr.project.v1.5')):
            with self.subTest(schema=schema):
                source = self.root / f'legacy-{index}.mosp'
                source.write_text(json.dumps(self.legacy(schema)), encoding='utf-8')
                before = source.read_bytes()
                project = self.load(source)
                self.assertEqual(source.read_bytes(), before)
                self.assertEqual(project.source_schema, schema or 'moy.asr.project.v1')
                self.assertTrue(project.import_changes)
                page = server_editor.build_server_page(project).decode('utf-8')
                self.assertIn('"requiresMigrationSaveAs": true', page)
                with server_editor.EditorServer(('127.0.0.1', 0), project, no_waveform=True) as server:
                    self.assertTrue(server.project_binding_payload()['requiresMigrationSaveAs'])
                    for options in ({}, {'filename': source.name}, {'backup_limit': 2, 'backup_only': True}, {'filename': ''}):
                        with self.subTest(options=options), self.assertRaises(server_editor.SaveProjectError):
                            server.save_project(project.data, **options)
                        self.assertEqual(source.read_bytes(), before)
                    occupied = self.root / f'occupied-{index}.mosp'
                    occupied.write_text('do not overwrite', encoding='utf-8')
                    with self.assertRaises(server_editor.SaveProjectError):
                        server.save_project(project.data, filename=occupied.name)
                    self.assertEqual(occupied.read_text(encoding='utf-8'), 'do not overwrite')
                    destination, _ = server.save_project(project.data, filename=f'converted-{index}.mosp')
                    self.assertEqual(source.read_bytes(), before)
                    self.assertEqual(json.loads(destination.read_text(encoding='utf-8'))['schema'], PROJECT_SCHEMA)
                    self.assertEqual(server.project.source_schema, PROJECT_SCHEMA)
                    self.assertEqual(server.project.import_changes, ())
                    self.assertFalse(server.project_binding_payload()['requiresMigrationSaveAs'])
                    self.assertEqual(self.load(destination).source_schema, PROJECT_SCHEMA)
                    server.save_project(server.project.data)
                    self.assertEqual(source.read_bytes(), before)

    def test_failed_exclusive_publish_never_overwrites_source_or_existing_target(self):
        source = self.root / 'legacy.mosp'
        source.write_text(json.dumps(self.legacy(None)), encoding='utf-8')
        before = source.read_bytes()
        project = self.load(source)
        destination = self.root / 'raced.mosp'
        def competing_writer(temp, target):
            destination.write_text('competitor', encoding='utf-8')
            raise FileExistsError('destination created concurrently')
        with server_editor.EditorServer(('127.0.0.1', 0), project, no_waveform=True) as server:
            with mock.patch.object(server_editor.os, 'rename' if server_editor.os.name == 'nt' else 'link', side_effect=competing_writer):
                with self.assertRaises(server_editor.SaveProjectError):
                    server.save_project(project.data, filename=destination.name)
            self.assertEqual(source.read_bytes(), before)
            self.assertEqual(destination.read_text(encoding='utf-8'), 'competitor')
            self.assertEqual(server.project.source_schema, 'moy.asr.project.v1')
            self.assertEqual(server.project.json_path, source)

    def test_remember_media_preserves_legacy_format(self):
        for index, schema in enumerate((None, 'moy.asr.project.v1', 'moy.asr.project.v1.5')):
            source = self.root / f'media-{index}.mosp'
            original = self.legacy(schema)
            source.write_text(json.dumps(original), encoding='utf-8')
            server_editor.remember_project_media(source, 'clip.wav')
            saved = json.loads(source.read_text(encoding='utf-8'))
            self.assertEqual(saved, {**original, 'media': 'clip.wav'})


if __name__ == '__main__':
    unittest.main()
