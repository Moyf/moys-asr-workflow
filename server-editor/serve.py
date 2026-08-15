"""MAWE 的本地 HTTP 字幕编辑器。

与 edit.py 生成的 file:// 自包含 HTML 共用 web/ 下的同一份模板、样式和脚本，
但通过 localhost 提供媒体的 HTTP Range 响应，方便浏览器调试和精确 seek。
"""

from __future__ import annotations

import argparse
import copy
import html
import json
import mimetypes
import os
import struct
import sys
import tempfile
import threading
import webbrowser
from dataclasses import dataclass, field, replace
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import NamedTuple
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

NINJA_SFX_ROOT = ROOT / "web" / "sfx"
NINJA_SFX_NAMES = frozenset(
    f"sfx_katana_slash_{index:02d}.{extension}"
    for index in range(1, 5)
    for extension in ("ogg", "opus")
)
mimetypes.add_type("audio/ogg", ".opus")

import edit  # noqa: E402
import reapeaks  # noqa: E402
from maw.gui_config import DEFAULT_ENV_PATH, load_env  # noqa: E402
from maw.project import (  # noqa: E402
    ProjectValidationFailed,
    normalize_project,
    repair_project_timing_ranges,
)
from maw.media import MEDIA_EXTENSIONS, MediaConversionError, MediaResolutionError, MediaStatus, convert_media_for_browser, resolve_project_media  # noqa: E402


MAX_RECENT_PROJECTS = 10
SETTINGS_FILE_NAME = "server-editor-settings.json"
BUILTIN_WORKSPACE_IDS = frozenset({"classic", "wave-right", "three-fold", "cinema"})


class ByteRange(NamedTuple):
    start: int
    end: int


@dataclass(frozen=True)
class ServerProject:
    data: dict
    json_path: Path | None
    media_path: Path | None
    sticker_root: Path | None
    stickers: list[dict]
    source_media_path: Path | None = None
    reapeaks_path: Path | None = None


@dataclass(frozen=True)
class RecentProject:
    """A project explicitly opened by the local editor; never a scanned file."""

    path: Path
    name: str

    def to_json(self) -> dict[str, object]:
        payload: dict[str, object] = {"path": str(self.path), "name": self.name}
        if not self.path.is_file():
            payload["exists"] = False
        return payload


@dataclass(frozen=True)
class ServerSettings:
    auto_open_last_project: bool = True
    recent_projects: tuple[RecentProject, ...] = field(default_factory=tuple)
    saved_workspaces: dict[str, dict[str, object]] = field(default_factory=dict)
    preset_workspaces: dict[str, dict[str, object]] = field(default_factory=dict)
    active_workspace_name: str = ""


class SaveProjectError(ValueError):
    """A client attempted a save outside the server's explicit project scope."""


class RecentProjectError(ValueError):
    """A client attempted to open a project that was not explicitly remembered."""


class AttachProjectError(ValueError):
    """A browser-opened project could not be bound to its on-disk file."""


def default_settings_path() -> Path:
    """Return a per-user app-data path, outside the project and browser storage."""
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    return base / "Moy" / "moys-asr-workflow" / SETTINGS_FILE_NAME


def read_server_settings(path: Path) -> ServerSettings:
    """Read tolerant local settings; malformed or missing files reset to safe defaults."""
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return ServerSettings()
    if not isinstance(payload, dict):
        return ServerSettings()

    projects: list[RecentProject] = []
    seen: set[Path] = set()
    values = payload.get("recent_projects", [])
    if isinstance(values, list):
        for value in values:
            if not isinstance(value, dict) or not isinstance(value.get("path"), str):
                continue
            try:
                project_path = Path(value["path"]).expanduser().resolve()
            except OSError:
                continue
            if project_path in seen:
                continue
            seen.add(project_path)
            name = value.get("name")
            projects.append(RecentProject(
                path=project_path,
                name=name if isinstance(name, str) and name else project_path.name,
            ))
            if len(projects) == MAX_RECENT_PROJECTS:
                break
    saved_workspaces: dict[str, dict[str, object]] = {}
    raw_workspaces = payload.get("saved_workspaces", {})
    if isinstance(raw_workspaces, dict):
        for name, workspace in raw_workspaces.items():
            if isinstance(name, str) and 1 <= len(name) <= 60 and isinstance(workspace, dict):
                saved_workspaces[name] = copy.deepcopy(workspace)
    preset_workspaces: dict[str, dict[str, object]] = {}
    raw_preset_workspaces = payload.get("preset_workspaces", {})
    if isinstance(raw_preset_workspaces, dict):
        for name, workspace in raw_preset_workspaces.items():
            if name in BUILTIN_WORKSPACE_IDS and isinstance(workspace, dict):
                preset_workspaces[name] = copy.deepcopy(workspace)
    active_workspace_name = payload.get("active_workspace_name")
    return ServerSettings(
        auto_open_last_project=payload.get("auto_open_last_project") is not False,
        recent_projects=tuple(projects),
        saved_workspaces=saved_workspaces,
        preset_workspaces=preset_workspaces,
        active_workspace_name=active_workspace_name if active_workspace_name in saved_workspaces else "",
    )


def write_server_settings(path: Path, settings: ServerSettings) -> None:
    """Atomically persist the local list with LF line endings."""
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": 1,
        "auto_open_last_project": settings.auto_open_last_project,
        "recent_projects": [project.to_json() for project in settings.recent_projects],
        "saved_workspaces": settings.saved_workspaces,
        "preset_workspaces": settings.preset_workspaces,
        "active_workspace_name": settings.active_workspace_name,
    }
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.stem}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as output:
            json.dump(payload, output, ensure_ascii=False, indent=2)
            output.write("\n")
        os.replace(temp_name, path)
    except Exception:
        # 保留未完成的临时文件以便排障；不要静默删除用户可恢复的文件。
        raise


def remember_project(settings: ServerSettings, project_path: Path) -> ServerSettings:
    """Move one explicitly opened project to the front, retaining only ten entries."""
    resolved = project_path.expanduser().resolve()
    recent = [RecentProject(resolved, resolved.name)]
    recent.extend(item for item in settings.recent_projects if item.path != resolved)
    return replace(settings, recent_projects=tuple(recent[:MAX_RECENT_PROJECTS]))


def parse_byte_range(value: str | None, size: int) -> ByteRange | None:
    """Parse one RFC 7233 bytes range; raise ValueError for an invalid range."""
    if not value:
        return None
    if size <= 0 or not value.startswith("bytes="):
        raise ValueError("unsupported range")
    spec = value[6:].strip()
    if not spec or "," in spec or "-" not in spec:
        raise ValueError("invalid range")
    start_text, end_text = (part.strip() for part in spec.split("-", 1))
    if not start_text:
        if not end_text or not end_text.isdigit():
            raise ValueError("invalid suffix range")
        length = int(end_text)
        if length <= 0:
            raise ValueError("invalid suffix length")
        return ByteRange(max(0, size - length), size - 1)
    if not start_text.isdigit() or (end_text and not end_text.isdigit()):
        raise ValueError("invalid range")
    start = int(start_text)
    if start >= size:
        raise ValueError("range starts after file")
    end = min(int(end_text), size - 1) if end_text else size - 1
    if end < start:
        raise ValueError("range end before start")
    return ByteRange(start, end)


def resolve_media_path(json_path: Path, data: dict, explicit_media: str | None) -> Path:
    resolution = resolve_project_media(json_path, data, explicit_media)
    if not resolution.loadable:
        raise MediaResolutionError(resolution)
    assert resolution.resolved_path is not None
    return resolution.resolved_path


def load_project(
    json_path: Path,
    explicit_media: str | None,
    stickers_dir: str | None,
    *,
    no_waveform: bool,
    load_reapeaks: bool = True,
    peaks_per_second: int,
) -> ServerProject:
    json_path = json_path.resolve()
    if not json_path.exists():
        raise FileNotFoundError(f"JSON 文件不存在 - {json_path}")
    raw_data = json.loads(json_path.read_text(encoding="utf-8"))
    # 兜底：上游（或旧版工具）可能写入 0 长/倒挂的段、词时间码，
    # 加载时先拉齐到至少 100ms，避免编辑器里出现看不见的字幕块、保存被校验拒绝。
    repaired_count = repair_project_timing_ranges(raw_data)
    if repaired_count:
        print(f"[project] 已兜底修复 {repaired_count} 处异常时间码（保底 100ms）")
    data = normalize_project(raw_data)

    resolution = resolve_project_media(json_path, data, explicit_media)
    if not resolution.loadable:
        raise MediaResolutionError(resolution)
    assert resolution.resolved_path is not None
    source_media_path = resolution.resolved_path
    media_path = source_media_path
    if resolution.status is MediaStatus.CONVERSION_NEEDED:
        print("[media] flv 无法预览，将会自动转换成 mp4 格式")
        configured_ffmpeg = os.environ.get("FFMPEG_PATH") or load_env(DEFAULT_ENV_PATH).get("FFMPEG_PATH", "")
        try:
            media_path = convert_media_for_browser(source_media_path, ffmpeg_path=configured_ffmpeg)
        except MediaConversionError as error:
            raise MediaConversionError(f"{error}（源文件：{source_media_path}）") from error
        print(f"[media] 已为浏览器准备播放缓存: {media_path}")
    # 保存时应沿用实际被服务器加载的媒体；这也会把 -m 覆盖的路径同步回工程。
    data["media"] = str(source_media_path)
    # .ReaPeaks 是转写时对"工程 media 字段原始文件"生成的；转换场景下
    # resolved_path 可能已被 _paired_mp4 升级为配对的 mp4，必须用原始
    # 请求路径（requested_path）查找，否则会漏读源媒体旁的缓存。
    reapeaks_base = resolution.requested_path or source_media_path
    if not no_waveform:
        try:
            waveform, extracted = edit.load_or_extract_waveform(
                data.get("waveform"), media_path, peaks_per_second=peaks_per_second,
            )
            data["waveform"] = waveform
            state = "已提取" if extracted else "使用缓存"
            print(f"[waveform] {state}: {waveform['peak_count']} peaks ({waveform['peaks_per_second']}/秒)")
        except (edit.WaveformError, ValueError) as error:
            data.pop("waveform", None)
            print(f"[waveform] 警告: {error}；编辑器仍可正常使用")

        if load_reapeaks:
            # 频谱缓存：源媒体旁存在 .ReaPeaks 时读取并内联下发，供波形染色。
            # 缺失/损坏/无 spectral 层一律静默降级，不影响编辑器。
            spectral = reapeaks.load_spectral_payload(reapeaks_base, peaks_per_second=peaks_per_second)
            if spectral is not None:
                data["spectral"] = spectral
                print(f"[spectral] 已加载 {spectral['peak_count']} 频谱点 (div={spectral['division']})")

            # ReaPeaks 波形层：最细 wave 层作为可选的波形形状来源（编辑器设置里切换）。
            reapeaks_wave = reapeaks.load_waveform_payload(reapeaks_base)
            if reapeaks_wave is not None:
                data["waveform_reapeaks"] = reapeaks_wave
                print(
                    f"[reapeaks-wave] 已加载 {reapeaks_wave['peak_count']} peaks "
                    f"({reapeaks_wave['peaks_per_second']}/秒)"
                )

    source = stickers_dir or edit.get_default_sticker_dir()
    sticker_root = Path(source).resolve() if source else None
    root_text, stickers = edit.scan_stickers(sticker_root) if sticker_root else ("", [])
    return ServerProject(
        data,
        json_path,
        media_path,
        Path(root_text) if root_text else None,
        stickers,
        source_media_path=source_media_path,
        reapeaks_path=reapeaks_base,
    )


def load_blank_project(stickers_dir: str | None) -> ServerProject:
    source = stickers_dir or edit.get_default_sticker_dir()
    sticker_root = Path(source).resolve() if source else None
    root_text, stickers = edit.scan_stickers(sticker_root) if sticker_root else ("", [])
    return ServerProject(
        {"segments": [], "media": "", "language": "", "model": ""},
        None,
        None,
        Path(root_text) if root_text else None,
        stickers,
        reapeaks_path=None,
    )


def without_deferred_reapeaks(project: ServerProject) -> ServerProject:
    """Keep the self-generated waveform while omitting optional ReaPeaks layers.

    ReaPeaks can contain millions of decoded points.  The editor must be able
    to render the project before those optional layers are parsed; they are
    fetched from ``/api/waveform`` after the server starts listening.
    """
    data = dict(project.data)
    data.pop("spectral", None)
    data.pop("waveform_reapeaks", None)
    return replace(project, data=data)


def build_server_page(project: ServerProject, settings: ServerSettings | None = None) -> bytes:
    """Render with current web/ assets on every page request to prevent UI drift."""
    settings = settings or ServerSettings()
    if project.media_path:
        media_html = edit.media_tag(project.media_path, "/media")
        source_media = project.source_media_path or project.media_path
        title = html.escape(f"MAWE（本地服务器）- {source_media.name}")
        filename_base = project.json_path.stem if project.json_path else source_media.stem
        json_display = project.json_path.name if project.json_path else "未加载工程"
        media_display = source_media.name
        media_title = f"点击复制媒体名：{source_media.name}"
        json_class = "" if project.json_path else "empty"
        media_class = ""
    else:
        media_html = '<audio id="player" preload="metadata" style="width:100%;display:block;"></audio>'
        title = html.escape("MAWE（本地服务器）- 用「打开工程」加载 JSON")
        filename_base = "untitled"
        json_display = "未加载工程"
        media_display = "未加载媒体"
        media_title = ""
        json_class = "empty"
        media_class = "empty"

    page_data = copy.deepcopy(project.data)
    project_workspace = page_data.get("workspace")
    project_selected_workspace = project_workspace.get("selectedPreset") if isinstance(project_workspace, dict) else None
    active_workspace = settings.saved_workspaces.get(settings.active_workspace_name)
    if active_workspace is not None and not project_selected_workspace:
        page_data["workspace"] = copy.deepcopy(active_workspace)
        page_data["workspace"]["selectedPreset"] = f"saved:{settings.active_workspace_name}"
    page = edit.render_editor_page(
        title=title,
        media_html=media_html,
        data_json=json.dumps(page_data, ensure_ascii=False),
        filename_base_json=json.dumps(filename_base, ensure_ascii=False),
        stickers_json=json.dumps(project.stickers, ensure_ascii=False),
        sticker_root_json=json.dumps(project.sticker_root.as_posix() if project.sticker_root else "", ensure_ascii=False),
        sticker_url_prefix_json=json.dumps("/stickers", ensure_ascii=False),
        ninja_sfx_base_url_json=json.dumps("/sfx/", ensure_ascii=False),
        server_config_json=json.dumps({
            "saveUrl": "/api/project",
            "waveformUrl": "/api/waveform",
            "canSave": project.json_path is not None,
            "autoLoadedMediaName": (project.source_media_path or project.media_path).name if project.media_path else None,
            "recentProjectsUrl": "/api/recent-projects/open",
            "attachUrl": "/api/project/attach",
            "settingsUrl": "/api/settings",
            "recentProjects": [item.to_json() for item in settings.recent_projects],
            "autoOpenLastProject": settings.auto_open_last_project,
            "savedWorkspaces": settings.saved_workspaces,
            "presetWorkspaces": settings.preset_workspaces,
            "activeWorkspaceName": settings.active_workspace_name,
        }, ensure_ascii=False),
        app_version=html.escape(f"v{edit.get_app_version()}"),
        json_display=html.escape(json_display),
        json_name_class=json_class,
        media_name_display=html.escape(media_display),
        media_name_title=html.escape(media_title),
        media_name_class=media_class,
    )
    return page.encode("utf-8")


class EditorServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(
        self,
        address: tuple[str, int],
        project: ServerProject,
        *,
        settings: ServerSettings | None = None,
        settings_path: Path | None = None,
        stickers_dir: str | None = None,
        no_waveform: bool = False,
        defer_reapeaks: bool = True,
        peaks_per_second: int = edit.DEFAULT_PEAKS_PER_SECOND,
    ):
        self.defer_reapeaks = defer_reapeaks and not no_waveform
        if self.defer_reapeaks:
            project = without_deferred_reapeaks(project)
        self.project = project
        self.settings = settings or ServerSettings()
        self.settings_path = settings_path
        self.stickers_dir = stickers_dir
        self.no_waveform = no_waveform
        self.peaks_per_second = peaks_per_second
        self.save_lock = threading.Lock()
        self.settings_lock = threading.Lock()
        self.reapeaks_lock = threading.Lock()
        self.reapeaks_generation = 0
        self.reapeaks_status = "pending" if self.defer_reapeaks else "disabled"
        self.reapeaks_payload: dict[str, dict] = {}
        self.reapeaks_thread: threading.Thread | None = None
        self.reapeaks_project: ServerProject | None = None
        super().__init__(address, EditorRequestHandler)

    def persist_settings(self) -> None:
        if self.settings_path:
            write_server_settings(self.settings_path, self.settings)

    def persist_settings_async(self) -> None:
        """Persist startup settings without delaying the listening server."""
        if not self.settings_path:
            return
        settings = self.settings
        path = self.settings_path

        def persist() -> None:
            try:
                write_server_settings(path, settings)
            except OSError as error:
                print(f"[settings] 后台保存失败: {error}", file=sys.stderr)

        threading.Thread(target=persist, daemon=True, name="maw-save-settings").start()

    def start_deferred_reapeaks_load(self) -> None:
        """Load optional ReaPeaks layers after the HTTP server is available."""
        if not self.defer_reapeaks:
            return
        with self.reapeaks_lock:
            project = self.project
            if self.reapeaks_project is project:
                return
            self.reapeaks_generation += 1
            generation = self.reapeaks_generation
            self.reapeaks_project = project
            self.reapeaks_status = "loading"
            self.reapeaks_payload = {}
        thread = threading.Thread(
            target=self._load_deferred_reapeaks,
            args=(project, generation),
            daemon=True,
            name="maw-load-reapeaks",
        )
        self.reapeaks_thread = thread
        thread.start()

    def _load_deferred_reapeaks(self, project: ServerProject, generation: int) -> None:
        spectral = None
        reapeaks_wave = None
        try:
            reapeaks_base = project.reapeaks_path or project.source_media_path or project.media_path
            if reapeaks_base is not None:
                spectral = reapeaks.load_spectral_payload(
                    reapeaks_base, peaks_per_second=self.peaks_per_second,
                )
                if spectral is not None:
                    print(f"[spectral] 后台加载 {spectral['peak_count']} 频谱点 (div={spectral['division']})")
                reapeaks_wave = reapeaks.load_waveform_payload(reapeaks_base)
                if reapeaks_wave is not None:
                    print(
                        f"[reapeaks-wave] 后台加载 {reapeaks_wave['peak_count']} peaks "
                        f"({reapeaks_wave['peaks_per_second']}/秒)"
                    )
        except (OSError, ValueError, IndexError, struct.error) as error:
            print(f"[reapeaks] 后台加载失败: {error}", file=sys.stderr)

        with self.reapeaks_lock:
            if generation != self.reapeaks_generation:
                return
            current_project = self.project
            data = dict(current_project.data)
            if spectral is None:
                data.pop("spectral", None)
            else:
                data["spectral"] = spectral
            if reapeaks_wave is None:
                data.pop("waveform_reapeaks", None)
            else:
                data["waveform_reapeaks"] = reapeaks_wave
            self.project = replace(current_project, data=data)
            self.reapeaks_payload = {
                key: value for key, value in {
                    "spectral": spectral,
                    "waveform_reapeaks": reapeaks_wave,
                }.items() if value is not None
            }
            self.reapeaks_status = "ready"

    def serve_forever(self, poll_interval: float = 0.5) -> None:
        """Start optional cache loading immediately before serving requests."""
        self.start_deferred_reapeaks_load()
        super().serve_forever(poll_interval)

    def reapeaks_status_payload(self) -> dict[str, object]:
        with self.reapeaks_lock:
            return {
                "ok": True,
                "status": self.reapeaks_status,
                **self.reapeaks_payload,
            }

    def remember_project(self, project_path: Path) -> None:
        with self.settings_lock:
            self.settings = remember_project(self.settings, project_path)
            self.persist_settings()

    def set_auto_open_last_project(self, enabled: bool) -> None:
        with self.settings_lock:
            self.settings = replace(self.settings, auto_open_last_project=enabled)
            self.persist_settings()

    def save_workspace(self, name: str, workspace: dict[str, object], *, overwrite: bool) -> None:
        with self.settings_lock:
            workspaces = copy.deepcopy(self.settings.saved_workspaces)
            if name in workspaces and not overwrite:
                raise ValueError("同名工作区已存在")
            if name not in workspaces and len(workspaces) >= 20:
                raise ValueError("最多保存 20 个自定义工作区")
            workspaces[name] = copy.deepcopy(workspace)
            self.settings = replace(self.settings, saved_workspaces=workspaces, active_workspace_name=name)
            self.persist_settings()

    def delete_workspace(self, name: str) -> None:
        with self.settings_lock:
            workspaces = copy.deepcopy(self.settings.saved_workspaces)
            if name not in workspaces:
                raise ValueError("工作区不存在")
            del workspaces[name]
            self.settings = replace(
                self.settings,
                saved_workspaces=workspaces,
                active_workspace_name="" if self.settings.active_workspace_name == name else self.settings.active_workspace_name,
            )
            self.persist_settings()

    def save_preset_workspace(self, preset: str, workspace: dict[str, object]) -> None:
        if preset not in BUILTIN_WORKSPACE_IDS:
            raise ValueError("不是可保存的内置工作区")
        with self.settings_lock:
            workspaces = copy.deepcopy(self.settings.preset_workspaces)
            workspaces[preset] = copy.deepcopy(workspace)
            self.settings = replace(self.settings, preset_workspaces=workspaces, active_workspace_name="")
            self.persist_settings()

    def reset_preset_workspace(self, preset: str) -> None:
        if preset not in BUILTIN_WORKSPACE_IDS:
            raise ValueError("不是可重置的内置工作区")
        with self.settings_lock:
            workspaces = copy.deepcopy(self.settings.preset_workspaces)
            workspaces.pop(preset, None)
            self.settings = replace(self.settings, preset_workspaces=workspaces, active_workspace_name="")
            self.persist_settings()

    def set_active_workspace(self, name: str) -> None:
        with self.settings_lock:
            if name and name not in self.settings.saved_workspaces:
                raise ValueError("工作区不存在")
            self.settings = replace(self.settings, active_workspace_name=name)
            self.persist_settings()

    def open_recent_project(self, project_path: str) -> ServerProject:
        candidate = Path(project_path).expanduser().resolve()
        with self.settings_lock:
            known = next((item for item in self.settings.recent_projects if item.path == candidate), None)
            if not known:
                raise RecentProjectError("该工程不在本机最近打开记录中")
            project = load_project(
                known.path,
                None,
                self.stickers_dir,
                no_waveform=self.no_waveform,
                load_reapeaks=not self.defer_reapeaks,
                peaks_per_second=self.peaks_per_second,
            )
            if self.defer_reapeaks:
                project = without_deferred_reapeaks(project)
            self.project = project
            self.settings = remember_project(self.settings, project.json_path)
            self.persist_settings()
            self.start_deferred_reapeaks_load()
            return project

    def attach_project(self, file_name: str, browser_project: dict) -> ServerProject:
        """Bind a project opened through the browser to its on-disk file.

        Browser file pickers never reveal real paths, but a MAW project records
        its media as an absolute path. When the same-named project file sits next
        to that media and its segments match the browser copy, the server takes
        over: media auto-loads and Ctrl+S saves back to the project file.
        """
        candidate = Path(file_name)
        if (
            not file_name
            or candidate.name != file_name
            or candidate.suffix.lower() not in {".json", ".mosp"}
            or file_name in {".", ".."}
        ):
            raise AttachProjectError("工程文件名不正确")
        media_value = browser_project.get("media")
        if not isinstance(media_value, str) or not media_value.strip():
            raise AttachProjectError("工程没有记录媒体路径，无法由服务器接管")
        media_path = Path(media_value).expanduser()
        if not media_path.is_absolute():
            raise AttachProjectError("工程记录的媒体路径不是绝对路径，无法由服务器接管")
        try:
            media_path = media_path.resolve(strict=True)
        except OSError:
            raise AttachProjectError("工程记录的媒体文件不存在或已移动")
        if media_path.suffix.lower() not in MEDIA_EXTENSIONS:
            raise AttachProjectError("工程记录的媒体不是可识别的音视频文件")
        project_path = media_path.parent / candidate.name
        if not project_path.is_file():
            raise AttachProjectError("媒体同目录下没有同名工程文件，无法绑定保存")

        # 防止同目录同名旧文件掉包：段落内容与浏览器打开的副本一致才接管。
        browser_data = copy.deepcopy(browser_project)
        repair_project_timing_ranges(browser_data)
        try:
            normalized_browser = normalize_project(browser_data)
        except ProjectValidationFailed as error:
            raise AttachProjectError(f"打开的工程内容无效：{error}") from error
        project = load_project(
            project_path,
            None,
            self.stickers_dir,
            no_waveform=self.no_waveform,
            load_reapeaks=not self.defer_reapeaks,
            peaks_per_second=self.peaks_per_second,
        )
        if self.defer_reapeaks:
            project = without_deferred_reapeaks(project)
        if project.data.get("segments") != normalized_browser.get("segments"):
            raise AttachProjectError("媒体同目录的同名工程与打开的副本内容不一致，未接管")
        with self.settings_lock:
            self.project = project
            self.settings = remember_project(self.settings, project.json_path)
            self.persist_settings()
        self.start_deferred_reapeaks_load()
        return project

    def save_project(self, project_data: dict, filename: str | None = None) -> tuple[Path, Path | None]:
        if not self.project.json_path:
            raise SaveProjectError("当前服务器没有绑定工程文件；请先导出 .mosp 工程，再重新打开该文件")
        try:
            repaired_project = copy.deepcopy(project_data)
            # 保存时只自动修复字/词级取整冲突；真正的字幕段重叠仍交给严格校验，
            # 避免把用户有意或误操作造成的段落重叠静默改写。
            repair_project_timing_ranges(repaired_project, repair_segment_ranges=False)
            normalized_project = normalize_project(repaired_project)
        except ProjectValidationFailed as error:
            raise SaveProjectError(str(error)) from error

        target = self.project.json_path
        if filename is not None:
            target = safe_project_filename(target.parent, filename)
        with self.save_lock:
            backup = write_project_json(target, normalized_project)
            self.project = replace(self.project, data=normalized_project, json_path=target)
            self.remember_project(target)
        return target, backup


def safe_project_filename(directory: Path, filename: str) -> Path:
    candidate = Path(filename)
    if (
        not filename
        or candidate.name != filename
        or candidate.suffix.lower() not in {".json", ".mosp"}
        or filename in {".", ".."}
    ):
        raise SaveProjectError("另存为只能使用当前工程目录内的 .mosp 或 .json 文件名")
    return directory / candidate.name


def write_project_json(target: Path, project_data: dict) -> Path | None:
    """Atomically write LF JSON and retain the immediately previous file as .bak."""
    target.parent.mkdir(parents=True, exist_ok=True)
    backup = target.with_suffix(f"{target.suffix}.bak") if target.exists() else None
    if backup:
        backup.write_bytes(target.read_bytes())
    fd, temp_name = tempfile.mkstemp(prefix=f".{target.stem}.", suffix=".tmp", dir=target.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as output:
            json.dump(project_data, output, ensure_ascii=False, indent=2)
            output.write("\n")
        os.replace(temp_name, target)
    except Exception:
        # 保留未完成的临时文件以便排障；不要静默删除用户可恢复的文件。
        raise
    return backup


class EditorRequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    @property
    def editor_server(self) -> EditorServer:
        return self.server  # type: ignore[return-value]

    def do_GET(self) -> None:  # noqa: N802
        self.handle_request(include_body=True)

    def do_HEAD(self) -> None:  # noqa: N802
        self.handle_request(include_body=False)

    def do_POST(self) -> None:  # noqa: N802
        path = urlsplit(self.path).path
        if path == "/api/shutdown":
            self.shutdown_server()
        elif path == "/api/project":
            self.save_project()
        elif path == "/api/project/attach":
            self.attach_project()
        elif path == "/api/recent-projects/open":
            self.open_recent_project()
        elif path == "/api/settings":
            self.update_settings()
        else:
            self.send_localized_error(HTTPStatus.NOT_FOUND, "未知 API")

    def send_localized_error(self, status: HTTPStatus, detail: str) -> None:
        """Send a localized error body without putting non-Latin-1 text in the status line."""
        super().send_error(status, status.phrase, detail)

    def shutdown_server(self) -> None:
        """Stop this loopback-only server from the MAW CLI."""
        self.send_json(HTTPStatus.OK, {"ok": True, "service": "maw-editor"})
        threading.Thread(target=self.editor_server.shutdown, daemon=True).start()

    def save_project(self) -> None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 64 * 1024 * 1024:
                raise SaveProjectError("保存内容为空或超过 64 MB")
            request = json.loads(self.rfile.read(length).decode("utf-8"))
            filename = request.get("filename")
            if filename is not None and not isinstance(filename, str):
                raise SaveProjectError("文件名格式不正确")
            target, backup = self.editor_server.save_project(request.get("project"), filename)
        except (UnicodeDecodeError, json.JSONDecodeError, SaveProjectError) as error:
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(error)})
            return
        except OSError as error:
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": f"写入失败：{error}"})
            return
        self.send_json(HTTPStatus.OK, {
            "ok": True,
            "filename": target.name,
            "backup": backup.name if backup else None,
        })

    def read_json_request(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > 64 * 1024 * 1024:
            raise ValueError("请求内容为空或超过 64 MB")
        request = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(request, dict):
            raise ValueError("请求内容必须是对象")
        return request

    def open_recent_project(self) -> None:
        try:
            request = self.read_json_request()
            project_path = request.get("path")
            if not isinstance(project_path, str) or not project_path:
                raise RecentProjectError("工程路径格式不正确")
            project = self.editor_server.open_recent_project(project_path)
        except FileNotFoundError as error:
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(error), "missing": True})
            return
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError, RecentProjectError) as error:
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(error)})
            return
        except OSError as error:
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": f"加载工程失败：{error}"})
            return
        self.send_json(HTTPStatus.OK, {
            "ok": True,
            "name": project.json_path.name if project.json_path else "",
            "mediaName": (project.source_media_path or project.media_path).name if project.media_path else "",
        })

    def attach_project(self) -> None:
        try:
            request = self.read_json_request()
            file_name = request.get("fileName")
            if not isinstance(file_name, str) or not file_name:
                raise AttachProjectError("工程文件名格式不正确")
            project_data = request.get("project")
            if not isinstance(project_data, dict):
                raise AttachProjectError("工程内容必须是对象")
            project = self.editor_server.attach_project(file_name, project_data)
        except (UnicodeDecodeError, json.JSONDecodeError, FileNotFoundError, ValueError) as error:
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(error)})
            return
        except OSError as error:
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": f"接管工程失败：{error}"})
            return
        self.send_json(HTTPStatus.OK, {
            "ok": True,
            "name": project.json_path.name if project.json_path else "",
            "mediaName": (project.source_media_path or project.media_path).name if project.media_path else "",
        })

    def update_settings(self) -> None:
        try:
            request = self.read_json_request()
            applied = self._apply_settings_request(request)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError, OSError) as error:
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(error)})
            return
        if not applied:
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "缺少可更新的设置"})
            return
        settings = self.editor_server.settings
        self.send_json(HTTPStatus.OK, {
            "ok": True,
            "autoOpenLastProject": settings.auto_open_last_project,
            "savedWorkspaces": settings.saved_workspaces,
            "presetWorkspaces": settings.preset_workspaces,
            "activeWorkspaceName": settings.active_workspace_name,
        })

    def _apply_settings_request(self, request: dict[str, object]) -> bool:
        """Apply at most one settings action; returns False when nothing was requested."""
        enabled = request.get("autoOpenLastProject")
        if enabled is not None:
            if not isinstance(enabled, bool):
                raise ValueError("autoOpenLastProject 必须是布尔值")
            self.editor_server.set_auto_open_last_project(enabled)
            return True
        save_workspace = request.get("saveWorkspace")
        if save_workspace is not None:
            if not isinstance(save_workspace, dict):
                raise ValueError("saveWorkspace 必须是对象")
            name = save_workspace.get("name")
            workspace = save_workspace.get("workspace")
            if not isinstance(name, str) or not (1 <= len(name.strip()) <= 60) or not isinstance(workspace, dict):
                raise ValueError("工作区名称或内容不正确")
            if len(json.dumps(workspace, ensure_ascii=False)) > 256 * 1024:
                raise ValueError("工作区不能超过 256 KB")
            self.editor_server.save_workspace(name.strip(), workspace, overwrite=save_workspace.get("overwrite") is True)
            return True
        save_preset = request.get("savePresetWorkspace")
        if save_preset is not None:
            if not isinstance(save_preset, dict):
                raise ValueError("savePresetWorkspace 必须是对象")
            preset = save_preset.get("preset")
            workspace = save_preset.get("workspace")
            if not isinstance(preset, str) or not isinstance(workspace, dict):
                raise ValueError("内置工作区名称或内容不正确")
            if len(json.dumps(workspace, ensure_ascii=False)) > 256 * 1024:
                raise ValueError("工作区不能超过 256 KB")
            self.editor_server.save_preset_workspace(preset, workspace)
            return True
        delete_workspace_name = request.get("deleteWorkspaceName")
        if delete_workspace_name is not None:
            if not isinstance(delete_workspace_name, str):
                raise ValueError("deleteWorkspaceName 必须是字符串")
            self.editor_server.delete_workspace(delete_workspace_name)
            return True
        reset_preset = request.get("resetPresetWorkspace")
        if reset_preset is not None:
            if not isinstance(reset_preset, str):
                raise ValueError("resetPresetWorkspace 必须是字符串")
            self.editor_server.reset_preset_workspace(reset_preset)
            return True
        active_workspace_name = request.get("activeWorkspaceName")
        if active_workspace_name is not None:
            if not isinstance(active_workspace_name, str):
                raise ValueError("activeWorkspaceName 必须是字符串")
            self.editor_server.set_active_workspace(active_workspace_name)
            return True
        return False

    def handle_request(self, *, include_body: bool) -> None:
        path = urlsplit(self.path).path
        if path == "/api/waveform":
            self.send_json(HTTPStatus.OK, self.editor_server.reapeaks_status_payload())
            return
        if path == "/":
            page = build_server_page(self.editor_server.project, self.editor_server.settings)
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(page)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if include_body:
                self.wfile.write(page)
            return
        if path == "/media":
            media_path = self.editor_server.project.media_path
            if media_path:
                self.send_file(media_path, include_body)
            else:
                self.send_localized_error(HTTPStatus.NOT_FOUND, "没有预加载媒体")
            return
        if path.startswith("/sfx/"):
            sfx_path = self.ninja_sfx_path(path[len("/sfx/"):])
            if sfx_path:
                self.send_file(sfx_path, include_body)
            else:
                self.send_localized_error(HTTPStatus.NOT_FOUND, "刀光音效不存在")
            return
        if path.startswith("/stickers/"):
            sticker_path = self.sticker_path(path[len("/stickers/"):])
            if sticker_path:
                self.send_file(sticker_path, include_body)
            else:
                self.send_localized_error(HTTPStatus.NOT_FOUND, "表情包不存在")
            return
        if path == "/favicon.ico":
            self.send_response(HTTPStatus.NO_CONTENT)
            self.end_headers()
            return
        self.send_localized_error(HTTPStatus.NOT_FOUND, "未知资源")

    def send_json(self, status: HTTPStatus, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def sticker_path(self, relative_url: str) -> Path | None:
        root = self.editor_server.project.sticker_root
        if not root:
            return None
        candidate = (root / unquote(relative_url)).resolve()
        try:
            candidate.relative_to(root)
        except ValueError:
            return None
        return candidate if candidate.is_file() else None

    def ninja_sfx_path(self, relative_url: str) -> Path | None:
        """Resolve one bundled slash sound without exposing arbitrary project files."""
        root = NINJA_SFX_ROOT.resolve()
        candidate = (root / unquote(relative_url)).resolve()
        try:
            candidate.relative_to(root)
        except ValueError:
            return None
        if candidate.name not in NINJA_SFX_NAMES:
            return None
        return candidate if candidate.is_file() else None

    def send_file(self, path: Path, include_body: bool) -> None:
        try:
            size = path.stat().st_size
            selected_range = parse_byte_range(self.headers.get("Range"), size)
        except FileNotFoundError:
            self.send_localized_error(HTTPStatus.NOT_FOUND, "文件不存在")
            return
        except ValueError:
            self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
            self.send_header("Content-Range", f"bytes */{path.stat().st_size}")
            self.end_headers()
            return

        start, end = selected_range if selected_range else (0, size - 1)
        length = end - start + 1
        self.send_response(HTTPStatus.PARTIAL_CONTENT if selected_range else HTTPStatus.OK)
        self.send_header("Content-Type", mimetypes.guess_type(path.name)[0] or "application/octet-stream")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if selected_range:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if not include_body:
            return
        with path.open("rb") as media_file:
            media_file.seek(start)
            remaining = length
            try:
                while remaining:
                    chunk = media_file.read(min(128 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
            except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
                # Browser media elements commonly cancel an old Range request while seeking.
                return

    def log_message(self, format: str, *args: object) -> None:
        print(f"[http] {self.address_string()} - {format % args}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="启动 MAWE localhost 编辑器（与自包含 HTML 共用 web/ 源码，支持媒体 Range seek）",
    )
    parser.add_argument("json_path", nargs="?", help="字幕工程 JSON；省略时默认尝试恢复上次打开的工程")
    parser.add_argument("-m", "--media", help="媒体文件路径（默认按 JSON.media / 同目录探测）")
    parser.add_argument("-s", "--stickers", help="表情包目录（默认读取 .env 的 STICKER_DIR）")
    parser.add_argument("--blank", action="store_true", help="启动空白编辑器，之后在页面中选择 JSON 与媒体")
    parser.add_argument("--port", type=int, default=8250, help="监听端口（默认 8250，0=自动选择）")
    parser.add_argument("--no-open", action="store_true", help="只启动服务，不自动打开浏览器")
    parser.add_argument("--no-waveform", action="store_true", help="跳过 ffmpeg 波形预计算")
    parser.add_argument(
        "--waveform-peaks-per-second", type=int, default=edit.DEFAULT_PEAKS_PER_SECOND,
        help=f"波形峰值密度（默认: {edit.DEFAULT_PEAKS_PER_SECOND}/秒）",
    )
    args = parser.parse_args()
    if args.blank and args.json_path:
        parser.error("--blank 不能与 json_path 同时使用")

    settings_path = default_settings_path()
    settings = read_server_settings(settings_path)
    defer_reapeaks = not args.no_waveform
    startup_settings_dirty = False

    try:
        if args.blank:
            project = load_blank_project(args.stickers)
        elif args.json_path:
            project = load_project(
                Path(args.json_path), args.media, args.stickers,
                no_waveform=args.no_waveform,
                load_reapeaks=not defer_reapeaks,
                peaks_per_second=args.waveform_peaks_per_second,
            )
            if defer_reapeaks:
                project = without_deferred_reapeaks(project)
            settings = remember_project(settings, project.json_path)
            startup_settings_dirty = True
        elif settings.auto_open_last_project and settings.recent_projects:
            last_project = settings.recent_projects[0]
            try:
                project = load_project(
                    last_project.path, None, args.stickers,
                    no_waveform=args.no_waveform,
                    load_reapeaks=not defer_reapeaks,
                    peaks_per_second=args.waveform_peaks_per_second,
                )
                if defer_reapeaks:
                    project = without_deferred_reapeaks(project)
            except (FileNotFoundError, ValueError, json.JSONDecodeError) as error:
                print(f"无法恢复上次打开的工程：{error}；已启动空白编辑器", file=sys.stderr)
                project = load_blank_project(args.stickers)
            else:
                settings = remember_project(settings, project.json_path)
                startup_settings_dirty = True
                print(f"已恢复上次打开的工程: {project.json_path}")
        else:
            project = load_blank_project(args.stickers)
    except (FileNotFoundError, ValueError, json.JSONDecodeError) as error:
        parser.error(str(error))

    with EditorServer(
        ("127.0.0.1", args.port),
        project,
        settings=settings,
        settings_path=settings_path,
        stickers_dir=args.stickers,
        no_waveform=args.no_waveform,
        defer_reapeaks=defer_reapeaks,
        peaks_per_second=args.waveform_peaks_per_second,
    ) as server:
        host, port = server.server_address[:2]
        url = f"http://{host}:{port}/"
        if startup_settings_dirty:
            server.persist_settings_async()
        print("MAWE 已启动（仅本机可访问）")
        print(f"地址: {url}")
        print("按 Ctrl+C 停止服务；修改 web/ 下源码后刷新页面即可看到最新界面。")
        if not args.no_open:
            webbrowser.open(url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nMAWE 已停止")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
