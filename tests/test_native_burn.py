"""Native burn grants and publication. Filesystem fixtures are deliberately retained."""
import errno
import http.client
import json
import os
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from contextlib import ExitStack
from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from pathlib import Path, PurePosixPath
from types import SimpleNamespace
from unittest import mock

if __name__ == "__main__":
    # Skip tempfile's create/unlink probe before importing MAW in the child.
    tempfile.tempdir = sys.argv[1]

    def _protect_fixture_files(event, args):
        if event in {"os.remove", "os.rmdir"}:
            raise AssertionError("native burn HTTP fixture must retain all files")
        if event == "os.rename":
            _, destination, _, fd = args
            try:
                os.stat(destination, dir_fd=None if fd < 0 else fd, follow_symlinks=False)
            except FileNotFoundError:
                return
            raise AssertionError("native burn HTTP fixture refuses to overwrite a file")

    sys.addaudithook(_protect_fixture_files)

from maw.native_burn_host import BURN_JOBS, BurnDialogUnavailable, BurnHost, BurnHostClient, BurnSessions
from maw.native_burn_output import BurnDestination, open_burn_output


def retain_then_create(path: Path, retained: Path, contents: bytes) -> None:
    if os.path.lexists(retained):
        raise AssertionError("fixture backup already exists")
    path.rename(retained)
    with path.open("xb") as output:
        output.write(contents)


# GitHub Windows runners occasionally abort established loopback sockets mid-request
# (WinError 10053) with no server-side fault. Idempotent GET polls retry once to absorb
# that noise; state-changing POSTs stay fail-closed and surface the original error.
TRANSIENT_CONNECTION_ERRORS = (ConnectionAbortedError, ConnectionResetError, BrokenPipeError)


def send_with_transient_retry(send, *, retry_transient_get, attempts=2, delay=0.1):
    """Perform one HTTP exchange, retrying transient loopback aborts for idempotent GETs."""
    for attempt in range(attempts):
        try:
            return send()
        except TRANSIENT_CONNECTION_ERRORS:
            if not retry_transient_get or attempt == attempts - 1:
                raise
            time.sleep(delay)


class NativeBurnHostTests(unittest.TestCase):
    def test_cocoa_save_panel_is_attached_and_can_be_reopened(self):
        from maw.gui_web import _pick_burn_target

        source = Path(tempfile.mkdtemp(prefix="maw-test-native-sheet-")).resolve() / "source.mp4"
        source.write_bytes(b"source")
        output = source.with_name("烧录输出.mp4")
        window = mock.Mock()
        window.gui = SimpleNamespace(__name__="webview.platforms.cocoa")
        window.native.attachedSheet.return_value = None
        window.native.isMiniaturized.return_value = False
        window.create_file_dialog.side_effect = AssertionError("Cocoa must use a window-attached save panel")
        panel = mock.Mock()
        panel.URL.return_value.path.return_value = str(output)
        responses = iter([0, 1])
        panel.beginSheetModalForWindow_completionHandler_.side_effect = (
            lambda _parent, complete: complete(next(responses))
        )
        save_panel = mock.Mock(side_effect=[RuntimeError("panel unavailable"), panel, panel])
        appkit = SimpleNamespace(NSSavePanel=SimpleNamespace(savePanel=save_panel), NSModalResponseOK=1)
        foundation = SimpleNamespace(NSURL=SimpleNamespace(fileURLWithPath_=lambda path: path))
        tools = SimpleNamespace(AppHelper=SimpleNamespace(callAfter=lambda callback: callback()))
        with mock.patch.dict(sys.modules, {"AppKit": appkit, "Foundation": foundation, "PyObjCTools": tools}):
            with self.assertRaisesRegex(RuntimeError, "panel unavailable"):
                _pick_burn_target(window, output.name, source, "en")
            self.assertIsNone(_pick_burn_target(window, output.name, source, "en"))
            self.assertEqual(_pick_burn_target(window, output.name, source, "en").path, output)

        panel.setDirectoryURL_.assert_called_with(str(source.parent))
        panel.setNameFieldStringValue_.assert_called_with(output.name)
        self.assertIs(panel.beginSheetModalForWindow_completionHandler_.call_args.args[0], window.native)
        window.create_confirmation_dialog.assert_not_called()

    def test_confirmation_language_follows_each_editor_request(self):
        from maw.gui_web import _pick_burn_target
        from maw.native_burn_api import NativeBurnJobs, _choose_target

        root = Path(tempfile.mkdtemp(prefix="maw-test-native-language-")).resolve()
        source, output = root / "source.mp4", root / "output.mp4"
        source.write_bytes(b"source")
        output.write_bytes(b"selected file")
        window = mock.Mock()
        window.create_file_dialog.return_value = (str(output),)
        window.create_confirmation_dialog.return_value = False
        with BurnHost(partial(_pick_burn_target, window)) as host:
            client = BurnHostClient.from_environment(host.environment())
            sessions = BurnSessions(client)
            session = sessions.redeem(host.launch_grant())
            server = mock.Mock()
            server.settings_lock = threading.Lock()
            server.project.json_path = None
            server.project.media_path = source
            server.gap_removed_media_source_snapshot.return_value.path = source
            server.binding_generation, server.source_media_id = 1, "media"
            native = NativeBurnJobs(sessions)
            request = {"nativeSession": session, "admissionToken": "a" * 64,
                       "suggestedName": output.name, "language": "zh"}
            self.assertEqual(_choose_target(server, native, request), {"cancelled": True})
            self.assertEqual(window.create_confirmation_dialog.call_args.args[0], "覆盖视频？")
            request["language"] = "en"
            self.assertEqual(_choose_target(server, native, request), {"cancelled": True})
            self.assertEqual(window.create_confirmation_dialog.call_args.args[0], "Overwrite video?")
            request["language"] = "invalid"
            with self.assertRaises(ValueError):
                _choose_target(server, native, request)
        self.assertEqual(output.read_bytes(), b"selected file")

    def test_spawn_channel_only_authorizes_its_child_and_dialog(self):
        root = Path(tempfile.mkdtemp(prefix="maw-test-native-host-")).resolve()
        source = root / "source.mp4"
        source.write_bytes(b"source")
        output = root / "output.mp4"
        output.write_bytes(b"approved overwrite")
        pick = mock.Mock(side_effect=lambda _name, media, _lang: BurnDestination.capture(output, media))
        with BurnHost(pick) as host:
            client = BurnHostClient.from_environment(host.environment())
            impostor = BurnHostClient(client.port, "wrong")
            with self.assertRaises(BurnDialogUnavailable):
                impostor.choose("export.mp4", source)
            pick.assert_not_called()
            with self.assertRaises(ValueError):
                client.choose("../export.mp4", source)
            pick.assert_not_called()
            selected = client.choose("export.mp4", source)
            self.assertEqual(selected.path, output)
            pick.assert_called_once_with("export.mp4", source, "zh")
            retain_then_create(output, root / "retained.mp4", b"changed after the Launcher grant")
            with self.assertRaises(ValueError):
                selected.validate()

    def test_existing_target_requires_launcher_confirmation_and_keeps_its_snapshot(self):
        from maw.gui_web import _pick_burn_target

        root = Path(tempfile.mkdtemp(prefix="maw-test-native-confirm-")).resolve()
        source = root / "source.mp4"
        source.write_bytes(b"source")
        output = root / "output.mp4"
        output.write_bytes(b"selected file")
        new_output = root / "new.mp4"
        window = mock.Mock()
        pick = partial(_pick_burn_target, window)
        with BurnHost(pick) as host:
            client = BurnHostClient.from_environment(host.environment())
            window.create_file_dialog.return_value = None
            self.assertIsNone(client.choose(output.name, source))
            window.create_file_dialog.return_value = (str(new_output),)
            self.assertIsNone(client.choose(new_output.name, source).original)
            window.create_confirmation_dialog.assert_not_called()

            window.create_file_dialog.return_value = (str(source),)
            with self.assertRaises(ValueError):
                client.choose(output.name, source)
            window.create_confirmation_dialog.assert_not_called()

            window.create_file_dialog.return_value = (str(output),)
            window.create_confirmation_dialog.return_value = False
            self.assertIsNone(client.choose(output.name, source))
            self.assertIn(repr(str(output)), window.create_confirmation_dialog.call_args.args[1])
            self.assertEqual(output.read_bytes(), b"selected file")

            window.create_confirmation_dialog.return_value = True
            selected = client.choose(output.name, source)
            self.assertEqual(selected.path, output)
            self.assertIsNotNone(selected.original)
            selected.validate()

            def replaced_during_confirmation(*_args):
                retain_then_create(output, root / "retained.mp4", b"other file")
                return True

            window.create_confirmation_dialog.side_effect = replaced_during_confirmation
            with self.assertRaisesRegex(ValueError, "保存目标或所在文件夹已变更"):
                client.choose(output.name, source)
            self.assertEqual((root / "retained.mp4").read_bytes(), b"selected file")
            self.assertEqual(output.read_bytes(), b"other file")

    def test_launch_grant_is_one_use_and_bound_to_exact_child(self):
        with BurnHost(mock.Mock()) as host, BurnHost(mock.Mock()) as other:
            sessions = BurnSessions(BurnHostClient.from_environment(host.environment()))
            other_sessions = BurnSessions(BurnHostClient.from_environment(other.environment()))
            grant = host.launch_grant()
            with self.assertRaises(PermissionError):
                other_sessions.redeem(grant)
            session = sessions.redeem(grant)
            sessions.require(session)
            with self.assertRaises(PermissionError):
                sessions.redeem(grant)
            with self.assertRaises(PermissionError):
                sessions.require(grant)
            self.assertTrue(host.stop_issuing_grants())
            with self.assertRaises(PermissionError):
                host.launch_grant()
            self.assertFalse(other.stop_issuing_grants())


class NativeBurnOutputTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="maw-test-native-burn-")).resolve()
        self.source = self.root / "source.mp4"
        self.source.write_bytes(b"original")
        self.encoded = self.root / "private.mp4"
        self.encoded.write_bytes(b"encoded")
        self.target = self.root / "output.mp4"
        # Exercise real filesystem checks. Retain unpublished staging files too.
        cleanup = mock.patch("maw.native_burn_output._remove_stage")
        self.addCleanup(cleanup.stop)
        cleanup.start()
        unlink = mock.patch("maw.native_burn_output.os.unlink", side_effect=AssertionError("test must retain files"))
        self.addCleanup(unlink.stop)
        unlink.start()

    def test_new_output_commit_and_identity_checked_open(self):
        destination = BurnDestination.capture(self.target, self.source)
        with destination.stage(self.encoded, lambda: None) as staged:
            published = staged.commit()
        self.assertEqual(self.target.read_bytes(), b"encoded")
        self.assertEqual(self.source.read_bytes(), b"original")
        with mock.patch("maw.native_burn_output._system_open") as launch:
            open_burn_output(published, folder=False)
            self.target.chmod(0o640)  # A desktop opener may also update file metadata.
            open_burn_output(published, folder=True)
            self.assertEqual(launch.call_args_list, [mock.call(self.target), mock.call(self.root)])
            retain_then_create(self.target, self.root / "retained-original-output.mp4", b"replacement")
            with self.assertRaises((OSError, ValueError)):
                open_burn_output(published, folder=False)
            open_burn_output(published, folder=True)
            self.assertEqual(launch.call_args_list[-1], mock.call(self.root))
            self.assertEqual(launch.call_count, 3)

    def test_native_target_can_have_the_source_name_in_another_folder(self):
        other = self.root / "exports"
        other.mkdir()
        target = other / self.source.name
        with BurnDestination.capture(target, self.source).stage(self.encoded, lambda: None) as staged:
            staged.commit()
        self.assertEqual(target.read_bytes(), b"encoded")
        self.assertEqual(self.source.read_bytes(), b"original")

    def test_no_space_flushing_stage_leaves_overwrite_target_and_retains_stage(self):
        self.target.write_bytes(b"approved original")
        destination = BurnDestination.capture(self.target, self.source)
        with mock.patch("maw.native_burn_output.os.fsync", side_effect=OSError(errno.ENOSPC, "fixture full")):
            with self.assertRaises(OSError) as error, destination.stage(self.encoded, lambda: None):
                self.fail("an unflushed stage must not reach publication")
        self.assertEqual(error.exception.errno, errno.ENOSPC)
        self.assertEqual(self.target.read_bytes(), b"approved original")
        self.assertEqual(len(list(self.root.glob(".maw-burn-*.partial"))), 1)

    @unittest.skipUnless(os.name == "posix", "directory fsync after POSIX publication")
    def test_directory_sync_follows_publication_and_failure_keeps_the_saved_result(self):
        destination = BurnDestination.capture(self.target, self.source)
        sync = os.fsync
        synced = []

        def sync_with_directory_error(fd):
            is_directory = stat.S_ISDIR(os.fstat(fd).st_mode)
            synced.append(is_directory)
            if is_directory:
                self.assertEqual(self.target.read_bytes(), b"encoded")
                raise OSError(errno.EIO, "fixture directory sync failure")
            self.assertFalse(self.target.exists())
            sync(fd)

        with mock.patch("maw.native_burn_output.os.fsync", side_effect=sync_with_directory_error):
            with destination.stage(self.encoded, lambda: None) as staged:
                published = staged.commit()
        self.assertEqual(synced, [False, True])
        self.assertTrue(published.sync_warning)
        self.assertEqual(self.target.read_bytes(), b"encoded")

    def test_cancellation_or_target_collision_leaves_original_intact(self):
        destination = BurnDestination.capture(self.target, self.source)
        with self.assertRaises(InterruptedError), destination.stage(self.encoded, mock.Mock(side_effect=InterruptedError)):
            self.fail("cancelled staging yielded a result")
        self.assertFalse(self.target.exists())
        with destination.stage(self.encoded, lambda: None) as staged:
            self.target.write_bytes(b"arrived while saving")
            with self.assertRaises((OSError, ValueError)):
                staged.commit()
        self.assertEqual(self.target.read_bytes(), b"arrived while saving")

    def test_source_and_link_aliases_are_refused(self):
        with self.assertRaises((OSError, ValueError)):
            BurnDestination.capture(self.source, self.source)
        os.link(self.source, self.target)
        with self.assertRaises((OSError, ValueError)):
            BurnDestination.capture(self.target, self.source)
        if os.name != "nt":
            alias = self.root / "alias.mp4"
            alias.symlink_to(self.source)
            with self.assertRaises((OSError, ValueError)):
                BurnDestination.capture(alias, self.source)
        preview = self.root / "preview.mp4"
        preview.write_bytes(b"project preview")
        with self.assertRaisesRegex(ValueError, "不能覆盖工程或源媒体"):
            BurnDestination.capture(preview, self.source, preview)

    def test_modified_overwrite_and_moved_parent_are_refused(self):
        self.target.write_bytes(b"approved original")
        destination = BurnDestination.capture(self.target, self.source)
        with destination.stage(self.encoded, lambda: None) as staged:
            retain_then_create(self.target, self.root / "approved.mp4", b"changed before publication")
            with self.assertRaises((OSError, ValueError)):
                staged.commit()
        self.assertEqual(self.target.read_bytes(), b"changed before publication")

        sub = self.root / "selected"
        sub.mkdir()
        destination = BurnDestination.capture(sub / "export.mp4", self.source)
        sub.rename(self.root / "moved")
        sub.mkdir()
        with self.assertRaises((OSError, ValueError)), destination.stage(self.encoded, lambda: None):
            self.fail("changed directory yielded a result")
        self.assertFalse((sub / "export.mp4").exists())

    @unittest.skipUnless(os.name == "posix", "POSIX can rename a pinned directory")
    def test_publication_does_not_claim_a_path_in_a_moved_directory(self):
        from maw.native_burn_output import UNCONFIRMED, _publish_new

        selected = self.root / "selected"
        selected.mkdir()
        moved = self.root / "moved"
        target = selected / "output.mp4"
        destination = BurnDestination.capture(target, self.source)

        def move_and_publish(*args):
            selected.rename(moved)
            selected.mkdir()
            _publish_new(*args)

        with destination.stage(self.encoded, lambda: None) as staged:
            with mock.patch("maw.native_burn_output._publish_new", side_effect=move_and_publish):
                with self.assertRaisesRegex(ValueError, UNCONFIRMED):
                    staged.commit()
        self.assertFalse(target.exists())
        self.assertEqual((moved / target.name).read_bytes(), b"encoded")

    def test_overwrite_publication_is_not_used_if_replacement_fails(self):
        self.target.write_bytes(b"approved original")
        destination = BurnDestination.capture(self.target, self.source)
        with destination.stage(self.encoded, lambda: None) as staged:
            with mock.patch("maw.native_burn_output.os.replace", side_effect=PermissionError) as replace:
                with self.assertRaises(PermissionError):
                    staged.commit()
                replace.assert_called_once()
        self.assertEqual(self.target.read_bytes(), b"approved original")

    def test_read_only_file_cannot_be_an_overwrite_target(self):
        self.target.write_bytes(b"read only")
        self.target.chmod(0o400)
        with self.assertRaises(PermissionError):
            BurnDestination.capture(self.target, self.source)

    def test_overwrite_target_can_change_after_validation(self):
        self.target.write_bytes(b"approved original")
        destination = BurnDestination.capture(self.target, self.source)
        retained = self.root / "approved.mp4"

        def observe_replace(*_args, **_kwargs):
            retain_then_create(self.target, retained, b"other writer")
            self.assertEqual(self.target.read_bytes(), b"other writer")
            raise InterruptedError("stop before replacing the other writer's file")

        with destination.stage(self.encoded, lambda: None) as staged:
            with mock.patch("maw.native_burn_output.os.replace", side_effect=observe_replace) as replace:
                with self.assertRaises(InterruptedError):
                    staged.commit()
                replace.assert_called_once()
        self.assertEqual(retained.read_bytes(), b"approved original")
        self.assertEqual(self.target.read_bytes(), b"other writer")

    @unittest.skipUnless(os.name == "posix", "POSIX path handoff")
    def test_path_consumer_can_resolve_a_replacement_after_identity_check(self):
        destination = BurnDestination.capture(self.target, self.source)
        with destination.stage(self.encoded, lambda: None) as staged:
            published = staged.commit()

        def resolve_later(path):
            retain_then_create(path, self.root / "retained-video.mp4", b"other writer")
            self.assertEqual(path.read_bytes(), b"other writer")

        with mock.patch("maw.native_burn_output._system_open", side_effect=resolve_later) as launch:
            open_burn_output(published, folder=False)
            launch.assert_called_once_with(self.target)
        self.assertEqual(self.target.read_bytes(), b"other writer")
        self.assertEqual((self.root / "retained-video.mp4").read_bytes(), b"encoded")


class NativeBurnSystemOpenTests(unittest.TestCase):
    def test_nonzero_xdg_exit_is_reported(self):
        from maw.native_burn_output import _system_open

        popen = subprocess.Popen
        native_os_name = os.name
        path = PurePosixPath("/fixture/burn.mp4")

        def spawn(command, **options):
            self.assertEqual(command, ["xdg-open", "/fixture/burn.mp4"])
            self.assertEqual(os.name, native_os_name)
            Path.cwd()  # The real platform's pathlib must remain usable.
            return popen([sys.executable, "-Bc", "raise SystemExit(4)"], **options)

        linux_os = SimpleNamespace(name="posix", environ=os.environ)
        with mock.patch("maw.native_burn_output.sys", SimpleNamespace(platform="linux")), \
                mock.patch("maw.native_burn_output.os", linux_os), \
                mock.patch("maw.native_burn_output.subprocess.Popen", side_effect=spawn):
            with self.assertRaises(subprocess.CalledProcessError) as error:
                _system_open(path)
        self.assertEqual(error.exception.returncode, 4)

    def test_foreground_xdg_handler_is_left_running_and_reaped(self):
        from maw.native_burn_output import _system_open

        reaped = threading.Event()
        process = mock.Mock()

        def wait(timeout=None):
            if timeout is not None:
                raise subprocess.TimeoutExpired("xdg-open", timeout)
            reaped.set()
            return 0

        process.wait.side_effect = wait
        linux_os = SimpleNamespace(name="posix", environ=os.environ)
        with mock.patch("maw.native_burn_output.sys", SimpleNamespace(platform="linux")), \
                mock.patch("maw.native_burn_output.os", linux_os), \
                mock.patch("maw.native_burn_output.subprocess.Popen", return_value=process):
            _system_open(PurePosixPath("/fixture/burn.mp4"))
            self.assertTrue(reaped.wait(2))
        process.kill.assert_not_called()
        process.terminate.assert_not_called()

    def test_windows_open_uses_native_path(self):
        from maw.native_burn_output import _system_open

        path = Path("fixture") / "burn.mp4"
        startfile = mock.Mock()
        with mock.patch("maw.native_burn_output.os", SimpleNamespace(name="nt", startfile=startfile)):
            _system_open(path)
        startfile.assert_called_once_with(str(path), "open")


class NativeBurnLauncherStopTests(unittest.TestCase):
    def test_stop_timeout_keeps_owned_process_and_does_not_close_launcher(self):
        from maw.gui_web import LauncherApi

        api = LauncherApi.__new__(LauncherApi)
        api._stop_server_lock = threading.Lock()
        api._native_burn_host = host = mock.Mock()
        api._native_burn_port = 9876
        api.server_log_file = None
        api.server_process = process = mock.Mock()
        api._emit = mock.Mock()
        process.poll.return_value = None
        process.wait.side_effect = subprocess.TimeoutExpired("serve", 5)
        # Lost response: still preserve the child until its shutdown is known.
        host.stop_issuing_grants.return_value = True
        host.request_editor_shutdown.return_value = False
        with mock.patch("maw.gui_web.terminate_process_tree") as terminate, \
                mock.patch("maw.gui_web.release_process_tree") as release, \
                mock.patch("maw.gui_web._stop_external_maw_server") as stop_external:
            self.assertEqual(api.stop_server()["code"], "server_stop_pending")
            self.assertIs(api.shutdown(), False)
            self.assertIs(api.server_process, process)
            self.assertIs(api._native_burn_host, host)
            host.close.assert_not_called()
            terminate.assert_not_called()
            release.assert_not_called()
            stop_external.assert_not_called()
            api._emit.assert_called_once_with({"type": "editorShutdownPending"})
            process.poll.return_value = 0
            self.assertFalse(api._stop_owned_server())
            self.assertIsNone(api.server_process)
            host.close.assert_called_once_with()
            release.assert_called_once_with(process)

    def test_failed_start_without_any_native_grant_can_still_stop(self):
        from maw.gui_web import LauncherApi

        api = LauncherApi.__new__(LauncherApi)
        api._stop_server_lock = threading.Lock()
        api._native_burn_host = host = mock.Mock()
        api._native_burn_port = 9876
        api.server_log_file = None
        api.server_process = process = mock.Mock()
        process.poll.return_value = None
        host.stop_issuing_grants.return_value = False
        host.request_editor_shutdown.return_value = False
        with mock.patch("maw.gui_web.terminate_process_tree") as terminate, \
                mock.patch("maw.gui_web.release_process_tree"):
            self.assertTrue(api._stop_owned_server())
        terminate.assert_called_once_with(process)
        self.assertIsNone(api.server_process)
        host.close.assert_called_once_with()


class NativeBurnHTTPTests(unittest.TestCase):
    def test_editor_child_authorization_and_complete_publication(self):
        from maw.gui_web import LauncherApi

        root = Path(tempfile.mkdtemp(prefix="maw-test-native-http-")).resolve()
        source = root / "source.mp4"
        project = root / "project.mosp"
        project.write_text("{}", encoding="utf-8")
        next_project = root / "next.mosp"
        next_project.write_text(json.dumps({"media": str(source), "segments": []}), encoding="utf-8")
        tools = os.environ.get("MAW_TEST_NATIVE_BURN_FFMPEG")
        if tools:
            subprocess.run([tools, "-nostdin", "-n", "-loglevel", "error", "-f", "lavfi",
                            "-i", "color=blue:size=160x120:rate=10", "-t", "1", "-c:v", "libx264",
                            "-pix_fmt", "yuv420p", str(source)], check=True, timeout=15)
        else:
            source.write_bytes(b"fixture input")
        source_bytes = source.read_bytes()
        output = root / "saved.mp4"
        output.write_bytes(b"existing file approved for overwrite")
        cancelled_output = root / "cancelled.mp4"
        shutdown_output = root / "shutdown.mp4"
        from maw.gui_web import _pick_burn_target

        window = mock.Mock()
        picker = window.create_file_dialog
        picker_open = threading.Event()
        close_picker = threading.Event()
        selections = iter([(str(output),), (str(output),), (str(cancelled_output),), (str(shutdown_output),)])

        def select(*_args, **_kwargs):
            if not picker_open.is_set():
                picker_open.set()
                if not close_picker.wait(timeout=5):
                    raise TimeoutError("fixture save picker was not released")
                return None
            return next(selections)

        picker.side_effect = select
        window.create_confirmation_dialog.side_effect = [False, True]
        pick = partial(_pick_burn_target, window)
        with BurnHost(pick) as host, (root / "editor.log").open("xb") as log:
            process = subprocess.Popen(
                [sys.executable, "-Bm", "tests.test_native_burn", str(root)],
                env={**os.environ, **host.environment(), "MAW_APP_DATA_ROOT": str(root / "app-data"),
                     "MAW_ENV_FILE": str(root / "unused-config")},
                stdout=log, stderr=subprocess.STDOUT,
            )
            try:
                ready = root / "ready.json"
                # The editor child may rebuild the web bundle on a cold runner
                # (observed on macOS release CI): esbuild can exceed the old
                # 5s window while the process stays healthy. Bound the wait by
                # the child's own lifetime instead of a fixed wall budget.
                for _ in range(1200):
                    if (ready.exists() and ready.stat().st_size) or process.poll() is not None:
                        break
                    time.sleep(0.025)
                if process.poll() is not None:
                    self.fail(f"editor child exited early with {process.returncode}; see {root / 'editor.log'}")
                self.assertTrue(ready.exists(), f"editor child did not publish ready.json; see {root / 'editor.log'}")
                launch = json.loads(ready.read_text())
                port, token = launch["port"], launch["token"]
                origin = f"http://127.0.0.1:{port}"

                def request(suffix, fields=None, *, session=None, from_origin=origin, full_path=None, host_header=None,
                            method=None):
                    headers = {"X-MAW-Request-Token": token}
                    if from_origin:
                        headers["Origin"] = from_origin
                    if host_header:
                        headers["Host"] = host_header
                    if session:
                        headers["X-MAW-Burn-Session"] = session
                    method, body = method or ("GET" if fields is None else "POST"), None
                    if fields is not None:
                        body = json.dumps({"requestToken": token, **fields})
                        headers["Content-Type"] = "application/json"

                    def send():
                        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=12)
                        try:
                            conn.request(method, full_path or (BURN_JOBS + suffix), body, headers)
                            reply = conn.getresponse()
                            data = reply.read()
                            return reply.status, data if reply.headers.get_content_type() == "video/mp4" else json.loads(data)
                        finally:
                            conn.close()

                    return send_with_transient_retry(send, retry_transient_get=(method == "GET"))

                def wait_ready(path, session):
                    for _ in range(200):
                        _, state = request(path, session=session)
                        if state["state"] in {"ready", "failed", "cancelled"}:
                            break
                        time.sleep(0.025)
                    self.assertEqual(state["state"], "ready", state)

                # Use the real Launcher method for the external browser handoff.
                launcher = mock.Mock(server_process=process, _native_burn_host=host, _native_burn_port=port)
                with mock.patch("maw.gui_web._open_external") as browser:
                    self.assertTrue(LauncherApi.open_url(launcher, {"url": origin + "/?lang=zh", "editor": True})["ok"])
                url = browser.call_args.args[0]
                grant = url.split("#maw-burn-host=")[1]
                # Match the CLI's bodyless POST. Shutdown rejects these headers
                # before reading a body; unread bytes can reset the reply on Windows.
                self.assertEqual(request("", method="POST", from_origin="https://example.test",
                                         full_path="/api/shutdown")[0], 403)
                self.assertEqual(request("", method="POST", from_origin=None, host_header="example.test",
                                         full_path="/api/shutdown")[0], 403)
                # The cross-origin guard must reject before parsing any payload.
                self.assertEqual(request("/native-session", method="POST", from_origin="https://example.test")[0], 403)
                status, data = request("/native-session", {"launchGrant": grant})
                self.assertEqual(status, 200, data)
                session = {"nativeSession": data["nativeSession"]}
                self.assertEqual(request("/native-session", {"launchGrant": grant})[0], 403)
                other = {"nativeSession": request("/native-session", {"launchGrant": host.launch_grant()})[1]["nativeSession"]}
                target_fields = {**launch["binding"], "suggestedName": "saved.mp4", "admissionToken": "a" * 64}
                self.assertEqual(request("/native-target", target_fields)[0], 403)
                self.assertEqual(request("/native-target", {**target_fields, **session, "path": str(source)})[0], 400)
                self.assertEqual(request("/native-target", {**target_fields, **session, "bindingGeneration": 999})[0], 409)
                picker.assert_not_called()
                with ThreadPoolExecutor(max_workers=1) as pool:
                    choosing = pool.submit(request, "/native-target", {**target_fields, **session})
                    try:
                        self.assertTrue(picker_open.wait(timeout=5))
                        status, busy = request("/native-target", {**target_fields, **other, "admissionToken": "d" * 64})
                        self.assertEqual(status, 409, busy)
                        self.assertIn("启动器已有保存对话框", busy["error"])
                    finally:
                        close_picker.set()
                    self.assertEqual(choosing.result(timeout=6), (200, {"ok": True, "cancelled": True}))
                self.assertEqual(request("/native-target", {**target_fields, **session})[1], {"ok": True, "cancelled": True})
                self.assertEqual(output.read_bytes(), b"existing file approved for overwrite")
                status, target = request("/native-target", {**target_fields, **session})
                self.assertEqual(status, 200, target)
                self.assertEqual(set(target), {"ok", "name", "nativeTarget"})
                admission = {**launch["binding"], **session, "srt": "1\n00:00:00,000 --> 00:00:00,800\nBurn test\n",
                             "admissionToken": target_fields["admissionToken"], "admissionDeadline": int(time.time() * 1000 + 50000),
                             "nativeTarget": target["nativeTarget"]}
                browser_fields = {"nativeTarget", "nativeSession", "admissionToken", "admissionDeadline"}
                self.assertEqual(request("", {**admission, **other})[0], 403)
                status, job = request("", admission)
                self.assertEqual(status, 202, job)
                self.assertEqual(request("", admission)[0], 403)
                job_url = "/" + job["jobId"]
                self.assertEqual(request(job_url + "/native-open", {**session, "folder": False})[0], 409)
                self.assertEqual(request(job_url, session=other["nativeSession"])[0], 403)
                self.assertEqual(request(job_url + "/cancel", other)[0], 403)
                self.assertEqual(request("/cancel-admission", {"admissionToken": "a" * 64})[0], 403)
                self.assertEqual(request("", {"admissionToken": "a" * 64},
                                         full_path="/api/exports/fcp7-png/jobs/cancel-admission")[0], 403)
                self.assertEqual(request("", session=session["nativeSession"],
                                         full_path="/api/exports/gap-removed-video/jobs" + job_url)[0], 403)
                self.assertEqual(request(job_url + "/download", session=session["nativeSession"])[0], 403)
                wait_ready(job_url, session["nativeSession"])
                self.assertEqual(request(job_url + "/native-save", other)[0], 403)
                self.assertEqual(request(job_url + "/native-save", {**session, "path": str(source)})[0], 400)
                self.assertEqual(output.read_bytes(), b"existing file approved for overwrite")
                with ThreadPoolExecutor(max_workers=1) as pool:
                    save = pool.submit(request, job_url + "/native-save", session)
                    try:
                        for _ in range(200):
                            if (root / "published-cleanup-pending").exists():
                                break
                            time.sleep(0.025)
                        self.assertTrue((root / "published-cleanup-pending").exists())
                        self.assertTrue(output.exists())
                        status, busy = request("", {key: value for key, value in admission.items() if key not in browser_fields})
                        self.assertEqual(status, 409, busy)
                        self.assertIn("另一个媒体导出任务正在进行", busy["error"])
                        status, cancelling = request(job_url + "/cancel", session)
                        self.assertEqual(status, 200)
                        self.assertEqual(cancelling["state"], "downloading")
                        self.assertFalse(cancelling["cleanupComplete"])
                    finally:
                        (root / "allow-published-cleanup").touch()
                    self.assertEqual(save.result(timeout=6), (200, {"ok": True, "name": output.name}))
                self.assertEqual(request(job_url + "/native-save", session)[0], 200)
                self.assertEqual((root / "retained-before-overwrite.mp4").read_bytes(),
                                 b"existing file approved for overwrite")
                self.assertEqual(source.read_bytes(), source_bytes)
                if tools:
                    probe = subprocess.check_output([str(Path(tools).with_name("ffprobe")), "-v", "error",
                                                     "-show_entries", "stream=codec_name", "-of", "csv=p=0", str(output)], timeout=10)
                    self.assertEqual(probe.strip(), b"h264")
                else:
                    self.assertEqual(output.read_bytes(), b"fixture rendered output")
                self.assertEqual(request(job_url + "/native-open", {**session, "folder": True, "path": str(source)})[0], 400)
                opened = request(job_url + "/native-open", {**session, "folder": False})
                self.assertEqual(opened, (200, {"ok": True, "openRequested": True}))
                self.assertEqual(request(job_url + "/native-open", {**session, "folder": True}), opened)
                self.assertEqual((root / "opened.log").read_text().splitlines(), [str(output), str(root)])
                (root / "desktop-open-failure").touch()
                status, failed_open = request(job_url + "/native-open", {**session, "folder": False})
                self.assertEqual(status, 503)
                self.assertFalse(failed_open["ok"])
                self.assertIn("无法向系统发出打开请求", failed_open["error"])

                next_target = {**target_fields, **session, "admissionToken": "b" * 64, "suggestedName": cancelled_output.name}
                status, target = request("/native-target", next_target)
                self.assertEqual(status, 200, target)
                status, job = request("", {**admission, "nativeTarget": target["nativeTarget"],
                                           "admissionToken": next_target["admissionToken"]})
                self.assertEqual(status, 202, job)
                cancel_url = "/" + job["jobId"]
                wait_ready(cancel_url, session["nativeSession"])
                with ThreadPoolExecutor(max_workers=1) as pool:
                    save = pool.submit(request, cancel_url + "/native-save", session)
                    for _ in range(200):
                        if (root / "staged-cancelled").exists():
                            break
                        time.sleep(0.025)
                    self.assertTrue((root / "staged-cancelled").exists())
                    self.assertEqual(request(cancel_url + "/cancel", session)[0], 200)
                    self.assertEqual(save.result(timeout=6)[0], 409)
                self.assertFalse(cancelled_output.exists())
                self.assertEqual(request(cancel_url + "/native-open", {**session, "folder": False})[0], 409)
                intent = {"switchPageId": "burn-fixture", "switchGeneration": 1}
                self.assertEqual(request("", intent, full_path="/api/project/switch-intent")[0], 200)
                status, rebound = request("", {**launch["binding"], **intent, "path": str(next_project)},
                                          full_path="/api/recent-projects/open")
                self.assertEqual(status, 200, rebound)
                self.assertNotEqual(rebound["bindingGeneration"], launch["binding"]["bindingGeneration"])
                self.assertEqual(request(job_url, session=session["nativeSession"])[1]["state"], "completed")
                self.assertEqual(request(job_url + "/native-open", {**session, "folder": True}), opened)
                self.assertEqual(request(job_url + "/native-open", {**other, "folder": True})[0], 403)
                new_binding = {key: rebound[key] for key in launch["binding"]}
                admission.update(new_binding)
                target_fields.update(new_binding)
                retain_then_create(output, root / "retained-saved.mp4", b"other file")
                self.assertIn(request(job_url + "/native-open", {**session, "folder": False})[0], (400, 503))

                # A page without Launcher credentials still receives the usual
                # browser download and cannot convert it into a native open.
                plain_admission = {key: value for key, value in admission.items() if key not in browser_fields}
                status, plain = request("", plain_admission)
                self.assertEqual(status, 202, plain)
                plain_url = "/" + plain["jobId"]
                wait_ready(plain_url, None)
                status, downloaded = request(plain_url + "/download")
                self.assertEqual(status, 200)
                self.assertEqual(downloaded, (root / "retained-saved.mp4").read_bytes())
                self.assertEqual(request(plain_url + "/native-open", {**session, "folder": False})[0], 409)
                # Real job admission prunes disposed records, regardless of age.
                for _ in range(32):
                    status, next_job = request("", plain_admission)
                    self.assertEqual(status, 202, next_job)
                    self.assertEqual(request("/" + next_job["jobId"] + "/cancel", {})[0], 200)
                    for _ in range(200):
                        state = request("/" + next_job["jobId"])[1]
                        if state["cleanupComplete"]:
                            break
                        time.sleep(0.025)
                    self.assertTrue(state["cleanupComplete"], state)
                status, expired = request(job_url + "/native-open", {**session, "folder": False})
                self.assertEqual(status, 410, expired)
                self.assertEqual(expired["code"], "burn_open_expired")
                self.assertEqual(request("/missing/native-open", {"folder": False})[0], 403)
                self.assertEqual((root / "opened.log").read_text().splitlines(), [str(output), str(root), str(root)])

                # Hold stage cleanup beyond the old Launcher deadline.
                next_target = {**target_fields, **session, "admissionToken": "c" * 64,
                               "suggestedName": shutdown_output.name}
                status, target = request("/native-target", next_target)
                self.assertEqual(status, 200, target)
                status, job = request("", {**admission, "nativeTarget": target["nativeTarget"],
                                           "admissionToken": next_target["admissionToken"]})
                self.assertEqual(status, 202, job)
                shutdown_url = "/" + job["jobId"]
                wait_ready(shutdown_url, session["nativeSession"])
                owned = LauncherApi.__new__(LauncherApi)
                owned.server_process, owned._native_burn_host, owned._native_burn_port = process, host, port
                owned._stop_server_lock = threading.Lock()
                owned.server_log_file = None
                with ThreadPoolExecutor(max_workers=1) as pool:
                    save = pool.submit(request, shutdown_url + "/native-save", session)
                    for _ in range(200):
                        if (root / "staged-shutdown").exists():
                            break
                        time.sleep(0.025)
                    self.assertTrue((root / "staged-shutdown").exists())
                    (root / "drop-shutdown-ack").touch()
                    self.assertTrue(owned._stop_owned_server())
                    self.assertEqual(save.result(timeout=6)[0], 409)
                self.assertTrue((root / "shutdown-ack-dropped").exists())
                self.assertTrue((root / "shutdown-stage-cleanup-finished").exists())
                self.assertIn((root / "staged-shutdown").read_text(),
                              (root / "retained-stage-cleanup.log").read_text().splitlines())
                self.assertEqual(process.wait(timeout=5), 0)
                self.assertFalse(shutdown_output.exists())
            finally:
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=5)


class TransientRetryTests(unittest.TestCase):
    """send_with_transient_retry absorbs runner-level loopback aborts without masking real faults."""

    def test_get_poll_retries_a_transient_abort(self):
        calls = []

        def send():
            calls.append(1)
            if len(calls) == 1:
                raise ConnectionAbortedError(10053, "aborted by host software")
            return 200, {"state": "ready"}

        self.assertEqual(send_with_transient_retry(send, retry_transient_get=True),
                         (200, {"state": "ready"}))
        self.assertEqual(len(calls), 2)

    def test_post_is_never_retried(self):
        calls = []

        def send():
            calls.append(1)
            raise ConnectionAbortedError(10053, "aborted by host software")

        with self.assertRaises(ConnectionAbortedError):
            send_with_transient_retry(send, retry_transient_get=False)
        self.assertEqual(len(calls), 1)

    def test_retries_are_exhausted_for_persistent_aborts(self):
        calls = []

        def send():
            calls.append(1)
            raise ConnectionResetError(10054, "reset")

        with self.assertRaises(ConnectionResetError):
            send_with_transient_retry(send, retry_transient_get=True)
        self.assertEqual(len(calls), 2)

    def test_non_transient_errors_propagate_without_retry(self):
        calls = []

        def send():
            calls.append(1)
            raise TimeoutError("request timed out")

        with self.assertRaises(TimeoutError):
            send_with_transient_retry(send, retry_transient_get=True)
        self.assertEqual(len(calls), 1)


def _editor_process(root: Path) -> None:
    """Real editor HTTP server in a child with a retained fixture directory."""
    import importlib.util

    import maw.native_burn_output as output_ops
    from maw.ffmpeg import FfmpegTools
    from maw.native_burn_api import NativeBurnJobs

    tempfile.tempdir = str(root)
    host = BurnHostClient.from_environment(os.environ)
    spec = importlib.util.spec_from_file_location("native_burn_test_serve", "server-editor/serve.py")
    server_module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = server_module
    spec.loader.exec_module(server_module)
    source = root / "source.mp4"
    project = server_module.ServerProject({"segments": []}, root / "project.mosp", source, None, [])
    tools = os.environ.get("MAW_TEST_NATIVE_BURN_FFMPEG")
    if tools:
        ffmpeg = FfmpegTools(Path(tools), Path(tools).with_name("ffprobe"))
    else:
        ffmpeg = FfmpegTools(Path("ffmpeg"), Path("ffprobe"))
    real_open = output_ops._system_open
    real_stage = BurnDestination.stage
    real_replace = os.replace
    send_json = server_module.EditorRequestHandler.send_json

    def simulate_lost_shutdown_ack(handler, status, payload, **options):
        if payload.get("service") == "maw-editor" and (root / "drop-shutdown-ack").exists():
            (root / "shutdown-ack-dropped").touch()
            handler.close_connection = True
            raise BrokenPipeError("fixture disconnected before shutdown response")
        return send_json(handler, status, payload, **options)

    def retain_before_replace(src, dst, *, src_dir_fd=None, dst_dir_fd=None):
        subtitle, burn_script = Path(src), Path(dst)
        if (src_dir_fd is None and dst_dir_fd is None and subtitle.parent == burn_script.parent
                and subtitle.parent.parent == root and subtitle.parent.name.startswith("maw-media-job-")
                and subtitle.match(".burn.maw-burn-*.ass") and burn_script.name == "burn.ass"):
            # The SRT conversion renames its fresh temporary subtitle.
            # The audit hook still verifies the destination is vacant.
            real_replace(src, dst)
            return
        selected = root / "saved.mp4"
        retained = root / "retained-before-overwrite.mp4"
        stage = root / Path(src).name
        match_path = (Path(dst) == selected and Path(src) == stage and src_dir_fd is None and dst_dir_fd is None)
        match_fd = (dst == selected.name and src == stage.name and src_dir_fd == dst_dir_fd and dst_dir_fd is not None
                    and os.path.samestat(os.fstat(dst_dir_fd), root.stat()))
        if not (match_path or match_fd) or not (stage.name.startswith(".maw-burn-") and stage.suffix == ".partial"):
            raise AssertionError("unexpected replace outside the designated burn fixture")
        if selected.read_bytes() != b"existing file approved for overwrite" or os.path.lexists(retained):
            raise AssertionError("the approved fixture cannot be preserved")
        selected.rename(retained)
        if os.path.lexists(selected):
            raise AssertionError("replacement must publish to a vacant fixture path")
        real_replace(src, dst, src_dir_fd=src_dir_fd, dst_dir_fd=dst_dir_fd)

    @contextmanager
    def observed_stage(destination, encoded, check_cancelled):
        with real_stage(destination, encoded, check_cancelled) as staged:
            if destination.path.name == "cancelled.mp4":
                (root / "staged-cancelled").touch()
                for _ in range(200):
                    check_cancelled()
                    time.sleep(0.025)
                raise TimeoutError("test did not cancel the staged job")
            if destination.path.name == "shutdown.mp4":
                (root / "staged-shutdown").write_text(staged.stage.name)
                try:
                    for _ in range(200):
                        check_cancelled()
                        time.sleep(0.025)
                    raise TimeoutError("test did not shut down the staged job")
                finally:
                    time.sleep(2.6)
                    (root / "shutdown-stage-cleanup-finished").touch()
            yield staged
            if destination.path.name == "saved.mp4":
                (root / "published-cleanup-pending").touch()
                for _ in range(200):
                    if (root / "allow-published-cleanup").exists():
                        break
                    time.sleep(0.025)
                else:
                    raise TimeoutError("test did not release publication cleanup")

    open_failed = False

    def record_open(path):
        nonlocal open_failed
        if not open_failed and (root / "desktop-open-failure").exists():
            open_failed = True
            raise subprocess.CalledProcessError(4, "desktop opener")
        if os.environ.get("MAW_TEST_NATIVE_BURN_DESKTOP") == "1":
            real_open(path)
        with (root / "opened.log").open("a", encoding="utf-8") as log:
            log.write(f"{path}\n")

    def simulated_burn(_source, _intervals, _text, result, **_options):
        result.write_bytes(b"fixture rendered output")

    def retain_stage_unlink(path, *, dir_fd=None):
        name = Path(path).name
        if not name.startswith(".maw-burn-") or not name.endswith(".partial"):
            raise AssertionError("only a staging file should reach the cleanup spy")
        with (root / "retained-stage-cleanup.log").open("a", encoding="utf-8") as log:
            log.write(f"{name}\n")

    with ExitStack() as stack:
        stack.enter_context(mock.patch("maw.media_jobs.MediaJob.remove_directory"))
        stack.enter_context(mock.patch("pathlib.Path.unlink", side_effect=lambda **_options: None))
        stack.enter_context(mock.patch("os.unlink", side_effect=retain_stage_unlink))
        stack.enter_context(mock.patch.object(os, "replace", side_effect=retain_before_replace))
        stack.enter_context(mock.patch.object(server_module.EditorRequestHandler, "send_json", simulate_lost_shutdown_ack))
        stack.enter_context(mock.patch.object(output_ops, "_system_open", side_effect=record_open))
        stack.enter_context(mock.patch.object(BurnDestination, "stage", observed_stage))
        stack.enter_context(mock.patch.object(server_module, "editor_ffmpeg_tools", return_value=ffmpeg))
        stack.enter_context(mock.patch.object(server_module.EditorServer, "_thumbnail_base_ready", return_value=False))
        if tools:
            stack.enter_context(mock.patch.object(server_module, "video_encoder_attempts", return_value=("cpu",)))
        else:
            stack.enter_context(mock.patch.object(server_module, "burn_ass_video", side_effect=simulated_burn))
            stack.enter_context(mock.patch.object(server_module.EditorServer, "ensure_libass_supported", return_value=True))
        server = stack.enter_context(server_module.EditorServer(
            ("127.0.0.1", 0), project, no_waveform=True, stickers_dir=str(root / "no-stickers")))
        server.settings = server_module.remember_project(server.settings, root / "next.mosp")
        server.media_jobs.temp_root = root
        server.native_burn = NativeBurnJobs(BurnSessions(host))
        (root / "ready.json").write_text(json.dumps({"port": server.server_port, "token": server.request_token,
            "binding": {"bindingGeneration": server.binding_generation, "sourceMediaId": server.source_media_id}}))
        server.serve_forever(poll_interval=0.05)


if __name__ == "__main__":
    _editor_process(Path(sys.argv[1]))
