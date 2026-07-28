# pyright: reportAny=false, reportAttributeAccessIssue=false, reportMissingImports=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnusedCallResult=false

from __future__ import annotations

import json
import os
import queue
import re
import shutil
import subprocess
import threading
import time
import webbrowser
from urllib.error import URLError
from urllib.request import urlopen
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from threading import Event
from typing import Final, final

from maw.gui_config import DEFAULT_ENV_PATH, LANGUAGES, MODELS, PROVIDERS, REGIONS, ProviderConfig, api_key_for_provider, effective_config, masked_secret, model_by_label, provider_by_id, provider_for_model, save_env
from maw.gui_platform import apply_dark_title_bar, asset_path, creationflags, startupinfo
from maw.gui_workflow import TranscriptionRequest, TranscriptionResult, build_serve_command, default_srt_path, run_transcription


OPEN_DIALOG = 10
SAVE_DIALOG = 30
FOLDER_DIALOG = 20
WINDOW_TITLE = "MAW Launcher"
MEDIA_EXTS: Final = frozenset({".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".ts", ".m4v", ".mp3", ".wav", ".m4a", ".flac", ".aac", ".ogg"})


ERROR_MESSAGES: Final[dict[str, str]] = {
    "json_not_found": "Project JSON does not exist.",
    "media_not_found": "Media file does not exist.",
    "server_media_missing": "Project media is missing. Choose media manually.",
    "api_key_missing": "API key is required.",
    "workspace_missing": "Workspace ID is required for Singapore region.",
    "output_missing": "SRT output path is required.",
    "server_no_response": "Editor server did not respond.",
    "sticker_dir_invalid": "Sticker directory does not exist.",
}


def _app_version(paths: object) -> str:
    """Read project.version from pyproject.toml for the hero wordmark; fall back to the bundled release."""
    root = getattr(paths, "root", None)
    pyproject = (root / "pyproject.toml") if root else Path("pyproject.toml")
    try:
        text = Path(pyproject).read_text(encoding="utf-8")
    except OSError:
        return "1.1.0"
    match = re.search(r'(?m)^version = "([^"]+)"\r?$', text)
    return match.group(1) if match else "1.1.0"


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
            "models": [{"id": item.id, "label": item.label, "envKey": item.env_key, "note": item.note} for item in MODELS],
            "regions": [{"id": value, "label": label} for value, label in REGIONS],
            "languages": [{"id": value, "label": label} for value, label in LANGUAGES],
            "providers": [_provider_payload(item, self.paths.env_path) for item in PROVIDERS],
        }

    def default_output(self, payload: Mapping[str, object]) -> dict[str, object]:
        media_text = str(payload.get("mediaPath") or "").strip()
        provider_id = str(payload.get("providerId") or "qwen")
        return {"ok": bool(media_text), "path": str(default_srt_path(Path(media_text), provider=provider_id)) if media_text else ""}

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
        save_env(self.paths.env_path, updates)
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
            save_env(self.paths.env_path, updates)
        return {"ok": True}

    def choose_file(self, payload: Mapping[str, object]) -> dict[str, object]:
        kind = str(payload.get("kind") or "media")
        file_types = ("JSON (*.json)",) if kind == "json" else ("Media files (*.mp4;*.mkv;*.avi;*.mov;*.wmv;*.flv;*.webm;*.ts;*.m4v;*.mp3;*.wav;*.m4a;*.flac;*.aac;*.ogg)", "All files (*.*)")
        chosen = _file_dialog(open_dialog=True, file_types=file_types)
        return _dialog_result(chosen)

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

    def start_server(self, payload: Mapping[str, object]) -> dict[str, object]:
        json_text = str(payload.get("jsonPath") or "").strip()
        port = _port(payload)
        if not json_text:
            # 无工程：启动空白编辑器，用户可在页面内自行选择 JSON 与媒体
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
        self.stop_server()
        self.server_process = subprocess.Popen(
            command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=True,
            cwd=str(self.paths.root),
            startupinfo=startupinfo(),
            creationflags=creationflags(),
        )
        url = f"http://127.0.0.1:{port}/"
        if not _wait_for_server(url, timeout=5.0):
            _ = self.stop_server()
            return _error_result("port", "server_no_response", url)
        webbrowser.open(url)
        return {"ok": True, "url": url}

    def check_server_media(self, payload: Mapping[str, object]) -> dict[str, object]:
        json_text = str(payload.get("jsonPath") or "").strip()
        if not json_text:
            return {"ok": False, "hasMedia": False, "mediaPath": "", "mediaExists": False, "error": "Project JSON is required."}
        json_path = Path(json_text).expanduser()
        try:
            data = json.loads(json_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, OSError, json.JSONDecodeError) as error:
            return {"ok": False, "hasMedia": False, "mediaPath": "", "mediaExists": False, "error": str(error)}
        media_value = data.get("media") if isinstance(data, dict) else ""
        media_text = media_value.strip() if isinstance(media_value, str) else ""
        if not media_text:
            return {"ok": True, "hasMedia": False, "mediaPath": "", "mediaExists": False}
        media_path = Path(media_text).expanduser()
        if not media_path.is_absolute():
            media_path = json_path.parent / media_path
        return {"ok": True, "hasMedia": True, "mediaPath": media_text, "mediaExists": media_path.exists()}

    def stop_server(self, _payload: Mapping[str, object] | None = None) -> dict[str, object]:
        process = self.server_process
        self.server_process = None
        if process and process.poll() is None:
            process.terminate()
            try:
                _ = process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                _ = process.wait(timeout=5)
        return {"ok": True, "stopped": True}

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
        save_env(self.paths.env_path, {"FFMPEG_PATH": value})
        result = _check_ffmpeg(self.paths.env_path, override=value)
        result["ok"] = bool(result["found"])
        return result

    def save_sticker_dir(self, payload: Mapping[str, object]) -> dict[str, object]:
        value = str(payload.get("path") or "").strip()
        path = Path(value).expanduser()
        if not value or not path.is_dir():
            return _error_result("stickerDir", "sticker_dir_invalid", value)
        save_env(self.paths.env_path, {"STICKER_DIR": str(path)})
        return {"ok": True, "stickerDir": str(path)}

    def shutdown(self) -> None:
        self.cancel_transcription()
        _ = self.stop_server()
        self.pump.shutdown()

    def _worker_main(self, request: TranscriptionRequest, cancel_event: Event) -> None:
        try:
            result = run_transcription(
                request,
                on_event=lambda line: self._emit({"type": "log", "message": line}),
                cancel_event=cancel_event,
                on_process_start=lambda pid: self._emit({"type": "log", "message": f"[info] 转写进程已启动 (pid {pid})"}),
            )
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
    provider = provider_by_id(str(payload.get("providerId") or "qwen"))
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
    return TranscriptionRequest(
        media_path=media,
        srt_path=srt,
        model=str(payload.get("modelId") or MODELS[0].id),
        language=str(payload.get("language") or ""),
        api_key=api_key,
        length_limit="2m" if bool(payload.get("testRun")) else str(payload.get("lengthLimit") or "").strip(),
        region=region,
        workspace_id=workspace_id,
        provider=provider.id,
        speaker_colors=bool(payload.get("speakerColors")) and provider.supports_speaker,
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
        value = int(str(payload.get("port") or "8765"))
    except ValueError:
        return 8765
    return min(65535, max(1, value))


def _error_result(field: str, code: str, detail: str = "") -> dict[str, object]:
    return {"ok": False, "field": field, "code": code, "detail": detail, "error": ERROR_MESSAGES.get(code, detail or code)}


def _route_dropped_path(path: str) -> dict[str, object]:
    suffix = Path(path).suffix.lower()
    if suffix == ".json":
        return {"type": "dropJson", "path": path}
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
    if configured_value and configured_dir is None:
        return {"ok": True, "found": False, "ffmpeg": "", "ffprobe": "", "directory": ""}
    if configured_dir:
        ffmpeg_candidate = configured_dir / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
        ffprobe_candidate = configured_dir / ("ffprobe.exe" if os.name == "nt" else "ffprobe")
        if ffmpeg_candidate.exists() and ffprobe_candidate.exists():
            ffmpeg_path = str(ffmpeg_candidate)
            ffprobe_path = str(ffprobe_candidate)
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
        "models": [{"id": item.id, "label": item.label, "envKey": item.env_key, "note": item.note} for item in provider.models],
        "regions": [{"id": value, "label": label} for value, label in provider.regions],
        "languages": [{"id": value, "label": label} for value, label in provider.languages],
    }
