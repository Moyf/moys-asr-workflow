import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from datetime import datetime

from maw.project_backups import backup_directory, backup_directory_candidates, write_backup


class BackupTests(unittest.TestCase):
    def test_locations(self):
        with patch('maw.project_backups.resolve_lang', return_value='zh'):
            self.assertEqual(backup_directory(Path('folder/a.mosp')), Path('folder/_maw/备份'))
            for folder in ('_maw', 'clip_maw'):
                self.assertEqual(backup_directory(Path(folder) / 'a.mosp'), Path(folder) / '备份')
        with patch('maw.project_backups.resolve_lang', return_value='en'):
            self.assertEqual(backup_directory(Path('folder/a.mosp')), Path('folder/_maw/backups'))
            # 当前语言命名在前，另一种语言命名兜底（兼容切换界面语言前的旧目录）。
            candidates = backup_directory_candidates(Path('folder/a.mosp'))
            self.assertEqual(candidates, [Path('folder/_maw/backups'), Path('folder/_maw/备份')])

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
