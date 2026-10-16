from __future__ import annotations

import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

from maw.gui_web import LauncherApi, LauncherPaths


class LauncherThumbnailBindingTests(unittest.TestCase):
    def test_explicit_project_never_silently_reuses_another_editors_media(self):
        class ExistingEditor(BaseHTTPRequestHandler):
            def do_GET(self):
                body = json.dumps({"ok": True, "status": "ready"}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args):
                pass

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = LauncherPaths(root=root, env_path=root / "unused.env", launcher_html=root / "launcher.html")
            api = LauncherApi(paths=paths, window_getter=lambda: None)
            server = ThreadingHTTPServer(("127.0.0.1", 0), ExistingEditor)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                port = server.server_address[1]
                with mock.patch("maw.gui_web.popen_process_tree") as spawn:
                    result = api.start_server({"jsonPath": str(root / "new-project.mosp"), "port": port})
                    self.assertFalse(result["ok"])
                    self.assertEqual(result["code"], "server_media_busy")
                    self.assertNotIn("url", result)
                    spawn.assert_not_called()
                    # An explicit request to open the existing editor still works.
                    existing = api.start_server({"port": port})
                    self.assertTrue(existing["ok"])
                    self.assertTrue(existing["serverAlreadyRunning"])
            finally:
                server.shutdown()
                thread.join(3)
                server.server_close()
