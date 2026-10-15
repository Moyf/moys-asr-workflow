"""Experiment contracts; no product schema or public Server mutation."""
import importlib.util
from http.client import HTTPConnection
import json
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools/filmstrip-lab"))
import backend  # noqa: E402
spec = importlib.util.spec_from_file_location("filmstrip_lab_server", ROOT / "tools/filmstrip-lab/serve.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)
INFO = {"name": "test.mp4", "duration": 7200, "videos": [{"index": 0}], "audio": False}


class FilmstripPolicyTests(unittest.TestCase):
    def test_budget_and_modes(self):
        self.assertEqual(backend.parameters(INFO, "adaptive", count=100)["count"], 100)
        self.assertEqual(backend.parameters({**INFO, "duration": 30}, "adaptive")["count"], 2)
        self.assertEqual(backend.parameters(INFO, "window", span=300, count=100)["span"], 300)
        self.assertEqual(backend.parameters(INFO, "window", span=300, count=100)["count"], 32)

    def test_reject_invalid_values(self):
        for kwargs in ({"mode": "other"}, {"mode": "fixed", "count": 241},
                       {"mode": "fixed", "stream": 1}, {"mode": "fixed", "count": True},
                       {"mode": "window", "start": 7200}, {"mode": "window", "span": float("nan")}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                backend.parameters(INFO, **kwargs)

    def test_same_basename_cannot_alias(self):
        with tempfile.TemporaryDirectory() as directory:
            a = Path(directory) / "a" / "movie.mp4"; a.parent.mkdir(); a.write_bytes(b"same")
            b = Path(directory) / "b" / "movie.mp4"; b.parent.mkdir(); b.write_bytes(b"same")
            config = backend.parameters(INFO, "fixed")
            self.assertNotEqual(backend.cache_key(a, config), backend.cache_key(b, config))
            old = backend.cache_key(a, config); a.write_bytes(b"changed")
            self.assertNotEqual(old, backend.cache_key(a, config))

    def test_cancel_before_spawn(self):
        with tempfile.TemporaryDirectory() as directory:
            media = Path(directory) / "test.mp4"; media.write_bytes(b"not a real media")
            event = threading.Event(); event.set()
            with patch.object(backend.subprocess, "Popen") as spawn:
                with self.assertRaises(backend.Cancelled):
                    backend.generate(media, INFO, Path(directory) / "cache", cancel=event)
                spawn.assert_not_called()

    def test_running_process_cancelled_and_waited(self):
        with tempfile.TemporaryDirectory() as directory:
            media = Path(directory) / "test.mp4"; media.write_bytes(b"not a real media")
            event = threading.Event()
            class Process:
                returncode = None
                def poll(self):
                    event.set()
                    return None
                def kill(self):
                    self.killed = True
                def wait(self, timeout=None):
                    self.waited = True
            process = Process()
            # Identity probes the tool stat, but no real executable is needed.
            ffmpeg = Path(directory) / "ffmpeg-test.exe"
            ffmpeg.write_bytes(b"stub")
            with patch.object(backend, "resolve_ffmpeg_tools", return_value=SimpleNamespace(ffmpeg=ffmpeg)), patch.object(backend.subprocess, "Popen", return_value=process):
                with self.assertRaises(backend.Cancelled):
                    backend.generate(media, INFO, Path(directory) / "cache", cancel=event)
            self.assertTrue(process.killed); self.assertTrue(process.waited)
            self.assertFalse(any((Path(directory) / "cache").glob("*/manifest.json")))

    def test_range_contract(self):
        self.assertEqual(server.byte_range("bytes=2-4", 10), (2, 4))
        self.assertEqual(server.byte_range("bytes=-3", 10), (7, 9))
        self.assertEqual(server.byte_range("bytes=3-", 10), (3, 9))
        for value in ("bytes=10-", "bytes=5-2", "bytes=0-1,3-4", "bytes=-0", "items=0-1"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                server.byte_range(value, 10)


class FilmstripServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.media = Path(self.temp.name) / "test.mp4"; self.media.write_bytes(b"0123456789")
        with patch.object(server, "probe", return_value=INFO):
            self.lab = server.Lab(0, [self.media], Path(self.temp.name) / "cache")
        self.thread = threading.Thread(target=self.lab.serve_forever, daemon=True); self.thread.start()
        self.url = f"http://127.0.0.1:{self.lab.server_port}"

    def tearDown(self):
        self.lab.shutdown(); self.lab.close(); self.thread.join(timeout=2); self.temp.cleanup()

    def test_range_response(self):
        with urlopen(Request(self.url + "/media/0", headers={"Range": "bytes=2-4"}), timeout=3) as response:
            self.assertEqual(response.status, 206); self.assertEqual(response.read(), b"234")

    def test_no_arbitrary_paths_or_unregistered_sprite(self):
        for path in ("/media/../test.mp4", "/sprite/unknown", "/anything"):
            with self.subTest(path=path), self.assertRaises(HTTPError) as exc:
                urlopen(self.url + path, timeout=3)
            self.assertEqual(exc.exception.code, 404)

    def test_host_origin_and_token(self):
        body = json.dumps({"media": "0", "mode": "fixed"}).encode()
        for case, headers in (("missing token", {}),
                              ("bad origin", {"X-Lab-Token": self.lab.token,
                                              "Origin": "http://evil.example"}),
                              ("bad host", {"X-Lab-Token": self.lab.token,
                                            "Host": "evil.example"})):
            with self.subTest(case=case):
                with self.assertRaises(HTTPError) as exc:
                    urlopen(Request(self.url + "/api/job", data=body, headers=headers), timeout=3)
                self.assertEqual(exc.exception.code, 403)

    def test_post_rejections_with_bounded_bodies(self):
        headers = {"X-Lab-Token": self.lab.token}
        for path, body, status in (("/api/job", b"", 400),
                                   ("/api/job", b"x" * 2048, 400),
                                   ("/api/job", b"x" * 2049, 400),
                                   ("/api/missing", b"x" * 32, 404),
                                   ("/api/missing", b"x" * 2049, 400)):
            with self.subTest(path=path, size=len(body)):
                with self.assertRaises(HTTPError) as exc:
                    urlopen(Request(self.url + path, data=body, headers=headers), timeout=3)
                self.assertEqual(exc.exception.code, status)
                if len(body) > 2048:
                    self.assertEqual(exc.exception.headers.get("Connection"), "close")

    def test_oversized_claim_is_rejected_without_reading_body(self):
        for case, headers, status in (
            ("authorized", {"X-Lab-Token": self.lab.token}, 400),
            ("bad origin", {"X-Lab-Token": self.lab.token,
                            "Origin": "http://evil.example"}, 400),
        ):
            with self.subTest(case=case):
                connection = HTTPConnection("127.0.0.1", self.lab.server_port, timeout=3)
                try:
                    connection.request("POST", "/api/job", body=b"",
                                       headers={**headers, "Content-Length": "1000000"})
                    response = connection.getresponse()
                    self.assertEqual(response.status, status)
                    self.assertEqual(response.getheader("Connection"), "close")
                finally:
                    connection.close()

    def test_chunked_post_is_rejected_without_waiting_for_chunks(self):
        connection = HTTPConnection("127.0.0.1", self.lab.server_port, timeout=3)
        try:
            connection.putrequest("POST", "/api/job")
            connection.putheader("X-Lab-Token", self.lab.token)
            connection.putheader("Transfer-Encoding", "chunked")
            connection.endheaders()
            response = connection.getresponse()
            self.assertEqual(response.status, 400)
            self.assertEqual(response.getheader("Connection"), "close")
            self.assertFalse(self.lab.jobs)
        finally:
            connection.close()

    def test_slow_post_has_absolute_deadline(self):
        with socket.create_connection(("127.0.0.1", self.lab.server_port), timeout=3) as connection:
            connection.settimeout(3)
            headers = (f"POST /api/job HTTP/1.1\r\nHost: 127.0.0.1:{self.lab.server_port}\r\n"
                       f"X-Lab-Token: {self.lab.token}\r\nContent-Length: 8\r\n\r\n").encode()
            start = time.monotonic()
            connection.sendall(headers + b"x")
            for _ in range(3):
                time.sleep(0.2)
                connection.sendall(b"x")
            response = connection.recv(4096)
            self.assertIn(b" 400 ", response.split(b"\r\n", 1)[0])
            self.assertIn(b"Connection: close", response)
            self.assertLess(time.monotonic() - start, 1.45)
            self.assertFalse(self.lab.jobs)

    def test_unknown_body_and_media(self):
        for body in ({"media": "../test.mp4"}, {"media": "0", "path": "/private"}):
            with self.subTest(body=body), self.assertRaises(HTTPError) as exc:
                urlopen(Request(self.url + "/api/job", data=json.dumps(body).encode(),
                                headers={"X-Lab-Token": self.lab.token}), timeout=3)
            self.assertEqual(exc.exception.code, 400)

    def test_explicit_cancel_endpoint(self):
        event = threading.Event(); self.lab.jobs["old"] = {"cancel": event}
        with urlopen(Request(self.url + "/api/cancel", data=b"",
                             headers={"X-Lab-Token": self.lab.token}), timeout=3) as response:
            self.assertTrue(json.load(response)["cancelled"])
        self.assertTrue(event.is_set())

    def test_registered_job_only(self):
        with patch.object(server, "generate", return_value={"key": "test", "times": [0]}):
            with urlopen(Request(self.url + "/api/job", data=b'{"media":"0","mode":"fixed"}',
                                 headers={"X-Lab-Token": self.lab.token}), timeout=3) as response:
                job = json.load(response)["job"]
            self.lab.jobs[job]["future"].result(timeout=3)
            with urlopen(self.url + "/api/job/" + job, timeout=3) as response:
                self.assertEqual(json.load(response)["state"], "done")
