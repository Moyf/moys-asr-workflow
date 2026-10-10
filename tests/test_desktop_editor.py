"""Behavioral contracts for the private Electron host; public Server stays bounded."""

from __future__ import annotations

import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import wave
from pathlib import Path

from tests.test_local_editor_server import server_editor as server


class DesktopEditorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.editor = server.EditorServer(
            ("127.0.0.1", 0), server.ServerProject({"segments": []}, None, None, None, []),
            settings_path=self.root / "settings.json", no_waveform=True,
            desktop_mode=True, desktop_token="test-desktop-token",
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

    def test_save_snapshot_rebases_relative_media_without_writing_a_file(self) -> None:
        path = self.project_file(media="missing.wav")
        self.editor.open_project_path(str(path))
        snapshot = {**self.editor.project.data, "waveform": {"cached": True}}
        result = self.editor.prepare_desktop_project(snapshot)
        self.assertEqual(result["media"], (self.root / "missing.wav").as_posix())
        self.assertNotIn("waveform", result)
        self.assertIn("waveform", snapshot)
        self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["media"], "missing.wav")
        self.assertEqual(self.editor.prepare_desktop_project({"segments": [], "media": ""}, new_project=True)["media"], "")
        with self.assertRaises(ValueError):
            self.editor.prepare_desktop_project(None)

    def test_bad_project_does_not_replace_current_or_enter_recents(self) -> None:
        good = self.project_file()
        self.editor.open_project_path(str(good))
        bad = self.root / "bad.mosp"
        bad.write_text('{"schema": "unknown", "segments": []}', encoding="utf-8")
        with self.assertRaises(server.ProjectValidationFailed):
            self.editor.open_project_path(str(bad))
        self.assertEqual(self.editor.project.json_path, good)
        self.assertEqual([p.path for p in self.editor.settings.recent_projects], [good])

    def test_native_media_preview_commits_only_after_acceptance_and_rejects_stale_ticket(self) -> None:
        path = self.project_file(media="missing.wav")
        self.editor.open_project_path(str(path))
        media = self.root / "chosen audio.wav"
        with wave.open(str(media), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(8000)
            output.writeframes(b"\x00\x00" * 8000)
        snapshot = {**self.editor.project.data, "waveform": {"old": True}}
        preview = self.editor.stage_desktop_media(str(media), snapshot)
        self.assertIsNone(self.editor.project.media_path)
        self.assertNotIn("waveform", preview["project"])
        self.editor.commit_desktop_media(preview["ticket"])
        self.assertEqual(self.editor.project.source_media_path, media)
        self.assertEqual(self.editor.project.json_path, path)
        self.assertEqual(self.editor.project.data["media"], media.as_posix())
        self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["media"], "missing.wav")
        stale = self.editor.stage_desktop_media(str(media), self.editor.project.data)
        self.editor.open_project_path(str(path))
        with self.assertRaises(server.ProjectMutationInProgressError):
            self.editor.commit_desktop_media(stale["ticket"])
        with self.assertRaises(ValueError):
            self.editor.stage_desktop_media(str(self.root / "settings.json"), snapshot)

    def test_private_state_requires_token_and_is_absent_in_public_server(self) -> None:
        thread = threading.Thread(target=self.editor.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(self.editor.shutdown)
        url = f"http://127.0.0.1:{self.editor.server_address[1]}/api/desktop/state"
        with self.assertRaises(urllib.error.HTTPError) as rejected:
            urllib.request.urlopen(url)
        self.assertEqual(rejected.exception.code, 403)
        request = urllib.request.Request(url, headers={"X-MAW-Desktop-Token": "test-desktop-token"})
        with urllib.request.urlopen(request) as response:
            self.assertTrue(json.load(response)["ok"])
        self.editor.desktop_mode = False
        with self.assertRaises(urllib.error.HTTPError) as rejected:
            urllib.request.urlopen(url)
        self.assertEqual(rejected.exception.code, 404)
