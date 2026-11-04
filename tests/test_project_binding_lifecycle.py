from __future__ import annotations

import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import wave
from pathlib import Path
from unittest import mock

from tests.test_local_editor_server import server_editor


class ProjectBindingLifecycleTests(unittest.TestCase):
    def start_http(self):
        thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        self.addCleanup(self.server.shutdown)

    def post(self, endpoint, payload, *, add_intent=True):
        if add_intent and endpoint in ("/api/project/attach", "/api/recent-projects/open"):
            payload = {**self.http_intent, **payload}
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.server.server_address[1]}{endpoint}",
            data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        # The fixture is a known mono PCM WAV. Keep metadata merging real;
        # real probe compatibility is checked by test_ffprobe_failure_integration.
        tracks = [{"audio_index": 0, "stream_index": 0, "codec": "pcm_s16le",
                   "channels": 1, "sample_rate": 8000, "language": "", "title": "", "default": False}]
        self.enterContext(mock.patch("maw.project_io.probe_audio_tracks",
            side_effect=lambda *args, **kwargs: [dict(track) for track in tracks]))
        self.enterContext(mock.patch.object(server_editor.EditorServer, "_thumbnail_base_ready", return_value=False))
        self.paths = {}
        for name in ("a", "b"):
            media = self.root / f"{name}.wav"
            with wave.open(str(media), "wb") as stream:
                stream.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
                stream.writeframes(b"\0\0" * 800)
            path = self.root / f"{name}.mosp"
            path.write_text(json.dumps({"media": str(media), "segments": [
                {"id": name, "start": 0, "end": 100, "text": name}]}), encoding="utf8")
            self.paths[name] = path
        self.server = server_editor.EditorServer(("127.0.0.1", 0), self.load("a"), no_waveform=True)
        self.addCleanup(self.server.server_close)
        self.http_intent = {"switchPageId": "http-fixture", "switchGeneration": 0}
        self.server.advance_project_switch(self.http_intent)

    def load(self, name):
        return server_editor.load_project(self.paths[name], None, str(self.root), no_waveform=True, peaks_per_second=100)

    def test_stale_or_missing_http_binding_cannot_save_or_create_backup(self):
        binding = self.server.project_binding_payload()
        with self.server.settings_lock:
            self.server._bind_project_locked(self.load("b"))
        before = {name: path.read_bytes() for name, path in self.paths.items()}
        thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()
        try:
            for token in ({}, binding):
                for backup in (False, True):
                    payload = {**token, "project": self.load("a").data, "backupOnly": backup, "backupLimit": 2}
                    request = urllib.request.Request(
                        f"http://127.0.0.1:{self.server.server_address[1]}/api/project",
                        data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}, method="POST")
                    with self.assertRaises(urllib.error.HTTPError) as error:
                        urllib.request.urlopen(request, timeout=5)
                    self.assertEqual(error.exception.code, 409)
            self.assertEqual({n: p.read_bytes() for n, p in self.paths.items()}, before)
            self.assertEqual(sorted(p.name for p in self.root.iterdir()), ["a.mosp", "a.wav", "b.mosp", "b.wav"])
        finally:
            self.server.shutdown()
            thread.join(5)

    def test_slow_old_attach_cannot_replace_a_new_binding(self):
        started, release = threading.Event(), threading.Event()
        binding = self.server.project_binding_payload()
        real_load = server_editor.load_project
        errors = []

        def delayed(path, *args, **kwargs):
            if Path(path) == self.paths["a"]:
                started.set()
                if not release.wait(5):
                    raise TimeoutError("test did not release old load")
            return real_load(path, *args, **kwargs)

        def old_attach():
            try:
                self.server.attach_project("a.mosp", self.load_data("a"), binding=binding)
            except Exception as error:
                errors.append(error)

        with mock.patch.object(server_editor, "load_project", side_effect=delayed):
            thread = threading.Thread(target=old_attach)
            thread.start()
            try:
                self.assertTrue(started.wait(5))
                self.server.attach_project("b.mosp", self.load_data("b"), binding=binding)
            finally:
                release.set()
                thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], server_editor.ProjectBindingChangedError)
        self.assertEqual(self.server.project.json_path, self.paths["b"])

    def load_data(self, name):
        return json.loads(self.paths[name].read_text(encoding="utf8"))

    def test_local_switch_invalidates_old_http_attach_and_recent_before_publication(self):
        self.start_http()
        for endpoint in ("/api/project/attach", "/api/recent-projects/open"):
            with self.subTest(endpoint=endpoint):
                with self.server.settings_lock:
                    self.server._bind_project_locked(self.load("b"))
                self.server.settings = server_editor.remember_project(self.server.settings, self.paths["a"])
                binding = self.server.project_binding_payload()
                page_id = "page-" + endpoint.rsplit("/", 1)[-1]
                intent = {"switchPageId": page_id, "switchGeneration": 1}
                self.assertEqual(self.post("/api/project/switch-intent", {
                    "requestToken": self.server.request_token, **intent})[0], 200)
                started, release = threading.Event(), threading.Event()
                real_load = server_editor.load_project
                before_files = {n: p.read_bytes() for n, p in self.paths.items()}
                before_settings = self.server.settings
                result = []

                def delayed(path, *args, **kwargs):
                    if Path(path).resolve() == self.paths["a"]:
                        started.set()
                        if not release.wait(5):
                            raise TimeoutError("old load was not released")
                    return real_load(path, *args, **kwargs)

                payload = {**binding, **intent, "fileName": "a.mosp",
                           "project": self.load_data("a"), "path": str(self.paths["a"])}
                with (mock.patch.object(server_editor, "load_project", side_effect=delayed),
                      mock.patch.object(self.server, "_bind_project_locked") as publish,
                      mock.patch.object(self.server, "persist_settings") as persist,
                      mock.patch.object(self.server, "start_deferred_reapeaks_load") as loader):
                    thread = threading.Thread(target=lambda: result.append(self.post(endpoint, payload)))
                    thread.start()
                    try:
                        self.assertTrue(started.wait(5))
                        # Local portable B sends only this notification, no attach.
                        self.assertEqual(self.post("/api/project/switch-intent", {
                            "requestToken": self.server.request_token,
                            **intent, "switchGeneration": 2})[0], 200)
                    finally:
                        release.set()
                        thread.join(5)
                    self.assertFalse(thread.is_alive())
                    self.assertEqual(result[0][0], 409)
                    publish.assert_not_called()
                    persist.assert_not_called()
                    loader.assert_not_called()
                self.assertEqual(self.server.project_binding_payload(), binding)
                self.assertEqual(self.server.project.json_path, self.paths["b"])
                self.assertEqual(self.server.settings, before_settings)
                self.assertEqual({n: p.read_bytes() for n, p in self.paths.items()}, before_files)

    def test_switch_intents_require_token_and_never_roll_back_or_publish_a_binding(self):
        self.start_http()
        binding = self.server.project_binding_payload()
        intent = {"switchPageId": "page-a", "switchGeneration": 2}
        self.assertEqual(self.post("/api/project/switch-intent", intent)[0], 403)
        self.assertNotIn("page-a", self.server.project_switch_generations)
        for generation, status in ((2, 200), (1, 409), (2, 200), (3, 200)):
            self.assertEqual(self.post("/api/project/switch-intent", {
                "requestToken": self.server.request_token, **intent, "switchGeneration": generation})[0], status)
        for bad in ({}, {**intent, "switchGeneration": True}, {**intent, "switchGeneration": -1},
                    {**intent, "switchPageId": []}, {**intent, "switchGeneration": 9007199254740992}):
            self.assertEqual(self.post("/api/project/switch-intent", {
                "requestToken": self.server.request_token, **bad})[0], 400)
        self.assertEqual(self.server.project_binding_payload(), binding)
        payload = {**binding, "fileName": "b.mosp", "project": self.load_data("b")}
        with mock.patch.object(server_editor, "load_project") as load:
            for invalid in ({}, intent, {**intent, "switchPageId": []}):
                self.assertEqual(self.post("/api/project/attach", {**payload, **invalid}, add_intent=False)[0], 409)
            load.assert_not_called()
        self.assertEqual(self.post("/api/project/attach", {
            **payload, **intent, "switchGeneration": 3})[0], 200)

    def test_other_pages_intents_do_not_cancel_this_page_but_binding_cas_still_applies(self):
        self.start_http()
        binding = self.server.project_binding_payload()
        first = {"switchPageId": "first-page", "switchGeneration": 1}
        other = {"switchPageId": "other-page", "switchGeneration": 99}
        for intent in (first, other):
            self.assertEqual(self.post("/api/project/switch-intent", {
                "requestToken": self.server.request_token, **intent})[0], 200)
        self.assertEqual(self.post("/api/project/attach", {
            **binding, **first, "fileName": "b.mosp", "project": self.load_data("b")})[0], 200)
        self.assertEqual(self.post("/api/project/attach", {
            **binding, **other, "fileName": "a.mosp", "project": self.load_data("a")})[0], 409)
        self.assertEqual(self.server.project.json_path, self.paths["b"])

    def test_save_and_binding_publication_cannot_cross_destinations(self):
        started, release = threading.Event(), threading.Event()
        real_write = server_editor.write_project_json
        errors = []
        data = self.load_data("a")
        data["segments"][0]["text"] = "saved a"
        binding = self.server.project_binding_payload()
        before_b = self.paths["b"].read_bytes()

        def delayed_write(*args, **kwargs):
            started.set()
            if not release.wait(5):
                raise TimeoutError("test did not release save")
            return real_write(*args, **kwargs)

        def save():
            try:
                self.server.save_project(data, binding=binding)
            except Exception as error:
                errors.append(error)

        def attach():
            try:
                self.server.attach_project("b.mosp", self.load_data("b"), binding=binding)
            except Exception as error:
                errors.append(error)

        with mock.patch.object(server_editor, "write_project_json", side_effect=delayed_write):
            saving = threading.Thread(target=save)
            switching = threading.Thread(target=attach)
            saving.start()
            try:
                self.assertTrue(started.wait(5))
                switching.start()
            finally:
                release.set()
                saving.join(5)
                if switching.ident:
                    switching.join(5)
        self.assertFalse(saving.is_alive() or switching.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(self.load_data("a")["segments"][0]["text"], "saved a")
        self.assertEqual(self.paths["b"].read_bytes(), before_b)
        self.assertEqual(self.server.project.json_path, self.paths["b"])

    def test_http_switches_require_binding_and_response_owns_its_published_token(self):
        self.server.settings = server_editor.remember_project(self.server.settings, self.paths['b'])
        self.start_http()
        before = self.server.project_binding_payload()
        for endpoint, data in [('/api/project/attach', {'fileName': 'b.mosp', 'project': self.load_data('b')}),
                               ('/api/recent-projects/open', {'path': str(self.paths['b'])})]:
            self.assertEqual(self.post(endpoint, data)[0], 409)
            self.assertEqual(self.server.project_binding_payload(), before)
        real_start = self.server.start_deferred_reapeaks_load
        published = {}

        def cross_response():
            published.update(self.server.project_binding_payload())
            with self.server.settings_lock:
                self.server._bind_project_locked(self.load('a'))
            real_start()

        with mock.patch.object(self.server, 'start_deferred_reapeaks_load', side_effect=cross_response):
            status, result = self.post('/api/project/attach', {
                **before, 'fileName': 'b.mosp', 'project': self.load_data('b')})
        self.assertEqual(status, 200)
        self.assertEqual(result['bindingGeneration'], published['bindingGeneration'])
        self.assertEqual(result['sourceMediaId'], published['sourceMediaId'])
        self.assertNotEqual(result['bindingGeneration'], self.server.binding_generation)
        for endpoint, data in [('/api/project/attach', {'fileName': 'b.mosp', 'project': self.load_data('b')}),
                               ('/api/recent-projects/open', {'path': str(self.paths['b'])})]:
            self.assertEqual(self.post(endpoint, {**before, **data})[0], 409)
        status, recent = self.post('/api/recent-projects/open', {
            **self.server.project_binding_payload(), 'path': str(self.paths['b'])})
        self.assertEqual(status, 200)
        self.assertEqual(recent['bindingGeneration'], self.server.binding_generation)
        self.assertEqual(self.post('/api/project', {
            **recent, 'project': self.load_data('b')})[0], 200)

    def test_binding_recovery_read_requires_page_token_and_cannot_enable_a_stale_save(self):
        self.start_http()
        old = self.server.project_binding_payload()
        self.assertEqual(self.post('/api/project/binding', {})[0], 403)
        self.server.attach_project('b.mosp', self.load_data('b'), binding=old)
        status, recovered = self.post('/api/project/binding', {'requestToken': self.server.request_token})
        self.assertEqual(status, 200)
        self.assertEqual(recovered['bindingGeneration'], self.server.binding_generation)
        before = self.paths['b'].read_bytes()
        self.assertEqual(self.post('/api/project', {**old, 'project': self.load_data('a')})[0], 409)
        self.assertEqual(self.paths['b'].read_bytes(), before)

    def test_old_deferred_waveform_cannot_publish_in_the_binding_to_loader_start_window(self):
        project = self.server.project
        generation = self.server.reapeaks_generation
        binding_generation = self.server.binding_generation
        with self.server.settings_lock:
            self.server._bind_project_locked(self.load('b'))
            self.server.project.data.update({'spectral': {'owner': 'b'}, 'waveform_reapeaks': {'owner': 'b'}, 'loudness': {'owner': 'b'}})
        before = dict(self.server.project.data)
        with (mock.patch.object(server_editor.quapeaks, 'load_spectral_payload', return_value=None),
              mock.patch.object(server_editor.quapeaks, 'load_waveform_payload', return_value=None),
              mock.patch.object(server_editor.quapeaks, 'load_loudness_stats', return_value=None)):
            self.server._load_deferred_reapeaks(project, generation, binding_generation)
        self.assertEqual(self.server.project.data, before)
        self.assertEqual(self.server.project.json_path, self.paths['b'])

    def test_http_save_as_returns_new_binding_for_followup_save(self):
        self.start_http()
        old = self.server.project_binding_payload()
        status, saved = self.post('/api/project', {**old, 'project': self.load_data('a'), 'filename': 'copy.mosp'})
        self.assertEqual(status, 200)
        self.assertGreater(saved['bindingGeneration'], old['bindingGeneration'])
        data = self.load_data('a')
        data['segments'][0]['text'] = 'followup'
        self.assertEqual(self.post('/api/project', {**saved, 'project': data})[0], 200)
        self.assertEqual(json.loads((self.root / 'copy.mosp').read_text(encoding='utf8'))['segments'][0]['text'], 'followup')
        self.assertEqual(self.load_data('a')['segments'][0]['text'], 'a')

    def test_save_as_restarts_deferred_loader_after_changing_its_binding(self):
        entered, release = threading.Event(), threading.Event()
        self.server.defer_reapeaks = True
        self.server.no_waveform = False
        calls = 0

        def slow_spectral(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                entered.set()
                if not release.wait(5):
                    raise TimeoutError('test did not release loader')
            return None

        with (mock.patch.object(server_editor.quapeaks, 'load_spectral_payload', side_effect=slow_spectral),
              mock.patch.object(server_editor.quapeaks, 'load_waveform_payload', return_value=None),
              mock.patch.object(server_editor.quapeaks, 'load_loudness_stats', return_value=None)):
            self.server.start_deferred_reapeaks_load()
            original = self.server.reapeaks_thread
            try:
                self.assertTrue(entered.wait(5))
                self.server.save_project(self.load_data('a'), filename='copy.mosp', binding=self.server.project_binding_payload())
                replacement = self.server.reapeaks_thread
                self.assertIsNot(replacement, original)
            finally:
                release.set()
                original.join(5)
                self.server.reapeaks_thread.join(5)
        self.assertFalse(original.is_alive() or self.server.reapeaks_thread.is_alive())
        self.assertEqual(self.server.reapeaks_status_payload()['status'], 'ready')
