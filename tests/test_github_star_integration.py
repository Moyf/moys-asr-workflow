import io
import json
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from maw import gui_web
from tests.test_local_editor_server import server_editor


class GitHubStarIntegrationTests(unittest.TestCase):
    def test_launcher_bridge_requires_trusted_page_and_empty_payload(self):
        api = object.__new__(gui_web.LauncherApi)
        api._github_star_source = Mock(return_value=False)
        with patch.object(gui_web, "check_maw_starred", return_value=False) as check, \
                patch.object(gui_web, "star_maw", return_value=True) as star:
            self.assertEqual(api.github_star({}), {"starred": None})
            self.assertEqual(api.github_star_status({}), {"starred": None})
            api._github_star_source.return_value = True
            self.assertEqual(api.github_star({"repo": "other/repo"}), {"starred": None})
            check.assert_not_called()
            star.assert_not_called()
            self.assertEqual(api.github_star_status({}), {"starred": False})
            check.assert_called_once_with()
            star.assert_not_called()
            self.assertEqual(api.github_star({}), {"starred": True})
            star.assert_called_once_with()

    def request(self, endpoint="/api/github-star", *, origin="http://127.0.0.1:1234",
                host="127.0.0.1:1234", payload=None):
        body = json.dumps({"requestToken": "test-token"} if payload is None else payload).encode()
        handler = object.__new__(server_editor.EditorRequestHandler)
        handler.server = SimpleNamespace(server_address=("127.0.0.1", 1234), request_token="test-token")
        handler.path = endpoint
        handler.headers = {"Host": host, "Origin": origin, "Content-Length": str(len(body))}
        handler.rfile = io.BytesIO(body)
        handler.send_json = Mock()
        handler.do_POST()
        return handler.send_json.call_args.args

    def test_editor_status_and_write_are_separate(self):
        with patch.object(server_editor, "check_maw_starred", return_value=False) as check, \
                patch.object(server_editor, "star_maw", side_effect=(True, False)) as star:
            self.assertEqual(self.request("/api/github-star/status"), (200, {"starred": False}))
            check.assert_called_once_with()
            star.assert_not_called()
            self.assertEqual(self.request(), (200, {"starred": True}))
            self.assertEqual(self.request(), (200, {"starred": None}))
            self.assertEqual(star.call_count, 2)

    def test_editor_rejects_untrusted_source_or_extra_fields(self):
        with patch.object(server_editor, "star_maw") as star:
            for options, code in (
                ({"origin": None}, 403),
                ({"origin": "http://127.0.0.1:4321"}, 403),
                ({"host": "example.test"}, 403),
                ({"payload": {"requestToken": "invalid"}}, 403),
                ({"payload": {"requestToken": "test-token", "repo": "other/repo"}}, 400),
            ):
                with self.subTest(options=options):
                    self.assertEqual(self.request(**options), (code, {"starred": None}))
            star.assert_not_called()
