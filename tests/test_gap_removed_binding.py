from __future__ import annotations

import json
import tempfile
import threading
import urllib.error
import urllib.request
import unittest
from dataclasses import replace
from pathlib import Path
from unittest import mock

from tests.test_local_editor_server import server_editor


class GapRemovedBindingTests(unittest.TestCase):
    def setUp(self):
        self.project = server_editor.ServerProject(
            data={"segments": []}, json_path=Path("bound.mosp"),
            media_path=Path("browser-cache.mp4"), source_media_path=Path("source.mp4"),
            sticker_root=None, stickers=[],
        )
        self.server = server_editor.EditorServer(("127.0.0.1", 0), self.project, no_waveform=True)
        self.addCleanup(self.server.server_close)

    def rebind(self, project=None):
        with self.server.settings_lock:
            self.server._bind_project_locked(project or self.project)

    def test_reopening_identical_project_rotates_both_fields(self):
        old = self.server.project_binding_payload()
        self.rebind()
        current = self.server.project_binding_payload()
        self.assertEqual(current["bindingGeneration"], old["bindingGeneration"] + 1)
        self.assertNotEqual(current["sourceMediaId"], old["sourceMediaId"])
        self.assertNotIn("source.mp4", current["sourceMediaId"])
        with self.assertRaises(server_editor.ProjectBindingChangedError):
            self.server.gap_removed_video_source_snapshot(old)

    def test_snapshot_uses_original_source_and_releases_settings_lock(self):
        source = self.server.gap_removed_video_source_snapshot(self.server.project_binding_payload())
        self.assertEqual(source, Path("source.mp4"))
        acquired = self.server.settings_lock.acquire(blocking=False)
        self.assertTrue(acquired)
        if acquired:
            self.server.settings_lock.release()
        self.rebind(replace(self.project, source_media_path=Path("new.mp4")))
        self.assertEqual(source, Path("source.mp4"))

    def test_identity_requires_both_strict_fields(self):
        binding = self.server.project_binding_payload()
        for bad in ({}, {**binding, "bindingGeneration": True},
                    {**binding, "bindingGeneration": 1.0},
                    {**binding, "sourceMediaId": "wrong"}):
            with self.subTest(bad=bad), self.assertRaises(server_editor.ProjectBindingChangedError):
                self.server.gap_removed_video_source_snapshot(bad)

    def test_initial_load_and_recent_reopen_rotate_binding(self):
        old = self.server.project_binding_payload()
        self.server._load_initial_project(lambda _: self.project)
        self.assertGreater(self.server.binding_generation, old["bindingGeneration"])
        current = self.server.project_binding_payload()
        self.server.settings = server_editor.remember_project(self.server.settings, self.project.json_path)
        with mock.patch.object(server_editor, "load_project", return_value=self.project):
            self.server.open_recent_project(str(self.project.json_path))
        self.assertGreater(self.server.binding_generation, current["bindingGeneration"])

    def test_autosave_keeps_binding_but_save_as_rotates_it(self):
        old = self.server.project_binding_payload()
        with mock.patch.object(server_editor, "normalize_project", side_effect=lambda value: value), \
                mock.patch.object(server_editor, "write_project_json", return_value=None):
            self.server.save_project({"segments": []})
            self.assertEqual(self.server.project_binding_payload(), old)
            self.server.save_project({"segments": []}, filename="renamed.mosp")
        self.assertGreater(self.server.binding_generation, old["bindingGeneration"])

    def test_browser_attach_rotates_binding_even_for_same_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.mp4"
            source.write_bytes(b"fixture")
            project_path = root / "source.mosp"
            project_path.write_text('{}', encoding="utf-8")
            project = replace(self.project, json_path=project_path, source_media_path=source)
            self.rebind(project)
            old = self.server.project_binding_payload()
            browser = {"media": str(source), "segments": []}
            with mock.patch.object(server_editor, "load_project", return_value=project):
                self.server.attach_project(project_path.name, browser)
            self.assertGreater(self.server.binding_generation, old["bindingGeneration"])
            self.assertNotEqual(self.server.source_media_id, old["sourceMediaId"])

    def test_stale_http_request_is_409_before_tools_and_does_not_claim_export_slot(self):
        old = self.server.project_binding_payload()
        self.rebind(replace(self.project, source_media_path=Path("new.mp4")))
        thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()
        try:
            payload = {"requestToken": self.server.request_token, **old,
                       "intervals": [{"startMs": 0, "endMs": 1000}]}
            request = urllib.request.Request(
                f"http://127.0.0.1:{self.server.server_address[1]}/api/exports/gap-removed-video",
                data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"},
            )
            with mock.patch.object(server_editor, "editor_ffmpeg_tools") as tools:
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    urllib.request.urlopen(request, timeout=2)
                self.assertEqual(caught.exception.code, 409)
                self.assertIn("绑定已变更", json.loads(caught.exception.read())["error"])
                tools.assert_not_called()
            acquired = self.server.gap_removed_video_lock.acquire(blocking=False)
            self.assertTrue(acquired)
            if acquired:
                self.server.gap_removed_video_lock.release()
        finally:
            self.server.shutdown()
            thread.join(timeout=2)

    def test_export_keeps_source_and_intervals_when_rebound_after_acceptance(self):
        handler = object.__new__(server_editor.EditorRequestHandler)
        handler.server = self.server
        payload = {"requestToken": self.server.request_token, **self.server.project_binding_payload(),
                   "intervals": [{"startMs": 0, "endMs": 1000}]}
        handler.read_json_request = mock.Mock(return_value=payload)
        handler.send_json = mock.Mock()
        handler.send_video_attachment = mock.Mock()
        captured = []

        def tools():
            self.rebind(replace(self.project, source_media_path=Path("new.mp4")))
            payload["intervals"][0]["endMs"] = 9999
            return mock.Mock(ffmpeg=Path("ffmpeg"), ffprobe=Path("ffprobe"))

        def rebuild(source, intervals, output, **kwargs):
            captured.append((source, intervals))
            output.write_bytes(b"video")

        with mock.patch.object(server_editor, "editor_ffmpeg_tools", side_effect=tools), \
                mock.patch.object(server_editor, "rebuild_gap_removed_video", side_effect=rebuild):
            handler.export_gap_removed_video()
        self.assertEqual(captured, [(Path("source.mp4"), [(0, 1000)])])
        handler.send_video_attachment.assert_called_once()
        handler.send_json.assert_not_called()


if __name__ == "__main__":
    unittest.main()
