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
        self.root = Path(self.temp_dir.name)
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
        self.assertIn('const STICKER_URL_PREFIX = "/stickers";', page)
        self.assertIn(
            'const SERVER_CONFIG = {"saveUrl": "/api/project", "canSave": true, '
            '"autoLoadedMediaName": "clip.mp3", "recentProjectsUrl": "/api/recent-projects/open", '
            '"settingsUrl": "/api/settings", "recentProjects": [{"path": "',
            page,
        )
        self.assertIn('"name": "clip.json"}], "autoOpenLastProject": true};', page)
        self.assertIn('id="save-project"', page)
        self.assertIn('id="save-project-as"', page)
        self.assertIn('id="recent-projects"', page)
        self.assertIn('id="auto-open-last-project"', page)
        self.assertLess(page.index('id="auto-open-last-project"'), page.index('id="recent-projects-list"'))
        self.assertIn("const STORAGE_KEY = 'mawe.language';", page)
        self.assertIn('class="waveform-mode-switch"', page)

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

                status, result = post("/api/recent-projects/open", {"path": str(self.root / "unknown.json")})
                self.assertEqual(status, 400)
                self.assertFalse(result["ok"])
            finally:
                server.shutdown()
                thread.join(timeout=2)

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
