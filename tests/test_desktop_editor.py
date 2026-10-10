"""Behavioral contracts for the private Electron host; public Server stays bounded."""

from __future__ import annotations

import json
import tempfile
import threading
import unittest
from unittest import mock
import urllib.error
import urllib.request
import wave
from pathlib import Path

from tests.test_local_editor_server import server_editor as server


class DesktopEditorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.editor = server.EditorServer(
            ("127.0.0.1", 0), server.ServerProject({"segments": []}, None, None, None, []),
            settings_path=self.root / "settings.json", no_waveform=True,
            desktop_mode=True, desktop_token="test-desktop-token", desktop_command_key="test-command-key",
        )
        self.addCleanup(self.editor.server_close)
        self.addCleanup(self.temp.cleanup)

    def project_file(self, name: str = "工程.mosp", **fields: object) -> Path:
        path = self.root / name
        path.write_text(json.dumps({"schema": "moy.asr.project.v1", "segments": [], **fields}), encoding="utf-8")
        return path

    def test_native_open_keeps_missing_media_project_editable_and_recent(self) -> None:
        path = self.project_file(media="missing.wav")
        project = self.editor.open_project_path(str(path))
        self.assertEqual(project.json_path, path)
        self.assertIsNone(project.media_path)
        self.assertEqual(project.data["media"], "missing.wav")
        self.assertEqual(self.editor.settings.recent_projects[0].path, path)
        target, _ = self.editor.save_project(project.data)
        self.assertEqual(target, path)
        self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["media"], "missing.wav")
        self.assertEqual(self.editor.open_recent_project(str(path)).json_path, path)

    def test_public_load_still_reports_missing_media(self) -> None:
        with self.assertRaises(server.MediaResolutionError):
            server.load_project(self.project_file(media="missing.wav"), None, None, no_waveform=True, peaks_per_second=100)

    def test_failed_native_save_preserves_binding_and_source_file(self) -> None:
        path = self.project_file(media="missing.wav")
        self.editor.open_project_path(str(path))
        original = path.read_bytes()
        generation = self.editor.project_generation
        target = self.root / "new.mosp"
        with mock.patch.object(server, "write_project_json", side_effect=OSError("write denied")):
            with self.assertRaisesRegex(OSError, "write denied"):
                self.editor.save_desktop_project(
                    "saveAs", self.editor.project.data, target_path=str(target),
                    expected_generation=generation, expected_revision=None, backup_limit=None,
                )
        self.assertEqual(self.editor.project.json_path, path)
        self.assertEqual(self.editor.project_generation, generation)
        self.assertEqual(path.read_bytes(), original)
        self.assertFalse(target.exists())

    def test_bad_project_does_not_replace_current_or_enter_recents(self) -> None:
        good = self.project_file()
        self.editor.open_project_path(str(good))
        bad = self.root / "bad.mosp"
        bad.write_text('{"schema": "unknown", "segments": []}', encoding="utf-8")
        with self.assertRaises(server.ProjectValidationFailed):
            self.editor.open_project_path(str(bad))
        self.assertEqual(self.editor.project.json_path, good)
        self.assertEqual([p.path for p in self.editor.settings.recent_projects], [good])

    def test_native_media_reassociation_preserves_file_and_rejects_stale_generation(self) -> None:
        path = self.project_file(media="missing.wav")
        self.editor.open_project_path(str(path))
        media = self.root / "chosen audio.wav"
        with wave.open(str(media), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(8000)
            output.writeframes(b"\x00\x00" * 8000)
        generation = self.editor.project_generation
        with mock.patch.object(server, "validate_desktop_media"):
            self.editor.attach_desktop_media(str(media), generation)
        self.assertEqual(self.editor.project.source_media_path, media)
        self.assertEqual(self.editor.project.json_path, path)
        self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["media"], "missing.wav")
        with self.assertRaises(server.ProjectMutationInProgressError):
            self.editor.attach_desktop_media(str(media), generation)
        with self.assertRaises(ValueError):
            self.editor.attach_desktop_media(str(self.root / "settings.json"), self.editor.project_generation)

    def test_private_state_requires_token_and_is_absent_in_public_server(self) -> None:
        thread = threading.Thread(target=self.editor.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(self.editor.shutdown)
        url = f"http://127.0.0.1:{self.editor.server_address[1]}/api/desktop/project/status"
        with self.assertRaises(urllib.error.HTTPError) as rejected:
            urllib.request.urlopen(url)
        self.assertEqual(rejected.exception.code, 403)
        request = urllib.request.Request(url, headers={"X-MAW-Desktop-Token": "test-desktop-token", "X-MAW-Desktop-Command-Key": "test-command-key"})
        with urllib.request.urlopen(request) as response:
            self.assertTrue(json.load(response)["ok"])
        self.editor.desktop_mode = False
        with self.assertRaises(urllib.error.HTTPError) as rejected:
            urllib.request.urlopen(url)
        self.assertEqual(rejected.exception.code, 404)
