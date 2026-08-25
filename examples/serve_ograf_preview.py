"""Serve the local dynamic-graphic browser preview without modifying examples.

Run from the MAW repository root:

    py examples\\serve_ograf_preview.py

The script discovers *.lottie, *.ograf.zip, or an already extracted .ograf.json/.mjs
pair, stages them in a temporary directory, serves the preview page over HTTP, and
opens the page in the default browser. Only 127.0.0.1 is used.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import socket
import stat
import tempfile
import threading
import webbrowser
import zipfile
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
EXAMPLES_DIR = SCRIPT_DIR
PREVIEW_PAGE = EXAMPLES_DIR / "preview.html"


def safe_slug(value: str, fallback: str = "graphic") -> str:
    """Convert a local filename into a stable, harmless staging directory name."""
    slug = re.sub(r"[^0-9A-Za-z._-]+", "-", value).strip("-._")
    return slug or fallback


def zip_member_path(name: str) -> tuple[str, ...]:
    normalized = name.replace("\\", "/")
    path = PurePosixPath(normalized)
    if not normalized or path.is_absolute() or ".." in path.parts:
        raise ValueError(f"压缩包包含不安全路径：{name}")
    return path.parts


def extract_zip_safely(archive_path: Path, target: Path) -> None:
    """Extract a preview package while rejecting traversal and symlink entries."""
    target_root = target.resolve()
    with zipfile.ZipFile(archive_path) as archive:
        for member in archive.infolist():
            parts = zip_member_path(member.filename)
            if not parts:
                continue
            destination = (target / Path(*parts)).resolve()
            if destination != target_root and target_root not in destination.parents:
                raise ValueError(f"压缩包包含越界路径：{member.filename}")
            mode = (member.external_attr >> 16) & 0o170000
            if stat.S_ISLNK(mode):
                raise ValueError(f"压缩包包含不支持的符号链接：{member.filename}")
            if member.is_dir():
                destination.mkdir(parents=True, exist_ok=True)
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(member) as source, destination.open("wb") as output:
                shutil.copyfileobj(source, output)


def relative_main_path(manifest_path: Path, package_root: Path, manifest: dict[str, Any]) -> Path:
    main = manifest.get("main")
    if not isinstance(main, str) or not main.strip():
        raise ValueError("manifest 缺少 main")
    main_parts = zip_member_path(main)
    main_path = (manifest_path.parent / Path(*main_parts)).resolve()
    root = package_root.resolve()
    if main_path != root and root not in main_path.parents:
        raise ValueError("manifest 的 main 指向包外文件")
    if not main_path.is_file():
        raise ValueError(f"找不到 manifest 的主脚本：{main}")
    return main_path


def inspect_package(package_root: Path, source_name: str) -> dict[str, Any]:
    manifests = sorted(package_root.rglob("*.ograf.json"))
    if len(manifests) != 1:
        raise ValueError(f"应当找到一个 .ograf.json，实际找到 {len(manifests)} 个")
    manifest_path = manifests[0]
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"无法读取 manifest：{error}") from error
    if not isinstance(manifest, dict):
        raise ValueError("manifest 必须是 JSON 对象")
    relative_main_path(manifest_path, package_root, manifest)
    return {
        "type": "ograf",
        "name": str(manifest.get("name") or source_name),
        "source": source_name,
        "manifest": manifest_path.relative_to(package_root).as_posix(),
        "id": str(manifest.get("id") or ""),
    }


def stage_zip(archive_path: Path, graphics_root: Path, ordinal: int) -> dict[str, Any]:
    package_root = graphics_root / f"zip-{ordinal:03d}-{safe_slug(archive_path.stem)}"
    package_root.mkdir(parents=True, exist_ok=True)
    extract_zip_safely(archive_path, package_root)
    package = inspect_package(package_root, archive_path.name)
    package["manifest"] = f"graphics/{package_root.relative_to(graphics_root).as_posix()}/{package['manifest']}"
    return package


def stage_direct_pair(manifest_path: Path, graphics_root: Path, ordinal: int) -> dict[str, Any]:
    package_root = graphics_root / f"file-{ordinal:03d}-{safe_slug(manifest_path.stem)}"
    package_root.mkdir(parents=True, exist_ok=True)
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"无法读取 manifest：{error}") from error
    if not isinstance(manifest, dict):
        raise ValueError("manifest 必须是 JSON 对象")
    main_path = relative_main_path(manifest_path, manifest_path.parent, manifest)
    main_relative = Path(*zip_member_path(str(manifest.get("main"))))
    staged_manifest = package_root / manifest_path.name
    staged_main = package_root / main_relative
    staged_manifest.write_text(
        json.dumps(manifest, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    staged_main.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(main_path, staged_main)
    package = inspect_package(package_root, manifest_path.name)
    package["manifest"] = f"graphics/{package_root.relative_to(graphics_root).as_posix()}/{package['manifest']}"
    return package


def stage_lottie(archive_path: Path, graphics_root: Path, ordinal: int) -> dict[str, Any]:
    """Stage a dotLottie archive for the browser player."""
    if archive_path.stat().st_size > 32 * 1024 * 1024:
        raise ValueError("Lottie 文件不能超过 32 MB")
    with zipfile.ZipFile(archive_path) as archive:
        if "manifest.json" not in archive.namelist():
            raise ValueError("Lottie 文件缺少 manifest.json")
    package_root = graphics_root / f"lottie-{ordinal:03d}-{safe_slug(archive_path.stem)}"
    package_root.mkdir(parents=True, exist_ok=True)
    staged_name = f"{safe_slug(archive_path.stem)}.lottie"
    shutil.copy2(archive_path, package_root / staged_name)
    return {
        "type": "lottie",
        "name": archive_path.stem,
        "source": archive_path.name,
        "src": f"graphics/{package_root.relative_to(graphics_root).as_posix()}/{staged_name}",
    }


def build_runtime(root: Path) -> tuple[tempfile.TemporaryDirectory[str], Path]:
    runtime = tempfile.TemporaryDirectory(prefix="maw-ograf-preview-")
    runtime_root = Path(runtime.name)
    shutil.copy2(PREVIEW_PAGE, runtime_root / "preview.html")
    graphics_root = runtime_root / "graphics"
    graphics_root.mkdir()

    packages: list[dict[str, Any]] = []
    warnings: list[str] = []
    package_ordinal = 0
    for archive_path in sorted(EXAMPLES_DIR.rglob("*.ograf.zip")):
        package_ordinal += 1
        try:
            packages.append(stage_zip(archive_path, graphics_root, package_ordinal))
        except (OSError, ValueError, zipfile.BadZipFile) as error:
            warnings.append(f"跳过 {archive_path.name}：{error}")

    for manifest_path in sorted(EXAMPLES_DIR.rglob("*.ograf.json")):
        package_ordinal += 1
        try:
            packages.append(stage_direct_pair(manifest_path, graphics_root, package_ordinal))
        except (OSError, ValueError) as error:
            warnings.append(f"跳过 {manifest_path.name}：{error}")

    for archive_path in sorted(EXAMPLES_DIR.rglob("*.lottie")):
        package_ordinal += 1
        try:
            packages.append(stage_lottie(archive_path, graphics_root, package_ordinal))
        except (OSError, ValueError, zipfile.BadZipFile) as error:
            warnings.append(f"跳过 {archive_path.name}：{error}")

    index = {"packages": packages, "warnings": warnings}
    (runtime_root / "ograf-index.json").write_text(
        json.dumps(index, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    return runtime, runtime_root


class PreviewHandler(SimpleHTTPRequestHandler):
    """Add stable MIME types for browser ES modules on Windows."""

    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".html": "text/html; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".lottie": "application/zip+dotlottie",
    }


class PreviewServer(ThreadingHTTPServer):
    """Do not let Windows route a new preview server onto an old listener."""

    allow_reuse_address = False

    def server_bind(self) -> None:
        exclusive_option = getattr(socket, "SO_EXCLUSIVEADDRUSE", None)
        if exclusive_option is not None:
            self.socket.setsockopt(socket.SOL_SOCKET, exclusive_option, 1)
        super().server_bind()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="启动 MAW 动态图形浏览器预览")
    parser.add_argument(
        "--port",
        type=int,
        default=8765,
        help="首选本地端口，默认 8765；不可用时自动向后寻找端口",
    )
    parser.add_argument("--no-open", action="store_true", help="不自动打开浏览器")
    return parser.parse_args()


def create_server(handler: Any, preferred_port: int) -> tuple[PreviewServer, int]:
    """Bind the preferred port, then a small local range when Windows rejects it."""
    last_error: OSError | None = None
    last_port = min(65535, preferred_port + 32)
    for port in range(preferred_port, last_port + 1):
        try:
            return PreviewServer(("127.0.0.1", port), handler), port
        except OSError as error:
            last_error = error
    raise OSError(
        f"无法监听 127.0.0.1:{preferred_port}，已尝试到 {last_port}"
    ) from last_error


def main() -> int:
    args = parse_args()
    if not PREVIEW_PAGE.is_file():
        raise SystemExit(f"找不到预览页：{PREVIEW_PAGE}")
    if not 1 <= args.port <= 65535:
        raise SystemExit("端口必须在 1 到 65535 之间")

    runtime, runtime_root = build_runtime(EXAMPLES_DIR)
    handler = partial(PreviewHandler, directory=str(runtime_root))
    try:
        server, port = create_server(handler, args.port)
    except OSError as error:
        runtime.cleanup()
        raise SystemExit(f"OGraf 预览服务器启动失败：{error}") from error

    url = f"http://127.0.0.1:{port}/preview.html"
    index = json.loads((runtime_root / "ograf-index.json").read_text(encoding="utf-8"))
    if port != args.port:
        print(f"首选端口 {args.port} 不可用，已改用 127.0.0.1:{port}。")
    print(f"动态图形预览：{url}")
    print(f"已发现 {len(index.get('packages', []))} 个动态图形包；按 Ctrl+C 停止。")
    for warning in index.get("warnings", []):
        print(f"警告：{warning}")

    if not args.no_open:
        threading.Timer(0.2, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止 OGraf 预览服务器。")
    finally:
        server.server_close()
        runtime.cleanup()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
