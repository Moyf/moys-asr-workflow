"""Managed runtime process cleanup, using only owned synthetic Python workers."""

from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from threading import Event
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from maw.gui_platform import terminate_process_tree  # noqa: E402
from maw.runtimes import base  # noqa: E402


class SyntheticCancelled(base.RuntimeCancelled):
    pass


class RuntimeProcessCleanupTests(unittest.TestCase):
    def run_process(self, command, *, cancel=None, on_line=None):
        return base._run_process(
            command, env=dict(os.environ), cancel=cancel or Event(),
            on_line=on_line or (lambda _line: None), cwd=str(Path.cwd()),
            error_class=base.ManagedRuntimeError, cancelled_class=SyntheticCancelled,
            cancelled_message="synthetic cancellation", message_prefix="synthetic runtime",
        )

    def _assert_owned_worker_reclaimed(self, mode: str) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            child = root / "child.py"
            child.write_text(
                "import os, pathlib, sys, time\n"
                "pathlib.Path(sys.argv[1]).write_text(str(os.getpid()))\n"
                "time.sleep(60)\n", encoding="utf-8", newline="\n",
            )
            worker = root / "worker.py"
            worker.write_text(
                "import json, os, pathlib, subprocess, sys, time\n"
                "pid_file = pathlib.Path(sys.argv[2])\n"
                "child = subprocess.Popen([sys.executable, sys.argv[1], str(pid_file)])\n"
                "deadline = time.monotonic() + 5\n"
                "while not pid_file.exists() and time.monotonic() < deadline:\n"
                "    time.sleep(0.01)\n"
                "print(json.dumps({'root': os.getpid(), 'child': child.pid}), flush=True)\n"
                "time.sleep(60)\n", encoding="utf-8", newline="\n",
            )
            cancel = Event()
            processes = []
            child_pid = None
            child_handle = None
            kernel32 = None

            def capture(*args, **kwargs):
                process = original_popen(*args, **kwargs)
                processes.append(process)
                return process

            def callback(line):
                nonlocal child_pid, child_handle, kernel32
                child_pid = json.loads(line)["child"]
                if sys.platform == "win32":
                    import ctypes
                    from ctypes import wintypes

                    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
                    kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
                    kernel32.OpenProcess.restype = wintypes.HANDLE
                    kernel32.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
                    kernel32.WaitForSingleObject.restype = wintypes.DWORD
                    kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
                    child_handle = kernel32.OpenProcess(0x00100000, False, child_pid)
                    self.assertTrue(child_handle, "synthetic child must be alive before interruption")
                if mode == "cancel":
                    cancel.set()
                elif mode == "interrupt":
                    raise KeyboardInterrupt()
                else:
                    raise ValueError("synthetic callback failure")

            original_popen = base.popen_process_tree
            expected_error = {"interrupt": KeyboardInterrupt, "cancel": SyntheticCancelled,
                              "callback": ValueError}[mode]
            started = time.monotonic()
            try:
                with mock.patch.object(base, "popen_process_tree", side_effect=capture):
                    with self.assertRaises(expected_error):
                        self.run_process([sys.executable, "-u", str(worker), str(child), str(root / "child.pid")],
                                         cancel=cancel, on_line=callback)
                self.assertEqual(len(processes), 1)
                self.assertIsNotNone(processes[0].poll(), "owned root survived interruption")
                self.assertTrue(processes[0].stdout.closed)
                self.assertIsNotNone(child_pid)
                if sys.platform == "win32":
                    self.assertEqual(kernel32.WaitForSingleObject(child_handle, 1000), 0,
                                     "owned child survived interruption")
                else:
                    deadline = time.monotonic() + 2
                    while _pid_running(child_pid) and time.monotonic() < deadline:
                        time.sleep(0.01)
                    self.assertFalse(_pid_running(child_pid), "owned child survived interruption")
                self.assertLess(time.monotonic() - started, 15)
            finally:
                # Negative-baseline runs deliberately leave the old worker
                # alive; always reclaim only the process captured by this test.
                for process in processes:
                    if process.poll() is None:
                        terminate_process_tree(process)
                    if process.stdout is not None and not process.stdout.closed:
                        process.stdout.close()
                if child_handle:
                    kernel32.CloseHandle(child_handle)

    def test_system_exit_reclaims_owned_process(self) -> None:
        process = mock.Mock(stdout=io.StringIO("ready\n"))

        def callback(_line):
            raise SystemExit(9)

        with mock.patch.object(base, "popen_process_tree", return_value=process), \
                mock.patch.object(base, "terminate_process_tree") as terminate, \
                mock.patch.object(base, "release_process_tree") as release:
            with self.assertRaises(SystemExit):
                self.run_process(["synthetic"], on_line=callback)
        terminate.assert_called_once_with(process)
        release.assert_not_called()
        self.assertTrue(process.stdout.closed)

    def test_keyboard_interrupt_reclaims_root_and_child(self) -> None:
        self._assert_owned_worker_reclaimed("interrupt")

    def test_event_cancellation_reclaims_root_and_child(self) -> None:
        self._assert_owned_worker_reclaimed("cancel")

    def test_callback_exception_reclaims_root_and_child(self) -> None:
        self._assert_owned_worker_reclaimed("callback")

    def test_completed_process_waits_and_releases_once_without_termination(self) -> None:
        process = mock.Mock(stdout=io.StringIO("ready\n"))
        process.wait.return_value = 0
        with mock.patch.object(base, "popen_process_tree", return_value=process), \
                mock.patch.object(base, "release_process_tree") as release, \
                mock.patch.object(base, "terminate_process_tree") as terminate:
            self.assertEqual(self.run_process(["synthetic"]), 0)
        process.wait.assert_called_once_with(timeout=0.1)
        release.assert_called_once_with(process)
        terminate.assert_not_called()
        self.assertTrue(process.stdout.closed)

    def test_nonzero_process_maps_json_error_without_double_termination(self) -> None:
        process = mock.Mock(stdout=io.StringIO('{"type":"error","detail":"synthetic detail"}\n'))
        process.wait.return_value = 3
        with mock.patch.object(base, "popen_process_tree", return_value=process), \
                mock.patch.object(base, "release_process_tree") as release, \
                mock.patch.object(base, "terminate_process_tree") as terminate:
            with self.assertRaisesRegex(base.ManagedRuntimeError, "synthetic detail"):
                self.run_process(["synthetic"])
        release.assert_called_once_with(process)
        terminate.assert_not_called()

    def test_cancel_after_stdout_eof_still_reclaims_process(self) -> None:
        cancel = Event()
        process = mock.Mock(stdout=io.StringIO(""))

        def wait(timeout=None):
            cancel.set()
            raise subprocess.TimeoutExpired("synthetic", timeout)

        process.wait.side_effect = wait
        with mock.patch.object(base, "popen_process_tree", return_value=process), \
                mock.patch.object(base, "terminate_process_tree") as terminate:
            with self.assertRaises(SyntheticCancelled):
                self.run_process(["synthetic"], cancel=cancel)
        terminate.assert_called_once_with(process)


def _pid_running(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    # A dead, unreaped Linux descendant is not executing; its inherited pipe
    # is already closed. Other POSIX systems report ESRCH once it is reaped.
    stat = Path(f"/proc/{pid}/stat")
    try:
        if stat.exists() and stat.read_text().split(")", 1)[1].split()[0] == "Z":
            return False
    except OSError:
        return False
    return True


if __name__ == "__main__":
    unittest.main()
