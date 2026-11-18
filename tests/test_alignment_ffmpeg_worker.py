from __future__ import annotations

import json
import io
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from contextlib import ExitStack, contextmanager, redirect_stderr, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
from urllib.request import Request, urlopen

from maw import local_runtime


_TEST_WORKER_TEMP_POLICY = (
    "if os.environ.get('MAW_TEST_PRESERVE_TEMP') == '1':\n"
    "    original_init = tempfile.TemporaryDirectory.__init__\n"
    "    def preserve(self, *args, **kwargs):\n"
    "        original_init(self, *args, **kwargs)\n"
    "        self._finalizer.detach()\n"
    "    tempfile.TemporaryDirectory.__init__ = preserve\n"
    "    tempfile.TemporaryDirectory.cleanup = lambda self: None\n"
)


@contextmanager
def _preserve_test_temporaries(preserve):
    if not preserve:
        yield
        return
    temporary_directory = tempfile.TemporaryDirectory

    def retained_directory(*args, **kwargs):
        directory = temporary_directory(*args, **kwargs)
        directory._finalizer.detach()
        directory.cleanup = lambda: None
        return directory

    with mock.patch.object(tempfile, "TemporaryDirectory", side_effect=retained_directory):
        yield


class TemporaryDirectoryPolicyTests(unittest.TestCase):
    def test_script_entry_temporaries_in_memory(self):
        from maw.timestamp_alignment import TimestampAlignmentError

        entries = (
            "test_gui_script_check_uses_saved_tools_and_default_second_track",
            "test_gui_script_fallback_uses_saved_tools_and_default_second_track",
            "test_cli_script_check_uses_saved_tools_and_default_second_track",
            "test_cli_script_fallback_uses_saved_tools",
        )
        for preserved in (False, True):
            for entry in entries:
                with self.subTest(preserved=preserved, entry=entry):
                    directories = []

                    class Directory:
                        def __init__(self, *args, **kwargs):
                            self.name = "/virtual/script" if kwargs.get("prefix") else "/virtual/root"
                            self._finalizer = SimpleNamespace(detach=mock.Mock())
                            self.cleaned = False
                            directories.append(self)

                        def cleanup(self):
                            self.cleaned = True

                        def __enter__(self):
                            return self.name

                        def __exit__(self, *_args):
                            self.cleanup()

                    fixture = AlignmentFfmpegWorkerTests(entry)
                    root = Path("/virtual/root")
                    fake_media = (root / "tools", root / "media", root / "script", root / "log")
                    with ExitStack() as stack:
                        patches = (
                            mock.patch.dict(os.environ, {"MAW_TEST_PRESERVE_TEMP": "1" if preserved else "0"}),
                            mock.patch.object(tempfile, "TemporaryDirectory", Directory),
                            mock.patch.object(Path, "resolve", lambda path: path),
                            mock.patch.object(Path, "is_file", return_value=True),
                            mock.patch.object(Path, "exists", return_value=True),
                            mock.patch.object(Path, "write_text"),
                            mock.patch.object(fixture, "real_media_tools", return_value=fake_media),
                            mock.patch("maw.script_timestamp_alignment.read_script_lines", return_value=["你好"]),
                            mock.patch("maw.script_timestamp_alignment.resolve_ffmpeg_tool", return_value=root / "ffmpeg"),
                            mock.patch("maw.media.resolve_default_audio_track", return_value=1),
                            mock.patch("maw.script_timestamp_alignment._run_ffmpeg", side_effect=TimestampAlignmentError("IN_MEMORY_STOP")),
                        )
                        for patcher in patches:
                            stack.enter_context(patcher)
                        fixture.setUp()
                        try:
                            with self.assertRaises(AssertionError) as failure:
                                getattr(fixture, entry)()
                        finally:
                            fixture.tearDown()
                            fixture.doCleanups()
                        self.assertIs(tempfile.TemporaryDirectory, Directory)
                    self.assertIn("IN_MEMORY_STOP", str(failure.exception))
                    self.assertEqual(len(directories), 2)
                    self.assertEqual(directories[0]._finalizer.detach.call_count, int(preserved))
                    self.assertEqual(directories[1]._finalizer.detach.call_count, int(preserved))
                    self.assertEqual(directories[0].cleaned, not preserved)
                    self.assertEqual(directories[1].cleaned, not preserved)

    def test_http_route_preserves_both_temporary_directories_in_memory(self):
        from maw import recording_review_server as recording
        from tests.test_server_align import SERVER

        for preserved in (False, True):
            for launcher in (False, True):
                with self.subTest(preserved=preserved, launcher=launcher):
                    state = {"outer": True, "inner": True}
                    directories = []

                    class Directory:
                        def __init__(self, *args, **kwargs):
                            self.inner = kwargs.get("prefix") == "maw-recording-request-"
                            self.name = "/virtual/root/request" if self.inner else "/virtual/root"
                            self._finalizer = SimpleNamespace(detach=mock.Mock())
                            directories.append(self)

                        def cleanup(self):
                            state["inner"] = False
                            if not self.inner:
                                state["outer"] = False

                        def __enter__(self):
                            return self.name

                        def __exit__(self, *_args):
                            self.cleanup()

                    class DeferredThread:
                        def __init__(self, *, target, args, daemon):
                            self.target, self.args = target, args

                        def start(self):
                            pass

                        def is_alive(self):
                            return False

                        def join(self, timeout=None):
                            self.target(*self.args)

                    root = Path("/virtual/root")
                    initial, media, script, log = (root / item for item in ("tools", "media", "script", "log"))
                    job_state = SimpleNamespace(project_path=root / "source.mosp", script_path=script,
                                                media_path=media, project={})
                    job = recording.RecordingReviewJob.__new__(recording.RecordingReviewJob)
                    with mock.patch.object(recording, "input_signature", return_value="signature"):
                        recording.RecordingReviewJob.__init__(job, job_state)
                    job.current_digest = "digest"
                    server = SimpleNamespace(recording_job=job, server_address=("127.0.0.1", 1),
                                             serve_forever=mock.Mock(), shutdown=mock.Mock(), server_close=mock.Mock())
                    handler = SimpleNamespace(path="/api/recording/start", server=server,
                                              read_json=mock.Mock(return_value={"sourceConfirmed": True}),
                                              check_request_token=mock.Mock(), send_json=mock.Mock())
                    fixture = AlignmentFfmpegWorkerTests("test_bundled_tools_cross_actual_worker_boundary")
                    artifact = {"ffmpeg": str(root / "updated-tools" / "ffmpeg"),
                                "ffprobe": str(root / "updated-tools" / "ffprobe")}

                    def response(payload):
                        return io.BytesIO(json.dumps(payload).encode())

                    def open_url(request, timeout):
                        if isinstance(request, Request):
                            SERVER.AlignmentRequestHandler.do_POST(handler)
                            return response({"ok": True})
                        if request.endswith("/api/state"):
                            return response({"requestToken": "token", "recordingInputSignature": "signature",
                                             "alignment": {"defaultSelection": {}}})
                        return response(job.snapshot())

                    def read_text(path, *args, **kwargs):
                        return json.dumps(["ffmpeg", "0:a:1"]) if path == log else "fixture"

                    with ExitStack() as stack:
                        patches = (
                            mock.patch.dict(os.environ, {"MAW_TEST_PRESERVE_TEMP": "1" if preserved else "0"}),
                            mock.patch.object(tempfile, "TemporaryDirectory", Directory),
                            mock.patch.object(Path, "resolve", lambda path: path),
                            mock.patch.object(Path, "mkdir"), mock.patch.object(Path, "chmod"),
                            mock.patch.object(Path, "read_text", read_text),
                            mock.patch.object(fixture, "real_media_tools", return_value=(initial, media, script, log)),
                            mock.patch("maw.gui_web._alignment_server_child_environment", return_value={}),
                            mock.patch.object(SERVER, "load_state", return_value=job_state),
                            mock.patch.object(SERVER, "AlignmentServer", return_value=server),
                            mock.patch.object(threading, "Thread", return_value=SimpleNamespace(start=mock.Mock(), join=mock.Mock())),
                            mock.patch.object(recording, "Thread", DeferredThread),
                            mock.patch.object(recording, "evidence_errors", return_value=[]),
                            mock.patch.object(job, "review", return_value={"review": {"ready": True, "request": {}}}),
                            mock.patch.object(job, "check_inputs"),
                            mock.patch("maw.gui_config.load_env", return_value={}),
                            mock.patch("tests.test_alignment_ffmpeg_worker.urlopen", side_effect=open_url),
                        )
                        for patcher in patches:
                            stack.enter_context(patcher)
                        writes = stack.enter_context(mock.patch.object(Path, "write_text", autospec=True))
                        worker = stack.enter_context(mock.patch.object(
                            local_runtime, "run_timestamp_alignment_in_runtime", return_value={"artifact": artifact}))
                        fixture.setUp()
                        try:
                            fixture.run_recording_http_entry(launcher=launcher)
                        finally:
                            fixture.tearDown()
                            fixture.doCleanups()

                    handler.send_json.assert_called_once()
                    worker.assert_called_once()
                    selection = root / "request" / "selection.json"
                    self.assertEqual(worker.call_args.kwargs["recording_request_path"], selection)
                    self.assertIn(selection, [call.args[0] for call in writes.call_args_list])
                    self.assertEqual(job.snapshot()["status"], "complete")
                    self.assertEqual(len(directories), 2)
                    self.assertEqual(directories[0]._finalizer.detach.call_count, int(preserved))
                    self.assertEqual(directories[1]._finalizer.detach.call_count, int(preserved))
                    self.assertEqual(state, {"outer": preserved, "inner": preserved})

    def test_outer_and_inner_lifecycles_in_memory(self):
        for value, preserved in ((None, False), ("0", False), ("1", True)):
            with self.subTest(value=value):
                state = {"outer": True, "inner": True}

                def clean_outer():
                    state.update(outer=False, inner=False)

                outer = SimpleNamespace(
                    name="/virtual/fixture",
                    _finalizer=SimpleNamespace(detach=mock.Mock()),
                    cleanup=mock.Mock(side_effect=clean_outer),
                )

                class InnerDirectory:
                    def __init__(self):
                        self._finalizer = SimpleNamespace(detach=mock.Mock())

                    def cleanup(self):
                        state["inner"] = False

                    def __enter__(self):
                        return self

                    def __exit__(self, *_args):
                        self.cleanup()

                environment = {} if value is None else {"MAW_TEST_PRESERVE_TEMP": value}
                fake_os = SimpleNamespace(environ=environment)
                fake_tempfile = SimpleNamespace(TemporaryDirectory=InnerDirectory)
                exec(_TEST_WORKER_TEMP_POLICY, {"os": fake_os, "tempfile": fake_tempfile})
                with mock.patch.dict(os.environ), \
                     mock.patch.object(tempfile, "TemporaryDirectory", return_value=outer), \
                     mock.patch.object(Path, "resolve", lambda path: path), \
                     mock.patch.object(Path, "write_text", return_value=0):
                    os.environ.pop("MAW_TEST_PRESERVE_TEMP", None)
                    os.environ.update(environment)
                    fixture = AlignmentFfmpegWorkerTests("test_bundled_tools_cross_actual_worker_boundary")
                    fixture.setUp()
                    try:
                        with fake_tempfile.TemporaryDirectory() as inner:
                            pass
                    finally:
                        fixture.tearDown()
                        fixture.doCleanups()

                self.assertEqual(inner._finalizer.detach.call_count, int(preserved))
                self.assertEqual(outer._finalizer.detach.call_count, int(preserved))
                self.assertEqual(outer.cleanup.call_count, int(not preserved))
                self.assertEqual(state, {"outer": preserved, "inner": preserved})

    def test_default_cleanup_and_explicit_preservation_in_memory(self):
        for value, preserved in ((None, False), ("0", False), ("1", True)):
            with self.subTest(value=value):
                class Finalizer:
                    detached = False

                    def detach(self):
                        self.detached = True

                class TemporaryDirectory:
                    def __init__(self):
                        self._finalizer = Finalizer()
                        self.cleaned = False

                    def cleanup(self):
                        self.cleaned = True

                    def __enter__(self):
                        return self

                    def __exit__(self, *_args):
                        self.cleanup()

                environment = {} if value is None else {"MAW_TEST_PRESERVE_TEMP": value}
                fake_os = SimpleNamespace(environ=environment)
                fake_tempfile = SimpleNamespace(TemporaryDirectory=TemporaryDirectory)
                exec(_TEST_WORKER_TEMP_POLICY, {"os": fake_os, "tempfile": fake_tempfile})
                with fake_tempfile.TemporaryDirectory() as directory:
                    pass
                self.assertEqual(directory._finalizer.detached, preserved)
                self.assertEqual(directory.cleaned, not preserved)


class AlignmentFfmpegWorkerTests(unittest.TestCase):
    def setUp(self):
        self.preserve_temp = os.environ.get("MAW_TEST_PRESERVE_TEMP") == "1"
        self.temp = tempfile.TemporaryDirectory()
        if self.preserve_temp:
            self.temp._finalizer.detach()
        temp_policy = _preserve_test_temporaries(self.preserve_temp)
        temp_policy.__enter__()
        self.addCleanup(temp_policy.__exit__, None, None, None)
        self.root = Path(self.temp.name).resolve()
        if self.preserve_temp:
            temp_root = mock.patch.object(tempfile, "tempdir", str(self.root))
            temp_root.start()
            self.addCleanup(temp_root.stop)
        self.python = sys.executable
        self.system_root = os.environ.get("SYSTEMROOT", "")
        self.helper = self.root / "probe.py"
        repo = str(Path(__file__).resolve().parents[1])
        self.helper.write_text(
            "import json, os, sys\n"
            "if sys.platform == 'darwin' and not os.environ.get('TEST_NATIVE_PLATFORM'): sys.platform = 'linux'\n"
            f"sys.path.insert(0, {repo!r})\n"
            "from maw.ffmpeg import resolve_ffmpeg_tools\n"
            "tools = resolve_ffmpeg_tools()\n"
            "extraction = 'not-run'\n"
            "if os.name != 'nt':\n"
            "    from pathlib import Path\n"
            "    from maw.timestamp_alignment import _extract_audio_span, TimestampAlignmentError\n"
            "    try:\n"
            "        _extract_audio_span(Path('input.wav'), Path('output.wav'), 0, 1000, ffmpeg_path=None)\n"
            "        extraction = 'ok'\n"
            "    except TimestampAlignmentError:\n"
            "        extraction = 'missing'\n"
            "print(json.dumps({'type':'result', 'command':sys.argv[1], 'ffmpeg':str(tools.ffmpeg or ''), "
            "'ffprobe':str(tools.ffprobe or ''), 'extraction':extraction}))\n",
            encoding="utf-8",
        )

    def tearDown(self):
        if not self.preserve_temp:
            self.temp.cleanup()

    def tools(self, directory, *names):
        directory.mkdir(parents=True, exist_ok=True)
        result = {}
        for name in names:
            path = directory / (name + (".exe" if os.name == "nt" else ""))
            path.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            path.chmod(0o755)
            result[name] = str(path.resolve())
        return result

    def run_child(self, *, env, config=None):
        env = {**({"SYSTEMROOT": self.system_root} if self.system_root else {}), **env}
        status = SimpleNamespace(ready=True, python_path=self.python)
        kwargs = {"model_id": "qwen"}
        if config is not None:
            kwargs["ffmpeg_path"] = config
        with mock.patch.dict(os.environ, env, clear=True), \
             mock.patch.object(sys, "frozen", True, create=True), \
             mock.patch.object(sys, "executable", str(self.root / "MAW.exe")), \
             mock.patch.object(sys, "platform", "linux" if sys.platform == "darwin" and not env.get("TEST_NATIVE_PLATFORM") else sys.platform), \
             mock.patch.object(sys, "_MEIPASS", str(self.root / "resources"), create=True), \
             mock.patch.object(local_runtime, "managed_runtime_status", return_value=status), \
             mock.patch.object(local_runtime.LOCAL, "bundle_path", return_value=self.helper):
            return local_runtime.run_timestamp_alignment_in_runtime(**kwargs)

    def test_bundled_tools_cross_actual_worker_boundary(self):
        bundled = self.tools(self.root / "ffmpeg" / "bin", "ffmpeg", "ffprobe")
        result = self.run_child(env={"PATH": "", "PYTHONDONTWRITEBYTECODE": "1"})
        self.assertEqual((result["ffmpeg"], result["ffprobe"]), (bundled["ffmpeg"], bundled["ffprobe"]))
        if os.name != "nt":
            self.assertEqual(result["extraction"], "ok")

    def test_all_alignment_worker_modes_receive_bundled_tools(self):
        bundled = self.tools(self.root / "ffmpeg" / "bin", "ffmpeg", "ffprobe")
        status = SimpleNamespace(ready=True, python_path=self.python)
        with mock.patch.dict(os.environ, {"PATH": "", "PYTHONDONTWRITEBYTECODE": "1", **({"SYSTEMROOT": self.system_root} if self.system_root else {})}, clear=True), \
             mock.patch.object(sys, "frozen", True, create=True), \
             mock.patch.object(sys, "executable", str(self.root / "MAW.exe")), \
             mock.patch.object(sys, "platform", "linux" if sys.platform == "darwin" else sys.platform), \
             mock.patch.object(sys, "_MEIPASS", str(self.root / "resources"), create=True), \
             mock.patch.object(local_runtime, "managed_runtime_status", return_value=status), \
             mock.patch.object(local_runtime.LOCAL, "bundle_path", return_value=self.helper):
            for expected, options in (
                ("timestamp-align", {}),
                ("script-align", {"script_path": "script.txt"}),
                ("recording-align", {"script_path": "script.txt", "recording_request_path": "request.json"}),
                ("recording-fill", {"script_path": "script.txt", "recording_request_path": "request.json", "recording_operation": "fill"}),
            ):
                with self.subTest(command=expected):
                    result = local_runtime.run_timestamp_alignment_in_runtime(model_id="qwen", **options)
                    self.assertEqual(result["command"], expected)
                    self.assertEqual((result["ffmpeg"], result["ffprobe"]), (bundled["ffmpeg"], bundled["ffprobe"]))

    def test_precedence_invalid_partial_and_missing(self):
        bundled = self.tools(self.root / "ffmpeg" / "bin", "ffmpeg", "ffprobe")
        path = self.tools(self.root / "path", "ffmpeg", "ffprobe")
        custom = self.tools(self.root / "custom", "ffmpeg")
        cases = [
            ({"PATH": str(self.root / "path")}, None, bundled["ffmpeg"], bundled["ffprobe"]),
            ({"PATH": str(self.root / "path"), "FFMPEG_PATH": str(self.root / "custom")}, None, custom["ffmpeg"], bundled["ffprobe"]),
            ({"PATH": str(self.root / "path"), "FFMPEG_PATH": custom["ffmpeg"]}, None, custom["ffmpeg"], bundled["ffprobe"]),
            ({"PATH": str(self.root / "path"), "FFMPEG_PATH": str(self.root / "invalid")}, None, bundled["ffmpeg"], bundled["ffprobe"]),
            ({"PATH": str(self.root / "path"), "FFMPEG_PATH": str(self.root / "path")}, str(self.root / "custom"), custom["ffmpeg"], bundled["ffprobe"]),
        ]
        for env, config, expected_ffmpeg, expected_probe in cases:
            with self.subTest(env=env, config=config):
                env["PYTHONDONTWRITEBYTECODE"] = "1"
                result = self.run_child(env=env, config=config)
                self.assertEqual((result["ffmpeg"], result["ffprobe"]), (expected_ffmpeg, expected_probe))
        # No bundle or explicit setting: PATH is the only candidate.
        other = self.root / "other"
        other.mkdir()
        old_root, self.root = self.root, other
        try:
            result = self.run_child(env={"PATH": str(old_root / "path"), "PYTHONDONTWRITEBYTECODE": "1"})
            self.assertEqual((result["ffmpeg"], result["ffprobe"]), (path["ffmpeg"], path["ffprobe"]))
            result = self.run_child(env={"PATH": "", "PYTHONDONTWRITEBYTECODE": "1"})
            self.assertEqual((result["ffmpeg"], result["ffprobe"]), ("", ""))
            if os.name != "nt":
                self.assertEqual(result["extraction"], "missing")
        finally:
            self.root = old_root

    @unittest.skipUnless(os.name == "nt", "Windows PATHEXT behavior")
    def test_worker_does_not_treat_scripts_as_executables(self):
        for tool in ("ffmpeg", "ffprobe"):
            for suffix in (".py", ".cmd"):
                (self.root / (tool + suffix)).write_text("fixture", encoding="utf-8")
        env = {"PATH": str(self.root), "PATHEXT": ".PY;.CMD;.EXE", "PYTHONDONTWRITEBYTECODE": "1"}
        if "SYSTEMROOT" in os.environ:
            env["SYSTEMROOT"] = os.environ["SYSTEMROOT"]
        result = self.run_child(env=env)
        self.assertEqual((result["ffmpeg"], result["ffprobe"]), ("", ""))

    @unittest.skipUnless(sys.platform == "darwin" and Path("/opt/homebrew/bin/ffprobe").is_file(), "requires macOS Homebrew ffprobe")
    def test_partial_configuration_preserves_bundled_probe_before_homebrew(self):
        bundled = self.tools(self.root / "ffmpeg" / "bin", "ffmpeg", "ffprobe")
        custom = self.tools(self.root / "custom", "ffmpeg")
        result = self.run_child(env={"PATH": "", "FFMPEG_PATH": str(self.root / "custom"), "PYTHONDONTWRITEBYTECODE": "1", "TEST_NATIVE_PLATFORM": "1"})
        self.assertEqual((result["ffmpeg"], result["ffprobe"]), (custom["ffmpeg"], bundled["ffprobe"]))

    def test_inherited_internal_probe_override_is_not_trusted_by_parent(self):
        rogue = self.tools(self.root / "rogue", "ffprobe")
        result = self.run_child(env={"PATH": "", "_MAW_ALIGNMENT_FFPROBE_PATH": rogue["ffprobe"], "PYTHONDONTWRITEBYTECODE": "1"})
        self.assertEqual((result["ffmpeg"], result["ffprobe"]), ("", ""))

    def test_internal_probe_rejects_wrong_filename_and_missing_file(self):
        from maw.ffmpeg import resolve_ffmpeg_tools
        tools = self.tools(self.root / "path", "ffmpeg", "ffprobe")
        for override in (tools["ffmpeg"], str(self.root / "missing" / Path(tools["ffprobe"]).name)):
            with self.subTest(override=override):
                result = resolve_ffmpeg_tools(environment={"PATH": str(self.root / "path"), "_MAW_ALIGNMENT_FFPROBE_PATH": override}, include_bundled=False, include_macos=False)
                self.assertEqual(str(result.ffprobe), tools["ffprobe"])

    def test_explicit_probe_precedes_internal_worker_probe(self):
        from maw.ffmpeg import resolve_ffmpeg_tool, resolve_ffmpeg_tools
        explicit = self.tools(self.root / "explicit", "ffmpeg", "ffprobe")
        internal = self.tools(self.root / "internal", "ffprobe")
        self.tools(self.root / "partial", "ffmpeg")
        env = {"PATH": "", "_MAW_ALIGNMENT_FFPROBE_PATH": internal["ffprobe"]}
        selected = resolve_ffmpeg_tools(self.root / "explicit", environment=env, include_bundled=False, include_macos=False)
        self.assertEqual(str(selected.ffprobe), explicit["ffprobe"])
        self.assertEqual(str(resolve_ffmpeg_tool("ffprobe", explicit["ffprobe"], environment=env, include_bundled=False, include_macos=False)), explicit["ffprobe"])
        missing = resolve_ffmpeg_tools(self.root / "missing", environment=env, include_bundled=False, include_macos=False)
        self.assertEqual(str(missing.ffprobe), internal["ffprobe"])
        partial = resolve_ffmpeg_tools(self.root / "partial", environment=env, include_bundled=False, include_macos=False)
        self.assertEqual(str(partial.ffprobe), internal["ffprobe"])
        implicit = resolve_ffmpeg_tools(environment={**env, "FFMPEG_PATH": str(self.root / "explicit")}, include_bundled=False, include_macos=False)
        self.assertEqual(str(implicit.ffprobe), internal["ffprobe"])
        strict = resolve_ffmpeg_tools(self.root / "missing", environment=env, include_bundled=False, include_macos=False, strict_config=True)
        self.assertIsNone(strict.ffprobe)

    def test_gui_passes_saved_configuration_to_actual_worker(self):
        from maw.gui_web import LauncherApi, LauncherPaths

        custom = self.tools(self.root / "custom", "ffmpeg", "ffprobe")
        self.tools(self.root / "ffmpeg" / "bin", "ffmpeg", "ffprobe")
        api = LauncherApi(paths=LauncherPaths(root=self.root, env_path=self.root / "config", launcher_html=self.root / "launcher.html"), window_getter=lambda: None)
        status = SimpleNamespace(ready=True, python_path=self.python)
        def run_real(**kwargs):
            result = local_runtime.run_timestamp_alignment_in_runtime(**kwargs)
            return {"artifact": {"projectPath": result["ffmpeg"]}, "report": {"ffprobe": result["ffprobe"]}}

        with mock.patch.dict(os.environ, {"PATH": "", "PYTHONDONTWRITEBYTECODE": "1", **({"SYSTEMROOT": self.system_root} if self.system_root else {})}, clear=True), \
             mock.patch.object(sys, "frozen", True, create=True), \
             mock.patch.object(sys, "executable", str(self.root / "MAW.exe")), \
             mock.patch.object(sys, "platform", "linux" if sys.platform == "darwin" else sys.platform), \
             mock.patch.object(sys, "_MEIPASS", str(self.root / "resources"), create=True), \
             mock.patch.object(local_runtime, "managed_runtime_status", return_value=status), \
             mock.patch.object(local_runtime.LOCAL, "bundle_path", return_value=self.helper), \
             mock.patch.object(api, "_local_runtime_status", return_value=status), \
             mock.patch("maw.gui_web.effective_config", return_value=SimpleNamespace(model_cache_root="")), \
             mock.patch("maw.gui_config.load_env", return_value={"FFMPEG_PATH": str(self.root / "custom")}), \
             mock.patch("maw.gui_web.inspect_alignment_model", return_value=SimpleNamespace(status="ready", installed=True)), \
             mock.patch("maw.gui_web.run_timestamp_alignment_in_runtime", side_effect=run_real):
            result = api.run_timestamp_alignment({"alignmentMode": "script", "modelId": "qwen", "scriptPath": "script.txt", "mediaPath": "audio.wav"})
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["projectPath"], custom["ffmpeg"])
        self.assertEqual(result["report"]["ffprobe"], custom["ffprobe"])

    def real_media_tools(self):
        ffmpeg = shutil.which("ffmpeg")
        ffprobe = shutil.which("ffprobe")
        if os.name == "nt" or not ffmpeg or not ffprobe:
            self.skipTest("requires existing POSIX FFmpeg and FFprobe")
        directory = self.root / "real tools"
        directory.mkdir()
        log = self.root / "calls.jsonl"
        for name, executable in (("ffmpeg", ffmpeg), ("ffprobe", ffprobe)):
            wrapper = directory / name
            wrapper.write_text(
                f"#!{self.python}\nimport json, os, sys\n"
                f"with open({str(log)!r}, 'a', encoding='utf-8') as out: out.write(json.dumps([{name!r}] + sys.argv[1:]) + '\\n')\n"
                f"os.execv({executable!r}, [{executable!r}] + sys.argv[1:])\n", encoding="utf-8")
            wrapper.chmod(0o755)
        media = self.root / "two-tracks.mkv"
        subprocess.run([ffmpeg, "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-f", "lavfi", "-i", "sine=frequency=880:duration=1", "-map", "0:a", "-map", "1:a", "-c:a", "pcm_s16le", "-disposition:a:0", "0", "-disposition:a:1", "default", str(media)], check=True)
        script = self.root / "script.txt"
        script.write_text("你好。\n", encoding="utf-8")
        return directory, media, script, log

    def symlinked_media_tools(self):
        directory, media, script, log = self.real_media_tools()
        versions = self.root / "versions"
        custom = self.root / "custom"
        path = self.root / "search-path"
        for item in (versions, custom, path):
            item.mkdir()
        for name, link_dir in (("ffmpeg", custom), ("ffprobe", path), ("ffmpeg", path)):
            target = versions / (name + ("-alternate" if name == "ffmpeg" and link_dir == path else "-7"))
            contents = (directory / name).read_text(encoding="utf-8")
            if name == "ffmpeg":
                label = "ffmpeg-custom" if link_dir == custom else "ffmpeg-alternate"
                contents = contents.replace("['ffmpeg']", f"[{label!r}]")
            target.write_text(contents, encoding="utf-8")
            target.chmod(0o755)
            (link_dir / name).symlink_to(target)
        return custom, path, media, script, log

    def test_symlinked_distinct_tools_survive_real_worker_and_default_track(self):
        custom, path, media, _, log = self.symlinked_media_tools()
        output = self.root / "worker-chunk.wav"
        repo = str(Path(__file__).resolve().parents[1])
        self.helper.write_text(
            "import json, sys\n"
            "if sys.platform == 'darwin': sys.platform = 'linux'\n"
            f"sys.path.insert(0, {repo!r})\n"
            "from pathlib import Path\nfrom maw.ffmpeg import resolve_ffmpeg_tools\n"
            "from maw.media import resolve_default_audio_track\n"
            "from maw.timestamp_alignment import _extract_audio_span\n"
            f"media = Path({str(media)!r})\n"
            "tools = resolve_ffmpeg_tools()\n"
            "track = resolve_default_audio_track(media, None)\n"
            f"_extract_audio_span(media, Path({str(output)!r}), 0, 500, ffmpeg_path=None)\n"
            "print(json.dumps({'type':'result', 'ffmpeg':str(tools.ffmpeg), 'ffprobe':str(tools.ffprobe), 'track':track}))\n",
            encoding="utf-8")
        result = self.run_child(env={"PATH": str(path), "FFMPEG_PATH": str(custom), "PYTHONDONTWRITEBYTECODE": "1"})
        self.assertEqual(result["ffmpeg"], str(custom / "ffmpeg"))
        self.assertEqual(result["ffprobe"], str(path / "ffprobe"))
        self.assertEqual(result["track"], 1)
        self.assertTrue(output.is_file())
        calls = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]
        self.assertTrue(any(call[0] == "ffprobe" for call in calls))
        self.assertTrue(any(call[0] == "ffmpeg-custom" for call in calls))
        self.assertFalse(any(call[0] == "ffmpeg-alternate" for call in calls))

    def test_symlinked_tools_gui_check_and_missing_probe_fallback(self):
        from maw.gui_web import LauncherApi, LauncherPaths
        custom, path, media, script, log = self.symlinked_media_tools()
        api = LauncherApi(paths=LauncherPaths(root=self.root, env_path=self.root / "config", launcher_html=self.root / "launcher.html"), window_getter=lambda: None)
        with mock.patch.object(sys, "platform", "linux" if sys.platform == "darwin" else sys.platform), \
             mock.patch("maw.gui_config.load_env", return_value={"FFMPEG_PATH": str(custom)}):
            for search_path, expected in ((str(path), 1), ("", 0)):
                with self.subTest(path=search_path), mock.patch.dict(os.environ, {"PATH": search_path, "PYTHONDONTWRITEBYTECODE": "1"}, clear=True):
                    result = api.check_script_alignment({"scriptPath": str(script), "mediaPath": str(media)})
                    self.assertTrue(result["ok"], result)
                    self.assertEqual(result["report"]["audioTrack"], expected)
        calls = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]
        self.assertTrue(any(call[0] == "ffmpeg-custom" and "0:a:1" in call for call in calls))
        self.assertTrue(any(call[0] == "ffmpeg-custom" and "0:a:0" in call for call in calls))
        self.assertFalse(any(call[0] == "ffmpeg-alternate" for call in calls))

    def test_failed_probe_falls_back_to_zero_but_explicit_track_wins(self):
        from maw.gui_web import LauncherApi, LauncherPaths
        custom, _, media, script, log = self.symlinked_media_tools()
        failing = self.root / "failing-probe"
        failing.mkdir()
        probe = failing / "ffprobe"
        probe.write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
        probe.chmod(0o755)
        api = LauncherApi(paths=LauncherPaths(root=self.root, env_path=self.root / "config", launcher_html=self.root / "launcher.html"), window_getter=lambda: None)
        with mock.patch.dict(os.environ, {"PATH": str(failing), "PYTHONDONTWRITEBYTECODE": "1"}, clear=True), \
             mock.patch.object(sys, "platform", "linux" if sys.platform == "darwin" else sys.platform), \
             mock.patch("maw.gui_config.load_env", return_value={"FFMPEG_PATH": str(custom)}):
            for explicit, expected in ((None, 0), (1, 1)):
                with self.subTest(explicit=explicit):
                    result = api.check_script_alignment({"scriptPath": str(script), "mediaPath": str(media), "audioTrack": explicit})
                    self.assertTrue(result["ok"], result)
                    self.assertEqual(result["report"]["audioTrack"], expected)
        calls = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]
        self.assertTrue(any(call[0] == "ffmpeg-custom" and "0:a:0" in call for call in calls))
        self.assertTrue(any(call[0] == "ffmpeg-custom" and "0:a:1" in call for call in calls))

    def test_symlinked_tools_gui_current_runtime_uses_default_track(self):
        from maw.gui_web import LauncherApi, LauncherPaths
        from maw.timestamp_alignment import TimedToken
        custom, path, media, script, log = self.symlinked_media_tools()
        api = LauncherApi(paths=LauncherPaths(root=self.root, env_path=self.root / "config", launcher_html=self.root / "launcher.html"), window_getter=lambda: None)
        backend = SimpleNamespace(align=lambda *args, **kwargs: [TimedToken("你好", 0, 500)])
        with mock.patch.dict(os.environ, {"PATH": str(path), "PYTHONDONTWRITEBYTECODE": "1"}, clear=True), \
             mock.patch.object(sys, "platform", "linux" if sys.platform == "darwin" else sys.platform), \
             mock.patch("maw.gui_config.load_env", return_value={"FFMPEG_PATH": str(custom)}), \
             mock.patch("maw.gui_web.effective_config", return_value=SimpleNamespace(model_cache_root="")), \
             mock.patch.object(api, "_local_runtime_status", return_value=SimpleNamespace(ready=False)), \
             mock.patch("maw.gui_web.inspect_alignment_model", return_value=SimpleNamespace(status="ready", installed=True)), \
             mock.patch("maw.script_timestamp_alignment.QwenForcedAlignerBackend", return_value=backend):
            result = api.run_timestamp_alignment({"alignmentMode": "script", "modelId": "qwen", "scriptPath": str(script), "mediaPath": str(media)})
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["report"]["audioTrack"], 1)
        calls = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]
        self.assertTrue(any(call[0] == "ffmpeg-custom" and "0:a:1" in call for call in calls))
        self.assertFalse(any(call[0] == "ffmpeg-alternate" for call in calls))

    def test_symlinked_resolved_paths_keep_identity_and_priority(self):
        from maw.ffmpeg import resolve_ffmpeg_tool, resolve_ffmpeg_tools
        custom, path, _, _, _ = self.symlinked_media_tools()
        environment = {"PATH": str(path)}
        tools = resolve_ffmpeg_tools(configured_path=custom / "ffmpeg", environment=environment, include_bundled=False, include_macos=False)
        self.assertEqual(tools.ffmpeg, custom / "ffmpeg")
        self.assertEqual(tools.ffprobe, path / "ffprobe")
        self.assertEqual(resolve_ffmpeg_tool("ffmpeg", tools.ffmpeg, environment=environment, include_bundled=False, include_macos=False), tools.ffmpeg)
        self.assertEqual(resolve_ffmpeg_tool("ffprobe", tools.ffprobe, environment=environment, include_bundled=False, include_macos=False), tools.ffprobe)
        fallback = resolve_ffmpeg_tools(configured_path=self.root / "invalid", environment=environment, include_bundled=False, include_macos=False)
        self.assertEqual(fallback.ffmpeg, path / "ffmpeg")
        self.assertEqual(fallback.ffprobe, path / "ffprobe")

    def test_user_configured_unrecognised_file_remains_invalid(self):
        from maw.ffmpeg import resolve_ffmpeg_tools
        directory, _, _, _ = self.real_media_tools()
        arbitrary = self.root / "ffmpeg-7"
        arbitrary.write_text((directory / "ffmpeg").read_text(encoding="utf-8"), encoding="utf-8")
        arbitrary.chmod(0o755)
        result = resolve_ffmpeg_tools(configured_path=arbitrary, environment={"PATH": ""}, strict_config=True)
        self.assertIsNone(result.ffmpeg)
        self.assertIsNone(result.ffprobe)

    def test_gui_script_check_uses_saved_tools_and_default_second_track(self):
        from maw.gui_web import LauncherApi, LauncherPaths
        directory, media, script, log = self.real_media_tools()
        api = LauncherApi(paths=LauncherPaths(root=self.root, env_path=self.root / "config", launcher_html=self.root / "launcher.html"), window_getter=lambda: None)
        with mock.patch.dict(os.environ, {"PATH": "", "PYTHONDONTWRITEBYTECODE": "1"}, clear=True), \
             mock.patch.object(sys, "platform", "linux" if sys.platform == "darwin" else sys.platform), \
             mock.patch("maw.gui_config.load_env", return_value={"FFMPEG_PATH": str(directory)}):
            result = api.check_script_alignment({"scriptPath": str(script), "mediaPath": str(media)})
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["report"]["audioTrack"], 1)
        calls = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]
        self.assertTrue(any(call[0] == "ffprobe" for call in calls))
        self.assertTrue(any(call[0] == "ffmpeg" and "0:a:1" in call for call in calls))

    def test_gui_explicit_configuration_precedes_inherited_internal_probe(self):
        from maw.gui_web import LauncherApi, LauncherPaths
        directory, media, script, log = self.real_media_tools()
        internal = self.root / "internal"
        internal.mkdir()
        probe = internal / "ffprobe"
        probe.write_text(f"#!{self.python}\nprint('{{\"streams\":[{{\"index\":0,\"disposition\":{{\"default\":1}}}},{{\"index\":1,\"disposition\":{{\"default\":0}}}}]}}')\n", encoding="utf-8")
        probe.chmod(0o755)
        api = LauncherApi(paths=LauncherPaths(root=self.root, env_path=self.root / "config", launcher_html=self.root / "launcher.html"), window_getter=lambda: None)
        environment = {"PATH": "", "_MAW_ALIGNMENT_FFPROBE_PATH": str(probe), "PYTHONDONTWRITEBYTECODE": "1"}
        with mock.patch.dict(os.environ, environment, clear=True), \
             mock.patch.object(sys, "platform", "linux" if sys.platform == "darwin" else sys.platform), \
             mock.patch("maw.gui_config.load_env", return_value={"FFMPEG_PATH": str(directory)}):
            result = api.check_script_alignment({"scriptPath": str(script), "mediaPath": str(media)})
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["report"]["audioTrack"], 1)
        calls = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]
        self.assertTrue(any(call[0] == "ffprobe" for call in calls))
        self.assertTrue(any(call[0] == "ffmpeg" and "0:a:1" in call for call in calls))

    def test_worker_explicit_probe_precedes_inherited_internal_probe(self):
        directory, media, _, _ = self.real_media_tools()
        partial = self.root / "partial"
        partial.mkdir()
        ffmpeg = partial / "ffmpeg"
        ffmpeg.write_text((directory / "ffmpeg").read_text(encoding="utf-8"), encoding="utf-8")
        ffmpeg.chmod(0o755)
        internal = self.root / "internal"
        internal.mkdir()
        probe = internal / "ffprobe"
        probe.write_text(f"#!{self.python}\nprint('{{\"streams\":[{{\"index\":0,\"disposition\":{{\"default\":1}}}},{{\"index\":1,\"disposition\":{{\"default\":0}}}}]}}')\n", encoding="utf-8")
        probe.chmod(0o755)
        repo = str(Path(__file__).resolve().parents[1])
        self.helper.write_text(
            "import json, sys\n"
            "if sys.platform == 'darwin': sys.platform = 'linux'\n"
            f"sys.path.insert(0, {repo!r})\n"
            "from pathlib import Path\nfrom maw.media import resolve_default_audio_track\n"
            f"media = Path({str(media)!r})\n"
            f"explicit = resolve_default_audio_track(media, None, ffprobe_path=Path({str(directory / 'ffprobe')!r}))\n"
            "implicit = resolve_default_audio_track(media, None)\n"
            "print(json.dumps({'type':'result', 'explicit':explicit, 'implicit':implicit}))\n", encoding="utf-8")
        result = self.run_child(env={"PATH": str(internal), "FFMPEG_PATH": str(partial), "PYTHONDONTWRITEBYTECODE": "1"})
        self.assertEqual(result["explicit"], 1)
        self.assertEqual(result["implicit"], 0)

    def test_gui_script_fallback_uses_saved_tools_and_default_second_track(self):
        from maw.gui_web import LauncherApi, LauncherPaths
        from maw.timestamp_alignment import TimedToken
        directory, media, script, log = self.real_media_tools()
        api = LauncherApi(paths=LauncherPaths(root=self.root, env_path=self.root / "config", launcher_html=self.root / "launcher.html"), window_getter=lambda: None)
        backend = SimpleNamespace(align=lambda *args, **kwargs: [TimedToken("你好", 0, 500)])
        with mock.patch.dict(os.environ, {"PATH": "", "PYTHONDONTWRITEBYTECODE": "1"}, clear=True), \
             mock.patch.object(sys, "platform", "linux" if sys.platform == "darwin" else sys.platform), \
             mock.patch("maw.gui_config.load_env", return_value={"FFMPEG_PATH": str(directory)}), \
             mock.patch("maw.gui_web.effective_config", return_value=SimpleNamespace(model_cache_root="")), \
             mock.patch.object(api, "_local_runtime_status", return_value=SimpleNamespace(ready=False)), \
             mock.patch("maw.gui_web.inspect_alignment_model", return_value=SimpleNamespace(status="ready", installed=True)), \
             mock.patch("maw.script_timestamp_alignment.QwenForcedAlignerBackend", return_value=backend):
            result = api.run_timestamp_alignment({"alignmentMode": "script", "modelId": "qwen", "scriptPath": str(script), "mediaPath": str(media)})
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["report"]["audioTrack"], 1)
        calls = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]
        self.assertTrue(any(call[0] == "ffprobe" for call in calls))
        self.assertTrue(any(call[0] == "ffmpeg" and "0:a:1" in call for call in calls))

    def test_cli_script_check_uses_saved_tools_and_default_second_track(self):
        from maw.cli import main
        directory, media, script, _ = self.real_media_tools()
        output = io.StringIO()
        errors = io.StringIO()
        with mock.patch.dict(os.environ, {"PATH": "", "PYTHONDONTWRITEBYTECODE": "1"}, clear=True), \
             mock.patch.object(sys, "platform", "linux" if sys.platform == "darwin" else sys.platform), \
             mock.patch("maw.gui_config.load_env", return_value={"FFMPEG_PATH": str(directory)}), \
             redirect_stdout(output), redirect_stderr(errors):
            code = main(["--align-script", str(script), "--alignment-check", "-i", str(media)])
        self.assertEqual(code, 0, errors.getvalue())
        self.assertEqual(json.loads(output.getvalue())["audioTrack"], 1)

    def test_cli_environment_ffmpeg_path_precedes_saved_setting(self):
        from maw.cli import main
        directory, media, script, _ = self.real_media_tools()
        output = io.StringIO()
        errors = io.StringIO()
        with mock.patch.dict(os.environ, {"PATH": "", "FFMPEG_PATH": str(directory / "ffmpeg"), "PYTHONDONTWRITEBYTECODE": "1"}, clear=True), \
             mock.patch.object(sys, "platform", "linux" if sys.platform == "darwin" else sys.platform), \
             mock.patch("maw.gui_config.load_env", return_value={"FFMPEG_PATH": str(self.root / "invalid")}), \
             redirect_stdout(output), redirect_stderr(errors):
            code = main(["--align-script", str(script), "--alignment-check", "-i", str(media)])
        self.assertEqual(code, 0, errors.getvalue())
        self.assertEqual(json.loads(output.getvalue())["audioTrack"], 1)

    def test_cli_script_fallback_uses_saved_tools(self):
        from maw.cli import main
        from maw.timestamp_alignment import TimedToken
        directory, media, script, log = self.real_media_tools()
        output = io.StringIO()
        errors = io.StringIO()
        backend = SimpleNamespace(align=lambda *args, **kwargs: [TimedToken("你好", 0, 500)])
        with mock.patch.dict(os.environ, {"PATH": "", "PYTHONDONTWRITEBYTECODE": "1"}, clear=True), \
             mock.patch.object(sys, "platform", "linux" if sys.platform == "darwin" else sys.platform), \
             mock.patch("maw.gui_config.load_env", return_value={"FFMPEG_PATH": str(directory)}), \
             mock.patch("maw.local_runtime.managed_runtime_status", return_value=SimpleNamespace(ready=False)), \
             mock.patch("maw.script_timestamp_alignment.QwenForcedAlignerBackend", return_value=backend), \
             redirect_stdout(output), redirect_stderr(errors):
            code = main(["--align-script", str(script), "-i", str(media)])
        self.assertEqual(code, 0, errors.getvalue())
        self.assertIn('"audioTrack": 1', output.getvalue())
        calls = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]
        self.assertTrue(any(call[0] == "ffmpeg" and "0:a:1" in call for call in calls))

    def test_cli_managed_alignment_passes_saved_tools_to_child(self):
        from maw.cli import main
        custom = self.tools(self.root / "custom", "ffmpeg", "ffprobe")
        status = SimpleNamespace(ready=True, python_path=self.python)
        captured = {}
        real_run = local_runtime.run_timestamp_alignment_in_runtime
        def run_real(**kwargs):
            result = real_run(**kwargs)
            captured.update(result)
            return {"artifact": {"projectPath": "out.mosp", "srtPath": "out.srt"}, "report": {}}

        with mock.patch.dict(os.environ, {"PATH": "", "PYTHONDONTWRITEBYTECODE": "1", **({"SYSTEMROOT": self.system_root} if self.system_root else {})}, clear=True), \
             mock.patch.object(sys, "frozen", True, create=True), \
             mock.patch.object(sys, "executable", str(self.root / "MAW.exe")), \
             mock.patch.object(sys, "platform", "linux" if sys.platform == "darwin" else sys.platform), \
             mock.patch.object(sys, "_MEIPASS", str(self.root / "resources"), create=True), \
             mock.patch("maw.gui_config.load_env", return_value={"FFMPEG_PATH": str(self.root / "custom")}), \
             mock.patch.object(local_runtime, "managed_runtime_status", return_value=status), \
             mock.patch.object(local_runtime.LOCAL, "bundle_path", return_value=self.helper), \
             mock.patch.object(local_runtime, "run_timestamp_alignment_in_runtime", side_effect=run_real), \
             redirect_stdout(io.StringIO()):
            code = main(["--align-script", "script.txt", "-i", "audio.wav"])
        self.assertEqual(code, 0)
        self.assertEqual(captured["command"], "script-align")
        self.assertEqual((captured["ffmpeg"], captured["ffprobe"]), (custom["ffmpeg"], custom["ffprobe"]))

    def test_gui_timestamp_and_moss_fallback_use_saved_ffmpeg(self):
        from threading import Event
        from maw.gui_web import LauncherApi, LauncherPaths
        from maw.gui_workflow import TranscriptionRequest, TranscriptionResult
        from maw.timestamp_alignment import _extract_audio_span
        directory, media, _, log = self.real_media_tools()
        api = LauncherApi(paths=LauncherPaths(root=self.root, env_path=self.root / "config", launcher_html=self.root / "launcher.html"), window_getter=lambda: None)
        project, srt = self.root / "out.mosp", self.root / "out.srt"
        project.write_text("{}", encoding="utf-8")
        srt.write_text("fixture", encoding="utf-8")
        artifact = SimpleNamespace(project_path=project, srt_path=srt, warnings=())
        report = SimpleNamespace(to_payload=lambda: {})
        counter = iter((1, 2))
        def align(_request, *, ffmpeg_path=None):
            _extract_audio_span(media, self.root / f"chunk-{next(counter)}.wav", 0, 500, ffmpeg_path=ffmpeg_path)
            return artifact, report
        with mock.patch.dict(os.environ, {"PATH": "", "PYTHONDONTWRITEBYTECODE": "1"}, clear=True), \
             mock.patch.object(sys, "platform", "linux" if sys.platform == "darwin" else sys.platform), \
             mock.patch("maw.gui_config.load_env", return_value={"FFMPEG_PATH": str(directory)}), \
             mock.patch("maw.gui_web.effective_config", return_value=SimpleNamespace(model_cache_root="")), \
             mock.patch.object(api, "_local_runtime_status", return_value=SimpleNamespace(ready=False)), \
             mock.patch("maw.gui_web.inspect_alignment_model", return_value=SimpleNamespace(status="ready", installed=True)), \
             mock.patch("maw.gui_web.process_timestamp_alignment", side_effect=align):
            result = api.run_timestamp_alignment({"modelId": "qwen", "mediaPath": str(media), "projectPath": str(project)})
            self.assertTrue(result["ok"], result)
            request = TranscriptionRequest(media_path=media, srt_path=srt, alignment_model="qwen")
            original = TranscriptionResult(srt_path=srt, json_path=project, html_path=None)
            self.assertEqual(api._align_transcription_result(request, original, Event()).json_path, project)
        calls = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(sum(call[0] == "ffmpeg" for call in calls), 2)

    def test_recording_worker_uses_probe_for_default_second_track(self):
        directory, media, _, log = self.real_media_tools()
        output = self.root / "decoded.wav"
        repo = str(Path(__file__).resolve().parents[1])
        self.helper.write_text(
            f"import json, sys\nsys.path.insert(0, {repo!r})\n"
            "from pathlib import Path\nfrom maw.script_recording_workflow import _decode_recording_audio\n"
            f"_decode_recording_audio({{}}, Path({str(media)!r}), Path({str(output)!r}))\n"
            "print(json.dumps({'type':'result'}))\n", encoding="utf-8")
        self.run_child(env={"PATH": "", "FFMPEG_PATH": str(directory), "PYTHONDONTWRITEBYTECODE": "1"})
        calls = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]
        self.assertTrue(any(call[0] == "ffprobe" for call in calls))
        self.assertTrue(any(call[0] == "ffmpeg" and "0:a:1" in call for call in calls))

    def run_recording_server_job(self, *, launcher, external_override=False, clear_config=False, system_fallback=False, frozen=False, no_change=False, source_items=False):
        from maw.gui_web import _alignment_server_child_environment

        initial, media, script, log = self.real_media_tools()
        updated = self.root / "updated-tools"
        updated.mkdir()
        for name in ("ffmpeg", "ffprobe"):
            destination = updated / name
            destination.write_text((initial / name).read_text(encoding="utf-8"), encoding="utf-8")
            destination.chmod(0o755)
        fallback = self.root / "system-tools"
        if system_fallback:
            fallback.mkdir()
            for name in ("ffmpeg", "ffprobe"):
                destination = fallback / name
                destination.write_text((initial / name).read_text(encoding="utf-8"), encoding="utf-8")
                destination.chmod(0o755)
        bundle = self.root / "ffmpeg" / "bin"
        if frozen:
            bundle.mkdir(parents=True)
            for name in ("ffmpeg", "ffprobe"):
                destination = bundle / name
                destination.write_text((initial / name).read_text(encoding="utf-8"), encoding="utf-8")
                destination.chmod(0o755)
        config = self.root / "configuration"
        config.write_text(f"FFMPEG_PATH={initial}\n", encoding="utf-8")
        project = self.root / "source.mosp"
        project.write_text("{}", encoding="utf-8")
        output = self.root / "recording-worker.wav"
        repo = str(Path(__file__).resolve().parents[1])
        self.helper.write_text(
            "import json, sys\n"
            "if sys.platform == 'darwin': sys.platform = 'linux'\n"
            f"sys.path.insert(0, {repo!r})\n"
            "from pathlib import Path\nfrom maw.ffmpeg import resolve_ffmpeg_tools\n"
            "from maw.script_recording_workflow import _decode_recording_audio\n"
            f"_decode_recording_audio({{}}, Path({str(media)!r}), Path({str(output)!r}))\n"
            "tools = resolve_ffmpeg_tools()\n"
            "print(json.dumps({'type':'result','artifact':{'ffmpeg':str(tools.ffmpeg or ''),'ffprobe':str(tools.ffprobe or '')}}))\n",
            encoding="utf-8")
        server = self.root / "server-job.py"
        server.write_text(
            "import json, os, sys, tempfile\n"
            "if sys.platform == 'darwin': sys.platform = 'linux'\n"
            f"sys.path.insert(0, {repo!r})\n"
            f"{_TEST_WORKER_TEMP_POLICY}"
            "from pathlib import Path\nfrom types import SimpleNamespace\nfrom threading import Event\nfrom unittest import mock\n"
            "from maw import local_runtime\nfrom maw.recording_review_server import RecordingReviewJob\n"
            "python_executable = sys.executable\n"
            + (f"sys.frozen = True\nsys.executable = {str(self.root / 'MAW.exe')!r}\n" if frozen else "")
            +
            f"state = SimpleNamespace(project_path=Path({str(project)!r}), script_path=Path({str(script)!r}), media_path=Path({str(media)!r}), project={{'media':{str(media)!r}}})\n"
            "job = RecordingReviewJob(state)\njob.current_digest = 'unchanged'\njob.status = {'selectionDigest':'unchanged'}\n"
            "sys.stdin.readline()\n"
            f"with mock.patch.object(local_runtime, 'managed_runtime_status', return_value=SimpleNamespace(ready=True, python_path=python_executable)), mock.patch.object(local_runtime.LOCAL, 'bundle_path', return_value=Path({str(self.helper)!r})):\n"
            f"    job._run({{}}, Event(), source_items={source_items!r})\n"
            "print(json.dumps(job.snapshot()))\n", encoding="utf-8")
        server_temp = self.root / "recording-server-temp"
        server_temp.mkdir()
        parent_env = {"PATH": str(fallback) if system_fallback else "", "PYTHONDONTWRITEBYTECODE": "1",
                      "TMPDIR": str(server_temp), "TMP": str(server_temp), "TEMP": str(server_temp)}
        if self.preserve_temp:
            parent_env["MAW_TEST_PRESERVE_TEMP"] = "1"
        if external_override:
            parent_env["FFMPEG_PATH"] = str(initial)
        if launcher:
            with mock.patch.dict(os.environ, parent_env, clear=True), \
                 mock.patch.object(sys, "platform", "linux" if sys.platform == "darwin" else sys.platform), \
                 mock.patch("maw.gui_workflow.DEFAULT_ENV_PATH", config), \
                 mock.patch.object(sys, "frozen", frozen, create=True), \
                 mock.patch.object(sys, "executable", str(self.root / "MAW.exe") if frozen else self.python):
                environment = _alignment_server_child_environment()
            self.assertEqual(environment["PATH"].split(os.pathsep)[0], str(initial))
        else:
            environment = {**parent_env, "MAW_ENV_FILE": str(config)}
        process = subprocess.Popen([self.python, str(server)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True, env=environment)
        try:
            if not no_change:
                config.write_text("" if clear_config else f"FFMPEG_PATH={updated}\n", encoding="utf-8")
            stdout, stderr = process.communicate("start\n", timeout=30)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
        self.assertEqual(process.returncode, 0, stderr)
        return json.loads(stdout), initial, updated, log

    def test_recording_server_uses_updated_launcher_configuration(self):
        result, _, updated, log = self.run_recording_server_job(launcher=True)
        self.assertEqual(result["status"], "complete", result)
        self.assertEqual(result["artifact"], {"ffmpeg": str(updated / "ffmpeg"), "ffprobe": str(updated / "ffprobe")})
        calls = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]
        self.assertTrue(any(call[0] == "ffmpeg" and "0:a:1" in call for call in calls))

    def test_recording_server_initial_launcher_path_remains_available(self):
        result, initial, _, _ = self.run_recording_server_job(launcher=True, no_change=True)
        self.assertEqual(result["status"], "complete", result)
        self.assertEqual(result["artifact"], {"ffmpeg": str(initial / "ffmpeg"), "ffprobe": str(initial / "ffprobe")})

    def test_recording_fill_uses_updated_configuration(self):
        result, _, updated, _ = self.run_recording_server_job(launcher=True, source_items=True)
        self.assertEqual(result["status"], "complete", result)
        self.assertEqual(result["artifact"], {"ffmpeg": str(updated / "ffmpeg"), "ffprobe": str(updated / "ffprobe")})

    def test_standalone_recording_server_reads_saved_configuration(self):
        result, _, updated, _ = self.run_recording_server_job(launcher=False)
        self.assertEqual(result["status"], "complete", result)
        self.assertEqual(result["artifact"], {"ffmpeg": str(updated / "ffmpeg"), "ffprobe": str(updated / "ffprobe")})

    def test_recording_server_environment_override_precedes_saved_configuration(self):
        result, initial, _, _ = self.run_recording_server_job(launcher=True, external_override=True)
        self.assertEqual(result["status"], "complete", result)
        self.assertEqual(result["artifact"], {"ffmpeg": str(initial / "ffmpeg"), "ffprobe": str(initial / "ffprobe")})

    def test_recording_server_does_not_retain_cleared_launcher_path(self):
        result, _, _, _ = self.run_recording_server_job(launcher=True, clear_config=True)
        self.assertEqual(result["status"], "error", result)
        self.assertIn("找不到 FFmpeg", result["message"])

    def test_recording_server_cleared_config_uses_original_system_path(self):
        result, _, _, _ = self.run_recording_server_job(launcher=True, clear_config=True, system_fallback=True)
        self.assertEqual(result["status"], "complete", result)
        fallback = self.root / "system-tools"
        self.assertEqual(result["artifact"], {"ffmpeg": str(fallback / "ffmpeg"), "ffprobe": str(fallback / "ffprobe")})

    def test_recording_server_cleared_config_uses_packaged_tools(self):
        result, _, _, _ = self.run_recording_server_job(launcher=True, clear_config=True, frozen=True)
        self.assertEqual(result["status"], "complete", result)
        bundled = self.root / "ffmpeg" / "bin"
        self.assertEqual(result["artifact"], {"ffmpeg": str(bundled / "ffmpeg"), "ffprobe": str(bundled / "ffprobe")})

    def test_launcher_alignment_entry_passes_original_path_to_server(self):
        from maw.gui_web import LauncherApi, LauncherPaths
        initial, media, script, _ = self.real_media_tools()
        config = self.root / "configuration"
        config.write_text(f"FFMPEG_PATH={initial}\n", encoding="utf-8")
        original_path = self.root / "system-path"
        original_path.mkdir()
        project = self.root / "source.mosp"
        project.write_text('{"segments": []}\n', encoding="utf-8")
        api = LauncherApi(paths=LauncherPaths(root=self.root, env_path=config, launcher_html=self.root / "launcher.html"), window_getter=lambda: None)
        process = SimpleNamespace(poll=lambda: None)
        with mock.patch.dict(os.environ, {"PATH": str(original_path), "PYTHONDONTWRITEBYTECODE": "1"}, clear=True), \
             mock.patch.object(sys, "platform", "linux" if sys.platform == "darwin" else sys.platform), \
             mock.patch("maw.gui_workflow.DEFAULT_ENV_PATH", config), \
             mock.patch("maw.gui_web.tempfile.TemporaryFile", return_value=io.BytesIO()), \
             mock.patch("maw.gui_web._free_local_port", return_value=9877), \
             mock.patch("maw.gui_web._wait_for_server", return_value=True), \
             mock.patch("maw.gui_web.popen_process_tree", return_value=process) as popen:
            result = api.start_alignment_server({"projectPath": str(project), "scriptPath": str(script), "mediaPath": str(media)})
        self.assertTrue(result["ok"], result)
        environment = popen.call_args.kwargs["env"]
        self.assertEqual(environment["_MAW_ALIGNMENT_ORIGINAL_PATH"], str(original_path))
        self.assertEqual(environment["PATH"].split(os.pathsep)[0], str(initial))

    def run_recording_http_entry(self, *, launcher):
        from maw.gui_web import _alignment_server_child_environment
        from tests.test_script_recording_workflow import cue, project
        from tests.test_server_align import SERVER

        initial, media, script, log = self.real_media_tools()
        updated = self.root / "updated-tools"
        updated.mkdir()
        for name in ("ffmpeg", "ffprobe"):
            destination = updated / name
            destination.write_text((initial / name).read_text(encoding="utf-8"), encoding="utf-8")
            destination.chmod(0o755)
        config = self.root / "configuration"
        config.write_text(f"FFMPEG_PATH={initial}\n", encoding="utf-8")
        script.write_text("你好，世界。", encoding="utf-8")
        source = self.root / "source.mosp"
        source.write_text(json.dumps({**project([cue("你好世界", 0, 1000)]), "media": str(media)}), encoding="utf-8")
        output = self.root / "http-worker.wav"
        repo = str(Path(__file__).resolve().parents[1])
        self.helper.write_text(
            "import json, sys\n"
            "if sys.platform == 'darwin': sys.platform = 'linux'\n"
            f"sys.path.insert(0, {repo!r})\n"
            "from pathlib import Path\nfrom maw.ffmpeg import resolve_ffmpeg_tools\n"
            "from maw.script_recording_workflow import _decode_recording_audio\n"
            f"_decode_recording_audio({{}}, Path({str(media)!r}), Path({str(output)!r}))\n"
            "tools = resolve_ffmpeg_tools()\n"
            "print(json.dumps({'type':'result','artifact':{'ffmpeg':str(tools.ffmpeg or ''),'ffprobe':str(tools.ffprobe or '')}}))\n",
            encoding="utf-8")
        parent_env = {"PATH": "", "PYTHONDONTWRITEBYTECODE": "1"}
        server_temp = self.root / "recording-http-temp"
        server_temp.mkdir()
        with mock.patch.dict(os.environ, parent_env, clear=True), \
             mock.patch.object(sys, "platform", "linux" if sys.platform == "darwin" else sys.platform), \
             mock.patch("maw.gui_workflow.DEFAULT_ENV_PATH", config):
            environment = _alignment_server_child_environment() if launcher else {**parent_env, "MAW_ENV_FILE": str(config)}
        with mock.patch.dict(os.environ, environment, clear=True), \
             mock.patch.object(sys, "platform", "linux" if sys.platform == "darwin" else sys.platform), \
             mock.patch("maw.gui_config.DEFAULT_ENV_PATH", config), \
             mock.patch.object(tempfile, "tempdir", str(server_temp)), \
             mock.patch.object(local_runtime, "managed_runtime_status", return_value=SimpleNamespace(ready=True, python_path=self.python)), \
             mock.patch.object(local_runtime.LOCAL, "bundle_path", return_value=self.helper):
            server = SERVER.AlignmentServer(("127.0.0.1", 0), SERVER.load_state(source, script, None))
            thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
            thread.start()
            try:
                url = f"http://127.0.0.1:{server.server_address[1]}"
                with urlopen(url + "/api/state", timeout=5) as response:
                    state = json.load(response)
                config.write_text(f"FFMPEG_PATH={updated}\n", encoding="utf-8")
                body = {"requestToken": state["requestToken"], "inputSignature": state["recordingInputSignature"],
                        "sourceConfirmed": True, "selectedByLine": state["alignment"]["defaultSelection"]}
                request = Request(url + "/api/recording/start", json.dumps(body).encode(), {"Content-Type": "application/json"})
                with urlopen(request, timeout=5) as response:
                    self.assertTrue(json.load(response)["ok"])
                server.recording_job.thread.join(timeout=20)
                self.assertFalse(server.recording_job.thread.is_alive())
                with urlopen(url + "/api/recording/status", timeout=5) as response:
                    result = json.load(response)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)
        self.assertEqual(result["status"], "complete", result)
        self.assertEqual(result["artifact"], {"ffmpeg": str(updated / "ffmpeg"), "ffprobe": str(updated / "ffprobe")})
        calls = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]
        self.assertTrue(any(call[0] == "ffmpeg" and "0:a:1" in call for call in calls))

    def test_launcher_recording_http_entry_uses_updated_configuration(self):
        self.run_recording_http_entry(launcher=True)

    def test_standalone_recording_http_entry_uses_saved_configuration(self):
        self.run_recording_http_entry(launcher=False)
