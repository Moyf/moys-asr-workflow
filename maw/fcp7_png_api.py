"""Local editor transport for PNG/WebP rendering and atomic XML publication."""
from __future__ import annotations

import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from http import HTTPStatus
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

from maw.fcp7_png import prepare_render_plan, render_png_assets
from maw.media_jobs import MediaJobBusy, MediaJobCancelled, MediaJobUnavailable
from maw.gui_platform import restore_host_library_path

PREFIX = "/api/exports/fcp7-png/jobs"


def _choose_export_directory(initial: Path) -> Path | None:
    """Use the platform folder picker; the browser never supplies an arbitrary path."""
    env = restore_host_library_path(os.environ.copy())
    env["MAW_FCP7_PICKER_INITIAL"] = str(initial)
    if sys.platform == "win32":
        script = ("[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; "
                  "Add-Type -AssemblyName System.Windows.Forms; "
                  "$d = New-Object System.Windows.Forms.FolderBrowserDialog; "
                  "$d.SelectedPath = $env:MAW_FCP7_PICKER_INITIAL; "
                  "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { "
                  "[Console]::Write($d.SelectedPath) } else { exit 1 }; $d.Dispose()")
        command = ["powershell.exe", "-NoProfile", "-STA", "-NonInteractive", "-Command", script]
    elif sys.platform == "darwin":
        command = ["osascript", "-e", 'on run argv\nset selectedFolder to choose folder default location (POSIX file (item 1 of argv))\nreturn POSIX path of selectedFolder\nend run', str(initial)]
    else:
        if not shutil.which("zenity"):
            raise ValueError("无法打开文件夹选择窗口：请安装 zenity")
        command = ["zenity", "--file-selection", "--directory", "--filename", str(initial) + os.sep]
    result = subprocess.run(command, capture_output=True, env=env, encoding="utf-8", errors="replace",
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0)
    if result.returncode:
        if result.returncode == 1 or (sys.platform == "darwin" and "-128" in result.stderr):
            return None
        raise ValueError("无法打开文件夹选择窗口")
    selected = result.stdout.strip()
    return Path(selected).resolve(strict=True) if selected else None


def _open_export_folder(directory: Path) -> None:
    if sys.platform == "win32":
        os.startfile(str(directory))
    else:
        subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", str(directory)],
                         env=restore_host_library_path(os.environ.copy()))


def _file_path(value: str) -> str:
    url = urlsplit(value)
    if url.scheme != "file":
        raise ValueError("XML 媒体必须使用本地文件 URL")
    path = unquote(url.path) if url.netloc in ("", "localhost") else "//" + url.netloc + unquote(url.path)
    if os.name == "nt" and len(path) > 2 and path[0] == "/" and path[2] == ":":
        path = path[1:]
    return os.path.normcase(str(Path(path).resolve()))


def validate_package_xml(xml: str, manifest: dict) -> None:
    if not isinstance(xml, str) or not xml.strip() or len(xml.encode("utf-8")) > 32 * 1024 * 1024:
        raise ValueError("XML 内容为空或过大")
    if "<!ENTITY" in xml.upper() or "<!DOCTYPE" in xml and "<!DOCTYPE xmeml>" not in xml:
        raise ValueError("XML 不允许外部声明")
    # The only accepted declaration has no external or internal subset.
    text = xml.replace("<!DOCTYPE xmeml>", "")
    if "<!DOCTYPE" in text.upper():
        raise ValueError("XML 不允许外部声明")
    try:
        tree = ET.fromstring(text)
    except ET.ParseError as error:
        raise ValueError("XML 格式无效") from error
    if tree.tag != "xmeml" or tree.get("version") != "5":
        raise ValueError("需要 FCP 7 XML v5")
    images = {os.path.normcase(str(Path(c["path"]).resolve()))
              for t in manifest["tracks"] for c in t["clips"]}
    allowed = images | {os.path.normcase(str(Path(manifest["sourcePath"]).resolve()))}
    references = {_file_path(e.text or "") for e in tree.iter("pathurl")}
    if not images.issubset(references) or not references.issubset(allowed):
        raise ValueError("XML 图片引用与本次渲染结果不一致")


def vegas_package_xml(xml: str) -> str:
    """Derive the VEGAS 14 path variant after validating the standard XML.

    Its importer unescapes pathurl and passes it directly to File.Exists,
    without removing the file URI scheme. Keep a separate standard handoff.
    """
    tree = ET.fromstring(xml.replace("<!DOCTYPE xmeml>", ""))
    for element in tree.iter("pathurl"):
        path = Path(_file_path(element.text or "")).as_posix()
        element.text = quote(path, safe="/:")
    return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n' + ET.tostring(tree, encoding="unicode")


def handle_fcp7_png(handler, path: str, *, mutate=False, include_body=True, tools_factory):
    """Publish alongside the project or in a folder selected by the local user."""
    manager = handler.editor_server.media_jobs
    try:
        request = handler.read_json_request(max_bytes=36 * 1024 * 1024) if mutate else {
            "requestToken": handler.headers.get("X-MAW-Request-Token")}
        handler._check_request_token(request)
        if not include_body:
            handler.send_json(HTTPStatus.METHOD_NOT_ALLOWED, {"ok": False, "error": "请使用 GET 查询任务"})
            return
        if path == PREFIX + "/choose-directory" and mutate:
            handler.editor_server.gap_removed_media_source_snapshot(request)
            project = handler.editor_server.project
            if project.json_path is None:
                raise ValueError("请先保存工程文件，再导出图片字幕")
            binding = (request["bindingGeneration"], request["sourceMediaId"])
            selected = _choose_export_directory(project.json_path.parent)
            if selected is None:
                handler.send_json(HTTPStatus.OK, {"ok": True, "cancelled": True})
                return
            if not selected.is_dir():
                raise ValueError("所选位置不是文件夹")
            with handler.editor_server.settings_lock:
                if binding != (handler.editor_server.binding_generation, handler.editor_server.source_media_id):
                    raise MediaJobUnavailable("工程或媒体绑定已变更，请重新选择文件夹")
                token = secrets.token_urlsafe(24)
                handler.editor_server.fcp7_export_directory = (token, binding, selected)
            handler.send_json(HTTPStatus.OK, {"ok": True, "directoryToken": token, "directory": str(selected)})
            return
        if path == PREFIX and mutate:
            snapshot = handler.editor_server.gap_removed_media_source_snapshot(request)
            project = handler.editor_server.project
            if project.json_path is None:
                raise ValueError("请先保存工程文件，再导出图片字幕")
            plan = prepare_render_plan(request.get("ass"), fps=request.get("fps"),
                width=request.get("width"), height=request.get("height"),
                duration_ms=request.get("durationMs"), selected_layers=request.get("layers"),
                image_format=request.get("imageFormat", "png"))
            tools = tools_factory()
            if tools.ffmpeg is None or not handler.editor_server.ensure_libass_supported(tools.ffmpeg):
                raise ValueError("图片字幕导出需要带 libass 的 FFmpeg")
            binding = (request["bindingGeneration"], request["sourceMediaId"])
            directory_token = request.get("directoryToken")
            directory = project.json_path.parent
            if directory_token:
                with handler.editor_server.settings_lock:
                    selection = getattr(handler.editor_server, "fcp7_export_directory", None)
                    if not selection or selection[0] != directory_token or selection[1] != binding:
                        raise ValueError("导出文件夹选择已失效，请重新选择")
                    directory = selection[2]
                if not directory.is_dir():
                    raise ValueError("所选导出文件夹不存在，请重新选择")
            package = directory / f"{project.json_path.stem}_{plan['imageFormat']}_subtitles_{secrets.token_hex(4)}"
            def render(job):
                job.fcp7_png = True
                manifest = render_png_assets(job, plan, tools.ffmpeg, package)
                manifest["sourcePath"] = str(snapshot.path)
                manifest["sourceKind"] = snapshot.kind
                job.output.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8", newline="\n")
            with handler.editor_server.settings_lock:
                if binding != (handler.editor_server.binding_generation, handler.editor_server.source_media_id):
                    raise MediaJobUnavailable("工程或媒体绑定已变更，请重新导出")
                job = manager.start(snapshot.path, binding, [], render, output_extension=".json",
                                    admission_token=request.get("admissionToken"))
                job.fcp7_png = True
            handler.send_json(HTTPStatus.ACCEPTED, job.snapshot())
            return
        if path == PREFIX + "/cancel-admission" and mutate:
            handler.send_json(HTTPStatus.OK, manager.cancel_admission(request.get("admissionToken")))
            return
        parts = path.removeprefix(PREFIX + "/").split("/")
        if len(parts) not in (1, 2) or (len(parts) == 2 and parts[1] not in ("cancel", "publish", "open-folder")):
            raise ValueError("未知图片字幕任务操作")
        job = manager.get(parts[0])
        if not getattr(job, "fcp7_png", False):
            raise MediaJobUnavailable("图片字幕任务不存在")
        if mutate and len(parts) == 2 and parts[1] == "cancel":
            handler.send_json(HTTPStatus.OK, manager.cancel(job.id))
            return
        binding_request = {"bindingGeneration": job.binding[0], "sourceMediaId": job.binding[1]}
        handler.editor_server.gap_removed_media_source_snapshot(binding_request)
        if mutate and len(parts) == 2 and parts[1] == "open-folder":
            with manager.lock:
                package = getattr(job, "published_package", None)
                if job.state != "completed" or not isinstance(package, Path):
                    raise MediaJobUnavailable("导出文件夹不存在或任务尚未完成")
            if package.is_symlink() or not package.is_dir():
                raise ValueError("导出文件夹不存在或已被替换")
            _open_export_folder(package)
            handler.send_json(HTTPStatus.OK, {"ok": True})
            return
        if not mutate and len(parts) == 1:
            with manager.lock:
                payload = job.snapshot()
                if job.state == "ready":
                    payload["manifest"] = json.loads(job.output.read_text(encoding="utf-8"))
            handler.send_json(HTTPStatus.OK, payload)
            return
        if not mutate or len(parts) != 2 or parts[1] != "publish":
            raise ValueError("未知图片字幕任务操作")
        with manager.lock:
            if job.state != "ready":
                raise MediaJobUnavailable("图片字幕尚未就绪或已经停止")
            manifest = json.loads(job.output.read_text(encoding="utf-8"))
            validate_package_xml(request.get("xml"), manifest)
            manager.begin_download(job.id)
        published = False
        try:
            package = Path(manifest["packagePath"])
            with tempfile.TemporaryDirectory(prefix=".maw-png-", dir=package.parent) as temporary:
                staging = Path(temporary) / "package"
                staging.mkdir()
                images = staging / "images"
                images.mkdir()
                for source in (job.directory / "images").iterdir():
                    job.check_cancelled()
                    shutil.copy2(source, images / source.name)
                (staging / "subtitles.xml").write_text(request["xml"], encoding="utf-8", newline="\n")
                (staging / "subtitles-vegas.xml").write_text(vegas_package_xml(request["xml"]), encoding="utf-8", newline="\n")
                (staging / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8", newline="\n")
                with handler.editor_server.settings_lock, manager.lock:
                    if job.binding != (handler.editor_server.binding_generation, handler.editor_server.source_media_id):
                        raise MediaJobUnavailable("工程或媒体绑定已变更，请重新导出")
                    job.check_cancelled()
                    if package.exists():
                        raise ValueError("输出目录已存在，请重新导出")
                    os.rename(staging, package)
                    published = True
                    job.published_package = package
                    manager.finish_download(job, success=True)
            handler.send_json(HTTPStatus.OK, {"ok": True, "packagePath": str(package),
                "xmlPath": str(package / "subtitles.xml"), "vegasXmlPath": str(package / "subtitles-vegas.xml"),
                "imageCount": manifest["imageCount"],
                "clipCount": sum(len(t["clips"]) for t in manifest["tracks"]),
                "fontNotices": manifest.get("fontNotices", []),
                "cleanupComplete": job.disposed})
        finally:
            if not published:
                manager.finish_download(job, success=False)
    except PermissionError as error:
        handler.send_json(HTTPStatus.FORBIDDEN, {"ok": False, "error": str(error)})
    except (MediaJobBusy, MediaJobCancelled, MediaJobUnavailable) as error:
        handler.send_json(HTTPStatus.CONFLICT, {"ok": False, "error": str(error)})
    except RuntimeError as error:
        handler.send_json(HTTPStatus.CONFLICT, {"ok": False, "error": str(error)})
    except (ValueError, TypeError, UnicodeError) as error:
        handler.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(error)})
    except OSError as error:
        handler.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": "图片字幕文件操作失败", "errorDetails": str(error)[-1000:]})
