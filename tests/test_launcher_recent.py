import json
from pathlib import Path
import tempfile
import unittest

from maw.launcher_recent import RecentProjects


class RecentProjectsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.store = RecentProjects(self.root / "state" / "recent.json")

    def project(self, name="project.mosp"):
        path = self.root / name
        path.write_text('{"private": "must not be copied"}', encoding="utf-8")
        # store 端会规范化路径（Windows TEMP 8.3 别名 / macOS /var 符号链接），期望值保持同一形式。
        return str(path.resolve())

    def test_empty_history_defaults_to_enabled_without_creating_a_file(self):
        self.assertEqual(self.store.get(), {"ok": True, "enabled": True, "entries": [], "limit": 30})
        self.assertFalse(self.store.path.exists())

    def test_remember_deduplicates_moves_to_front_and_stores_only_path_and_time(self):
        first = self.project("one.mosp")
        second = self.project("two.json")
        for path in (first, second, first):
            result = self.store.update({"action": "remember", "path": path})
        self.assertEqual([entry["path"] for entry in result["entries"]], [first, second])
        self.assertTrue(all(entry["exists"] for entry in result["entries"]))
        raw = json.loads(self.store.path.read_text(encoding="utf-8"))
        self.assertEqual(set(raw["entries"][0]), {"path", "openedAt"})
        self.assertNotIn("must not be copied", self.store.path.read_text(encoding="utf-8"))
        self.assertNotIn(b"\r", self.store.path.read_bytes())

    def test_retains_at_most_thirty_projects(self):
        for index in range(33):
            self.store.update({"action": "remember", "path": self.project(f"{index}.mosp")})
        entries = self.store.get()["entries"]
        self.assertEqual(len(entries), 30)
        self.assertEqual(Path(entries[-1]["path"]).name, "3.mosp")

    def test_disabled_history_does_not_record_new_projects(self):
        first = self.project()
        self.store.update({"action": "enabled", "enabled": False})
        self.store.update({"action": "remember", "path": first})
        restored = RecentProjects(self.store.path).get()
        self.assertFalse(restored["enabled"])
        self.assertEqual(restored["entries"], [])

    def test_missing_file_is_flagged_and_can_be_relocated(self):
        old = self.project()
        self.store.update({"action": "remember", "path": old})
        new = self.root / "moved.mosp"
        Path(old).rename(new)
        self.assertFalse(self.store.get()["entries"][0]["exists"])
        updated = self.store.update({"action": "relocate", "path": str(new), "previousPath": old})
        self.assertEqual(updated["entries"][0]["path"], str(new.resolve()))
        self.assertTrue(updated["entries"][0]["exists"])
        self.assertEqual(len(updated["entries"]), 1)

    def test_remove_and_clear_never_delete_project_files(self):
        path = self.project()
        self.store.update({"action": "remember", "path": path})
        self.store.update({"action": "remove", "path": path})
        self.assertTrue(Path(path).is_file())
        self.store.update({"action": "remember", "path": path})
        self.store.update({"action": "clear"})
        self.assertTrue(Path(path).is_file())
        self.assertEqual(self.store.get()["entries"], [])

    def test_disabled_history_still_allows_manual_relocation(self):
        old = self.project()
        self.store.update({"action": "remember", "path": old})
        self.store.update({"action": "enabled", "enabled": False})
        new = self.root / "moved.mosp"
        Path(old).rename(new)
        result = self.store.update({"action": "relocate", "path": str(new), "previousPath": old})
        self.assertFalse(result["enabled"])
        self.assertEqual([entry["path"] for entry in result["entries"]], [str(new.resolve())])

    def test_invalid_paths_actions_and_booleans_are_rejected(self):
        for payload in [
            {"action": "remember", "path": "relative.mosp"},
            {"action": "remember", "path": str(self.root / "missing.mosp")},
            {"action": "remember", "path": self.project("not-a-project.txt")},
            {"action": "remember", "path": []},
            {"action": "enabled", "enabled": "false"},
            {"action": "unknown"},
        ]:
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                self.store.update(payload)

    def test_relocate_requires_an_existing_history_entry(self):
        with self.assertRaises(ValueError):
            self.store.update({"action": "relocate", "path": self.project(), "previousPath": "unknown.mosp"})

    def test_corrupt_or_malformed_storage_is_safe(self):
        self.store.path.parent.mkdir()
        for raw in ["not JSON", "[]", '{"entries": 3}', '{"entries": [null, 4, {"path": "relative.mosp", "openedAt": "now"}]}']:
            with self.subTest(raw=raw):
                self.store.path.write_text(raw, encoding="utf-8")
                self.assertEqual(self.store.get()["entries"], [])


if __name__ == "__main__":
    unittest.main()
