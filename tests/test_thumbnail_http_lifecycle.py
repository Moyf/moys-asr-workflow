from __future__ import annotations

import http.client
import json
import os
import socket
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from tests.test_local_editor_server import server_editor


class ThumbnailHttpLifecycleTests(unittest.TestCase):
    """Real loopback HTTP framing, without FFmpeg or a media/cache fixture."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.enterContext(mock.patch.dict(os.environ, {"MAW_APP_DATA_ROOT": str(Path(temp.name) / "app")}))
        project = server_editor.ServerProject(data={"segments": []}, json_path=None,
            media_path=None, source_media_path=None, sticker_root=None, stickers=[])
        self.server = server_editor.EditorServer(("127.0.0.1", 0), project, no_waveform=True)
        self.thread = threading.Thread(target=self.server.serve_forever,
            kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)
        self.host = f"127.0.0.1:{self.server.server_address[1]}"
        self.payload = {"binding": self.server.thumbnail_jobs.binding, "client_id": "test",
                        "requestToken": self.server.request_token}

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(3)
        self.assertFalse(self.thread.is_alive())

    def connect(self):
        connection = socket.create_connection(self.server.server_address, timeout=2)
        self.addCleanup(connection.close)
        stream = connection.makefile("rb")
        self.addCleanup(stream.close)
        return connection, stream

    def post(self, body, *, path="demand", headers=None):
        fields = {"Host": self.host, "Content-Type": "application/json",
                  "Content-Length": str(len(body)), **(headers or {})}
        head = f"POST /api/thumbnails/{path} HTTP/1.1\r\n"
        head += "".join(f"{key}: {value}\r\n" for key, value in fields.items())
        return (head + "\r\n").encode("ascii") + body

    def response(self, stream):
        line = stream.readline(4096)
        self.assertTrue(line.startswith(b"HTTP/1.1 "), line)
        status = int(line.split()[1])
        headers = http.client.parse_headers(stream)
        length = int(headers.get("Content-Length", "0"))
        self.assertLess(length, 4096)
        body = stream.read(length)
        self.assertEqual(len(body), length)
        return status, headers, json.loads(body)

    def test_early_rejection_does_not_parse_unread_body_as_next_request(self):
        # This is the rejected POST's body, NOT a second HTTP request. Before
        # closing on early rejection, the handler served this as a favicon GET.
        body = (f"GET /favicon.ico HTTP/1.1\r\nHost: {self.host}\r\n"
                "Connection: close\r\n\r\n").encode("ascii")
        for headers, expected in (({"Host": "evil.example"}, 403),
                                  ({"Origin": "https://evil.example"}, 403),
                                  ({"Content-Length": "65537"}, 400)):
            with self.subTest(headers=headers):
                connection, stream = self.connect()
                connection.sendall(self.post(body, headers=headers))
                status, response_headers, payload = self.response(stream)
                self.assertEqual(status, expected)
                self.assertIsInstance(payload.get("error"), str)
                self.assertEqual(stream.read(1), b"", "unread body was handled as a new request")
                self.assertEqual(response_headers.get("Connection"), "close")

    def test_early_rejection_closes_without_waiting_for_remaining_body(self):
        # Never send the remainder or half-close: rejection must not drain or
        # wait for it. Socket timeout is only a failure bound, not a sleep.
        for headers, expected in (({"Host": "evil.example", "Content-Length": "1024"}, 403),
                                  ({"Origin": "https://evil.example", "Content-Length": "1024"}, 403),
                                  ({"Content-Length": "999999999999"}, 400),
                                  ({"Content-Length": "invalid"}, 400),
                                  ({"Content-Length": "-1"}, 400),
                                  ({"Content-Length": "0"}, 400)):
            with self.subTest(headers=headers):
                connection, stream = self.connect()
                connection.sendall(self.post(b"{", headers=headers))
                status, response_headers, _ = self.response(stream)
                self.assertEqual(status, expected)
                self.assertEqual(stream.read(1), b"")
                self.assertEqual(response_headers.get("Connection"), "close")

    def test_consumed_body_success_and_business_errors_preserve_keepalive(self):
        for path, changes, expected in (("release", {}, 200),
                                         ("demand", {}, 200),
                                         ("demand", {"requestToken": "bad"}, 403),
                                         ("demand", {"path": "forbidden"}, 400),
                                         ("demand", {"binding": "old"}, 409),
                                         ("demand", {"playing": "false"}, 400)):
            with self.subTest(path=path, changes=changes):
                connection, stream = self.connect()
                body = json.dumps({**self.payload, **changes}).encode("utf-8")
                next_body = json.dumps(self.payload).encode("utf-8")
                connection.sendall(self.post(body, path=path) +
                    self.post(next_body, path="release", headers={"Connection": "close"}))
                status, headers, _ = self.response(stream)
                self.assertEqual(status, expected)
                self.assertNotEqual(headers.get("Connection"), "close")
                next_status, _, payload = self.response(stream)
                self.assertEqual(next_status, 200)
                self.assertEqual(payload, {"ok": True})
                self.assertEqual(stream.read(1), b"")
