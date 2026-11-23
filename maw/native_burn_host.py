"""Launcher-owned save dialog and per-launch editor session authentication."""
from __future__ import annotations

import hashlib
import hmac
import http.client
import json
import re
import secrets
import threading
import time
from collections.abc import Callable, MutableMapping
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from maw.native_burn_output import BurnDestination

HOST_ENV = "_MAW_NATIVE_BURN_HOST"
BURN_JOBS = "/api/exports/burned-video/jobs"
GRANT_SECONDS = 120
MAX_MESSAGE = 65536
_TOKEN = re.compile(r"[0-9a-f]{64}")


class BurnDialogUnavailable(RuntimeError):
    pass


class BurnDialogBusy(BurnDialogUnavailable):
    pass


def _sign(key: str, domain: str, data: bytes) -> str:
    return hmac.new(key.encode("ascii"), domain.encode("ascii") + b"\0" + data, hashlib.sha256).hexdigest()


def _valid_signature(key: str, domain: str, data: bytes, value: object) -> bool:
    return isinstance(value, str) and _TOKEN.fullmatch(value) is not None and hmac.compare_digest(
        _sign(key, domain, data), value)


def _json(data: object) -> bytes:
    return json.dumps(data, ensure_ascii=True, separators=(",", ":")).encode("ascii")


def validate_suggested_name(name: object) -> str:
    if (not isinstance(name, str) or not 5 <= len(name) <= 255 or not name.lower().endswith(".mp4")
            or any(char in '/\\:*?"<>|' or ord(char) < 32 for char in name)):
        raise ValueError("烧录视频请使用 .mp4 扩展名")
    return name


class BurnHost:
    """Listen only during the lifetime of the Launcher-owned editor process."""

    def __init__(self, pick: Callable[[str, Path, str], BurnDestination | None]):
        self._key = secrets.token_hex(32)
        key = self._key
        dialog = threading.Lock()
        nonce_lock = threading.Lock()
        seen: dict[str, float] = {}

        class Handler(BaseHTTPRequestHandler):
            timeout = 5

            def log_message(self, *_args):
                pass

            def do_POST(self):
                if (self.path != "/choose" or self.headers.get("Origin") is not None
                        or self.headers.get("Host") != f"127.0.0.1:{self.server.server_port}"):
                    self.send_error(403)
                    return
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    if not 0 < length <= MAX_MESSAGE:
                        self.send_error(400)
                        return
                    body = self.rfile.read(length)
                    if not _valid_signature(key, "choose", body, self.headers.get("X-MAW-Host-Proof")):
                        self.send_error(403)
                        return
                    data = json.loads(body)
                    now = time.time()
                    if abs(now - data["at"]) > 15:
                        self.send_error(403)
                        return
                    name = validate_suggested_name(data["name"])
                    language = data["language"]
                    if language not in ("zh", "en"):
                        raise ValueError("Invalid language")
                    source = Path(data["source"])
                    if not source.is_absolute():
                        self.send_error(400)
                        return
                    nonce = data["nonce"]
                    with nonce_lock:
                        for used, expiry in list(seen.items()):
                            if expiry <= now:
                                del seen[used]
                        if nonce in seen or len(seen) >= 128:
                            self.send_error(403)
                            return
                        seen[nonce] = now + 30
                except (OSError, KeyError, TypeError, ValueError):
                    self.send_error(400)
                    return
                if not dialog.acquire(blocking=False):
                    reply = {"error": "busy"}
                else:
                    try:
                        target = pick(name, source, language)
                        if target is None:
                            reply = {"cancelled": True}
                        else:
                            reply = {"path": str(target.path), "directory": target.directory,
                                     "original": target.original, "mode": target.mode,
                                     "sourceIdentity": target.source_identity}
                    except BurnDialogBusy:
                        reply = {"error": "busy"}
                    except ValueError as error:
                        reply = {"invalid": str(error)}
                    except OSError:
                        reply = {"error": "file"}
                    except Exception:
                        reply = {"error": "dialog"}
                    finally:
                        dialog.release()
                response = _json(reply)
                try:
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(response)))
                    self.send_header("X-MAW-Host-Proof", _sign(key, "chosen", body + b"\0" + response))
                    self.end_headers()
                    self.wfile.write(response)
                except OSError:
                    pass  # The editor can exit while the user has the dialog open.

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._close_lock = threading.Lock()
        self._closed = False
        self._grant_lock = threading.Lock()
        self._granted = False
        self._grants_closed = False
        self._thread = threading.Thread(target=self._server.serve_forever,
                                        kwargs={"poll_interval": 0.1}, daemon=True)
        self._thread.start()

    def environment(self) -> dict[str, str]:
        return {HOST_ENV: f"{self._server.server_port}:{self._key}"}

    def launch_grant(self) -> str:
        with self._grant_lock:
            if self._grants_closed:
                raise PermissionError("Editor is shutting down")
            payload = f"{int(time.time()) + GRANT_SECONDS}.{secrets.token_hex(32)}"
            self._granted = True
            return f"{payload}.{_sign(self._key, 'launch', payload.encode('ascii'))}"

    def stop_issuing_grants(self) -> bool:
        """Freeze browser handoffs and report whether native requests may exist."""
        with self._grant_lock:
            self._grants_closed = True
            return self._granted

    def owns_editor(self, port: int) -> bool:
        challenge = secrets.token_hex(32)
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
        try:
            connection.request("GET", f"{BURN_JOBS}/host-proof", headers={"X-MAW-Challenge": challenge})
            response = connection.getresponse()
            return response.status == 200 and _valid_signature(
                self._key, "editor", challenge.encode("ascii"), response.headers.get("X-MAW-Host-Proof"))
        except (OSError, http.client.HTTPException):
            return False
        finally:
            connection.close()

    def request_editor_shutdown(self, port: int) -> bool:
        if not self.owns_editor(port):
            return False
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
        try:
            connection.request("POST", "/api/shutdown")
            response = connection.getresponse()
            response.read(4096)
            return response.status == 200
        except (OSError, http.client.HTTPException):
            return False
        finally:
            connection.close()

    def close(self) -> None:
        with self._close_lock:
            if self._closed:
                return
            self._server.shutdown()
            self._server.server_close()
            self._thread.join()
            self._closed = True

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        self.close()


class BurnHostClient:
    def __init__(self, port: int, key: str):
        self.port = port
        self._key = key

    @classmethod
    def from_environment(cls, environment: MutableMapping[str, str]) -> BurnHostClient | None:
        raw = environment.pop(HOST_ENV, "")
        port, _, key = raw.partition(":")
        if port.isascii() and port.isdecimal() and len(port) <= 5 and 0 < int(port) <= 65535 and _TOKEN.fullmatch(key):
            return cls(int(port), key)
        return None

    def editor_proof(self, challenge: object) -> str | None:
        if isinstance(challenge, str) and _TOKEN.fullmatch(challenge):
            return _sign(self._key, "editor", challenge.encode("ascii"))
        return None

    def launch_expiry(self, grant: object) -> int:
        if isinstance(grant, str) and len(grant) < 160:
            expiry, nonce, signature = (grant.split(".") + ["", ""])[:3]
            if (expiry.isascii() and expiry.isdecimal() and len(expiry) <= 12 and _TOKEN.fullmatch(nonce)
                    and _valid_signature(self._key, "launch", f"{expiry}.{nonce}".encode("ascii"), signature)
                    and grant == f"{expiry}.{nonce}.{signature}" and time.time() < int(expiry)):
                return int(expiry)
        raise PermissionError("启动器编辑器会话无效，请从启动器重新打开")

    def choose(self, name: str, source: Path, language: str = "zh") -> BurnDestination | None:
        body = _json({"name": validate_suggested_name(name), "source": str(source),
                      "language": language, "at": time.time(), "nonce": secrets.token_hex(16)})
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=300)
        try:
            connection.request("POST", "/choose", body, {"X-MAW-Host-Proof": _sign(self._key, "choose", body)})
            response = connection.getresponse()
            raw = response.read(MAX_MESSAGE + 1)
            if (response.status != 200 or len(raw) > MAX_MESSAGE
                    or not _valid_signature(self._key, "chosen", body + b"\0" + raw,
                                            response.headers.get("X-MAW-Host-Proof"))):
                raise BurnDialogUnavailable("无法打开启动器保存对话框")
            result = json.loads(raw)
            if result.get("error") == "busy":
                raise BurnDialogBusy("启动器已有保存对话框，请先完成或关闭")
            if result.get("error") == "file":
                raise OSError("Launcher could not inspect the selected file")
            if result.get("error"):
                raise BurnDialogUnavailable("无法打开启动器保存对话框")
            if result.get("invalid"):
                raise ValueError(result["invalid"])
            if result.get("cancelled"):
                return None
            original = result["original"]
            return BurnDestination(Path(result["path"]), tuple(result["directory"]),
                                   tuple(original) if original is not None else None, result["mode"],
                                   source, tuple(result["sourceIdentity"]), ())
        except (ConnectionError, TimeoutError, http.client.HTTPException) as error:
            raise BurnDialogUnavailable("无法打开启动器保存对话框") from error
        finally:
            connection.close()


class BurnSessions:
    """One-use launch grants and browser sessions, in memory in one editor process."""

    def __init__(self, host: BurnHostClient):
        self.host = host
        self._lock = threading.Lock()
        self._used: dict[str, int] = {}
        self._sessions: dict[str, None] = {}

    def redeem(self, grant: str) -> str:
        expiry = self.host.launch_expiry(grant)
        with self._lock:
            now = time.time()
            self._used = {key: end for key, end in self._used.items() if end > now}
            if expiry <= now or grant in self._used or len(self._used) >= 128:
                raise PermissionError("启动器编辑器会话无效，请从启动器重新打开")
            session = secrets.token_hex(32)
            self._used[grant] = expiry
            # Bound dormant tabs. Evict the least recently used session.
            while len(self._sessions) >= 128:
                del self._sessions[next(iter(self._sessions))]
            self._sessions[session] = None
            return session

    def require(self, session: object) -> str:
        with self._lock:
            if isinstance(session, str) and session in self._sessions:
                del self._sessions[session]
                self._sessions[session] = None
                return session
        raise PermissionError("启动器编辑器会话无效，请从启动器重新打开")
