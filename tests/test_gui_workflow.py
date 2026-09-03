# pyright: reportImplicitOverride=false, reportPrivateUsage=false, reportUnannotatedClassAttribute=false, reportUninitializedInstanceVariable=false, reportUnusedCallResult=false, reportUnusedParameter=false

import json
import os
import struct
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
    TranscriptionProcessError,
    TranscriptionRequest,
    build_alignment_serve_command,
    build_serve_command,
    build_output_paths,
    build_transcribe_command,
    raw_response_path,
    unique_output_path,
    _child_environment,
    _decode_process_output,
    render_editor_html,
    run_transcription,
)
from maw.gui_platform import _terminate_registered_job, terminate_process_tree  # noqa: E402
from maw_gui import _is_ffmpeg_missing_error, _startup_error_log_path  # noqa: E402


def _write_bwf_wav(path: Path, sample_rate: int, time_reference_samples: int) -> None:
    fmt = struct.pack('<HHIIHH', 1, 1, sample_rate, sample_rate * 2, 2, 16)
    bext = bytearray(346)
    bext[338:346] = struct.pack('<II', time_reference_samples & 0xFFFFFFFF, time_reference_samples >> 32)
    data = bytes(4)
    chunks = (
        b'fmt ' + struct.pack('<I', len(fmt)) + fmt
        + b'bext' + struct.pack('<I', len(bext)) + bext
        + b'data' + struct.pack('<I', len(data)) + data
    )
    path.write_bytes(b'RIFF' + struct.pack('<I', 4 + len(chunks)) + b'WAVE' + chunks)


class GuiWorkflowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        # Windows CI may expose %TEMP% as an 8.3 short path while production code resolves it.
        self.root = Path(self.temp_dir.name).resolve()
        self.media_path = self.root / "clip.mp3"
        self.media_path.write_bytes(b"placeholder")
        self.srt_path = self.root / "out.srt"

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_build_output_paths_derive_exact_json_and_html_paths(self) -> None:
        paths = build_output_paths(self.srt_path)

        self.assertEqual(paths.srt, self.srt_path)
        self.assertEqual(paths.json, self.root / "out.mosp")
        self.assertEqual(paths.html, self.root / "out.edit.html")

    def test_child_environment_forwards_resolved_env_path(self) -> None:
        env_path = self.root / "config.env"
        with mock.patch("maw.gui_workflow.DEFAULT_ENV_PATH", env_path):
            env = _child_environment({"PATH": ""}, api_key="")

        self.assertEqual(env["MAW_ENV_FILE"], str(env_path))

    def test_child_environment_prepends_managed_site_packages_for_local_provider(self) -> None:
        """Given source-mode local transcription, When building env, Then managed site-packages go first on PYTHONPATH."""
        runtime_root = self.root / "local-runtime-moss"
        (runtime_root / "site-packages").mkdir(parents=True, exist_ok=True)

        with mock.patch.dict(os.environ, {"MAW_MOSS_RUNTIME_ROOT": str(runtime_root)}):
            env = _child_environment(
                {"PATH": "", "PYTHONPATH": str(self.root / "dev-stubs")},
                api_key="",
                provider="local",
                engine="moss",
            )

        python_path = env["PYTHONPATH"].split(os.pathsep)
        self.assertEqual(python_path[0], str(runtime_root / "site-packages"))
        self.assertIn(str(self.root / "dev-stubs"), python_path)

    def test_child_environment_skips_missing_site_packages_and_non_local_providers(self) -> None:
        """Given no managed runtime installed (or cloud provider), Then PYTHONPATH stays untouched."""
        missing_root = self.root / "not-installed"
        with mock.patch.dict(os.environ, {"MAW_MOSS_RUNTIME_ROOT": str(missing_root)}):
            env = _child_environment(
                {"PATH": "", "PYTHONPATH": "keep-me"},
                api_key="",
                provider="local",
                engine="moss",
            )
        self.assertEqual(env["PYTHONPATH"], "keep-me")

        cloud = _child_environment(
            {"PATH": "", "PYTHONPATH": "keep-me"},
            api_key="",
            provider="qwen",
        )
        self.assertEqual(cloud["PYTHONPATH"], "keep-me")

    def test_unique_output_path_adds_suffix_for_existing_sidecar(self) -> None:
        self.srt_path.with_suffix(".mosp").write_text("{}", encoding="utf-8")

        self.assertEqual(unique_output_path(self.srt_path), self.root / "out-1.srt")

        self.srt_path.with_name("out-1.mosp").write_text("{}", encoding="utf-8")
        self.assertEqual(unique_output_path(self.srt_path), self.root / "out-2.srt")

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
        self.assertNotIn("--with-spectral", command)
        self.assertNotIn("secret-key", " ".join(command))

    def test_build_transcribe_command_enables_spectral_generation_when_requested(self) -> None:
        request = TranscriptionRequest(
            media_path=self.media_path,
            srt_path=self.srt_path,
            generate_spectral=True,
        )

        command = build_transcribe_command(request, executable=Path("python.exe"), frozen=False)

        self.assertEqual(command.count("--with-waveform"), 1)
        self.assertEqual(command.count("--with-spectral"), 1)

    def test_build_transcribe_command_passes_segmentation_options(self) -> None:
        request = TranscriptionRequest(
            media_path=self.media_path,
            srt_path=self.srt_path,
            max_len="14",
            min_len="3",
            gap_split="800",
        )

        command = build_transcribe_command(request, executable=Path("python.exe"), frozen=False)

        self.assertEqual(command[command.index("--max-len") + 1], "14")
        self.assertEqual(command[command.index("--min-len") + 1], "3")
        self.assertEqual(command[command.index("--gap-split") + 1], "800")

    def test_build_transcribe_command_always_sends_strip_tail_punct(self) -> None:
        # 空串也要显式下发：表示共享保留符号配置要求完全不剥尾。
        request = TranscriptionRequest(
            media_path=self.media_path,
            srt_path=self.srt_path,
            strip_tail_punct="。",
        )

        command = build_transcribe_command(request, executable=Path("python.exe"), frozen=False)

        self.assertEqual(command[command.index("--strip-tail-punct") + 1], "。")

        empty = TranscriptionRequest(
            media_path=self.media_path,
            srt_path=self.srt_path,
            strip_tail_punct="",
        )

        empty_command = build_transcribe_command(empty, executable=Path("python.exe"), frozen=False)

        self.assertEqual(empty_command[empty_command.index("--strip-tail-punct") + 1], "")

    def test_build_transcribe_command_debug_raw_saves_full_response(self) -> None:
        request = TranscriptionRequest(
            media_path=self.media_path,
            srt_path=self.srt_path,
            debug_raw=True,
        )

        command = build_transcribe_command(request, executable=Path("python.exe"), frozen=False)

        self.assertIn("--debug-raw", command)
        self.assertEqual(raw_response_path(self.srt_path), self.srt_path.with_suffix(".asr-response.json"))

    def test_build_transcribe_command_local_ignores_debug_raw(self) -> None:
        request = TranscriptionRequest(
            media_path=self.media_path,
            srt_path=self.srt_path,
            provider="local",
            model="Qwen/Qwen3-ASR-0.6B",
            runtime_python="runtime-python",
            debug_raw=True,
        )

        command = build_transcribe_command(request, executable=Path("python.exe"), frozen=False)

        self.assertNotIn("--debug-raw", command)

    def test_build_transcribe_command_qwen_audio_passes_one_shot_context_hotwords_and_vocabulary(self) -> None:
        request = TranscriptionRequest(
            media_path=self.media_path,
            srt_path=self.srt_path,
            model="qwen-audio-3.0-asr-flash-filetrans",
            qwen_audio_context="产品名和专业术语",
            qwen_audio_hotwords="张三\n李四,阿里云",
            qwen_audio_vocabulary_id="vocab-qwen-audio",
            qwen_audio_hotword_weight="50",
        )

        command = build_transcribe_command(request, executable=Path("python.exe"), frozen=False)

        self.assertEqual(command[command.index("--context") + 1], "产品名和专业术语")
        self.assertEqual(command[command.index("--vocabulary-id") + 1], "vocab-qwen-audio")
        self.assertEqual(command[command.index("--hotword-weight") + 1], "50")
        hotword_positions = [index for index, value in enumerate(command) if value == "--hotword"]
        self.assertEqual([command[index + 1] for index in hotword_positions], ["张三", "李四", "阿里云"])

    def test_build_transcribe_command_soniox_passes_context_json(self) -> None:
        request = TranscriptionRequest(
            media_path=self.media_path,
            srt_path=self.srt_path,
            provider="soniox",
            soniox_context={
                "general": [{"key": "domain", "value": "Healthcare"}],
                "terms": ["MRI"],
            },
        )

        command = build_transcribe_command(request, executable=Path("python.exe"), frozen=False)

        self.assertIn("--context-json", command)
        self.assertEqual(
            json.loads(command[command.index("--context-json") + 1]),
            request.soniox_context,
        )

    def test_build_transcribe_command_soniox_passes_debug_raw(self) -> None:
        request = TranscriptionRequest(
            media_path=self.media_path,
            srt_path=self.srt_path,
            provider="soniox",
            debug_raw=True,
        )

        command = build_transcribe_command(request, executable=Path("python.exe"), frozen=False)

        self.assertIn("--debug-raw", command)

    def test_soniox_generator_help_declares_debug_raw(self) -> None:
        result = subprocess.run(
            [sys.executable, str(ROOT / "generate_subtitle_soniox_api.py"), "--help"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertIn("--debug-raw", result.stdout)

    def test_build_transcribe_command_qwen_audio_uses_hotword_file_mode(self) -> None:
        hotwords_file = self.root / "hotwords.txt"
        hotwords_file.write_text("张三\n阿里云\n", encoding="utf-8")
        request = TranscriptionRequest(
            media_path=self.media_path,
            srt_path=self.srt_path,
            model="qwen-audio-3.0-asr-flash-filetrans",
            qwen_audio_hotwords_file=str(hotwords_file),
            qwen_audio_hotwords="不会被使用",
        )

        command = build_transcribe_command(request, executable=Path("python.exe"), frozen=False)

        self.assertEqual(command[command.index("--hotword-file") + 1], str(hotwords_file))
        self.assertNotIn("--hotword", command)

    def test_build_transcribe_command_frozen_mode_dispatches_same_executable(self) -> None:
        request = TranscriptionRequest(media_path=self.media_path, srt_path=self.srt_path)

        command = build_transcribe_command(request, executable=Path("MAW.exe"), frozen=True)

        self.assertEqual(command[:3], ["MAW.exe", "--transcribe", str(self.media_path)])
        self.assertIn("--json", command)
        self.assertIn("--no-html", command)
        self.assertEqual(command.count("--with-waveform"), 1)

    def test_build_transcribe_command_uses_managed_runtime_for_frozen_local_asr(self) -> None:
        request = TranscriptionRequest(
            media_path=self.media_path,
            srt_path=self.srt_path,
            provider="local",
            engine="funasr",
            model="paraformer-zh",
            model_path="C:\\Users\\Demo\\model-cache",
            runtime_python="C:\\Users\\Demo\\AppData\\Local\\MAW\\local-runtime\\Scripts\\python.exe",
        )

        command = build_transcribe_command(request, executable=Path("MAW.exe"), frozen=True)

        self.assertEqual(command[0], request.runtime_python)
        self.assertIn("local-runtime", command[1])
        self.assertIn("generate_subtitle_local.py", command[1])
        self.assertNotIn("--transcribe-local", command)
        self.assertIn("--engine", command)
        self.assertIn("funasr", command)

    def test_build_transcribe_command_passes_moss_speaker_colors(self) -> None:
        request = TranscriptionRequest(
            media_path=self.media_path,
            srt_path=self.srt_path,
            provider="local",
            engine="moss",
            model="OpenMOSS-Team/MOSS-Transcribe-Diarize",
            runtime_python="moss-python",
            speaker_colors=True,
        )

        command = build_transcribe_command(request, executable=Path("python.exe"), frozen=False)

        self.assertIn("--speaker-colors", command)

    def test_run_transcription_passes_api_key_only_in_child_environment(self) -> None:
        request = TranscriptionRequest(
            media_path=self.media_path,
            srt_path=self.srt_path,
            api_key="secret-key",
            workspace_id="workspace-123",
            ui_language="en",
        )
        self.srt_path.write_text("1\n", encoding="utf-8")
        self.srt_path.with_suffix(".mosp").write_text('{"segments": []}\n', encoding="utf-8")
        events: list[str] = []

        class FakeProcess:
            returncode = 0
            stdout = ["started\n", "done\n"]

            def poll(self) -> int | None:
                return 0

            def wait(self, timeout: float | None = None) -> int:
                return 0

        with mock.patch("maw.gui_workflow.subprocess.Popen", return_value=FakeProcess()) as popen:
            with mock.patch(
                "maw.gui_workflow.render_editor_html",
                return_value=self.srt_path.with_suffix(".edit.html"),
            ) as render_html:
                result = run_transcription(request, on_event=events.append)

        kwargs = popen.call_args.kwargs
        self.assertEqual(kwargs["env"]["DASHSCOPE_API_KEY"], "secret-key")
        self.assertEqual(kwargs["env"]["DASHSCOPE_WORKSPACE_ID"], "workspace-123")
        if sys.platform == "win32":
            self.assertTrue(kwargs["creationflags"] & subprocess.CREATE_NEW_PROCESS_GROUP)
        else:
            self.assertTrue(kwargs["start_new_session"])
        self.assertNotEqual(os.environ.get("DASHSCOPE_API_KEY"), "secret-key")
        self.assertEqual(events, ["started", "done"])
        self.assertEqual(result.srt_path, self.srt_path)
        self.assertEqual(result.json_path, self.srt_path.with_suffix(".mosp"))
        self.assertEqual(result.html_path, self.srt_path.with_suffix(".edit.html"))
        render_html.assert_called_once_with(
            self.srt_path.with_suffix(".mosp"),
            self.media_path,
            self.srt_path.with_suffix(".edit.html"),
            "en",
        )

    def test_terminate_process_tree_uses_windows_taskkill_for_descendants(self) -> None:
        class FakeProcess:
            pid = 4321
            returncode: int | None = None

            def poll(self) -> int | None:
                return self.returncode

            def wait(self, timeout: float | None = None) -> int:
                self.returncode = 0
                return 0

            def terminate(self) -> None:
                self.returncode = -15

            def kill(self) -> None:
                self.returncode = -9

        fake = FakeProcess()
        with mock.patch("maw.gui_platform.sys.platform", "win32"):
            with mock.patch("maw.gui_platform.subprocess.run", return_value=mock.Mock(returncode=0)) as taskkill:
                terminate_process_tree(fake)

        taskkill.assert_called_once()
        self.assertEqual(taskkill.call_args.args[0], ["taskkill", "/PID", "4321", "/T", "/F"])

    def test_terminate_process_tree_reaps_an_already_exited_root(self) -> None:
        class FakeProcess:
            pid = 4321
            returncode: int | None = 0
            waited = False

            def poll(self) -> int | None:
                return self.returncode

            def wait(self, timeout: float | None = None) -> int:
                self.waited = True
                return 0

        fake = FakeProcess()
        with mock.patch("maw.gui_platform.sys.platform", "win32"):
            terminate_process_tree(fake)

        self.assertTrue(fake.waited)

    def test_terminate_registered_windows_job_closes_handle_after_kill(self) -> None:
        fake = mock.Mock()
        fake._maw_job_handle = 123
        kernel32 = mock.Mock()
        kernel32.TerminateJobObject.return_value = 1

        with mock.patch("maw.gui_platform.sys.platform", "win32"):
            with mock.patch("ctypes.WinDLL", return_value=kernel32, create=True):
                self.assertTrue(_terminate_registered_job(fake))

        kernel32.TerminateJobObject.assert_called_once_with(123, 1)
        kernel32.CloseHandle.assert_called_once_with(123)
        self.assertIsNone(fake._maw_job_handle)

    def test_decode_process_output_accepts_utf8_and_bom(self) -> None:
        self.assertEqual(_decode_process_output("已开始\n"), "已开始\n")
        self.assertEqual(
            _decode_process_output(b"\xef\xbb\xbf\xe5\xb7\xb2\xe5\xbc\x80\xe5\xa7\x8b\n"),
            "已开始\n",
        )

    def test_decode_process_output_falls_back_to_windows_gbk(self) -> None:
        value = "上传失败：文件格式不支持\n".encode("cp936")
        self.assertEqual(_decode_process_output(value), "上传失败：文件格式不支持\n")

    def test_render_editor_html_embeds_requested_gui_language(self) -> None:
        json_path = self.srt_path.with_suffix(".mosp")
        html_path = self.srt_path.with_suffix(".edit.html")
        json_path.write_text(json.dumps({"segments": []}), encoding="utf-8")

        result = render_editor_html(json_path, self.media_path, html_path, "en")

        self.assertEqual(result, html_path)
        page = html_path.read_text(encoding="utf-8")
        self.assertIn('const GENERATED_LANGUAGE = typeof "en"', page)
        self.assertNotIn("__UI_LANGUAGE_JSON__", page)

    def test_render_editor_html_embeds_bwf_time_reference(self) -> None:
        json_path = self.srt_path.with_suffix('.mosp')
        html_path = self.srt_path.with_suffix('.edit.html')
        media_path = self.root / 'recording.wav'
        json_path.write_text(json.dumps({'segments': []}), encoding='utf-8')
        _write_bwf_wav(media_path, 48000, 8895762)

        result = render_editor_html(json_path, media_path, html_path)
        self.assertEqual(result, html_path)
        page = html_path.read_text(encoding='utf-8')
        self.assertIn('"sample_rate": 48000', page)
        self.assertIn('"time_reference_samples": 8895762', page)

    def test_child_environment_forces_unbuffered_python_stdout(self) -> None:
        env = _child_environment({"PYTHONUNBUFFERED": "0"}, "secret-key", "workspace-123")

        self.assertEqual(env["PYTHONUNBUFFERED"], "1")
        self.assertEqual(env["PYTHONUTF8"], "1")
        self.assertEqual(env["PYTHONIOENCODING"], "utf-8:replace")
        self.assertEqual(env["DASHSCOPE_API_KEY"], "secret-key")
        self.assertEqual(env["DASHSCOPE_WORKSPACE_ID"], "workspace-123")

    def test_child_environment_prepends_ffmpeg_path_directory(self) -> None:
        ffmpeg_dir = self.root / "ffmpeg" / "bin"
        ffmpeg_dir.mkdir(parents=True)
        ffmpeg_exe = ffmpeg_dir / "ffmpeg.exe"
        ffmpeg_exe.write_bytes(b"exe")

        env = _child_environment({"PATH": "C:\\Windows", "FFMPEG_PATH": str(ffmpeg_exe)}, "", "")

        self.assertEqual(env["PATH"].split(os.pathsep)[0], str(ffmpeg_dir))

    def test_child_environment_uses_bundled_ffmpeg_when_no_path_is_configured(self) -> None:
        ffmpeg_dir = self.root / "ffmpeg" / "bin"
        ffmpeg_dir.mkdir(parents=True)
        (ffmpeg_dir / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")).write_bytes(b"exe")
        (ffmpeg_dir / ("ffprobe.exe" if os.name == "nt" else "ffprobe")).write_bytes(b"exe")

        with mock.patch("maw.ffmpeg.bundled_ffmpeg_directories", return_value=(ffmpeg_dir,)):
            with mock.patch("maw.gui_workflow.load_env", return_value={}):
                env = _child_environment({"PATH": "C:\\Windows"}, "", "")

        self.assertEqual(env["PATH"].split(os.pathsep)[0], str(ffmpeg_dir))

    def test_child_environment_uses_release_root_ffmpeg_in_frozen_mode(self) -> None:
        app_root = self.root / "MAW"
        ffmpeg_dir = app_root / "ffmpeg" / "bin"
        ffmpeg_dir.mkdir(parents=True)
        (ffmpeg_dir / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")).write_bytes(b"exe")
        (ffmpeg_dir / ("ffprobe.exe" if os.name == "nt" else "ffprobe")).write_bytes(b"exe")

        with mock.patch("maw.gui_workflow.sys.frozen", True, create=True):
            with mock.patch("maw.gui_workflow.sys.executable", str(app_root / "MAW.exe")):
                with mock.patch("maw.gui_workflow.load_env", return_value={}):
                    env = _child_environment({"PATH": "C:\\Windows"}, "", "")

        self.assertEqual(env["PATH"].split(os.pathsep)[0], str(ffmpeg_dir))

    def test_child_environment_appends_macos_candidate_directories(self) -> None:
        with mock.patch.object(sys, "platform", "darwin"):
                with mock.patch("maw.gui_workflow.MACOS_FFMPEG_CANDIDATE_DIRECTORIES", ("/opt/homebrew/bin", "/usr/local/bin")):
                    with mock.patch("maw.gui_workflow.load_env", return_value={}):
                        env = _child_environment({"PATH": "/usr/bin"}, "", "")

        self.assertEqual(
            env["PATH"].split(os.pathsep),
            ["/usr/bin", "/opt/homebrew/bin", "/usr/local/bin"],
        )

    def test_run_transcription_reports_child_pid_after_popen(self) -> None:
        request = TranscriptionRequest(media_path=self.media_path, srt_path=self.srt_path)
        self.srt_path.write_text("1\n", encoding="utf-8")
        self.srt_path.with_suffix(".mosp").write_text('{"segments": []}\n', encoding="utf-8")
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

    def test_run_transcription_failure_carries_child_output(self) -> None:
        request = TranscriptionRequest(media_path=self.media_path, srt_path=self.srt_path)
        events: list[str] = []

        class FakeProcess:
            pid = 4321
            returncode = 1
            stdout = ["[info] 提交任务...\n".encode(), "错误: 未识别到任何内容\n".encode()]

            def poll(self) -> int | None:
                return 1

            def wait(self, timeout: float | None = None) -> int:
                return 1

        with mock.patch("maw.gui_workflow.subprocess.Popen", return_value=FakeProcess()):
            with self.assertRaises(TranscriptionProcessError) as raised:
                run_transcription(request, on_event=events.append)

        self.assertEqual(raised.exception.exit_code, 1)
        self.assertTrue(any("未识别到任何内容" in line for line in raised.exception.output))
        self.assertIn("未识别到任何内容", str(raised.exception))
        self.assertTrue(any("提交任务" in event for event in events))

    def test_run_transcription_keeps_json_when_optional_html_render_fails(self) -> None:
        request = TranscriptionRequest(media_path=self.media_path, srt_path=self.srt_path)
        self.srt_path.write_text("1\n", encoding="utf-8")
        self.srt_path.with_suffix(".mosp").write_text('{"segments": []}\n', encoding="utf-8")
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

        self.assertEqual(result.json_path, self.srt_path.with_suffix(".mosp"))
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

    def test_build_transcribe_command_local_routes_to_local_cli(self) -> None:
        request = TranscriptionRequest(
            media_path=self.media_path,
            srt_path=self.srt_path,
            provider="local",
            model="Qwen/Qwen3-ASR-0.6B",
            engine="qwen-asr",
            model_path="D:\\Models\\qwen",
            device="cpu",
        )

        command = build_transcribe_command(request, executable=Path("python.exe"), frozen=False)

        self.assertIn("generate_subtitle_local.py", command[1])
        self.assertIn("--engine", command)
        self.assertEqual(command[command.index("--model") + 1], "Qwen/Qwen3-ASR-0.6B")
        self.assertEqual(command[command.index("--model-path") + 1], "D:\\Models\\qwen")
        self.assertEqual(command[command.index("--device") + 1], "cpu")
        self.assertNotIn("--region", command)

    def test_build_transcribe_command_frozen_local_dispatches_local_flag(self) -> None:
        request = TranscriptionRequest(media_path=self.media_path, srt_path=self.srt_path, provider="local")

        command = build_transcribe_command(request, executable=Path("MAW.exe"), frozen=True)

        self.assertEqual(command[:3], ["MAW.exe", "--transcribe-local", str(self.media_path)])
        self.assertNotIn("secret-key", " ".join(command))

    def test_build_transcribe_command_funasr_uses_dashscope_script_and_speaker_colors(self) -> None:
        request = TranscriptionRequest(
            media_path=self.media_path,
            srt_path=self.srt_path,
            provider="qwen",
            model="fun-asr",
            language="zh",
            region="beijing",
            speaker_colors=True,
        )

        command = build_transcribe_command(
            request,
            executable=Path("python.exe"),
            frozen=False,
        )

        self.assertIn("generate_subtitle_qwen_api.py", command[1])
        self.assertEqual(command[command.index("--model") + 1], "fun-asr")
        self.assertEqual(command[command.index("--language") + 1], "zh")
        self.assertEqual(command[command.index("--region") + 1], "beijing")
        self.assertIn("--speaker-colors", command)

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

    def test_build_transcribe_command_frozen_tencent_dispatches_tencent_flag(self) -> None:
        request = TranscriptionRequest(
            media_path=self.media_path,
            srt_path=self.srt_path,
            provider="tencent",
            model="16k_zh_en_2.0",
        )

        command = build_transcribe_command(request, executable=Path("MAW.exe"), frozen=True)

        self.assertEqual(command[:3], ["MAW.exe", "--transcribe-tencent", str(self.media_path)])
        self.assertIn("--model", command)

    def test_child_environment_soniox_uses_soniox_key_only(self) -> None:
        env = _child_environment({}, "secret-key", "workspace-123", "soniox")

        self.assertEqual(env["SONIOX_API_KEY"], "secret-key")
        self.assertNotIn("DASHSCOPE_API_KEY", env)
        self.assertNotIn("DASHSCOPE_WORKSPACE_ID", env)
        self.assertEqual(env["PYTHONUNBUFFERED"], "1")

    def test_child_environment_tencent_injects_secret_id_and_system_secret_key(self) -> None:
        env = _child_environment(
            {"TENCENT_SECRET_KEY": "system-secret"}, "secret-id", provider="tencent"
        )

        self.assertEqual(env["TENCENT_SECRET_ID"], "secret-id")
        self.assertEqual(env["TENCENT_SECRET_KEY"], "system-secret")
        self.assertNotIn("DASHSCOPE_API_KEY", env)

    def test_default_srt_path_uses_provider_tag(self) -> None:
        from maw.gui_workflow import default_srt_path

        self.assertEqual(default_srt_path(Path("clip.mp4")).name, "clip.qwen-audio.srt")
        self.assertEqual(
            default_srt_path(Path("clip.mp4"), model="fun-asr").name,
            "clip.fun-asr.srt",
        )
        self.assertEqual(
            default_srt_path(Path("clip.mp4"), model="qwen3-asr-flash-filetrans").name,
            "clip.qwen3-asr-api.srt",
        )
        self.assertEqual(default_srt_path(Path("clip.mp4"), provider="soniox").name, "clip.soniox.srt")
        self.assertEqual(
            default_srt_path(Path("clip.mp4"), test_run=True).name,
            "clip.qwen-audio-test.srt",
        )
        self.assertEqual(default_srt_path(Path("clip.mp4"), provider="local", model="qwen3-asr-local").name, "clip.qwen-asr-local.srt")
        self.assertEqual(default_srt_path(Path("clip.mp4"), provider="local", model="qwen3-asr-1.7b-local").name, "clip.qwen3-asr-1.7b-local.srt")
        self.assertEqual(default_srt_path(Path("clip.mp4"), provider="local", model="sensevoice-small-local").name, "clip.sensevoice-local.srt")
        self.assertEqual(default_srt_path(Path("clip.mp4"), provider="local", model="fun-asr-nano-local").name, "clip.funasr-local.srt")
        self.assertEqual(default_srt_path(Path("clip.mp4"), provider="local", model="funasr-local").name, "clip.funasr-local.srt")

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

    def test_build_alignment_serve_command_source_mode_uses_standalone_server(self) -> None:
        project_path = self.root / "project.mosp"
        script_path = self.root / "script.txt"
        media_path = self.root / "clip.wav"

        command = build_alignment_serve_command(
            project_path,
            script_path,
            media_path,
            9877,
            gap_remove={
                "minimum_ms": 400,
                "threshold_db": -28,
                "hysteresis_db": 2,
                "lead_in_ms": 120,
                "lead_out_ms": 80,
            },
            executable=Path("python.exe"),
            frozen=False,
        )

        self.assertEqual(command[0], "python.exe")
        self.assertIn("server-align", command[1])
        self.assertIn("serve.py", command[1])
        self.assertEqual(command[2:4], [str(project_path), str(script_path)])
        self.assertEqual(command[command.index("--media") + 1], str(media_path))
        self.assertEqual(command[command.index("--gap-minimum-ms") + 1], "400")
        self.assertEqual(command[command.index("--gap-threshold-db") + 1], "-28")
        self.assertEqual(command[command.index("--gap-hysteresis-db") + 1], "2")
        self.assertEqual(command[command.index("--gap-lead-in-ms") + 1], "120")
        self.assertEqual(command[command.index("--gap-lead-out-ms") + 1], "80")
        self.assertEqual(command[command.index("--port") + 1], "9877")

    def test_build_alignment_serve_command_frozen_mode_dispatches_same_executable(self) -> None:
        project_path = self.root / "project.mosp"
        script_path = self.root / "script.txt"

        command = build_alignment_serve_command(
            project_path,
            script_path,
            None,
            9877,
            executable=Path("MAW.exe"),
            frozen=True,
        )

        self.assertEqual(command[:4], ["MAW.exe", "--serve-alignment", str(project_path), str(script_path)])
        self.assertNotIn("--media", command)
        self.assertEqual(command[command.index("--port") + 1], "9877")

    def test_build_serve_command_without_project_leaves_restore_to_server(self) -> None:
        command = build_serve_command(None, None, 8765, executable=Path("python.exe"), frozen=False)

        self.assertEqual(command[0], "python.exe")
        self.assertIn("serve.py", command[1])
        self.assertNotIn("--blank", command)
        self.assertNotIn("-m", command)
        self.assertEqual(command[command.index("--port") + 1], "8765")

    def test_build_serve_command_without_project_frozen_uses_serve_flag(self) -> None:
        command = build_serve_command(None, None, 8765, executable=Path("MAW.exe"), frozen=True)

        self.assertEqual(command[:2], ["MAW.exe", "--serve"])
        self.assertNotIn("--blank", command)
        self.assertEqual(command[command.index("--port") + 1], "8765")

    def test_entrypoint_smoke_import_argument_does_not_open_window(self) -> None:
        import maw_gui

        with mock.patch("maw.gui_web.run_app") as run_app, mock.patch("maw_gui.configure_utf8_stdio") as configure:
            exit_code = maw_gui.main(["--smoke-import"])

        self.assertEqual(exit_code, 0)
        run_app.assert_not_called()
        configure.assert_called_once_with()

    def test_entrypoint_alignment_server_dispatches_to_internal_server(self) -> None:
        import maw_gui

        with mock.patch("maw_gui._run_internal_alignment_serve", return_value=0) as run_server:
            self.assertEqual(maw_gui.main(["--serve-alignment", "project.mosp", "script.txt"]), 0)

        run_server.assert_called_once_with(["project.mosp", "script.txt"])
    def test_startup_error_log_path_uses_shared_maw_log_directory(self) -> None:
        import maw_gui

        with mock.patch.object(maw_gui.sys, "platform", "win32"), mock.patch.object(
            maw_gui.sys, "executable", str(self.root / "MAW.exe")
        ), mock.patch.object(maw_gui.sys, "frozen", True, create=True), mock.patch.dict(
            os.environ,
            {"LOCALAPPDATA": str(self.root / "LocalAppData"), "MAW_APP_DATA_ROOT": ""},
            clear=False,
        ):
            self.assertEqual(
                _startup_error_log_path(),
                self.root / "LocalAppData" / "MAW" / "logs" / "launcher-startup.log",
            )

    def test_startup_error_fallback_uses_shared_maw_log_directory(self) -> None:
        import maw_gui

        with mock.patch("maw.app_paths.sys.platform", "win32"), mock.patch.dict(
            os.environ,
            {"LOCALAPPDATA": str(self.root / "LocalAppData"), "MAW_APP_DATA_ROOT": ""},
            clear=False,
        ):
            self.assertEqual(
                maw_gui._startup_error_fallback_log_path(),
                self.root / "LocalAppData" / "MAW" / "logs" / "launcher-startup.log",
            )

    def test_entrypoint_debug_aliases_configure_launcher_debug_modes(self) -> None:
        import maw_gui

        for argv, expected in (
            (["-dbg"], mock.call(debug=True, devtools=False)),
            (["--debug"], mock.call(debug=True, devtools=False)),
            (["-dt"], mock.call(debug=True, devtools=True)),
            (["--devtools"], mock.call(debug=True, devtools=True)),
        ):
            with self.subTest(argv=argv), mock.patch("maw.gui_web.run_app") as run_app:
                self.assertEqual(maw_gui.main(argv), 0)
                run_app.assert_called_once_with(**expected.kwargs)

    def test_entrypoint_open_project_routes_through_launcher(self) -> None:
        import maw_gui

        with mock.patch("maw.gui_web.run_app") as run_app:
            self.assertEqual(maw_gui.main(["--open-project", "project.mosp"]), 0)

        run_app.assert_called_once_with(
            debug=False,
            devtools=False,
            initial_project_path="project.mosp",
        )

    def test_entrypoint_gui_failure_uses_friendly_startup_boundary(self) -> None:
        import maw_gui

        error = RuntimeError(
            r"Failed to resolve Python.Runtime.Loader.Initialize from C:\MAW\_internal\pythonnet\runtime\Python.Runtime.dll"
        )
        log_path = Path(r"C:\Temp\launcher-startup.log")
        with mock.patch("maw_gui.sys.platform", "win32"):
            with mock.patch("maw_gui.main", side_effect=error):
                with mock.patch("maw_gui._write_startup_error_log", return_value=log_path):
                    with mock.patch("maw_gui._show_startup_error") as show_error:
                        exit_code = maw_gui.run_entrypoint([])

        self.assertEqual(exit_code, 1)
        show_error.assert_called_once_with(error, log_path)
        message = maw_gui._startup_error_message(error, log_path)
        self.assertIn("解除锁定", message)
        self.assertIn("完整解压", message)
        self.assertNotIn("Traceback", message)

    def test_entrypoint_unknown_windows_gui_shows_hint_then_reraises(self) -> None:
        import maw_gui

        error = RuntimeError("unrelated GUI failure")
        with mock.patch("maw_gui.sys.platform", "win32"):
            with mock.patch("maw_gui.main", side_effect=error):
                with mock.patch("maw_gui._show_unknown_startup_hint") as show_hint:
                    with self.assertRaises(RuntimeError) as raised:
                        maw_gui.run_entrypoint([])

        self.assertIs(raised.exception, error)
        show_hint.assert_called_once_with()

    def test_entrypoint_python_runtime_marker_is_not_owned_on_non_windows(self) -> None:
        import maw_gui

        error = RuntimeError("Python.Runtime.Loader.Initialize failed: Python.Runtime.dll")
        with mock.patch("maw_gui.sys.platform", "linux"):
            with mock.patch("maw_gui.main", side_effect=error):
                with mock.patch("maw_gui._write_startup_error_log") as write_log:
                    with mock.patch("maw_gui._show_startup_error") as show_error:
                        with mock.patch("maw_gui._show_unknown_startup_hint") as show_hint:
                            with self.assertRaises(RuntimeError) as raised:
                                maw_gui.run_entrypoint([])

        self.assertIs(raised.exception, error)
        write_log.assert_not_called()
        show_error.assert_not_called()
        show_hint.assert_not_called()

    def test_entrypoint_internal_failure_prints_concise_ffmpeg_error(self) -> None:
        import maw_gui

        error = FileNotFoundError(2, "not found", "ffprobe.exe")
        with mock.patch("maw_gui.sys.platform", "win32"):
            with mock.patch("maw_gui.main", side_effect=error):
                with mock.patch("maw_gui._show_startup_error") as show_error:
                    with mock.patch("builtins.print") as print_message:
                        exit_code = maw_gui.run_entrypoint(["--transcribe"])

        self.assertEqual(exit_code, 1)
        show_error.assert_not_called()
        self.assertIn("找不到 FFmpeg / FFprobe", str(print_message.call_args.args[0]))

    def test_entrypoint_tencent_internal_failure_prints_concise_ffmpeg_error(self) -> None:
        import maw_gui

        error = FileNotFoundError(2, "not found", "ffprobe.exe")
        with mock.patch("maw_gui.sys.platform", "win32"):
            with mock.patch("maw_gui.main", side_effect=error):
                with mock.patch("maw_gui._show_startup_error") as show_error:
                    with mock.patch("builtins.print") as print_message:
                        exit_code = maw_gui.run_entrypoint(["--transcribe-tencent"])

        self.assertEqual(exit_code, 1)
        show_error.assert_not_called()
        self.assertIn("找不到 FFmpeg / FFprobe", str(print_message.call_args.args[0]))

    def test_entrypoint_unknown_gui_failure_is_reraised_unchanged(self) -> None:
        import maw_gui

        error = RuntimeError("unrelated GUI failure")
        with mock.patch("maw_gui.sys.platform", "win32"):
            with mock.patch("maw_gui.main", side_effect=error):
                with mock.patch("maw_gui._show_startup_error") as show_error:
                    with mock.patch("maw_gui._show_unknown_startup_hint") as show_hint:
                        with self.assertRaises(RuntimeError) as raised:
                            maw_gui.run_entrypoint([])

        self.assertIs(raised.exception, error)
        show_error.assert_not_called()
        show_hint.assert_called_once_with()

    def test_entrypoint_unknown_internal_failure_is_reraised_unchanged(self) -> None:
        import maw_gui

        error = RuntimeError("unrelated transcription failure")
        with mock.patch("maw_gui.main", side_effect=error):
            with mock.patch("builtins.print") as print_message:
                with self.assertRaises(RuntimeError) as raised:
                    maw_gui.run_entrypoint(["--transcribe"])

        self.assertIs(raised.exception, error)
        print_message.assert_not_called()

    def test_entrypoint_serve_ffmpeg_failure_is_not_reclassified(self) -> None:
        import maw_gui

        error = FileNotFoundError(2, "not found", "ffmpeg.exe")
        with mock.patch("maw_gui.sys.platform", "win32"):
            with mock.patch("maw_gui.main", side_effect=error):
                with mock.patch("builtins.print") as print_message:
                    with self.assertRaises(FileNotFoundError) as raised:
                        maw_gui.run_entrypoint(["--serve"])

        self.assertIs(raised.exception, error)
        print_message.assert_not_called()

    def test_ffmpeg_missing_boundary_does_not_match_generic_file_error(self) -> None:
        with mock.patch("maw_gui.sys.platform", "win32"):
            self.assertTrue(_is_ffmpeg_missing_error(FileNotFoundError(2, "not found", "ffprobe.exe")))
            self.assertTrue(_is_ffmpeg_missing_error(RuntimeError("[WinError 2] ffmpeg.exe was not found")))
            self.assertFalse(_is_ffmpeg_missing_error(FileNotFoundError(2, "input media is missing", "clip.mp3")))
            self.assertFalse(_is_ffmpeg_missing_error(RuntimeError("[WinError 2] a configuration file was not found")))

    def test_debug_flag_with_transcription_arguments_remains_public_cli(self) -> None:
        import maw_gui

        with mock.patch("maw.cli.main", return_value=7) as cli_main:
            exit_code = maw_gui.main(["--debug", "--input", "clip.mp3"])

        self.assertEqual(exit_code, 7)
        cli_main.assert_called_once_with(["--debug", "--input", "clip.mp3"])

    def test_entrypoint_debug_port_is_forwarded_to_launcher(self) -> None:
        import maw_gui

        with mock.patch("maw.gui_web.run_app") as run_app:
            self.assertEqual(maw_gui.main(["-dbg", "--port", "8258"]), 0)

        run_app.assert_called_once_with(debug=True, devtools=False, server_port=8258)

    def test_entrypoint_help_subprocess_is_headless_safe(self) -> None:
        completed = subprocess.run(
            [sys.executable, str(ROOT / "maw_gui.py"), "--help"],
            check=False,
            capture_output=True,
            text=True,
        )

        self.assertEqual(completed.returncode, 0)
        self.assertIn("MAW 命令行", completed.stdout)
        self.assertIn("--server", completed.stdout)


if __name__ == "__main__":
    unittest.main()
