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
from dataclasses import dataclass, replace
from pathlib import Path
from threading import Event
from typing import BinaryIO, Final, final

from media_cache import embed_media_caches
from waveform import is_waveform_payload
from maw.gui_config import DEFAULT_ENV_PATH, DEFAULT_MODEL_ID, MODELS, PROVIDERS, ModelConfig, ProviderConfig, api_key_for_provider, effective_config, masked_secret, model_by_label, provider_by_id, provider_for_model, save_env
from maw.gui_platform import apply_dark_title_bar, asset_path, creationflags, popen_process_tree, process_group_kwargs, release_process_tree, startupinfo, terminate_process_tree
from maw.gui_workflow import TranscriptionCancelledError, TranscriptionProcessError, TranscriptionRequest, TranscriptionResult, _bundled_ffmpeg_directory, _child_environment, _ffmpeg_search_path, build_serve_command, default_srt_path, raw_response_path, run_transcription, unique_output_path, with_test_suffix
from maw.launcher_batch import BatchItem, run_batch
from maw.local_runtime import LocalRuntimeCancelled, LocalRuntimeError, install_local_runtime, managed_runtime_status
from maw.local_models import inspect_local_model, local_model_payload, prepare_local_model as prepare_model
from maw.media import find_ffmpeg, resolve_project_media
from maw.postprocess import FixedProcessRequest, LlmPostprocessRequest, OutputMode, Replacement, run_fixed_process as process_fixed_process, run_llm_postprocess as process_llm_postprocess
from maw.project import normalize_project
from maw.postprocess_ffmpeg import FfconcatRequest, run_ffconcat_rebuild as process_ffconcat_rebuild
from maw.postprocess_match import ScriptMatchRequest, run_script_match as process_script_match
from maw.postprocess_ocr import OcrDedupRequest, OcrRegion
from maw.postprocess_llm import DEFAULT_REASONING_MODE, LlmClientError, LlmSettings, PRESETS as POSTPROCESS_PRESETS, complete_subtitle_groups, list_llm_models, normalize_reasoning_mode, preset_by_id, test_llm_connection
from maw.postprocess_pipeline import (
    PostprocessCancelled,
    default_postprocess_plan,
    enabled_steps,
    invalidate_llm_verification_if_changed,
    is_llm_verified,
    load_postprocess_plan,
    run_postprocess_pipeline,
    save_postprocess_plan,
    snapshot_postprocess_llm_settings,
    validate_plan,
)
from maw.postprocess_pipeline import PostprocessPipelineError
from maw.text_conversion import TextConversionUnavailable, normalize_text_conversion_mode
from maw.ocr_runtime import OCR_MODEL_ID, OcrRuntimeCancelled, OcrRuntimeError, install_ocr_runtime, managed_ocr_runtime_status, ocr_model_type, ocr_models_payload, run_ocr_in_runtime
from maw.project_preview import JsonValue
from maw.soniox import SonioxContextError, build_soniox_context


OPEN_DIALOG = 10
SAVE_DIALOG = 30
FOLDER_DIALOG = 20
WINDOW_TITLE = "MAW Launcher"
MEDIA_EXTS: Final = frozenset({".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".ts", ".m4v", ".mp3", ".wav", ".m4a", ".flac", ".aac", ".ogg"})
MOSE_REGISTRY_KEY = r"Software\Moy\MOSE"
MOSE_FILE_TYPE = "Moy.MOSE.Project"
# 工程恢复会同步准备自研波形；大型工程可能需要超过默认的网络探测窗口。
SERVER_START_TIMEOUT: Final = 30.0
# Keep this aligned with pyproject.toml; release workflows synchronize and verify it.
BUNDLED_APP_VERSION = "1.4.0"
MOSE_VERSION = "0.1.0"


ERROR_MESSAGES: Final[dict[str, str]] = {
    "json_not_found": "Project file does not exist.",
    "media_not_found": "Media file does not exist.",
    "server_media_missing": "Project media is missing, unsupported, or ambiguous. Choose media manually.",
    "api_key_missing": "API key is required.",
    "local_runtime_missing": "本地模型运行时未安装。",
    "local_runtime_install_failed": "本地模型运行环境安装失败。",
    "local_runtime_cancelled": "本地模型运行环境安装已取消。",
    "local_model_missing": "尚未检测到本地模型，请先下载或选择模型目录。",
    "local_model_incomplete": "本地模型不完整，请先准备所需模型组件。",
    "local_model_path_invalid": "本地模型目录不存在，或所选路径不是文件夹。",
    "local_model_path_mismatch": "当前模型目录看起来属于另一种本地模型。",
    "model_cache_path_invalid": "模型缓存目录不能是一个文件。",
    "local_prepare_running": "本地模型正在准备中。",
    "local_prepare_failed": "本地模型准备失败。",
    "ocr_runtime_missing": "OCR 支持尚未安装，请打开设置下载安装。",
    "ocr_runtime_install_failed": "OCR 运行环境安装失败。",
    "ocr_runtime_cancelled": "OCR 运行环境安装已取消。",
    "ocr_model_missing": "OCR 模型尚未安装，请打开设置下载安装。",
    "ocr_runtime_path_invalid": "OCR 运行环境路径不能是一个文件。",
    "workspace_missing": "Workspace ID is required for Singapore region.",
    "output_missing": "SRT output path is required.",
    "segmentation_invalid": "Subtitle segmentation settings are invalid.",
    "ffmpeg_start_failed": "FFmpeg failed to start.",
    "transcription_failed": "Transcription failed.",
    "transcription_cancelled": "转写已取消。",
    "context_too_long": "Qwen-Audio context is limited to 400 characters.",
    "soniox_context_too_long": "Soniox context is limited to approximately 10,000 characters.",
    "soniox_context_invalid": "Soniox context format is invalid.",
    "hotwords_file_missing": "Choose an existing UTF-8 .txt hotword file.",
    "server_no_response": "Editor server did not respond.",
    "server_start_failed": "Editor server failed to start.",
    "mose_not_found": "MOSE desktop editor was not found in this MAW package.",
    "mose_start_failed": "MOSE desktop editor failed to start.",
    "server_stop_not_maw": "The process using this port is not a MAW editor server.",
    "server_stop_failed": "Unable to stop the MAW editor server.",
    "sticker_dir_invalid": "Sticker directory does not exist.",
    "config_save_failed": "Local configuration could not be saved.",
    "custom_prompt_required": "A custom prompt is required.",
    "postprocess_config_invalid": "自动后处理配置不完整。",
    "postprocess_failed": "转写已完成，但自动后处理失败。",
    "postprocess_cancelled": "自动后处理已取消，原始转写产物仍然保留。",
    "waveform_unavailable": "Waveform data could not be embedded.",
    "waveform_generation_failed": "Waveform project generation failed.",
}


def _app_version(paths: object) -> str:
    """Read project.version from pyproject.toml for the hero wordmark; fall back to the bundled release."""
    root = getattr(paths, "root", None)
    pyproject = (root / "pyproject.toml") if root else Path("pyproject.toml")
    try:
        text = Path(pyproject).read_text(encoding="utf-8")
    except OSError:
        return BUNDLED_APP_VERSION
    match = re.search(r'(?m)^version = "([^"]+)"\r?$', text)
    return match.group(1) if match else BUNDLED_APP_VERSION


def _is_ffprobe_start_failure(lines: Sequence[str]) -> bool:
    """Recognise the Windows loader failure emitted by a nested ffprobe process."""
    detail = "\n".join(lines).lower()
    return "ffprobe" in detail and any(
        marker in detail for marker in ("3221225794", "0xc0000142", "c0000142")
    )


def _is_ffmpeg_start_failure(lines: Sequence[str]) -> bool:
    """Recognise the same Windows loader failure when FFmpeg is the child tool."""
    detail = "\n".join(lines).lower()
    return "ffmpeg" in detail and any(
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
    # 冻结（PyInstaller / AppImage）时资源在 sys._MEIPASS（如 dist/MAW/_internal），
    # 源码运行时在仓库根；与 maw.gui_platform.asset_path 的取法保持一致。
    root = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[1]))
    return LauncherPaths(root=root, env_path=DEFAULT_ENV_PATH, launcher_html=root / "web" / "launcher" / "index.html")


# ---- Linux keycap 表情字体（Noto Color Emoji）----
# 段落标题的 keycap 表情（1️⃣ 等）由「数字 + U+FE0F + U+20E3」组成，需要彩色 emoji 字体
# 完整覆盖才可正常成型；部分 Linux 发行版（如 SteamOS 的 Twemoji）缺少 U+FE0F，会渲染成
# 「3x」。Windows / macOS 系统 emoji 字体已覆盖 keycap，无需额外处理。
# Linux 下首次启动时按顺序尝试以下地址下载到用户缓存目录，成功即缓存，之后离线可用；
# 可通过 MAW_EMOJI_FONT_URL 环境变量整体覆盖（例如指向其它可用镜像）。
_EMOJI_FONT_FILE_NAME = "NotoColorEmoji.ttf"
_EMOJI_FONT_MIN_BYTES = 1_000_000
_EMOJI_FONT_REMOTE_URLS: Final[Sequence[str]] = (
    "https://cdn.jsdelivr.net/gh/googlefonts/noto-emoji@main/fonts/NotoColorEmoji.ttf",
    "https://fastly.jsdelivr.net/gh/googlefonts/noto-emoji@main/fonts/NotoColorEmoji.ttf",
    "https://gcore.jsdelivr.net/gh/googlefonts/noto-emoji@main/fonts/NotoColorEmoji.ttf",
)


def _emoji_font_cache_path() -> Path:
    """返回平台对应的用户级缓存路径（与 macOS 的 .env 目录命名空间一致）。"""
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support" / "Moy" / "MAW"
    elif sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local"))) / "Moy" / "MAW"
    else:
        base = Path(os.environ.get("XDG_CACHE_HOME", str(Path.home() / ".cache"))) / "Moy" / "MAW"
    return base / _EMOJI_FONT_FILE_NAME


def _emoji_font_urls() -> list[str]:
    override = os.environ.get("MAW_EMOJI_FONT_URL", "").strip()
    return ([override] if override else []) + list(_EMOJI_FONT_REMOTE_URLS)


def _valid_emoji_font(path: Path) -> bool:
    """轻量校验：足够大且带 TrueType 魔数，避免把 HTML 错误页等垃圾当成字体缓存。"""
    try:
        if path.stat().st_size < _EMOJI_FONT_MIN_BYTES:
            return False
        with path.open("rb") as handle:
            return handle.read(4) == b"\x00\x01\x00\x00"
    except OSError:
        return False


def download_emoji_font(urls: Sequence[str], dest: Path, timeout: float = 20.0) -> Path | None:
    """按顺序尝试下载 Noto Color Emoji 到 dest；全部失败时清理临时文件并返回 None。"""
    dest.parent.mkdir(parents=True, exist_ok=True)
    partial = dest.with_name(dest.name + ".part")
    for url in urls:
        if not url:
            continue
        try:
            # URLs are restricted to the HTTPS-only CDN allowlist by the caller.
            with urlopen(url, timeout=timeout) as response:  # noqa: S310
                if getattr(response, "status", None) != 200:
                    continue
                size = 0
                with partial.open("wb") as handle:
                    while True:
                        chunk = response.read(1 << 16)
                        if not chunk:
                            break
                        handle.write(chunk)
                        size += len(chunk)
                if size < _EMOJI_FONT_MIN_BYTES:
                    continue
            partial.replace(dest)
            return dest
        except (OSError, URLError, ValueError):
            continue
    try:
        partial.unlink(missing_ok=True)
    except OSError:
        pass
    return None


@final
class LauncherApi:
    def __init__(self, *, paths: LauncherPaths | None = None, window_getter: Callable[[], object | None] | None = None) -> None:
        self.paths = paths or default_paths()
        self.window_getter = window_getter or _active_window
        self.cancel_event: Event | None = None
        self.worker: threading.Thread | None = None
        self.batch_worker: threading.Thread | None = None
        self.batch_cancel_event: Event | None = None
        self.local_prepare_cancel_event: Event | None = None
        self.local_prepare_worker: threading.Thread | None = None
        self.local_runtime_cancel_event: Event | None = None
        self.local_runtime_worker: threading.Thread | None = None
        self._emoji_font_worker: threading.Thread | None = None
        self.ocr_runtime_cancel_event: Event | None = None
        self.ocr_runtime_worker: threading.Thread | None = None
        self.server_process: subprocess.Popen[str] | None = None
        self.server_log_file: BinaryIO | None = None
        self.result: TranscriptionResult | None = None
        self.postprocess_retry_context: dict[str, object] | None = None
        self.postprocess_workspace_directory: Path | None = None
        self.postprocess_translation_srt_path: Path | None = None
        self._last_postprocess_progress_at = 0.0
        self.pump = EventPump(window_getter=self.window_getter)

    def get_emoji_font_path(self, _payload: Mapping[str, object] | None = None) -> dict[str, object]:
        """返回本地可用的 Noto Color Emoji 路径（file:// URI；未就绪或非 Linux 为空字符串）。

        仅 Linux 需要：缓存已存在时直接返回；否则启动后台下载，完成后通过
        emojiFontReady 事件通知页面注入 @font-face（期间回退系统字体）。
        """
        if sys.platform != "linux":
            return {"ok": True, "path": ""}
        dest = _emoji_font_cache_path()
        if _valid_emoji_font(dest):
            return {"ok": True, "path": dest.as_uri()}
        self._start_emoji_font_download(dest)
        return {"ok": True, "path": ""}

    def _start_emoji_font_download(self, dest: Path) -> None:
        worker = self._emoji_font_worker
        if worker is not None and worker.is_alive():
            return
        worker = threading.Thread(
            target=self._download_emoji_font_worker,
            args=(dest,),
            daemon=True,
            name="emoji-font-download",
        )
        self._emoji_font_worker = worker
        worker.start()

    def _download_emoji_font_worker(self, dest: Path) -> None:
        path = download_emoji_font(_emoji_font_urls(), dest)
        if path is not None:
            self.pump.enqueue({"type": "emojiFontReady", "path": path.as_uri()})

    def _ocr_runtime_status(self):
        return managed_ocr_runtime_status(effective_config_value(self.paths.env_path, "MAW_OCR_RUNTIME_ROOT"))

    def get_config(self, _payload: Mapping[str, object] | None = None) -> dict[str, object]:
        config = effective_config(self.paths.env_path)
        ocr_runtime = self._ocr_runtime_status()
        remembered_model = config.last_model or MODELS[0].id
        provider = provider_for_model(remembered_model)
        selected_model = next(
            (item for item in provider.models if item.id == remembered_model),
            MODELS[0],
        )
        if selected_model.id != remembered_model:
            provider = provider_for_model(selected_model.id)
        selected_api_key = api_key_for_provider(provider.id, self.paths.env_path)
        return {
            "providerId": provider.id,
            "modelId": selected_model.id,
            "apiKey": selected_api_key,
            "maskedApiKey": masked_secret(selected_api_key),
            "region": config.region,
            "workspaceId": config.workspace_id,
            "language": config.language,
            "guiLang": config.gui_lang,
            "appVersion": _app_version(self.paths),
            "stickerDir": config.sticker_dir,
            "showRareLangs": config.show_rare_langs,
            "lastModel": config.last_model,
            "lastLanguage": config.last_language,
            "localRuntime": managed_runtime_status(config.model_cache_root).to_payload(),
            "ocrRuntime": ocr_runtime.to_payload(),
            "ocrModels": ocr_models_payload(ocr_runtime),
            "ocrModelId": OCR_MODEL_ID,
            "modelCacheRoot": config.model_cache_root,
            "models": [_model_payload(item, model_cache_root=config.model_cache_root) for item in provider.models],
            "regions": [{"id": value, "label": label} for value, label in provider.regions],
            "languages": [{"id": value, "label": label} for value, label in provider.languages],
            "providers": [_provider_payload(item, self.paths.env_path, config.model_cache_root) for item in PROVIDERS],
            "postprocessProviders": _postprocess_provider_payloads(self.paths.env_path),
            "postprocessAutoPlan": load_postprocess_plan(self.paths.env_path),
            "zoomPercent": config.zoom_percent,
        }

    def default_output(self, payload: Mapping[str, object]) -> dict[str, object]:
        media_text = str(payload.get("mediaPath") or "").strip()
        provider_id = str(payload.get("providerId") or "qwen")
        model_id = str(payload.get("modelId") or DEFAULT_MODEL_ID)
        test_run = bool(payload.get("testRun"))
        requested = (
            default_srt_path(Path(media_text), provider=provider_id, model=model_id, test_run=test_run)
            if media_text else Path()
        )
        selected = unique_output_path(requested) if media_text else requested
        return {
            "ok": bool(media_text),
            "path": str(selected) if media_text else "",
            "renamed": bool(media_text and selected != requested),
        }

    def save_settings(self, payload: Mapping[str, object]) -> dict[str, object]:
        api_key = str(payload.get("apiKey") or "").strip()
        provider = provider_by_id(str(payload.get("providerId") or "qwen"))
        model_id = str(payload.get("modelId") or "")
        model = next((item for item in provider.models if model_id in (item.id, item.label)), provider.models[0] if provider.models else model_by_label(model_id))
        updates = {"MAW_GUI_LANG": _gui_lang(payload)}
        if "modelCacheRoot" in payload:
            model_cache_root = str(payload.get("modelCacheRoot") or "").strip()
            if model_cache_root:
                candidate = Path(model_cache_root).expanduser().resolve(strict=False)
                if candidate.exists() and not candidate.is_dir():
                    return _error_result("localModelCachePath", "model_cache_path_invalid", str(candidate))
                updates["MAW_MODEL_CACHE_ROOT"] = str(candidate)
            else:
                updates["MAW_MODEL_CACHE_ROOT"] = ""
        if provider.requires_api_key and model.env_key:
            updates[model.env_key] = api_key
        if provider.id == "qwen":
            updates["DASHSCOPE_REGION"] = str(payload.get("region") or "beijing")
            updates["DASHSCOPE_DEFAULT_LANGUAGE"] = str(payload.get("language") or "")
            updates["DASHSCOPE_WORKSPACE_ID"] = str(payload.get("workspaceId") or "").strip()
        try:
            save_env(self.paths.env_path, updates)
        except (OSError, UnicodeError, ValueError) as error:
            return _error_result("", "config_save_failed", f"{self.paths.env_path}: {error}")
        return {
            "ok": True,
            "maskedApiKey": masked_secret(api_key),
            "modelCacheRoot": updates.get("MAW_MODEL_CACHE_ROOT", effective_config(self.paths.env_path).model_cache_root),
            "message": "settings saved",
        }

    def save_prefs(self, payload: Mapping[str, object]) -> dict[str, object]:
        updates: dict[str, str] = {}
        if "modelId" in payload:
            updates["MAW_GUI_LAST_MODEL"] = str(payload.get("modelId") or "")
        if "language" in payload:
            updates["MAW_GUI_LAST_LANGUAGE"] = str(payload.get("language") or "")
        if "showRareLangs" in payload:
            updates["MAW_GUI_SHOW_RARE_LANGS"] = "true" if payload.get("showRareLangs") else "false"
        if "zoomPercent" in payload:
            from maw.gui_config import normalize_zoom_percent

            zoom_percent = normalize_zoom_percent(payload.get("zoomPercent"))
            updates["MAW_GUI_ZOOM_PERCENT"] = str(zoom_percent)
        else:
            zoom_percent = effective_config(self.paths.env_path).zoom_percent
        if updates:
            try:
                save_env(self.paths.env_path, updates)
            except (OSError, UnicodeError, ValueError) as error:
                return _error_result("", "config_save_failed", f"{self.paths.env_path}: {error}")
        return {"ok": True, "zoomPercent": zoom_percent}

    def save_postprocess_settings(self, payload: Mapping[str, object]) -> dict[str, object]:
        preset = preset_by_id(str(payload.get("providerId") or "deepseek"))
        file_values = _postprocess_values(self.paths.env_path, preset.env_prefix)
        previous_values = {
            "apiKey": file_values["apiKey"],
            "baseUrl": file_values["baseUrl"] or preset.base_url,
            "model": file_values["model"] or preset.model,
        }
        api_key = str(payload.get("apiKey") or "").strip() or file_values["apiKey"]
        display_name = str(payload.get("displayName") or "").strip()
        try:
            reasoning_mode = normalize_reasoning_mode(
                payload.get("reasoningMode") if "reasoningMode" in payload else file_values["reasoningMode"]
            )
        except ValueError as error:
            return _error_result("postprocessReasoningMode", "invalid_reasoning_mode", str(error))
        updates = {
            f"{preset.env_prefix}_API_KEY": api_key,
            f"{preset.env_prefix}_BASE_URL": str(payload.get("baseUrl") or file_values["baseUrl"] or preset.base_url).strip(),
            f"{preset.env_prefix}_MODEL": str(payload.get("model") or file_values["model"] or preset.model).strip(),
            f"{preset.env_prefix}_REASONING_MODE": reasoning_mode,
            "MAW_POSTPROCESS_LAST_PROVIDER": preset.id,
        }
        if preset.id == "custom":
            updates[f"{preset.env_prefix}_DISPLAY_NAME"] = display_name
        try:
            save_env(self.paths.env_path, updates)
        except (OSError, UnicodeError, ValueError) as error:
            field = "postprocessApiKey"
            for key, candidate in (
                (f"{preset.env_prefix}_API_KEY", "postprocessApiKey"),
                (f"{preset.env_prefix}_BASE_URL", "postprocessBaseUrl"),
                (f"{preset.env_prefix}_MODEL", "postprocessModel"),
                (f"{preset.env_prefix}_DISPLAY_NAME", "postprocessDisplayName"),
            ):
                if str(error).startswith(f"{key}:"):
                    field = candidate
                    break
            return _error_result(field, "config_save_failed", f"{self.paths.env_path}: {error}")
        invalidate_llm_verification_if_changed(
            self.paths.env_path,
            preset.id,
            previous_values,
            {
                "apiKey": api_key,
                "baseUrl": updates[f"{preset.env_prefix}_BASE_URL"],
                "model": updates[f"{preset.env_prefix}_MODEL"],
            },
        )
        return {
            "ok": True,
            "providerId": preset.id,
            "label": display_name if preset.id == "custom" and display_name else preset.label,
            "displayName": display_name if preset.id == "custom" else "",
            "maskedApiKey": masked_secret(api_key),
            "reasoningMode": reasoning_mode,
            "verified": is_llm_verified(self.paths.env_path, preset.id),
        }

    def save_postprocess_plan(self, payload: Mapping[str, object]) -> dict[str, object]:
        try:
            plan = save_postprocess_plan(self.paths.env_path, payload.get("plan"))
        except (OSError, UnicodeError, ValueError) as error:
            return _error_result("autoPostprocess", "config_save_failed", str(error))
        return {"ok": True, "plan": plan}

    def validate_postprocess_plan(self, payload: Mapping[str, object]) -> dict[str, object]:
        media = Path(str(payload.get("mediaPath") or "")).expanduser()
        plan = payload.get("plan", default_postprocess_plan())
        ffmpeg = _postprocess_ffmpeg(self.paths.env_path)
        normalized, errors = validate_plan(plan, env_path=self.paths.env_path, media_path=media, ffmpeg_path=ffmpeg)
        return {"ok": not errors, "plan": normalized, "errors": list(errors)}

    def test_postprocess_connection(self, payload: Mapping[str, object]) -> dict[str, object]:
        preset = preset_by_id(str(payload.get("providerId") or "deepseek"))
        file_values = _postprocess_values(self.paths.env_path, preset.env_prefix)
        try:
            reasoning_mode = _postprocess_reasoning_mode(payload, file_values)
        except ValueError as error:
            return _error_result("postprocessReasoningMode", "invalid_reasoning_mode", str(error))
        settings = LlmSettings(
            provider_id=preset.id,
            api_key=str(payload.get("apiKey") or "").strip() or file_values["apiKey"],
            base_url=str(payload.get("baseUrl") or "").strip() or file_values["baseUrl"] or preset.base_url,
            model=str(payload.get("model") or "").strip() or file_values["model"] or preset.model,
            reasoning_mode=reasoning_mode,
        )
        if not settings.api_key:
            return _error_result("postprocessApiKey", "api_key_missing", "Post-processing API key is required.")
        if not settings.base_url or not settings.model:
            detail = "LLM API URL and model are required."
            return {"ok": False, "field": "postprocessProvider", "code": "postprocess_connection_failed", "detail": detail, "error": detail}
        try:
            test_llm_connection(settings)
        except LlmClientError as error:
            detail = str(error)
            return {"ok": False, "field": "postprocessProvider", "code": "postprocess_connection_failed", "detail": detail, "error": detail}
        stored = _postprocess_values(self.paths.env_path, preset.env_prefix)
        if (
            stored["apiKey"] == settings.api_key
            and (stored["baseUrl"] or preset.base_url) == settings.base_url
            and (stored["model"] or preset.model) == settings.model
        ):
            from maw.postprocess_pipeline import record_llm_verification

            record_llm_verification(self.paths.env_path, preset.id, {
                "apiKey": settings.api_key,
                "baseUrl": settings.base_url,
                "model": settings.model,
            })
        return {"ok": True, "providerId": preset.id, "verified": is_llm_verified(self.paths.env_path, preset.id)}

    def get_postprocess_models(self, payload: Mapping[str, object]) -> dict[str, object]:
        preset = preset_by_id(str(payload.get("providerId") or "deepseek"))
        file_values = _postprocess_values(self.paths.env_path, preset.env_prefix)
        settings = LlmSettings(
            provider_id=preset.id,
            api_key=str(payload.get("apiKey") or "").strip() or file_values["apiKey"],
            base_url=str(payload.get("baseUrl") or "").strip() or file_values["baseUrl"] or preset.base_url,
            model=str(payload.get("model") or "").strip() or file_values["model"] or preset.model,
        )
        if not settings.api_key:
            return _error_result("postprocessApiKey", "api_key_missing", "Post-processing API key is required.")
        try:
            models = list_llm_models(settings)
        except LlmClientError as error:
            detail = str(error)
            return {"ok": False, "field": "postprocessModel", "code": "postprocess_models_failed", "detail": detail, "error": detail}
        return {"ok": True, "providerId": preset.id, "models": models}

    def run_fixed_process(self, payload: Mapping[str, object]) -> dict[str, object]:
        self._emit_postprocess_status("toolbox_status_reading")
        try:
            replacements = tuple(
                Replacement(source=str(item.get("source") or ""), target=str(item.get("target") or ""))
                for item in _mapping_list(payload.get("replacements"))
            )
            self._emit_postprocess_status("toolbox_status_fixed_processing")
            result = process_fixed_process(
                FixedProcessRequest(
                    project_path=_optional_path(payload.get("projectPath")),
                    srt_path=_optional_path(payload.get("srtPath")),
                    output_mode=_output_mode(payload.get("outputMode")),
                    replacements=replacements,
                    media_path=_optional_path(payload.get("mediaPath")),
                    conversion=normalize_text_conversion_mode(payload.get("conversion")),
                )
            )
            self._emit_postprocess_status("toolbox_status_writing")
        except (OSError, UnicodeError, ValueError, TextConversionUnavailable) as error:
            return {"ok": False, "field": "postprocessInput", "code": "postprocess_failed", "detail": str(error), "error": str(error)}
        return _subtitle_artifact_result(result)

    def run_fixed_replacement(self, payload: Mapping[str, object]) -> dict[str, object]:
        """Compatibility bridge for callers using the old toolbox method name."""

        return self.run_fixed_process(payload)

    def run_script_match(self, payload: Mapping[str, object]) -> dict[str, object]:
        script_path = _optional_path(payload.get("scriptPath"))
        if script_path is None:
            return _error_result("postprocessScriptPath", "postprocess_failed", "A script file is required.")
        self._emit_postprocess_status("toolbox_status_reading")
        try:
            self._emit_postprocess_status("toolbox_status_matching")
            result = process_script_match(
                ScriptMatchRequest(
                    project_path=_optional_path(payload.get("projectPath")),
                    srt_path=_optional_path(payload.get("srtPath")),
                    script_path=script_path,
                    output_mode=_output_mode(payload.get("outputMode")),
                    media_path=_optional_path(payload.get("mediaPath")),
                )
            )
            self._emit_postprocess_status("toolbox_status_writing")
        except (OSError, UnicodeError, ValueError) as error:
            return {"ok": False, "field": "postprocessScriptPath", "code": "postprocess_failed", "detail": str(error), "error": str(error)}
        return _subtitle_artifact_result(result)

    def run_ocr_dedup(self, payload: Mapping[str, object]) -> dict[str, object]:
        runtime = self._ocr_runtime_status()
        if not runtime.ready:
            return _error_result("ocrModel", "ocr_runtime_missing", runtime.detail)
        if self.ocr_runtime_worker and self.ocr_runtime_worker.is_alive():
            return _error_result("ocrModel", "ocr_runtime_install_failed", "OCR 运行环境正在安装中。")
        model_id = str(payload.get("modelId") or OCR_MODEL_ID)
        try:
            _ = ocr_model_type(model_id)
        except ValueError as error:
            return _error_result("ocrModel", "ocr_model_missing", str(error))
        configured = effective_config_value(self.paths.env_path, "FFMPEG_PATH")
        ffmpeg = find_ffmpeg(configured)
        if ffmpeg is None:
            bundled_directory = _bundled_ffmpeg_directory()
            if bundled_directory is not None:
                ffmpeg = (bundled_directory / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")).resolve()
        if ffmpeg is None:
            return {"ok": False, "field": "ocrVideoPath", "code": "postprocess_failed", "detail": "找不到 FFmpeg，无法抽取视频画面。", "error": "找不到 FFmpeg，无法抽取视频画面。"}
        self._emit_postprocess_status("toolbox_status_reading")
        try:
            raw_threshold = payload.get("threshold")
            request = OcrDedupRequest(
                project_path=_optional_path(payload.get("projectPath")),
                srt_path=_optional_path(payload.get("srtPath")),
                video_path=_optional_path(payload.get("videoPath")),
                output_mode=_output_mode(payload.get("outputMode")),
                fallback_video_path=_optional_path(payload.get("fallbackVideoPath")),
                media_path=_optional_path(payload.get("mediaPath")),
                region=_ocr_region(payload),
                threshold=float(str(raw_threshold if raw_threshold is not None else "0.5")),
                report=bool(payload.get("report")),
            )
            result = run_ocr_in_runtime(
                request,
                ffmpeg_path=ffmpeg,
                runtime_root=runtime.path,
                model_id=model_id,
                on_status=self._emit_postprocess_status,
            )
        except OcrRuntimeCancelled as error:
            return _error_result("ocrModel", "ocr_runtime_cancelled", str(error))
        except (OSError, UnicodeError, ValueError, OcrRuntimeError) as error:
            return {"ok": False, "field": "ocrVideoPath", "code": "postprocess_failed", "detail": str(error), "error": str(error)}
        return {"ok": True, **result}

    def run_llm_postprocess(self, payload: Mapping[str, object]) -> dict[str, object]:
        preset = preset_by_id(str(payload.get("providerId") or "deepseek"))
        operation = str(payload.get("operation") or "proofread")
        custom_prompt = str(payload.get("customPrompt") or "").strip()
        if operation == "custom" and not custom_prompt:
            return _error_result("postprocessPrompt", "custom_prompt_required")
        file_values = _postprocess_values(self.paths.env_path, preset.env_prefix)
        try:
            reasoning_mode = _postprocess_reasoning_mode(payload, file_values)
        except ValueError as error:
            return _error_result("postprocessReasoningMode", "invalid_reasoning_mode", str(error))
        settings = LlmSettings(
            provider_id=preset.id,
            api_key=str(payload.get("apiKey") or "").strip() or file_values["apiKey"],
            base_url=str(payload.get("baseUrl") or "").strip() or file_values["baseUrl"] or preset.base_url,
            model=str(payload.get("model") or "").strip() or file_values["model"] or preset.model,
            reasoning_mode=reasoning_mode,
        )
        if not settings.api_key:
            return _error_result("postprocessApiKey", "api_key_missing", "Post-processing API key is required.")
        if not settings.base_url or not settings.model:
            return {"ok": False, "field": "postprocessProvider", "code": "postprocess_failed", "detail": "LLM API URL and model are required.", "error": "LLM API URL and model are required."}
        batch_number = 0

        def complete(prompt: str, cues: list[dict[str, JsonValue]]) -> dict[str, JsonValue]:
            nonlocal batch_number
            batch_number += 1
            current_batch = batch_number
            return complete_subtitle_groups(
                settings,
                prompt,
                cues,
                on_delta=lambda kind, text: self._emit_postprocess_stream(kind, text, current_batch),
            )

        try:
            result = process_llm_postprocess(
                LlmPostprocessRequest(
                    project_path=_optional_path(payload.get("projectPath")),
                    srt_path=_optional_path(payload.get("srtPath")),
                    output_mode=_output_mode(payload.get("outputMode")),
                    operation=operation,
                    custom_prompt=custom_prompt,
                    task_prompt=(str(payload.get("taskPrompt") or "") if "taskPrompt" in payload else None),
                    media_path=_optional_path(payload.get("mediaPath")),
                ),
                complete=complete,
                on_status=self._emit_postprocess_status,
            )
        except (OSError, UnicodeError, ValueError, RuntimeError) as error:
            return {"ok": False, "field": "postprocessInput", "code": "postprocess_failed", "detail": str(error), "error": str(error)}
        return _subtitle_artifact_result(result)

    def run_ffconcat_rebuild(self, payload: Mapping[str, object]) -> dict[str, object]:
        configured = effective_config_value(self.paths.env_path, "FFMPEG_PATH")
        ffmpeg = find_ffmpeg(configured)
        if ffmpeg is None:
            bundled_directory = _bundled_ffmpeg_directory()
            if bundled_directory is not None:
                ffmpeg = (bundled_directory / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")).resolve()
        if ffmpeg is None:
            return {"ok": False, "field": "postprocessFfconcat", "code": "postprocess_failed", "detail": "FFmpeg was not found.", "error": "FFmpeg was not found."}
        self._emit_postprocess_status("toolbox_status_validating_media")
        try:
            self._emit_postprocess_status("toolbox_status_rebuilding_media")
            result = process_ffconcat_rebuild(
                FfconcatRequest(
                    media_path=Path(str(payload.get("mediaPath") or "")),
                    ffconcat_path=Path(str(payload.get("ffconcatPath") or "")),
                ),
                ffmpeg_path=ffmpeg,
            )
        except (OSError, ValueError, RuntimeError) as error:
            return {"ok": False, "field": "postprocessFfconcat", "code": "postprocess_failed", "detail": str(error), "error": str(error)}
        return {
            "ok": True,
            "sourceMediaPath": str(result.source_media_path),
            "mediaPath": str(result.media_path),
            "ffconcatPath": str(result.ffconcat_path),
        }

    def choose_file(self, payload: Mapping[str, object]) -> dict[str, object]:
        kind = str(payload.get("kind") or "media")
        if kind == "json":
            file_types = ("MAW projects (*.mosp;*.json)",)
        elif kind == "subtitle":
            file_types = ("Subtitle files (*.mosp;*.json;*.srt)",)
        elif kind == "video":
            file_types = ("Video files (*.mp4;*.mkv;*.avi;*.mov;*.wmv;*.flv;*.webm;*.ts;*.m4v)", "All files (*.*)")
        elif kind == "ffconcat":
            file_types = ("FFconcat scripts (*.ffconcat)",)
        elif kind == "script":
            file_types = ("Script files (*.txt;*.md;*.markdown)", "All files (*.*)")
        elif kind == "hotwords":
            file_types = ("Text files (*.txt)", "All files (*.*)")
        else:
            file_types = ("Media files (*.mp4;*.mkv;*.avi;*.mov;*.wmv;*.flv;*.webm;*.ts;*.m4v;*.mp3;*.wav;*.m4a;*.flac;*.aac;*.ogg)", "All files (*.*)")
        multiple = bool(payload.get("multiple"))
        chosen = _file_dialog(open_dialog=True, file_types=file_types, multiple=multiple)
        return _dialog_result(chosen, include_paths=multiple)

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

    def open_file(self, payload: Mapping[str, object]) -> dict[str, object]:
        path = Path(str(payload.get("path") or "").strip()).expanduser()
        if not path.is_file():
            return {"ok": False, "error": f"File does not exist: {path}"}
        return _open_existing_path(path)

    def open_containing_folder(self, payload: Mapping[str, object]) -> dict[str, object]:
        path = Path(str(payload.get("path") or "").strip()).expanduser()
        if not path.is_file():
            return {"ok": False, "error": f"File does not exist: {path}"}
        return _open_existing_path(path.resolve().parent)

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
            self.server_process = popen_process_tree(
                command,
                stdout=self.server_log_file,
                stderr=subprocess.STDOUT,
                text=True,
                env=_child_environment(os.environ, "", provider=""),
                cwd=str(self.paths.root),
                **process_group_kwargs(),
            )
        except OSError as error:
            self._close_server_log()
            return _error_result("port", "server_start_failed", f"{url} | {error}")
        if not _wait_for_server(url, timeout=SERVER_START_TIMEOUT):
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
                terminate_process_tree(process)
                stopped = True
            return stopped
        finally:
            if process is not None:
                release_process_tree(process)
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
        if self.batch_worker and self.batch_worker.is_alive():
            return {"ok": False, "error": "A batch transcription is already running."}
        if self.worker and self.worker.is_alive():
            return {"ok": False, "error": "Transcription is already running."}
        if self.local_prepare_worker and self.local_prepare_worker.is_alive():
            return _error_result("model", "local_prepare_running")
        if self.local_runtime_worker and self.local_runtime_worker.is_alive():
            return _error_result("model", "local_runtime_install_failed", "本地运行环境正在安装中。")
        try:
            request = _request_from_payload(payload, self.paths.env_path)
        except PreflightError as error:
            return error.as_result()
        selected_output = unique_output_path(request.srt_path)
        output_renamed = selected_output != request.srt_path
        if output_renamed:
            request = replace(request, srt_path=selected_output)
        self.result = None
        self.cancel_event = Event()
        self.postprocess_workspace_directory = None
        self.postprocess_translation_srt_path = None
        self._last_postprocess_progress_at = 0.0
        self.pump.start()
        self.worker = threading.Thread(target=self._worker_main, args=(request, self.cancel_event), daemon=True)
        self.worker.start()
        return {
            "ok": True,
            "outputPath": str(request.srt_path),
            "outputRenamed": output_renamed,
            "rawPath": str(raw_response_path(request.srt_path)) if request.debug_raw else "",
        }

    def start_batch_transcription(self, payload: Mapping[str, object]) -> dict[str, object]:
        if self.worker and self.worker.is_alive() or self.batch_worker and self.batch_worker.is_alive():
            return {"ok": False, "error": "Transcription is already running."}
        raw_items = payload.get("items")
        if not isinstance(raw_items, Sequence) or isinstance(raw_items, (str, bytes)) or not raw_items:
            return {"ok": False, "field": "items", "code": "batch_items_required", "error": "Batch items are required."}
        shared = payload.get("settings")
        settings = dict(shared) if isinstance(shared, Mapping) else {key: value for key, value in payload.items() if key != "items"}
        items: list[BatchItem] = []
        reserved: set[Path] = set()
        for index, raw_item in enumerate(raw_items):
            item_id = str(raw_item.get("id") or index) if isinstance(raw_item, Mapping) else str(index)
            try:
                if not isinstance(raw_item, Mapping):
                    raise PreflightError("items", "batch_item_invalid", f"Batch item {index + 1} is invalid.")
                item_payload = {
                    **settings,
                    "mediaPath": raw_item.get("mediaPath"),
                    "srtPath": raw_item.get("srtPath") or raw_item.get("outputPath"),
                }
                merged = dict(item_payload)
                media_text = str(merged.get("mediaPath") or "").strip()
                if media_text and not str(merged.get("srtPath") or "").strip():
                    merged["srtPath"] = str(
                        default_srt_path(
                            Path(media_text),
                            provider=str(merged.get("providerId") or "qwen"),
                            model=str(merged.get("modelId") or DEFAULT_MODEL_ID),
                        )
                    )
                raw_plan = merged.get("autoPostprocess")
                if isinstance(raw_plan, Mapping):
                    merged["autoPostprocess"] = _batch_postprocess_plan(raw_plan)
                request = _request_from_payload(merged, self.paths.env_path)
                selected = _batch_unique_output_path(request.srt_path, reserved)
                items.append(BatchItem(str(raw_item.get("id") or index), replace(request, srt_path=selected)))
                reserved.update(_artifact_paths(selected))
            except PreflightError as error:
                items.append(BatchItem(item_id, None, error.message))
            except (OSError, ValueError) as error:
                items.append(BatchItem(item_id, None, str(error)))
        manifest_text = str(payload.get("manifestPath") or "").strip()
        first_request = next((item.request for item in items if item.request is not None), None)
        if first_request is None:
            details = "; ".join(
                f"{item.item_id}: {item.preflight_error}"
                for item in items
                if item.preflight_error
            )
            return {
                "ok": False,
                "field": "items",
                "code": "batch_items_invalid",
                "error": "No valid batch items were provided.",
                "detail": details,
            }
        manifest_path = Path(manifest_text).expanduser() if manifest_text else _unique_batch_manifest_path(first_request.srt_path.parent)
        self.batch_cancel_event = Event()
        self.pump.start()
        self.batch_worker = threading.Thread(
            target=self._batch_main,
            args=(tuple(items), settings, manifest_path, self.batch_cancel_event),
            daemon=True,
        )
        self.batch_worker.start()
        return {"ok": True, "manifestPath": str(manifest_path), "itemCount": len(items)}

    def cancel_batch_transcription(self, _payload: Mapping[str, object] | None = None) -> dict[str, object]:
        if self.batch_cancel_event:
            self.batch_cancel_event.set()
        if self.cancel_event:
            self.cancel_event.set()
        return {"ok": True}

    def _batch_main(self, items: Sequence[BatchItem], settings: Mapping[str, object], manifest_path: Path, cancel_event: Event) -> None:
        try:
            run_batch(
                items,
                settings=settings,
                manifest_path=manifest_path,
                cancel_event=cancel_event,
                on_event=self._emit,
                env_path=self.paths.env_path,
                ffmpeg_path=_postprocess_ffmpeg(self.paths.env_path),
                ocr_runtime_root=self._ocr_runtime_status().path,
            )
        # The background GUI boundary must unlock the batch controls after any failure.
        except Exception as error:  # noqa: BLE001
            self._emit(
                {
                    "type": "batch_done",
                    "status": "failed",
                    "error": str(error),
                    "outcomes": [],
                    "manifestPath": str(manifest_path),
                }
            )
        finally:
            if self.batch_worker is threading.current_thread():
                self.batch_worker = None
            self.pump.flush()

    def generate_waveform_project(self, payload: Mapping[str, object]) -> dict[str, object]:
        """Create a media-only project containing embedded waveform caches."""
        media_text = str(payload.get("mediaPath") or "").strip()
        media_path = Path(media_text).expanduser().resolve() if media_text else None
        if media_path is None or media_path.suffix.lower() not in MEDIA_EXTS or not media_path.is_file():
            return _error_result("mediaPath", "media_not_found", media_text)

        output_seed = unique_output_path(media_path.with_suffix(".waveform.srt"))
        project_path = output_seed.with_suffix(".mosp")
        project: dict[str, object] = {"media": str(media_path), "segments": []}
        try:
            cached = embed_media_caches(
                project,
                media_path,
                source_media_path=media_path,
                generate_spectral=bool(payload.get("generateSpectral")),
            )
            normalized = normalize_project(cached.project)
            waveform = normalized.get("waveform")
            if not is_waveform_payload(waveform) or int(waveform["peak_count"]) <= 0:
                return _error_result("mediaPath", "waveform_unavailable", str(media_path))
            project_path.write_bytes((json.dumps(normalized, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
        except (OSError, TypeError, ValueError) as error:
            return _error_result("mediaPath", "waveform_generation_failed", str(error))

        warnings: list[str] = []
        if cached.reapeaks_path is None:
            warnings.append("ReaPeaks cache was not generated.")
        return {
            "ok": True,
            "mediaPath": str(media_path),
            "projectPath": str(project_path),
            "warnings": warnings,
            "reapeaksPath": str(cached.reapeaks_path) if cached.reapeaks_path else "",
        }

    def get_local_models(self, payload: Mapping[str, object] | None = None) -> dict[str, object]:
        provider = provider_by_id("local")
        model_cache_root = effective_config(self.paths.env_path).model_cache_root
        selected_id = str((payload or {}).get("modelId") or "")
        selected_path = str((payload or {}).get("modelPath") or "").strip()
        return {
            "ok": True,
            "runtime": managed_runtime_status(model_cache_root).to_payload(),
            "models": [
                _model_payload(
                    model,
                    model_path=selected_path if model.id == selected_id else "",
                    model_cache_root=model_cache_root,
                )
                for model in provider.models
            ],
        }

    def get_local_runtime(self, _payload: Mapping[str, object] | None = None) -> dict[str, object]:
        model_cache_root = effective_config(self.paths.env_path).model_cache_root
        return {"ok": True, **managed_runtime_status(model_cache_root).to_payload()}

    def get_ocr_runtime(self, _payload: Mapping[str, object] | None = None) -> dict[str, object]:
        status = self._ocr_runtime_status()
        return {
            "ok": True,
            **status.to_payload(),
            "models": ocr_models_payload(status),
        }

    def save_ocr_settings(self, payload: Mapping[str, object]) -> dict[str, object]:
        value = str(payload.get("runtimePath") or payload.get("path") or "").strip()
        candidate = Path(value).expanduser().resolve(strict=False) if value else None
        if candidate is not None and candidate.exists() and not candidate.is_dir():
            return _error_result("ocrRuntimePath", "ocr_runtime_path_invalid", str(candidate))
        try:
            save_env(self.paths.env_path, {"MAW_OCR_RUNTIME_ROOT": str(candidate) if candidate else ""})
        except (OSError, UnicodeError, ValueError) as error:
            return _error_result("ocrRuntimePath", "config_save_failed", f"{self.paths.env_path}: {error}")
        status = self._ocr_runtime_status()
        return {"ok": True, "runtimePath": status.path, "runtime": status.to_payload()}

    def install_ocr_runtime(self, payload: Mapping[str, object] | None = None) -> dict[str, object]:
        if self.ocr_runtime_worker and self.ocr_runtime_worker.is_alive():
            return _error_result("ocrModel", "ocr_runtime_install_failed", "OCR 运行环境正在安装中。")
        repair = bool((payload or {}).get("repair"))
        runtime_root = effective_config_value(self.paths.env_path, "MAW_OCR_RUNTIME_ROOT")
        self.ocr_runtime_cancel_event = Event()
        self.pump.start()
        self.ocr_runtime_worker = threading.Thread(
            target=self._ocr_runtime_main,
            args=(repair, runtime_root, self.ocr_runtime_cancel_event),
            daemon=True,
        )
        self.ocr_runtime_worker.start()
        return {"ok": True, "installing": True, "repair": repair}

    def cancel_ocr_runtime(self, _payload: Mapping[str, object] | None = None) -> dict[str, object]:
        event = self.ocr_runtime_cancel_event
        if event:
            event.set()
        return {"ok": True}

    def install_local_runtime(self, payload: Mapping[str, object] | None = None) -> dict[str, object]:
        if self.worker and self.worker.is_alive():
            return {"ok": False, "error": "Transcription is already running."}
        if self.local_prepare_worker and self.local_prepare_worker.is_alive():
            return _error_result("model", "local_prepare_running")
        if getattr(self, "local_runtime_worker", None) and self.local_runtime_worker.is_alive():
            return _error_result("model", "local_runtime_install_failed", "本地运行环境正在安装中。")
        repair = bool((payload or {}).get("repair"))
        model_cache_root = effective_config(self.paths.env_path).model_cache_root
        self.local_runtime_cancel_event = Event()
        self.pump.start()
        self.local_runtime_worker = threading.Thread(
            target=self._local_runtime_main,
            args=(repair, model_cache_root, self.local_runtime_cancel_event),
            daemon=True,
        )
        self.local_runtime_worker.start()
        return {"ok": True, "installing": True, "repair": repair}

    def cancel_local_runtime(self, _payload: Mapping[str, object] | None = None) -> dict[str, object]:
        event = getattr(self, "local_runtime_cancel_event", None)
        if event:
            event.set()
        return {"ok": True}

    def cancel_local_model(self, _payload: Mapping[str, object] | None = None) -> dict[str, object]:
        event = getattr(self, "local_prepare_cancel_event", None)
        worker = getattr(self, "local_prepare_worker", None)
        active = bool(event and worker and worker.is_alive())
        if active:
            event.set()
        return {"ok": True, "cancelling": active}

    def prepare_local_model(self, payload: Mapping[str, object]) -> dict[str, object]:
        if self.worker and self.worker.is_alive():
            return {"ok": False, "error": "Transcription is already running."}
        if self.local_runtime_worker and self.local_runtime_worker.is_alive():
            return _error_result("model", "local_runtime_install_failed", "本地运行环境正在安装中。")
        if self.local_prepare_worker and self.local_prepare_worker.is_alive():
            return _error_result("model", "local_prepare_running")
        provider = provider_by_id("local")
        model_cache_root = effective_config(self.paths.env_path).model_cache_root
        requested_model = str(payload.get("modelId") or "")
        model = next((item for item in provider.models if requested_model in (item.id, item.label)), provider.models[0])
        model_path = str(payload.get("modelPath") or "").strip()
        status = inspect_local_model(model, model_path, model_cache_root=model_cache_root)
        if status.status == "runtime_missing":
            return _error_result("model", "local_runtime_missing", status.detail)
        if status.status == "path_invalid":
            return _error_result("localModelPath", "local_model_path_invalid", status.detail)
        if status.status == "path_mismatch":
            return _error_result("localModelPath", "local_model_path_mismatch", status.detail)
        if status.status == "installed":
            return {"ok": True, "alreadyInstalled": True, "modelId": model.id}
        self.local_prepare_cancel_event = Event()
        self.pump.start()
        self.local_prepare_worker = threading.Thread(
            target=self._local_prepare_main,
            args=(
                model,
                model_path,
                str(payload.get("device") or "auto"),
                str(payload.get("forcedAligner") or "").strip(),
                model_cache_root,
                self.local_prepare_cancel_event,
            ),
            daemon=True,
        )
        self.local_prepare_worker.start()
        return {"ok": True, "preparing": True, "modelId": model.id}

    def cancel_transcription(self, _payload: Mapping[str, object] | None = None) -> dict[str, object]:
        if self.cancel_event:
            self.cancel_event.set()
        return {"ok": True}

    def retry_postprocess(self, _payload: Mapping[str, object] | None = None) -> dict[str, object]:
        context = self.postprocess_retry_context
        if not context:
            return {"ok": False, "error": "没有可恢复的自动后处理任务。"}
        if self.worker and self.worker.is_alive():
            return {"ok": False, "error": "任务仍在运行中。"}
        self.cancel_event = Event()
        self._last_postprocess_progress_at = 0.0
        self.pump.start()
        self.worker = threading.Thread(
            target=self._retry_postprocess_main,
            args=(context, self.cancel_event),
            daemon=True,
        )
        self.worker.start()
        return {"ok": True, "retrying": True}

    def open_output_folder(self, _payload: Mapping[str, object] | None = None) -> dict[str, object]:
        if self.result:
            return _open_existing_path(self.result.srt_path.parent)
        return {"ok": False, "error": "No result yet."}

    def open_postprocess_folder(self, _payload: Mapping[str, object] | None = None) -> dict[str, object]:
        directory = self.postprocess_workspace_directory
        if directory is None and self.postprocess_retry_context:
            value = self.postprocess_retry_context.get("runDirectory")
            if value:
                directory = Path(str(value)).expanduser().resolve()
        if directory is None:
            return {"ok": False, "error": "没有可打开的自动后处理中间产物。"}
        return _open_existing_path(directory)

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
        except (OSError, UnicodeError, ValueError) as error:
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
        except (OSError, UnicodeError, ValueError) as error:
            return _error_result("stickerDir", "config_save_failed", f"{self.paths.env_path}: {error}")
        return {"ok": True, "stickerDir": str(path)}

    def shutdown(self) -> None:
        self.cancel_transcription()
        self.cancel_batch_transcription()
        if self.local_prepare_cancel_event:
            self.local_prepare_cancel_event.set()
        if self.local_runtime_cancel_event:
            self.local_runtime_cancel_event.set()
        if self.ocr_runtime_cancel_event:
            self.ocr_runtime_cancel_event.set()
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
        except TranscriptionCancelledError as error:
            self._emit({"type": "error", "code": "transcription_cancelled", "detail": str(error)})
            if self.worker is threading.current_thread():
                self.worker = None
            self.pump.flush()
            return
        except TranscriptionProcessError as error:
            if _is_ffprobe_start_failure(child_output):
                self._emit({
                    "type": "error",
                    "code": "ffprobe_start_failed",
                    "detail": str(error),
                })
            elif _is_ffmpeg_start_failure(child_output):
                self._emit({
                    "type": "error",
                    "code": "ffmpeg_start_failed",
                    "detail": str(error),
                })
            else:
                self._emit({"type": "error", "code": "transcription_failed", "detail": str(error)})
            if self.worker is threading.current_thread():
                self.worker = None
            self.pump.flush()
            return
        # The pywebview worker boundary must report every backend failure to JS.
        except Exception as error:  # noqa: BLE001
            self._emit({"type": "error", "code": "transcription_failed", "detail": str(error)})
            if self.worker is threading.current_thread():
                self.worker = None
            self.pump.flush()
            return
        self.result = result
        self.postprocess_retry_context = None
        self._last_postprocess_progress_at = 0.0
        auto_run_directory: Path | None = None
        if request.postprocess_plan:
            try:
                auto_result = run_postprocess_pipeline(
                    request.postprocess_plan,
                    media_path=request.media_path,
                    project_path=result.json_path,
                    srt_path=result.srt_path,
                    env_path=self.paths.env_path,
                    ffmpeg_path=_postprocess_ffmpeg(self.paths.env_path),
                    ocr_runtime_root=self._ocr_runtime_status().path,
                    cancel_event=cancel_event,
                    on_event=self._handle_postprocess_pipeline_event,
                    llm_settings=request.postprocess_llm_settings,
                )
                auto_run_directory = auto_result.run_directory
                self.postprocess_translation_srt_path = auto_result.translated_srt_path
                self.result = replace(result, srt_path=auto_result.srt_path, json_path=auto_result.project_path)
            except PostprocessCancelled as error:
                self._emit({"type": "error", "code": "postprocess_cancelled", "detail": str(error), "postprocessRunDirectory": str(self.postprocess_workspace_directory or "")})
                if self.worker is threading.current_thread():
                    self.worker = None
                self.pump.flush()
                return
            except PostprocessPipelineError as error:
                self.postprocess_retry_context = {
                    "plan": request.postprocess_plan,
                    "mediaPath": str(request.media_path),
                    "sourceProjectPath": str(result.json_path),
                    "sourceSrtPath": str(result.srt_path),
                    "runDirectory": str(error.run_directory),
                    "failedIndex": error.failed_index,
                    "currentProject": str(error.current_project),
                    "currentSrt": str(error.current_srt),
                    "llmSettings": request.postprocess_llm_settings,
                }
                self._emit({
                    "type": "error",
                    "code": "postprocess_failed",
                    "detail": str(error),
                    "canRetry": True,
                    "postprocessRunDirectory": str(error.run_directory),
                })
                if self.worker is threading.current_thread():
                    self.worker = None
                self.pump.flush()
                return
            except Exception as error:  # noqa: BLE001 - postprocess boundary reports separately from ASR.
                self._emit({"type": "error", "code": "postprocess_failed", "detail": str(error), "postprocessRunDirectory": str(self.postprocess_workspace_directory or "")})
                if self.worker is threading.current_thread():
                    self.worker = None
                self.pump.flush()
                return
        result = self.result
        assert result is not None
        self.postprocess_workspace_directory = auto_run_directory if auto_run_directory and auto_run_directory.is_dir() else None
        self._emit({"type": "done", "result": {"srtPath": str(result.srt_path), "translatedSrtPath": str(self.postprocess_translation_srt_path or ""), "jsonPath": str(result.json_path), "htmlPath": str(result.html_path or ""), "rawPath": str(result.raw_path or ""), "postprocessRunDirectory": str(self.postprocess_workspace_directory or "")}})
        if self.worker is threading.current_thread():
            self.worker = None
        self.pump.flush()

    def _retry_postprocess_main(self, context: Mapping[str, object], cancel_event: Event) -> None:
        result = self.result
        if result is None:
            self._emit({"type": "error", "code": "postprocess_failed", "detail": "原始转写结果已不可用。"})
            if self.worker is threading.current_thread():
                self.worker = None
            self.pump.flush()
            return
        try:
            auto_result = run_postprocess_pipeline(
                context.get("plan") if isinstance(context.get("plan"), Mapping) else default_postprocess_plan(),
                media_path=Path(str(context.get("mediaPath") or "")),
                project_path=Path(str(context.get("sourceProjectPath") or result.json_path)),
                srt_path=Path(str(context.get("sourceSrtPath") or result.srt_path)),
                env_path=self.paths.env_path,
                ffmpeg_path=_postprocess_ffmpeg(self.paths.env_path),
                ocr_runtime_root=self._ocr_runtime_status().path,
                cancel_event=cancel_event,
                on_event=self._handle_postprocess_pipeline_event,
                llm_settings=context.get("llmSettings") if isinstance(context.get("llmSettings"), Mapping) else None,
                resume_directory=Path(str(context.get("runDirectory") or "")),
                resume_from=int(context.get("failedIndex") or 0),
                resume_project_path=Path(str(context.get("currentProject") or result.json_path)),
                resume_srt_path=Path(str(context.get("currentSrt") or result.srt_path)),
            )
        except PostprocessCancelled as error:
            self._emit({"type": "error", "code": "postprocess_cancelled", "detail": str(error), "postprocessRunDirectory": str(self.postprocess_workspace_directory or "")})
            if self.worker is threading.current_thread():
                self.worker = None
            self.pump.flush()
            return
        except PostprocessPipelineError as error:
            self.postprocess_retry_context = {
                **dict(context),
                "runDirectory": str(error.run_directory),
                "failedIndex": error.failed_index,
                "currentProject": str(error.current_project),
                "currentSrt": str(error.current_srt),
            }
            self._emit({"type": "error", "code": "postprocess_failed", "detail": str(error), "canRetry": True, "postprocessRunDirectory": str(error.run_directory)})
            if self.worker is threading.current_thread():
                self.worker = None
            self.pump.flush()
            return
        except Exception as error:  # noqa: BLE001 - retry boundary reports to the Launcher.
            self._emit({"type": "error", "code": "postprocess_failed", "detail": str(error), "canRetry": True, "postprocessRunDirectory": str(self.postprocess_workspace_directory or "")})
            if self.worker is threading.current_thread():
                self.worker = None
            self.pump.flush()
            return
        self.result = replace(result, srt_path=auto_result.srt_path, json_path=auto_result.project_path)
        self.postprocess_translation_srt_path = auto_result.translated_srt_path
        self.postprocess_retry_context = None
        self.postprocess_workspace_directory = auto_result.run_directory if auto_result.run_directory.is_dir() else None
        self._emit({"type": "done", "result": {"srtPath": str(self.result.srt_path), "translatedSrtPath": str(self.postprocess_translation_srt_path or ""), "jsonPath": str(self.result.json_path), "htmlPath": str(self.result.html_path or ""), "rawPath": str(self.result.raw_path or ""), "postprocessRunDirectory": str(self.postprocess_workspace_directory or "")}})
        if self.worker is threading.current_thread():
            self.worker = None
        self.pump.flush()

    def _emit_postprocess_status(self, key: str, details: Mapping[str, int] | None = None) -> None:
        self.pump.start()
        event: dict[str, object] = {"type": "postprocess_status", "key": key}
        if details:
            event.update(details)
        self._emit(event)

    def _emit_postprocess_stream(self, kind: str, text: str, batch: int) -> None:
        if kind != "reset" and not text:
            return
        self.pump.start()
        self._emit({"type": "postprocess_stream", "kind": kind, "text": text, "batch": batch})

    def _handle_postprocess_pipeline_event(self, event: Mapping[str, object]) -> None:
        run_directory = str(event.get("runDirectory") or "").strip()
        if run_directory:
            self.postprocess_workspace_directory = Path(run_directory).expanduser().resolve()
        payload = {"type": "postprocess_pipeline", **dict(event)}
        self._emit(payload)
        stage = str(event.get("stage") or "")
        labels = {
            "match": "文稿匹配",
            "replace": "固定处理",
            "proofread": "LLM 校对",
            "resegment": "重新断句",
            "ocr": "OCR 字幕去重",
            "translate": "翻译",
        }
        step = labels.get(str(event.get("step") or ""), str(event.get("step") or "后处理"))
        if stage == "start":
            self._emit({"type": "log", "message": f"[后处理] 已开始，共 {event.get('total', 0)} 步"})
        elif stage == "step_start":
            self._emit({"type": "log", "message": f"[后处理 {event.get('index', '?')}/{event.get('total', '?')}] {step}：开始"})
        elif stage == "step_done":
            artifacts = " / ".join(
                name
                for name in (str(event.get("projectName") or ""), str(event.get("srtName") or ""), str(event.get("translatedSrtName") or ""))
                if name
            )
            suffix = f"（{artifacts}）" if artifacts else ""
            self._emit({"type": "log", "message": f"[后处理 {event.get('index', '?')}/{event.get('total', '?')}] {step}：完成{suffix}"})
        elif stage == "done":
            artifacts = " / ".join(
                name
                for name in (str(event.get("projectName") or ""), str(event.get("srtName") or ""), str(event.get("translatedSrtName") or ""))
                if name
            )
            self._emit({"type": "log", "message": f"[后处理] 全部完成：{artifacts}"})
        elif stage == "cancelled":
            self._emit({"type": "log", "message": "[后处理] 已取消；原始转写产物仍然保留。"})
        elif stage == "failed":
            self._emit({"type": "log", "message": "[后处理] 失败；原始转写产物和中间产物已保留。"})
        elif stage == "detail" and str(event.get("key") or "") in {"toolbox_status_llm_batch", "toolbox_status_ocr_frame"}:
            now = time.monotonic()
            current = event.get("current")
            total = event.get("total")
            if now - self._last_postprocess_progress_at >= 1.0 or current == total:
                self._last_postprocess_progress_at = now
                self._emit({"type": "log", "message": f"[后处理] {step} 进度 {current}/{total}"})

    def _local_runtime_main(
        self,
        repair: bool,
        model_cache_root: str,
        cancel_event: Event,
    ) -> None:
        def on_progress(message: str, percent: int, stage: str) -> None:
            if cancel_event.is_set():
                return
            self._emit({
                "type": "localRuntimeProgress",
                "message": message,
                "percent": percent,
                "stage": stage,
            })
            self._emit({"type": "log", "message": f"[runtime] {message}"})

        try:
            status = install_local_runtime(
                on_event=on_progress,
                cancel_event=cancel_event,
                repair=repair,
                model_cache_root=model_cache_root,
            )
            if cancel_event.is_set():
                return
            self._emit({"type": "localRuntimeReady", "runtime": status.to_payload()})
        except LocalRuntimeCancelled as error:
            if cancel_event.is_set():
                self._emit({"type": "localRuntimeCancelled"})
            else:
                self._emit({"type": "error", "code": "local_runtime_cancelled", "field": "model", "detail": str(error)})
        except (LocalRuntimeError, OSError) as error:
            if not cancel_event.is_set():
                self._emit({"type": "error", "code": "local_runtime_install_failed", "field": "model", "detail": str(error)})
        finally:
            self.pump.flush()

    def _ocr_runtime_main(
        self,
        repair: bool,
        runtime_root: str,
        cancel_event: Event,
    ) -> None:
        def on_progress(message: str, percent: int, stage: str) -> None:
            if cancel_event.is_set():
                return
            self._emit({
                "type": "ocrRuntimeProgress",
                "message": message,
                "percent": percent,
                "stage": stage,
            })
            self._emit({"type": "log", "message": f"[ocr-runtime] {message}"})

        try:
            status = install_ocr_runtime(
                on_event=on_progress,
                cancel_event=cancel_event,
                repair=repair,
                runtime_root=runtime_root,
            )
            if cancel_event.is_set():
                return
            self._emit({
                "type": "ocrRuntimeReady",
                "runtime": status.to_payload(),
                "models": ocr_models_payload(status),
            })
        except OcrRuntimeCancelled as error:
            if cancel_event.is_set():
                self._emit({"type": "ocrRuntimeCancelled"})
            else:
                self._emit({"type": "error", "code": "ocr_runtime_cancelled", "field": "ocrModel", "detail": str(error)})
        except (OcrRuntimeError, OSError) as error:
            if not cancel_event.is_set():
                self._emit({"type": "error", "code": "ocr_runtime_install_failed", "field": "ocrModel", "detail": str(error)})
        finally:
            self.pump.flush()

    def _local_prepare_main(
        self,
        model: ModelConfig,
        model_path: str,
        device: str,
        forced_aligner: str,
        model_cache_root: str,
        cancel_event: Event,
    ) -> None:
        def on_event(message: str) -> None:
            if not cancel_event.is_set():
                self._emit({"type": "log", "message": message})
                self._emit({"type": "modelProgress", "message": message})

        def on_progress(progress: Mapping[str, object]) -> None:
            if cancel_event.is_set():
                return
            message = str(progress.get("message") or "")
            self._emit({"type": "modelProgress", **dict(progress)})
            if message:
                self._emit({"type": "log", "message": message})

        try:
            status = prepare_model(
                model,
                model_path=model_path,
                device=device,
                forced_aligner=forced_aligner,
                model_cache_root=model_cache_root,
                on_event=on_event,
                on_progress=on_progress,
                cancel_event=cancel_event,
            )
            if cancel_event.is_set():
                self._emit({"type": "localPrepareCancelled", "modelId": model.id})
                return
            self._emit({
                "type": "modelPrepared",
                "modelId": model.id,
                "status": local_model_payload(model, model_path, model_cache_root=model_cache_root) | {"status": status.status},
            })
        # Optional runtime setup failures are converted into a user-facing status.
        except Exception as error:  # noqa: BLE001
            if cancel_event.is_set():
                self._emit({"type": "localPrepareCancelled", "modelId": model.id})
            else:
                self._emit({"type": "error", "code": "local_prepare_failed", "field": "model", "detail": str(error)})
        finally:
            self.pump.flush()

    def _emit(self, event: Mapping[str, object]) -> None:
        self.pump.enqueue(event)

    def handle_drop_paths(self, paths: Sequence[str]) -> None:
        for path in paths:
            if path:
                self._emit(_route_dropped_path(path))
                self.pump.flush()


def run_app(*, debug: bool = False, devtools: bool = False) -> None:
    import webview

    # pywebview opens DevTools automatically in debug mode when this setting is
    # enabled. Keep debug mode and automatic DevTools opening independently
    # controllable so normal development does not force an extra window.
    webview.settings["OPEN_DEVTOOLS_IN_DEBUG"] = devtools
    paths = default_paths()
    api = LauncherApi(paths=paths)
    window = webview.create_window(
        WINDOW_TITLE,
        url=paths.launcher_html.resolve().as_uri(),
        js_api=api,
        width=900,
        height=880,
        min_size=(760, 640),
        background_color="#16181d",
        text_select=True,
    )
    if window is not None:
        window.events.closing += lambda: api.shutdown()

        def _on_loaded() -> None:
            api.pump.start()
            apply_dark_title_bar(WINDOW_TITLE)

        window.events.loaded += _on_loaded
    icon = asset_path("assets/maw.ico")
    webview.start(
        lambda: bind_launcher_drop(window, api),
        debug=debug or devtools,
        icon=str(icon) if icon.exists() else None,
    )


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
    postprocess_step: str = ""

    def as_result(self) -> dict[str, object]:
        result = _error_result(self.field, self.code, self.message)
        if self.postprocess_step:
            result["postprocessStep"] = self.postprocess_step
        return result


def _segmentation_option(
    payload: Mapping[str, object],
    *,
    field: str,
    label: str,
    minimum: int,
) -> str:
    text = str(payload.get(field) or "").strip()
    if not text:
        return ""
    try:
        value = int(text)
    except (TypeError, ValueError) as error:
        raise PreflightError(field, "segmentation_invalid", f"{label}必须是整数。") from error
    if value < minimum:
        raise PreflightError(field, "segmentation_invalid", f"{label}不能小于 {minimum}。")
    return str(value)


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
    runtime_python = ""
    if not media_text or not media.exists():
        raise PreflightError("mediaPath", "media_not_found", "Media file does not exist.")
    if not srt_text or not srt.name:
        raise PreflightError("srtPath", "output_missing", "SRT output path is required.")
    max_len = _segmentation_option(payload, field="maxLen", label="最大字数", minimum=1)
    min_len = _segmentation_option(payload, field="minLen", label="短句合并阈值", minimum=1)
    gap_split = _segmentation_option(payload, field="gapSplit", label="停顿切句阈值", minimum=0)
    if max_len and min_len and int(max_len) < int(min_len):
        raise PreflightError(
            "maxLen",
            "segmentation_invalid",
            "最大字数不能小于短句合并阈值。",
        )
    local_model_path = str(payload.get("localModelPath") or "").strip()
    device = str(payload.get("device") or "auto").strip().lower()
    model_cache_root = ""
    if provider.kind == "local":
        model_cache_root = effective_config(env_path).model_cache_root
        local_status = inspect_local_model(
            model,
            local_model_path,
            model_cache_root=model_cache_root,
        )
        if local_status.status == "path_invalid":
            raise PreflightError("localModelPath", "local_model_path_invalid", local_status.detail)
        if local_status.status == "path_mismatch":
            raise PreflightError("localModelPath", "local_model_path_mismatch", local_status.detail)
        if local_status.status == "runtime_missing":
            raise PreflightError("model", "local_runtime_missing", local_status.detail)
        if local_status.status == "missing":
            raise PreflightError("model", "local_model_missing", local_status.detail)
        if local_status.status == "partial":
            raise PreflightError("model", "local_model_incomplete", local_status.detail)
        runtime_python = local_status.runtime_python
        if device not in {"auto", "cpu", "cuda"}:
            raise PreflightError("device", "local_model_path_invalid", "设备必须是 auto、cpu 或 cuda。")
    if provider.requires_api_key and not api_key:
        raise PreflightError("apiKey", "api_key_missing", "API key is required.")
    if provider.id == "qwen" and region == "singapore" and not workspace_id:
        raise PreflightError("workspaceId", "workspace_missing", "Workspace ID is required for Singapore region.")
    qwen_audio_context = (
        str(payload.get("qwenAudioContext") or "").strip()
        if provider.id == "qwen" and model.supports_context else ""
    )
    if len(qwen_audio_context) > 400:
        raise PreflightError(
            "qwenAudioContext",
            "context_too_long",
            "Qwen-Audio context is limited to 400 characters.",
        )
    soniox_context = None
    if provider.id == "soniox" and model.supports_context:
        try:
            soniox_context = build_soniox_context(
                general=str(payload.get("sonioxContextGeneral") or ""),
                text=str(payload.get("sonioxContextText") or ""),
                terms=str(payload.get("sonioxContextTerms") or ""),
                translation_terms=str(payload.get("sonioxContextTranslationTerms") or ""),
            )
        except SonioxContextError as error:
            raise PreflightError(error.field, error.code, str(error)) from error
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
    auto_plan: dict[str, object] | None = None
    auto_llm_settings: dict[str, dict[str, str]] | None = None
    raw_auto_plan = payload.get("autoPostprocess")
    if isinstance(raw_auto_plan, Mapping):
        candidate_plan, plan_errors = validate_plan(
            raw_auto_plan,
            env_path=env_path,
            media_path=media,
            ffmpeg_path=_postprocess_ffmpeg(env_path),
        )
        if bool(candidate_plan.get("enabled")):
            if plan_errors:
                first_error = plan_errors[0]
                raise PreflightError(
                    str(first_error.get("field") or "autoPostprocess"),
                    "postprocess_config_invalid",
                    str(first_error.get("message") or "自动后处理配置不完整。"),
                    str(first_error.get("step") or ""),
                )
            if enabled_steps(candidate_plan):
                auto_plan = candidate_plan
                auto_llm_settings = snapshot_postprocess_llm_settings(env_path, candidate_plan)
    return TranscriptionRequest(
        media_path=media,
        srt_path=srt,
        model=model.model_ref or model.id,
        language=str(payload.get("language") or ""),
        api_key=api_key,
        length_limit="2m" if test_run else str(payload.get("lengthLimit") or "").strip(),
        max_len=max_len,
        min_len=min_len,
        gap_split=gap_split,
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
        soniox_context=soniox_context,
        region=region,
        workspace_id=workspace_id,
        provider=provider.id,
        speaker_colors=bool(payload.get("speakerColors")) and model.supports_speaker,
        generate_spectral=bool(payload.get("generateSpectral")),
        ui_language=_gui_lang(payload),
        generate_html=bool(payload.get("generateHtml")) and not bool(payload.get("batchSrtOnly")),
        srt_only=bool(payload.get("batchSrtOnly")),
        debug_raw=bool(payload.get("debugRaw")),
        engine=model.engine if provider.kind == "local" else "",
        model_path=local_model_path if provider.kind == "local" else "",
        model_cache_root=model_cache_root,
        device=device,
        forced_aligner=str(payload.get("forcedAligner") or "").strip(),
        runtime_python=runtime_python,
        postprocess_plan=auto_plan,
        postprocess_llm_settings=auto_llm_settings,
    )


def _file_dialog(*, open_dialog: bool, file_types: tuple[str, ...], save_filename: str = "", multiple: bool = False) -> tuple[str, ...] | None:
    import webview

    if not webview.windows:
        return None
    dialog_type = OPEN_DIALOG if open_dialog else SAVE_DIALOG
    selected = webview.windows[0].create_file_dialog(dialog_type, save_filename=save_filename, file_types=file_types, allow_multiple=multiple)
    return tuple(selected) if selected else None


def _folder_dialog() -> tuple[str, ...] | None:
    import webview

    if not webview.windows:
        return None
    selected = webview.windows[0].create_file_dialog(FOLDER_DIALOG)
    return tuple(selected) if selected else None


def _dialog_result(selected: tuple[str, ...] | None, *, include_paths: bool = False) -> dict[str, object]:
    if not selected:
        return {"ok": False, "path": ""}
    result: dict[str, object] = {"ok": True, "path": selected[0]}
    if include_paths:
        result["paths"] = list(selected)
    return result


def _artifact_paths(path: Path) -> set[Path]:
    return {path, path.with_suffix(".mosp"), path.with_suffix(".edit.html")}


def _batch_unique_output_path(path: Path, reserved: set[Path]) -> Path:
    candidate = unique_output_path(path)
    counter = 1
    while _artifact_paths(candidate) & reserved:
        candidate = path.with_name(f"{path.stem}-{counter}{path.suffix}")
        counter += 1
    return candidate


def _unique_batch_manifest_path(directory: Path) -> Path:
    candidate = directory / "maw-batch-manifest.json"
    counter = 1
    while candidate.exists():
        candidate = directory / f"maw-batch-manifest-{counter}.json"
        counter += 1
    return candidate


def _batch_postprocess_plan(plan: Mapping[str, object]) -> dict[str, object]:
    steps = plan.get("steps")
    if not isinstance(steps, Sequence) or isinstance(steps, (str, bytes)):
        return dict(plan)
    sanitized: dict[str, object] = {
        **dict(plan),
        "steps": [
            {**dict(step), "enabled": False}
            if isinstance(step, Mapping) and str(step.get("id") or "") == "match"
            else step
            for step in steps
        ],
    }
    if bool(sanitized.get("enabled")) and not enabled_steps(sanitized):
        sanitized["enabled"] = False
    return sanitized


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


def _optional_path(value: object) -> Path | None:
    text = str(value or "").strip()
    return Path(text) if text else None


def _output_mode(value: object) -> OutputMode:
    try:
        return OutputMode(str(value or OutputMode.BOTH.value))
    except ValueError:
        return OutputMode.BOTH


def _ocr_region(payload: Mapping[str, object]) -> OcrRegion:
    mode = str(payload.get("regionMode") or "full")
    if mode != "custom":
        return OcrRegion(mode=mode)

    def percent(field: str) -> float:
        raw = payload.get(field)
        if raw is None or not str(raw).strip():
            raise ValueError(f"OCR 自定义区域的 {field} 必须是数字")
        try:
            return float(str(raw)) / 100.0
        except ValueError as error:
            raise ValueError(f"OCR 自定义区域的 {field} 必须是数字") from error

    return OcrRegion(
        mode="custom",
        x1=percent("regionX1"),
        y1=percent("regionY1"),
        x2=percent("regionX2"),
        y2=percent("regionY2"),
    )


def _mapping_list(value: object) -> tuple[Mapping[str, object], ...]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        return ()
    return tuple(item for item in value if isinstance(item, Mapping))


def _postprocess_values(env_path: Path, prefix: str) -> dict[str, str]:
    from maw.gui_config import load_env

    values = load_env(env_path)
    api_key = os.environ.get(f"{prefix}_API_KEY") or values.get(f"{prefix}_API_KEY", "")
    if prefix == "MAW_POSTPROCESS_QWEN" and not api_key:
        api_key = os.environ.get("DASHSCOPE_API_KEY") or values.get("DASHSCOPE_API_KEY", "")
    return {
        "apiKey": api_key,
        "baseUrl": os.environ.get(f"{prefix}_BASE_URL") or values.get(f"{prefix}_BASE_URL", ""),
        "model": os.environ.get(f"{prefix}_MODEL") or values.get(f"{prefix}_MODEL", ""),
        "displayName": os.environ.get(f"{prefix}_DISPLAY_NAME") or values.get(f"{prefix}_DISPLAY_NAME", ""),
        "reasoningMode": os.environ.get(f"{prefix}_REASONING_MODE") or values.get(f"{prefix}_REASONING_MODE", DEFAULT_REASONING_MODE),
    }


def _postprocess_reasoning_mode(payload: Mapping[str, object], file_values: Mapping[str, str]) -> str:
    value = payload.get("reasoningMode") if "reasoningMode" in payload else file_values.get("reasoningMode")
    return normalize_reasoning_mode(value)


def _postprocess_provider_payloads(env_path: Path) -> list[dict[str, object]]:
    from maw.gui_config import load_env

    file_values = load_env(env_path)
    providers: list[dict[str, object]] = []
    for preset in POSTPROCESS_PRESETS:
        values = _postprocess_values(env_path, preset.env_prefix)
        display_name = values["displayName"] if preset.id == "custom" else ""
        providers.append({
            "id": preset.id,
            "label": display_name or preset.label,
            "defaultLabel": preset.label,
            "displayName": display_name,
            "baseUrl": values["baseUrl"] or preset.base_url,
            "model": values["model"] or preset.model,
            "reasoningMode": values["reasoningMode"] or DEFAULT_REASONING_MODE,
            "maskedApiKey": masked_secret(values["apiKey"]),
            "selected": file_values.get("MAW_POSTPROCESS_LAST_PROVIDER", "deepseek") == preset.id,
            "verified": is_llm_verified(env_path, preset.id),
            "hasApiKey": bool(values["apiKey"]),
            "hasBaseUrl": bool(values["baseUrl"] or preset.base_url),
            "hasModel": bool(values["model"] or preset.model),
        })
    return providers


def _subtitle_artifact_result(result: object) -> dict[str, object]:
    return {
        "ok": True,
        "sourceProjectPath": str(getattr(result, "source_project_path", None) or ""),
        "sourceSrtPath": str(getattr(result, "source_srt_path", None) or ""),
        "projectPath": str(getattr(result, "project_path", None) or ""),
        "srtPath": str(getattr(result, "srt_path", None) or ""),
        "translatedSrtPath": str(getattr(result, "translated_srt_path", None) or ""),
        "warnings": list(getattr(result, "warnings", ())),
    }


def _route_dropped_path(path: str) -> dict[str, object]:
    suffix = Path(path).suffix.lower()
    if suffix in {".json", ".mosp"}:
        return {"type": "dropJson", "path": path}
    if suffix == ".srt":
        return {"type": "dropSubtitle", "path": path}
    if suffix == ".txt":
        return {"type": "dropHotwordFile", "path": path}
    if suffix == ".ffconcat":
        return {"type": "dropFfconcat", "path": path}
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
    is_frozen_maw = any(flag in command for flag in ("--serve", "--server")) and bool(
        re.search(r"(?:^|[\\\"\s])maw\.exe(?:[\\\"\s]|$)", command)
    )
    is_source_maw = "server-editor\\serve.py" in command or (
        "maw_gui.py" in command and "--server" in command
    )
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


def _postprocess_ffmpeg(env_path: Path) -> Path | None:
    configured = effective_config_value(env_path, "FFMPEG_PATH")
    ffmpeg = find_ffmpeg(configured)
    if ffmpeg is None:
        bundled_directory = _bundled_ffmpeg_directory()
        if bundled_directory is not None:
            candidate = bundled_directory / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
            if candidate.is_file():
                return candidate.resolve()
    return ffmpeg.resolve() if ffmpeg is not None else None


def _check_ffmpeg(env_path: Path, override: str = "") -> dict[str, object]:
    ffmpeg_path = _which_ffmpeg_tool("ffmpeg")
    ffprobe_path = _which_ffmpeg_tool("ffprobe")
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


def _which_ffmpeg_tool(name: str) -> str | None:
    if sys.platform != "darwin":
        return shutil.which(name)
    return shutil.which(name, path=_ffmpeg_search_path())


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


def _provider_payload(
    provider: ProviderConfig,
    env_path: Path,
    model_cache_root: str = "",
) -> dict[str, object]:
    api_key = api_key_for_provider(provider.id, env_path)
    return {
        "id": provider.id,
        "label": provider.label,
        "kind": provider.kind,
        "keyUrl": provider.key_url,
        "requiresApiKey": provider.requires_api_key,
        "apiKey": api_key,
        "maskedApiKey": masked_secret(api_key),
        "supportsSpeaker": provider.supports_speaker,
        "multiLanguage": provider.multi_language,
        "supportsLanguage": provider.supports_language,
        "note": provider.note,
        "commonLanguages": list(provider.common_languages),
        "models": [
            _model_payload(item, model_cache_root=model_cache_root)
            for item in provider.models
        ],
        "regions": [{"id": value, "label": label} for value, label in provider.regions],
        "languages": [{"id": value, "label": label} for value, label in provider.languages],
    }


def _model_payload(
    model: ModelConfig,
    *,
    model_path: str = "",
    model_cache_root: str = "",
) -> dict[str, object]:
    payload: dict[str, object] = {
        "id": model.id,
        "label": model.label,
        "envKey": model.env_key,
        "note": model.note,
        "supportsSpeaker": model.supports_speaker,
        "supportsContext": model.supports_context,
        "supportsHotwords": model.supports_hotwords,
        "supportsVocabulary": model.supports_vocabulary,
        "kind": model.kind,
        "engine": model.engine,
        "modelRef": model.model_ref,
        "requiredModelRefs": list(model.required_model_refs),
        "languages": [
            {"id": value, "label": label}
            for value, label in model.languages
        ],
    }
    if model.kind == "local":
        payload["localStatus"] = local_model_payload(
            model,
            model_path,
            model_cache_root=model_cache_root,
        )
    return payload
