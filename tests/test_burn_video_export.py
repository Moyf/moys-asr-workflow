"""Editor ASS burn-in video export: command construction, HTTP job lifecycle."""
from __future__ import annotations

from tests.compact_assertions import CompactContainerAssertions

import importlib.util
import json
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "server-editor" / "serve.py"
SPEC = importlib.util.spec_from_file_location("asr_local_editor_server_burn", SERVER_PATH)
assert SPEC and SPEC.loader
server_editor = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = server_editor
SPEC.loader.exec_module(server_editor)


ASS_TEXT = (
    "[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\n\n"
    "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    "Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,你好\n"
)


class BurnAssVideoTests(CompactContainerAssertions, unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name).resolve()
        self.source = self.root / "clip.mp4"
        self.source.write_bytes(b"source")
        self.output = self.root / "private" / "restructured.mp4"
        self.calls: list[list[str]] = []
        attempts_patcher = mock.patch.object(server_editor, "video_encoder_attempts", return_value=("cpu",))
        attempts_patcher.start()
        self.addCleanup(attempts_patcher.stop)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def _run_full_video(self, source: Path | None = None):
        source = source or self.source

        def run(command, **kwargs):
            self.calls.append(command)
            if command[0] == "ffprobe":
                return subprocess.CompletedProcess(command, 0,
                    stdout=json.dumps({"format": {"duration": "4.5"}}), stderr="")
            Path(command[-1]).write_bytes(b"burned")
            return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

        with mock.patch.object(server_editor.subprocess, "run", side_effect=run):
            return server_editor.burn_ass_video(
                source, [], ASS_TEXT, self.output,
                ffmpeg_path=Path("ffmpeg"), ffprobe_path=Path("ffprobe"),
            )

    def test_full_video_burn_builds_launcher_style_encoder_command(self) -> None:
        result = self._run_full_video()
        self.assertEqual(result, self.output)
        self.assertEqual(self.output.read_bytes(), b"burned")
        ass_path = self.output.parent / "burn.ass"
        self.assertEqual(ass_path.read_text(encoding="utf-8"), ASS_TEXT)
        command = next(command for command in self.calls if command[0] == "ffmpeg")
        self.assertEqual(command[command.index("-i") + 1], str(self.source.resolve()))
        self.assertEqual(command[command.index("-vf") + 1], "ass=filename='burn.ass'")
        self.assertEqual(command[command.index("-map") + 1], "0:v:0")
        self.assertEqual(command[command.index("-map", command.index("-map") + 1) + 1], "0:a?")
        self.assertEqual(command[command.index("-c:v") + 1], "libx264")
        self.assertEqual(command[command.index("-crf") + 1], "21")
        self.assertEqual(command[command.index("-preset") + 1], "medium")
        self.assertEqual(command[command.index("-c:a") + 1], "aac")
        self.assertEqual(command[command.index("-b:a") + 1], "192k")
        self.assertEqual(command[command.index("-pix_fmt") + 1], "yuv420p")
        self.assertEqual(command[command.index("-movflags") + 1], "+faststart")
        self.assertNotIn("-progress", command)
        self.assertEqual(command[-1], str(self.output))

    def test_full_video_burn_resolves_source_and_runs_in_ass_directory(self) -> None:
        seen: dict[str, object] = {}

        def run(command, **kwargs):
            seen["cwd"] = kwargs.get("cwd")
            if command[0] == "ffprobe":
                return subprocess.CompletedProcess(command, 0,
                    stdout=json.dumps({"format": {"duration": "4.5"}}), stderr="")
            Path(command[-1]).write_bytes(b"burned")
            return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

        self.output.parent.mkdir(parents=True, exist_ok=True)
        with mock.patch.object(server_editor.subprocess, "run", side_effect=run):
            server_editor.burn_ass_video(self.source, [], ASS_TEXT, self.output,
                ffmpeg_path=Path("ffmpeg"), ffprobe_path=Path("ffprobe"))
        self.assertEqual(seen["cwd"], self.output.parent)

    def test_interval_burn_filters_decoded_video_and_audio(self) -> None:
        streams = [
            {"codec_type": "video", "codec_name": "h264"},
            {"codec_type": "audio", "codec_name": "aac", "channels": 2, "sample_rate": "48000"},
        ]

        def run(command, **kwargs):
            self.calls.append(command)
            if command[0] == "ffprobe":
                return subprocess.CompletedProcess(command, 0,
                    stdout=json.dumps({"streams": streams, "format": {"start_time": "1.4"}}), stderr="")
            Path(command[-1]).write_bytes(b"burned")
            return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

        with mock.patch.object(server_editor.subprocess, "run", side_effect=run):
            server_editor.burn_ass_video(self.source, [(0, 1250), (2000, 3500)], ASS_TEXT, self.output,
                ffmpeg_path=Path("ffmpeg"), ffprobe_path=Path("ffprobe"))
        command = next(command for command in self.calls if command[0] == "ffmpeg")
        self.assertNotIn("concat", command)
        self.assertEqual(command[command.index("-i") + 1], str(self.source.resolve()))
        graph = Path(command[command.index("-/filter_complex") + 1]).read_text(encoding="utf-8")
        self.assertIn("atrim=start=0.000:end=1.250", graph)
        self.assertIn("atrim=start=2.000:end=3.500", graph)
        self.assertIn("[burn_video]", command)
        self.assertIn("[burn_audio_0]", command)
        durations = [command[index + 1] for index, value in enumerate(command) if value == "-t"]
        self.assertEqual(durations, ["3.500", "2.750"])

    def test_interval_burn_retries_legacy_syntax_only_for_unknown_option(self) -> None:
        for error in ("Unrecognized option '/filter_complex'.", "Encoder initialization failed"):
            with self.subTest(error=error):
                calls = []

                def run(command, **kwargs):
                    if command[0] == "ffprobe":
                        return subprocess.CompletedProcess(command, 0,
                            stdout=json.dumps({"streams": [{"codec_type": "video", "codec_name": "h264"}]}), stderr="")
                    calls.append(list(command))
                    if "-/filter_complex" in command:
                        return subprocess.CompletedProcess(command, 1, stdout="", stderr=error)
                    Path(command[-1]).write_bytes(b"burned")
                    return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

                with mock.patch.object(server_editor.subprocess, "run", side_effect=run):
                    def burn():
                        return server_editor.burn_ass_video(self.source, [(0, 1000)], ASS_TEXT, self.output,
                            ffmpeg_path=Path("ffmpeg"), ffprobe_path=Path("ffprobe"))
                    if error.startswith("Unrecognized option"):
                        self.assertEqual(burn(), self.output)
                        self.assertEqual(len(calls), 2)
                        self.assertIn("-filter_complex_script", calls[1])
                    else:
                        with self.assertRaises(server_editor.BurnVideoExportError):
                            burn()
                        self.assertEqual(len(calls), 1)

    def test_auto_encoder_fallback_retries_next_encoder(self) -> None:
        def run(command, **kwargs):
            self.calls.append(command)
            if command[0] == "ffprobe":
                return subprocess.CompletedProcess(command, 0,
                    stdout=json.dumps({"format": {"duration": "4.5"}}), stderr="")
            if command[command.index("-c:v") + 1] != "libx264":
                return subprocess.CompletedProcess(command, 1, stdout="", stderr="nvenc exploded")
            Path(command[-1]).write_bytes(b"burned")
            return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

        with mock.patch.object(server_editor.subprocess, "run", side_effect=run), \
                mock.patch.object(server_editor, "video_encoder_attempts", return_value=("nvenc", "cpu")):
            result = server_editor.burn_ass_video(self.source, [], ASS_TEXT, self.output,
                ffmpeg_path=Path("ffmpeg"), ffprobe_path=Path("ffprobe"))
        self.assertEqual(result, self.output)
        encoders = [command[command.index("-c:v") + 1] for command in self.calls if command[0] == "ffmpeg"]
        self.assertEqual(encoders, ["h264_nvenc", "libx264"])

    def test_missing_glyph_aborts_without_fallback_or_output(self) -> None:
        warning = (
            "[Parsed_ass_0 @ 0x123] fontselect: failed to find any fallback "
            "with glyph 0x4E2D for font: (PingFang SC, 700, 0)\n"
        )

        def run(command, **kwargs):
            self.calls.append(command)
            if command[0] == "ffprobe":
                return subprocess.CompletedProcess(command, 0,
                    stdout=json.dumps({"format": {"duration": "4.5"}}), stderr="")
            Path(command[-1]).write_bytes(b"boxes")
            return subprocess.CompletedProcess(command, 0, stdout="", stderr=warning)

        with mock.patch.object(server_editor.subprocess, "run", side_effect=run), \
                mock.patch.object(server_editor, "video_encoder_attempts", return_value=("nvenc", "cpu")):
            with self.assertRaisesRegex(server_editor.BurnVideoExportError, "缺少字形"):
                server_editor.burn_ass_video(self.source, [], ASS_TEXT, self.output,
                    ffmpeg_path=Path("ffmpeg"), ffprobe_path=Path("ffprobe"))
        self.assertEqual([command for command in self.calls if command[0] == "ffmpeg"], [self.calls[1]])
        self.assertFalse(self.output.exists())

    def test_encoder_failure_without_alternative_cleans_up_and_reports_details(self) -> None:
        def run(command, **kwargs):
            if command[0] == "ffprobe":
                return subprocess.CompletedProcess(command, 0,
                    stdout=json.dumps({"format": {"duration": "4.5"}}), stderr="")
            return subprocess.CompletedProcess(command, 1, stdout="", stderr="encoder dead")

        with mock.patch.object(server_editor.subprocess, "run", side_effect=run):
            with self.assertRaisesRegex(server_editor.BurnVideoExportError, "视频烧录失败") as context:
                server_editor.burn_ass_video(self.source, [], ASS_TEXT, self.output,
                    ffmpeg_path=Path("ffmpeg"), ffprobe_path=Path("ffprobe"))
        self.assertIn("encoder dead", context.exception.details or "")

    def test_invalid_sources_and_content_are_rejected(self) -> None:
        audio = self.root / "clip.mp3"
        audio.write_bytes(b"audio")
        for source, intervals, ass in (
            (audio, [], ASS_TEXT),
            (self.root / "missing.mp4", [], ASS_TEXT),
            (self.source, [(500, 500)], ASS_TEXT),
            (self.source, [], "   "),
        ):
            with self.subTest(source=source.name, intervals=intervals, ass=bool(ass)):
                with self.assertRaises(server_editor.BurnVideoExportError):
                    server_editor.burn_ass_video(source, intervals, ass, self.output,
                        ffmpeg_path=Path("ffmpeg"), ffprobe_path=Path("ffprobe"))
        self.assertFalse(self.output.exists())

    def test_green_screen_audio_and_video_sources_keep_finite_canvas_and_optional_audio(self):
        for extension in (".wav", ".mp4"):
            source = self.root / ("source" + extension)
            source.write_bytes(b"source")
            for include_audio in (False, True):
                calls = []
                def run(command, **kwargs):
                    calls.append(command)
                    Path(command[-1]).write_bytes(b"green")
                    return subprocess.CompletedProcess(command, 0, stdout="", stderr="")
                with mock.patch.object(server_editor.subprocess, "run", side_effect=run):
                    server_editor.burn_ass_video(source, [], ASS_TEXT, self.output,
                        ffmpeg_path=Path("ffmpeg"), ffprobe_path=Path("ffprobe"),
                        green_screen=True, include_audio=include_audio, audio_track=1)
                command = calls[0]
                self.assertIn("color=c=0x00ff00:s=1920x1080:r=30:d=1.500", command)
                self.assertEqual(command[command.index("-t") + 1], "1.500")
                self.assertNotIn("-shortest", command)
                if include_audio:
                    self.assertIn("1:a:1?", command)
                    self.assertIn(str(source.resolve()), command)
                    self.assertNotIn("-an", command)
                else:
                    self.assertIn("-an", command)
                    self.assertNotIn(str(source.resolve()), command)


class BurnVideoJobHttpTests(unittest.TestCase):
    def setUp(self):
        from tests.test_local_editor_server import server_editor as loaded_server_editor
        self.server_editor = loaded_server_editor
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.source = self.root / "source.mp4"
        self.source.write_bytes(b"unchanged source")
        project = self.server_editor.ServerProject(data={"segments": []}, json_path=self.root / "project.json",
            media_path=self.source, source_media_path=self.source, sticker_root=None, stickers=[])
        self.server = self.server_editor.EditorServer(("127.0.0.1", 0), project, no_waveform=True)
        self.server.media_jobs.temp_root = self.root
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.base = "/api/exports/burned-video/jobs"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)
        self.temp.cleanup()

    def request(self, path, payload=None, token=True):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["X-MAW-Request-Token"] = self.server.request_token
        data = json.dumps(payload).encode() if payload is not None else None
        request = urllib.request.Request(self.origin + path, data=data, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                body = response.read()
                return response.status, json.loads(body) if "json" in response.headers.get("Content-Type", "") else body
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())

    def payload(self, **overrides):
        request = {"requestToken": self.server.request_token,
                   **self.server.project_binding_payload(),
                   "ass": ASS_TEXT}
        request.update(overrides)
        return request

    def wait(self, job_id, state):
        result = None
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            _, result = self.request(self.base + "/" + job_id)
            if result["state"] == state:
                return result
            time.sleep(.01)
        self.assertEqual(result and result["state"], state, result and result.get("error"))

    def tools(self):
        return mock.Mock(ffmpeg=Path("ffmpeg"), ffprobe=Path("ffprobe"))

    def test_http_burn_job_lifecycle_download_and_filename(self) -> None:
        captured = {}

        def burn(source, intervals, ass, output, **kwargs):
            captured["source"] = source
            captured["intervals"] = intervals
            captured["ass"] = ass
            output.write_bytes(b"burned-video")

        tools = self.tools()
        with mock.patch.object(self.server_editor, "editor_ffmpeg_tools", return_value=tools), \
             mock.patch.object(self.server_editor.EditorServer, "ensure_libass_supported", return_value=True), \
             mock.patch.object(self.server_editor, "burn_ass_video", side_effect=burn):
            status, job = self.request(self.base, self.payload())
            self.assertEqual(status, 202)
            job_id = job["jobId"]
            self.wait(job_id, "ready")
            self.assertEqual(self.request(self.base + "/" + job_id, token=False)[0], 403)
            self.assertEqual(self.request(self.base, self.payload())[0], 409)
            status, body = self.request(self.base + "/" + job_id + "/download")
            self.assertEqual((status, body), (200, b"burned-video"))
            self.wait(job_id, "completed")
        self.assertEqual(captured["source"], self.source)
        self.assertEqual(captured["intervals"], [])
        self.assertEqual(captured["ass"], ASS_TEXT)
        self.assertEqual(self.source.read_bytes(), b"unchanged source")
        self.assertEqual(self.request(self.base + "/" + job_id + "/download")[0], 409)

    def test_http_interval_burn_passes_normalized_intervals(self) -> None:
        captured = {}

        def burn(source, intervals, ass, output, **kwargs):
            captured["intervals"] = intervals
            output.write_bytes(b"burned-video")

        with mock.patch.object(self.server_editor, "editor_ffmpeg_tools", return_value=self.tools()), \
             mock.patch.object(self.server_editor.EditorServer, "ensure_libass_supported", return_value=True), \
             mock.patch.object(self.server_editor, "burn_ass_video", side_effect=burn):
            status, job = self.request(self.base, self.payload(intervals=[{"startMs": 0, "endMs": 1000}]))
            self.assertEqual(status, 202)
            self.wait(job["jobId"], "ready")
            status, _ = self.request(self.base + "/" + job["jobId"] + "/download")
            self.assertEqual(status, 200)
        self.assertEqual(captured["intervals"], [(0, 1000)])

    def test_http_start_validates_ass_and_intervals(self) -> None:
        tools = self.tools()
        with mock.patch.object(self.server_editor, "editor_ffmpeg_tools", return_value=tools), \
             mock.patch.object(self.server_editor.EditorServer, "ensure_libass_supported", return_value=True):
            self.assertEqual(self.request(self.base, self.payload(ass=""))[0], 400)
            self.assertEqual(self.request(self.base, self.payload(ass="   "))[0], 400)
            self.assertEqual(self.request(self.base, self.payload(intervals=[]))[0], 400)
            self.assertEqual(self.request(self.base, self.payload(intervals="bad"))[0], 400)
        self.assertEqual(self.server.media_jobs.jobs, {})

    def test_http_start_rejects_audio_source_and_missing_libass(self) -> None:
        audio_project = self.server_editor.ServerProject(data={"segments": []},
            json_path=self.root / "audio.json", media_path=self.root / "song.mp3",
            source_media_path=self.root / "song.mp3", sticker_root=None, stickers=[])
        (self.root / "song.mp3").write_bytes(b"audio")
        self.server.project = audio_project
        with mock.patch.object(self.server_editor, "editor_ffmpeg_tools", return_value=self.tools()), \
             mock.patch.object(self.server_editor.EditorServer, "ensure_libass_supported", return_value=True):
            status, error = self.request(self.base, self.payload())
            self.assertEqual(status, 400)
            self.assertIn("视频源", error["error"])
        self.server.project = self.server_editor.ServerProject(data={"segments": []},
            json_path=self.root / "project.json", media_path=self.source,
            source_media_path=self.source, sticker_root=None, stickers=[])
        with mock.patch.object(self.server_editor, "editor_ffmpeg_tools", return_value=self.tools()), \
             mock.patch.object(self.server_editor.EditorServer, "ensure_libass_supported", return_value=False):
            status, error = self.request(self.base, self.payload())
            self.assertEqual(status, 503)
            self.assertIn("libass", error["error"])

    def test_http_green_screen_accepts_bound_audio_and_rejects_invalid_options(self):
        audio = self.root / "song.wav"
        audio.write_bytes(b"audio")
        self.server.project = self.server_editor.ServerProject(data={"segments": [], "media_metadata": {"selected_audio_track": 1}},
            json_path=self.root / "audio.json", media_path=audio,
            source_media_path=audio, sticker_root=None, stickers=[], audio_track=1)
        captured = {}
        def burn(source, intervals, ass, output, **kwargs):
            captured.update(kwargs)
            output.write_bytes(b"green")
        with mock.patch.object(self.server_editor, "editor_ffmpeg_tools", return_value=self.tools()), \
             mock.patch.object(self.server_editor.EditorServer, "ensure_libass_supported", return_value=True), \
             mock.patch.object(self.server_editor, "burn_ass_video", side_effect=burn):
            for options in ({"greenScreen": "true"}, {"greenScreen": True, "includeAudio": 1},
                            {"greenScreen": True, "intervals": [{"startMs": 0, "endMs": 100}]}):
                self.assertEqual(self.request(self.base, self.payload(**options))[0], 400)
            status, result = self.request(self.base, self.payload(greenScreen=True, includeAudio=True))
            self.assertEqual(status, 202)
            self.wait(result["jobId"], "ready")
            self.assertTrue(captured["green_screen"])
            self.assertTrue(captured["include_audio"])
            self.assertEqual(captured["audio_track"], 1)

    def test_http_cancel_admission_and_expired_deadline_are_conflicts(self) -> None:
        token = "b" * 64
        cancel = {"requestToken": self.server.request_token, "admissionToken": token}
        self.assertEqual(self.request(self.base + "/cancel-admission", {**cancel, "requestToken": "wrong"})[0], 403)
        self.assertEqual(self.request(self.base + "/cancel-admission", cancel)[0], 200)
        payload = {**self.payload(), "admissionToken": token,
                   "admissionDeadline": int(time.time() * 1000) + 60000}
        with mock.patch.object(self.server_editor, "editor_ffmpeg_tools", return_value=self.tools()), \
             mock.patch.object(self.server_editor.EditorServer, "ensure_libass_supported", return_value=True):
            self.assertEqual(self.request(self.base, payload)[0], 409)
            self.assertEqual(self.request(self.base, {**payload, "admissionToken": "c" * 64,
                "admissionDeadline": int(time.time() * 1000) - 1})[0], 409)
        self.assertIsNone(self.server.media_jobs.active)


if __name__ == "__main__":
    unittest.main()


class BurnVideoPrecisionTests(CompactContainerAssertions, unittest.TestCase):
    """Real decoded media, including cuts between keyframes and audio samples."""

    @classmethod
    def setUpClass(cls):
        cls.ffmpeg = shutil.which('ffmpeg')
        cls.ffprobe = shutil.which('ffprobe')
        if not cls.ffmpeg or not cls.ffprobe:
            raise unittest.SkipTest('Real burn precision checks require FFmpeg and FFprobe')

    def run_tool(self, args):
        return subprocess.run(args, capture_output=True, check=True, timeout=45)

    def test_real_green_screen_optional_audio_and_caption_duration(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for source_duration in (0.3, 3):
                source = root / f"tone-{source_duration}.wav"
                self.run_tool([self.ffmpeg, "-y", "-v", "error", "-f", "lavfi", "-i",
                               f"sine=frequency=440:duration={source_duration}", str(source)])
                for include_audio in (False, True):
                    output = root / f"green-{source_duration}-{include_audio}" / "out.mp4"
                    with mock.patch.object(server_editor, "video_encoder_attempts", return_value=("cpu",)), \
                         mock.patch.object(server_editor, "_green_screen_size_resolution", return_value=(160, 90)):
                        server_editor.burn_ass_video(source, [], ASS_TEXT.replace("你好", "OK"), output,
                            ffmpeg_path=Path(self.ffmpeg), ffprobe_path=Path(self.ffprobe),
                            green_screen=True, include_audio=include_audio)
                    probe = json.loads(self.run_tool([self.ffprobe, "-v", "error", "-show_streams",
                        "-show_format", "-of", "json", str(output)]).stdout)
                    self.assertEqual(sum(s["codec_type"] == "audio" for s in probe["streams"]), int(include_audio))
                    self.assertLess(abs(float(probe["format"]["duration"]) - 1.5), .1)

    def test_long_gop_cuts_exclude_removed_frames_and_keep_audio_clock(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / 'colors.mp4'
            command = [self.ffmpeg, '-y', '-hide_banner', '-loglevel', 'error']
            for color in ('red', 'green', 'blue'):
                command += ['-f', 'lavfi', '-i', f'color={color}:s=160x90:r=25:d=1']
            for hz in (440, 880, 1320):
                command += ['-f', 'lavfi', '-i', f'sine=frequency={hz}:sample_rate=48000:duration=1']
            command += ['-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v];[3:a][4:a][5:a]concat=n=3:v=0:a=1[a]',
                        '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-g', '250', '-keyint_min', '250',
                        '-sc_threshold', '0', '-bf', '2', '-pix_fmt', 'yuv420p', '-c:a', 'aac', str(source)]
            self.run_tool(command)
            for start in (1250, 1240):
                with self.subTest(start=start):
                    output = root / f'burn-{start}' / 'out.mp4'
                    with mock.patch.object(server_editor, 'video_encoder_attempts', return_value=('cpu',)):
                        server_editor.burn_ass_video(source, [(start, start + 500), (start + 1000, start + 1500)],
                            ASS_TEXT.replace('你好', 'OK'), output, ffmpeg_path=Path(self.ffmpeg), ffprobe_path=Path(self.ffprobe))
                    probe = json.loads(self.run_tool([self.ffprobe, '-v', 'error', '-count_frames', '-show_entries',
                        'stream=codec_type,nb_read_frames,duration:format=duration', '-of', 'json', str(output)]).stdout)
                    self.assertAlmostEqual(float(probe['format']['duration']), 1.0, delta=0.041)
                    video = next(stream for stream in probe['streams'] if stream['codec_type'] == 'video')
                    self.assertLessEqual(abs(int(video['nb_read_frames']) - 25), 1)
                    pixels = self.run_tool([self.ffmpeg, '-v', 'error', '-i', str(output), '-vf', 'scale=1:1',
                        '-fps_mode', 'passthrough', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']).stdout
                    colors = [max(range(3), key=lambda channel: pixels[i + channel]) for i in range(0, len(pixels), 3)]
                    self.assertNotIn(0, colors, 'Removed red frames must never survive either cut')
                    self.assertIn(1, colors)
                    self.assertIn(2, colors)
                    pcm = self.run_tool([self.ffmpeg, '-v', 'error', '-i', str(output), '-vn', '-ac', '1', '-ar', '48000',
                        '-f', 'f32le', '-']).stdout
                    samples = struct.unpack('<' + 'f' * (len(pcm) // 4), pcm)
                    self.assertLessEqual(abs(len(samples) - 48000), 1024)
                    for begin, end, expected in ((0.1, 0.4, 880), (0.6, 0.9, 1320)):
                        section = samples[int(begin * 48000):int(end * 48000)]
                        crossings = sum(a <= 0 < b for a, b in zip(section, section[1:]))
                        self.assertAlmostEqual(crossings / (end - begin), expected, delta=8)

    def test_nonzero_origin_keeps_two_audio_tracks_and_initial_audio_offset(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / 'offset.mkv'
            self.run_tool([self.ffmpeg, '-y', '-v', 'error', '-f', 'lavfi', '-i',
                'color=green:s=160x90:r=25:d=3', '-itsoffset', '0.2', '-f', 'lavfi', '-i',
                'sine=frequency=880:sample_rate=48000:duration=2.8', '-f', 'lavfi', '-i',
                'sine=frequency=1320:sample_rate=48000:duration=3', '-map', '0:v', '-map', '1:a', '-map', '2:a',
                '-c:v', 'libx264', '-g', '250', '-sc_threshold', '0', '-c:a', 'pcm_s16le',
                '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=jpn',
                '-disposition:a:0', '0', '-disposition:a:1', 'default', '-output_ts_offset', '2', str(source)])
            output = root / 'output' / 'out.mp4'
            with mock.patch.object(server_editor, 'video_encoder_attempts', return_value=('cpu',)):
                server_editor.burn_ass_video(source, [(100, 600), (2100, 2600)], ASS_TEXT.replace('你好', 'OK'), output,
                    ffmpeg_path=Path(self.ffmpeg), ffprobe_path=Path(self.ffprobe))
            probe = json.loads(self.run_tool([self.ffprobe, '-v', 'error', '-show_entries',
                'stream=codec_type:stream_tags=language:stream_disposition:format=duration', '-of', 'json', str(output)]).stdout)
            self.assertAlmostEqual(float(probe['format']['duration']), 1.0, delta=0.041)
            audios = [stream for stream in probe['streams'] if stream['codec_type'] == 'audio']
            self.assertEqual(len(audios), 2)
            self.assertEqual([a['tags'].get('language') for a in audios], ['eng', 'jpn'])
            self.assertEqual([a['disposition']['default'] for a in audios], [0, 1])
            pcm = self.run_tool([self.ffmpeg, '-v', 'error', '-i', str(output), '-map', '0:a:0', '-ac', '1', '-ar', '48000',
                '-f', 'f32le', '-']).stdout
            samples = struct.unpack('<' + 'f' * (len(pcm) // 4), pcm)
            # The first kept interval starts 100ms before this audio stream.
            # Resetting to STARTPTS would erase that genuine A/V offset.
            self.assertLess(max(abs(v) for v in samples[:2400]), 0.002)
            self.assertGreater(max(abs(v) for v in samples[7200:12000]), 0.03)
            # An entire kept interval can precede a delayed audio stream.
            # It must remain silence, not disappear and pull later sound early.
            early_output = root / 'early' / 'out.mp4'
            with mock.patch.object(server_editor, 'video_encoder_attempts', return_value=('cpu',)):
                server_editor.burn_ass_video(source, [(0, 100), (300, 800)], ASS_TEXT.replace('你好', 'OK'), early_output,
                    ffmpeg_path=Path(self.ffmpeg), ffprobe_path=Path(self.ffprobe))
            raw = self.run_tool([self.ffmpeg, '-v', 'error', '-i', str(early_output), '-map', '0:a:0', '-ac', '1',
                '-ar', '48000', '-f', 'f32le', '-']).stdout
            early_samples = struct.unpack('<' + 'f' * (len(raw) // 4), raw)
            self.assertLess(max(abs(v) for v in early_samples[:4000]), 0.002)
            self.assertGreater(max(abs(v) for v in early_samples[9600:14400]), 0.03)

    def test_ass_events_use_the_shortened_output_clock(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / 'green.mp4'
            self.run_tool([self.ffmpeg, '-y', '-v', 'error', '-f', 'lavfi', '-i',
                'color=green:s=160x90:r=25:d=3', '-c:v', 'libx264', '-g', '250', '-sc_threshold', '0', str(source)])
            ass = ('[Script Info]\nScriptType: v4.00+\nPlayResX: 160\nPlayResY: 90\n'
                   '[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n'
                   'Style: Default,Arial,32,&H000000FF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,8,1,1,1,1\n'
                   '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'
                   'Dialogue: 0,0:00:00.60,0:00:00.90,Default,,0,0,0,,MMMM\n')
            output = root / 'out' / 'caption.mp4'
            with mock.patch.object(server_editor, 'video_encoder_attempts', return_value=('cpu',)):
                server_editor.burn_ass_video(source, [(1000, 1500), (2000, 2500)], ass, output,
                    ffmpeg_path=Path(self.ffmpeg), ffprobe_path=Path(self.ffprobe))
            def red_pixels(at):
                raw = self.run_tool([self.ffmpeg, '-v', 'error', '-ss', str(at), '-i', str(output),
                    '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']).stdout
                return sum(raw[i] > 120 and raw[i] > raw[i + 1] * 1.5 and raw[i] > raw[i + 2] * 1.5
                    for i in range(0, len(raw), 3))
            self.assertEqual(red_pixels(0.2), 0)
            self.assertGreater(red_pixels(0.7), 20)

    def test_video_only_precise_cuts_do_not_require_audio(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / 'silent.mp4'
            self.run_tool([self.ffmpeg, '-y', '-v', 'error', '-f', 'lavfi', '-i',
                'color=green:s=160x90:r=25:d=3', '-c:v', 'libx264', '-g', '250', '-sc_threshold', '0', str(source)])
            output = root / 'output' / 'out.mp4'
            with mock.patch.object(server_editor, 'video_encoder_attempts', return_value=('cpu',)):
                server_editor.burn_ass_video(source, [(1250, 1750), (2250, 2750)], ASS_TEXT.replace('你好', 'OK'), output,
                    ffmpeg_path=Path(self.ffmpeg), ffprobe_path=Path(self.ffprobe))
            probe = json.loads(self.run_tool([self.ffprobe, '-v', 'error', '-show_entries',
                'stream=codec_type:format=duration', '-of', 'json', str(output)]).stdout)
            self.assertAlmostEqual(float(probe['format']['duration']), 1.0, delta=0.041)
            self.assertEqual([stream['codec_type'] for stream in probe['streams']], ['video'])


class BurnVideoDiagnosticTests(unittest.TestCase):
    def test_early_split_glyph_warning_survives_later_stderr_and_blocks_output(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / 'source.mp4'
            source.write_bytes(b'source')
            warning = ('[Parsed_ass_0] fontselect: failed to find any fallback '
                       'with glyph 0x4E2D for font: (MissingFont, 400, 0)\n')
            script = root / 'encoder.py'
            script.write_text('import sys\nfrom pathlib import Path\n'
                + 'Path(sys.argv[1]).write_bytes(b"invalid-video")\n'
                + 'sys.stderr.write(' + repr('x' * 4070 + warning) + ')\n'
                + "sys.stderr.write(('later warning ' * 16 + '\\n') * 1200)\n", encoding='utf-8')
            manager = server_editor.MediaJobManager(temp_root=root)
            def burn(job):
                original = job.run_command
                def run(command, **kwargs):
                    return original([sys.executable, str(script), command[-1]], **kwargs)
                job.run_command = run
                server_editor.burn_ass_video(source, [], ASS_TEXT, job.output,
                    ffmpeg_path=Path('ffmpeg'), ffprobe_path=Path('ffprobe'), job=job)
            try:
                with mock.patch.object(server_editor, 'video_encoder_attempts', return_value=('cpu',)), \
                     mock.patch.object(server_editor, '_probe_media_duration_ms', return_value=1000):
                    job = manager.start(source, (1, 'bound'), [], burn, output_extension='.mp4')
                    job.thread.join(10)
                self.assertFalse(job.thread.is_alive())
                self.assertEqual(job.state, 'failed', job.error)
                self.assertIn('缺少字形', job.error)
                self.assertTrue(job.disposed_event.wait(2))
                self.assertFalse(job.output.exists())
            finally:
                manager.close()
