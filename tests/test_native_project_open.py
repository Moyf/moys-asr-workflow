from __future__ import annotations

import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import wave
from functools import partial
from pathlib import Path
from unittest import mock

from maw.gui_web import FOLDER_DIALOG, OPEN_DIALOG, _pick_editor_media, _pick_editor_path, _pick_editor_project
from maw.native_burn_api import NativeBurnJobs
from maw.native_burn_host import BurnDialogUnavailable, BurnHost, BurnHostClient, BurnSessions
from tests.test_local_editor_server import server_editor


class NativeProjectOpenTests(unittest.TestCase):
    def setUp(self):
        root = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        (root / "projects").mkdir()
        (root / "media").mkdir()
        self.original = root / "original.mosp"
        self.original.write_text('{"segments":[]}', encoding="utf-8")
        self.selected = root / "projects" / "selected.JSON"
        self.selected.write_text(json.dumps({"media": "../media/source.wav", "segments": [
            {"start": 0, "end": 100, "text": "selected project"},
        ]}), encoding="utf-8")
        self.media = root / "media" / "source.wav"
        with wave.open(str(self.media), "wb") as stream:
            stream.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
            stream.writeframes(b"\0\0" * 800)
        self.window = mock.Mock()
        self.window.create_file_dialog.return_value = (str(self.selected),)
        self.media_window = mock.Mock()
        self.media_window.create_confirmation_dialog.return_value = True
        self.media_window.create_file_dialog.return_value = (str(self.media),)
        self.folder_window = mock.Mock()
        self.host = self.enterContext(BurnHost(
            mock.Mock(), pick_project=partial(_pick_editor_project, self.window),
            pick_media=partial(_pick_editor_media, self.media_window),
            pick_sticker_root=partial(_pick_editor_path, self.folder_window, FOLDER_DIALOG),
        ))
        self.client = BurnHostClient.from_environment(self.host.environment())
        self.enterContext(mock.patch("maw.project_io.probe_audio_tracks", return_value=[]))
        project = server_editor.load_project(self.original, None, None, no_waveform=True, peaks_per_second=100)
        self.server = server_editor.EditorServer(("127.0.0.1", 0), project, no_waveform=True)
        self.addCleanup(self.server.server_close)
        sessions = BurnSessions(self.client)
        self.session = sessions.redeem(self.host.launch_grant())
        self.other_session = sessions.redeem(self.host.launch_grant())
        self.server.native_burn = NativeBurnJobs(sessions)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        self.addCleanup(self.server.shutdown)

    def post(self, route, *, origin=None, **fields):
        body = {"requestToken": self.server.request_token, "nativeSession": self.session, **fields}
        request = urllib.request.Request(self.url + route, data=json.dumps(body).encode(), headers={
            "Content-Type": "application/json", "Origin": self.url if origin is None else origin,
        })
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, json.load(error)

    def switch_fields(self, generation=1):
        intent = {"switchPageId": "native-test-page", "switchGeneration": generation}
        self.server.advance_project_switch(intent)
        binding = self.server.project_binding_payload()
        return {**intent, "bindingGeneration": binding["bindingGeneration"], "sourceMediaId": binding["sourceMediaId"]}

    def test_selected_path_binds_media_and_is_the_only_save_target(self):
        previous = self.switch_fields()
        status, picked = self.post("/api/project/native-pick")
        self.assertEqual(status, 200)
        self.assertEqual(picked.keys(), {"ok", "selection"})
        self.window.create_file_dialog.assert_called_once_with(
            OPEN_DIALOG, allow_multiple=False, file_types=("MAW Project (*.mosp;*.json)",),
        )
        self.assertEqual(self.server.project.json_path, self.original)
        self.assertFalse(self.server.settings.recent_projects)

        status, result = self.post("/api/project/native-bind", selection=picked["selection"], **previous)
        self.assertEqual(status, 200)
        self.assertEqual(self.server.project.json_path, self.selected)
        self.assertEqual(self.server.settings.recent_projects[0].path, self.selected)
        with urllib.request.urlopen(self.url + "/media", timeout=5) as response:
            self.assertEqual(response.read(), self.media.read_bytes())

        edited = json.loads(self.selected.read_text(encoding="utf-8"))
        edited["segments"][0]["text"] = "saved edit"
        self.assertEqual(self.post("/api/project", project=edited, **previous)[0], 409)
        self.assertEqual(self.post("/api/project", project=edited,
                                   bindingGeneration=result["bindingGeneration"], sourceMediaId=result["sourceMediaId"])[0], 200)
        self.assertEqual(json.loads(self.selected.read_text(encoding="utf-8"))["segments"][0]["text"], "saved edit")
        self.assertEqual(self.original.read_text(encoding="utf-8"), '{"segments":[]}')

    def test_cancellation_and_invalid_project_leave_current_binding_intact(self):
        binding = self.server.project_binding_payload()
        self.window.create_file_dialog.return_value = None
        self.assertEqual(self.post("/api/project/native-pick"), (200, {"ok": True, "cancelled": True}))
        self.window.create_file_dialog.return_value = (str(self.media),)
        self.assertEqual(self.post("/api/project/native-pick")[0], 400)
        self.window.create_file_dialog.return_value = (str(self.selected),)
        self.selected.write_text("not JSON", encoding="utf-8")
        self.assertEqual(self.post("/api/project/native-pick")[0], 400)
        self.assertEqual(self.server.project_binding_payload(), binding)
        self.assertEqual(self.server.project.json_path, self.original)
        self.assertFalse(self.server.settings.recent_projects)

    def test_requires_same_origin_session_token_and_never_accepts_client_paths(self):
        with self.assertRaises(BurnDialogUnavailable):
            BurnHostClient(self.client.port, "not-the-host-key").choose_project()
        for fields, status in [
            ({"origin": "https://example.test"}, 403),
            ({"nativeSession": ""}, 403),
            ({"requestToken": "wrong"}, 403),
            ({"path": str(self.selected)}, 400),
        ]:
            with self.subTest(fields=fields.keys()):
                self.assertEqual(self.post("/api/project/native-pick", **fields)[0], status)
        self.window.create_file_dialog.assert_not_called()

        _, picked = self.post("/api/project/native-pick")
        previous = self.switch_fields()
        self.assertEqual(self.post("/api/project/native-bind", nativeSession=self.other_session,
                                   selection=picked["selection"], **previous)[0], 409)
        self.switch_fields(2)
        self.assertEqual(self.post("/api/project/native-bind", selection=picked["selection"], **previous)[0], 409)
        self.assertEqual(self.server.project.json_path, self.original)

    def test_reopening_a_project_that_was_saved_after_selection_requires_a_new_pick(self):
        self.window.create_file_dialog.return_value = (str(self.original),)
        status, picked = self.post("/api/project/native-pick")
        self.assertEqual(status, 200)
        current = self.switch_fields()
        edited = {"segments": [{"start": 0, "end": 100, "text": "saved while picker was open"}]}
        self.assertEqual(self.post("/api/project", project=edited, **current)[0], 200)
        self.assertEqual(self.post("/api/project/native-bind", selection=picked["selection"], **current)[0], 409)
        self.assertEqual(self.server.project.data["segments"][0]["text"], edited["segments"][0]["text"])
        self.assertEqual(self.server.binding_generation, current["bindingGeneration"])

    def test_media_relink_cancel_preserves_binding_and_confirmed_relink_is_written_only_on_save(self):
        data = json.loads(self.selected.read_text(encoding="utf-8"))
        data["media"] = "missing.wav"
        self.selected.write_text(json.dumps(data), encoding="utf-8")
        binding = self.switch_fields()
        self.media_window.create_confirmation_dialog.return_value = False
        self.assertEqual(self.post("/api/project/native-pick", language="en"), (200, {"ok": True, "cancelled": True}))
        self.assertEqual(self.server.project.json_path, self.original)
        self.media_window.create_file_dialog.assert_not_called()
        self.media_window.create_confirmation_dialog.return_value = True
        self.media_window.create_file_dialog.return_value = None
        self.assertEqual(self.post("/api/project/native-pick"), (200, {"ok": True, "cancelled": True}))
        self.assertEqual(self.server.project.json_path, self.original)

        self.media_window.create_file_dialog.return_value = (str(self.media),)
        status, picked = self.post("/api/project/native-pick", language="en")
        self.assertEqual(status, 200)
        self.assertEqual(self.media_window.create_confirmation_dialog.call_args.args[0], "Locate linked media?")
        self.assertIn("*.wav", self.media_window.create_file_dialog.call_args.kwargs["file_types"][0])
        self.assertEqual(self.server.project.json_path, self.original)
        status, result = self.post("/api/project/native-bind", selection=picked["selection"], **binding)
        self.assertEqual(status, 200)
        self.assertEqual(self.server.project.source_media_path, self.media)
        self.assertEqual(json.loads(self.selected.read_text(encoding="utf-8"))["media"], "missing.wav")
        self.assertEqual(self.post("/api/project", project=self.server.project.data,
                                   bindingGeneration=result["bindingGeneration"], sourceMediaId=result["sourceMediaId"])[0], 200)
        self.assertEqual(json.loads(self.selected.read_text(encoding="utf-8"))["media"], "../media/source.wav")

    def test_native_sticker_folder_fills_path_without_applying_or_accepting_browser_paths(self):
        route = "/api/stickers/native-pick-root"
        original_project = self.server.project
        self.folder_window.create_file_dialog.return_value = None
        self.assertEqual(self.post(route, nativeSession="")[0], 403)
        self.assertEqual(self.post(route, path=str(self.media.parent))[0], 400)
        self.folder_window.create_file_dialog.assert_not_called()
        self.assertEqual(self.post(route), (200, {"ok": True, "cancelled": True}))
        self.folder_window.create_file_dialog.return_value = (str(self.media),)
        self.assertEqual(self.post(route)[0], 400)
        self.folder_window.create_file_dialog.return_value = (str(self.media.parent),)
        self.assertEqual(self.post(route), (200, {"ok": True, "root": self.media.parent.as_posix()}))
        self.folder_window.create_file_dialog.assert_called_with(FOLDER_DIALOG, allow_multiple=False, file_types=())
        self.assertIs(self.server.project, original_project)

    def test_native_bind_does_not_switch_after_selected_media_disappears(self):
        status, picked = self.post("/api/project/native-pick")
        self.assertEqual(status, 200)
        binding = self.switch_fields()
        self.media.rename(self.media.with_name("moved.wav"))
        self.assertEqual(self.post("/api/project/native-bind", selection=picked["selection"], **binding)[0], 409)
        self.assertEqual(self.server.project.json_path, self.original)
        self.assertFalse(self.server.settings.recent_projects)

    def test_sticker_scan_may_not_activate_a_root_on_a_new_binding(self):
        binding = self.switch_fields()
        _, picked = self.post("/api/project/native-pick")
        entered, release = threading.Event(), threading.Event()
        results = []
        validate = server_editor.validate_sticker_root

        def delayed_validate(path):
            entered.set()
            if not release.wait(5):
                raise TimeoutError("sticker scan was not released")
            return validate(path)

        with mock.patch.object(server_editor, "validate_sticker_root", side_effect=delayed_validate):
            worker = threading.Thread(target=lambda: results.append(self.post("/api/stickers/root", path=self.media.parent.as_posix(), **binding)))
            worker.start()
            try:
                self.assertTrue(entered.wait(5))
                self.assertEqual(self.post("/api/project/native-bind", selection=picked["selection"], **binding)[0], 200)
            finally:
                release.set()
                worker.join(5)
        self.assertEqual([status for status, _ in results], [409])
        self.assertNotEqual(self.server.project.sticker_root, self.media.parent)
