import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from datetime import datetime

from maw.project_backups import backup_directory, write_backup


class BackupTests(unittest.TestCase):
    def test_locations(self):
        self.assertEqual(backup_directory(Path('folder/a.mosp')), Path('folder/_maw/backups'))
        for folder in ('_maw', 'clip_maw'):
            self.assertEqual(backup_directory(Path(folder) / 'a.mosp'), Path(folder) / 'backups')

    def test_collision_retention_and_project_isolation(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp).resolve() / 'project.mosp'
            other = write_backup(project.with_name('project-other.mosp'), {'segments': []}, 2)
            with patch('maw.project_backups.datetime') as clock, patch('maw.project_backups.send2trash') as trash:
                clock.now.return_value = datetime(2026, 6, 26, 16, 59, 3)
                first = write_backup(project, {'segments': [], 'waveform': {'peaks': []}}, 2)
                second = write_backup(project, {'segments': []}, 2)
                third = write_backup(project, {'segments': [], 'language': 'zh'}, 2)
                trash.assert_called_once_with(str(first))
            self.assertEqual(first.name, 'project-2026-06-26_165903.mosp-bak')
            self.assertTrue(second.exists())
            self.assertTrue(other.exists())
            self.assertEqual(json.loads(third.read_text(encoding='utf-8'))['language'], 'zh')
            self.assertNotIn(b'\r', third.read_bytes())
            self.assertFalse(project.exists())

    def test_invalid_limits_do_not_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / 'a.mosp'
            for limit in (0, -1, 1001, True, '20', 1.5):
                with self.assertRaises(ValueError):
                    write_backup(project, {}, limit)
            self.assertFalse(backup_directory(project).exists())
