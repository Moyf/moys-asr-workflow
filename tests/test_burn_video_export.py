"""Editor ASS burn-in video export: command construction, HTTP job lifecycle."""
from __future__ import annotations

from tests.compact_assertions import CompactContainerAssertions

import importlib.util
import json
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
        self.assertEqual(command[command.index("-crf") + 1], "18")
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

    def test_interval_burn_uses_ffconcat_input(self) -> None:
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
        self.assertEqual(command[command.index("-f") + 1], "concat")
        self.assertEqual(command[command.index("-safe") + 1], "0")
        concat_path = Path(command[command.index("-i") + 1])
        concat_text = concat_path.read_text(encoding="utf-8")
        self.assertIn("inpoint 1.400\noutpoint 2.650", concat_text)
        self.assertIn("inpoint 3.400\noutpoint 4.900", concat_text)

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
