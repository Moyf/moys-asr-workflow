from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "server-editor" / "serve.py"
SPEC = importlib.util.spec_from_file_location("asr_local_editor_server", SERVER_PATH)
assert SPEC and SPEC.loader
server_editor = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = server_editor
SPEC.loader.exec_module(server_editor)


class LocalEditorServerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        # Windows CI may expose %TEMP% as an 8.3 short path while production code resolves it.
        self.root = Path(self.temp_dir.name).resolve()
        self.media = self.root / "clip.mp3"
        self.media.write_bytes(b"0123456789")
        self.stickers = self.root / "stickers"
        (self.stickers / "nested").mkdir(parents=True)
        (self.stickers / "nested" / "cat.png").write_bytes(b"png")
        self.project_path = self.root / "clip.json"
        self.project_path.write_text(
            json.dumps({"media": str(self.media), "segments": []}), encoding="utf-8",
        )
        self.other_media = self.root / "other.mp3"
        self.other_media.write_bytes(b"abcdefghij")
        self.other_project_path = self.root / "other.json"
        self.other_project_path.write_text(
            json.dumps({"media": str(self.other_media), "segments": []}), encoding="utf-8",
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_range_parser_handles_standard_and_suffix_ranges(self) -> None:
        self.assertEqual(server_editor.parse_byte_range("bytes=2-5", 10), (2, 5))
        self.assertEqual(server_editor.parse_byte_range("bytes=7-", 10), (7, 9))
        self.assertEqual(server_editor.parse_byte_range("bytes=-3", 10), (7, 9))
        with self.assertRaises(ValueError):
            server_editor.parse_byte_range("bytes=10-", 10)

    def test_server_page_uses_shared_template_and_routes_stickers(self) -> None:
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        settings = server_editor.remember_project(server_editor.ServerSettings(), self.project_path)
        page = server_editor.build_server_page(project, settings).decode("utf-8")
        self.assertIn('src="/media"', page)
        self.assertIn('let STICKER_URL_PREFIX = "/stickers";', page)
        self.assertIn('const SERVER_CONFIG = {"saveUrl": "/api/project", "canSave": true, ', page)
        self.assertIn('"autoLoadedMediaName": "clip.mp3", "recentProjectsUrl": "/api/recent-projects/open", ', page)
        self.assertIn('"settingsUrl": "/api/settings", "recentProjects": [{"path": "', page)
        self.assertIn('"name": "clip.json"}], "autoOpenLastProject": true, "savedWorkspaces": {}, ', page)
        self.assertIn('"presetWorkspaces": {}, ', page)
        self.assertIn('"activeWorkspaceName": ""};', page)
        self.assertIn('id="save-project"', page)
        self.assertIn('id="save-project-as"', page)
        self.assertIn('id="save-project-dropdown"', page)
        self.assertIn('id="open-project-dropdown"', page)
        self.assertIn('id="load-srt"', page)
        self.assertIn('id="load-srt-file"', page)
        self.assertIn('function parseSrtSegments(text)', page)
        self.assertIn('function isMawProject(data)', page)
        self.assertIn('请使用 MAW 生成的工程文件', page)

        self.assertIn('id="server-auto-save-settings"', page)
        self.assertIn('id="auto-save-project"', page)
        self.assertIn('id="auto-save-project" checked', page)
        self.assertIn('id="auto-save-interval"', page)
        self.assertLess(page.index('editor-settings-title">导出'), page.index('id="server-auto-save-settings"'))
        self.assertIn('function scheduleAutoSave()', page)
        self.assertIn('hasUnsavedProjectChanges() && !projectSaveInFlight', page)
        self.assertIn('id="recent-projects"', page)
        self.assertIn('id="auto-open-last-project"', page)
        self.assertLess(page.index('id="auto-open-last-project"'), page.index('id="recent-projects-list"'))
        self.assertIn("const STORAGE_KEY = 'mawe.language';", page)
        self.assertIn('class="waveform-mode-switch"', page)
        self.assertIn('data-saved-workspaces', page)
        self.assertIn('id="workspace-save-as"', page)
        self.assertIn('function configureServerWorkspaceLibrary()', page)

        with server_editor.EditorServer(("127.0.0.1", 0), project) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                base_url = f"http://127.0.0.1:{server.server_address[1]}"
                request = urllib.request.Request(f"{base_url}/media", headers={"Range": "bytes=2-5"})
                with urllib.request.urlopen(request) as response:
                    self.assertEqual(response.status, 206)
                    self.assertEqual(response.headers["Content-Range"], "bytes 2-5/10")
                    self.assertEqual(response.read(), b"2345")
                with urllib.request.urlopen(f"{base_url}/stickers/nested/cat.png") as response:
                    self.assertEqual(response.read(), b"png")
            finally:
                server.shutdown()
                thread.join(timeout=2)

    def test_flv_project_uses_persistent_conversion_without_overwriting_project_media(self) -> None:
        source = self.root / "clip.flv"
        source.write_bytes(b"flv")
        project_path = self.root / "flv.json"
        project_path.write_text(json.dumps({"media": str(source), "segments": []}), encoding="utf-8")
        converted = self.root / "cache" / "clip.mp4"
        converted.parent.mkdir()
        converted.write_bytes(b"mp4")

        with mock.patch.object(server_editor, "convert_media_for_browser", return_value=converted) as convert:
            project = server_editor.load_project(
                project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
            )

        convert.assert_called_once_with(source.resolve(), ffmpeg_path=mock.ANY)
        self.assertEqual(project.media_path, converted)
        self.assertEqual(project.source_media_path, source.resolve())
        self.assertEqual(project.data["media"], str(source.resolve()))

    def test_mosp_save_backup_keeps_mosp_extension(self) -> None:
        target = self.root / "copy.mosp"
        target.write_text('{"segments": []}\n', encoding="utf-8")
        backup = server_editor.write_project_json(target, {"segments": [{"start": 0, "end": 1, "text": "x"}]})

        self.assertIsNotNone(backup)
        self.assertEqual(backup.name, "copy.mosp.bak")
        self.assertEqual(backup.read_text(encoding="utf-8"), '{"segments": []}\n')

    def test_recent_projects_are_limited_to_ten_and_persisted_as_lf_json(self) -> None:
        settings = server_editor.ServerSettings()
        paths = []
        for index in range(12):
            project_path = self.root / f"project-{index}.json"
            paths.append(project_path)
            settings = server_editor.remember_project(settings, project_path)

        self.assertTrue(settings.auto_open_last_project)
        self.assertEqual(len(settings.recent_projects), 10)
        self.assertEqual(settings.recent_projects[0].path, paths[-1].resolve())
        self.assertNotIn(paths[0].resolve(), [item.path for item in settings.recent_projects])

        settings_path = self.root / "server-editor-settings.json"
        server_editor.write_server_settings(settings_path, settings)
        saved = settings_path.read_bytes()
        self.assertNotIn(b"\r\n", saved)
        self.assertTrue(saved.endswith(b"\n"))
        self.assertEqual(server_editor.read_server_settings(settings_path), settings)

    def test_recent_project_endpoint_reloads_media_and_updates_setting(self) -> None:
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        settings_path = self.root / "server-editor-settings.json"
        settings = server_editor.remember_project(server_editor.ServerSettings(), self.project_path)
        settings = server_editor.remember_project(settings, self.other_project_path)
        with server_editor.EditorServer(
            ("127.0.0.1", 0),
            project,
            settings=settings,
            settings_path=settings_path,
            stickers_dir=str(self.stickers),
            no_waveform=True,
            peaks_per_second=100,
        ) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                base_url = f"http://127.0.0.1:{server.server_address[1]}"

                def post(endpoint: str, payload: dict) -> tuple[int, dict]:
                    request = urllib.request.Request(
                        f"{base_url}{endpoint}",
                        data=json.dumps(payload).encode("utf-8"),
                        headers={"Content-Type": "application/json"},
                        method="POST",
                    )
                    try:
                        with urllib.request.urlopen(request) as response:
                            return response.status, json.loads(response.read())
                    except urllib.error.HTTPError as error:
                        return error.code, json.loads(error.read())

                status, result = post("/api/recent-projects/open", {"path": str(self.other_project_path)})
                self.assertEqual(status, 200)
                self.assertTrue(result["ok"])
                self.assertEqual(result["name"], "other.json")
                self.assertEqual(result["mediaName"], "other.mp3")
                self.assertEqual(server.project.json_path, self.other_project_path)
                self.assertEqual(server.project.media_path, self.other_media)
                self.assertEqual(server.settings.recent_projects[0].path, self.other_project_path)

                status, result = post("/api/settings", {"autoOpenLastProject": False})
                self.assertEqual(status, 200)
                self.assertTrue(result["ok"])
                self.assertFalse(server.settings.auto_open_last_project)
                self.assertFalse(server_editor.read_server_settings(settings_path).auto_open_last_project)

                workspace = {"schema": "moy.asr.editor.workspace.v1", "preset": "custom", "tree": {}}
                status, result = post("/api/settings", {
                    "saveWorkspace": {"name": "测试工作区", "workspace": workspace, "overwrite": False},
                })
                self.assertEqual(status, 200)
                self.assertTrue(result["ok"])
                self.assertEqual(server.settings.saved_workspaces["测试工作区"], workspace)

                status, result = post("/api/settings", {
                    "savePresetWorkspace": {"preset": "wave-right", "workspace": workspace},
                })
                self.assertEqual(status, 200)
                self.assertTrue(result["ok"])
                self.assertEqual(result["presetWorkspaces"]["wave-right"], workspace)

                status, result = post("/api/recent-projects/open", {"path": str(self.root / "unknown.json")})
                self.assertEqual(status, 400)
                self.assertFalse(result["ok"])
            finally:
                server.shutdown()
                thread.join(timeout=2)

    def test_saved_workspaces_are_persisted_and_reused_by_new_projects(self) -> None:
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        settings_path = self.root / "server-editor-settings.json"
        workspace = {
            "schema": 1,
            "preset": "custom",
            "columnPercent": 46,
            "rows": [30, 40, 30],
            "tree": {"type": "leaf", "id": "waveform"},
        }
        with server_editor.EditorServer(
            ("127.0.0.1", 0), project, settings_path=settings_path,
        ) as server:
            server.save_workspace("剪辑工作区", workspace, overwrite=False)
            self.assertEqual(server.settings.active_workspace_name, "剪辑工作区")
            self.assertEqual(server_editor.read_server_settings(settings_path).saved_workspaces["剪辑工作区"], workspace)

            page = server_editor.build_server_page(server.project, server.settings).decode("utf-8")
            self.assertIn('"workspace": {"schema": 1, "preset": "custom"', page)
            self.assertIn('"savedWorkspaces": {"剪辑工作区": {"schema": 1', page)

            with self.assertRaisesRegex(ValueError, "同名工作区"):
                server.save_workspace("剪辑工作区", workspace, overwrite=False)
            server.save_workspace("剪辑工作区", {**workspace, "columnPercent": 55}, overwrite=True)
            self.assertEqual(server.settings.saved_workspaces["剪辑工作区"]["columnPercent"], 55)
            server.delete_workspace("剪辑工作区")
            self.assertEqual(server.settings.active_workspace_name, "")
            self.assertEqual(server.settings.saved_workspaces, {})

            server.save_preset_workspace("wave-right", workspace)
            self.assertEqual(server.settings.preset_workspaces["wave-right"], workspace)
            server.save_preset_workspace("three-fold", workspace)
            self.assertEqual(server.settings.preset_workspaces["three-fold"], workspace)
            server.reset_preset_workspace("wave-right")
            self.assertEqual(server.settings.preset_workspaces, {"three-fold": workspace})
            server.reset_preset_workspace("three-fold")
            self.assertEqual(server.settings.preset_workspaces, {})
            with self.assertRaisesRegex(ValueError, "内置工作区"):
                server.save_preset_workspace("custom", workspace)

    def test_server_saves_project_with_backup_and_rejects_unsafe_save_as(self) -> None:
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        original = self.project_path.read_bytes()
        with server_editor.EditorServer(("127.0.0.1", 0), project) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                base_url = f"http://127.0.0.1:{server.server_address[1]}"

                def post(payload: dict) -> tuple[int, dict]:
                    request = urllib.request.Request(
                        f"{base_url}/api/project",
                        data=json.dumps(payload).encode("utf-8"),
                        headers={"Content-Type": "application/json"},
                        method="POST",
                    )
                    try:
                        with urllib.request.urlopen(request) as response:
                            return response.status, json.loads(response.read())
                    except urllib.error.HTTPError as error:
                        return error.code, json.loads(error.read())

                saved_project = {
                    "media": str(self.media),
                    "segments": [{"start": 0, "end": 1000, "text": "保存后的字幕"}],
                }
                status, result = post({"project": saved_project, "filename": None})
                self.assertEqual(status, 200)
                self.assertTrue(result["ok"])
                self.assertEqual(result["filename"], "clip.json")
                self.assertEqual(result["backup"], "clip.json.bak")
                self.assertEqual(self.project_path.with_suffix(".json.bak").read_bytes(), original)
                saved_bytes = self.project_path.read_bytes()
                self.assertNotIn(b"\r\n", saved_bytes)
                self.assertTrue(saved_bytes.endswith(b"\n"))
                self.assertEqual(json.loads(saved_bytes), saved_project)

                status, result = post({"project": saved_project, "filename": "copy.json"})
                copied_path = self.root / "copy.json"
                self.assertEqual(status, 200)
                self.assertEqual(result["filename"], "copy.json")
                self.assertIsNone(result["backup"])
                self.assertEqual(json.loads(copied_path.read_text(encoding="utf-8")), saved_project)
                self.assertEqual(server.project.json_path, copied_path)

                status, result = post({"project": saved_project, "filename": "../outside.json"})
                self.assertEqual(status, 400)
                self.assertFalse(result["ok"])
                self.assertFalse((self.root.parent / "outside.json").exists())
            finally:
                server.shutdown()
                thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
