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
from dataclasses import replace
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

    def test_fixed_gain_full_green_and_interval_audio_is_applied_once(self):
        def run(command, **kwargs):
            self.calls.append(command)
            Path(command[-1]).write_bytes(b'burned')
            return subprocess.CompletedProcess(command, 0, '', '')
        for green, include in ((False, False), (True, True), (True, False)):
            with self.subTest(green=green, include=include), \
                 mock.patch.object(server_editor, '_probe_media_duration_ms', return_value=2000), \
                 mock.patch.object(server_editor, '_green_screen_input',
                    return_value=(['-f', 'lavfi', '-i', 'color=c=green:s=32x32:d=2'], None)), \
                 mock.patch.object(server_editor.subprocess, 'run', side_effect=run):
                server_editor.burn_ass_video(self.source, [], ASS_TEXT, self.output,
                    ffmpeg_path=Path('ffmpeg'), ffprobe_path=Path('ffprobe'),
                    green_screen=green, include_audio=include, audio_gain_db=6)
                command = self.calls[-1]
                self.assertEqual(command.count('-af'), int(not green or include))
                if not green or include:
                    self.assertEqual(command[command.index('-af') + 1], 'volume=6.000000dB')
                self.assertNotIn('loudnorm', ' '.join(command))
        graph = server_editor._burn_interval_filter([(0, 1000), (2000, 3000)], 2, audio_gain_db=-6)
        self.assertEqual(graph.count('volume=-6.000000dB'), 2)
        self.assertIn('concat=n=2:v=0:a=1,volume=-6.000000dB[burn_audio_1]', graph)

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

    def test_editor_burn_normalizes_ass_and_converted_srt_without_client_aliases(self) -> None:
        from maw import ass_fonts
        from maw import postprocess_ffmpeg

        # SRT 转换产物会按「样式库 srtBurnStyleId 指向的样式」重写 Default
        # 样式；样式库读取用户级真实配置，空缺时又回退到按操作系统选择的
        # 默认字体，断言会随机器漂移。这里把样式库隔离为仅含雅黑字体的
        # default 样式，让「别名表改写字体名」的断言在所有平台走同一路径。
        ass = ASS_TEXT.replace("[Events]", "[V4+ Styles]\nStyle: Default,Microsoft YaHei,86\n[Events]")
        ass = ass.replace("你好", r"{\i1}你好{\i0}")
        entries = ({"canonical": "Example Local", "names": ["Microsoft YaHei"]},)

        def run(command, **kwargs):
            if command[0] == "ffprobe":
                return subprocess.CompletedProcess(command, 0, json.dumps({
                    "streams": [{"codec_type": "video", "width": 1920, "height": 1080}],
                    "format": {"duration": "4.5"},
                }), "")
            if "-c:s" in command:
                Path(command[-1]).write_text(ass, encoding="utf-8")
            else:
                text = self.output.with_name("burn.ass").read_text(encoding="utf-8")
                self.assertIn("Style: Default,Example Local,", text)
                self.assertNotIn("Microsoft YaHei", text)
                self.assertIn(r"{\i1}你好{\i0}", text)
                self.assertEqual(command.count("-af"), 1)
                self.assertEqual(command[command.index("-af") + 1], "volume=6.000000dB")
                Path(command[-1]).write_bytes(b"burned")
            return subprocess.CompletedProcess(command, 0, "", "")

        for subtitle_format in ("ass", "srt"):
            with self.subTest(subtitle_format=subtitle_format), \
                    mock.patch.object(ass_fonts, "font_alias_entries", return_value=entries), \
                    mock.patch.object(postprocess_ffmpeg, "load_ass_style_library",
                                      return_value={"styles": [{"id": "default", "fontName": "Microsoft YaHei"}],
                                                    "assignments": {"srtBurnStyleId": "default"}}), \
                    mock.patch.object(server_editor.subprocess, "run", side_effect=run):
                server_editor.burn_ass_video(self.source, [],
                    ass if subtitle_format == "ass" else "1\n00:00:00,000 --> 00:00:01,000\n你好\n",
                    self.output, ffmpeg_path=Path("ffmpeg"), ffprobe_path=Path("ffprobe"),
                    subtitle_format=subtitle_format, audio_gain_db=6)

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


    def test_srt_conversion_uses_library_slot_and_source_resolution(self):
        from maw.ass_styles import default_ass_style_library
        library = default_ass_style_library()
        library['styles'].append({**library['styles'][0], 'id': 'chosen-srt', 'fontSize': 80})
        library['assignments']['srtBurnStyleId'] = 'chosen-srt'
        calls = []

        def run(command, **kwargs):
            calls.append((command, kwargs))
            if command[0] == 'ffprobe':
                return subprocess.CompletedProcess(command, 0, json.dumps({
                    'streams': [{'codec_type': 'video', 'width': 1280, 'height': 720}],
                    'format': {'duration': '4.5'},
                }), '')
            if '-c:s' in command:
                Path(command[-1]).write_text('[Script Info]\nPlayResX: 384\nPlayResY: 288\n'
                    '[V4+ Styles]\nStyle: Default,Arial,12\n', encoding='utf-8')
            else:
                Path(command[-1]).write_bytes(b'burned')
            return subprocess.CompletedProcess(command, 0, '', '')

        with mock.patch.object(server_editor.subprocess, 'run', side_effect=run), \
             mock.patch('maw.postprocess_ffmpeg.load_ass_style_library', return_value=library):
            server_editor.burn_ass_video(self.source, [], '1\n00:00:00,000 --> 00:00:01,000\nHELLO\n',
                self.output, ffmpeg_path=Path('ffmpeg'), ffprobe_path=Path('ffprobe'), subtitle_format='srt')
        text = self.output.with_name('burn.ass').read_text(encoding='utf-8')
        self.assertIn('PlayResX: 1280', text)
        self.assertIn('PlayResY: 720', text)
        style = next(line for line in text.splitlines() if line.startswith('Style: Default,'))
        self.assertEqual(style.split(',')[2], '53')
        conversion = next((command, kwargs) for command, kwargs in calls if '-c:s' in command)
        self.assertEqual(conversion[1]['cwd'], self.output.parent)
        self.assertFalse(list(self.output.parent.glob('.*.maw-burn-*.ass')))
        self.assertEqual(self.source.read_bytes(), b'source')

    def test_srt_conversion_failure_never_encodes_video(self):
        calls = []

        def run(command, **kwargs):
            calls.append(command)
            if command[0] == 'ffprobe':
                return subprocess.CompletedProcess(command, 0, json.dumps({
                    'streams': [{'codec_type': 'video', 'width': 640, 'height': 360}], 'format': {},
                }), '')
            Path(command[-1]).write_text('incomplete', encoding='utf-8')
            return subprocess.CompletedProcess(command, 1, '', 'invalid subtitle')

        with mock.patch.object(server_editor.subprocess, 'run', side_effect=run):
            with self.assertRaises(server_editor.BurnVideoExportError):
                server_editor.burn_ass_video(self.source, [], 'bad SRT', self.output,
                    ffmpeg_path=Path('ffmpeg'), ffprobe_path=Path('ffprobe'), subtitle_format='srt')
        self.assertFalse(self.output.exists())
        self.assertFalse(any('-c:v' in command for command in calls))
        self.assertFalse(list(self.output.parent.glob('.*.maw-burn-*.ass')))


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

    def test_http_gain_validation_and_job_snapshot(self):
        for gain in (True, '6', None, -61, 25, float('nan'), float('inf'), 10**400):
            with self.subTest(gain=gain):
                status, _ = self.request(self.base, self.payload(audioGainDb=gain))
                self.assertEqual(status, 400)
        captured = {}
        def burn(source, intervals, ass, output, **kwargs):
            captured.update(kwargs)
            output.write_bytes(b'burned')
        with mock.patch.object(self.server_editor, 'editor_ffmpeg_tools', return_value=self.tools()), \
             mock.patch.object(self.server_editor.EditorServer, 'ensure_libass_supported', return_value=True), \
             mock.patch.object(self.server_editor, 'burn_ass_video', side_effect=burn):
            status, started = self.request(self.base, self.payload(audioGainDb=6))
            self.assertEqual(status, 202)
            self.wait(started['jobId'], 'ready')
            self.assertEqual(captured['audio_gain_db'], 6)

    def test_http_loudness_pins_preview_media_and_rejects_stale_binding(self):
        preview = self.root / 'converted.mp4'
        preview.write_bytes(b'playback cache')
        self.server.project = replace(self.server.project, media_path=preview)
        result = {'ok': True, 'status': 'measuring'}
        with mock.patch.object(self.server_editor, 'editor_ffmpeg_tools', return_value=self.tools()), \
             mock.patch.object(self.server.loudness_analyzer, 'request', return_value=result) as analyze:
            status, _ = self.request('/api/audio/loudness', self.payload())
            self.assertEqual(status, 202)
            self.assertEqual(analyze.call_args.args[0], preview)
            self.assertNotEqual(analyze.call_args.args[0], self.source)
            status, _ = self.request('/api/audio/loudness', self.payload(bindingGeneration=0))
            self.assertEqual(status, 409)
            status, _ = self.request('/api/audio/loudness', self.payload(requestToken='bad'))
            self.assertEqual(status, 403)
            status, _ = self.request('/api/audio/loudness', self.payload(force='yes'))
            self.assertEqual(status, 400)
            self.assertEqual(analyze.call_count, 1)

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

    def test_http_srt_uses_the_same_bound_job_and_rejects_ambiguous_input(self):
        captured = {}

        def burn(source, intervals, text, output, **kwargs):
            captured.update(source=source, intervals=intervals, text=text, subtitle_format=kwargs['subtitle_format'])
            output.write_bytes(b'srt-burned')

        request = self.payload()
        request.pop('ass')
        request['srt'] = '1\n00:00:00,000 --> 00:00:01,000\nHELLO\n'
        request['intervals'] = [{'startMs': 0, 'endMs': 1000}]
        with mock.patch.object(self.server_editor, 'editor_ffmpeg_tools', return_value=self.tools()), \
             mock.patch.object(self.server_editor.EditorServer, 'ensure_libass_supported', return_value=True), \
             mock.patch.object(self.server_editor, 'burn_ass_video', side_effect=burn):
            self.assertEqual(self.request(self.base, {**request, 'ass': ASS_TEXT})[0], 400)
            self.assertEqual(self.request(self.base, {**request, 'srt': ''})[0], 400)
            self.assertEqual(self.request(self.base, {**request, 'sourceMediaId': 'stale'})[0], 409)
            self.assertEqual(self.request(self.base, {**request, 'requestToken': 'invalid'}, token=False)[0], 403)
            status, job = self.request(self.base, request)
            self.assertEqual(status, 202)
            self.wait(job['jobId'], 'ready')
            self.assertEqual(captured, {'source': self.source, 'intervals': [(0, 1000)],
                                       'text': request['srt'], 'subtitle_format': 'srt'})
            self.assertEqual(self.request(self.base + '/' + job['jobId'] + '/download'), (200, b'srt-burned'))

    def test_http_srt_forwards_stickers_with_and_without_removed_intervals(self):
        sticker_root = self.root / "stickers"
        sticker_root.mkdir()
        sticker = sticker_root / "a.png"
        sticker.write_bytes(b"png")
        self.server.project = self.server_editor.replace(self.server.project, sticker_root=sticker_root)
        captured = {}

        def burn(source, intervals, text, output, **kwargs):
            captured.update(source=source, intervals=intervals, text=text, **kwargs)
            output.write_bytes(b"srt-sticker-burned")

        with mock.patch.object(self.server_editor, "editor_ffmpeg_tools", return_value=self.tools()), \
             mock.patch.object(self.server_editor.EditorServer, "ensure_libass_supported", return_value=True), \
             mock.patch.object(self.server_editor, "burn_ass_video", side_effect=burn):
            for intervals in ([], [{"startMs": 0, "endMs": 1000}, {"startMs": 2000, "endMs": 5000}]):
                with self.subTest(intervals=intervals):
                    request = self.payload()
                    request.pop("ass")
                    start, end = (2000, 3000) if intervals else (3000, 4000)
                    request.update(srt=f"1\n00:00:0{start // 1000},000 --> 00:00:0{end // 1000},000\nHELLO\n",
                        stickers={"mode": "cue-left", "placements": [{"rel": "a.png",
                            "x": 10, "y": 20, "width": 30, "height": 40, "align": "center",
                            "intervals": [{"start": start, "end": end}]}]})
                    if intervals:
                        request["intervals"] = intervals
                    status, job = self.request(self.base, request)
                    self.assertEqual(status, 202)
                    self.wait(job["jobId"], "ready")
                    self.assertEqual(captured["source"], self.source)
                    self.assertEqual(captured["subtitle_format"], "srt")
                    self.assertEqual(captured["text"], request["srt"])
                    self.assertEqual(captured["intervals"], [(part["startMs"], part["endMs"]) for part in intervals])
                    self.assertEqual(len(captured["stickers"]), 1)
                    self.assertEqual(captured["stickers"][0]["path"], sticker)
                    self.assertEqual(captured["stickers"][0]["intervals"], [(start, end)])
                    self.assertEqual(self.request(self.base + "/" + job["jobId"] + "/download"),
                        (200, b"srt-sticker-burned"))

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

    def test_cancelling_srt_conversion_stops_its_child_and_cleans_the_job(self):
        probe = mock.Mock(streams=[mock.Mock(codec_signature=('video', None, None, None, 320, 180), disposition=())])

        def converting(subtitle, *, run_command, **kwargs):
            run_command([sys.executable, '-c', 'import time; time.sleep(30)'], cwd=subtitle.parent)
            self.fail('Cancelled conversion must never complete')

        request = self.payload()
        request.pop('ass')
        request['srt'] = '1\n00:00:00,000 --> 00:00:01,000\nHELLO\n'
        with mock.patch.object(self.server_editor, 'editor_ffmpeg_tools', return_value=self.tools()), \
             mock.patch.object(self.server_editor.EditorServer, 'ensure_libass_supported', return_value=True), \
             mock.patch.object(self.server_editor, '_probe_gap_removed_video', return_value=probe), \
             mock.patch.object(self.server_editor, 'convert_srt_to_ass', side_effect=converting):
            status, snapshot = self.request(self.base, request)
            self.assertEqual(status, 202)
            job = self.server.media_jobs.jobs[snapshot['jobId']]
            deadline = time.monotonic() + 5
            while job.process is None and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertIsNotNone(job.process)
            process = job.process
            self.assertEqual(self.request(self.base + '/' + job.id + '/cancel', {
                'requestToken': self.server.request_token,
            })[0], 200)
            cancelled = self.wait(job.id, 'cancelled')
            self.assertTrue(cancelled['cleanupComplete'])
            self.assertIsNotNone(process.poll())
            self.assertFalse(job.output.exists())
            self.assertEqual(self.source.read_bytes(), b'unchanged source')


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

    def test_real_gain_matches_full_gap_and_green_screen_audio(self):
        import array
        import math
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            source = root / 'two-tracks.mkv'
            self.run_tool([self.ffmpeg, '-v', 'error', '-y', '-f', 'lavfi', '-i',
                'color=c=black:s=64x36:r=10:d=3', '-f', 'lavfi', '-i',
                'sine=frequency=1000:sample_rate=48000:duration=3', '-f', 'lavfi', '-i',
                'sine=frequency=500:sample_rate=48000:duration=3',
                '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-c:a', 'pcm_s16le', str(source)])
            original_bytes = source.read_bytes()
            def rms(path, track):
                data = self.run_tool([self.ffmpeg, '-v', 'error', '-ss', '0.4', '-i', str(path),
                    '-t', '0.4', '-map', f'0:a:{track}', '-ac', '1', '-f', 'f32le', '-']).stdout
                samples = array.array('f')
                samples.frombytes(data)
                self.assertTrue(samples)
                return math.sqrt(sum(value * value for value in samples) / len(samples))
            originals = [rms(source, index) for index in range(2)]
            for kind in ('full', 'gap', 'green'):
                with self.subTest(kind=kind):
                    output = root / f'{kind}.mp4'
                    options = {'green_screen': True, 'include_audio': True, 'audio_track': 1} if kind == 'green' else {}
                    with mock.patch.object(server_editor, 'video_encoder_attempts', return_value=('cpu',)):
                        server_editor.burn_ass_video(source, [(0, 1000), (2000, 3000)] if kind == 'gap' else [],
                            ASS_TEXT.replace('你好', 'GAIN'), output,
                            ffmpeg_path=Path(self.ffmpeg), ffprobe_path=Path(self.ffprobe), audio_gain_db=6, **options)
                    tracks = (1,) if kind == 'green' else (0, 1)
                    for output_track, original_track in enumerate(tracks):
                        gain = 20 * math.log10(rms(output, output_track) / originals[original_track])
                        self.assertAlmostEqual(gain, 6, delta=.3)
            self.assertEqual(source.read_bytes(), original_bytes)

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

    def test_sticker_overlay_burns_in_window_and_keeps_full_duration(self):
        """真实编码回归：表情包输入无限化 + shortest=1 不截断输出，overlay 只在
        enable 窗口内出现且位置正确（CI 回归 TASK.md「实测踩坑」的 FFmpeg 行为：
        短输入截断 / shortest 挂起 / 坐标错位在这些断言下都会复发）。"""
        import zlib
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / 'colors.mp4'
            command = [self.ffmpeg, '-y', '-hide_banner', '-loglevel', 'error']
            for color in ('red', 'green', 'blue'):
                command += ['-f', 'lavfi', '-i', f'color={color}:s=160x90:r=25:d=1']
            self.run_tool(command + ['-filter_complex',
                '[0:v][1:v][2:v]concat=n=3:v=1:a=0[out]', '-map', '[out]', str(source)])
            # 最小不透明白色 PNG（40x30）：zlib 存储，无滤波。
            sticker = root / 'dot.png'
            raw = b''.join(b'\x00' + b'\xff\xff\xff' * 40 for _ in range(30))

            def chunk(tag, payload):
                return (struct.pack('>I', len(payload)) + tag + payload
                        + struct.pack('>I', zlib.crc32(tag + payload)))
            sticker.write_bytes(b'\x89PNG\r\n\x1a\n'
                + chunk(b'IHDR', struct.pack('>IIBBBBB', 40, 30, 8, 2, 0, 0, 0))
                + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))
            output = root / 'stickered.mp4'
            server_editor.burn_ass_video(source, [], ASS_TEXT.replace('你好', 'OK'), output,
                ffmpeg_path=Path(self.ffmpeg), ffprobe_path=Path(self.ffprobe),
                stickers=[{'rel': 'dot.png', 'path': sticker, 'x': 10, 'y': 10,
                           'width': 40, 'height': 30, 'intervals': [(400, 1200)]}])
            probe = json.loads(self.run_tool([self.ffprobe, '-v', 'error', '-show_streams',
                '-show_format', '-of', 'json', str(output)]).stdout)
            # 无限化输入 + shortest=1：输出时长必须等于源时长（短输入截断 / 永不
            # 退出两类历史症状在这里都会复发）。
            self.assertLess(abs(float(probe['format']['duration']) - 3.0), .15)

            def sample(frame_bytes, x0, y0, x1, y1):
                total = [0, 0, 0]
                count = 0
                for y in range(y0, y1):
                    for x in range(x0, x1):
                        offset = (y * 160 + x) * 3
                        for channel in range(3):
                            total[channel] += frame_bytes[offset + channel]
                        count += 1
                return tuple(value // count for value in total)
            for stamp, expect_sticker in ((0.8, True), (2.5, False)):
                frame = root / f'sticker-{stamp}.raw'
                self.run_tool([self.ffmpeg, '-y', '-v', 'error', '-ss', str(stamp),
                    '-i', str(output), '-frames:v', '1', '-pix_fmt', 'rgb24',
                    '-f', 'rawvideo', str(frame)])
                color = sample(frame.read_bytes(), 15, 15, 45, 35)
                is_light = color[0] > 180 and color[1] > 180 and color[2] > 180
                self.assertEqual(is_light, expect_sticker,
                    f't={stamp}: sticker box {color}, expected sticker={expect_sticker}')

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


    def test_srt_burn_renders_library_style_with_real_ffmpeg(self):
        from maw.ass_styles import default_ass_style_library
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / 'source.mp4'
            self.run_tool([self.ffmpeg, '-y', '-v', 'error', '-f', 'lavfi', '-i',
                           'color=black:s=320x180:r=25:d=1', '-c:v', 'libx264', str(source)])
            library = default_ass_style_library()
            library['styles'].append({**library['styles'][0], 'id': 'srt-render', 'fontSize': 90,
                                      'fontFamily': 'Arial', 'marginV': 12})
            library['assignments']['srtBurnStyleId'] = 'srt-render'
            output = root / 'export' / 'subtitled.mp4'
            with mock.patch.object(server_editor, 'video_encoder_attempts', return_value=('cpu',)), \
                 mock.patch('maw.postprocess_ffmpeg.load_ass_style_library', return_value=library):
                server_editor.burn_ass_video(source, [], '1\n00:00:00,100 --> 00:00:00,800\nHELLO\n', output,
                    ffmpeg_path=Path(self.ffmpeg), ffprobe_path=Path(self.ffprobe), subtitle_format='srt')
            ass = output.with_name('burn.ass').read_text(encoding='utf-8')
            self.assertIn('PlayResX: 320', ass)
            self.assertIn('PlayResY: 180', ass)
            style = next(line for line in ass.splitlines() if line.startswith('Style: Default,'))
            self.assertEqual(style.split(',')[2], '15')
            frame = self.run_tool([self.ffmpeg, '-v', 'error', '-ss', '0.4', '-i', str(output),
                '-frames:v', '1', '-pix_fmt', 'gray', '-f', 'rawvideo', '-']).stdout
            self.assertGreater(sum(value > 100 for value in frame), 30)
            gap_output = root / 'gap-export' / 'subtitled.mp4'
            with mock.patch.object(server_editor, 'video_encoder_attempts', return_value=('cpu',)), \
                 mock.patch('maw.postprocess_ffmpeg.load_ass_style_library', return_value=library):
                server_editor.burn_ass_video(source, [(200, 800)], '1\n00:00:00,200 --> 00:00:00,500\nHELLO\n', gap_output,
                    ffmpeg_path=Path(self.ffmpeg), ffprobe_path=Path(self.ffprobe), subtitle_format='srt')
            early = self.run_tool([self.ffmpeg, '-v', 'error', '-ss', '0.08', '-i', str(gap_output),
                '-frames:v', '1', '-pix_fmt', 'gray', '-f', 'rawvideo', '-']).stdout
            visible = self.run_tool([self.ffmpeg, '-v', 'error', '-ss', '0.3', '-i', str(gap_output),
                '-frames:v', '1', '-pix_fmt', 'gray', '-f', 'rawvideo', '-']).stdout
            self.assertEqual(sum(value > 100 for value in early), 0)
            self.assertGreater(sum(value > 100 for value in visible), 30)


    def test_srt_with_sticker_preserves_caption_clock_window_and_duration(self):
        import zlib
        from maw.ass_styles import default_ass_style_library

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "source.mp4"
            self.run_tool([self.ffmpeg, "-y", "-v", "error", "-f", "lavfi", "-i",
                "color=black:s=320x180:r=25:d=1", "-c:v", "libx264", str(source)])
            sticker = root / "dot.png"
            raw = b"".join(b"\x00" + b"\xff\xff\xff" * 40 for _ in range(30))

            def chunk(tag, payload):
                return (struct.pack(">I", len(payload)) + tag + payload
                    + struct.pack(">I", zlib.crc32(tag + payload)))

            sticker.write_bytes(b"\x89PNG\r\n\x1a\n"
                + chunk(b"IHDR", struct.pack(">IIBBBBB", 40, 30, 8, 2, 0, 0, 0))
                + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
            library = default_ass_style_library()
            library["styles"].append({**library["styles"][0], "id": "srt-sticker-render",
                "fontSize": 90, "fontFamily": "Arial", "marginV": 12})
            library["assignments"]["srtBurnStyleId"] = "srt-sticker-render"

            for intervals, duration in (([], 1.0), ([(200, 800)], 0.6)):
                with self.subTest(intervals=intervals):
                    output = root / ("gap" if intervals else "full") / "subtitled.mp4"
                    with mock.patch.object(server_editor, "video_encoder_attempts", return_value=("cpu",)), \
                         mock.patch("maw.postprocess_ffmpeg.load_ass_style_library", return_value=library):
                        server_editor.burn_ass_video(source, intervals,
                            "1\n00:00:00,200 --> 00:00:00,500\nHELLO\n", output,
                            ffmpeg_path=Path(self.ffmpeg), ffprobe_path=Path(self.ffprobe), subtitle_format="srt",
                            stickers=[{"rel": "dot.png", "path": sticker, "x": 10, "y": 10,
                                "width": 40, "height": 30, "intervals": [(300, 400)]}])
                    probe = json.loads(self.run_tool([self.ffprobe, "-v", "error", "-show_format",
                        "-of", "json", str(output)]).stdout)
                    self.assertAlmostEqual(float(probe["format"]["duration"]), duration, delta=0.041)
                    for stamp, caption_visible, sticker_visible in (
                            (0.08, False, False), (0.24, True, False),
                            (0.36, True, True), (0.52, False, False)):
                        frame = self.run_tool([self.ffmpeg, "-v", "error", "-ss", str(stamp),
                            "-i", str(output), "-frames:v", "1", "-pix_fmt", "gray", "-f", "rawvideo", "-"]).stdout
                        self.assertEqual(len(frame), 320 * 180, f"missing frame at {stamp}")
                        caption_pixels = sum(value > 100 for value in frame[120 * 320:])
                        if caption_visible:
                            self.assertGreater(caption_pixels, 30, f"caption missing at {stamp}")
                        else:
                            self.assertEqual(caption_pixels, 0, f"caption appeared outside its window at {stamp}")
                        patch = [frame[y * 320 + x] for y in range(15, 35) for x in range(15, 45)]
                        self.assertEqual(sum(patch) / len(patch) > 180, sticker_visible,
                            f"sticker appeared outside its window at {stamp}")


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


class BurnStickerTests(CompactContainerAssertions, unittest.TestCase):
    """Sticker overlay burn: request parsing, filter graph, and command wiring."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name).resolve()
        self.source = self.root / "clip.mp4"
        self.source.write_bytes(b"source")
        self.output = self.root / "private" / "restructured.mp4"
        self.stickers_dir = self.root / "stickers"
        self.stickers_dir.mkdir()
        self.sticker_a = self.stickers_dir / "a.png"
        self.sticker_a.write_bytes(b"png")
        self.sticker_gif = self.stickers_dir / "b.gif"
        self.sticker_gif.write_bytes(b"gif")
        self.calls: list[list[str]] = []
        attempts_patcher = mock.patch.object(server_editor, "video_encoder_attempts", return_value=("cpu",))
        attempts_patcher.start()
        self.addCleanup(attempts_patcher.stop)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def _entry(self, rel: str = "a.png", intervals=None, **overrides) -> dict:
        entry = {"rel": rel, "x": 200, "y": 30, "width": 100, "height": 75,
                 "intervals": [{"start": 1000, "end": 2500}, {"start": 3000, "end": 4500}]
                 if intervals is None else intervals}
        entry.update(overrides)
        return entry

    def _run_full_video(self, stickers):
        def run(command, **kwargs):
            self.calls.append(command)
            if command[0] == "ffprobe":
                return subprocess.CompletedProcess(command, 0,
                    stdout=json.dumps({"format": {"duration": "6.0"}}), stderr="")
            Path(command[-1]).write_bytes(b"burned")
            return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

        with mock.patch.object(server_editor.subprocess, "run", side_effect=run):
            return server_editor.burn_ass_video(
                self.source, [], ASS_TEXT, self.output,
                ffmpeg_path=Path("ffmpeg"), ffprobe_path=Path("ffprobe"), stickers=stickers)

    def test_parse_keeps_one_entry_per_placement_and_merges_inputs(self) -> None:
        stickers = server_editor._parse_burn_sticker_inputs(
            [self._entry(), self._entry(intervals=[{"start": 5000, "end": 6000}])], self.stickers_dir)
        # 方案二载荷：同一 rel 保留多个 placement（逐句贴放），FFmpeg 输入按图片去重。
        self.assertEqual(len(stickers), 2)
        self.assertEqual(stickers[0]["path"], self.sticker_a)
        self.assertEqual(stickers[0]["intervals"], [(1000, 2500), (3000, 4500)])
        self.assertEqual(stickers[1]["intervals"], [(5000, 6000)])
        self.assertEqual(server_editor._burn_sticker_input_args(stickers),
                         ["-loop", "1", "-i", str(self.sticker_a)])

    def test_parse_accepts_object_payload_with_mode(self) -> None:
        stickers = server_editor._parse_burn_sticker_inputs(
            {"mode": "cue-left", "placements": [self._entry()]}, self.stickers_dir)
        self.assertEqual(len(stickers), 1)
        with self.assertRaises(ValueError) as caught:
            server_editor._parse_burn_sticker_inputs(
                {"mode": "diagonal", "placements": [self._entry()]}, self.stickers_dir)
        self.assertIn("烧录模式无效", str(caught.exception))

    def test_parse_rejects_too_many_placements(self) -> None:
        payload = [self._entry() for _ in range(server_editor.MAX_BURN_STICKER_PLACEMENTS + 1)]
        with self.assertRaises(ValueError) as caught:
            server_editor._parse_burn_sticker_inputs(payload, self.stickers_dir)
        self.assertIn("条目超过上限", str(caught.exception))

    def test_parse_keeps_infinite_inputs_per_format(self) -> None:
        args = server_editor._burn_sticker_input_args([
            {"path": self.sticker_a}, {"path": self.sticker_gif},
            {"path": self.stickers_dir / "still.webp"}])
        self.assertEqual(args, [
            "-loop", "1", "-i", str(self.sticker_a),
            "-stream_loop", "-1", "-ignore_loop", "0", "-i", str(self.sticker_gif),
            "-stream_loop", "-1", "-i", str(self.stickers_dir / "still.webp")])

    def test_parse_rejects_animated_webp_but_accepts_static(self) -> None:
        riff_header = b"RIFF" + (4).to_bytes(4, "little") + b"WEBP"
        # VP8X chunk data: flags 字节在 data[0]（bit 1 = Animation）。
        animated = self.stickers_dir / "animated.webp"
        animated.write_bytes(riff_header + b"VP8X" + (10).to_bytes(4, "little")
                             + b"\x02" + b"\x00" * 3 + (119).to_bytes(3, "little") + (89).to_bytes(3, "little")
                             + b"ANMF" + (0).to_bytes(4, "little"))
        still = self.stickers_dir / "still.webp"
        still.write_bytes(riff_header + b"VP8 " + (86).to_bytes(4, "little") + b"\x00" * 86)
        # 静态文件的压缩数据/元数据里恰好出现 ANMF 字节也不能误判（按 chunk 结构
        # 只读 VP8X 标志，不全文搜索）。
        static_with_anmf = self.stickers_dir / "still_with_anmf.webp"
        static_with_anmf.write_bytes(riff_header + b"VP8 " + (90).to_bytes(4, "little")
                                     + b"\x00" * 86 + b"ANMF" + (0).to_bytes(4, "little"))
        with self.assertRaises(ValueError) as caught:
            server_editor._parse_burn_sticker_inputs([self._entry(rel="animated.webp")], self.stickers_dir)
        self.assertIn("动画 WebP", str(caught.exception))
        stickers = server_editor._parse_burn_sticker_inputs([self._entry(rel="still.webp")], self.stickers_dir)
        self.assertEqual(stickers[0]["path"], still)
        stickers = server_editor._parse_burn_sticker_inputs([self._entry(rel="still_with_anmf.webp")],
            self.stickers_dir)
        self.assertEqual(stickers[0]["path"], static_with_anmf)

    def test_parse_rejects_invalid_entries(self) -> None:
        root = self.stickers_dir
        cases = [
            ("bad scalar", "表情包烧录参数无效"),
            ([None], "表情包烧录参数无效"),
            ({"mode": "diagonal", "placements": [self._entry()]}, "烧录模式无效"),
            ([{"rel": "a.png"}], "几何参数无效"),
            ([self._entry(rel="")], "缺少相对路径"),
            ([self._entry(rel="../a.png")], "表情包相对路径不安全"),
            ([self._entry(rel="missing.png")], "表情包源文件不存在"),
            ([self._entry(x=-1)], "几何参数无效"),
            ([self._entry(width=0)], "几何尺寸无效"),
            ([self._entry(intervals="bad")], "显示区间为空"),
            ([self._entry(intervals=[None])], "显示区间无效"),
            ([self._entry(intervals=[{"start": 100, "end": 50}])], "显示区间无效"),
            ([self._entry(intervals=[{"start": -1, "end": 50}])], "显示区间无效"),
        ]
        for payload, message in cases:
            with self.subTest(payload=payload):
                with self.assertRaises(ValueError) as caught:
                    server_editor._parse_burn_sticker_inputs(payload, root)
                self.assertIn(message, str(caught.exception))
        with self.assertRaises(ValueError):
            server_editor._parse_burn_sticker_inputs([self._entry()], None)
        # 全部区间退化为空的 placement 直接跳过（不算错误）。
        stickers = server_editor._parse_burn_sticker_inputs(
            [self._entry(intervals=[{"start": 100, "end": 100}])], root)
        self.assertEqual(stickers, [])

    def test_parse_rejects_too_many_unique_images(self) -> None:
        for index in range(server_editor.MAX_BURN_STICKER_INPUTS + 1):
            (self.stickers_dir / f"m{index}.png").write_bytes(b"png")
        payload = [self._entry(rel=f"m{index}.png") for index in range(server_editor.MAX_BURN_STICKER_INPUTS + 1)]
        with self.assertRaises(ValueError) as caught:
            server_editor._parse_burn_sticker_inputs(payload, self.stickers_dir)
        self.assertIn("图片数量超过上限", str(caught.exception))

    def test_parse_empty_and_none_pass_through(self) -> None:
        self.assertEqual(server_editor._parse_burn_sticker_inputs(None, None), [])
        self.assertEqual(server_editor._parse_burn_sticker_inputs([], None), [])

    def test_chain_lines_use_static_contain_coordinates(self) -> None:
        stickers = server_editor._parse_burn_sticker_inputs(
            [self._entry(), self._entry(rel="b.gif", intervals=[{"start": 0, "end": 800}])], self.stickers_dir)
        lines = server_editor._burn_sticker_chain_lines(stickers, "[0:v:0]")
        # 假字节文件读不到尺寸，退化为整框矩形（仍是纯数字坐标）。
        self.assertEqual(lines[0], "[1:v]null[burn_raw0_0]")
        self.assertEqual(lines[1], "[2:v]null[burn_raw1_0]")
        self.assertIn("[burn_raw0_0]scale=w=100:h=75[burn_stick0]", lines[2])
        self.assertIn("[0:v:0][burn_stick0]overlay=x=200:y=30:", lines[3])
        self.assertIn("enable='gte(t,1.000)*lt(t,2.500)+gte(t,3.000)*lt(t,4.500)':shortest=1", lines[3])
        self.assertEqual(lines[-1], "[burn_ovl1]ass=filename='burn.ass'[burn_video]")
        self.assertNotIn("force_original_aspect_ratio", "\n".join(lines))
        self.assertNotIn("(120-W)", "\n".join(lines))

    def test_chain_lines_split_one_input_across_same_rel_placements(self) -> None:
        stickers = server_editor._parse_burn_sticker_inputs(
            [self._entry(), self._entry(intervals=[{"start": 5000, "end": 6000}])], self.stickers_dir)
        lines = server_editor._burn_sticker_chain_lines(stickers, "[0:v:0]")
        self.assertEqual(lines[0], "[1:v]split=2[burn_raw0_0][burn_raw0_1]")
        self.assertIn("[burn_raw0_0]scale=w=100:h=75[burn_stick0]", lines[1])
        self.assertIn("[0:v:0][burn_stick0]overlay=x=200:y=30:", lines[2])
        self.assertIn("[burn_raw0_1]scale=w=100:h=75[burn_stick1]", lines[3])
        self.assertIn("[burn_ovl0][burn_stick1]overlay=x=200:y=30:", lines[4])
        self.assertIn("enable='gte(t,5.000)*lt(t,6.000)'", lines[4])

    def test_cue_left_contain_aligns_right_edge(self) -> None:
        # 窄图：60x100 在 100x75 框 → fit = 0.75 → 45x75；右对齐 x = 200 + 55 = 255，
        # 居中则是 227——cue-left 必须贴住目标框右缘（字幕间隙），与图片宽窄无关。
        ihdr = (b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR"
                + struct.pack(">II", 60, 100) + b"\x08\x06\x00\x00\x00")
        narrow = self.stickers_dir / "narrow.png"
        narrow.write_bytes(ihdr)
        payload = {"mode": "cue-left", "placements": [self._entry(rel="narrow.png")]}
        stickers = server_editor._parse_burn_sticker_inputs(payload, self.stickers_dir)
        self.assertEqual((stickers[0]["x"], stickers[0]["y"],
                          stickers[0]["width"], stickers[0]["height"]), (255, 30, 45, 75))
        # fixed 模式同一张窄图居中：x = 200 + (100-45)//2 = 227。
        stickers = server_editor._parse_burn_sticker_inputs([self._entry(rel="narrow.png")], self.stickers_dir)
        self.assertEqual(stickers[0]["x"], 227)
        # placement 显式 align 覆盖模式默认值（cue-left 的回退段用 center）。
        payload = {"mode": "cue-left", "placements": [
            self._entry(rel="narrow.png", align="center")]}
        stickers = server_editor._parse_burn_sticker_inputs(payload, self.stickers_dir)
        self.assertEqual(stickers[0]["x"], 227)

    def test_vp8l_sticker_keeps_contain_geometry(self) -> None:
        # 无损（VP8L）静态 WebP 是贴纸包常见格式：尺寸解析失败会退化为整框
        # 拉伸（静默纵横比畸变），必须能读出尺寸并按 contain 适配。
        riff_header = b"RIFF" + (4).to_bytes(4, "little") + b"WEBP"
        vp8l = self.stickers_dir / "lossless.webp"
        vp8l.write_bytes(riff_header + b"VP8L" + (16).to_bytes(4, "little")
                         + b"\x2f" + struct.pack("<I", (59) | ((79) << 14)) + b"\x00" * 11)
        stickers = server_editor._parse_burn_sticker_inputs([self._entry(rel="lossless.webp")],
            self.stickers_dir)
        # 60x80 图在 (200,30,100,75) 框：fit = min(100/60, 75/80, 1) = 0.9375 → 56x75，
        # 居中 x = 200 + (100-56)//2 = 222，y = 30 + 0 = 30。
        self.assertEqual((stickers[0]["x"], stickers[0]["y"],
                          stickers[0]["width"], stickers[0]["height"]), (222, 30, 56, 75))

    def test_sticker_geometry_rejects_out_of_range_values(self) -> None:
        with self.assertRaises(ValueError) as caught:
            server_editor._parse_burn_sticker_inputs([self._entry(width=100_000)], self.stickers_dir)
        self.assertIn("几何参数无效", str(caught.exception))
        with self.assertRaises(ValueError):
            server_editor._parse_burn_sticker_inputs([self._entry(x=2_000_000)], self.stickers_dir)

    def test_parse_computes_static_contain_box_from_image_size(self) -> None:
        ihdr = (b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR"
                + struct.pack(">II", 200, 100) + b"\x08\x06\x00\x00\x00")
        wide = self.stickers_dir / "wide.png"
        wide.write_bytes(ihdr)
        stickers = server_editor._parse_burn_sticker_inputs([self._entry(rel="wide.png")], self.stickers_dir)
        # fit = min(100/200, 75/100, 1) = 0.5 → 100x50，层内水平居中、垂直居中。
        self.assertEqual((stickers[0]["x"], stickers[0]["y"],
                          stickers[0]["width"], stickers[0]["height"]), (200, 42, 100, 50))

    def test_interval_filter_wraps_chain_between_setpts_and_ass(self) -> None:
        stickers = server_editor._parse_burn_sticker_inputs([self._entry()], self.stickers_dir)
        graph = server_editor._burn_interval_filter([(0, 2000), (3000, 5000)], 1, stickers)
        lines = graph.strip().split(";\n")
        self.assertIn("[burn_base]", lines[0])
        self.assertNotIn("ass=", lines[0])
        self.assertEqual(lines[1], "[1:v]null[burn_raw0_0]")
        self.assertTrue(lines[2].startswith("[burn_raw0_0]scale="))
        self.assertTrue(lines[3].startswith("[burn_base][burn_stick0]overlay="))
        self.assertEqual(lines[4], "[burn_ovl0]ass=filename='burn.ass'[burn_video]")
        self.assertIn("[burn_audio_0]", graph)
        legacy = server_editor._burn_interval_filter([(0, 2000)], 0, None)
        self.assertIn("setpts=", legacy.split(";\n")[0])
        self.assertIn("ass=filename='burn.ass'[burn_video]", legacy)

    def test_full_video_burn_wires_sticker_inputs_and_filter_complex(self) -> None:
        stickers = server_editor._parse_burn_sticker_inputs(
            [self._entry(), self._entry(rel="b.gif", intervals=[{"start": 0, "end": 800}])], self.stickers_dir)
        self._run_full_video(stickers)
        command = next(command for command in self.calls if command[0] == "ffmpeg")
        self.assertEqual(command[command.index("-loop") + 1], "1")
        self.assertEqual(command[command.index("-i", command.index("-loop")) + 1], str(self.sticker_a))
        self.assertEqual(command[command.index("-i", command.index(str(self.sticker_a))) + 1], str(self.sticker_gif))
        self.assertIn("-/filter_complex", command)
        self.assertEqual(command[command.index("-map") + 1], "[burn_video]")
        self.assertEqual(command[command.index("-map", command.index("-map") + 1) + 1], "0:a?")
        graph = Path(command[command.index("-/filter_complex") + 1]).read_text(encoding="utf-8")
        self.assertIn("overlay=", graph)
        self.assertIn("ass=filename='burn.ass'[burn_video]", graph)

    def test_full_video_burn_without_stickers_keeps_vf_shortcut(self) -> None:
        self._run_full_video([])
        command = next(command for command in self.calls if command[0] == "ffmpeg")
        self.assertEqual(command[command.index("-vf") + 1], "ass=filename='burn.ass'")
        self.assertNotIn("-/filter_complex", command)

    def test_http_burn_job_forwards_stickers_to_export(self) -> None:
        from tests.test_local_editor_server import server_editor as loaded_server_editor
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name).resolve()
        stickers_dir = root / "stickers"
        stickers_dir.mkdir()
        sticker = stickers_dir / "a.png"
        sticker.write_bytes(b"png")
        source = root / "source.mp4"
        source.write_bytes(b"source")
        project = loaded_server_editor.ServerProject(data={"segments": []}, json_path=root / "project.json",
            media_path=source, source_media_path=source, sticker_root=stickers_dir, stickers=[])
        server = loaded_server_editor.EditorServer(("127.0.0.1", 0), project, no_waveform=True)
        server.media_jobs.temp_root = root
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        # addCleanup runs LIFO: shutdown → close → join keeps the socket valid while stopping.
        self.addCleanup(thread.join, 2)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        base = "/api/exports/burned-video/jobs"
        captured = {}

        def burn(source_path, intervals, ass, output, **kwargs):
            captured["stickers"] = kwargs.get("stickers")
            output.write_bytes(b"burned-video")

        def request(path, payload=None):
            headers = {"Content-Type": "application/json", "X-MAW-Request-Token": server.request_token}
            data = json.dumps(payload).encode() if payload is not None else None
            req = urllib.request.Request(f"http://127.0.0.1:{server.server_address[1]}{path}",
                data=data, headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=5) as response:
                    return response.status, json.loads(response.read())
            except urllib.error.HTTPError as error:
                return error.code, json.loads(error.read())

        payload = {"requestToken": server.request_token, **server.project_binding_payload(),
                   "ass": ASS_TEXT,
                   "stickers": [{"rel": "a.png", "x": 10, "y": 20, "width": 30, "height": 40,
                                 "intervals": [{"start": 0, "end": 900}]}]}
        tools = mock.Mock(ffmpeg=Path("ffmpeg"), ffprobe=Path("ffprobe"))
        with mock.patch.object(loaded_server_editor, "editor_ffmpeg_tools", return_value=tools), \
             mock.patch.object(loaded_server_editor.EditorServer, "ensure_libass_supported", return_value=True), \
             mock.patch.object(loaded_server_editor, "burn_ass_video", side_effect=burn):
            status, job = request(base, payload)
            self.assertEqual(status, 202)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                _, state = request(f"{base}/{job['jobId']}")
                if state["state"] == "ready":
                    break
                time.sleep(.01)
            self.assertEqual(state["state"], "ready")
        self.assertEqual(len(captured["stickers"]), 1)
        self.assertEqual(captured["stickers"][0]["path"], sticker)
        self.assertEqual(captured["stickers"][0]["intervals"], [(0, 900)])

        # Inactive sticker root: stickers cannot be burned and the request is rejected.
        server.project = server_editor.replace(server.project, sticker_root=None)
        status, error = request(base, {**payload, "stickers": [{"rel": "a.png", "x": 1, "y": 1,
            "width": 2, "height": 2, "intervals": [{"start": 0, "end": 1}]}]})
        self.assertEqual(status, 400)
        self.assertIn("表情包", error["error"])
