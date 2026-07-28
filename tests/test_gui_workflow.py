# pyright: reportImplicitOverride=false, reportPrivateUsage=false, reportUnannotatedClassAttribute=false, reportUninitializedInstanceVariable=false, reportUnusedCallResult=false, reportUnusedParameter=false

import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from threading import Event
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from maw.gui_workflow import (  # noqa: E402
    TranscriptionRequest,
    build_serve_command,
    build_output_paths,
    build_transcribe_command,
    _child_environment,
    run_transcription,
)


class GuiWorkflowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.media_path = self.root / "clip.mp3"
        self.media_path.write_bytes(b"placeholder")
        self.srt_path = self.root / "out.srt"

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_build_output_paths_derive_exact_json_and_html_paths(self) -> None:
        paths = build_output_paths(self.srt_path)

        self.assertEqual(paths.srt, self.srt_path)
        self.assertEqual(paths.json, self.root / "out.json")
        self.assertEqual(paths.html, self.root / "out.edit.html")

    def test_build_transcribe_command_source_mode_uses_script_and_forces_json_no_html(self) -> None:
        request = TranscriptionRequest(
            media_path=self.media_path,
            srt_path=self.srt_path,
            model="qwen3-asr-flash-filetrans",
            language="zh",
            api_key="secret-key",
        )

        command = build_transcribe_command(request, executable=Path("python.exe"), frozen=False)

        self.assertEqual(command[0], "python.exe")
        self.assertIn("generate_subtitle_qwen_api.py", command[1])
        self.assertEqual(command[2], str(self.media_path))
        self.assertIn("--json", command)
        self.assertIn("--no-html", command)
        self.assertEqual(command[command.index("--output") + 1], str(self.srt_path))
        self.assertEqual(command[command.index("--model") + 1], "qwen3-asr-flash-filetrans")
        self.assertEqual(command[command.index("--language") + 1], "zh")
        self.assertEqual(command.count("--with-waveform"), 1)
        self.assertNotIn("secret-key", " ".join(command))

    def test_build_transcribe_command_frozen_mode_dispatches_same_executable(self) -> None:
        request = TranscriptionRequest(media_path=self.media_path, srt_path=self.srt_path)

        command = build_transcribe_command(request, executable=Path("MAW.exe"), frozen=True)

        self.assertEqual(command[:3], ["MAW.exe", "--transcribe", str(self.media_path)])
        self.assertIn("--json", command)
        self.assertIn("--no-html", command)
        self.assertEqual(command.count("--with-waveform"), 1)

    def test_run_transcription_passes_api_key_only_in_child_environment(self) -> None:
        request = TranscriptionRequest(
            media_path=self.media_path,
            srt_path=self.srt_path,
            api_key="secret-key",
            workspace_id="workspace-123",
        )
        self.srt_path.write_text("1\n", encoding="utf-8")
        self.srt_path.with_suffix(".json").write_text('{"segments": []}\n', encoding="utf-8")
        events: list[str] = []

        class FakeProcess:
            returncode = 0
            stdout = ["started\n", "done\n"]

            def poll(self) -> int | None:
                return 0

            def wait(self, timeout: float | None = None) -> int:
                return 0

        with mock.patch("maw.gui_workflow.subprocess.Popen", return_value=FakeProcess()) as popen:
            with mock.patch("maw.gui_workflow.render_editor_html", return_value=self.srt_path.with_suffix(".edit.html")):
                result = run_transcription(request, on_event=events.append)

        kwargs = popen.call_args.kwargs
        self.assertEqual(kwargs["env"]["DASHSCOPE_API_KEY"], "secret-key")
        self.assertEqual(kwargs["env"]["DASHSCOPE_WORKSPACE_ID"], "workspace-123")
        self.assertNotEqual(os.environ.get("DASHSCOPE_API_KEY"), "secret-key")
        self.assertEqual(events, ["started", "done"])
        self.assertEqual(result.srt_path, self.srt_path)
        self.assertEqual(result.json_path, self.srt_path.with_suffix(".json"))
        self.assertEqual(result.html_path, self.srt_path.with_suffix(".edit.html"))

    def test_child_environment_forces_unbuffered_python_stdout(self) -> None:
        env = _child_environment({"PYTHONUNBUFFERED": "0"}, "secret-key", "workspace-123")

        self.assertEqual(env["PYTHONUNBUFFERED"], "1")
        self.assertEqual(env["DASHSCOPE_API_KEY"], "secret-key")
        self.assertEqual(env["DASHSCOPE_WORKSPACE_ID"], "workspace-123")

    def test_child_environment_prepends_ffmpeg_path_directory(self) -> None:
        ffmpeg_dir = self.root / "ffmpeg" / "bin"
        ffmpeg_dir.mkdir(parents=True)
        ffmpeg_exe = ffmpeg_dir / "ffmpeg.exe"
        ffmpeg_exe.write_bytes(b"exe")

        env = _child_environment({"PATH": "C:\\Windows", "FFMPEG_PATH": str(ffmpeg_exe)}, "", "")

        self.assertEqual(env["PATH"].split(os.pathsep)[0], str(ffmpeg_dir))

    def test_run_transcription_reports_child_pid_after_popen(self) -> None:
        request = TranscriptionRequest(media_path=self.media_path, srt_path=self.srt_path)
        self.srt_path.write_text("1\n", encoding="utf-8")
        self.srt_path.with_suffix(".json").write_text('{"segments": []}\n', encoding="utf-8")
        started: list[int] = []

        class FakeProcess:
            pid = 4321
            returncode = 0
            stdout = []

            def poll(self) -> int | None:
                return 0

            def wait(self, timeout: float | None = None) -> int:
                return 0

        with mock.patch("maw.gui_workflow.subprocess.Popen", return_value=FakeProcess()):
            with mock.patch("maw.gui_workflow.render_editor_html", return_value=None):
                run_transcription(request, on_process_start=started.append)

        self.assertEqual(started, [4321])

    def test_run_transcription_keeps_json_when_optional_html_render_fails(self) -> None:
        request = TranscriptionRequest(media_path=self.media_path, srt_path=self.srt_path)
        self.srt_path.write_text("1\n", encoding="utf-8")
        self.srt_path.with_suffix(".json").write_text('{"segments": []}\n', encoding="utf-8")
        events: list[str] = []

        class FakeProcess:
            pid = 4321
            returncode = 0
            stdout = []

            def poll(self) -> int | None:
                return 0

            def wait(self, timeout: float | None = None) -> int:
                return 0

        with mock.patch("maw.gui_workflow.subprocess.Popen", return_value=FakeProcess()):
            with mock.patch("maw.gui_workflow.render_editor_html", side_effect=ValueError("invalid preview")):
                result = run_transcription(request, on_event=events.append)

        self.assertEqual(result.json_path, self.srt_path.with_suffix(".json"))
        self.assertIsNone(result.html_path)
        self.assertTrue(any("SRT/JSON 已保留" in event for event in events))

    def test_run_transcription_cancels_running_process(self) -> None:
        request = TranscriptionRequest(media_path=self.media_path, srt_path=self.srt_path)
        cancel_event = Event()
        cancel_event.set()

        class FakeProcess:
            returncode = None
            stdout = []
            terminated = False

            def poll(self) -> int | None:
                return None

            def terminate(self) -> None:
                self.terminated = True

            def wait(self, timeout: float | None = None) -> int:
                self.returncode = -15
                return -15

            def kill(self) -> None:
                self.returncode = -9

        fake = FakeProcess()
        with mock.patch("maw.gui_workflow.subprocess.Popen", return_value=fake) as popen:
            with self.assertRaises(Exception) as raised:
                run_transcription(request, cancel_event=cancel_event)

        popen.assert_not_called()
        self.assertFalse(fake.terminated)
        self.assertIn("cancelled", str(raised.exception).lower())

    def test_run_transcription_cancels_quiet_process_promptly(self) -> None:
        request = TranscriptionRequest(media_path=self.media_path, srt_path=self.srt_path)
        cancel_event = Event()
        outcome: list[BaseException] = []
        release_stdout = Event()

        class QuietStdout:
            def __iter__(self) -> "QuietStdout":
                return self

            def __next__(self) -> str:
                release_stdout.wait()
                raise StopIteration

        class QuietProcess:
            returncode = None
            stdout = QuietStdout()

            def poll(self) -> int | None:
                return self.returncode

            def wait(self, timeout: float | None = None) -> int:
                self.returncode = 0
                return 0

            def terminate(self) -> None:
                self.returncode = -15
                release_stdout.set()

            def kill(self) -> None:
                self.returncode = -9
                release_stdout.set()

        def run() -> None:
            try:
                run_transcription(request, cancel_event=cancel_event)
            except BaseException as exc:
                outcome.append(exc)

        with mock.patch("maw.gui_workflow.subprocess.Popen", return_value=QuietProcess()):
            worker = threading.Thread(target=run)
            worker.start()
            time.sleep(0.2)
            cancel_event.set()
            worker.join(timeout=0.5)
            ignored_cancellation = worker.is_alive()
            release_stdout.set()
            worker.join(timeout=1)

        self.assertFalse(ignored_cancellation, "quiet subprocess ignored cancellation")
        self.assertEqual(len(outcome), 1)
        self.assertIn("cancelled", str(outcome[0]).lower())

    def test_build_transcribe_command_soniox_uses_soniox_script_without_region(self) -> None:
        request = TranscriptionRequest(
            media_path=self.media_path,
            srt_path=self.srt_path,
            provider="soniox",
            model="stt-async-v5",
            language="zh",
            api_key="secret-key",
            speaker_colors=True,
        )

        command = build_transcribe_command(request, executable=Path("python.exe"), frozen=False)

        self.assertEqual(command[0], "python.exe")
        self.assertIn("generate_subtitle_soniox_api.py", command[1])
        self.assertEqual(command[2], str(self.media_path))
        self.assertIn("--json", command)
        self.assertIn("--no-html", command)
        self.assertIn("--speaker-colors", command)
        self.assertEqual(command[command.index("--output") + 1], str(self.srt_path))
        self.assertEqual(command[command.index("--model") + 1], "stt-async-v5")
        self.assertEqual(command[command.index("--language") + 1], "zh")
        self.assertEqual(command.count("--with-waveform"), 1)
        self.assertNotIn("--region", command)
        self.assertNotIn("secret-key", " ".join(command))

    def test_build_transcribe_command_soniox_omits_speaker_colors_and_leaked_qwen_model(self) -> None:
        request = TranscriptionRequest(
            media_path=self.media_path,
            srt_path=self.srt_path,
            provider="soniox",
        )

        command = build_transcribe_command(request, executable=Path("python.exe"), frozen=False)

        self.assertNotIn("--speaker-colors", command)
        self.assertEqual(command.count("--with-waveform"), 1)
        # dataclass 默认 model 是 Qwen 的；泄漏到 soniox 请求时应省略 --model，
        # 让 CLI 回退到 SONIOX_MODEL / stt-async-v5
        self.assertNotIn("--model", command)

    def test_build_transcribe_command_frozen_soniox_dispatches_soniox_flag(self) -> None:
        request = TranscriptionRequest(media_path=self.media_path, srt_path=self.srt_path, provider="soniox")

        command = build_transcribe_command(request, executable=Path("MAW.exe"), frozen=True)

        self.assertEqual(command[:3], ["MAW.exe", "--transcribe-soniox", str(self.media_path)])
        self.assertEqual(command.count("--with-waveform"), 1)

    def test_child_environment_soniox_uses_soniox_key_only(self) -> None:
        env = _child_environment({}, "secret-key", "workspace-123", "soniox")

        self.assertEqual(env["SONIOX_API_KEY"], "secret-key")
        self.assertNotIn("DASHSCOPE_API_KEY", env)
        self.assertNotIn("DASHSCOPE_WORKSPACE_ID", env)
        self.assertEqual(env["PYTHONUNBUFFERED"], "1")

    def test_default_srt_path_uses_provider_tag(self) -> None:
        from maw.gui_workflow import default_srt_path

        self.assertEqual(default_srt_path(Path("clip.mp4")).name, "clip.qwen3-asr-api.srt")
        self.assertEqual(default_srt_path(Path("clip.mp4"), provider="soniox").name, "clip.soniox.srt")

    def test_entrypoint_transcribe_soniox_help_dispatches_soniox_script(self) -> None:
        import maw_gui

        with self.assertRaises(SystemExit) as raised:
            maw_gui.main(["--transcribe-soniox", "--help"])

        self.assertEqual(raised.exception.code, 0)

    def test_build_serve_command_source_mode_uses_server_script(self) -> None:
        project_path = self.root / "project.json"
        media_path = self.root / "clip.mp4"

        command = build_serve_command(
            project_path,
            media_path,
            9876,
            executable=Path("python.exe"),
            frozen=False,
        )

        self.assertEqual(command[0], "python.exe")
        self.assertIn("serve.py", command[1])
        self.assertEqual(command[2], str(project_path))
        self.assertEqual(command[command.index("-m") + 1], str(media_path))
        self.assertEqual(command[command.index("--port") + 1], "9876")

    def test_build_serve_command_frozen_mode_dispatches_same_executable(self) -> None:
        project_path = self.root / "project.json"

        command = build_serve_command(project_path, None, 8765, executable=Path("MAW.exe"), frozen=True)

        self.assertEqual(command[:3], ["MAW.exe", "--serve", str(project_path)])
        self.assertNotIn("-m", command)
        self.assertEqual(command[command.index("--port") + 1], "8765")

    def test_build_serve_command_without_project_starts_blank_editor(self) -> None:
        command = build_serve_command(None, None, 8765, executable=Path("python.exe"), frozen=False)

        self.assertEqual(command[0], "python.exe")
        self.assertIn("serve.py", command[1])
        self.assertIn("--blank", command)
        self.assertNotIn("-m", command)
        self.assertEqual(command[command.index("--port") + 1], "8765")

    def test_build_serve_command_blank_frozen_uses_serve_flag_and_blank(self) -> None:
        command = build_serve_command(None, None, 8765, executable=Path("MAW.exe"), frozen=True)

        self.assertEqual(command[:2], ["MAW.exe", "--serve"])
        self.assertIn("--blank", command)
        self.assertEqual(command[command.index("--port") + 1], "8765")

    def test_entrypoint_smoke_import_argument_does_not_open_window(self) -> None:
        import maw_gui

        with mock.patch("maw.gui.run_app") as run_app:
            exit_code = maw_gui.main(["--smoke-import"])

        self.assertEqual(exit_code, 0)
        run_app.assert_not_called()

    def test_entrypoint_help_subprocess_is_headless_safe(self) -> None:
        completed = subprocess.run(
            [sys.executable, str(ROOT / "maw_gui.py"), "--help"],
            check=False,
            capture_output=True,
            text=True,
        )

        self.assertEqual(completed.returncode, 0)
        self.assertIn("Moy's ASR Workflow GUI", completed.stdout)


if __name__ == "__main__":
    unittest.main()
