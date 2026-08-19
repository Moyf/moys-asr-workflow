from __future__ import annotations

import importlib.util
import json
import struct
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from dataclasses import replace
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "server-editor" / "serve.py"
SPEC = importlib.util.spec_from_file_location("asr_local_editor_server", SERVER_PATH)
assert SPEC and SPEC.loader
server_editor = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = server_editor
SPEC.loader.exec_module(server_editor)


def _write_reapeaks_for(media_path: Path) -> Path:
    """Write a synthetic RPKN .ReaPeaks beside media, header carrying its real mtime/size.

    One wave mip (div=80, 2 peaks) + one spectral mip (2 peaks), so both
    spectral and waveform payloads can be loaded. ``peaks_per_second=100``
    targets div=80, matching the spectral mip.
    """
    src = media_path.stat()
    header = struct.pack("<4sBBiii", b"RPKN", 1, 2, 8000, int(src.st_mtime), src.st_size)
    mip_headers = struct.pack("<iiii", 80, 2, -ord("s"), 2)
    wave_data = struct.pack("<hhhh", 100, -100, 200, -50)
    spec_data = struct.pack("<ii", (16383 << 15) | 300, (100 << 15) | 5000)
    path = media_path.with_name(media_path.name + ".ReaPeaks")
    path.write_bytes(header + mip_headers + wave_data + spec_data)
    return path


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

    def test_server_help_exposes_short_port_option(self) -> None:
        result = subprocess.run(
            [sys.executable, str(SERVER_PATH), "-h"],
            capture_output=True,
            check=True,
            text=True,
        )

        self.assertIn("-p PORT, --port PORT", result.stdout)

    def test_range_parser_handles_standard_and_suffix_ranges(self) -> None:
        self.assertEqual(server_editor.parse_byte_range("bytes=2-5", 10), (2, 5))
        self.assertEqual(server_editor.parse_byte_range("bytes=7-", 10), (7, 9))
        self.assertEqual(server_editor.parse_byte_range("bytes=-3", 10), (7, 9))
        with self.assertRaises(ValueError):
            server_editor.parse_byte_range("bytes=10-", 10)

    def test_media_send_ignores_browser_cancelled_connections(self) -> None:
        for disconnect in (BrokenPipeError(), ConnectionResetError(10054, "connection reset")):
            with self.subTest(disconnect=type(disconnect).__name__):
                handler = mock.Mock()
                handler.headers = {}
                handler.wfile.write.side_effect = disconnect
                server_editor.EditorRequestHandler.send_file(handler, self.media, True)
                handler.wfile.write.assert_called_once()

    def test_media_less_projects_reopen_bound_without_media_work(self) -> None:
        for project_data in (
            {"media": "", "segments": []},
            {
                "segments": [
                    {"start": 0, "end": 1000, "text": "仅字幕工程"},
                ],
            },
        ):
            with self.subTest(project_data=project_data):
                project_path = self.root / "subtitles-only.mosp"
                project_path.write_text(json.dumps(project_data), encoding="utf-8")
                with (
                    mock.patch.object(server_editor, "resolve_project_media") as resolve_media,
                    mock.patch.object(server_editor.edit, "load_or_extract_waveform") as load_waveform,
                    mock.patch.object(server_editor.reapeaks, "load_spectral_payload") as load_spectral,
                    mock.patch.object(server_editor.reapeaks, "load_waveform_payload") as load_reapeaks_waveform,
                ):
                    project = server_editor.load_project(
                        project_path,
                        None,
                        str(self.stickers),
                        no_waveform=False,
                        peaks_per_second=100,
                    )

                resolve_media.assert_not_called()
                load_waveform.assert_not_called()
                load_spectral.assert_not_called()
                load_reapeaks_waveform.assert_not_called()
                self.assertEqual(project.json_path, project_path)
                self.assertIsNone(project.media_path)
                self.assertIsNone(project.source_media_path)
                self.assertIsNone(project.reapeaks_path)
                self.assertIn('"canSave": true', server_editor.build_server_page(project).decode("utf-8"))

    def test_bound_media_less_page_displays_project_name(self) -> None:
        project_path = self.root / "subtitles-only.mosp"
        project_path.write_text(
            json.dumps({"media": "", "segments": [{"start": 0, "end": 1000, "text": "仅字幕工程"}]}),
            encoding="utf-8",
        )
        project = server_editor.load_project(
            project_path,
            None,
            str(self.stickers),
            no_waveform=True,
            peaks_per_second=100,
        )

        page = server_editor.build_server_page(project).decode("utf-8")

        self.assertIn('let FILENAME_BASE = "subtitles-only";', page)
        self.assertIn('id="json-name" title="点击复制工程文件名">subtitles-only.mosp</span>', page)
        self.assertNotIn('class="json-name empty"', page)
        self.assertIn('id="media-name" title="">未加载媒体</span>', page)
        self.assertIn('"canSave": true', page)

    def test_media_less_project_loads_without_a_sticker_directory(self) -> None:
        project_path = self.root / "no-stickers.mosp"
        project_path.write_text(
            json.dumps({"media": "", "segments": []}),
            encoding="utf-8",
        )

        with mock.patch.object(server_editor.edit, "get_default_sticker_dir", return_value=None):
            project = server_editor.load_project(
                project_path,
                None,
                None,
                no_waveform=True,
                peaks_per_second=100,
            )

        self.assertEqual(project.json_path, project_path)
        self.assertIsNone(project.media_path)
        self.assertIsNone(project.sticker_root)
        self.assertEqual(project.stickers, [])

    def test_nonempty_missing_media_is_still_rejected(self) -> None:
        project_path = self.root / "missing-media.mosp"
        project_path.write_text(
            json.dumps({"media": "missing.mp3", "segments": []}),
            encoding="utf-8",
        )

        with self.assertRaises(server_editor.MediaResolutionError):
            server_editor.load_project(
                project_path,
                None,
                str(self.stickers),
                no_waveform=True,
                peaks_per_second=100,
            )

    def test_project_sticker_root_wins_over_launcher_root(self) -> None:
        project_root = self.root / "project-stickers"
        project_root.mkdir()
        (project_root / "project.png").write_bytes(b"project")
        project_path = self.root / "persisted.json"
        project_path.write_text(json.dumps({
            "media": str(self.media), "sticker_root": str(project_root), "segments": [],
        }), encoding="utf-8")

        project = server_editor.load_project(
            project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )

        self.assertEqual(project.sticker_root, project_root.resolve())
        self.assertEqual([sticker["rel"] for sticker in project.stickers], ["project.png"])

    def test_invalid_project_sticker_root_falls_back_to_launcher_root(self) -> None:
        project_path = self.root / "invalid-persisted.json"
        project_path.write_text(json.dumps({
            "media": str(self.media), "sticker_root": str(self.root / "missing-stickers"), "segments": [],
        }), encoding="utf-8")

        project = server_editor.load_project(
            project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )

        self.assertEqual(project.sticker_root, self.stickers.resolve())
        self.assertEqual([sticker["rel"] for sticker in project.stickers], ["nested/cat.png"])

    def test_unknown_resource_keeps_localized_detail_with_ascii_http_reason(self) -> None:
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        with server_editor.EditorServer(("127.0.0.1", 0), project) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                base_url = f"http://127.0.0.1:{server.server_address[1]}"
                with self.assertRaises(urllib.error.HTTPError) as context:
                    urllib.request.urlopen(f"{base_url}/.well-known/appspecific/com.chrome.devtools.json")
                error = context.exception
                self.assertEqual(error.code, 404)
                self.assertEqual(error.reason, "Not Found")
                self.assertIn("未知资源", error.read().decode("utf-8"))
            finally:
                server.shutdown()
                thread.join(timeout=2)

    def test_shutdown_endpoint_stops_the_loopback_server(self) -> None:
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        with server_editor.EditorServer(("127.0.0.1", 0), project) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base_url = f"http://127.0.0.1:{server.server_address[1]}"
            request = urllib.request.Request(
                f"{base_url}/api/shutdown",
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(request) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(json.loads(response.read()), {"ok": True, "service": "maw-editor"})
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive())

    def test_server_page_uses_shared_template_and_routes_stickers(self) -> None:
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        settings = server_editor.remember_project(server_editor.ServerSettings(), self.project_path)
        page = server_editor.build_server_page(project, settings).decode("utf-8")
        self.assertIn('src="/media"', page)
        self.assertIn('let STICKER_URL_PREFIX = "/stickers";', page)
        self.assertIn('const NINJA_SFX_BASE_URL = "/sfx/";', page)
        self.assertIn('const SERVER_CONFIG = {"saveUrl": "/api/project", ', page)
        self.assertNotIn('createUrl', page)
        self.assertIn('"requestToken": "", "stickerRootUrl": "/api/stickers/root", ', page)
        self.assertIn('"portableStickerExportUrl": "/api/exports/sticker-otio", ', page)
        self.assertIn('"canPortableStickerExport": true, "initialStickerCount": 1, ', page)
        self.assertIn('"autoLoadedMediaName": "clip.mp3", "recentProjectsUrl": "/api/recent-projects/open", ', page)
        self.assertIn('"attachUrl": "/api/project/attach", "settingsUrl": "/api/settings", ', page)
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

    def test_sticker_root_endpoint_validates_token_and_preserves_state_on_failure(self) -> None:
        project = server_editor.load_blank_project(str(self.stickers))
        alternate = self.root / "alternate-stickers"
        alternate.mkdir()
        (alternate / "new.png").write_bytes(b"new")
        with server_editor.EditorServer(("127.0.0.1", 0), project) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                base_url = f"http://127.0.0.1:{server.server_address[1]}"

                def post(payload: dict) -> tuple[int, dict]:
                    request = urllib.request.Request(
                        f"{base_url}/api/stickers/root",
                        data=json.dumps(payload).encode(),
                        headers={"Content-Type": "application/json"}, method="POST",
                    )
                    try:
                        with urllib.request.urlopen(request) as response:
                            return response.status, json.loads(response.read())
                    except urllib.error.HTTPError as error:
                        return error.code, json.loads(error.read())

                original_root = server.project.sticker_root
                status, result = post({"requestToken": "wrong", "path": str(alternate)})
                self.assertEqual(status, 403)
                self.assertFalse(result["ok"])
                self.assertEqual(server.project.sticker_root, original_root)
                status, result = post({"requestToken": server.request_token, "path": str(self.root / "missing")})
                self.assertEqual(status, 400)
                self.assertFalse(result["ok"])
                self.assertEqual(server.project.sticker_root, original_root)
                status, result = post({"requestToken": server.request_token, "path": str(alternate)})
                self.assertEqual(status, 200)
                self.assertEqual(result["root"], alternate.as_posix())
                self.assertEqual(result["count"], 1)
                self.assertEqual(result["stickers"][0]["rel"], "new.png")
            finally:
                server.shutdown()
                thread.join(timeout=2)

    def test_sticker_otio_export_copies_used_stickers_portably(self) -> None:
        first = self.stickers / "a" / "x.png"
        second = self.stickers / "b" / "X.png"
        first.parent.mkdir()
        second.parent.mkdir()
        first.write_bytes(b"first")
        second.write_bytes(b"second")
        timeline = {
            "OTIO_SCHEMA": "Timeline.1",
            "name": "source",
            "metadata": {},
            "tracks": {"children": [{"children": [
                {"OTIO_SCHEMA": "Gap.1"},
                {"OTIO_SCHEMA": "Clip.2", "metadata": {"moy": {"sticker_rel": "a/x.png"}},
                 "media_references": {"DEFAULT_MEDIA": {"target_url": "old-a"}}},
                {"OTIO_SCHEMA": "Clip.2", "metadata": {"moy": {"sticker_rel": "a/x.png"}},
                 "media_references": {"DEFAULT_MEDIA": {"target_url": "old-a-2"}}},
                {"OTIO_SCHEMA": "Clip.2", "metadata": {"moy": {"sticker_rel": "b/X.png"}},
                 "media_references": {"DEFAULT_MEDIA": {"target_url": "old-b"}},
                 "source_media": "file:///do-not-copy.mp4"},
            ]}]},
        }
        with server_editor.EditorServer(("127.0.0.1", 0), server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                base_url = f"http://127.0.0.1:{server.server_address[1]}"
                def post(payload: dict) -> tuple[int, dict]:
                    request = urllib.request.Request(
                        f"{base_url}/api/exports/sticker-otio",
                        data=json.dumps(payload).encode(),
                        headers={"Content-Type": "application/json"}, method="POST",
                    )
                    try:
                        with urllib.request.urlopen(request) as response:
                            return response.status, json.loads(response.read())
                    except urllib.error.HTTPError as error:
                        return error.code, json.loads(error.read())

                server.set_sticker_root(str(self.stickers))
                status, result = post({"requestToken": server.request_token, "kind": "stickers", "timeline": timeline})
                self.assertEqual(status, 200)
                package = self.root / result["folderName"]
                self.assertEqual(package.parent, self.project_path.parent)
                self.assertEqual(result["folderPath"], str(package.resolve()))
                self.assertEqual(result["otioName"], "clip_stickers.otio")
                self.assertEqual(result["stickerCount"], 2)
                self.assertFalse((package / "do-not-copy.mp4").exists())
                copied = sorted((package / "stickers").iterdir())
                self.assertEqual({item.name for item in copied}, {"x.png", "X-2.png"})
                exported = json.loads((package / result["otioName"]).read_text(encoding="utf-8"))
                clips = exported["tracks"]["children"][0]["children"]
                urls = [clip["media_references"]["DEFAULT_MEDIA"]["target_url"] for clip in clips if "media_references" in clip]
                self.assertEqual(urls, ["stickers/x.png", "stickers/x.png", "stickers/X-2.png"])
                self.assertNotIn(b"\r\n", (package / result["otioName"]).read_bytes())
                occupied = package
                occupied.mkdir(exist_ok=True)
                status, result = post({"requestToken": server.request_token, "kind": "stickers", "timeline": timeline})
                self.assertEqual(status, 200)
                self.assertTrue(result["folderName"].endswith("-2"))
            finally:
                server.shutdown()
                thread.join(timeout=2)

    def test_sticker_otio_export_rejects_malicious_relative_path(self) -> None:
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        timeline = {"OTIO_SCHEMA": "Timeline.1", "tracks": {"children": [{"children": [
            {"metadata": {"moy": {"sticker_rel": "../clip.mp3"}}, "media_references": {"DEFAULT_MEDIA": {"target_url": "x"}}},
        ]}]}}
        with server_editor.EditorServer(("127.0.0.1", 0), project) as server:
            server.set_sticker_root(str(self.stickers))
            with self.assertRaises(ValueError):
                server_editor.export_sticker_otio(server.project, "stickers", timeline, self.stickers)

    def test_sticker_otio_export_requires_sticker_rel_on_each_clip(self) -> None:
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        server = server_editor.EditorServer(("127.0.0.1", 0), project)
        try:
            server.set_sticker_root(str(self.stickers))
            timeline = {"OTIO_SCHEMA": "Timeline.1", "tracks": {"children": [{"children": [
                {"OTIO_SCHEMA": "Clip.2", "metadata": {}, "media_references": {"DEFAULT_MEDIA": {"target_url": "x"}}},
            ]}]}}
            with self.assertRaises(ValueError):
                server_editor.export_sticker_otio(server.project, "stickers", timeline, self.stickers)
        finally:
            server.server_close()

    def test_sticker_otio_export_uri_encodes_filename_but_copies_raw_name(self) -> None:
        filename = "face #%.png"
        source = self.stickers / filename
        source.write_bytes(b"special")
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        server = server_editor.EditorServer(("127.0.0.1", 0), project)
        try:
            server.set_sticker_root(str(self.stickers))
            timeline = {"OTIO_SCHEMA": "Timeline.1", "tracks": {"children": [{"children": [
                {"OTIO_SCHEMA": "Clip.2", "metadata": {"moy": {"sticker_rel": filename}},
                 "media_references": {"DEFAULT_MEDIA": {"target_url": "old"}}},
            ]}]}}
            package, otio_name, count = server_editor.export_sticker_otio(
                server.project, "stickers", timeline, self.stickers,
            )
            self.assertEqual(count, 1)
            self.assertTrue((package / "stickers" / filename).is_file())
            exported = json.loads((package / otio_name).read_text(encoding="utf-8"))
            target = exported["tracks"]["children"][0]["children"][0]["media_references"]["DEFAULT_MEDIA"]["target_url"]
            self.assertEqual(target, "stickers/face%20%23%25.png")
        finally:
            server.server_close()

    def test_reapeaks_loading_is_deferred_until_server_is_serving(self) -> None:
        self_waveform = {
            "schema": "moy.asr.waveform.v1",
            "encoding": "i8-minmax-base64",
            "peaks_per_second": 1000,
            "peak_count": 1,
            "duration_ms": 1,
            "data": "AIA=",
        }
        with (
            mock.patch.object(server_editor.edit, "load_or_extract_waveform", return_value=(self_waveform, False)) as waveform_load,
            mock.patch.object(server_editor.reapeaks, "load_spectral_payload") as spectral_load,
            mock.patch.object(server_editor.reapeaks, "load_waveform_payload") as reapeaks_wave_load,
        ):
            project = server_editor.load_project(
                self.project_path,
                None,
                str(self.stickers),
                no_waveform=False,
                load_reapeaks=False,
                peaks_per_second=100,
            )

        waveform_load.assert_called_once()
        spectral_load.assert_not_called()
        reapeaks_wave_load.assert_not_called()
        self.assertIs(project.data["waveform"], self_waveform)
        self.assertNotIn("spectral", project.data)
        self.assertNotIn("waveform_reapeaks", project.data)

        spectral_payload = {"peak_count": 2, "division": 80}
        reapeaks_wave_payload = {"peak_count": 4, "peaks_per_second": 1000}
        loader_started = threading.Event()
        release_loader = threading.Event()

        def blocking_spectral_load(*_args: object, **_kwargs: object) -> dict:
            loader_started.set()
            release_loader.wait(timeout=3)
            return spectral_payload

        def waveform_reapeaks_load(*_args: object, **_kwargs: object) -> dict:
            return reapeaks_wave_payload

        with (
            mock.patch.object(server_editor.reapeaks, "load_spectral_payload", side_effect=blocking_spectral_load),
            mock.patch.object(server_editor.reapeaks, "load_waveform_payload", side_effect=waveform_reapeaks_load),
            server_editor.EditorServer(
                ("127.0.0.1", 0),
                project,
                stickers_dir=str(self.stickers),
                no_waveform=False,
                defer_reapeaks=True,
                peaks_per_second=100,
            ) as server,
        ):
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base_url = f"http://127.0.0.1:{server.server_address[1]}"
            try:
                self.assertTrue(loader_started.wait(timeout=2))

                # If ReaPeaks were still on the request/startup path, this
                # request would wait for release_loader instead of returning.
                with urllib.request.urlopen(f"{base_url}/", timeout=1) as response:
                    self.assertEqual(response.status, 200)
                with urllib.request.urlopen(f"{base_url}/api/waveform", timeout=1) as response:
                    self.assertEqual(json.loads(response.read())["status"], "loading")

                release_loader.set()
                assert server.reapeaks_thread is not None
                server.reapeaks_thread.join(timeout=2)
                self.assertFalse(server.reapeaks_thread.is_alive())
                with urllib.request.urlopen(f"{base_url}/api/waveform", timeout=1) as response:
                    result = json.loads(response.read())
                self.assertEqual(result["status"], "ready")
                self.assertEqual(result["spectral"], spectral_payload)
                self.assertEqual(result["waveform_reapeaks"], reapeaks_wave_payload)
            finally:
                release_loader.set()
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

    def test_flv_conversion_loads_source_reapeaks(self) -> None:
        """只有 flv（走转换）：.ReaPeaks 在 flv 旁，应按原始请求路径加载。"""
        source = self.root / "clip.flv"
        source.write_bytes(b"flv-content")
        _write_reapeaks_for(source)
        project_path = self.root / "flv.json"
        project_path.write_text(json.dumps({"media": str(source), "segments": []}), encoding="utf-8")
        converted = self.root / "cache" / "clip.mp4"
        converted.parent.mkdir()
        converted.write_bytes(b"mp4")

        with mock.patch.object(server_editor, "convert_media_for_browser", return_value=converted):
            project = server_editor.load_project(
                project_path, None, str(self.stickers), no_waveform=False, peaks_per_second=100,
            )

        self.assertIsNotNone(project.data.get("spectral"))
        self.assertIsNotNone(project.data.get("waveform_reapeaks"))

    def test_flv_paired_mp4_still_loads_source_reapeaks(self) -> None:
        """flv 旁已有配对 mp4（resolve 会把 resolved_path 升级为 mp4）：仍按原始 flv 找 .ReaPeaks。"""
        source = self.root / "clip.flv"
        source.write_bytes(b"flv-content")
        _write_reapeaks_for(source)
        paired = source.with_suffix(".mp4")
        paired.write_bytes(b"mp4-adjacent")
        project_path = self.root / "flv.json"
        project_path.write_text(json.dumps({"media": str(source), "segments": []}), encoding="utf-8")

        project = server_editor.load_project(
            project_path, None, str(self.stickers), no_waveform=False, peaks_per_second=100,
        )

        self.assertEqual(project.media_path, paired.resolve())
        self.assertIsNotNone(project.data.get("spectral"))
        self.assertIsNotNone(project.data.get("waveform_reapeaks"))

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
        missing_project_path = self.root / "missing.json"
        settings = server_editor.remember_project(server_editor.ServerSettings(), self.project_path)
        settings = server_editor.remember_project(settings, self.other_project_path)
        settings = server_editor.remember_project(settings, missing_project_path)
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

                status, result = post("/api/recent-projects/open", {"path": str(missing_project_path)})
                self.assertEqual(status, 400)
                self.assertFalse(result["ok"])
                self.assertTrue(result["missing"])
            finally:
                server.shutdown()
                thread.join(timeout=2)

    def test_recent_project_payload_marks_missing_paths(self) -> None:
        missing_project_path = self.root / "missing.json"
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        settings = server_editor.remember_project(server_editor.ServerSettings(), missing_project_path)
        page = server_editor.build_server_page(project, settings).decode("utf-8")
        self.assertIn('"name": "missing.json", "exists": false', page)

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

    def test_workspace_navigation_updates_merge_and_survive_server_restart(self) -> None:
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        settings_path = self.root / "server-editor-settings.json"
        workspace = {
            "schema": 1,
            "preset": "custom",
            "columnPercent": 46,
            "editorDisplay": {"cueListShowTime": True},
            "navigation": {"cueListScrollTop": 120, "waveformTopEdgeMs": 2400},
        }
        preset_workspace = {
            "schema": 1,
            "preset": "wave-right",
            "waveformSettings": {"secondsPerRow": 10},
        }
        with server_editor.EditorServer(
            ("127.0.0.1", 0), project, settings_path=settings_path,
        ) as server:
            server.save_workspace("剪辑工作区", workspace, overwrite=False)
            server.save_preset_workspace("wave-right", preset_workspace)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                base_url = f"http://127.0.0.1:{server.server_address[1]}"

                def post(payload: dict) -> tuple[int, dict]:
                    request = urllib.request.Request(
                        f"{base_url}/api/settings",
                        data=json.dumps(payload).encode("utf-8"),
                        headers={"Content-Type": "application/json"},
                        method="POST",
                    )
                    try:
                        with urllib.request.urlopen(request) as response:
                            return response.status, json.loads(response.read())
                    except urllib.error.HTTPError as error:
                        return error.code, json.loads(error.read())

                status, result = post({
                    "updateWorkspaceNavigation": {
                        "name": "剪辑工作区",
                        "navigation": {"cueListScrollTop": 840, "waveformTopEdgeMs": 12600},
                    },
                })
                self.assertEqual(status, 200)
                self.assertTrue(result["ok"])
                saved = server.settings.saved_workspaces["剪辑工作区"]
                self.assertEqual(saved["navigation"], {"cueListScrollTop": 840, "waveformTopEdgeMs": 12600})
                self.assertEqual(saved["columnPercent"], workspace["columnPercent"])
                self.assertEqual(saved["editorDisplay"], workspace["editorDisplay"])

                status, result = post({
                    "updateWorkspaceNavigation": {
                        "name": "剪辑工作区",
                        "navigation": {"cueListScrollTop": 900},
                    },
                })
                self.assertEqual(status, 200)
                self.assertTrue(result["ok"])
                self.assertEqual(
                    server.settings.saved_workspaces["剪辑工作区"]["navigation"],
                    {"cueListScrollTop": 900, "waveformTopEdgeMs": 12600},
                )

                status, result = post({
                    "updateWorkspaceNavigation": {
                        "preset": "wave-right",
                        "navigation": {"cueListScrollTop": 360, "waveformTopEdgeMs": 7200},
                    },
                })
                self.assertEqual(status, 200)
                self.assertTrue(result["ok"])
                self.assertEqual(
                    server.settings.preset_workspaces["wave-right"]["navigation"],
                    {"cueListScrollTop": 360, "waveformTopEdgeMs": 7200},
                )
            finally:
                server.shutdown()
                thread.join(timeout=2)

        reloaded = server_editor.read_server_settings(settings_path)
        self.assertEqual(
            reloaded.saved_workspaces["剪辑工作区"]["navigation"],
            {"cueListScrollTop": 900, "waveformTopEdgeMs": 12600},
        )
        self.assertEqual(
            reloaded.preset_workspaces["wave-right"]["navigation"],
            {"cueListScrollTop": 360, "waveformTopEdgeMs": 7200},
        )

    def test_workspace_navigation_rejects_invalid_targets_values_and_fields(self) -> None:
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        settings_path = self.root / "server-editor-settings.json"
        workspace = {"schema": 1, "columnPercent": 46, "editorDisplay": {"cueListShowTime": True}}
        with server_editor.EditorServer(
            ("127.0.0.1", 0), project, settings_path=settings_path,
        ) as server:
            server.save_workspace("剪辑工作区", workspace, overwrite=False)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                base_url = f"http://127.0.0.1:{server.server_address[1]}"

                def post(navigation: dict, *, target: dict | None = None) -> tuple[int, dict]:
                    update = {"navigation": navigation}
                    update.update(target or {"name": "剪辑工作区"})
                    request = urllib.request.Request(
                        f"{base_url}/api/settings",
                        data=json.dumps({"updateWorkspaceNavigation": update}).encode("utf-8"),
                        headers={"Content-Type": "application/json"},
                        method="POST",
                    )
                    try:
                        with urllib.request.urlopen(request) as response:
                            return response.status, json.loads(response.read())
                    except urllib.error.HTTPError as error:
                        return error.code, json.loads(error.read())

                invalid_cases = [
                    ({"cueListScrollTop": -1, "waveformTopEdgeMs": 20}, None),
                    ({"cueListScrollTop": 1.5, "waveformTopEdgeMs": 20}, None),
                    ({"cueListScrollTop": float("nan"), "waveformTopEdgeMs": 20}, None),
                    ({"cueListScrollTop": 20, "waveformTopEdgeMs": "20"}, None),
                    ({"cueListScrollTop": 20, "waveformTopEdgeMs": 20, "other": 1}, None),
                    ({"cueListScrollTop": 20, "waveformTopEdgeMs": 20}, {"name": "不存在"}),
                    ({"cueListScrollTop": 20, "waveformTopEdgeMs": 20}, {"preset": "custom"}),
                ]
                for navigation, target in invalid_cases:
                    with self.subTest(navigation=navigation, target=target):
                        status, result = post(navigation, target=target)
                        self.assertEqual(status, 400)
                        self.assertFalse(result["ok"])
                self.assertEqual(server.settings.saved_workspaces["剪辑工作区"], workspace)
            finally:
                server.shutdown()
                thread.join(timeout=2)

    def test_workspace_navigation_creates_navigation_only_preset_override(self) -> None:
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        settings_path = self.root / "server-editor-settings.json"
        with server_editor.EditorServer(
            ("127.0.0.1", 0), project, settings_path=settings_path,
        ) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                base_url = f"http://127.0.0.1:{server.server_address[1]}"

                def post(payload: dict) -> tuple[int, dict]:
                    request = urllib.request.Request(
                        f"{base_url}/api/settings",
                        data=json.dumps(payload).encode("utf-8"),
                        headers={"Content-Type": "application/json"},
                        method="POST",
                    )
                    try:
                        with urllib.request.urlopen(request) as response:
                            return response.status, json.loads(response.read())
                    except urllib.error.HTTPError as error:
                        return error.code, json.loads(error.read())

                # First save for builtin preset with no existing override
                status, result = post({
                    "updateWorkspaceNavigation": {
                        "preset": "wave-right",
                        "navigation": {"cueListScrollTop": 100, "waveformTopEdgeMs": 2000},
                    },
                })
                self.assertEqual(status, 200)
                self.assertTrue(result["ok"])
                self.assertEqual(
                    server.settings.preset_workspaces["wave-right"],
                    {"navigation": {"cueListScrollTop": 100, "waveformTopEdgeMs": 2000}},
                )

                # Second save updates the same navigation dict
                status, result = post({
                    "updateWorkspaceNavigation": {
                        "preset": "wave-right",
                        "navigation": {"cueListScrollTop": 300},
                    },
                })
                self.assertEqual(status, 200)
                self.assertTrue(result["ok"])
                self.assertEqual(
                    server.settings.preset_workspaces["wave-right"],
                    {"navigation": {"cueListScrollTop": 300, "waveformTopEdgeMs": 2000}},
                )

                # Full preset workspace save still works and preserves navigation
                status, result = post({
                    "savePresetWorkspace": {
                        "preset": "wave-right",
                        "workspace": {
                            "schema": 1,
                            "columnPercent": 50,
                            "editorDisplay": {"cueListShowTime": True},
                        },
                    },
                })
                self.assertEqual(status, 200)
                self.assertTrue(result["ok"])
                self.assertEqual(
                    server.settings.preset_workspaces["wave-right"],
                    {
                        "schema": 1,
                        "columnPercent": 50,
                        "editorDisplay": {"cueListShowTime": True},
                        "navigation": {"cueListScrollTop": 300, "waveformTopEdgeMs": 2000},
                    },
                )
            finally:
                server.shutdown()
                thread.join(timeout=2)

    def test_open_recent_project_does_not_hold_settings_lock(self) -> None:
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        settings_path = self.root / "server-editor-settings.json"
        # Write a recent-projects entry directly into settings
        initial_settings = server_editor.read_server_settings(settings_path)
        initial_settings = replace(
            initial_settings,
            recent_projects=[
                server_editor.RecentProject(
                    path=self.project_path,
                    name=self.project_path.name,
                ),
            ],
        )
        with server_editor.EditorServer(
            ("127.0.0.1", 0), project, settings=initial_settings, settings_path=settings_path,
        ) as server:
            load_started = threading.Event()
            original_load_project = server_editor.load_project

            def slow_load_project(*args, **kwargs):
                load_started.set()
                import time
                time.sleep(0.5)
                return original_load_project(*args, **kwargs)

            with mock.patch.object(server_editor, "load_project", slow_load_project):
                thread = threading.Thread(
                    target=server.open_recent_project, args=(str(self.project_path),),
                )
                thread.start()
                try:
                    load_started.wait(timeout=2)
                    # set_active_workspace should not block while load_project sleeps
                    server.save_workspace("x", {"schema": 1}, overwrite=False)
                    start = __import__("time").time()
                    server.set_active_workspace("x")
                    elapsed = __import__("time").time() - start
                    self.assertLess(elapsed, 0.3, "set_active_workspace blocked on load_project")
                finally:
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
                normalized_saved_project = {
                    "media": str(self.media),
                    "segments": [{"id": "main-001", "start": 0, "end": 1000, "text": "保存后的字幕"}],
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
                self.assertEqual(json.loads(saved_bytes), normalized_saved_project)

                status, result = post({"project": saved_project, "filename": "copy.json"})
                copied_path = self.root / "copy.json"
                self.assertEqual(status, 200)
                self.assertEqual(result["filename"], "copy.json")
                self.assertIsNone(result["backup"])
                self.assertEqual(json.loads(copied_path.read_text(encoding="utf-8")), normalized_saved_project)
                self.assertEqual(server.project.json_path, copied_path)

                status, result = post({"project": saved_project, "filename": "../outside.json"})
                self.assertEqual(status, 400)
                self.assertFalse(result["ok"])
                self.assertFalse((self.root.parent / "outside.json").exists())
            finally:
                server.shutdown()
                thread.join(timeout=2)

    def test_server_accepts_reconciled_extension_ranges_but_rejects_overlap(self) -> None:
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        with server_editor.EditorServer(("127.0.0.1", 0), project) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                base_url = f"http://127.0.0.1:{server.server_address[1]}"

                def post(payload: dict) -> tuple[int, dict]:
                    request = urllib.request.Request(
                        f"{base_url}/api/project",
                        data=json.dumps({"project": payload}).encode("utf-8"),
                        headers={"Content-Type": "application/json"},
                        method="POST",
                    )
                    try:
                        with urllib.request.urlopen(request) as response:
                            return response.status, json.loads(response.read())
                    except urllib.error.HTTPError as error:
                        return error.code, json.loads(error.read())

                valid_project = {
                    "media": str(self.media),
                    "segments": [{"id": "main-1", "start": 1000, "end": 4000, "text": "主字幕"}],
                    "multi_subtitle": {
                        "schema": "moy.asr.multi_subtitle.v1",
                        "enabled": True,
                        "display_mode": "both",
                        "tracks": [{
                            "id": "extension-1",
                            "role": "extension",
                            "name": "English",
                            "language": "English",
                            "split_mode": "word",
                            "source_name": "translation.srt",
                            "segments": [
                                {"id": "extension-1", "start": 1000, "end": 3000, "text": "前半"},
                                {"id": "extension-2", "start": 3000, "end": 4000, "text": "后半"},
                            ],
                        }],
                        "bindings": [{
                            "id": "binding-1",
                            "track_id": "extension-1",
                            "main_segment_ids": ["main-1"],
                            "extension_segment_ids": ["extension-1"],
                            "start_offset_ms": 0,
                            "end_offset_ms": -1000,
                        }],
                    },
                }
                status, result = post(valid_project)
                self.assertEqual(status, 200)
                self.assertTrue(result["ok"])

                invalid_project = json.loads(json.dumps(valid_project))
                invalid_project["multi_subtitle"]["tracks"][0]["segments"][1]["start"] = 2999
                status, result = post(invalid_project)
                self.assertEqual(status, 400)
                self.assertFalse(result["ok"])
                self.assertIn("must be >= previous segment end", result["error"])
            finally:
                server.shutdown()
                thread.join(timeout=2)


    def test_attach_endpoint_binds_browser_opened_project_and_enables_save(self) -> None:
        blank_project = server_editor.load_blank_project(str(self.stickers))
        settings_path = self.root / "server-editor-settings.json"
        with server_editor.EditorServer(
            ("127.0.0.1", 0),
            blank_project,
            settings=server_editor.ServerSettings(),
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

                legacy_project = {
                    "media": str(self.media),
                    "segments": [{"start": 0, "end": 1000, "text": "浏览器打开的字幕"}],
                }
                # The browser normalizes a legacy project before asking the
                # server to take it over, while the on-disk copy still has no
                # IDs. The server must apply the same deterministic repair to
                # both copies before comparing their subtitle content.
                browser_project = json.loads(json.dumps(legacy_project))
                browser_project["segments"][0]["id"] = "main-001"

                # 失败矩阵：任何一项不满足都不得绑定工程路径。
                notes = self.root / "notes.txt"
                notes.write_text("not media", encoding="utf-8")
                failure_cases = [
                    ({"fileName": "../outside.json", "project": browser_project}, "文件名"),
                    ({"fileName": "", "project": browser_project}, "文件名"),
                    ({"fileName": "clip.json", "project": "not-a-dict"}, "对象"),
                    ({"fileName": "clip.json", "project": {"segments": []}}, "媒体路径"),
                    ({"fileName": "clip.json", "project": {"media": "clip.mp3", "segments": []}}, "绝对路径"),
                    (
                        {"fileName": "clip.json", "project": {"media": str(self.root / "gone.mp3"), "segments": []}},
                        "不存在或已移动",
                    ),
                    (
                        {"fileName": "clip.json", "project": {"media": str(notes), "segments": []}},
                        "音视频",
                    ),
                    ({"fileName": "missing.json", "project": browser_project}, "同名工程"),
                    (
                        {
                            "fileName": "clip.json",
                            "project": {"media": str(self.media), "segments": [{"start": 5, "end": 900, "text": "旧副本"}]},
                        },
                        "内容不一致",
                    ),
                ]
                for payload, hint in failure_cases:
                    with self.subTest(hint=hint):
                        status, result = post("/api/project/attach", payload)
                        self.assertEqual(status, 400)
                        self.assertFalse(result["ok"])
                        self.assertIn(hint, result["error"])
                        self.assertIsNone(server.project.json_path)

                # 磁盘上的同名工程与浏览器副本一致：接管并恢复媒体与保存。
                self.project_path.write_text(json.dumps(legacy_project), encoding="utf-8")
                status, result = post("/api/project/attach", {"fileName": "clip.json", "project": browser_project})
                self.assertEqual(status, 200)
                self.assertTrue(result["ok"])
                self.assertEqual(result["name"], "clip.json")
                self.assertEqual(result["mediaName"], "clip.mp3")
                self.assertEqual(server.project.json_path, self.project_path.resolve())
                self.assertEqual(server.project.media_path, self.media.resolve())
                self.assertEqual(server.settings.recent_projects[0].path, self.project_path.resolve())
                self.assertEqual(
                    server_editor.read_server_settings(settings_path).recent_projects[0].path,
                    self.project_path.resolve(),
                )

                # 接管后保存直接写回绑定的工程文件。
                edited = {"media": str(self.media), "segments": [{"start": 0, "end": 1000, "text": "接管后保存"}]}
                status, result = post("/api/project", {"project": edited, "filename": None})
                self.assertEqual(status, 200)
                self.assertTrue(result["ok"])
                self.assertEqual(
                    json.loads(self.project_path.read_text(encoding="utf-8")),
                    {
                        "media": str(self.media.resolve()),
                        "segments": [{"id": "main-001", "start": 0, "end": 1000, "text": "接管后保存"}],
                    },
                )
            finally:
                server.shutdown()
                thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
