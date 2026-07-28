# pyright: reportAny=false, reportArgumentType=false, reportAttributeAccessIssue=false, reportImplicitOverride=false, reportIndexIssue=false, reportPrivateUsage=false, reportUnannotatedClassAttribute=false, reportUninitializedInstanceVariable=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnusedCallResult=false, reportUnusedParameter=false

from __future__ import annotations

import sys
import tempfile
import threading
import unittest
import json
from pathlib import Path
from unittest import mock
from typing import final


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from maw.gui_web import EventPump, LauncherApi, LauncherPaths, _port, _request_from_payload, _route_dropped_path  # noqa: E402
from maw.gui_workflow import TranscriptionRequest, TranscriptionResult  # noqa: E402


class FakeWindow:
    def __init__(self) -> None:
        self.scripts: list[str] = []

    def evaluate_js(self, script: str) -> None:
        self.scripts.append(script)


@final
class GuiWebBridgeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.env_path = self.root / ".env"
        self.example_path = self.root / ".env.example"
        _ = self.example_path.write_text("DASHSCOPE_API_KEY=\nDASHSCOPE_REGION=beijing\n", encoding="utf-8")
        self.paths = LauncherPaths(root=self.root, env_path=self.env_path, launcher_html=self.root / "launcher.html")
        self.window = FakeWindow()
        self.api = LauncherApi(paths=self.paths, window_getter=lambda: self.window)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_get_config_returns_registry_and_masked_key_when_env_exists(self) -> None:
        """Given local config, When JS asks for config, Then secrets are masked and registries return."""
        _ = self.env_path.write_text("DASHSCOPE_API_KEY=sk-secret-abcd\nDASHSCOPE_REGION=singapore\nMAW_GUI_LANG=en\n", encoding="utf-8")

        config = self.api.get_config()

        self.assertEqual(config["apiKey"], "sk-secret-abcd")
        self.assertEqual(config["maskedApiKey"], "sk-…abcd")
        self.assertEqual(config["region"], "singapore")
        self.assertEqual(config["guiLang"], "en")
        self.assertEqual(config["providerId"], "qwen")
        self.assertEqual(config["modelId"], "qwen3-asr-flash-filetrans")
        self.assertIsNone(config["lastModel"])
        self.assertIsNone(config["lastLanguage"])
        self.assertEqual(config["stickerDir"], "")
        self.assertEqual(config["providers"][0]["keyUrl"], "https://help.aliyun.com/zh/model-studio/get-api-key")
        self.assertEqual(len(config["providers"][0]["commonLanguages"]), 9)
        self.assertEqual(len(config["providers"][1]["commonLanguages"]), 8)
        self.assertEqual(config["models"][0]["id"], "qwen3-asr-flash-filetrans")
        self.assertEqual(config["languages"][0]["id"], "")

    def test_save_settings_writes_env_without_echoing_key(self) -> None:
        """Given form values, When saved, Then .env is updated and response masks the key."""
        result = self.api.save_settings({
            "modelId": "qwen3-asr-flash-filetrans",
            "apiKey": "sk-super-secret-9999",
            "region": "singapore",
            "language": "zh",
            "workspaceId": "ws-1",
            "guiLang": "en",
        })

        text = self.env_path.read_text(encoding="utf-8")
        self.assertIn("DASHSCOPE_API_KEY=sk-super-secret-9999", text)
        self.assertIn("DASHSCOPE_WORKSPACE_ID=ws-1", text)
        self.assertEqual(result["maskedApiKey"], "sk-…9999")
        self.assertNotIn("super-secret", result["message"])

    def test_save_prefs_writes_only_gui_memory_keys(self) -> None:
        self.env_path.write_text("# keep\nDASHSCOPE_REGION=beijing\nSTICKER_DIR=stickers\n", encoding="utf-8")

        result = self.api.save_prefs({"modelId": "stt-async-v5", "language": ""})

        self.assertTrue(result["ok"])
        self.assertEqual(
            self.env_path.read_text(encoding="utf-8"),
            "# keep\nDASHSCOPE_REGION=beijing\nSTICKER_DIR=stickers\nMAW_GUI_LAST_MODEL=stt-async-v5\nMAW_GUI_LAST_LANGUAGE=\n",
        )

    def test_get_config_exposes_last_language_empty_vs_absent(self) -> None:
        self.env_path.write_text("MAW_GUI_LAST_MODEL=stt-async-v5\nMAW_GUI_LAST_LANGUAGE=\n", encoding="utf-8")

        remembered = self.api.get_config()
        self.env_path.write_text("DASHSCOPE_DEFAULT_LANGUAGE=zh\n", encoding="utf-8")
        absent = self.api.get_config()

        self.assertEqual(remembered["lastModel"], "stt-async-v5")
        self.assertEqual(remembered["lastLanguage"], "")
        self.assertIsNone(absent["lastLanguage"])
        self.assertEqual(absent["language"], "zh")

    def test_start_server_builds_command_and_opens_localhost(self) -> None:
        """Given a project json, When server starts, Then it uses the serve command and localhost URL."""
        project = self.root / "project.json"
        media = self.root / "clip.mp4"
        project.write_text(json.dumps({"media": str(media), "segments": []}), encoding="utf-8")
        media.write_bytes(b"media")

        class FakeProcess:
            returncode = None

            def poll(self) -> int | None:
                return None

            def terminate(self) -> None:
                self.returncode = -15

            def wait(self, timeout: float | None = None) -> int:
                return self.returncode or 0

        with mock.patch("maw.gui_web.subprocess.Popen", return_value=FakeProcess()) as popen:
            with mock.patch("maw.gui_web._wait_for_server", return_value=True) as wait_for_server:
                with mock.patch("maw.gui_web.webbrowser.open") as open_browser:
                    result = self.api.start_server({
                        "jsonPath": str(project),
                        "mediaPath": str(media),
                        "port": "9876",
                        "guiLang": "en",
                    })

        command = popen.call_args.args[0]
        self.assertIn("serve.py", command[1])
        self.assertEqual(command[2], str(project))
        self.assertEqual(command[command.index("-m") + 1], str(media))
        self.assertEqual(command[command.index("--port") + 1], "9876")
        self.assertEqual(result["url"], "http://127.0.0.1:9876/?lang=en")
        wait_for_server.assert_called_once_with("http://127.0.0.1:9876/", timeout=5.0)
        open_browser.assert_called_once_with("http://127.0.0.1:9876/?lang=en")

    def test_start_server_reports_failure_when_port_never_responds(self) -> None:
        """Given child starts but port stays closed, When starting server, Then browser is not opened."""
        project = self.root / "project.json"
        media = self.root / "clip.mp4"
        project.write_text(json.dumps({"media": str(media), "segments": []}), encoding="utf-8")
        media.write_bytes(b"media")

        class FakeProcess:
            returncode = None

            def poll(self) -> int | None:
                return None

            def terminate(self) -> None:
                self.returncode = -15

            def wait(self, timeout: float | None = None) -> int:
                return self.returncode or 0

        with mock.patch("maw.gui_web.subprocess.Popen", return_value=FakeProcess()):
            with mock.patch("maw.gui_web._wait_for_server", return_value=False):
                with mock.patch("maw.gui_web.webbrowser.open") as open_browser:
                    result = self.api.start_server({"jsonPath": str(project), "mediaPath": str(media), "port": "9876"})

        self.assertFalse(result["ok"])
        self.assertEqual(result["field"], "port")
        self.assertEqual(result["code"], "server_no_response")
        open_browser.assert_not_called()

    def test_start_server_reports_code_when_project_json_is_missing(self) -> None:
        """Given missing project JSON, When starting server, Then json_not_found code is returned."""
        result = self.api.start_server({"jsonPath": str(self.root / "missing.json"), "mediaPath": "", "port": "8765"})

        self.assertFalse(result["ok"])
        self.assertEqual(result["field"], "jsonPath")
        self.assertEqual(result["code"], "json_not_found")

    def test_start_server_opens_url_after_wait_helper_passes(self) -> None:
        """Given wait helper passes, When starting server, Then open happens after wait call."""
        project = self.root / "project.json"
        media = self.root / "clip.mp4"
        project.write_text(json.dumps({"media": str(media), "segments": []}), encoding="utf-8")
        media.write_bytes(b"media")
        calls: list[str] = []

        class FakeProcess:
            returncode = None

            def poll(self) -> int | None:
                return None

            def terminate(self) -> None:
                self.returncode = -15

            def wait(self, timeout: float | None = None) -> int:
                return self.returncode or 0

        def wait(_url: str, *, timeout: float) -> bool:
            calls.append("wait")
            return True

        def open_url(_url: str) -> None:
            calls.append("open")

        with mock.patch("maw.gui_web.subprocess.Popen", return_value=FakeProcess()):
            with mock.patch("maw.gui_web._wait_for_server", side_effect=wait):
                with mock.patch("maw.gui_web.webbrowser.open", side_effect=open_url):
                    result = self.api.start_server({"jsonPath": str(project), "mediaPath": str(media), "port": "9876"})

        self.assertTrue(result["ok"])
        self.assertEqual(calls, ["wait", "open"])

    def test_check_server_media_reports_existing_project_media(self) -> None:
        """Given JSON embeds existing media, When checked, Then media is usable."""
        media = self.root / "clip.mp4"
        project = self.root / "project.json"
        media.write_bytes(b"media")
        project.write_text(json.dumps({"media": str(media), "segments": []}), encoding="utf-8")

        result = self.api.check_server_media({"jsonPath": str(project)})

        self.assertTrue(result["hasMedia"])
        self.assertTrue(result["mediaExists"])
        self.assertEqual(result["mediaPath"], str(media))

    def test_check_server_media_reports_missing_or_absent_media(self) -> None:
        """Given JSON lacks usable media, When checked, Then manual media is required."""
        project = self.root / "project.json"
        project.write_text('{"media": "D:/missing.mp4", "segments": []}\n', encoding="utf-8")

        missing = self.api.check_server_media({"jsonPath": str(project)})
        project.write_text('{"segments": []}\n', encoding="utf-8")
        absent = self.api.check_server_media({"jsonPath": str(project)})

        self.assertTrue(missing["hasMedia"])
        self.assertFalse(missing["mediaExists"])
        self.assertFalse(absent["hasMedia"])

    def test_check_server_media_handles_malformed_json(self) -> None:
        """Given malformed project JSON, When checked, Then result is structured not raised."""
        project = self.root / "bad.json"
        project.write_text("{bad", encoding="utf-8")

        result = self.api.check_server_media({"jsonPath": str(project)})

        self.assertFalse(result["ok"])
        self.assertFalse(result["hasMedia"])

    def test_start_server_requires_manual_media_when_project_media_missing(self) -> None:
        """Given project media is unusable, When no override is provided, Then server blocks."""
        project = self.root / "project.json"
        project.write_text('{"segments": []}\n', encoding="utf-8")

        result = self.api.start_server({"jsonPath": str(project), "mediaPath": "", "port": "8765"})

        self.assertFalse(result["ok"])
        self.assertEqual(result["field"], "serverMediaPath")
        self.assertEqual(result["code"], "server_media_missing")

    def test_open_blank_html_opens_repo_template_when_present(self) -> None:
        """Given blank editor exists, When opened, Then browser receives its file URL."""
        blank = self.root / "blank-editor.html"
        blank.write_text("<!doctype html>\n", encoding="utf-8")

        with mock.patch("maw.gui_web._open_existing_path", return_value={"ok": True}) as open_path:
            result = self.api.open_blank_html()

        self.assertTrue(result["ok"])
        open_path.assert_called_once_with(blank)

    def test_open_blank_html_reports_missing_template_without_raising(self) -> None:
        """Given blank editor is missing, When opened, Then JS receives structured failure."""
        with mock.patch("maw.gui_web.asset_path", return_value=self.root / "missing-blank-editor.html"):
            result = self.api.open_blank_html()

        self.assertFalse(result["ok"])
        self.assertIn("blank-editor.html", result["error"])

    def test_check_ffmpeg_reports_found_when_both_tools_exist(self) -> None:
        ffmpeg = self.root / "bin" / "ffmpeg.exe"
        ffprobe = self.root / "bin" / "ffprobe.exe"
        ffmpeg.parent.mkdir()
        ffmpeg.write_bytes(b"exe")
        ffprobe.write_bytes(b"exe")

        def which(name: str) -> str:
            return str(ffmpeg if name == "ffmpeg" else ffprobe)

        with mock.patch("maw.gui_web.shutil.which", side_effect=which):
            result = self.api.check_ffmpeg()

        self.assertTrue(result["found"])
        self.assertEqual(result["directory"], str(ffmpeg.parent))

    def test_save_ffmpeg_path_invalid_stays_missing(self) -> None:
        result = self.api.save_ffmpeg_path({"path": str(self.root / "missing")})

        self.assertFalse(result["ok"])
        self.assertFalse(result["found"])

    def test_save_sticker_dir_rejects_missing_directory(self) -> None:
        result = self.api.save_sticker_dir({"path": str(self.root / "missing-stickers")})

        self.assertFalse(result["ok"])
        self.assertEqual(result["field"], "stickerDir")
        self.assertEqual(result["code"], "sticker_dir_invalid")

    def test_save_sticker_dir_writes_valid_directory_to_env(self) -> None:
        stickers = self.root / "stickers"
        stickers.mkdir()

        result = self.api.save_sticker_dir({"path": str(stickers)})

        self.assertTrue(result["ok"])
        self.assertEqual(result["stickerDir"], str(stickers))
        self.assertIn(f"STICKER_DIR={stickers}", self.env_path.read_text(encoding="utf-8"))

    def test_open_output_folder_uses_startfile_on_windows(self) -> None:
        folder = self.root / "out"
        folder.mkdir()
        self.api.result = mock.Mock(srt_path=folder / "a.srt", html_path=None)

        with mock.patch("maw.gui_web.os.name", "nt"):
            with mock.patch("maw.gui_web.os.startfile") as startfile:
                result = self.api.open_output_folder()

        self.assertTrue(result["ok"])
        startfile.assert_called_once_with(str(folder))

    def test_open_html_missing_path_does_not_open(self) -> None:
        self.api.result = mock.Mock(srt_path=self.root / "a.srt", html_path=self.root / "missing.edit.html")

        with mock.patch("maw.gui_web.webbrowser.open") as open_browser:
            result = self.api.open_html()

        self.assertFalse(result["ok"])
        open_browser.assert_not_called()

    def test_cancel_transcription_sets_event(self) -> None:
        """Given a running cancellation token, When cancel is called, Then the event is set."""
        self.api.cancel_event = threading.Event()

        result = self.api.cancel_transcription()

        self.assertTrue(self.api.cancel_event.is_set())
        self.assertTrue(result["ok"])

    def test_start_transcription_rejects_missing_media(self) -> None:
        """Given missing media, When transcription starts, Then validation fails before subprocess."""
        result = self.api.start_transcription({"mediaPath": str(self.root / "missing.mp3"), "srtPath": str(self.root / "out.srt")})

        self.assertFalse(result["ok"])
        self.assertEqual(result["field"], "mediaPath")
        self.assertEqual(result["code"], "media_not_found")
        self.assertIn("media", result["error"].lower())

    def test_start_transcription_rejects_empty_resolved_api_key(self) -> None:
        """Given media and output but no key anywhere, When starting, Then API key blocks."""
        media = self.root / "clip.mp3"
        media.write_bytes(b"media")

        result = self.api.start_transcription({"mediaPath": str(media), "srtPath": str(self.root / "out.srt"), "apiKey": ""})

        self.assertFalse(result["ok"])
        self.assertEqual(result["field"], "apiKey")
        self.assertEqual(result["code"], "api_key_missing")

    def test_start_transcription_accepts_api_key_from_env_file(self) -> None:
        """Given saved API key, When field is empty, Then resolved key is used."""
        media = self.root / "clip.mp3"
        media.write_bytes(b"media")
        self.env_path.write_text("DASHSCOPE_API_KEY=sk-from-env\n", encoding="utf-8")

        with mock.patch("maw.gui_web.run_transcription"):
            result = self.api.start_transcription({"mediaPath": str(media), "srtPath": str(self.root / "out.srt"), "apiKey": ""})

        self.assertTrue(result["ok"])
        self.api.cancel_transcription()

    def test_start_transcription_rejects_singapore_without_workspace(self) -> None:
        """Given Singapore region, When workspace is absent, Then workspace blocks."""
        media = self.root / "clip.mp3"
        media.write_bytes(b"media")

        result = self.api.start_transcription({
            "mediaPath": str(media),
            "srtPath": str(self.root / "out.srt"),
            "apiKey": "sk-test",
            "region": "singapore",
            "workspaceId": "",
        })

        self.assertFalse(result["ok"])
        self.assertEqual(result["field"], "workspaceId")
        self.assertEqual(result["code"], "workspace_missing")

    def test_start_transcription_rejects_missing_output_path_with_code(self) -> None:
        """Given media but no output path, When transcription starts, Then output_missing blocks."""
        media = self.root / "clip.mp3"
        media.write_bytes(b"media")

        result = self.api.start_transcription({"mediaPath": str(media), "srtPath": "", "apiKey": "sk-test"})

        self.assertFalse(result["ok"])
        self.assertEqual(result["field"], "srtPath")
        self.assertEqual(result["code"], "output_missing")

    def test_request_from_payload_test_run_overrides_manual_length_limit(self) -> None:
        media = self.root / "clip.mp3"
        media.write_bytes(b"media")

        request = _request_from_payload({
            "mediaPath": str(media),
            "srtPath": str(self.root / "out.srt"),
            "apiKey": "sk-test",
            "region": "beijing",
            "lengthLimit": "30m",
            "testRun": True,
            "guiLang": "en",
        }, self.env_path)

        self.assertEqual(request.length_limit, "2m")
        self.assertEqual(request.ui_language, "en")

    def test_request_from_payload_without_test_run_uses_manual_length_limit(self) -> None:
        media = self.root / "clip.mp3"
        media.write_bytes(b"media")

        request = _request_from_payload({
            "mediaPath": str(media),
            "srtPath": str(self.root / "out.srt"),
            "apiKey": "sk-test",
            "region": "beijing",
            "lengthLimit": "30m",
            "testRun": False,
        }, self.env_path)

        self.assertEqual(request.length_limit, "30m")

    def test_event_pump_batches_events_and_preserves_order(self) -> None:
        pump = EventPump(window_getter=lambda: self.window)
        pump.enqueue({"type": "log", "message": "one"})
        pump.enqueue({"type": "log", "message": "two"})

        pump.flush()

        self.assertEqual(len(self.window.scripts), 1)
        self.assertIn("onBackendEvents", self.window.scripts[0])
        self.assertLess(self.window.scripts[0].index("one"), self.window.scripts[0].index("two"))

    def test_launcher_api_queues_started_event_and_shutdown_flushes(self) -> None:
        self.api._emit({"type": "log", "message": "queued"})

        self.api.shutdown()

        self.assertTrue(self.window.scripts)
        self.assertIn("queued", self.window.scripts[-1])

    def test_worker_emits_done_with_json_when_optional_html_is_missing(self) -> None:
        request = TranscriptionRequest(
            media_path=self.root / "clip.wav",
            srt_path=self.root / "clip.srt",
        )
        result = TranscriptionResult(
            srt_path=self.root / "clip.srt",
            json_path=self.root / "clip.json",
            html_path=None,
        )

        with mock.patch("maw.gui_web.run_transcription", return_value=result):
            self.api._worker_main(request, threading.Event())

        self.assertEqual(self.api.result, result)
        self.assertTrue(self.window.scripts)
        event_script = self.window.scripts[-1]
        self.assertIn('"type": "done"', event_script)
        self.assertIn(str(result.json_path).replace("\\", "\\\\"), event_script)
        self.assertIn('"htmlPath": ""', event_script)

    def test_route_dropped_path_routes_json_media_and_reject(self) -> None:
        """Given dropped paths, When routed, Then event type mirrors launcher drop behavior."""
        media = _route_dropped_path(r"D:\Videos\clip.MP4")
        project = _route_dropped_path(r"D:\Videos\clip.json")
        rejected = _route_dropped_path(r"D:\Videos\clip.txt")

        self.assertEqual(media, {"type": "dropMedia", "path": r"D:\Videos\clip.MP4"})
        self.assertEqual(project, {"type": "dropJson", "path": r"D:\Videos\clip.json"})
        self.assertEqual(rejected, {"type": "dropReject", "path": r"D:\Videos\clip.txt"})


@final
class LauncherAssetContractTests(unittest.TestCase):
    def test_sticker_picker_saves_immediately_without_a_separate_button(self) -> None:
        page = (ROOT / "web" / "launcher" / "index.html").read_text(encoding="utf-8")
        script = (ROOT / "web" / "launcher" / "launcher.js").read_text(encoding="utf-8")

        self.assertNotIn('id="saveStickerDir"', page)
        self.assertIn('if (result.ok) await saveStickerDirectory(result.path);', script)

    def test_default_editor_port_is_8250(self) -> None:
        page = (ROOT / "web" / "launcher" / "index.html").read_text(encoding="utf-8")

        self.assertEqual(_port({}), 8250)
        self.assertEqual(_port({"port": "invalid"}), 8250)
        self.assertIn('id="port" type="number" min="1" max="65535" value="8250"', page)

    def test_language_filter_hint_is_available_to_single_language_providers(self) -> None:
        page = (ROOT / "web" / "launcher" / "index.html").read_text(encoding="utf-8")
        script = (ROOT / "web" / "launcher" / "launcher.js").read_text(encoding="utf-8")

        self.assertIn('id="languageFilterHint"', page)
        self.assertIn('language_filter_hint: "默认仅显示常用语言', script)
        self.assertIn('$("languageFilterHint").classList.toggle("hidden", showRare || commons.length === 0);', script)

    def test_launcher_section_titles_share_emoji_numbering_and_size(self) -> None:
        page = (ROOT / "web" / "launcher" / "index.html").read_text(encoding="utf-8")
        stylesheet = (ROOT / "web" / "launcher" / "launcher.css").read_text(encoding="utf-8")

        for expected in ("1️⃣ 媒体与输出", "2️⃣ 识别设置", "3️⃣ 日志", "4️⃣ 字幕编辑器设置"):
            self.assertIn(expected, page)
        self.assertIn(".card h2{margin:0 0 12px;color:var(--text-secondary);font-size:16px;", stylesheet)

    def test_server_start_button_exposes_disabled_starting_state(self) -> None:
        script = (ROOT / "web" / "launcher" / "launcher.js").read_text(encoding="utf-8")

        self.assertIn('const SERVER_STARTING_TEXT = { zh: "启动中……", en: "Starting…" };', script)
        self.assertIn("button.disabled = state.serverStarting;", script)
        self.assertIn("state.serverStarting = true;", script)
        self.assertIn("state.serverStarting = false;", script)
        self.assertIn("guiLang: state.lang", script)

    def test_attention_button_keeps_amber_hover_style(self) -> None:
        stylesheet = (ROOT / "web" / "launcher" / "launcher.css").read_text(encoding="utf-8")

        self.assertIn(".ghost.attention:hover:not(:disabled)", stylesheet)
        self.assertIn("border-color:var(--amber-hover)", stylesheet)


if __name__ == "__main__":
    unittest.main()
