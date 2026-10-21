"""maw.recent_projects 的宽容读取与 Launcher recent_projects 桥。

编辑器侧的持久化格式归 server-editor/serve.py 所有；本模块是 Launcher GUI
进程内的只读镜像，这里同时守护两者对 recent_projects 列表的对齐语义。
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from maw.app_paths import SERVER_SETTINGS_FILE_NAME
from maw.gui_web import LauncherApi, LauncherPaths
from maw.recent_projects import MAX_RECENT_PROJECTS, load_recent_projects, read_recent_projects


class RecentProjectsReaderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        # Load the real editor reader only in tests: the Launcher must stay light.
        server_path = Path(__file__).resolve().parents[1] / "server-editor" / "serve.py"
        spec = importlib.util.spec_from_file_location("recent_projects_editor_contract", server_path)
        assert spec and spec.loader
        cls.server_editor = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = cls.server_editor
        spec.loader.exec_module(cls.server_editor)

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.addCleanup(self.temp_dir.cleanup)

    def write_settings(self, payload: object) -> Path:
        path = self.root / SERVER_SETTINGS_FILE_NAME
        text = payload if isinstance(payload, str) else json.dumps(payload)
        path.write_text(text, encoding="utf-8")
        return path

    def test_reads_entries_in_order_and_marks_missing_files(self) -> None:
        existing = self.root / "clip.mosp"
        existing.write_text("{}", encoding="utf-8")
        settings = self.write_settings({"recent_projects": [
            {"path": str(existing), "name": "clip.mosp"},
            {"path": str(self.root / "gone.json"), "name": "gone.json"},
        ]})

        projects = read_recent_projects(settings)

        self.assertEqual([item["name"] for item in projects], ["clip.mosp", "gone.json"])
        self.assertNotIn("exists", projects[0])
        self.assertIs(projects[1]["exists"], False)
        self.assertEqual(Path(str(projects[0]["path"])), existing.resolve())

    def test_dedupes_by_resolved_path_and_caps_at_ten(self) -> None:
        target = self.root / "only.mosp"
        entries = [{"path": str(target)}] * 3
        entries += [{"path": str(self.root / f"p{i}.mosp")} for i in range(MAX_RECENT_PROJECTS + 2)]
        settings = self.write_settings({"recent_projects": entries})

        projects = read_recent_projects(settings)

        self.assertEqual(len(projects), MAX_RECENT_PROJECTS)
        self.assertEqual(len({item["path"] for item in projects}), MAX_RECENT_PROJECTS)
        self.assertEqual(projects[0]["name"], "only.mosp")

    def test_name_falls_back_to_file_name(self) -> None:
        settings = self.write_settings({"recent_projects": [
            {"path": str(self.root / "named.mosp"), "name": "显示名"},
            {"path": str(self.root / "fallback.mosp"), "name": ""},
            {"path": str(self.root / "fallback2.mosp"), "name": 42},
        ]})

        projects = read_recent_projects(settings)

        self.assertEqual([item["name"] for item in projects], ["显示名", "fallback.mosp", "fallback2.mosp"])

    def test_skips_invalid_entries(self) -> None:
        settings = self.write_settings({"recent_projects": [
            "junk",
            None,
            {"name": "no path"},
            {"path": 12},
            {"path": str(self.root / "ok.mosp")},
        ]})

        projects = read_recent_projects(settings)

        self.assertEqual([item["name"] for item in projects], ["ok.mosp"])

    def test_malformed_payloads_yield_empty_list(self) -> None:
        for payload in ("{not json", "[]", '{"recent_projects": "nope"}', "42"):
            with self.subTest(payload=payload):
                settings = self.write_settings(payload)
                self.assertEqual(read_recent_projects(settings), [])

    def test_missing_file_yields_empty_list(self) -> None:
        self.assertEqual(read_recent_projects(self.root / "absent.json"), [])

    def test_expanduser_resolves_home_relative_paths(self) -> None:
        settings = self.write_settings({"recent_projects": [{"path": "~/docs/clip.mosp"}]})

        with mock.patch.dict(os.environ, {"HOME": str(self.root), "USERPROFILE": str(self.root)}):
            projects = read_recent_projects(settings)

        self.assertEqual(projects[0]["path"], str((self.root / "docs" / "clip.mosp").resolve()))

    def test_reader_matches_editor_for_shared_settings_inputs(self) -> None:
        existing = self.root / "现有工程.mosp"
        existing.write_text("{}", encoding="utf-8")
        directory = self.root / "folder.mosp"
        directory.mkdir()
        cases = {
            "paths_and_existence": {"recent_projects": [
                {"path": str(existing), "name": "显示名"},
                {"path": str(directory)},
                {"path": "~/docs/missing.mosp"},
                {"path": "relative.mosp"},
            ]},
            "name_fallbacks": {"recent_projects": [
                {"path": str(self.root / "empty.mosp"), "name": ""},
                {"path": str(self.root / "numeric.mosp"), "name": 42},
                {"path": str(self.root / "absent.mosp")},
            ]},
            "duplicates_and_limit": {"recent_projects": [
                {"path": str(existing), "name": "first wins"},
                {"path": str(self.root / "subdir" / ".." / existing.name), "name": "duplicate"},
                *[{"path": str(self.root / f"p{i}.mosp")} for i in range(12)],
            ]},
            "invalid_entries": {"recent_projects": [
                "junk", None, 12, {}, {"name": "no path"}, {"path": 42},
                {"path": str(existing)},
            ]},
            "missing_list": {},
            "invalid_list": {"recent_projects": "nope"},
            "invalid_root": [],
            "malformed_json": "{not json",
        }
        with mock.patch.dict(os.environ, {"HOME": str(self.root), "USERPROFILE": str(self.root)}):
            for name, payload in cases.items():
                with self.subTest(case=name):
                    settings = self.write_settings(payload)
                    editor_projects = [
                        project.to_json()
                        for project in self.server_editor.read_server_settings(settings).recent_projects
                    ]
                    self.assertEqual(read_recent_projects(settings), editor_projects)

    def test_missing_settings_matches_editor(self) -> None:
        settings = self.root / "absent.json"

        self.assertEqual(
            read_recent_projects(settings),
            [project.to_json() for project in self.server_editor.read_server_settings(settings).recent_projects],
        )


class LoadRecentProjectsFallbackTests(unittest.TestCase):
    """load_recent_projects 的默认路径与 legacy 回退（对齐 serve.py 的读取顺序）。"""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.addCleanup(self.temp_dir.cleanup)
        self.app_root = self.root / "app-data"
        # legacy 路径也要隔离：开发机可能存在真实的旧版设置文件。
        self.legacy_base = self.root / "legacy-share"
        self.legacy_env = (
            {"LOCALAPPDATA": str(self.legacy_base)}
            if sys.platform == "win32"
            else {"XDG_DATA_HOME": str(self.legacy_base)}
        )
        self.env_patcher = mock.patch.dict(
            os.environ, {"MAW_APP_DATA_ROOT": str(self.app_root), **self.legacy_env}
        )
        self.env_patcher.start()
        self.addCleanup(self.env_patcher.stop)

    def test_reads_default_settings_path(self) -> None:
        path = self.app_root / SERVER_SETTINGS_FILE_NAME
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"recent_projects": [{"path": str(self.root / "a.mosp")}]}), encoding="utf-8")

        projects = load_recent_projects()

        self.assertEqual([item["name"] for item in projects], ["a.mosp"])

    def test_falls_back_to_legacy_settings_path_once(self) -> None:
        legacy_path = self.legacy_base / "Moy" / "moys-asr-workflow" / SERVER_SETTINGS_FILE_NAME
        legacy_path.parent.mkdir(parents=True, exist_ok=True)
        legacy_path.write_text(json.dumps({"recent_projects": [{"path": str(self.root / "b.mosp")}]}), encoding="utf-8")

        projects = load_recent_projects()

        self.assertEqual([item["name"] for item in projects], ["b.mosp"])

    def test_returns_empty_without_any_settings_file(self) -> None:
        self.assertEqual(load_recent_projects(), [])


class RecentProjectsBridgeTests(unittest.TestCase):
    """LauncherApi.recent_projects 桥：返回 ok + projects，绝不抛异常。"""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.addCleanup(self.temp_dir.cleanup)
        self.app_root = self.root / "app-data"
        # legacy 路径也要隔离：开发机可能存在真实的旧版设置文件。
        legacy_base = self.root / "legacy-share"
        legacy_env = (
            {"LOCALAPPDATA": str(legacy_base)}
            if sys.platform == "win32"
            else {"XDG_DATA_HOME": str(legacy_base)}
        )
        env_patcher = mock.patch.dict(
            os.environ, {"MAW_APP_DATA_ROOT": str(self.app_root), **legacy_env}
        )
        env_patcher.start()
        self.addCleanup(env_patcher.stop)
        paths = LauncherPaths(root=self.root, env_path=self.root / ".env", launcher_html=self.root / "launcher.html")
        self.api = LauncherApi(paths=paths, window_getter=lambda: None)

    def write_settings(self, payload: object) -> Path:
        path = self.app_root / SERVER_SETTINGS_FILE_NAME
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(payload if isinstance(payload, str) else json.dumps(payload), encoding="utf-8")
        return path

    def test_bridge_returns_entries_from_settings_file(self) -> None:
        existing = self.root / "clip.mosp"
        existing.write_text("{}", encoding="utf-8")
        self.write_settings({"recent_projects": [
            {"path": str(existing), "name": "clip.mosp"},
            {"path": str(self.root / "gone.json"), "name": "gone.json"},
        ]})

        result = self.api.recent_projects({})

        self.assertTrue(result["ok"])
        self.assertEqual([item["name"] for item in result["projects"]], ["clip.mosp", "gone.json"])
        self.assertIs(result["projects"][1]["exists"], False)

    def test_bridge_returns_empty_list_without_settings_file(self) -> None:
        self.assertEqual(self.api.recent_projects({}), {"ok": True, "projects": []})

    def test_bridge_falls_back_to_legacy_settings_path(self) -> None:
        legacy_path = (self.root / "legacy-share") / "Moy" / "moys-asr-workflow" / SERVER_SETTINGS_FILE_NAME
        legacy_path.parent.mkdir(parents=True, exist_ok=True)
        legacy_path.write_text(json.dumps({"recent_projects": [{"path": str(self.root / "legacy.mosp")}]}), encoding="utf-8")

        result = self.api.recent_projects({})

        self.assertEqual([item["name"] for item in result["projects"]], ["legacy.mosp"])

    def test_bridge_tolerates_malformed_settings_file(self) -> None:
        self.write_settings("{not json")

        self.assertEqual(self.api.recent_projects({}), {"ok": True, "projects": []})


if __name__ == "__main__":
    unittest.main()
