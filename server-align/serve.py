"""Start the MAW recording-alignment MVP server.

The server is intentionally separate from MAWE.  It previews script lines,
alternative recording blocks, and extra source ranges, then writes a new
MAWE-compatible project with disabled source cues and gap-remove decisions.
It does not rewrite the source media.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import tempfile
import webbrowser
from dataclasses import dataclass
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import NamedTuple
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in os.sys.path:
    os.sys.path.insert(0, str(ROOT))

from maw.postprocess_io import read_project  # noqa: E402
from maw.project import normalize_project  # noqa: E402
from maw.script_alignment import (  # noqa: E402
    align_project_to_script,
    apply_alignment_to_project,
    make_selection_manifest,
)


PAGE_PATH = Path(__file__).with_name("index.html")
GAP_REMOVE_CORE_PATH = ROOT / "web" / "gap-remove-core.js"
PAGE_CORE_PLACEHOLDER = "/* __GAP_REMOVE_CORE_JS__ */"
MAX_REQUEST_BYTES = 2 * 1024 * 1024


class ByteRange(NamedTuple):
    start: int
    end: int


@dataclass(frozen=True, slots=True)
class AlignmentState:
    project_path: Path
    script_path: Path
    media_path: Path | None
    project: dict[str, object]
    alignment: dict[str, object]

    def payload(self) -> dict[str, object]:
        media_kind = ""
        if self.media_path is not None:
            media_kind = "video" if self.media_path.suffix.lower() in {
                ".mp4", ".mkv", ".mov", ".webm", ".avi", ".m4v", ".flv", ".ts",
            } else "audio"
        return {
            "projectName": self.project_path.name,
            "scriptName": self.script_path.name,
            "media": {
                "available": self.media_path is not None,
                "name": self.media_path.name if self.media_path is not None else "",
                "kind": media_kind,
                "url": "/media" if self.media_path is not None else "",
            },
            "waveform": {
                "available": isinstance(self.project.get("waveform"), dict),
                "url": "/api/waveform" if isinstance(self.project.get("waveform"), dict) else "",
            },
            "alignment": self.alignment,
        }


class AlignmentServer(ThreadingHTTPServer):
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], state: AlignmentState) -> None:
        self.state = state
        super().__init__(address, AlignmentRequestHandler)


class AlignmentRequestHandler(BaseHTTPRequestHandler):
    server: AlignmentServer

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
        self.handle_request(include_body=True)

    def do_HEAD(self) -> None:  # noqa: N802 - stdlib handler API
        self.handle_request(include_body=False)

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        path = urlsplit(self.path).path
        if path == "/api/preview":
            try:
                request = self.read_json()
                selected = request.get("selectedByLine", {})
                extra_actions = request.get("extraActions", {})
                candidate_actions = request.get("candidateActions", {})
                gap_remove = request.get("gapRemove")
                if not isinstance(selected, dict):
                    raise ValueError("selectedByLine 必须是对象")
                if not isinstance(extra_actions, dict):
                    raise ValueError("extraActions 必须是对象")
                if not isinstance(candidate_actions, dict):
                    raise ValueError("candidateActions 必须是对象")
                if gap_remove is not None and not isinstance(gap_remove, dict):
                    raise ValueError("gapRemove 必须是对象")
                selection = make_selection_manifest(
                    self.server.state.alignment,
                    selected,
                    extra_actions=extra_actions,
                    candidate_actions=candidate_actions,
                )
                preview_project = apply_alignment_to_project(
                    self.server.state.project,
                    self.server.state.alignment,
                    selection,
                    gap_remove_override=gap_remove,
                )
                self.send_json(HTTPStatus.OK, {
                    "ok": True,
                    "selection": selection,
                    "gapRanges": preview_project.get("gap_remove", {}).get("gaps", []),
                    "gapRemove": preview_project.get("gap_remove", {}),
                })
            except (UnicodeDecodeError, json.JSONDecodeError, OSError, ValueError) as error:
                self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(error)})
            return
        if path != "/api/export":
            self.send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "未知接口"})
            return
        try:
            request = self.read_json()
            selected = request.get("selectedByLine", {})
            if not isinstance(selected, dict):
                raise ValueError("selectedByLine 必须是对象")
            extra_actions = request.get("extraActions", {})
            if not isinstance(extra_actions, dict):
                raise ValueError("extraActions 必须是对象")
            candidate_actions = request.get("candidateActions", {})
            gap_remove = request.get("gapRemove")
            if not isinstance(candidate_actions, dict):
                raise ValueError("candidateActions 必须是对象")
            if gap_remove is not None and not isinstance(gap_remove, dict):
                raise ValueError("gapRemove 必须是对象")
            selection = make_selection_manifest(
                self.server.state.alignment,
                selected,
                extra_actions=extra_actions,
                candidate_actions=candidate_actions,
            )
            output_project = apply_alignment_to_project(
                self.server.state.project,
                self.server.state.alignment,
                selection,
                gap_remove_override=gap_remove,
            )
            output_project["script_alignment"]["createdAt"] = datetime.now().astimezone().isoformat(timespec="seconds")
            output_project["script_alignment"]["sourceProjectPath"] = str(self.server.state.project_path)
            output_project["script_alignment"]["scriptPath"] = str(self.server.state.script_path)
            output_project = normalize_project(output_project)
            output_path = write_project(self.server.state.project_path, output_project)
        except (UnicodeDecodeError, json.JSONDecodeError, OSError, ValueError) as error:
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(error)})
            return
        self.send_json(HTTPStatus.OK, {
            "ok": True,
            "path": str(output_path),
            "selection": selection,
            "readyForMediaTrim": selection.get("readyForMediaTrim") is True,
        })

    def handle_request(self, *, include_body: bool) -> None:
        path = urlsplit(self.path).path
        if path == "/":
            try:
                body = render_page()
            except (OSError, ValueError) as error:
                self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": str(error)})
                return
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if include_body:
                self.wfile.write(body)
            return
        if path == "/api/state":
            self.send_json(HTTPStatus.OK, self.server.state.payload())
            return
        if path == "/api/waveform":
            waveform = self.server.state.project.get("waveform")
            if not isinstance(waveform, dict):
                self.send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "工程没有内嵌波形"})
                return
            self.send_json(HTTPStatus.OK, waveform)
            return
        if path == "/media":
            media_path = self.server.state.media_path
            if media_path is None:
                self.send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "没有可播放媒体"})
                return
            self.send_file(media_path, include_body=include_body)
            return
        self.send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "未知资源"})

    def read_json(self) -> dict[str, object]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ValueError("请求长度无效") from error
        if length <= 0 or length > MAX_REQUEST_BYTES:
            raise ValueError("请求内容为空或超过 2 MB")
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("请求内容必须是对象")
        return payload

    def send_json(self, status: HTTPStatus, payload: dict[str, object]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path: Path, *, include_body: bool) -> None:
        try:
            size = path.stat().st_size
            selected_range = parse_byte_range(self.headers.get("Range"), size)
        except (FileNotFoundError, OSError):
            self.send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "媒体文件不存在"})
            return
        except ValueError:
            self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
            self.send_header("Content-Range", f"bytes */{size}")
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
                return

    def log_message(self, format: str, *args: object) -> None:
        print(f"[http] {self.address_string()} - {format % args}")


def parse_byte_range(value: str | None, size: int) -> ByteRange | None:
    if not value:
        return None
    if size <= 0 or not value.startswith("bytes="):
        raise ValueError("unsupported range")
    spec = value[6:].strip()
    if not spec or "," in spec or "-" not in spec:
        raise ValueError("invalid range")
    start_text, end_text = (part.strip() for part in spec.split("-", 1))
    if not start_text:
        if not end_text.isdigit() or int(end_text) <= 0:
            raise ValueError("invalid suffix range")
        return ByteRange(max(0, size - int(end_text)), size - 1)
    if not start_text.isdigit() or (end_text and not end_text.isdigit()):
        raise ValueError("invalid range")
    start = int(start_text)
    if start >= size:
        raise ValueError("range starts after file")
    end = min(int(end_text), size - 1) if end_text else size - 1
    if end < start:
        raise ValueError("range end before start")
    return ByteRange(start, end)


def load_state(project_path: Path, script_path: Path, media_path: Path | None) -> AlignmentState:
    project = read_project(project_path)
    script = script_path.read_text(encoding="utf-8-sig")
    alignment = align_project_to_script(project, script)
    resolved_media = resolve_media_path(project_path, project, media_path)
    return AlignmentState(project_path.resolve(), script_path.resolve(), resolved_media, project, alignment)


def resolve_media_path(project_path: Path, project: dict[str, object], override: Path | None) -> Path | None:
    value = str(override or project.get("media") or "").strip()
    if not value:
        return None
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = project_path.parent / path
    resolved = path.resolve()
    return resolved if resolved.is_file() else None


def write_project(project_path: Path, payload: dict[str, object]) -> Path:
    directory = project_path.parent
    base = directory / f"{project_path.stem}.aligned.mosp"
    candidate = base
    counter = 2
    while candidate.exists():
        candidate = directory / f"{project_path.stem}.aligned-{counter}.mosp"
        counter += 1
    text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{candidate.name}.", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
        os.replace(temporary_name, candidate)
    except Exception:
        Path(temporary_name).unlink(missing_ok=True)
        raise
    return candidate.resolve()


def render_page() -> bytes:
    """Inline the shared gap-remove core into the standalone alignment page."""
    page = PAGE_PATH.read_text(encoding="utf-8")
    core = GAP_REMOVE_CORE_PATH.read_text(encoding="utf-8").rstrip()
    if page.count(PAGE_CORE_PLACEHOLDER) != 1:
        raise ValueError("对齐页面缺少唯一的 Gap Core 注入占位符")
    return page.replace(PAGE_CORE_PLACEHOLDER, core).encode("utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="启动 MAW 文稿对齐 MVP Server（仅本机访问）")
    parser.add_argument("project_path", help="MAW .mosp/.json 工程")
    parser.add_argument("script_path", help="UTF-8 文稿，每个非空行视为一行文稿")
    parser.add_argument("-m", "--media", help="覆盖工程中的媒体路径")
    parser.add_argument("-p", "--port", type=int, default=8260, help="监听端口（默认 8260，0=自动选择）")
    parser.add_argument("--no-open", action="store_true", help="只启动服务，不自动打开浏览器")
    args = parser.parse_args()

    project_path = Path(args.project_path).expanduser().resolve()
    script_path = Path(args.script_path).expanduser().resolve()
    if not project_path.is_file():
        parser.error(f"工程文件不存在：{project_path}")
    if not script_path.is_file():
        parser.error(f"文稿文件不存在：{script_path}")
    try:
        state = load_state(project_path, script_path, Path(args.media).expanduser() if args.media else None)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        parser.error(str(error))

    with AlignmentServer(("127.0.0.1", args.port), state) as server:
        host, port = server.server_address[:2]
        url = f"http://{host}:{port}/"
        print("MAW 文稿对齐 MVP Server 已启动（仅本机可访问）")
        print(f"工程: {project_path}")
        print(f"文稿: {script_path}")
        print(f"地址: {url}")
        if not args.no_open:
            webbrowser.open(url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nMAW 文稿对齐 MVP Server 已停止")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
