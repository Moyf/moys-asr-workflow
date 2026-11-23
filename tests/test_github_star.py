import os
import subprocess
import sys
import unittest
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from threading import Event
from unittest.mock import patch

from maw import github_star


class GitHubCliDiscoveryTests(unittest.TestCase):
    def test_finder_path_falls_back_to_homebrew_after_absolute_path_entries(self):
        path_dir = Path.cwd() / "test-path"
        brew_dir = Path.cwd() / "test-homebrew"
        name = "gh.exe" if os.name == "nt" else "gh"
        brew_cli = str(brew_dir / name)
        with (
            patch.object(github_star.os, "get_exec_path", return_value=[".", str(path_dir)]),
            patch.object(github_star, "_MACOS_GH_DIRECTORIES", (str(brew_dir),), create=True),
            patch.object(sys, "platform", "darwin"),
            patch.object(github_star.shutil, "which", side_effect=lambda path: path if path == brew_cli else None) as which,
        ):
            self.assertEqual(github_star._find_gh(), brew_cli)
            self.assertEqual([item.args[0] for item in which.call_args_list], [str(path_dir / name), brew_cli])
            which.reset_mock()
            which.side_effect = lambda path: path
            self.assertEqual(github_star._find_gh(), str(path_dir / name))
            which.assert_called_once_with(str(path_dir / name))
            which.reset_mock()
            which.side_effect = lambda path: None
            with patch.object(sys, "platform", "linux"):
                self.assertIsNone(github_star._find_gh())
            which.assert_called_once_with(str(path_dir / name))


class GitHubStarTests(unittest.TestCase):
    def setUp(self):
        self.find_gh = self.enterContext(patch.object(github_star, "_find_gh", return_value="mock-gh"))
        self.run = self.enterContext(patch.object(github_star.subprocess, "run"))

    def respond(self, code, response):
        self.run.return_value = subprocess.CompletedProcess([], code, response)

    def assert_gh_method(self, method):
        self.run.assert_called_once()
        self.assertEqual(
            self.run.call_args.args[0],
            ["mock-gh", "api", "--hostname", "github.com", "--method", method,
             "--include", "--silent", "user/starred/Moyf/moys-asr-workflow"],
        )

    def test_check_is_read_only(self):
        self.respond(0, b"HTTP/2.0 204 No Content\n")
        self.assertIs(github_star.check_maw_starred(), True)
        self.assert_gh_method("GET")

    def test_only_confirmed_404_means_not_starred(self):
        self.respond(1, b"HTTP/1.1 404 Not Found\n")
        self.assertIs(github_star.check_maw_starred(), False)
        for output in (b"", b"gh: HTTP 404", b"HTTP/2.0 401 Unauthorized\n", b"HTTP/2.0 403 Forbidden\n"):
            with self.subTest(output=output):
                self.respond(1, output)
                self.assertIsNone(github_star.check_maw_starred())

    def test_missing_gh_never_spawns(self):
        self.find_gh.return_value = None
        self.assertIsNone(github_star.check_maw_starred())
        self.assertFalse(github_star.star_maw())
        self.run.assert_not_called()

    def test_subprocess_errors_are_unavailable(self):
        for error in (OSError(), subprocess.TimeoutExpired("mock-gh", 8)):
            with self.subTest(error=type(error)):
                self.run.side_effect = error
                self.assertIsNone(github_star.check_maw_starred())
                self.assertFalse(github_star.star_maw())

    def test_write_requires_confirmed_success(self):
        self.respond(0, b"HTTP/2.0 204 No Content\n")
        self.assertTrue(github_star.star_maw())
        self.assert_gh_method("PUT")
        for code, output in ((1, b"HTTP/2.0 404 Not Found\n"), (0, b""), (1, b"HTTP/2.0 204 No Content\n")):
            with self.subTest(code=code, output=output):
                self.respond(code, output)
                self.assertFalse(github_star.star_maw())

    def test_concurrent_checks_share_one_gh_call_without_caching(self):
        self.assert_shared_attempt(github_star.check_maw_starred, False, True)

    def test_concurrent_writes_share_failure_and_can_retry(self):
        self.assert_shared_attempt(github_star.star_maw, False, True)

    def assert_shared_attempt(self, action, first_result, retry_result):
        entered_gh = Event()
        follower_joined = Event()
        release_gh = Event()

        class ObservedFuture(Future):
            def result(self, timeout=None):
                follower_joined.set()
                return super().result(timeout)

        def blocked_gh(*args, **kwargs):
            entered_gh.set()
            if not release_gh.wait(5):
                raise AssertionError("Test did not release the mock gh call")
            return subprocess.CompletedProcess([], 1, b"HTTP/1.1 404 Not Found\n")

        self.run.side_effect = blocked_gh
        with patch.object(github_star, "Future", ObservedFuture, create=True), ThreadPoolExecutor(2) as pool:
            leader = pool.submit(action)
            try:
                self.assertTrue(entered_gh.wait(2))
                follower = pool.submit(action)
                self.assertTrue(follower_joined.wait(2), "Second caller did not join the in-flight request")
                self.run.assert_called_once()
            finally:
                release_gh.set()
            self.assertIs(leader.result(2), first_result)
            self.assertIs(follower.result(2), first_result)

        self.run.side_effect = None
        self.respond(0, b"HTTP/2.0 204 No Content\n")
        self.assertIs(action(), retry_result)
        self.assertEqual(self.run.call_count, 2)
