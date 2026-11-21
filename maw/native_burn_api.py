"""Requests for Launcher-authorized native video destinations."""
from __future__ import annotations

import secrets
import subprocess
import threading
import time
from dataclasses import dataclass, replace
from http import HTTPStatus
from pathlib import Path

from maw.media_jobs import MediaJobCancelled, MediaJobUnavailable
from maw.native_burn_host import BURN_JOBS, BurnDialogBusy, BurnDialogUnavailable, BurnSessions, validate_suggested_name
from maw.native_burn_output import BurnDestination, PublishedBurn, open_burn_output

SESSION_HEADER = "X-MAW-Burn-Session"
SESSION_REQUIRED = "启动器编辑器会话无效，请从启动器重新打开"
TARGET_REQUIRED = "烧录保存位置已失效，请重新选择"
FILE_ERROR = "无法完成烧录文件操作，请检查保存位置权限或可用空间后重试"
OPEN_ERROR = "无法向系统发出打开请求，请从保存位置手动打开"
OPEN_EXPIRED = "打开操作已过期，请从保存位置手动打开"


@dataclass(frozen=True)
class NativeBurnTarget:
    session: str
    admission: str
    binding: tuple[int, str]
    destination: BurnDestination


class NativeBurnJobs:
    def __init__(self, sessions: BurnSessions):
        self.sessions = sessions
        self.targets: dict[str, tuple[float, NativeBurnTarget]] = {}

    # Callers hold the editor's settings_lock for both target operations.
    def remember(self, target: NativeBurnTarget) -> str:
        now = time.monotonic()
        self.targets = {key: record for key, record in self.targets.items() if record[0] > now}
        if len(self.targets) >= 128:
            raise ValueError(TARGET_REQUIRED)
        key = secrets.token_urlsafe(32)
        self.targets[key] = (now + 600, target)
        return key

    def require_target(self, request: dict, binding: tuple[int, str], source: Path) -> NativeBurnTarget:
        session = self.sessions.require(request.get("nativeSession"))
        key = request.get("nativeTarget")
        record = self.targets.get(key) if isinstance(key, str) else None
        if record is not None:
            expiry, target = record
            if (expiry > time.monotonic() and (target.session, target.admission, target.binding, target.destination.source)
                    == (session, request.get("admissionToken"), binding, source)):
                return target
        raise PermissionError(TARGET_REQUIRED)


def require_native_job_session(server, job, session: object) -> None:
    if job.native_burn is not None and (server.native_burn is None
            or server.native_burn.sessions.require(session) != job.native_burn.session):
        raise PermissionError(SESSION_REQUIRED)


def check_native_origin(handler) -> None:
    port = handler.editor_server.server_address[1]
    if (handler.headers.get("Host") != f"127.0.0.1:{port}"
            or handler.headers.get("Origin") != f"http://127.0.0.1:{port}"):
        raise PermissionError(SESSION_REQUIRED)


def native_host_proof(handler, *, include_body: bool) -> None:
    native = handler.editor_server.native_burn
    proof = native.sessions.host.editor_proof(handler.headers.get("X-MAW-Challenge")) if native else None
    if proof is None:
        handler.send_json(HTTPStatus.NOT_FOUND, {"ok": False}, include_body=include_body)
        return
    handler.send_response(HTTPStatus.OK)
    handler.send_header("X-MAW-Host-Proof", proof)
    handler.send_header("Content-Length", "0")
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()


def _binding(server) -> tuple[int, str]:
    return server.binding_generation, server.source_media_id


def _choose_target(server, native: NativeBurnJobs, request: dict) -> dict:
    session = native.sessions.require(request.get("nativeSession"))
    admission = request.get("admissionToken")
    server.media_jobs.validate_admission_token(admission)
    name = validate_suggested_name(request.get("suggestedName"))
    language = request.get("language", "zh")
    if language not in ("zh", "en"):
        raise ValueError("Invalid language")
    source = server.gap_removed_media_source_snapshot(request).path
    with server.settings_lock:
        server._check_project_binding_locked(request)
        protected = tuple(path for path in (server.project.json_path, server.project.media_path) if path)
    target = native.sessions.host.choose(name, source, language)
    if target is None:
        return {"cancelled": True}
    destination = replace(target, protected=protected)
    destination.validate()
    with server.settings_lock:
        native.sessions.require(session)
        server._check_project_binding_locked(request)
        key = native.remember(NativeBurnTarget(session, admission, _binding(server), destination))
    return {"nativeTarget": key, "name": destination.path.name}


def _require_job(server, job, request: dict) -> None:
    require_native_job_session(server, job, request.get("nativeSession"))
    if job.native_burn is None:
        raise MediaJobUnavailable(TARGET_REQUIRED)


def _check_save_binding(server, job) -> None:
    if job.binding != _binding(server):
        raise MediaJobUnavailable("工程或媒体绑定已变更，请重新发起视频烧录")


def _saved_result(output: PublishedBurn) -> dict:
    return {"name": output.path.name, **({"syncWarning": True} if output.sync_warning else {})}


def _save_output(server, job, request: dict) -> dict:
    manager = server.media_jobs
    save_done = threading.Event()
    with server.settings_lock:
        _require_job(server, job, request)
        if job.native_burn_output is not None:
            return _saved_result(job.native_burn_output)  # Retry a lost response.
        _check_save_binding(server, job)
        with manager.lock:
            manager.begin_download(job.id)
            job.native_burn_save_done = save_done
    committed = False
    try:
        with job.native_burn.destination.stage(job.output, job.check_cancelled) as staged:
            # Cancel and rebind serialize with publication. The copy holds
            # neither lock, so a stop during a large copy can still take effect.
            with server.settings_lock, manager.lock:
                _check_save_binding(server, job)
                job.check_cancelled()
                job.native_burn_output = staged.commit()
                committed = True
        return _saved_result(job.native_burn_output)
    finally:
        try:
            manager.finish_download(job, success=committed)
        finally:
            save_done.set()


def _open_output(server, job, request: dict) -> dict:
    folder = request.get("folder")
    if type(folder) is not bool:
        raise ValueError("打开操作无效")
    _require_job(server, job, request)
    output = job.native_burn_output
    if output is None:
        raise MediaJobUnavailable("烧录视频尚未保存")
    open_burn_output(output, folder=folder)
    return {"openRequested": True}


def handle_native_burn(handler, path: str) -> None:
    server = handler.editor_server
    native = server.native_burn
    opening = False
    try:
        check_native_origin(handler)
        if native is None:
            raise PermissionError(SESSION_REQUIRED)
        request = handler.read_json_request(max_bytes=4096)
        handler._check_request_token(request)
        parts = path.removeprefix(BURN_JOBS + "/").split("/")
        allowed = {"requestToken", "nativeSession"}
        if parts == ["native-session"] and request.keys() <= allowed | {"launchGrant"}:
            session = (native.sessions.redeem(request["launchGrant"]) if "launchGrant" in request
                       else native.sessions.require(request.get("nativeSession")))
            result = {"nativeSession": session}
        elif parts == ["native-target"] and request.keys() <= allowed | {
                "suggestedName", "admissionToken", "bindingGeneration", "sourceMediaId", "language"}:
            result = _choose_target(server, native, request)
        elif len(parts) == 2 and parts[1] in {"native-save", "native-open"}:
            opening = parts[1] == "native-open"
            if not request.keys() <= (allowed | {"folder"} if opening else allowed):
                raise ValueError("烧录保存和打开操作只接受任务句柄")
            native.sessions.require(request.get("nativeSession"))
            try:
                job = server.media_jobs.get(parts[0])
            except MediaJobUnavailable:
                if not opening:
                    raise
                handler.send_json(HTTPStatus.GONE, {"ok": False, "code": "burn_open_expired", "error": OPEN_EXPIRED})
                return
            result = _open_output(server, job, request) if opening else _save_output(server, job, request)
        else:
            raise ValueError("未知烧录保存操作")
        handler.send_json(HTTPStatus.OK, {"ok": True, **result})
    except PermissionError as error:
        status, message = (HTTPStatus.SERVICE_UNAVAILABLE, OPEN_ERROR if opening else FILE_ERROR) if error.errno is not None else (
            HTTPStatus.FORBIDDEN, str(error))
        handler.send_json(status, {"ok": False, "error": message}, close_connection=True)
    except (MediaJobUnavailable, MediaJobCancelled, BurnDialogBusy) as error:
        handler.send_json(HTTPStatus.CONFLICT, {"ok": False, "error": str(error)})
    except BurnDialogUnavailable as error:
        handler.send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"ok": False, "error": str(error)})
    except ValueError as error:
        handler.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(error)}, close_connection=True)
    except (OSError, subprocess.SubprocessError):
        handler.send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"ok": False, "error": OPEN_ERROR if opening else FILE_ERROR})
