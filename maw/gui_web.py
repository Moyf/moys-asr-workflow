# pyright: reportAny=false, reportAttributeAccessIssue=false, reportMissingImports=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnusedCallResult=false

from __future__ import annotations

import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import tempfile
import time
import webbrowser
from urllib.error import URLError
from urllib.request import urlopen
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from threading import Event
from typing import BinaryIO, Final, final

from maw.gui_config import DEFAULT_ENV_PATH, DEFAULT_MODEL_ID, LANGUAGES, MODELS, PROVIDERS, REGIONS, ModelConfig, ProviderConfig, api_key_for_provider, effective_config, masked_secret, model_by_label, provider_by_id, provider_for_model, save_env
from maw.gui_platform import apply_dark_title_bar, asset_path, creationflags, startupinfo
from maw.gui_workflow import TranscriptionProcessError, TranscriptionRequest, TranscriptionResult, _bundled_ffmpeg_directory, _child_environment, build_serve_command, default_srt_path, run_transcription, with_test_suffix
from maw.media import resolve_project_media


OPEN_DIALOG = 10
SAVE_DIALOG = 30
FOLDER_DIALOG = 20
WINDOW_TITLE = "MAW Launcher"
MEDIA_EXTS: Final = frozenset({".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".ts", ".m4v", ".mp3", ".wav", ".m4a", ".flac", ".aac", ".ogg"})
MOSE_REGISTRY_KEY = r"Software\Moy\MOSE"
MOSE_FILE_TYPE = "Moy.MOSE.Project"
# Keep this aligned with desktop/src-tauri/tauri.conf.json until an installer owns it.
MOSE_VERSION = "0.1.0"


ERROR_MESSAGES: Final[dict[str, str]] = {
    "json_not_found": "Project file does not exist.",
    "media_not_found": "Media file does not exist.",
    "server_media_missing": "Project media is missing, unsupported, or ambiguous. Choose media manually.",
    "api_key_missing": "API key is required.",
    "workspace_missing": "Workspace ID is required for Singapore region.",
    "output_missing": "SRT output path is required.",
    "context_too_long": "Qwen-Audio context is limited to 400 characters.",
    "hotwords_file_missing": "Choose an existing UTF-8 .txt hotword file.",
    "server_no_response": "Editor server did not respond.",
    "server_start_failed": "Editor server failed to start.",
    "mose_not_found": "MOSE desktop editor was not found in this MAW package.",
    "mose_start_failed": "MOSE desktop editor failed to start.",
    "server_stop_not_maw": "The process using this port is not a MAW editor server.",
    "server_stop_failed": "Unable to stop the MAW editor server.",
    "sticker_dir_invalid": "Sticker directory does not exist.",
    "config_save_failed": "Local configuration could not be saved.",
}


def _app_version(paths: object) -> str:
    """Read project.version from pyproject.toml for the hero wordmark; fall back to the bundled release."""
    root = getattr(paths, "root", None)
    pyproject = (root / "pyproject.toml") if root else Path("pyproject.toml")
    try:
        text = Path(pyproject).read_text(encoding="utf-8")
    except OSError:
        return "1.13.1-beta-5"
    match = re.search(r'(?m)^version = "([^"]+)"\r?$', text)
    return match.group(1) if match else "1.13.1-beta-5"


def _is_ffprobe_start_failure(lines: Sequence[str]) -> bool:
    """Recognise the Windows loader failure emitted by a nested ffprobe process."""
    detail = "\n".join(lines).lower()
    return "ffprobe" in detail and any(
        marker in detail for marker in ("3221225794", "0xc0000142", "c0000142")
    )


def _registered_mose_executable() -> Path | None:
    """Read a valid independent MOSE installation registered for this user."""
    if sys.platform != "win32":
        return None
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, MOSE_REGISTRY_KEY) as key:
            try:
                value = winreg.QueryValueEx(key, "ExecutablePath")[0]
            except OSError:
                install_path = winreg.QueryValueEx(key, "InstallPath")[0]
                value = Path(str(install_path)) / "MOSE.exe"
    except (AttributeError, ImportError, OSError, TypeError, ValueError):
        return None
    candidate = Path(str(value)).expanduser()
    if not candidate.is_file():
        return None
    try:
        return candidate.resolve()
    except OSError:
        return candidate


def _macos_mose_executable(app_path: Path) -> Path | None:
    """Return the executable inside a macOS MOSE application bundle."""
    for name in ("mose", "MOSE"):
        candidate = app_path / "Contents" / "MacOS" / name
        if candidate.is_file():
            return candidate
    return None


def _mose_search_paths() -> list[Path]:
    """Return the optional MOSE paths that the MAW Launcher will inspect."""
    candidates: list[Path] = []
    registered = _registered_mose_executable()
    if registered is not None:
        candidates.append(registered)

    repo_root = Path(__file__).resolve().parents[1]
    if sys.platform == "darwin":
        app_candidates: list[Path] = [
            repo_root / "MOSE.app",
            repo_root / "mose.app",
            repo_root / "desktop" / "target" / "release" / "bundle" / "macos" / "MOSE.app",
            repo_root / "desktop" / "target" / "release" / "bundle" / "macos" / "mose.app",
            repo_root / "desktop" / "target" / "debug" / "bundle" / "macos" / "MOSE.app",
            repo_root / "desktop" / "target" / "debug" / "bundle" / "macos" / "mose.app",
            asset_path("MOSE.app"),
            asset_path("mose.app"),
            Path("/Applications/MOSE.app"),
            Path("/Applications/mose.app"),
            Path.home() / "Applications" / "MOSE.app",
            Path.home() / "Applications" / "mose.app",
        ]
        if getattr(sys, "frozen", False):
            executable_path = Path(sys.executable).resolve()
            executable_dir = executable_path.parent
            frozen_app_candidates = [
                executable_dir / "MOSE.app",
                executable_dir / "mose.app",
                executable_dir.parent / "Resources" / "MOSE.app",
                executable_dir.parent / "Resources" / "mose.app",
                executable_dir.parent.parent.parent / "MOSE.app",
                executable_dir.parent.parent.parent / "mose.app",
            ]
            # In a normal PyInstaller .app, sys.executable is inside
            # MAW.app/Contents/MacOS. Derive the sibling from the actual .app
            # ancestor instead of relying on a fixed number of parent levels;
            # this also works when the bundle is launched through a symlink or
            # when PyInstaller changes its internal layout.
            for bundle_path in executable_path.parents:
                if bundle_path.suffix.lower() == ".app":
                    frozen_app_candidates.extend(
                        (
                            bundle_path.parent / "MOSE.app",
                            bundle_path.parent / "mose.app",
                        )
                    )
            app_candidates[0:0] = frozen_app_candidates
        candidates.extend(app_candidates)
    else:
        if getattr(sys, "frozen", False):
            executable_dir = Path(sys.executable).resolve().parent
            candidates.extend((executable_dir / "MOSE.exe", executable_dir / "mose.exe"))
        candidates.extend(
            (
                repo_root / "MOSE.exe",
                repo_root / "mose.exe",
                repo_root / "desktop" / "target" / "release" / "mose.exe",
                repo_root / "desktop" / "target" / "debug" / "mose.exe",
                asset_path("MOSE.exe"),
                asset_path("mose.exe"),
            )
        )

    return candidates


def _find_mose_executable() -> Path | None:
    """Find the optional MOSE executable or macOS app bundle for the MAW Launcher."""
    seen: set[Path] = set()
    for candidate in _mose_search_paths():
        if sys.platform == "darwin" and candidate.suffix.lower() == ".app":
            executable = _macos_mose_executable(candidate)
            if executable is None:
                continue
            candidate = executable
        try:
            candidate = candidate.resolve()
        except OSError:
            continue
        if candidate in seen:
            continue
        seen.add(candidate)
        if candidate.is_file():
            return candidate
    return None


def _mose_environment() -> dict[str, str]:
    """Pass a bundled MAWxFF directory to MOSE when the two apps are siblings."""
    environment = os.environ.copy()
    bundled_directory = _bundled_ffmpeg_directory()
    if bundled_directory is not None:
        old_path = environment.get("PATH", "")
        environment["PATH"] = str(bundled_directory) if not old_path else str(bundled_directory) + os.pathsep + old_path
    return environment


def _register_mosp_association() -> bool:
    """Register the portable package's .mosp association for the current Windows user."""
    if sys.platform != "win32":
        return False
    registered = _registered_mose_executable()
    executable = registered or _find_mose_executable()
    if executable is None:
        return False
    # MOSE.exe already embeds the MOSE icon.  Referencing the executable keeps
    # the association self-contained in the portable bundle and avoids pointing
    # Explorer at MAW's launcher icon (or at a stale _MEIPASS path).
    icon = executable
    try:
        import winreg

        version = MOSE_VERSION
        if registered is not None:
            try:
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER, MOSE_REGISTRY_KEY) as mose_key:
                    existing_version = winreg.QueryValueEx(mose_key, "Version")[0]
                if str(existing_version).strip():
                    version = str(existing_version).strip()
            except (AttributeError, OSError, TypeError, ValueError):
                pass

        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, MOSE_REGISTRY_KEY) as mose_key:
            winreg.SetValueEx(mose_key, "InstallPath", 0, winreg.REG_SZ, str(executable.parent))
            winreg.SetValueEx(mose_key, "ExecutablePath", 0, winreg.REG_SZ, str(executable))
            winreg.SetValueEx(mose_key, "Version", 0, winreg.REG_SZ, version)
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, r"Software\Classes\.mosp") as extension_key:
            winreg.SetValueEx(extension_key, None, 0, winreg.REG_SZ, MOSE_FILE_TYPE)
            winreg.SetValueEx(extension_key, "Content Type", 0, winreg.REG_SZ, "application/json")
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, rf"Software\Classes\{MOSE_FILE_TYPE}") as file_type_key:
            winreg.SetValueEx(file_type_key, None, 0, winreg.REG_SZ, "MOSE Project")
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, rf"Software\Classes\{MOSE_FILE_TYPE}\DefaultIcon") as icon_key:
            winreg.SetValueEx(icon_key, None, 0, winreg.REG_SZ, f'"{icon}",0')
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, rf"Software\Classes\{MOSE_FILE_TYPE}\shell\open\command") as command_key:
            winreg.SetValueEx(command_key, None, 0, winreg.REG_SZ, f'"{executable}" "%1"')
    except (AttributeError, ImportError, OSError):
        return False
    try:
        import ctypes

        # Make Explorer invalidate its cached association/icon immediately.
        ctypes.windll.shell32.SHChangeNotify(0x08000000, 0, None, None)
    except (AttributeError, OSError, TypeError):
        pass
    return True


@final
class EventPump:
    def __init__(self, *, window_getter: Callable[[], object | None], interval: float = 0.1) -> None:
        self.window_getter = window_getter
        self.interval = interval
        self.events: queue.Queue[Mapping[str, object]] = queue.Queue()
        self.stop_event = threading.Event()
        self.thread: threading.Thread | None = None
        self.lock = threading.Lock()

    def start(self) -> None:
        with self.lock:
            if self.thread and self.thread.is_alive():
                return
            self.stop_event.clear()
            self.thread = threading.Thread(target=self._run, daemon=True)
            self.thread.start()

    def enqueue(self, event: Mapping[str, object]) -> None:
        self.events.put(dict(event))

    def flush(self) -> None:
        batch: list[Mapping[str, object]] = []
        while True:
            try:
                batch.append(self.events.get_nowait())
            except queue.Empty:
                break
        if not batch:
            return
        window = self.window_getter()
        if window is None:
            return
        script = f"window.MAWLauncher && window.MAWLauncher.onBackendEvents({json.dumps(batch, ensure_ascii=False)})"
        window.evaluate_js(script)

    def shutdown(self) -> None:
        self.stop_event.set()
        self.flush()

    def _run(self) -> None:
        while not self.stop_event.wait(self.interval):
            self.flush()


@dataclass(frozen=True, slots=True)
class LauncherPaths:
    root: Path
    env_path: Path
    launcher_html: Path


def default_paths() -> LauncherPaths:
    root = Path(__file__).resolve().parents[1]
    return LauncherPaths(root=root, env_path=DEFAULT_ENV_PATH, launcher_html=root / "web" / "launcher" / "index.html")


@final
class LauncherApi:
    def __init__(self, *, paths: LauncherPaths | None = None, window_getter: Callable[[], object | None] | None = None) -> None:
        self.paths = paths or default_paths()
        self.window_getter = window_getter or _active_window
        self.cancel_event: Event | None = None
        self.worker: threading.Thread | None = None
        self.server_process: subprocess.Popen[str] | None = None
        self.server_log_file: BinaryIO | None = None
        self.result: TranscriptionResult | None = None
        self.pump = EventPump(window_getter=self.window_getter)

    def get_config(self, _payload: Mapping[str, object] | None = None) -> dict[str, object]:
        config = effective_config(self.paths.env_path)
        provider = provider_for_model(MODELS[0].id)
        return {
            "providerId": provider.id,
            "modelId": MODELS[0].id,
            "apiKey": config.api_key,
            "maskedApiKey": masked_secret(config.api_key),
            "region": config.region,
            "workspaceId": config.workspace_id,
            "language": config.language,
            "guiLang": config.gui_lang,
            "appVersion": _app_version(self.paths),
            "stickerDir": config.sticker_dir,
            "showRareLangs": config.show_rare_langs,
            "lastModel": config.last_model,
            "lastLanguage": config.last_language,
            "models": [_model_payload(item) for item in MODELS],
            "regions": [{"id": value, "label": label} for value, label in REGIONS],
            "languages": [{"id": value, "label": label} for value, label in LANGUAGES],
            "providers": [_provider_payload(item, self.paths.env_path) for item in PROVIDERS],
        }

    def default_output(self, payload: Mapping[str, object]) -> dict[str, object]:
        media_text = str(payload.get("mediaPath") or "").strip()
        provider_id = str(payload.get("providerId") or "qwen")
        model_id = str(payload.get("modelId") or DEFAULT_MODEL_ID)
        test_run = bool(payload.get("testRun"))
        return {
            "ok": bool(media_text),
            "path": str(default_srt_path(Path(media_text), provider=provider_id, model=model_id, test_run=test_run))
            if media_text else "",
        }

    def save_settings(self, payload: Mapping[str, object]) -> dict[str, object]:
        api_key = str(payload.get("apiKey") or "").strip()
        provider = provider_by_id(str(payload.get("providerId") or "qwen"))
        model_id = str(payload.get("modelId") or "")
        model = next((item for item in provider.models if model_id in (item.id, item.label)), provider.models[0] if provider.models else model_by_label(model_id))
        updates = {
            model.env_key: api_key,
            "MAW_GUI_LANG": _gui_lang(payload),
        }
        if provider.id == "qwen":
            updates["DASHSCOPE_REGION"] = str(payload.get("region") or "beijing")
            updates["DASHSCOPE_DEFAULT_LANGUAGE"] = str(payload.get("language") or "")
            updates["DASHSCOPE_WORKSPACE_ID"] = str(payload.get("workspaceId") or "").strip()
        try:
            save_env(self.paths.env_path, updates)
        except (OSError, UnicodeError) as error:
            return _error_result("", "config_save_failed", f"{self.paths.env_path}: {error}")
        return {"ok": True, "maskedApiKey": masked_secret(api_key), "message": "settings saved"}

    def save_prefs(self, payload: Mapping[str, object]) -> dict[str, object]:
        updates: dict[str, str] = {}
        if "modelId" in payload:
            updates["MAW_GUI_LAST_MODEL"] = str(payload.get("modelId") or "")
        if "language" in payload:
            updates["MAW_GUI_LAST_LANGUAGE"] = str(payload.get("language") or "")
        if "showRareLangs" in payload:
            updates["MAW_GUI_SHOW_RARE_LANGS"] = "true" if payload.get("showRareLangs") else "false"
        if updates:
            try:
                save_env(self.paths.env_path, updates)
            except (OSError, UnicodeError) as error:
                return _error_result("", "config_save_failed", f"{self.paths.env_path}: {error}")
        return {"ok": True}

    def choose_file(self, payload: Mapping[str, object]) -> dict[str, object]:
        kind = str(payload.get("kind") or "media")
        if kind == "json":
            file_types = ("MAW projects (*.mosp;*.json)",)
        elif kind == "hotwords":
            file_types = ("Text files (*.txt)", "All files (*.*)")
        else:
            file_types = ("Media files (*.mp4;*.mkv;*.avi;*.mov;*.wmv;*.flv;*.webm;*.ts;*.m4v;*.mp3;*.wav;*.m4a;*.flac;*.aac;*.ogg)", "All files (*.*)")
        chosen = _file_dialog(open_dialog=True, file_types=file_types)
        return _dialog_result(chosen)

    def read_hotword_file(self, payload: Mapping[str, object]) -> dict[str, object]:
        value = str(payload.get("path") or "").strip()
        path = Path(value).expanduser()
        if not value or not path.is_file() or path.suffix.lower() != ".txt":
            return _error_result("qwenAudioHotwordsFile", "hotwords_file_missing", value)
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as error:
            return _error_result("qwenAudioHotwordsFile", "hotwords_file_missing", str(error))
        return {"ok": True, "path": str(path), "text": text}

    def choose_folder(self, _payload: Mapping[str, object] | None = None) -> dict[str, object]:
        chosen = _folder_dialog()
        return _dialog_result(chosen)

    def choose_save_srt(self, payload: Mapping[str, object]) -> dict[str, object]:
        current = str(payload.get("currentPath") or "").strip()
        media = str(payload.get("mediaPath") or "").strip()
        filename = Path(current or str(default_srt_path(Path(media or "output.mp3")))).name
        chosen = _file_dialog(open_dialog=False, save_filename=filename, file_types=("SRT (*.srt)",))
        return _dialog_result(chosen)

    def open_url(self, payload: Mapping[str, object]) -> dict[str, object]:
        url = str(payload.get("url") or "").strip()
        if not url.startswith(("https://", "http://")):
            return {"ok": False, "error": "Invalid URL."}
        webbrowser.open(url)
        return {"ok": True}

    def open_mose(self, payload: Mapping[str, object]) -> dict[str, object]:
        """Open the packaged MOSE editor and pass it the selected project path."""
        project_text = str(payload.get("jsonPath") or "").strip()
        project = Path(project_text).expanduser() if project_text else None
        if project is not None and not project.is_file():
            return _error_result("jsonPath", "json_not_found", str(project))

        executable = _find_mose_executable()
        if executable is None:
            expected = "MOSE.app" if sys.platform == "darwin" else "MOSE.exe"
            result = _error_result("editor", "mose_not_found", expected)
            result["searchPaths"] = [str(path) for path in _mose_search_paths()]
            return result

        command = [str(executable)]
        if project is not None:
            command.append(str(project.resolve()))
        try:
            subprocess.Popen(
                command,
                cwd=str(executable.parent),
                startupinfo=startupinfo(),
                creationflags=creationflags(),
                env=_mose_environment(),
            )
        except OSError as error:
            return _error_result("editor", "mose_start_failed", str(error))
        return {"ok": True, "usedMose": True, "path": str(executable)}

    def start_server(self, payload: Mapping[str, object]) -> dict[str, object]:
        json_text = str(payload.get("jsonPath") or "").strip()
        port = _port(payload)
        url = f"http://127.0.0.1:{port}/"
        launch_url = f"{url}?lang={_gui_lang(payload)}"

        owned_server_running = self.server_process is not None and self.server_process.poll() is None
        if _wait_for_server(url, timeout=0.25) and (not json_text or not owned_server_running):
            return {"ok": True, "url": launch_url, "serverAlreadyRunning": True}
        if not json_text:
            # 无工程：不带 JSON 路径启动，由服务器按「自动打开上次工程」设置恢复最近工程或回落为空白编辑器
            command = build_serve_command(None, None, port)
        else:
            json_path = Path(json_text).expanduser()
            if not json_path.exists():
                return _error_result("jsonPath", "json_not_found", str(json_path))
            media_state = self.check_server_media({"jsonPath": str(json_path)})
            media_text = str(payload.get("mediaPath") or "").strip()
            media_path = Path(media_text).expanduser() if media_text else None
            if media_path and not media_path.exists():
                media_path = None
            if (not media_state.get("hasMedia") or not media_state.get("mediaExists")) and media_path is None:
                return _error_result("serverMediaPath", "server_media_missing", str(media_state.get("mediaPath") or ""))
            command = build_serve_command(json_path, media_path, port)
        command.append("--no-open")
        _ = self._stop_owned_server()
        self.server_log_file = tempfile.TemporaryFile(mode="w+b")
        try:
            self.server_process = subprocess.Popen(
                command,
                stdout=self.server_log_file,
                stderr=subprocess.STDOUT,
                text=True,
                env=_child_environment(os.environ, "", provider=""),
                cwd=str(self.paths.root),
                startupinfo=startupinfo(),
                creationflags=creationflags(),
            )
        except OSError as error:
            self._close_server_log()
            return _error_result("port", "server_start_failed", f"{url} | {error}")
        if not _wait_for_server(url, timeout=5.0):
            exit_code = self.server_process.poll() if self.server_process else None
            if exit_code is not None:
                detail = self._read_server_log()
                detail = f"{url} | 进程退出码 {exit_code}" + (f"：{detail}" if detail else "")
                _ = self._stop_owned_server()
                return _error_result("port", "server_start_failed", detail)
            _ = self._stop_owned_server()
            return _error_result("port", "server_no_response", url)
        self._close_server_log()
        return {"ok": True, "url": launch_url}

    def get_server_status(self, payload: Mapping[str, object]) -> dict[str, object]:
        """Report a responding MAW server on the currently selected localhost port."""
        port = _port(payload)
        url = f"http://127.0.0.1:{port}/"
        if not _wait_for_server(url, timeout=0.25):
            return {"ok": True, "running": False, "url": url}
        pid = _maw_server_process_id(port)
        return {"ok": True, "running": pid is not None, "url": url, "pid": pid}

    def check_server_media(self, payload: Mapping[str, object]) -> dict[str, object]:
        json_text = str(payload.get("jsonPath") or "").strip()
        if not json_text:
            return {"ok": False, "hasMedia": False, "mediaPath": "", "mediaExists": False, "error": "Project file is required."}
        json_path = Path(json_text).expanduser()
        try:
            data = json.loads(json_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, OSError, json.JSONDecodeError) as error:
            return {"ok": False, "hasMedia": False, "mediaPath": "", "mediaExists": False, "error": str(error)}
        if not isinstance(data, dict):
            return {"ok": False, "hasMedia": False, "mediaPath": "", "mediaExists": False, "error": "Project file must contain a JSON object."}
        resolution = resolve_project_media(json_path, data)
        resolved = resolution.resolved_path
        requested = resolution.requested_path
        return {
            "ok": resolution.loadable,
            "status": resolution.status.value,
            "hasMedia": bool(requested or resolved or resolution.candidates),
            "mediaPath": str(resolved or requested or ""),
            "mediaExists": resolved is not None,
            "candidates": [str(path) for path in resolution.candidates],
            "detail": resolution.message,
        }

    def _stop_owned_server(self) -> bool:
        process = self.server_process
        self.server_process = None
        stopped = False
        try:
            if process and process.poll() is None:
                process.terminate()
                try:
                    _ = process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    _ = process.wait(timeout=5)
                stopped = True
            return stopped
        finally:
            self._close_server_log()

    def _read_server_log(self) -> str:
        log_file = self.server_log_file
        if log_file is None:
            return ""
        try:
            log_file.flush()
            log_file.seek(0)
            return log_file.read().decode("utf-8", errors="replace").strip()
        except (OSError, ValueError):
            return ""

    def _close_server_log(self) -> None:
        log_file = self.server_log_file
        self.server_log_file = None
        if log_file is not None:
            try:
                log_file.close()
            except OSError:
                pass

    def stop_server(self, payload: Mapping[str, object] | None = None) -> dict[str, object]:
        if self._stop_owned_server():
            return {"ok": True, "stopped": True}
        port = _port(payload or {})
        url = f"http://127.0.0.1:{port}/"
        if not _wait_for_server(url, timeout=0.25):
            return {"ok": True, "stopped": False}
        if _stop_external_maw_server(port):
            return {"ok": True, "stopped": True}
        if _maw_server_process_id(port) is None:
            return _error_result("port", "server_stop_not_maw", url)
        return _error_result("port", "server_stop_failed", url)

    def start_transcription(self, payload: Mapping[str, object]) -> dict[str, object]:
        if self.worker and self.worker.is_alive():
            return {"ok": False, "error": "Transcription is already running."}
        try:
            request = _request_from_payload(payload, self.paths.env_path)
        except PreflightError as error:
            return error.as_result()
        self.result = None
        self.cancel_event = Event()
        self.pump.start()
        self.worker = threading.Thread(target=self._worker_main, args=(request, self.cancel_event), daemon=True)
        self.worker.start()
        return {"ok": True}

    def cancel_transcription(self, _payload: Mapping[str, object] | None = None) -> dict[str, object]:
        if self.cancel_event:
            self.cancel_event.set()
        return {"ok": True}

    def open_output_folder(self, _payload: Mapping[str, object] | None = None) -> dict[str, object]:
        if self.result:
            return _open_existing_path(self.result.srt_path.parent)
        return {"ok": False, "error": "No result yet."}

    def open_html(self, _payload: Mapping[str, object] | None = None) -> dict[str, object]:
        if self.result and self.result.html_path and self.result.html_path.exists():
            return _open_existing_path(self.result.html_path)
        return {"ok": False, "error": "No editor HTML yet."}

    def open_blank_html(self, _payload: Mapping[str, object] | None = None) -> dict[str, object]:
        path = self.paths.root / "blank-editor.html"
        if not path.exists():
            frozen_path = asset_path("blank-editor.html")
            path = frozen_path if frozen_path.exists() else path
        if not path.exists():
            return {"ok": False, "error": f"blank-editor.html not found: {path}"}
        return _open_existing_path(path)

    def check_ffmpeg(self, _payload: Mapping[str, object] | None = None) -> dict[str, object]:
        return _check_ffmpeg(self.paths.env_path)

    def save_ffmpeg_path(self, payload: Mapping[str, object]) -> dict[str, object]:
        value = str(payload.get("path") or "").strip()
        try:
            save_env(self.paths.env_path, {"FFMPEG_PATH": value})
        except (OSError, UnicodeError) as error:
            return _error_result("ffmpegPath", "config_save_failed", f"{self.paths.env_path}: {error}")
        result = _check_ffmpeg(self.paths.env_path, override=value)
        result["ok"] = bool(result["found"])
        return result

    def save_sticker_dir(self, payload: Mapping[str, object]) -> dict[str, object]:
        value = str(payload.get("path") or "").strip()
        path = Path(value).expanduser()
        if not value or not path.is_dir():
            return _error_result("stickerDir", "sticker_dir_invalid", value)
        try:
            save_env(self.paths.env_path, {"STICKER_DIR": str(path)})
        except (OSError, UnicodeError) as error:
            return _error_result("stickerDir", "config_save_failed", f"{self.paths.env_path}: {error}")
        return {"ok": True, "stickerDir": str(path)}

    def shutdown(self) -> None:
        self.cancel_transcription()
        _ = self.stop_server()
        self.pump.shutdown()

    def _worker_main(self, request: TranscriptionRequest, cancel_event: Event) -> None:
        child_output: list[str] = []

        def on_child_event(line: str) -> None:
            child_output.append(line)
            self._emit({"type": "log", "message": line})

        try:
            result = run_transcription(
                request,
                on_event=on_child_event,
                cancel_event=cancel_event,
                on_process_start=lambda pid: self._emit({"type": "log", "message": f"[info] 转写进程已启动 (pid {pid})"}),
            )
        except TranscriptionProcessError as error:
            if _is_ffprobe_start_failure(child_output):
                self._emit({
                    "type": "error",
                    "code": "ffprobe_start_failed",
                    "detail": str(error),
                })
            else:
                self._emit({"type": "error", "message": str(error)})
            self.pump.flush()
            return
        except Exception as error:  # noqa: BROAD_EXCEPT_OK - pywebview worker boundary reports to JS.
            self._emit({"type": "error", "message": str(error)})
            self.pump.flush()
            return
        self.result = result
        self._emit({"type": "done", "result": {"srtPath": str(result.srt_path), "jsonPath": str(result.json_path), "htmlPath": str(result.html_path or "")}})
        self.pump.flush()

    def _emit(self, event: Mapping[str, object]) -> None:
        self.pump.enqueue(event)

    def handle_drop_paths(self, paths: Sequence[str]) -> None:
        for path in paths:
            if path:
                self._emit(_route_dropped_path(path))
                self.pump.flush()
                return


def run_app() -> None:
    import webview

    paths = default_paths()
    api = LauncherApi(paths=paths)
    _register_mosp_association()
    window = webview.create_window(
        WINDOW_TITLE,
        url=paths.launcher_html.resolve().as_uri(),
        js_api=api,
        width=900,
        height=780,
        min_size=(760, 640),
        background_color="#16181d",
        text_select=True,
    )
    if window is not None:
        window.events.closing += lambda: api.shutdown()
        window.events.loaded += lambda: apply_dark_title_bar(WINDOW_TITLE)
    icon = asset_path("assets/maw.ico")
    webview.start(lambda: bind_launcher_drop(window, api), icon=str(icon) if icon.exists() else None)


def bind_launcher_drop(window: object | None, api: LauncherApi) -> None:
    if window is None:
        return
    try:
        from webview.dom import DOMEventHandler
    except ImportError:
        return

    def on_drop(event: Mapping[str, object]) -> None:
        api.handle_drop_paths(_drop_paths_from_event(event))

    window.dom.document.events.drop += DOMEventHandler(on_drop, True, True)


@dataclass(frozen=True, slots=True)
class PreflightError(Exception):
    field: str
    code: str
    message: str

    def as_result(self) -> dict[str, object]:
        return _error_result(self.field, self.code, self.message)


def _request_from_payload(payload: Mapping[str, object], env_path: Path) -> TranscriptionRequest:
    media_text = str(payload.get("mediaPath") or "").strip()
    srt_text = str(payload.get("srtPath") or "").strip()
    media = Path(media_text).expanduser()
    srt = Path(srt_text).expanduser()
    test_run = bool(payload.get("testRun"))
    if test_run:
        srt = with_test_suffix(srt)
    provider = provider_by_id(str(payload.get("providerId") or "qwen"))
    requested_model = str(payload.get("modelId") or "")
    model = next(
        (item for item in provider.models if requested_model in (item.id, item.label)),
        provider.models[0],
    )
    api_key = str(payload.get("apiKey") or "").strip() or api_key_for_provider(provider.id, env_path)
    region = str(payload.get("region") or "beijing") if provider.id == "qwen" else ""
    workspace_id = str(payload.get("workspaceId") or "").strip()
    if not media_text or not media.exists():
        raise PreflightError("mediaPath", "media_not_found", "Media file does not exist.")
    if not srt_text or not srt.name:
        raise PreflightError("srtPath", "output_missing", "SRT output path is required.")
    if not api_key:
        raise PreflightError("apiKey", "api_key_missing", "API key is required.")
    if provider.id == "qwen" and region == "singapore" and not workspace_id:
        raise PreflightError("workspaceId", "workspace_missing", "Workspace ID is required for Singapore region.")
    qwen_audio_context = str(payload.get("qwenAudioContext") or "").strip() if model.supports_context else ""
    if len(qwen_audio_context) > 400:
        raise PreflightError(
            "qwenAudioContext",
            "context_too_long",
            "Qwen-Audio context is limited to 400 characters.",
        )
    qwen_audio_hotwords_mode = str(payload.get("qwenAudioHotwordsMode") or "text").strip().lower()
    qwen_audio_hotwords_file = ""
    qwen_audio_hotwords = ""
    if model.supports_hotwords and qwen_audio_hotwords_mode == "file":
        hotwords_file_text = str(payload.get("qwenAudioHotwordsFile") or "").strip()
        hotwords_file = Path(hotwords_file_text).expanduser()
        if not hotwords_file.is_file() or hotwords_file.suffix.lower() != ".txt":
            raise PreflightError(
                "qwenAudioHotwordsFile",
                "hotwords_file_missing",
                "Qwen-Audio hotword source must be an existing .txt file.",
            )
        qwen_audio_hotwords_file = str(hotwords_file)
    elif model.supports_hotwords:
        qwen_audio_hotwords = str(payload.get("qwenAudioHotwords") or "").strip()
    return TranscriptionRequest(
        media_path=media,
        srt_path=srt,
        model=model.id,
        language=str(payload.get("language") or ""),
        api_key=api_key,
        length_limit="2m" if test_run else str(payload.get("lengthLimit") or "").strip(),
        qwen_audio_context=qwen_audio_context,
        qwen_audio_hotwords=qwen_audio_hotwords,
        qwen_audio_hotwords_file=qwen_audio_hotwords_file,
        qwen_audio_vocabulary_id=(
            str(payload.get("qwenAudioVocabularyId") or "").strip()
            if model.supports_vocabulary else ""
        ),
        qwen_audio_hotword_weight=(
            str(payload.get("qwenAudioHotwordWeight") or "").strip()
            if model.supports_hotwords else ""
        ),
        region=region,
        workspace_id=workspace_id,
        provider=provider.id,
        speaker_colors=bool(payload.get("speakerColors")) and model.supports_speaker,
        ui_language=_gui_lang(payload),
        generate_html=bool(payload.get("generateHtml")),
    )


def _file_dialog(*, open_dialog: bool, file_types: tuple[str, ...], save_filename: str = "") -> tuple[str, ...] | None:
    import webview

    if not webview.windows:
        return None
    dialog_type = OPEN_DIALOG if open_dialog else SAVE_DIALOG
    selected = webview.windows[0].create_file_dialog(dialog_type, save_filename=save_filename, file_types=file_types)
    return tuple(selected) if selected else None


def _folder_dialog() -> tuple[str, ...] | None:
    import webview

    if not webview.windows:
        return None
    selected = webview.windows[0].create_file_dialog(FOLDER_DIALOG)
    return tuple(selected) if selected else None


def _dialog_result(selected: tuple[str, ...] | None) -> dict[str, object]:
    if not selected:
        return {"ok": False, "path": ""}
    return {"ok": True, "path": selected[0]}


def _active_window() -> object | None:
    import webview

    return webview.windows[0] if webview.windows else None


def _gui_lang(payload: Mapping[str, object]) -> str:
    return "en" if str(payload.get("guiLang") or "zh").lower() == "en" else "zh"


def _port(payload: Mapping[str, object]) -> int:
    try:
        value = int(str(payload.get("port") or "8250"))
    except ValueError:
        return 8250
    return min(65535, max(1, value))


def _error_result(field: str, code: str, detail: str = "") -> dict[str, object]:
    return {"ok": False, "field": field, "code": code, "detail": detail, "error": ERROR_MESSAGES.get(code, detail or code)}


def _route_dropped_path(path: str) -> dict[str, object]:
    suffix = Path(path).suffix.lower()
    if suffix in {".json", ".mosp"}:
        return {"type": "dropJson", "path": path}
    if suffix == ".txt":
        return {"type": "dropHotwordFile", "path": path}
    if suffix in MEDIA_EXTS:
        return {"type": "dropMedia", "path": path}
    return {"type": "dropReject", "path": path}


def _drop_paths_from_event(event: Mapping[str, object]) -> list[str]:
    data_transfer = event.get("dataTransfer")
    if not isinstance(data_transfer, Mapping):
        return []
    files = data_transfer.get("files")
    if not isinstance(files, Sequence) or isinstance(files, (str, bytes)):
        return []
    paths: list[str] = []
    for file_item in files:
        if not isinstance(file_item, Mapping):
            continue
        value = file_item.get("pywebviewFullPath")
        if isinstance(value, str) and value:
            paths.append(value)
    return paths


def _wait_for_server(url: str, *, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urlopen(url, timeout=0.25) as response:
                if 200 <= response.status < 500:
                    return True
        except (OSError, URLError):
            time.sleep(0.1)
    return False


def _listening_process_id(port: int) -> int | None:
    """Return the PID listening on one IPv4 loopback port on Windows."""
    if os.name != "nt":
        return None
    try:
        result = subprocess.run(
            ["netstat", "-ano", "-p", "TCP"], capture_output=True, text=True, check=False,
            startupinfo=startupinfo(), creationflags=creationflags(),
        )
    except OSError:
        return None
    pattern = re.compile(rf"^\s*TCP\s+127\.0\.0\.1:{port}\s+\S+\s+LISTENING\s+(\d+)\s*$", re.IGNORECASE)
    for line in result.stdout.splitlines():
        match = pattern.match(line)
        if match:
            return int(match.group(1))
    return None


def _process_command_line(pid: int) -> str:
    """Read one Windows process command line. The PID is parsed internally, never user input."""
    if os.name != "nt":
        return ""
    command = f"(Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = {pid}').CommandLine"
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", command],
            capture_output=True, text=True, check=False, startupinfo=startupinfo(), creationflags=creationflags(),
        )
    except OSError:
        return ""
    return result.stdout.strip()


def _maw_server_process_id(port: int) -> int | None:
    """Recognise only MAW's frozen --serve process or its checked-out serve.py command."""
    pid = _listening_process_id(port)
    if pid is None:
        return None
    command = _process_command_line(pid).lower().replace("/", "\\")
    is_frozen_maw = "--serve" in command and bool(re.search(r"(?:^|[\\\"\s])maw\.exe(?:[\\\"\s]|$)", command))
    is_source_maw = "server-editor\\serve.py" in command
    return pid if is_frozen_maw or is_source_maw else None


def _stop_external_maw_server(port: int) -> bool:
    """Stop a verified MAW editor process without touching another local service."""
    pid = _maw_server_process_id(port)
    if pid is None:
        return False
    try:
        result = subprocess.run(
            ["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, text=True, check=False,
            startupinfo=startupinfo(), creationflags=creationflags(),
        )
    except OSError:
        return False
    return result.returncode == 0


def _open_existing_path(path: Path) -> dict[str, object]:
    target = Path(path).expanduser()
    if not target.exists():
        return {"ok": False, "error": f"Path does not exist: {target}"}
    if os.name == "nt":
        os.startfile(str(target))
    else:
        webbrowser.open(target.resolve().as_uri())
    return {"ok": True}


def _check_ffmpeg(env_path: Path, override: str = "") -> dict[str, object]:
    ffmpeg_path = shutil.which("ffmpeg")
    ffprobe_path = shutil.which("ffprobe")
    configured_value = override or os.environ.get("FFMPEG_PATH", "") or effective_config_value(env_path, "FFMPEG_PATH")
    configured_dir = _ffmpeg_directory(configured_value)
    if override and configured_dir is None:
        return {"ok": True, "found": False, "ffmpeg": "", "ffprobe": "", "directory": ""}
    if configured_dir:
        ffmpeg_candidate = configured_dir / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
        ffprobe_candidate = configured_dir / ("ffprobe.exe" if os.name == "nt" else "ffprobe")
        if ffmpeg_candidate.exists() and ffprobe_candidate.exists():
            ffmpeg_path = str(ffmpeg_candidate)
            ffprobe_path = str(ffprobe_candidate)
    if not (ffmpeg_path and ffprobe_path):
        bundled_dir = _bundled_ffmpeg_directory()
        if bundled_dir:
            ffmpeg_path = str(bundled_dir / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg"))
            ffprobe_path = str(bundled_dir / ("ffprobe.exe" if os.name == "nt" else "ffprobe"))
    found = bool(ffmpeg_path and ffprobe_path)
    directory = str(Path(ffmpeg_path).parent) if ffmpeg_path else ""
    return {"ok": True, "found": found, "ffmpeg": ffmpeg_path or "", "ffprobe": ffprobe_path or "", "directory": directory}


def effective_config_value(env_path: Path, key: str) -> str:
    from maw.gui_config import load_env

    return os.environ.get(key) or load_env(env_path).get(key, "")


def _ffmpeg_directory(value: str) -> Path | None:
    if not value.strip():
        return None
    candidate = Path(value.strip()).expanduser()
    if candidate.is_dir():
        return candidate
    if candidate.exists():
        return candidate.parent
    return None


def _provider_payload(provider: ProviderConfig, env_path: Path) -> dict[str, object]:
    api_key = api_key_for_provider(provider.id, env_path)
    return {
        "id": provider.id,
        "label": provider.label,
        "keyUrl": provider.key_url,
        "apiKey": api_key,
        "maskedApiKey": masked_secret(api_key),
        "supportsSpeaker": provider.supports_speaker,
        "multiLanguage": provider.multi_language,
        "commonLanguages": list(provider.common_languages),
        "models": [_model_payload(item) for item in provider.models],
        "regions": [{"id": value, "label": label} for value, label in provider.regions],
        "languages": [{"id": value, "label": label} for value, label in provider.languages],
    }


def _model_payload(model: ModelConfig) -> dict[str, object]:
    return {
        "id": model.id,
        "label": model.label,
        "envKey": model.env_key,
        "note": model.note,
        "supportsSpeaker": model.supports_speaker,
        "supportsContext": model.supports_context,
        "supportsHotwords": model.supports_hotwords,
        "supportsVocabulary": model.supports_vocabulary,
        "languages": [
            {"id": value, "label": label}
            for value, label in model.languages
        ],
    }
