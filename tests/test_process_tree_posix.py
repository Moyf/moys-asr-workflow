"""Owned POSIX group cleanup: platform mocks plus portable real-worker cases."""
from __future__ import annotations

import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from maw import gui_platform  # noqa: E402


class PosixGroupTests(unittest.TestCase):
    def test_popen_missing_pid_test_double_remains_compatible(self) -> None:
        process = type("FakeProcess", (), {})()
        with mock.patch.object(gui_platform.sys, "platform", "linux"), \
                mock.patch.object(gui_platform.subprocess, "Popen", return_value=process):
            self.assertIs(gui_platform.popen_process_tree(["synthetic"], start_new_session=True), process)
        self.assertFalse(hasattr(process, "_maw_process_group_id"))

    def test_popen_records_only_explicit_new_group(self) -> None:
        for kwargs, owned in (({"start_new_session": True}, True), ({"process_group": 0}, True),
                              ({}, False), ({"start_new_session": False}, False),
                              ({"process_group": 9000}, False)):
            with self.subTest(kwargs=kwargs):
                process = mock.Mock(pid=4321)
                with mock.patch.object(gui_platform.sys, "platform", "linux"), \
                        mock.patch.object(gui_platform.subprocess, "Popen", return_value=process):
                    gui_platform.popen_process_tree(["synthetic"], **kwargs)
                self.assertEqual(process.__dict__.get("_maw_process_group_id"), 4321 if owned else None)

    def test_exited_root_does_not_skip_live_owned_group(self) -> None:
        process = mock.Mock(pid=4321, _maw_process_group_id=4321)
        process.poll.return_value = 0
        with mock.patch.object(gui_platform.sys, "platform", "darwin"), \
                mock.patch.object(gui_platform.signal, "SIGKILL", 9, create=True), \
                mock.patch.object(gui_platform.os, "killpg", create=True) as killpg, \
                mock.patch.object(gui_platform, "_posix_group_alive", side_effect=[True, False]), \
                mock.patch.object(gui_platform.time, "sleep"):
            gui_platform.terminate_process_tree(process, timeout=0.2)
        killpg.assert_called_once_with(4321, signal.SIGTERM)
        process.wait.assert_called_once_with(timeout=0.2)
        process.terminate.assert_not_called()

    def test_surviving_group_receives_sigkill_after_root_exit(self) -> None:
        process = mock.Mock(pid=4321, _maw_process_group_id=4321)
        process.poll.return_value = 0
        with mock.patch.object(gui_platform.sys, "platform", "darwin"), \
                mock.patch.object(gui_platform.signal, "SIGKILL", 9, create=True), \
                mock.patch.object(gui_platform.os, "killpg", create=True) as killpg, \
                mock.patch.object(gui_platform, "_posix_group_alive", return_value=True), \
                mock.patch.object(gui_platform.time, "monotonic", side_effect=[0.0, 0.3]):
            gui_platform.terminate_process_tree(process, timeout=0.2)
        self.assertEqual(killpg.call_args_list, [mock.call(4321, signal.SIGTERM), mock.call(4321, 9)])
        process.wait.assert_called_once_with(timeout=0.2)

    def test_unowned_group_is_never_guessed_from_pid(self) -> None:
        process = mock.Mock(pid=4321)
        process.poll.return_value = None
        with mock.patch.object(gui_platform.sys, "platform", "darwin"), \
                mock.patch.object(gui_platform.os, "killpg", create=True) as killpg:
            gui_platform.terminate_process_tree(process)
        killpg.assert_not_called()
        process.terminate.assert_called_once()

    def test_linux_zombie_only_group_is_not_waited_on(self) -> None:
        entry = mock.Mock(name="proc_entry")
        entry.name = "4322"
        entry.__truediv__ = mock.Mock(return_value=mock.Mock(read_text=mock.Mock(
            return_value="4322 (synthetic worker) Z 1 4321 4321 0")))
        proc = mock.Mock(is_dir=mock.Mock(return_value=True), iterdir=mock.Mock(return_value=[entry]))
        with mock.patch.object(gui_platform.sys, "platform", "linux"), \
                mock.patch.object(gui_platform.os, "killpg", create=True), \
                mock.patch.object(gui_platform, "Path", return_value=proc):
            self.assertFalse(gui_platform._posix_group_alive(4321))

    def test_linux_live_member_keeps_group_alive(self) -> None:
        entry = mock.MagicMock()
        entry.name = "4322"
        (entry / "stat").read_text.return_value = "4322 (synthetic worker) S 1 4321 4321 0"
        proc = mock.Mock(is_dir=mock.Mock(return_value=True), iterdir=mock.Mock(return_value=[entry]))
        with mock.patch.object(gui_platform.sys, "platform", "linux"), \
                mock.patch.object(gui_platform.os, "killpg", create=True), \
                mock.patch.object(gui_platform, "Path", return_value=proc):
            self.assertTrue(gui_platform._posix_group_alive(4321))

    def test_group_disappearance_probe(self) -> None:
        with mock.patch.object(gui_platform.os, "killpg", side_effect=ProcessLookupError, create=True):
            self.assertFalse(gui_platform._posix_group_alive(4321))

    def test_sigterm_exiting_root_does_not_hide_surviving_child(self) -> None:
        process = mock.Mock(pid=4321, _maw_process_group_id=4321)
        process.poll.side_effect = [None, 0, 0]
        with mock.patch.object(gui_platform.sys, "platform", "darwin"), \
                mock.patch.object(gui_platform.signal, "SIGKILL", 9, create=True), \
                mock.patch.object(gui_platform.os, "killpg", create=True) as killpg, \
                mock.patch.object(gui_platform, "_posix_group_alive", return_value=True), \
                mock.patch.object(gui_platform.time, "monotonic", side_effect=[0.0, 0.3]):
            gui_platform.terminate_process_tree(process, timeout=0.2)
        self.assertEqual(killpg.call_args_list, [mock.call(4321, signal.SIGTERM), mock.call(4321, 9)])
        process.wait.assert_called_once_with(timeout=0.2)


@unittest.skipIf(sys.platform == "win32", "POSIX process groups require a POSIX host")
class RealPosixGroupTests(unittest.TestCase):
    def _assert_dead_root_child_cleanup(self, ignore_term: bool) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            child = root / "child.py"
            child.write_text("import pathlib, signal, sys, time\n"
                             + ("signal.signal(signal.SIGTERM, signal.SIG_IGN)\n" if ignore_term else "")
                             + "pathlib.Path(sys.argv[1]).write_text('ready')\ntime.sleep(60)\n",
                             encoding="utf-8", newline="\n")
            worker = root / "worker.py"
            worker.write_text(
                "import pathlib, subprocess, sys, time\n"
                "p = subprocess.Popen([sys.executable, sys.argv[1], sys.argv[2]], stdout=subprocess.DEVNULL)\n"
                "deadline = time.monotonic() + 5\n"
                "while not pathlib.Path(sys.argv[2]).exists() and time.monotonic() < deadline:\n"
                "    time.sleep(0.01)\n"
                "print(p.pid, flush=True)\n", encoding="utf-8", newline="\n")
            process = gui_platform.popen_process_tree(
                [sys.executable, str(worker), str(child), str(root / "ready")],
                stdout=subprocess.PIPE, text=True, **gui_platform.process_group_kwargs())
            child_pid = None
            try:
                process.wait(timeout=8)
                child_pid = int(process.stdout.readline())
                started = time.monotonic()
                gui_platform.terminate_process_tree(process, timeout=0.2)
                deadline = time.monotonic() + 2
                while _running(child_pid) and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertFalse(_running(child_pid))
                self.assertLess(time.monotonic() - started, 3)
            finally:
                # Group ownership is explicit and local to this synthetic test.
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait(timeout=3)
                process.stdout.close()

    def test_exited_root_live_child_is_reclaimed(self) -> None:
        self._assert_dead_root_child_cleanup(False)

    def test_exited_root_sigterm_ignoring_child_is_reclaimed(self) -> None:
        self._assert_dead_root_child_cleanup(True)


def _running(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    if sys.platform == "linux":
        try:
            return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0] != "Z"
        except FileNotFoundError:
            return False
    # macOS exposes zombie state through its system ps (no extra dependency).
    result = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True,
                            text=True, timeout=2)
    return bool(result.stdout.strip()) and not result.stdout.strip().startswith("Z")


if __name__ == "__main__":
    unittest.main()
