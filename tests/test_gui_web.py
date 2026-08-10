# pyright: reportAny=false, reportArgumentType=false, reportAttributeAccessIssue=false, reportImplicitOverride=false, reportIndexIssue=false, reportPrivateUsage=false, reportUnannotatedClassAttribute=false, reportUninitializedInstanceVariable=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnusedCallResult=false, reportUnusedParameter=false

from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from typing import final
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from maw.gui_web import EventPump, LauncherApi, LauncherPaths, PreflightError, _find_mose_executable, _is_ffmpeg_start_failure, _is_ffprobe_start_failure, _port, _register_mosp_association, _request_from_payload, _route_dropped_path  # noqa: E402
from maw.gui_workflow import TranscriptionProcessError, TranscriptionRequest, TranscriptionResult  # noqa: E402


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
        self.assertEqual(config["modelId"], "qwen-audio-3.0-asr-flash-filetrans")
        self.assertIsNone(config["lastModel"])
        self.assertIsNone(config["lastLanguage"])
        self.assertEqual(config["stickerDir"], "")
        self.assertEqual(config["providers"][0]["keyUrl"], "https://help.aliyun.com/zh/model-studio/get-api-key")
        self.assertEqual(len(config["providers"][0]["commonLanguages"]), 10)
        self.assertEqual(len(config["providers"][1]["commonLanguages"]), 8)
        self.assertEqual(config["models"][0]["id"], "qwen-audio-3.0-asr-flash-filetrans")
        self.assertEqual(config["models"][1]["id"], "fun-asr")
        self.assertEqual(config["models"][2]["id"], "qwen3-asr-flash-filetrans")
        self.assertTrue(config["models"][0]["supportsSpeaker"])
        self.assertTrue(config["models"][0]["supportsContext"])
        self.assertTrue(config["models"][0]["supportsHotwords"])
        self.assertTrue(config["models"][0]["supportsVocabulary"])
        self.assertEqual(config["models"][0]["languages"][0]["id"], "")
        self.assertFalse(config["models"][2]["supportsSpeaker"])
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

    def test_start_server_builds_command_and_returns_localhost_url(self) -> None:
        """Given a project json, When server starts, Then it returns the localhost URL for the launcher link."""
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
            with mock.patch("maw.gui_web._wait_for_server", side_effect=[False, True]) as wait_for_server:
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
        self.assertEqual(
            wait_for_server.call_args_list,
            [
                mock.call("http://127.0.0.1:9876/", timeout=0.25),
                mock.call("http://127.0.0.1:9876/", timeout=5.0),
            ],
        )
        self.assertNotIn("serverAlreadyRunning", result)

    def test_open_mose_passes_project_path_to_packaged_executable(self) -> None:
        project = self.root / "project.mosp"
        executable = self.root / "MOSE.exe"
        project.write_text("{}\n", encoding="utf-8")
        executable.write_bytes(b"exe")

        with mock.patch("maw.gui_web._find_mose_executable", return_value=executable):
            with mock.patch("maw.gui_web.subprocess.Popen") as popen:
                result = self.api.open_mose({"jsonPath": str(project)})

        self.assertTrue(result["ok"])
        self.assertTrue(result["usedMose"])
        self.assertEqual(popen.call_args.args[0], [str(executable), str(project.resolve())])
        self.assertEqual(popen.call_args.kwargs["cwd"], str(self.root))

    def test_open_mose_forwards_bundled_ffmpeg_to_sibling_app(self) -> None:
        executable = self.root / "MOSE.exe"
        ffmpeg_dir = self.root / "ffmpeg" / "bin"
        executable.write_bytes(b"exe")
        ffmpeg_dir.mkdir(parents=True)

        with mock.patch("maw.gui_web._find_mose_executable", return_value=executable):
            with mock.patch("maw.gui_web._bundled_ffmpeg_directory", return_value=ffmpeg_dir):
                with mock.patch("maw.gui_web.subprocess.Popen") as popen:
                    result = self.api.open_mose({})

        self.assertTrue(result["ok"])
        child_path = popen.call_args.kwargs["env"]["PATH"].split(os.pathsep)
        self.assertEqual(child_path[0], str(ffmpeg_dir))

    def test_find_mose_prefers_executable_beside_frozen_maw(self) -> None:
        maw_executable = self.root / "MAW.exe"
        mose_executable = self.root / "MOSE.exe"
        maw_executable.write_bytes(b"exe")
        mose_executable.write_bytes(b"exe")

        with mock.patch.object(sys, "platform", "win32"):
            with mock.patch.object(sys, "frozen", True, create=True):
                with mock.patch.object(sys, "executable", str(maw_executable)):
                    self.assertEqual(_find_mose_executable(), mose_executable.resolve())

    def test_find_mose_resolves_macos_app_beside_frozen_maw(self) -> None:
        maw_executable = self.root / "MAW.app" / "Contents" / "MacOS" / "MAW"
        mose_executable = self.root / "MOSE.app" / "Contents" / "MacOS" / "mose"
        maw_executable.parent.mkdir(parents=True)
        mose_executable.parent.mkdir(parents=True)
        maw_executable.write_bytes(b"maw")
        mose_executable.write_bytes(b"mose")

        with mock.patch.object(sys, "platform", "darwin"):
            with mock.patch.object(sys, "frozen", True, create=True):
                with mock.patch.object(sys, "executable", str(maw_executable)):
                    self.assertEqual(_find_mose_executable(), mose_executable.resolve())

    def test_open_mose_reports_macos_app_when_no_desktop_editor_exists(self) -> None:
        project = self.root / "project.mosp"
        project.write_text("{}\n", encoding="utf-8")

        with mock.patch.object(sys, "platform", "darwin"):
            with mock.patch("maw.gui_web._find_mose_executable", return_value=None):
                result = self.api.open_mose({"jsonPath": str(project)})

        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "mose_not_found")
        self.assertEqual(result["detail"], "MOSE.app")
        self.assertTrue(result["searchPaths"])

    def test_register_mosp_association_points_to_mose_icon_and_command(self) -> None:
        executable = self.root / "MOSE.exe"
        executable.write_bytes(b"exe")

        class FakeKey:
            def __init__(self, path: str) -> None:
                self.path = path

            def __enter__(self) -> "FakeKey":
                return self

            def __exit__(self, *_args: object) -> None:
                return None

        class FakeWinreg:
            HKEY_CURRENT_USER = object()
            REG_SZ = 1

            def __init__(self) -> None:
                self.values: list[tuple[str, str | None, str]] = []
                self.read_values: dict[tuple[str, str], str] = {}

            def OpenKey(self, _root: object, path: str) -> FakeKey:
                return FakeKey(path)

            def QueryValueEx(self, key: FakeKey, name: str) -> tuple[str, int]:
                try:
                    return self.read_values[(key.path, name)], self.REG_SZ
                except KeyError as error:
                    raise OSError from error

            def CreateKey(self, _root: object, path: str) -> FakeKey:
                return FakeKey(path)

            def SetValueEx(self, key: FakeKey, name: str | None, _reserved: int, _kind: int, value: str) -> None:
                self.values.append((key.path, name, value))

        fake_winreg = FakeWinreg()
        with mock.patch.object(sys, "platform", "win32"):
            with mock.patch("maw.gui_web._find_mose_executable", return_value=executable):
                with mock.patch("ctypes.windll", create=True):
                    with mock.patch.dict(sys.modules, {"winreg": fake_winreg}):
                        self.assertTrue(_register_mosp_association())

        values = {path: value for path, name, value in fake_winreg.values if name is None}
        self.assertEqual(values[r"Software\Classes\.mosp"], "Moy.MOSE.Project")
        self.assertEqual(values[r"Software\Classes\Moy.MOSE.Project\DefaultIcon"], f'"{executable}",0')
        self.assertEqual(values[r"Software\Classes\Moy.MOSE.Project\shell\open\command"], f'"{executable}" "%1"')
        named_values = {(path, name): value for path, name, value in fake_winreg.values if name is not None}
        self.assertEqual(named_values[(r"Software\Moy\MOSE", "InstallPath")], str(self.root))
        self.assertEqual(named_values[(r"Software\Moy\MOSE", "ExecutablePath")], str(executable))
        self.assertEqual(named_values[(r"Software\Moy\MOSE", "Version")], "0.1.0")

    def test_find_mose_prefers_valid_registered_independent_installation(self) -> None:
        registered = self.root / "installed" / "MOSE.exe"
        bundled = self.root / "bundle" / "MOSE.exe"
        registered.parent.mkdir()
        bundled.parent.mkdir()
        registered.write_bytes(b"installed")
        bundled.write_bytes(b"bundled")
        maw_executable = bundled.parent / "MAW.exe"
        maw_executable.write_bytes(b"maw")

        class FakeKey:
            def __init__(self, path: str) -> None:
                self.path = path

            def __enter__(self) -> "FakeKey":
                return self

            def __exit__(self, *_args: object) -> None:
                return None

        class FakeWinreg:
            HKEY_CURRENT_USER = object()
            REG_SZ = 1

            def OpenKey(self, _root: object, path: str) -> FakeKey:
                return FakeKey(path)

            def QueryValueEx(self, key: FakeKey, name: str) -> tuple[str, int]:
                if key.path == r"Software\Moy\MOSE" and name == "ExecutablePath":
                    return str(registered), self.REG_SZ
                raise OSError

        with mock.patch.object(sys, "platform", "win32"):
            with mock.patch.object(sys, "frozen", True, create=True):
                with mock.patch.object(sys, "executable", str(maw_executable)):
                    with mock.patch.dict(sys.modules, {"winreg": FakeWinreg()}):
                        self.assertEqual(_find_mose_executable(), registered.resolve())

    def test_open_mose_reports_missing_project_before_starting(self) -> None:
        with mock.patch("maw.gui_web.subprocess.Popen") as popen:
            result = self.api.open_mose({"jsonPath": str(self.root / "missing.mosp")})

        self.assertFalse(result["ok"])
        self.assertEqual(result["field"], "jsonPath")
        self.assertEqual(result["code"], "json_not_found")
        popen.assert_not_called()

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

    def test_start_server_exposes_child_startup_log_when_process_exits(self) -> None:
        project = self.root / "project.json"
        media = self.root / "clip.mp4"
        project.write_text(json.dumps({"media": str(media), "segments": []}), encoding="utf-8")
        media.write_bytes(b"media")

        class FailedProcess:
            def poll(self) -> int:
                return 2

        def spawn(*_args, **kwargs):
            kwargs["stdout"].write(b"Traceback: FLV conversion failed\r\nffmpeg is unavailable\r\n")
            kwargs["stdout"].flush()
            return FailedProcess()

        with mock.patch("maw.gui_web.subprocess.Popen", side_effect=spawn):
            with mock.patch("maw.gui_web._wait_for_server", return_value=False):
                result = self.api.start_server({"jsonPath": str(project), "mediaPath": str(media), "port": "9876"})

        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "server_start_failed")
        self.assertIn("进程退出码 2", result["detail"])
        self.assertIn("FLV conversion failed", result["detail"])

    def test_start_server_reports_code_when_project_json_is_missing(self) -> None:
        """Given missing project JSON, When starting server, Then json_not_found code is returned."""
        result = self.api.start_server({"jsonPath": str(self.root / "missing.json"), "mediaPath": "", "port": "8765"})

        self.assertFalse(result["ok"])
        self.assertEqual(result["field"], "jsonPath")
        self.assertEqual(result["code"], "json_not_found")

    def test_start_server_returns_url_after_wait_helper_passes(self) -> None:
        """Given wait helper passes, When starting server, Then it returns the URL after waiting."""
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
            return len(calls) > 1

        with mock.patch("maw.gui_web.subprocess.Popen", return_value=FakeProcess()):
            with mock.patch("maw.gui_web._wait_for_server", side_effect=wait):
                result = self.api.start_server({"jsonPath": str(project), "mediaPath": str(media), "port": "9876"})

        self.assertTrue(result["ok"])
        self.assertEqual(calls, ["wait", "wait"])

    def test_start_server_returns_existing_server_url_without_spawning(self) -> None:
        """Given a responding port, When starting server, Then it reports the existing server instead of spawning."""
        with mock.patch("maw.gui_web._wait_for_server", return_value=True):
            with mock.patch("maw.gui_web.subprocess.Popen") as popen:
                result = self.api.start_server({"port": "9876", "guiLang": "zh"})

        self.assertTrue(result["ok"])
        self.assertTrue(result["serverAlreadyRunning"])
        self.assertEqual(result["url"], "http://127.0.0.1:9876/?lang=zh")
        popen.assert_not_called()

    def test_start_server_restarts_owned_server_for_a_new_project(self) -> None:
        """Given an owned server, When another project opens, Then the server is rebound to that project."""
        project = self.root / "second.json"
        media = self.root / "second.mp4"
        project.write_text(json.dumps({"media": str(media), "segments": []}), encoding="utf-8")
        media.write_bytes(b"media")

        class RunningProcess:
            returncode = None

            def poll(self) -> int | None:
                return self.returncode

            def terminate(self) -> None:
                self.returncode = -15

            def wait(self, timeout: float | None = None) -> int:
                return self.returncode or 0

        previous_process = RunningProcess()
        replacement_process = RunningProcess()
        self.api.server_process = previous_process

        with mock.patch("maw.gui_web.subprocess.Popen", return_value=replacement_process) as popen:
            with mock.patch("maw.gui_web._wait_for_server", side_effect=[True, True]):
                result = self.api.start_server({
                    "jsonPath": str(project),
                    "port": "9876",
                    "guiLang": "zh",
                })

        self.assertTrue(result["ok"])
        self.assertEqual(previous_process.returncode, -15)
        self.assertIs(self.api.server_process, replacement_process)
        self.assertEqual(popen.call_args.args[0][2], str(project))
        self.assertNotIn("serverAlreadyRunning", result)

    def test_server_status_reports_only_a_verified_maw_server(self) -> None:
        with mock.patch("maw.gui_web._wait_for_server", return_value=True):
            with mock.patch("maw.gui_web._maw_server_process_id", return_value=4321):
                result = self.api.get_server_status({"port": "9876"})

        self.assertTrue(result["ok"])
        self.assertTrue(result["running"])
        self.assertEqual(result["pid"], 4321)
        self.assertEqual(result["url"], "http://127.0.0.1:9876/")

    def test_stop_server_can_stop_a_verified_external_maw_process(self) -> None:
        with mock.patch("maw.gui_web._wait_for_server", return_value=True):
            with mock.patch("maw.gui_web._stop_external_maw_server", return_value=True) as stop_external:
                result = self.api.stop_server({"port": "9876"})

        self.assertTrue(result["ok"])
        self.assertTrue(result["stopped"])
        stop_external.assert_called_once_with(9876)

    def test_stop_server_refuses_a_non_maw_external_listener(self) -> None:
        with mock.patch("maw.gui_web._wait_for_server", return_value=True):
            with mock.patch("maw.gui_web._stop_external_maw_server", return_value=False):
                with mock.patch("maw.gui_web._maw_server_process_id", return_value=None):
                    result = self.api.stop_server({"port": "9876"})

        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "server_stop_not_maw")

    def test_maw_server_pid_verifies_the_frozen_serve_command(self) -> None:
        with mock.patch("maw.gui_web._listening_process_id", return_value=4321):
            with mock.patch("maw.gui_web._process_command_line", return_value='"D:\\Tools\\MAW.exe" --serve --port 9876'):
                from maw.gui_web import _maw_server_process_id
                self.assertEqual(_maw_server_process_id(9876), 4321)

    def test_maw_server_pid_verifies_the_public_server_command(self) -> None:
        with mock.patch("maw.gui_web._listening_process_id", return_value=4321):
            with mock.patch("maw.gui_web._process_command_line", return_value='"D:\\Tools\\MAW.exe" --server 9876'):
                from maw.gui_web import _maw_server_process_id
                self.assertEqual(_maw_server_process_id(9876), 4321)

    def test_check_server_media_reports_existing_project_media(self) -> None:
        """Given JSON embeds existing media, When checked, Then media is usable."""
        media = self.root / "clip.mp4"
        project = self.root / "project.json"
        media.write_bytes(b"media")
        project.write_text(json.dumps({"media": str(media), "segments": []}), encoding="utf-8")

        result = self.api.check_server_media({"jsonPath": str(project)})

        self.assertTrue(result["hasMedia"])
        self.assertTrue(result["mediaExists"])
        self.assertEqual(Path(result["mediaPath"]).resolve(), media.resolve())

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

    def test_check_ffmpeg_falls_back_to_bundled_tools(self) -> None:
        ffmpeg_dir = self.root / "ffmpeg" / "bin"
        ffmpeg_dir.mkdir(parents=True)
        ffmpeg = ffmpeg_dir / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
        ffprobe = ffmpeg_dir / ("ffprobe.exe" if os.name == "nt" else "ffprobe")
        ffmpeg.write_bytes(b"exe")
        ffprobe.write_bytes(b"exe")

        with mock.patch("maw.gui_web.shutil.which", return_value=None):
            with mock.patch("maw.gui_web._bundled_ffmpeg_directory", return_value=ffmpeg_dir):
                result = self.api.check_ffmpeg()

        self.assertTrue(result["found"])
        self.assertEqual(result["ffmpeg"], str(ffmpeg))
        self.assertEqual(result["ffprobe"], str(ffprobe))

    def test_save_ffmpeg_path_invalid_stays_missing(self) -> None:
        result = self.api.save_ffmpeg_path({"path": str(self.root / "missing")})

        self.assertFalse(result["ok"])
        self.assertFalse(result["found"])

    def test_save_ffmpeg_path_reports_configuration_write_failure(self) -> None:
        with mock.patch("maw.gui_web.save_env", side_effect=PermissionError("read-only app bundle")):
            result = self.api.save_ffmpeg_path({"path": "/opt/homebrew/bin"})

        self.assertFalse(result["ok"])
        self.assertEqual(result["field"], "ffmpegPath")
        self.assertEqual(result["code"], "config_save_failed")
        self.assertIn("read-only app bundle", result["detail"])

    def test_save_ffmpeg_path_accepts_a_directory_with_both_macos_tools(self) -> None:
        ffmpeg_dir = self.root / "bin"
        ffmpeg_dir.mkdir()
        ffmpeg_name = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
        ffprobe_name = "ffprobe.exe" if os.name == "nt" else "ffprobe"
        (ffmpeg_dir / ffmpeg_name).write_bytes(b"executable")
        (ffmpeg_dir / ffprobe_name).write_bytes(b"executable")

        result = self.api.save_ffmpeg_path({"path": str(ffmpeg_dir)})

        self.assertTrue(result["ok"])
        self.assertTrue(result["found"])
        self.assertEqual(result["directory"], str(ffmpeg_dir))
        self.assertIn(f"FFMPEG_PATH={ffmpeg_dir}", self.env_path.read_text(encoding="utf-8"))

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

    @unittest.skipUnless(os.name == "nt", "os.startfile 仅 Windows 可用；os.name 补丁会让 pathlib 选择 WindowsPath")
    def test_open_output_folder_uses_startfile_on_windows(self) -> None:
        folder = self.root / "out"
        folder.mkdir()
        self.api.result = mock.Mock(srt_path=folder / "a.srt", html_path=None)

        with mock.patch("maw.gui_web.os.name", "nt"):
            with mock.patch("maw.gui_web.os.startfile", create=True) as startfile:
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

    def test_default_output_avoids_existing_srt_and_reports_rename(self) -> None:
        media = self.root / "clip.mp4"
        media.write_bytes(b"media")
        output = self.root / "clip.qwen-audio.srt"
        output.write_text("existing", encoding="utf-8")

        result = self.api.default_output({"mediaPath": str(media), "providerId": "qwen", "modelId": "qwen-audio-3.0-asr-flash-filetrans"})

        self.assertTrue(result["renamed"])
        self.assertEqual(result["path"], str(self.root / "clip.qwen-audio-1.srt"))

    def test_start_transcription_rechecks_output_collision_before_worker(self) -> None:
        media = self.root / "clip.mp3"
        media.write_bytes(b"media")
        output = self.root / "out.srt"
        output.write_text("existing", encoding="utf-8")
        result = TranscriptionResult(srt_path=self.root / "out-1.srt", json_path=self.root / "out-1.mosp", html_path=None)

        with mock.patch("maw.gui_web.run_transcription", return_value=result):
            started = self.api.start_transcription({"mediaPath": str(media), "srtPath": str(output), "apiKey": "sk-test"})
            self.assertTrue(started["ok"])
            self.assertTrue(started["outputRenamed"])
            self.assertEqual(started["outputPath"], str(self.root / "out-1.srt"))
            if self.api.worker:
                self.api.worker.join(timeout=1)

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
            "debugRaw": True,
            "guiLang": "en",
        }, self.env_path)

        self.assertEqual(request.length_limit, "2m")
        self.assertEqual(request.srt_path.name, "out-test.srt")
        self.assertEqual(request.ui_language, "en")
        self.assertTrue(request.debug_raw)

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

    def test_request_from_payload_only_generates_html_when_requested(self) -> None:
        media = self.root / "clip.mp3"
        media.write_bytes(b"media")
        payload = {
            "mediaPath": str(media),
            "srtPath": str(self.root / "out.srt"),
            "apiKey": "sk-test",
        }

        self.assertFalse(_request_from_payload(payload, self.env_path).generate_html)
        self.assertTrue(_request_from_payload({**payload, "generateHtml": True}, self.env_path).generate_html)

    def test_request_from_payload_enables_speaker_colors_only_for_selected_model(self) -> None:
        media = self.root / "clip.mp3"
        media.write_bytes(b"media")
        base = {
            "providerId": "qwen",
            "mediaPath": str(media),
            "srtPath": str(self.root / "out.srt"),
            "apiKey": "sk-test",
            "region": "beijing",
            "speakerColors": True,
        }

        qwen = _request_from_payload(
            {**base, "modelId": "qwen3-asr-flash-filetrans"},
            self.env_path,
        )
        funasr = _request_from_payload(
            {**base, "modelId": "fun-asr"},
            self.env_path,
        )

        self.assertFalse(qwen.speaker_colors)
        self.assertTrue(funasr.speaker_colors)

    def test_request_from_payload_passes_qwen_audio_options_without_persisting_them(self) -> None:
        media = self.root / "clip.mp3"
        media.write_bytes(b"media")
        request = _request_from_payload({
            "providerId": "qwen",
            "modelId": "qwen-audio-3.0-asr-flash-filetrans",
            "mediaPath": str(media),
            "srtPath": str(self.root / "out.srt"),
            "apiKey": "sk-test",
            "region": "beijing",
            "qwenAudioContext": "产品名和专业术语",
            "qwenAudioHotwords": "张三\n李四,阿里云",
            "qwenAudioVocabularyId": "vocab-qwen-audio",
            "qwenAudioHotwordWeight": "50",
        }, self.env_path)

        self.assertEqual(request.qwen_audio_context, "产品名和专业术语")
        self.assertEqual(request.qwen_audio_hotwords, "张三\n李四,阿里云")
        self.assertEqual(request.qwen_audio_vocabulary_id, "vocab-qwen-audio")
        self.assertEqual(request.qwen_audio_hotword_weight, "50")

    def test_request_from_payload_passes_qwen_audio_hotword_file_mode(self) -> None:
        media = self.root / "clip.mp3"
        media.write_bytes(b"media")
        hotwords = self.root / "hotwords.txt"
        hotwords.write_text("张三\n阿里云\n", encoding="utf-8")
        request = _request_from_payload({
            "providerId": "qwen",
            "modelId": "qwen-audio-3.0-asr-flash-filetrans",
            "mediaPath": str(media),
            "srtPath": str(self.root / "out.srt"),
            "apiKey": "sk-test",
            "region": "beijing",
            "qwenAudioHotwordsMode": "file",
            "qwenAudioHotwordsFile": str(hotwords),
            "qwenAudioHotwords": "不会被使用",
        }, self.env_path)

        self.assertEqual(request.qwen_audio_hotwords_file, str(hotwords))
        self.assertEqual(request.qwen_audio_hotwords, "")

    def test_request_from_payload_rejects_missing_qwen_audio_hotword_file(self) -> None:
        media = self.root / "clip.mp3"
        media.write_bytes(b"media")

        with self.assertRaisesRegex(PreflightError, "\\.txt"):
            _request_from_payload({
                "providerId": "qwen",
                "modelId": "qwen-audio-3.0-asr-flash-filetrans",
                "mediaPath": str(media),
                "srtPath": str(self.root / "out.srt"),
                "apiKey": "sk-test",
                "region": "beijing",
                "qwenAudioHotwordsMode": "file",
                "qwenAudioHotwordsFile": str(self.root / "missing.txt"),
            }, self.env_path)

    def test_read_hotword_file_returns_utf8_text(self) -> None:
        hotwords = self.root / "hotwords.txt"
        hotwords.write_text("张三\n阿里云\n", encoding="utf-8")

        result = self.api.read_hotword_file({"path": str(hotwords)})

        self.assertTrue(result["ok"])
        self.assertEqual(result["path"], str(hotwords))
        self.assertEqual(result["text"], "张三\n阿里云\n")

    def test_request_from_payload_rejects_qwen_audio_context_over_400_characters(self) -> None:
        media = self.root / "clip.mp3"
        media.write_bytes(b"media")

        with self.assertRaisesRegex(PreflightError, "400"):
            _request_from_payload({
                "providerId": "qwen",
                "modelId": "qwen-audio-3.0-asr-flash-filetrans",
                "mediaPath": str(media),
                "srtPath": str(self.root / "out.srt"),
                "apiKey": "sk-test",
                "region": "beijing",
                "qwenAudioContext": "x" * 401,
            }, self.env_path)

    def test_event_pump_batches_events_and_preserves_order(self) -> None:
        pump = EventPump(window_getter=lambda: self.window)
        pump.enqueue({"type": "log", "message": "one"})
        pump.enqueue({"type": "log", "message": "two"})

        pump.flush()

        self.assertEqual(len(self.window.scripts), 1)
        self.assertIn("onBackendEvents", self.window.scripts[0])
        self.assertLess(self.window.scripts[0].index("one"), self.window.scripts[0].index("two"))

    def test_ffprobe_start_failure_is_recognised_from_child_output(self) -> None:
        self.assertTrue(_is_ffprobe_start_failure([
            "subprocess.CalledProcessError: Command ['ffprobe', ...]",
            "returned non-zero exit status 3221225794.",
        ]))
        self.assertFalse(_is_ffprobe_start_failure([
            "subprocess.CalledProcessError: Command ['ffprobe', ...]",
            "returned non-zero exit status 1.",
        ]))

    def test_ffmpeg_start_failure_is_recognised_from_child_output(self) -> None:
        self.assertTrue(_is_ffmpeg_start_failure([
            "Traceback: Command ['ffmpeg', '-i', 'clip.mp4']",
            "returned non-zero exit status 3221225794.",
        ]))
        self.assertFalse(_is_ffmpeg_start_failure([
            "Command ['ffmpeg', ...]",
            "returned non-zero exit status 1.",
        ]))

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
        self.assertIn('"rawPath": ""', event_script)

    def test_worker_emits_retryable_error_for_ffprobe_start_failure(self) -> None:
        request = TranscriptionRequest(
            media_path=self.root / "clip.wav",
            srt_path=self.root / "clip.srt",
        )

        def fail_with_ffprobe_output(*_args: object, **kwargs: object) -> None:
            callback = kwargs["on_event"]
            assert callable(callback)
            callback("subprocess.CalledProcessError: Command ['ffprobe', ...]")
            callback("returned non-zero exit status 3221225794.")
            raise TranscriptionProcessError(1)

        with mock.patch("maw.gui_web.run_transcription", side_effect=fail_with_ffprobe_output):
            self.api._worker_main(request, threading.Event())

        self.assertTrue(self.window.scripts)
        event_script = self.window.scripts[-1]
        self.assertIn('"code": "ffprobe_start_failed"', event_script)
        self.assertIn('"detail": "Transcription failed with exit code 1"', event_script)

    def test_worker_emits_retryable_error_for_ffmpeg_start_failure(self) -> None:
        request = TranscriptionRequest(
            media_path=self.root / "clip.mp4",
            srt_path=self.root / "clip.srt",
        )

        def fail_with_ffmpeg_output(*_args: object, **kwargs: object) -> None:
            callback = kwargs["on_event"]
            assert callable(callback)
            callback("Traceback: Command ['ffmpeg', '-i', 'clip.mp4']")
            callback("returned non-zero exit status 3221225794.")
            raise TranscriptionProcessError(1)

        with mock.patch("maw.gui_web.run_transcription", side_effect=fail_with_ffmpeg_output):
            self.api._worker_main(request, threading.Event())

        self.assertTrue(self.window.scripts)
        event_script = self.window.scripts[-1]
        self.assertIn('"code": "ffmpeg_start_failed"', event_script)
        self.assertIn('"detail": "Transcription failed with exit code 1"', event_script)

    def test_route_dropped_path_routes_json_media_and_hotword_file(self) -> None:
        """Given dropped paths, When routed, Then event type mirrors launcher drop behavior."""
        media = _route_dropped_path(r"D:\Videos\clip.MP4")
        project = _route_dropped_path(r"D:\Videos\clip.json")
        mosp_project = _route_dropped_path(r"D:\Videos\clip.mosp")
        hotwords = _route_dropped_path(r"D:\Videos\clip.txt")

        self.assertEqual(media, {"type": "dropMedia", "path": r"D:\Videos\clip.MP4"})
        self.assertEqual(project, {"type": "dropJson", "path": r"D:\Videos\clip.json"})
        self.assertEqual(mosp_project, {"type": "dropJson", "path": r"D:\Videos\clip.mosp"})
        self.assertEqual(hotwords, {"type": "dropHotwordFile", "path": r"D:\Videos\clip.txt"})


@final
class LauncherAssetContractTests(unittest.TestCase):
    def test_launcher_hero_shows_the_bundled_brand_icon(self) -> None:
        page = (ROOT / "web" / "launcher" / "index.html").read_text(encoding="utf-8")
        stylesheet = (ROOT / "web" / "launcher" / "launcher.css").read_text(encoding="utf-8")

        self.assertIn('<div class="hero-brand">', page)
        self.assertIn('<img class="hero-icon" src="../../assets/show.webp"', page)
        self.assertIn(".hero-icon {\n  width: 72px;\n  height: 72px;", stylesheet)

    def test_launcher_reports_media_drop_rejection_and_output_collision(self) -> None:
        page = (ROOT / "web" / "launcher" / "index.html").read_text(encoding="utf-8")
        script = (ROOT / "web" / "launcher" / "launcher.js").read_text(encoding="utf-8")

        self.assertIn('id="srtPathNotice" class="hint warn hidden"', page)
        self.assertIn("drop_reject_media", script)
        self.assertIn('drop_reject_media: "仅支持以下媒体文件类型：\\n{extensions}"', script)
        self.assertIn('function appendMessageText(container, text)', script)
        self.assertIn('setError("mediaPath", mediaDropError())', script)
        self.assertIn('output_collision: "检测到同名输出文件', script)
        self.assertIn("result.outputRenamed", script)

    def test_sticker_picker_saves_immediately_without_a_separate_button(self) -> None:
        page = (ROOT / "web" / "launcher" / "index.html").read_text(encoding="utf-8")
        script = (ROOT / "web" / "launcher" / "launcher.js").read_text(encoding="utf-8")

        self.assertNotIn('id="saveStickerDir"', page)
        self.assertIn('if (result.ok) await saveStickerDirectory(result.path);', script)

    def test_ffmpeg_save_distinguishes_write_failure_from_missing_tools(self) -> None:
        script = (ROOT / "web" / "launcher" / "launcher.js").read_text(encoding="utf-8")

        self.assertIn("config_save_failed", script)
        self.assertIn("result.found === false", script)
        self.assertIn("if (!result.ok) { const message = ffmpegSaveError(result);", script)

    def test_default_editor_port_is_8250(self) -> None:
        page = (ROOT / "web" / "launcher" / "index.html").read_text(encoding="utf-8")

        self.assertEqual(_port({}), 8250)
        self.assertEqual(_port({"port": "invalid"}), 8250)
        self.assertIn('id="port" type="number" min="1" max="65535" value="8250"', page)
        self.assertIn('id="refreshServerStatus"', page)

    def test_single_file_editor_controls_are_opt_in_and_contextual(self) -> None:
        page = (ROOT / "web" / "launcher" / "index.html").read_text(encoding="utf-8")
        script = (ROOT / "web" / "launcher" / "launcher.js").read_text(encoding="utf-8")

        self.assertIn('id="generateHtml" type="checkbox"', page)
        self.assertIn('id="debugRaw" type="checkbox"', page)
        self.assertIn('data-i18n-title="debug_raw_title"', page)
        self.assertIn('data-i18n="test_run">快速测试', page)
        self.assertIn('data-i18n="test_run_override">快速测试已限定前 2 分钟', page)
        self.assertGreater(page.index('id="debugRaw"'), page.index('id="speakerColorsField"'))
        self.assertGreater(page.index('id="debugRawField"'), page.index('id="advancedCard"'))
        self.assertIn('data-i18n-title="generate_html_title"', page)
        self.assertIn('id="openHtml" class="hidden"', page)
        self.assertIn('generateHtml: $("generateHtml").checked', script)
        self.assertIn('debugRaw: $("debugRaw").checked', script)
        self.assertIn('test_run: "快速测试"', script)
        self.assertIn('test_run: "Quick test"', script)
        self.assertIn('function syncHtmlMenu()', script)
        self.assertIn('$("openHtml").classList.toggle("hidden", !enabled)', script)
        self.assertIn('$("openHtml").disabled = enabled && !state.result?.htmlPath', script)

    def test_server_status_uses_clickable_link_and_independent_stop_control(self) -> None:
        page = (ROOT / "web" / "launcher" / "index.html").read_text(encoding="utf-8")
        script = (ROOT / "web" / "launcher" / "launcher.js").read_text(encoding="utf-8")

        self.assertIn('function setServerStatus(url, alreadyRunning = false, prefix = "")', script)
        self.assertIn('bridge("open_url", { url })', script)
        self.assertIn('server_already_running', script)
        self.assertIn('get_server_status', script)
        self.assertIn('id="stopServer" class="ghost server-stop hidden"', page)
        self.assertIn('$("stopServer").addEventListener("click", stopEditorServer)', script)
        self.assertIn('bridge("stop_server", serverPayload())', script)
        self.assertIn('void checkExistingServer(t("done"));', script)
        self.assertIn('id="refreshServerStatus"', page)
        self.assertNotIn('state.serverRunning ? t("server_stop")', script)

    def test_workspace_requests_sync_server_config_from_response(self) -> None:
        script = (ROOT / "web" / "editor.js").read_text(encoding="utf-8")

        self.assertIn('async function updateServerWorkspaceSettings(payload)', script)
        self.assertIn('body: JSON.stringify(payload)', script)
        self.assertIn('SERVER_CONFIG.savedWorkspaces = result.savedWorkspaces || {};', script)
        self.assertIn("SERVER_CONFIG.activeWorkspaceName = result.activeWorkspaceName || '';", script)
        self.assertIn('SERVER_CONFIG.autoOpenLastProject = result.autoOpenLastProject !== false;', script)

    def test_saved_workspace_is_kept_in_the_current_select_list(self) -> None:
        script = (ROOT / "web" / "editor.js").read_text(encoding="utf-8")

        self.assertIn("SERVER_CONFIG.savedWorkspaces = { ...getSavedServerWorkspaces(), [name]: workspace };", script)
        self.assertIn("workspacePresetSelect.querySelector('optgroup[data-saved-workspaces]')?.remove();", script)
        self.assertNotIn("当前服务器版本不支持保存布局", script)

    def test_workspace_select_is_owned_by_editor_not_waveform(self) -> None:
        script = (ROOT / "web" / "editor.js").read_text(encoding="utf-8")
        waveform = (ROOT / "web" / "waveform.js").read_text(encoding="utf-8")

        self.assertNotIn('layoutPresetSelect', waveform)
        self.assertIn('const workspacePresetSelect = document.getElementById(\'workspace-preset\');', script)
        self.assertIn("workspacePresetSelect?.addEventListener('change', () => applyWorkspaceSelection(workspacePresetSelect.value));", script)

    def test_builtin_workspace_save_uses_its_visible_name(self) -> None:
        script = (ROOT / "web" / "editor.js").read_text(encoding="utf-8")

        self.assertIn('function currentWorkspaceDisplayName()', script)
        self.assertIn('const displayName = saveAs ? name : currentWorkspaceDisplayName();', script)
        self.assertIn('已保存工作区：${displayName}', script)
        self.assertIn('[currentBuiltinWorkspaceName]: workspace };', script)

    def test_html_editor_menu_uses_current_labels_and_closes_outside_the_menu(self) -> None:
        page = (ROOT / "web" / "launcher" / "index.html").read_text(encoding="utf-8")
        script = (ROOT / "web" / "launcher" / "launcher.js").read_text(encoding="utf-8")

        self.assertIn("打开该工程的 HTML 编辑器", page)
        self.assertIn("打开空的 HTML 编辑器", page)
        self.assertIn('event.target.closest(".split-wrap")', script)

    def test_launcher_uses_server_as_default_and_hides_mose_in_menu(self) -> None:
        page = (ROOT / "web" / "launcher" / "index.html").read_text(encoding="utf-8")
        script = (ROOT / "web" / "launcher" / "launcher.js").read_text(encoding="utf-8")

        self.assertIn('id="openMawe" class="ghost split-main" type="button" data-i18n="start_server_editor"', page)
        self.assertNotIn('id="openMose"', page)
        self.assertNotIn("在 MOSE 中打开", page)
        self.assertIn('$("openMawe").addEventListener("click", openServerEditor)', script)
        self.assertNotIn("openMose", script)
        self.assertNotIn("open_mose", script)
        self.assertIn('function openServerEditor()', script)
        self.assertIn('bridge("start_server"', script)

    def test_project_change_marks_server_editor_action_for_rebinding(self) -> None:
        script = (ROOT / "web" / "launcher" / "launcher.js").read_text(encoding="utf-8")

        self.assertIn('function setJsonPath(path)', script)
        self.assertIn('$("openMawe").classList.add("attention")', script)
        self.assertIn('state.serverProjectPath', script)

    def test_language_filter_hint_is_available_to_single_language_providers(self) -> None:
        page = (ROOT / "web" / "launcher" / "index.html").read_text(encoding="utf-8")
        script = (ROOT / "web" / "launcher" / "launcher.js").read_text(encoding="utf-8")

        self.assertIn('id="languageFilterHint"', page)
        self.assertIn('language_filter_hint: "默认仅显示常用语言', script)
        self.assertIn('$("languageFilterHint").classList.toggle("hidden", showRare || commons.length === 0);', script)
        self.assertIn("const selectedModel = () =>", script)
        self.assertIn("applyProviderLanguages(provider(), selectedModel())", script)

    def test_qwen_audio_launcher_exposes_one_shot_context_and_hotwords_only(self) -> None:
        page = (ROOT / "web" / "launcher" / "index.html").read_text(encoding="utf-8")
        script = (ROOT / "web" / "launcher" / "launcher.js").read_text(encoding="utf-8")

        for field in ("qwenAudioContext", "qwenAudioHotwordsMode", "qwenAudioHotwords", "qwenAudioHotwordsFile", "qwenAudioHotwordWeight"):
            self.assertIn(f'id="{field}"', page)
        self.assertIn('qwenAudioContext: $("qwenAudioContext").value.trim()', script)
        self.assertIn('qwenAudioHotwords: $("qwenAudioHotwords").value.trim()', script)
        self.assertIn('qwenAudioHotwordsMode: $("qwenAudioHotwordsMode").value', script)
        self.assertIn('qwenAudioHotwordsFile: $("qwenAudioHotwordsFile").value.trim()', script)
        self.assertIn('kind: "hotwords"', script)
        self.assertIn('read_hotword_file', script)
        self.assertIn('qwenAudioContextCount', page)
        self.assertIn('classList.toggle("over-limit", count > 400)', script)
        self.assertIn('qwenAudioHotwordsWarning', page)
        self.assertIn('qwen_audio_hotwords_weight_override_hint', script)
        self.assertIn('parseHotwordEntry', script)
        self.assertIn('MAX_SUPER_HOTWORDS = 50', script)
        self.assertNotIn('id="qwenAudioVocabularyId"', page)
        self.assertNotIn("qwenAudioVocabularyId", script)
        self.assertIn('supportsContext', script)

    def test_regional_fields_are_temporarily_hidden_for_domestic_launcher(self) -> None:
        page = (ROOT / "web" / "launcher" / "index.html").read_text(encoding="utf-8")
        script = (ROOT / "web" / "launcher" / "launcher.js").read_text(encoding="utf-8")

        self.assertIn('id="regionField" class="field hidden"', page)
        self.assertIn('id="workspaceField" class="field hidden"', page)
        self.assertIn("北京地域选填（推荐），新加坡地域必填。", page)
        self.assertIn(
            "const SHOW_REGIONAL_FIELDS = false;",
            script,
        )
        self.assertIn(
            '$("regionField").classList.toggle("hidden", !SHOW_REGIONAL_FIELDS || current.regions.length === 0);',
            script,
        )
        self.assertIn(
            '$("workspaceField").classList.toggle("hidden", !SHOW_REGIONAL_FIELDS || provider().regions.length === 0);',
            script,
        )
        self.assertIn('data.region === "singapore" && !data.workspaceId', script)

    def test_launcher_section_titles_share_emoji_numbering_and_size(self) -> None:
        page = (ROOT / "web" / "launcher" / "index.html").read_text(encoding="utf-8")
        stylesheet = (ROOT / "web" / "launcher" / "launcher.css").read_text(encoding="utf-8")

        for expected in ("1️⃣ 媒体与输出", "2️⃣ 识别设置", "3️⃣ 日志", "4️⃣ 字幕编辑器设置"):
            self.assertIn(expected, page)
        self.assertIn(".card h2 {\n  margin: 0 0 12px;\n  color: var(--text-secondary);\n  font-size: 16px;", stylesheet)

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
        self.assertIn("border-color: var(--amber-hover);", stylesheet)


if __name__ == "__main__":
    unittest.main()
