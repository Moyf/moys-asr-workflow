"""Narrow loopback lab server; only CLI-authorized media and registered sprites."""
from __future__ import annotations

import argparse
from collections import deque
from concurrent.futures import ThreadPoolExecutor
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import secrets
import sys
import threading
import time
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from backend import Cancelled, generate, probe  # noqa: E402
from maw.waveform import extract_waveform  # noqa: E402


def byte_range(header: str | None, size: int) -> tuple[int, int]:
    if not header:
        return 0, size - 1
    if not header.startswith("bytes=") or "," in header:
        raise ValueError("Single bytes range required")
    left, right = header[6:].split("-", 1)
    if not left:
        length = int(right)
        if length <= 0:
            raise ValueError("Invalid suffix")
        return max(0, size - length), size - 1
    start = int(left)
    end = min(int(right), size - 1) if right else size - 1
    if not 0 <= start <= end < size:
        raise ValueError("Invalid range")
    return start, end


class Lab(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port: int, paths: list[Path], cache: Path):
        super().__init__(("127.0.0.1", port), Handler)
        self.token = secrets.token_urlsafe(24)
        self.cache = cache
        self.registry = {}
        for i, path in enumerate(paths):
            info = probe(path)
            self.registry[str(i)] = {"path": path, "info": info}
        self.jobs = {}
        self.images = {}
        self.order = deque()
        self.lock = threading.Lock()
        self.pool = ThreadPoolExecutor(max_workers=1)
        self.last_access = time.monotonic()

    def close(self):
        with self.lock:
            for job in self.jobs.values():
                job["cancel"].set()
        self.pool.shutdown(wait=True, cancel_futures=True)
        self.server_close()


class Handler(BaseHTTPRequestHandler):
    MAX_JOB_BODY = 2048
    MAX_POST_DRAIN = 4096

    def log_message(self, *_):
        pass

    def reply(self, value, status=200, *, close=False):
        body = json.dumps(value, ensure_ascii=False).encode()
        if close:
            self.close_connection = True
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if close:
            self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def authorized_host(self):
        return self.headers.get("Host") == f"127.0.0.1:{self.server.server_port}"

    def read_post_body(self):
        if self.headers.get("Transfer-Encoding") is not None:
            return None, True
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return None, True
        if not 0 <= length <= self.MAX_POST_DRAIN:
            return None, True
        # Closing a Windows socket with an unread POST body can turn a 403/404
        # response into a connection reset. Bound the read and its total wait.
        deadline = time.monotonic() + 1.0
        previous_timeout = self.connection.gettimeout()
        try:
            body = bytearray()
            while len(body) < length:
                remaining_time = deadline - time.monotonic()
                if remaining_time <= 0:
                    return None, True
                self.connection.settimeout(remaining_time)
                chunk = self.rfile.read1(length - len(body))
                if not chunk:
                    return None, True
                body.extend(chunk)
            return bytes(body), False
        except OSError:
            return None, True
        finally:
            self.connection.settimeout(previous_timeout)

    def do_POST(self):
        self.server.last_access = time.monotonic()
        authorized = (self.authorized_host()
                      and self.headers.get("X-Lab-Token") == self.server.token
                      and self.headers.get("Origin") in
                      (None, f"http://127.0.0.1:{self.server.server_port}"))
        body_bytes, invalid_body = self.read_post_body()
        if invalid_body:
            return self.reply({"error": "Invalid request"}, 400, close=True)
        if not authorized:
            return self.reply({"error": "Forbidden"}, 403)
        if len(body_bytes) > self.MAX_JOB_BODY:
            return self.reply({"error": "Invalid request"}, 400, close=True)
        if urlsplit(self.path).path == "/api/cancel":
            with self.server.lock:
                for job in self.server.jobs.values():
                    job["cancel"].set()
                    if "future" in job:
                        job["future"].cancel()
            return self.reply({"cancelled": True})
        if urlsplit(self.path).path != "/api/job":
            return self.reply({"error": "Not found"}, 404)
        try:
            if not body_bytes:
                raise ValueError("Body limit")
            body = json.loads(body_bytes)
            if set(body) - {"media", "mode", "start", "span", "count", "stream"}:
                raise ValueError("Unknown parameters")
            media = self.server.registry[str(body.pop("media"))]
            # Cancel prior view work. One decoder and a bounded queue; completed
            # results are only returned for the exact job ID the browser requested.
            with self.server.lock:
                for job in self.server.jobs.values():
                    job["cancel"].set()
                cancel = threading.Event()
                job_id = secrets.token_hex(12)
                job = {"cancel": cancel, "state": "pending"}
                self.server.jobs[job_id] = job
                self.server.order.append(job_id)
                while len(self.server.order) > 32:
                    self.server.jobs.pop(self.server.order.popleft(), None)
            def work():
                try:
                    result = generate(media["path"], media["info"], self.server.cache,
                                      cancel=cancel, **body)
                    with self.server.lock:
                        if cancel.is_set():
                            raise Cancelled("Superseded")
                        self.server.images[result["key"]] = self.server.cache / result["key"] / "sprite.jpg"
                        job.update(state="done", result=result)
                except Cancelled:
                    job.update(state="cancelled")
                except Exception as exc:
                    job.update(state="error", error=str(exc)[:180])
            # Remove queued superseded futures before submitting the next view.
            for old in list(self.server.jobs.values()):
                if old is not job and "future" in old:
                    old["future"].cancel()
            job["future"] = self.server.pool.submit(work)
            return self.reply({"job": job_id}, 202)
        except (ValueError, TypeError, KeyError):
            return self.reply({"error": "Invalid request"}, 400)

    def send_file(self, path: Path, mime: str, ranged=False):
        size = path.stat().st_size
        try:
            start, end = byte_range(self.headers.get("Range") if ranged else None, size)
        except (ValueError, TypeError):
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        partial = ranged and self.headers.get("Range")
        self.send_response(206 if partial else 200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("X-Content-Type-Options", "nosniff")
        if ranged:
            self.send_header("Accept-Ranges", "bytes")
        if partial:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        try:
            with path.open("rb") as stream:
                stream.seek(start)
                remaining = end - start + 1
                while remaining:
                    block = stream.read(min(65536, remaining))
                    if not block:
                        break
                    self.wfile.write(block)
                    remaining -= len(block)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def do_GET(self):
        self.server.last_access = time.monotonic()
        if not self.authorized_host():
            return self.reply({"error": "Forbidden host"}, 403)
        path = urlsplit(self.path).path
        if path == "/api/config":
            return self.reply({"token": self.server.token, "media": [
                {"id": key, **value["info"]} for key, value in self.server.registry.items()]})
        if path.startswith("/api/job/"):
            job = self.server.jobs.get(path.split("/")[-1])
            if job:
                return self.reply({k: v for k, v in job.items() if k not in ("cancel", "future")})
        if path.startswith("/media/"):
            media = self.server.registry.get(path.split("/")[-1])
            if media:
                mime = "video/mp4" if media["path"].suffix == ".mp4" else "video/webm"
                if media["path"].suffix == ".mov":
                    mime = "video/quicktime"
                if media["path"].suffix == ".wav":
                    mime = "audio/wav"
                return self.send_file(media["path"], mime, True)
        if path.startswith("/sprite/"):
            image = self.server.images.get(path.split("/")[-1])
            if image:
                return self.send_file(image, "image/jpeg")
        if path.startswith("/api/wave/"):
            media = self.server.registry.get(path.split("/")[-1])
            if media:
                # Optional, short-file only. No blocking 2h waveform precompute.
                if not media["info"]["audio"] or media["info"]["duration"] > 60:
                    return self.reply({"waveform": None})
                if "waveform" not in media:
                    try:
                        media["waveform"] = extract_waveform(media["path"], peaks_per_second=20, pcm_sample_rate=16000)
                    except Exception:
                        media["waveform"] = None
                return self.reply({"waveform": media["waveform"]})
        static = {
            "/": (ROOT / "web/experiments/filmstrip/index.html", "text/html; charset=utf-8"),
            "/verification": (ROOT / ".artifacts/filmstrip/verification.html", "text/html; charset=utf-8"),
            "/lab.mjs": (ROOT / "web/experiments/filmstrip/lab.mjs", "text/javascript"),
            "/core.mjs": (ROOT / "web/experiments/filmstrip/core.mjs", "text/javascript"),
            "/lab.css": (ROOT / "web/experiments/filmstrip/lab.css", "text/css"),
            "/gap.js": (ROOT / "web/shared/gap-remove-core.js", "text/javascript"),
            "/lab-inline.js": (ROOT / ".artifacts/filmstrip/lab-inline.js", "text/javascript"),
            "/scale.mjs": (ROOT / "web/editor/media/waveform/scale.js", "text/javascript"),
        }
        if path in static:
            if static[path][0].is_file():
                return self.send_file(*static[path])
        return self.reply({"error": "Not found"}, 404)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--media", type=Path, nargs="+", required=True)
    parser.add_argument("--port", type=int, default=8769)
    parser.add_argument("--cache", type=Path, default=ROOT / ".artifacts/filmstrip/cache")
    parser.add_argument("--idle-seconds", type=int, default=900)
    args = parser.parse_args()
    lab = Lab(args.port, [p.resolve(strict=True) for p in args.media], args.cache.resolve())
    lab.timeout = 0.5
    print(f"Filmstrip lab http://127.0.0.1:{lab.server_port} (Ctrl+C to stop)", flush=True)
    try:
        while time.monotonic() - lab.last_access < args.idle_seconds:
            lab.handle_request()
    except KeyboardInterrupt:
        pass
    finally:
        lab.close()


if __name__ == "__main__":
    main()
