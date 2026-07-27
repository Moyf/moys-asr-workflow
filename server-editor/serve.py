"""MAWE 的本地 HTTP 字幕编辑器。

与 edit.py 生成的 file:// 自包含 HTML 共用 web/ 下的同一份模板、样式和脚本，
但通过 localhost 提供媒体的 HTTP Range 响应，方便浏览器调试和精确 seek。
"""

from __future__ import annotations

import argparse
import html
import json
import mimetypes
import os
import sys
import tempfile
import threading
import webbrowser
from dataclasses import dataclass, field, replace
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import NamedTuple
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import edit  # noqa: E402
from maw.project import ProjectValidationFailed, normalize_project  # noqa: E402


MAX_RECENT_PROJECTS = 10
SETTINGS_FILE_NAME = "server-editor-settings.json"


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


@dataclass(frozen=True)
class RecentProject:
    """A project explicitly opened by the local editor; never a scanned file."""

    path: Path
    name: str

    def to_json(self) -> dict[str, str]:
        return {"path": str(self.path), "name": self.name}


@dataclass(frozen=True)
class ServerSettings:
    auto_open_last_project: bool = True
    recent_projects: tuple[RecentProject, ...] = field(default_factory=tuple)


class SaveProjectError(ValueError):
    """A client attempted a save outside the server's explicit project scope."""


class RecentProjectError(ValueError):
    """A client attempted to open a project that was not explicitly remembered."""


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
    return ServerSettings(
        auto_open_last_project=payload.get("auto_open_last_project") is not False,
        recent_projects=tuple(projects),
    )


def write_server_settings(path: Path, settings: ServerSettings) -> None:
    """Atomically persist the local list with LF line endings."""
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": 1,
        "auto_open_last_project": settings.auto_open_last_project,
        "recent_projects": [project.to_json() for project in settings.recent_projects],
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
    if explicit_media:
        candidate = Path(explicit_media).resolve()
        if candidate.exists():
            return candidate
    elif data.get("media"):
        candidate = Path(str(data["media"]))
        if candidate.exists():
            return candidate.resolve()

    stem = json_path.stem.split(".")[0]
    for extension in [*sorted(edit.VIDEO_EXTS), *sorted(edit.AUDIO_EXTS)]:
        candidate = json_path.parent / f"{stem}{extension}"
        if candidate.exists():
            return candidate.resolve()
    raise FileNotFoundError("找不到媒体文件，请用 -m 参数指定")


def load_project(
    json_path: Path,
    explicit_media: str | None,
    stickers_dir: str | None,
    *,
    no_waveform: bool,
    peaks_per_second: int,
) -> ServerProject:
    json_path = json_path.resolve()
    if not json_path.exists():
        raise FileNotFoundError(f"JSON 文件不存在 - {json_path}")
    data = normalize_project(json.loads(json_path.read_text(encoding="utf-8")))

    media_path = resolve_media_path(json_path, data, explicit_media)
    # 保存时应沿用实际被服务器加载的媒体；这也会把 -m 覆盖的路径同步回工程。
    data["media"] = str(media_path)
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

    source = stickers_dir or edit.get_default_sticker_dir()
    sticker_root = Path(source).resolve() if source else None
    root_text, stickers = edit.scan_stickers(sticker_root) if sticker_root else ("", [])
    return ServerProject(data, json_path, media_path, Path(root_text) if root_text else None, stickers)


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
    )


def build_server_page(project: ServerProject, settings: ServerSettings | None = None) -> bytes:
    """Render with current web/ assets on every page request to prevent UI drift."""
    settings = settings or ServerSettings()
    generated_at = datetime.now().strftime("%Y-%m-%d %H:%M")
    if project.media_path:
        media_html = edit.media_tag(project.media_path, "/media")
        title = html.escape(f"MAWE（本地服务器）- {project.media_path.name}")
        filename_base = project.json_path.stem if project.json_path else project.media_path.stem
        json_display = project.json_path.name if project.json_path else "未加载工程"
        media_display = project.media_path.name
        media_title = f"点击复制媒体名：{project.media_path.name}"
        json_class = "" if project.json_path else "empty"
        media_class = ""
    else:
        media_html = '<audio id="player" controls preload="metadata" style="width:100%;display:block;"></audio>'
        title = html.escape("MAWE（本地服务器）- 用「打开工程」加载 JSON")
        filename_base = "untitled"
        json_display = "未加载工程"
        media_display = "未加载媒体"
        media_title = ""
        json_class = "empty"
        media_class = "empty"

    page = edit.render_editor_page(
        title=title,
        media_html=media_html,
        data_json=json.dumps(project.data, ensure_ascii=False),
        filename_base_json=json.dumps(filename_base, ensure_ascii=False),
        stickers_json=json.dumps(project.stickers, ensure_ascii=False),
        sticker_root_json=json.dumps(project.sticker_root.as_posix() if project.sticker_root else "", ensure_ascii=False),
        sticker_url_prefix_json=json.dumps("/stickers", ensure_ascii=False),
        server_config_json=json.dumps({
            "saveUrl": "/api/project",
            "canSave": project.json_path is not None,
            "autoLoadedMediaName": project.media_path.name if project.media_path else None,
            "recentProjectsUrl": "/api/recent-projects/open",
            "settingsUrl": "/api/settings",
            "recentProjects": [item.to_json() for item in settings.recent_projects],
            "autoOpenLastProject": settings.auto_open_last_project,
        }, ensure_ascii=False),
        generated_at=html.escape(generated_at),
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
        peaks_per_second: int = edit.DEFAULT_PEAKS_PER_SECOND,
    ):
        self.project = project
        self.settings = settings or ServerSettings()
        self.settings_path = settings_path
        self.stickers_dir = stickers_dir
        self.no_waveform = no_waveform
        self.peaks_per_second = peaks_per_second
        self.save_lock = threading.Lock()
        self.settings_lock = threading.Lock()
        super().__init__(address, EditorRequestHandler)

    def persist_settings(self) -> None:
        if self.settings_path:
            write_server_settings(self.settings_path, self.settings)

    def remember_project(self, project_path: Path) -> None:
        with self.settings_lock:
            self.settings = remember_project(self.settings, project_path)
            self.persist_settings()

    def set_auto_open_last_project(self, enabled: bool) -> None:
        with self.settings_lock:
            self.settings = replace(self.settings, auto_open_last_project=enabled)
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
                peaks_per_second=self.peaks_per_second,
            )
            self.project = project
            self.settings = remember_project(self.settings, project.json_path)
            self.persist_settings()
            return project

    def save_project(self, project_data: dict, filename: str | None = None) -> tuple[Path, Path | None]:
        if not self.project.json_path:
            raise SaveProjectError("空白服务器没有绑定工程路径；请使用“导出工程”")
        try:
            normalized_project = normalize_project(project_data)
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
        or candidate.suffix.lower() != ".json"
        or filename in {".", ".."}
    ):
        raise SaveProjectError("另存为只能使用当前工程目录内的 .json 文件名")
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
        if path == "/api/project":
            self.save_project()
        elif path == "/api/recent-projects/open":
            self.open_recent_project()
        elif path == "/api/settings":
            self.update_settings()
        else:
            self.send_error(HTTPStatus.NOT_FOUND, "未知 API")

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
        except (UnicodeDecodeError, json.JSONDecodeError, FileNotFoundError, ValueError, RecentProjectError) as error:
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(error)})
            return
        except OSError as error:
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": f"加载工程失败：{error}"})
            return
        self.send_json(HTTPStatus.OK, {
            "ok": True,
            "name": project.json_path.name if project.json_path else "",
            "mediaName": project.media_path.name if project.media_path else "",
        })

    def update_settings(self) -> None:
        try:
            request = self.read_json_request()
            enabled = request.get("autoOpenLastProject")
            if not isinstance(enabled, bool):
                raise ValueError("autoOpenLastProject 必须是布尔值")
            self.editor_server.set_auto_open_last_project(enabled)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError, OSError) as error:
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(error)})
            return
        self.send_json(HTTPStatus.OK, {"ok": True, "autoOpenLastProject": enabled})

    def handle_request(self, *, include_body: bool) -> None:
        path = urlsplit(self.path).path
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
                self.send_error(HTTPStatus.NOT_FOUND, "没有预加载媒体")
            return
        if path.startswith("/stickers/"):
            sticker_path = self.sticker_path(path[len("/stickers/"):])
            if sticker_path:
                self.send_file(sticker_path, include_body)
            else:
                self.send_error(HTTPStatus.NOT_FOUND, "表情包不存在")
            return
        if path == "/favicon.ico":
            self.send_response(HTTPStatus.NO_CONTENT)
            self.end_headers()
            return
        self.send_error(HTTPStatus.NOT_FOUND, "未知资源")

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

    def send_file(self, path: Path, include_body: bool) -> None:
        try:
            size = path.stat().st_size
            selected_range = parse_byte_range(self.headers.get("Range"), size)
        except FileNotFoundError:
            self.send_error(HTTPStatus.NOT_FOUND, "文件不存在")
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
            while remaining:
                chunk = media_file.read(min(128 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

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
    parser.add_argument("--port", type=int, default=8765, help="监听端口（默认 8765，0=自动选择）")
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

    try:
        if args.blank:
            project = load_blank_project(args.stickers)
        elif args.json_path:
            project = load_project(
                Path(args.json_path), args.media, args.stickers,
                no_waveform=args.no_waveform,
                peaks_per_second=args.waveform_peaks_per_second,
            )
            settings = remember_project(settings, project.json_path)
            write_server_settings(settings_path, settings)
        elif settings.auto_open_last_project and settings.recent_projects:
            last_project = settings.recent_projects[0]
            try:
                project = load_project(
                    last_project.path, None, args.stickers,
                    no_waveform=args.no_waveform,
                    peaks_per_second=args.waveform_peaks_per_second,
                )
            except (FileNotFoundError, ValueError, json.JSONDecodeError) as error:
                print(f"无法恢复上次打开的工程：{error}；已启动空白编辑器", file=sys.stderr)
                project = load_blank_project(args.stickers)
            else:
                settings = remember_project(settings, project.json_path)
                write_server_settings(settings_path, settings)
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
        peaks_per_second=args.waveform_peaks_per_second,
    ) as server:
        host, port = server.server_address[:2]
        url = f"http://{host}:{port}/"
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
