from __future__ import annotations

from tests.compact_assertions import CompactContainerAssertions

import base64
import importlib.util
import io
import json
import os
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
import zipfile
from dataclasses import replace
from pathlib import Path
from unittest import mock

from maw.project import PROJECT_SCHEMA
import edit


ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "server-editor" / "serve.py"
SPEC = importlib.util.spec_from_file_location("asr_local_editor_server", SERVER_PATH)
assert SPEC and SPEC.loader
server_editor = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = server_editor
SPEC.loader.exec_module(server_editor)


def _write_reapeaks_for(media_path: Path) -> Path:
    """Write a synthetic RPKN .ReaPeaks beside media, header carrying its real mtime/size.

    One wave mip (div=80, 2 peaks) + one spectral mip (2 peaks), so both
    spectral and waveform payloads can be loaded. ``peaks_per_second=100``
    targets div=80, matching the spectral mip.
    """
    src = media_path.stat()
    header = struct.pack("<4sBBiii", b"RPKN", 1, 2, 8000, int(src.st_mtime), src.st_size)
    mip_headers = struct.pack("<iiii", 80, 2, -ord("s"), 2)
    wave_data = struct.pack("<hhhh", 100, -100, 200, -50)
    spec_data = struct.pack("<ii", (16383 << 15) | 300, (100 << 15) | 5000)
    path = media_path.with_name(media_path.name + ".ReaPeaks")
    path.write_bytes(header + mip_headers + wave_data + spec_data)
    return path


class LocalEditorServerTests(CompactContainerAssertions, unittest.TestCase):
    def test_about_release_url_targets_the_build_tag_and_dev_release_list(self) -> None:
        version = edit.get_app_version()
        self.assertEqual(
            edit.get_app_release_url(),
            f"https://github.com/Moyf/moys-asr-workflow/releases/tag/v{version}",
        )
        with mock.patch("edit.get_app_version", return_value="1.9.0-dev.2"):
            self.assertEqual(
                edit.get_app_release_url(),
                "https://github.com/Moyf/moys-asr-workflow/releases",
            )

    def test_gap_removed_intervals_are_ordered_integer_milliseconds(self) -> None:
        self.assertEqual(
            server_editor.normalize_gap_removed_intervals([
                {"startMs": 0, "endMs": 750}, {"startMs": 1000, "endMs": 2250},
            ]),
            [(0, 750), (1000, 2250)],
        )
        for bad_intervals in (
            [],
            [{"startMs": True, "endMs": 500}],
            [{"startMs": 500, "endMs": 500}],
            [{"startMs": 0, "endMs": 1000}, {"startMs": 999, "endMs": 1500}],
            [{"startMs": 1000, "endMs": 1500}, {"startMs": 0, "endMs": 500}],
        ):
            with self.subTest(intervals=bad_intervals), self.assertRaises(server_editor.GapRemovedVideoExportError):
                server_editor.normalize_gap_removed_intervals(bad_intervals)

    def test_rebuild_gap_removed_video_stream_copies_and_checks_every_stream(self) -> None:
        source = self.root / "clip's source.mp4"
        source.write_bytes(b"source")
        output = self.root / "private" / "restructured.mp4"
        streams = [
            {"codec_type": "video", "codec_name": "h264", "profile": "High", "width": 1920, "height": 1080},
            {"codec_type": "audio", "codec_name": "aac", "channels": 2, "sample_rate": "48000"},
        ]
        calls: list[list[str]] = []

        def run(command, **kwargs):
            calls.append(command)
            if command[0] == "ffprobe":
                return subprocess.CompletedProcess(command, 0, stdout=json.dumps({"streams": streams, "format": {"duration": "4.5"}}), stderr="")
            Path(command[-1]).write_bytes(b"rebuilt-media")
            return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

        with mock.patch.object(server_editor.subprocess, "run", side_effect=run):
            result = server_editor.rebuild_gap_removed_video(
                source, [(0, 1250), (2000, 3500)], output,
                ffmpeg_path=Path("ffmpeg"), ffprobe_path=Path("ffprobe"),
            )

        self.assertEqual(result, output)
        self.assertEqual(output.read_bytes(), b"rebuilt-media")
        ffmpeg_command = next(command for command in calls if command[0] == "ffmpeg")
        self.assertEqual(ffmpeg_command[ffmpeg_command.index("-map") + 1], "0")
        self.assertEqual(ffmpeg_command[ffmpeg_command.index("-c") + 1], "copy")
        self.assertEqual(len([command for command in calls if command[0] == "ffprobe"]), 2)
        concat_text = output.with_suffix(".ffconcat").read_text(encoding="utf-8")
        self.assertIn("inpoint 0.000\noutpoint 1.250", concat_text)
        self.assertIn("inpoint 2.000\noutpoint 3.500", concat_text)
        self.assertIn("'\\''", concat_text)

    def test_rebuild_gap_removed_video_rejects_a_dropped_audio_stream(self) -> None:
        source = self.root / "clip.mp4"
        source.write_bytes(b"source")
        output = self.root / "restructured.mp4"
        input_streams = [{"codec_type": "video", "codec_name": "h264"}, {"codec_type": "audio", "codec_name": "aac"}]
        output_streams = [{"codec_type": "video", "codec_name": "h264"}]
        outputs = [input_streams, output_streams]

        def run(command, **kwargs):
            if command[0] == "ffprobe":
                return subprocess.CompletedProcess(command, 0, stdout=json.dumps({"streams": outputs.pop(0)}), stderr="")
            Path(command[-1]).write_bytes(b"video-without-audio")
            return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

        with mock.patch.object(server_editor.subprocess, "run", side_effect=run):
            with self.assertRaisesRegex(server_editor.GapRemovedVideoExportError, "媒体流与源视频不一致"):
                server_editor.rebuild_gap_removed_video(
                    source, [(0, 1000)], output,
                    ffmpeg_path=Path("ffmpeg"), ffprobe_path=Path("ffprobe"),
                )
        self.assertFalse(output.exists())

    def test_rebuild_gap_removed_video_maps_project_intervals_to_file_timestamps(self) -> None:
        source = self.root / "clip.mp4"
        source.write_bytes(b"source")
        streams = [
            {"codec_type": "video", "codec_name": "h264", "start_time": "1.421333"},
            {"codec_type": "audio", "codec_name": "aac", "start_time": "1.400000"},
        ]
        cases = [
            ({}, ["0.000", "0.001", "2.000", "3.500"]),
            ({"format": {}}, ["0.000", "0.001", "2.000", "3.500"]),
            ({"format": {"start_time": None}}, ["0.000", "0.001", "2.000", "3.500"]),
            ({"format": {"start_time": "0.000000"}}, ["0.000000", "0.001000", "2.000000", "3.500000"]),
            ({"format": {"start_time": "1.400000"}}, ["1.400000", "1.401000", "3.400000", "4.900000"]),
            ({"format": {"start_time": "-0.250123"}}, ["-0.250123", "-0.249123", "1.749877", "3.249877"]),
            ({"format": {"start_time": "0.000001"}}, ["0.000001", "0.001001", "2.000001", "3.500001"]),
            ({"format": {"start_time": "10000000000.000001"}}, [
                "10000000000.000001", "10000000000.001001", "10000000002.000001", "10000000003.500001",
            ]),
        ]
        for index, (metadata, expected) in enumerate(cases):
            with self.subTest(metadata=metadata):
                output = self.root / f"rebuilt-{index}.mp4"
                calls: list[list[str]] = []

                def run(command, **kwargs):
                    calls.append(command)
                    if command[0] == "ffprobe":
                        # The output muxer may choose a different origin; only
                        # the source file's origin can locate the kept content.
                        probe_metadata = metadata if command[-1] == str(source.resolve()) else {"format": {"start_time": "0.000000"}}
                        return subprocess.CompletedProcess(command, 0, stdout=json.dumps({"streams": streams, **probe_metadata}), stderr="")
                    Path(command[-1]).write_bytes(b"rebuilt-media")
                    return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

                with mock.patch.object(server_editor.subprocess, "run", side_effect=run):
                    server_editor.rebuild_gap_removed_video(
                        source, [(0, 1), (2000, 3500)], output,
                        ffmpeg_path=Path("ffmpeg"), ffprobe_path=Path("ffprobe"),
                    )
                actual = [
                    line.split(" ", 1)[1] for line in output.with_suffix(".ffconcat").read_text(encoding="utf-8").splitlines()
                    if line.startswith(("inpoint ", "outpoint "))
                ]
                self.assertEqual(actual, expected)
                probe_calls = [command for command in calls if command[0] == "ffprobe"]
                self.assertEqual(len(probe_calls), 2)
                self.assertIn(":format=start_time", probe_calls[0][probe_calls[0].index("-show_entries") + 1])
                self.assertEqual(len([command for command in calls if command[0] == "ffmpeg"]), 1)

    def test_rebuild_gap_removed_video_rejects_invalid_file_start_times_before_ffmpeg(self) -> None:
        source = self.root / "clip.mp4"
        source.write_bytes(b"source")
        invalid_metadata = [
            {"format": None}, {"format": []}, {"format": "1.4"},
            *({"format": {"start_time": value}} for value in (
                True, {}, [], "", "N/A", "not-a-time", "NaN", "sNaN", "Infinity", "-Infinity", float("nan"), float("inf"),
                "1e999999", "-9223372036854.775808",
            )),
        ]
        for index, metadata in enumerate(invalid_metadata):
            with self.subTest(metadata=metadata):
                output = self.root / f"invalid-{index}.mp4"
                payload = {"streams": [{"codec_type": "video", "codec_name": "h264"}], **metadata}
                with mock.patch.object(server_editor.subprocess, "run", return_value=subprocess.CompletedProcess(
                    [], 0, stdout=json.dumps(payload), stderr="",
                )) as run:
                    with self.assertRaisesRegex(server_editor.GapRemovedVideoExportError, "无效的媒体起始时间"):
                        server_editor.rebuild_gap_removed_video(
                            source, [(0, 1000)], output,
                            ffmpeg_path=Path("ffmpeg"), ffprobe_path=Path("ffprobe"),
                        )
                self.assertEqual(run.call_count, 1)
                self.assertFalse(output.exists())
                self.assertFalse(output.with_suffix(".ffconcat").exists())

    def test_rebuild_gap_removed_video_preserves_track_dispositions_and_metadata(self) -> None:
        source = self.root / "clip.mp4"
        source.write_bytes(b"source")
        output = self.root / "restructured.mp4"
        input_streams = [
            {"codec_type": "video", "codec_name": "h264", "disposition": {"default": 1}},
            {
                "codec_type": "audio", "codec_name": "aac", "disposition": {"default": 0},
                "tags": {"language": "eng", "NAME": "English", "HANDLER_NAME": "SoundHandler"},
            },
            {
                "codec_type": "audio", "codec_name": "aac", "disposition": {"default": 1, "dub": 1},
                "tags": {"language": "zho", "title": "Chinese", "handler_name": "Chinese audio"},
            },
        ]
        output_streams = [
            {**input_streams[0], "tags": {"handler_name": "VideoHandler"}},
            {**input_streams[1], "tags": {"language": "eng", "TITLE": "English", "handler_name": "SoundHandler"}},
            {**input_streams[2], "tags": {"language": "zho", "name": "Chinese", "handler_name": "Chinese audio"}},
        ]
        outputs = [input_streams, output_streams]
        calls: list[list[str]] = []

        def run(command, **kwargs):
            calls.append(command)
            if command[0] == "ffprobe":
                return subprocess.CompletedProcess(command, 0, stdout=json.dumps({"streams": outputs.pop(0)}), stderr="")
            Path(command[-1]).write_bytes(b"rebuilt-media")
            return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

        with mock.patch.object(server_editor.subprocess, "run", side_effect=run):
            server_editor.rebuild_gap_removed_video(
                source, [(0, 1000)], output,
                ffmpeg_path=Path("ffmpeg"), ffprobe_path=Path("ffprobe"),
            )

        command = next(command for command in calls if command[0] == "ffmpeg")
        self.assertEqual(command[command.index("-disposition:0") + 1], "default")
        self.assertEqual(command[command.index("-disposition:1") + 1], "0")
        self.assertEqual(command[command.index("-disposition:2") + 1], "default+dub")
        self.assertEqual(
            {value for flag, value in zip(command, command[1:]) if flag == "-metadata:s:1"},
            {"language=eng", "title=English", "handler_name=SoundHandler"},
        )
        self.assertEqual(
            {value for flag, value in zip(command, command[1:]) if flag == "-metadata:s:2"},
            {"language=zho", "title=Chinese", "handler_name=Chinese audio"},
        )
        probe_command = next(command for command in calls if command[0] == "ffprobe")
        self.assertIn(":stream_disposition:stream_tags", probe_command[probe_command.index("-show_entries") + 1])
        self.assertTrue(output.is_file())

    def test_rebuild_gap_removed_video_rejects_changed_track_flags_and_metadata(self) -> None:
        source = self.root / "clip.mp4"
        source.write_bytes(b"source")
        output = self.root / "restructured.mp4"
        audio = {
            "codec_type": "audio", "codec_name": "aac", "disposition": {"default": 1},
            "tags": {"language": "zho", "name": "Chinese", "handler_name": "Chinese audio"},
        }
        altered_streams = [
            {**audio, "disposition": {"default": 0}},
            {**audio, "tags": {**audio["tags"], "language": "eng"}},
            {**audio, "tags": {"language": "zho", "handler_name": "Chinese audio"}},
            {**audio, "tags": {**audio["tags"], "handler_name": "SoundHandler"}},
        ]
        for altered in altered_streams:
            with self.subTest(audio=altered):
                video = {"codec_type": "video", "codec_name": "h264"}
                outputs = [[video, audio], [video, altered]]

                def run(command, **kwargs):
                    if command[0] == "ffprobe":
                        return subprocess.CompletedProcess(command, 0, stdout=json.dumps({"streams": outputs.pop(0)}), stderr="")
                    Path(command[-1]).write_bytes(b"changed-track-metadata")
                    return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

                with mock.patch.object(server_editor.subprocess, "run", side_effect=run):
                    with self.assertRaisesRegex(server_editor.GapRemovedVideoExportError, "媒体流与源视频不一致"):
                        server_editor.rebuild_gap_removed_video(
                            source, [(0, 1000)], output,
                            ffmpeg_path=Path("ffmpeg"), ffprobe_path=Path("ffprobe"),
                        )
                self.assertFalse(output.exists())

    def test_gap_removed_video_endpoint_streams_bound_source_without_accepting_paths(self) -> None:
        source = self.root / "bound.mp4"
        source.write_bytes(b"source")
        outside = self.root / "outside.mp4"
        outside.write_bytes(b"untrusted")
        project = server_editor.ServerProject(
            data={"media": str(source), "segments": []}, json_path=self.project_path,
            media_path=source, sticker_root=None, stickers=[], source_media_path=source,
        )
        captured: dict[str, object] = {}

        def rebuild(source_path, intervals, output_path, **kwargs):
            captured["source"] = source_path
            captured["intervals"] = intervals
            captured["output_path"] = output_path
            captured["tools"] = kwargs
            output_path.write_bytes(b"verified-video-bytes")
            return output_path

        with server_editor.EditorServer(("127.0.0.1", 0), project) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                base_url = f"http://127.0.0.1:{server.server_address[1]}"
                payload = {
                    "requestToken": server.request_token,
                    "intervals": [{"startMs": 0, "endMs": 1200}],
                    "sourceMediaPath": str(outside),
                    "outputPath": str(outside),
                }
                request = urllib.request.Request(
                    f"{base_url}/api/exports/gap-removed-video",
                    data=json.dumps(payload).encode("utf-8"),
                    headers={"Content-Type": "application/json"}, method="POST",
                )
                with mock.patch.object(server_editor, "editor_ffmpeg_tools", return_value=mock.Mock(
                    ffmpeg=Path("ffmpeg"), ffprobe=Path("ffprobe"),
                )), mock.patch.object(server_editor, "rebuild_gap_removed_video", side_effect=rebuild):
                    with urllib.request.urlopen(request, timeout=2) as response:
                        body = response.read()
                        self.assertEqual(response.status, 200)
                        self.assertEqual(response.headers["Content-Type"], "video/mp4")
                        self.assertEqual(int(response.headers["Content-Length"]), len(body))
                        self.assertIn("filename*=UTF-8''bound_gap-removed.mp4", response.headers["Content-Disposition"])
                self.assertEqual(body, b"verified-video-bytes")
                self.assertEqual(captured["source"], source)
                self.assertEqual(captured["intervals"], [(0, 1200)])
                self.assertEqual(outside.read_bytes(), b"untrusted")
            finally:
                server.shutdown()
                thread.join(timeout=2)

    def test_gap_removed_video_endpoint_requires_token_and_ordered_intervals(self) -> None:
        source = self.root / "bound.mp4"
        source.write_bytes(b"source")
        project = server_editor.ServerProject(
            data={"media": str(source), "segments": []}, json_path=self.project_path,
            media_path=source, sticker_root=None, stickers=[], source_media_path=source,
        )
        with server_editor.EditorServer(("127.0.0.1", 0), project) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                base_url = f"http://127.0.0.1:{server.server_address[1]}"

                def post(payload):
                    request = urllib.request.Request(
                        f"{base_url}/api/exports/gap-removed-video",
                        data=json.dumps(payload).encode("utf-8"),
                        headers={"Content-Type": "application/json"}, method="POST",
                    )
                    try:
                        with urllib.request.urlopen(request, timeout=2) as response:
                            return response.status, json.loads(response.read())
                    except urllib.error.HTTPError as error:
                        return error.code, json.loads(error.read())

                with mock.patch.object(server_editor, "editor_ffmpeg_tools", side_effect=AssertionError("must not resolve tools")):
                    status, response = post({
                        "requestToken": "wrong", "intervals": [{"startMs": 0, "endMs": 1000}],
                    })
                    self.assertEqual(status, 403)
                    self.assertFalse(response["ok"])
                    status, response = post({
                        "requestToken": server.request_token,
                        "intervals": [{"startMs": 1000, "endMs": 2000}, {"startMs": 0, "endMs": 500}],
                    })
                    self.assertEqual(status, 400)
                    self.assertIn("排序", response["error"])
            finally:
                server.shutdown()
                thread.join(timeout=2)

    def test_open_backup_folder_is_bound_and_requires_token(self) -> None:
        handler = object.__new__(server_editor.EditorRequestHandler)
        handler.server = mock.Mock()
        handler.server.project.json_path = self.project_path
        handler.server.request_token = 'test-token'
        handler.send_json = mock.Mock()
        handler.read_json_request = mock.Mock(return_value={'requestToken': 'wrong'})
        with mock.patch.object(server_editor.os, 'startfile', create=True) as opener, mock.patch.object(server_editor.sys, 'platform', 'win32'):
            handler.open_backup_directory()
            self.assertEqual(handler.send_json.call_args.args[0], 403)
            opener.assert_not_called()
            handler.read_json_request.return_value = {'requestToken': 'test-token', 'path': str(self.root / 'untrusted')}
            with mock.patch('maw.project_backups.resolve_lang', return_value='zh'):
                handler.open_backup_directory()
            opener.assert_called_once_with(str(self.root / '_maw' / '备份'))
            self.assertEqual(handler.send_json.call_args.args[0], 200)

    def test_open_backup_directory_passes_restored_env_to_posix_opener(self) -> None:
        handler = object.__new__(server_editor.EditorRequestHandler)
        handler.server = mock.Mock()
        handler.server.project.json_path = self.project_path
        handler.server.request_token = 'test-token'
        handler.send_json = mock.Mock()
        handler.read_json_request = mock.Mock(return_value={'requestToken': 'test-token'})
        with mock.patch.object(server_editor.sys, 'platform', 'linux'), mock.patch.object(
            server_editor.subprocess, 'Popen'
        ) as popen:
            handler.open_backup_directory()

        self.assertEqual(handler.send_json.call_args.args[0], 200)
        self.assertEqual(popen.call_args.args[0][0], 'xdg-open')
        # open/xdg-open 是宿主桌面程序：必须用还原后的宿主环境（非 frozen 即原环境）。
        self.assertEqual(popen.call_args.kwargs['env'], dict(os.environ))

    def _ass_frame_handler(self) -> object:
        handler = object.__new__(server_editor.EditorRequestHandler)
        handler.server = mock.Mock()
        handler.server.project.media_path = self.media
        handler.server.request_token = 'test-token'
        handler.send_json = mock.Mock()
        return handler

    def test_ass_frame_endpoint_requires_token_and_valid_payload(self) -> None:
        handler = self._ass_frame_handler()
        payload = {'requestToken': 'test-token', 'ass': '[Script Info]\n', 'timeMs': 1200}

        handler.read_json_request = mock.Mock(return_value={**payload, 'requestToken': 'wrong'})
        handler.render_ass_frame()
        self.assertEqual(handler.send_json.call_args.args[0], 403)

        for bad_request in (
            {**payload, 'ass': '   '},
            {**payload, 'ass': None},
            {**payload, 'timeMs': '1200'},
            {**payload, 'timeMs': -1},
            {**payload, 'timeMs': True},
            {**payload, 'timeMs': 9_007_199_254_740_992},
            {**payload, 'timeMs': 10 ** 1000},
        ):
            handler.read_json_request = mock.Mock(return_value=bad_request)
            handler.render_ass_frame()
            self.assertEqual(handler.send_json.call_args.args[0], 400)

        handler.server.project.media_path = None
        handler.read_json_request = mock.Mock(return_value=payload)
        handler.render_ass_frame()
        self.assertEqual(handler.send_json.call_args.args[0], 400)
        self.assertIn('媒体', handler.send_json.call_args.args[1]['error'])

    def test_ass_frame_endpoint_requires_libass_filter(self) -> None:
        handler = self._ass_frame_handler()
        handler.read_json_request = mock.Mock(return_value={'requestToken': 'test-token', 'ass': '[Script Info]\n', 'timeMs': 0})
        handler.server.ensure_libass_supported = mock.Mock(return_value=False)
        with mock.patch.object(server_editor, 'editor_ffmpeg_binary', return_value=Path('ffmpeg')):
            handler.render_ass_frame()
        self.assertEqual(handler.send_json.call_args.args[0], 400)
        self.assertIn('libass', handler.send_json.call_args.args[1]['error'])
        self.assertEqual(handler.send_json.call_args.args[1]['code'], 'ASS_FRAME_LIBASS_UNAVAILABLE')
        handler.server.ensure_libass_supported.assert_called_once_with(Path('ffmpeg'))

    def test_ass_frame_endpoint_reports_missing_ffmpeg_code(self) -> None:
        handler = self._ass_frame_handler()
        handler.read_json_request = mock.Mock(return_value={
            'requestToken': 'test-token', 'ass': '[Script Info]\n', 'timeMs': 0,
        })
        with mock.patch.object(server_editor, 'editor_ffmpeg_binary', return_value=None):
            handler.render_ass_frame()
        self.assertEqual(handler.send_json.call_args.args[0], 400)
        self.assertEqual(handler.send_json.call_args.args[1]['code'], 'ASS_FRAME_FFMPEG_MISSING')

    def test_libass_capability_cache_tracks_binary_replacement(self) -> None:
        server = object.__new__(server_editor.EditorServer)
        server.ass_frame_lock = threading.Lock()
        server.libass_supported = None
        server.libass_binary_signature = None
        first = self.root / 'first-ffmpeg'
        second = self.root / 'second-ffmpeg'
        first.write_bytes(b'old build')
        second.write_bytes(b'new build')
        with mock.patch.object(server_editor, 'ffmpeg_supports_libass', side_effect=[False, True, False]) as probe:
            self.assertFalse(server.ensure_libass_supported(first))
            self.assertFalse(server.ensure_libass_supported(first))
            self.assertEqual(probe.call_count, 1)
            self.assertTrue(server.ensure_libass_supported(second))
            self.assertTrue(server.ensure_libass_supported(second))
            self.assertEqual(probe.call_count, 2)
            second.write_bytes(b'replaced build with different size')
            self.assertFalse(server.ensure_libass_supported(second))
            self.assertEqual(probe.call_count, 3)

    def test_ass_frame_endpoint_returns_base64_png_and_warnings(self) -> None:
        handler = self._ass_frame_handler()
        handler.read_json_request = mock.Mock(return_value={'requestToken': 'test-token', 'ass': '[Script Info]\n', 'timeMs': 2500})
        handler.server.ensure_libass_supported = mock.Mock(return_value=True)
        warnings = ['字幕字体「Demo」缺少字形 U+4E2D，实际画面可能显示方框。']
        with mock.patch.object(server_editor, 'editor_ffmpeg_binary', return_value=Path('ffmpeg')), \
             mock.patch.object(server_editor, 'render_ass_frame_png', return_value=(b'\x89PNG-data', warnings)) as renderer:
            handler.render_ass_frame()
        self.assertEqual(handler.send_json.call_args.args[0], 200)
        body = handler.send_json.call_args.args[1]
        self.assertTrue(body['ok'])
        self.assertEqual(base64.b64decode(body['image']), b'\x89PNG-data')
        self.assertEqual(body['timeMs'], 2500)
        self.assertEqual(body['warnings'], warnings)
        media_path, ass_text, time_ms, ffmpeg = renderer.call_args.args
        self.assertEqual(media_path, self.media)
        self.assertEqual(ass_text, '[Script Info]\n')
        self.assertEqual(time_ms, 2500)
        self.assertEqual(ffmpeg, Path('ffmpeg'))

    def test_ffmpeg_supports_libass_probe_matches_filter_listing(self) -> None:
        listing = (
            " T. ass               V->V       Render ASS subtitles onto input video using the libass library.\n"
            " T. subtitles          V->V       Render text subtitles onto input video using the libass library.\n"
        )
        with mock.patch.object(server_editor.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, stdout=listing, stderr='')):
            self.assertTrue(server_editor.ffmpeg_supports_libass(Path('ffmpeg')))
        with mock.patch.object(server_editor.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, stdout=' T. drawtext V->V Draw text\n', stderr='')):
            self.assertFalse(server_editor.ffmpeg_supports_libass(Path('ffmpeg')))
        with mock.patch.object(server_editor.subprocess, 'run', side_effect=OSError('missing')):
            self.assertFalse(server_editor.ffmpeg_supports_libass(Path('ffmpeg')))

    def test_render_ass_frame_png_builds_burn_style_command(self) -> None:
        calls = []

        def fake_run(command, **kwargs):
            calls.append((command, kwargs))
            stderr = (
                "[Parsed_ass_0 @ 0x1] fontselect: failed to find any fallback "
                "with glyph 0x1f914 for font: (Demo, 400, 0)\n"
                "fontselect: failed to find any fallback with glyph 0x01F914 for font: (Demo, 400, 0)\n"
            ).encode('utf-8')
            return subprocess.CompletedProcess(command, 0, stdout=b'\x89PNG\r\n\x1a\n', stderr=stderr)

        with mock.patch.object(server_editor.subprocess, 'run', side_effect=fake_run):
            png, warnings = server_editor.render_ass_frame_png(self.media, '[Script Info]\n', 1500, Path('ffmpeg'))

        self.assertTrue(png.startswith(b'\x89PNG'))
        self.assertEqual(len(warnings), 1)
        self.assertIn('Demo', warnings[0])
        self.assertIn('U+1F914（🤔）', warnings[0])
        command, kwargs = calls[0]
        self.assertEqual(command[command.index('-vf') + 1], "format=rgb24,ass=filename='frame.ass'")
        self.assertEqual(command[command.index('-frames:v') + 1], '1')
        self.assertEqual(command[command.index('-map') + 1], '0:V:0')
        # -copyts 保持原始时间戳，libass 才能按播放头时间命中字幕事件。
        self.assertEqual(command.index('-copyts'), command.index('-ss') + 2)
        self.assertEqual(command[command.index('-ss') + 1], '1.500')
        self.assertEqual(command[-1], 'pipe:1')
        self.assertTrue(Path(kwargs['cwd']).name.startswith('maw-ass-frame-'))

    def test_render_ass_frame_png_reports_empty_output_as_error(self) -> None:
        with mock.patch.object(
            server_editor.subprocess, 'run',
            return_value=subprocess.CompletedProcess([], 0, stdout=b'', stderr=b'Output file is empty'),
        ):
            with self.assertRaisesRegex(server_editor.AssFrameError, '没有视频画面'):
                server_editor.render_ass_frame_png(self.media, '[Script Info]\n', 0, Path('ffmpeg'))

    def test_ass_frame_render_uses_real_libass_when_available(self) -> None:
        ffmpeg = server_editor.editor_ffmpeg_binary()
        if ffmpeg is None:
            self.skipTest('未找到 FFmpeg，跳过真实单帧渲染验证')
        if not server_editor.ffmpeg_supports_libass(ffmpeg):
            # Homebrew 等发行版构建可能不编译 libass（无 ass 滤镜）。
            self.skipTest('FFmpeg 未编译 ass 滤镜，跳过真实单帧渲染验证')
        with tempfile.TemporaryDirectory() as directory:
            media = Path(directory) / 'clip.mp4'
            encode = subprocess.run([
                str(ffmpeg), '-hide_banner', '-loglevel', 'error',
                '-f', 'lavfi', '-i', 'color=black:s=320x180:d=1',
                '-c:v', 'mpeg4', '-q:v', '20', '-y', str(media),
            ], capture_output=True, text=True)
            self.assertEqual(encode.returncode, 0, encode.stderr)
            ass_text = (
                '[Script Info]\nScriptType: v4.00+\nPlayResX: 320\nPlayResY: 180\nYCbCr Matrix: None\n\n'
                '[V4+ Styles]\n'
                'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n'
                'Style: Default,Arial,24,&H0000FF00,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1\n\n'
                '[Events]\n'
                'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'
                'Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,帧预览\n'
            )
            png, warnings = server_editor.render_ass_frame_png(media, ass_text, 300, ffmpeg)
            # 回归守卫：字幕必须真实改变像素。输入侧 -ss 若缺 -copyts 会重置
            # 时间戳，libass 按错误时间判定事件，画面会与无字幕帧完全一致。
            plain = subprocess.run([
                str(ffmpeg), '-hide_banner', '-loglevel', 'error',
                '-ss', '0.300', '-copyts', '-i', str(media),
                '-frames:v', '1', '-c:v', 'png', '-f', 'image2pipe', 'pipe:1',
            ], capture_output=True)
            self.assertEqual(plain.returncode, 0, plain.stderr.decode('utf-8', 'replace'))
            # Source dimensions are preserved, and RGB glyph composition must
            # not introduce red/blue chroma fringing around pure green text.
            self.assertEqual(struct.unpack('>II', png[16:24]), (320, 180))
            decoded = subprocess.run([
                str(ffmpeg), '-hide_banner', '-loglevel', 'error',
                '-i', 'pipe:0', '-frames:v', '1', '-pix_fmt', 'rgb24',
                '-f', 'rawvideo', 'pipe:1',
            ], input=png, capture_output=True)
            self.assertEqual(decoded.returncode, 0, decoded.stderr.decode('utf-8', 'replace'))
            pixels = decoded.stdout
            self.assertGreater(sum(value > 0 for value in pixels[1::3]), 50)
            self.assertLessEqual(max(pixels[0::3]), 1)
            self.assertLessEqual(max(pixels[2::3]), 1)
        self.assertTrue(png.startswith(b'\x89PNG'))
        self.assertIsInstance(warnings, list)
        self.assertNotEqual(png, plain.stdout)

    def test_version_backup_does_not_save_or_remember_snapshot(self) -> None:
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        original = self.project_path.read_bytes()
        with server_editor.EditorServer(('127.0.0.1', 0), project) as server:
            data = {'segments': [], 'language': 'en'}
            target, backup = server.save_project(data, backup_limit=2, backup_only=True)
            self.assertEqual(target, self.project_path)
            self.assertEqual(self.project_path.read_bytes(), original)
            self.assertEqual(server.settings.recent_projects, ())
            self.assertEqual(json.loads(backup.read_text(encoding='utf-8'))['language'], 'en')
            server.save_project(data, backup_limit=2)
            self.assertEqual(len(list(backup.parent.glob('*.mosp-bak'))), 2)
            self.assertEqual([p.path for p in server.settings.recent_projects], [target])
            self.assertIs(server_editor.remember_project(server.settings, backup), server.settings)

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        # Windows CI may expose %TEMP% as an 8.3 short path while production code resolves it.
        self.root = Path(self.temp_dir.name).resolve()
        self.media = self.root / "clip.mp3"
        self.media.write_bytes(b"0123456789")
        self.stickers = self.root / "stickers"
        (self.stickers / "nested").mkdir(parents=True)
        (self.stickers / "nested" / "cat.png").write_bytes(b"png")
        self.project_path = self.root / "clip.json"
        self.project_path.write_text(
            json.dumps({"media": str(self.media), "segments": []}), encoding="utf-8",
        )
        self.other_media = self.root / "other.mp3"
        self.other_media.write_bytes(b"abcdefghij")
        self.other_project_path = self.root / "other.json"
        self.other_project_path.write_text(
            json.dumps({"media": str(self.other_media), "segments": []}), encoding="utf-8",
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_server_help_exposes_short_port_option(self) -> None:
        result = subprocess.run(
            [sys.executable, str(SERVER_PATH), "-h"],
            capture_output=True,
            check=True,
            text=True,
        )

        self.assertRegex(result.stdout, r"-p(?: PORT)?, --port PORT")

    def test_default_settings_path_uses_unified_maw_namespace(self) -> None:
        with mock.patch.object(server_editor.sys, "platform", "win32"), mock.patch.dict(
            os.environ,
            {"LOCALAPPDATA": str(self.root / "LocalAppData"), "MAW_APP_DATA_ROOT": ""},
            clear=True,
        ):
            self.assertEqual(
                server_editor.default_settings_path(),
                self.root / "LocalAppData" / "MAW" / "server-editor-settings.json",
            )

    def test_default_settings_read_uses_legacy_file_only_when_new_file_is_absent(self) -> None:
        primary = self.root / "MAW" / "server-editor-settings.json"
        legacy = self.root / "Moy" / "moys-asr-workflow" / "server-editor-settings.json"
        legacy.parent.mkdir(parents=True)
        legacy_settings = server_editor.replace(server_editor.ServerSettings(), auto_open_last_project=False)
        server_editor.write_server_settings(legacy, legacy_settings)

        with mock.patch.object(server_editor, "default_settings_path", return_value=primary), mock.patch.object(
            server_editor, "legacy_server_settings_path", return_value=legacy
        ):
            loaded = server_editor.load_default_server_settings()

        self.assertFalse(loaded.auto_open_last_project)
        self.assertFalse(primary.exists())

    def test_default_settings_read_prefers_new_file_over_legacy_file(self) -> None:
        primary = self.root / "MAW" / "server-editor-settings.json"
        legacy = self.root / "Moy" / "moys-asr-workflow" / "server-editor-settings.json"
        primary.parent.mkdir(parents=True)
        legacy.parent.mkdir(parents=True)
        server_editor.write_server_settings(primary, server_editor.replace(server_editor.ServerSettings(), auto_open_last_project=False))
        server_editor.write_server_settings(legacy, server_editor.replace(server_editor.ServerSettings(), auto_open_last_project=True))

        with mock.patch.object(server_editor, "default_settings_path", return_value=primary), mock.patch.object(
            server_editor, "legacy_server_settings_path", return_value=legacy
        ):
            loaded = server_editor.load_default_server_settings()

        self.assertFalse(loaded.auto_open_last_project)

    def test_server_responds_before_initial_project_load_finishes(self) -> None:
        project = server_editor.load_blank_project(str(self.stickers))
        load_started = threading.Event()
        release_load = threading.Event()
        waveform = {
            "schema": "moy.asr.waveform.v1",
            "encoding": "i8-minmax-base64",
            "peaks_per_second": 100,
            "peak_count": 1,
            "duration_ms": 1000,
            "data": "AIA=",
        }

        def load_project_in_background(progress: server_editor.ProjectLoadProgressCallback) -> server_editor.ServerProject:
            progress("loading_waveform_cache", 40)
            load_started.set()
            release_load.wait(timeout=3)
            return server_editor.load_project(
                self.project_path, None, str(self.stickers),
                no_waveform=False, load_reapeaks=False,
                peaks_per_second=100, progress=progress,
            )

        with mock.patch.object(server_editor.edit, "load_or_extract_waveform", return_value=(waveform, False)):
            with server_editor.EditorServer(
                ("127.0.0.1", 0), project,
                project_loader=load_project_in_background,
            ) as server:
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                base_url = f"http://127.0.0.1:{server.server_address[1]}"
                try:
                    self.assertTrue(load_started.wait(timeout=2))
                    with urllib.request.urlopen(f"{base_url}/api/startup-status", timeout=2) as response:
                        status = json.loads(response.read())
                    self.assertEqual(status["status"], "loading")
                    self.assertEqual(status["stage"], "loading_waveform_cache")

                    with urllib.request.urlopen(base_url, timeout=2) as response:
                        page = response.read().decode("utf-8")
                    self.assertIn('"startupStatus": "loading"', page)

                    release_load.set()
                    deadline = time.monotonic() + 2
                    while time.monotonic() < deadline:
                        with urllib.request.urlopen(f"{base_url}/api/startup-status", timeout=2) as response:
                            status = json.loads(response.read())
                        if status["status"] == "ready":
                            break
                        time.sleep(0.02)
                    self.assertEqual(status["status"], "ready")
                    self.assertEqual(server.project.json_path, self.project_path.resolve())
                    self.assertIs(server.project.data["waveform"], waveform)
                finally:
                    release_load.set()
                    server.shutdown()
                    thread.join(timeout=2)

    def test_project_load_reports_distinct_waveform_cache_and_generation_phases(self) -> None:
        waveform = {
            "schema": "moy.asr.waveform.v1",
            "encoding": "i8-minmax-base64",
            "peaks_per_second": 100,
            "peak_count": 1,
            "duration_ms": 10,
            "data": "AIA=",
        }
        events: list[tuple[str, int]] = []

        def load_waveform(*_args: object, **kwargs: object) -> tuple[dict, bool]:
            callback = kwargs["on_progress"]
            assert callable(callback)
            callback("generating")
            return waveform, True

        with mock.patch.object(server_editor.edit, "load_or_extract_waveform", side_effect=load_waveform):
            server_editor.load_project(
                self.project_path,
                None,
                str(self.stickers),
                no_waveform=False,
                load_reapeaks=False,
                peaks_per_second=100,
                progress=lambda stage, value: events.append((stage, value)),
            )

        self.assertEqual(
            events,
            [
                ("reading_project", 5),
                ("validating_project", 20),
                ("preparing_media", 35),
                ("loading_waveform_cache", 40),
                ("generating_waveform", 50),
                ("waveform_ready", 60),
                ("finalizing", 95),
            ],
        )

    def test_project_load_cache_hit_does_not_report_waveform_generation(self) -> None:
        waveform = {
            "schema": "moy.asr.waveform.v1",
            "encoding": "i8-minmax-base64",
            "peaks_per_second": 100,
            "peak_count": 1,
            "duration_ms": 10,
            "data": "AIA=",
        }
        events: list[tuple[str, int]] = []
        with mock.patch.object(
            server_editor.edit,
            "load_or_extract_waveform",
            return_value=(waveform, False),
        ):
            server_editor.load_project(
                self.project_path,
                None,
                str(self.stickers),
                no_waveform=False,
                load_reapeaks=False,
                peaks_per_second=100,
                progress=lambda stage, value: events.append((stage, value)),
            )

        self.assertNotIn(("generating_waveform", 50), events)
        self.assertIn(("loading_waveform_cache", 40), events)
        self.assertIn(("waveform_ready", 60), events)

    def test_initial_project_load_error_keeps_server_available(self) -> None:
        project = server_editor.load_blank_project(str(self.stickers))

        def fail_project_load(progress: server_editor.ProjectLoadProgressCallback) -> server_editor.ServerProject:
            progress("reading_project", 5)
            raise ValueError("测试工程无法读取")

        with server_editor.EditorServer(
            ("127.0.0.1", 0), project, no_waveform=True,
            project_loader=fail_project_load,
        ) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base_url = f"http://127.0.0.1:{server.server_address[1]}"
            try:
                deadline = time.monotonic() + 2
                status = {}
                while time.monotonic() < deadline:
                    with urllib.request.urlopen(f"{base_url}/api/startup-status", timeout=2) as response:
                        status = json.loads(response.read())
                    if status["status"] == "error":
                        break
                    time.sleep(0.02)
                self.assertEqual(status["status"], "error")
                self.assertIn("测试工程无法读取", status["error"])
                with urllib.request.urlopen(base_url, timeout=2) as response:
                    self.assertEqual(response.status, 200)
            finally:
                server.shutdown()
                thread.join(timeout=2)

    def test_range_parser_handles_standard_and_suffix_ranges(self) -> None:
        self.assertEqual(server_editor.parse_byte_range("bytes=2-5", 10), (2, 5))
        self.assertEqual(server_editor.parse_byte_range("bytes=7-", 10), (7, 9))
        self.assertEqual(server_editor.parse_byte_range("bytes=-3", 10), (7, 9))
        with self.assertRaises(ValueError):
            server_editor.parse_byte_range("bytes=10-", 10)

    def test_media_send_ignores_browser_cancelled_connections(self) -> None:
        for disconnect in (BrokenPipeError(), ConnectionResetError(10054, "connection reset")):
            with self.subTest(disconnect=type(disconnect).__name__):
                handler = mock.Mock()
                handler.headers = {}
                handler.wfile.write.side_effect = disconnect
                server_editor.EditorRequestHandler.send_file(handler, self.media, True)
                handler.wfile.write.assert_called_once()

    def test_request_handler_ignores_client_disconnect_while_reading(self) -> None:
        handler = object.__new__(server_editor.EditorRequestHandler)
        with mock.patch.object(
            server_editor.BaseHTTPRequestHandler,
            "handle",
            side_effect=ConnectionAbortedError(10053, "client aborted"),
        ):
            handler.handle()

    def test_media_less_projects_reopen_bound_without_media_work(self) -> None:
        for project_data in (
            {"media": "", "segments": []},
            {
                "segments": [
                    {"start": 0, "end": 1000, "text": "仅字幕工程"},
                ],
            },
        ):
            with self.subTest(project_data=project_data):
                project_path = self.root / "subtitles-only.mosp"
                project_path.write_text(json.dumps(project_data), encoding="utf-8")
                with (
                    mock.patch.object(server_editor, "resolve_project_media") as resolve_media,
                    mock.patch.object(server_editor.edit, "load_or_extract_waveform") as load_waveform,
                    mock.patch.object(server_editor.quapeaks, "load_spectral_payload") as load_spectral,
                    mock.patch.object(server_editor.quapeaks, "load_waveform_payload") as load_quapeaks_waveform,
                ):
                    project = server_editor.load_project(
                        project_path,
                        None,
                        str(self.stickers),
                        no_waveform=False,
                        peaks_per_second=100,
                    )

                resolve_media.assert_not_called()
                load_waveform.assert_not_called()
                load_spectral.assert_not_called()
                load_quapeaks_waveform.assert_not_called()
                self.assertEqual(project.json_path, project_path)
                self.assertIsNone(project.media_path)
                self.assertIsNone(project.source_media_path)
                self.assertIsNone(project.reapeaks_path)
                self.assertIn('"canSave": true', server_editor.build_server_page(project).decode("utf-8"))

    def test_bound_media_less_page_displays_project_name(self) -> None:
        project_path = self.root / "subtitles-only.mosp"
        project_path.write_text(
            json.dumps({"media": "", "segments": [{"start": 0, "end": 1000, "text": "仅字幕工程"}]}),
            encoding="utf-8",
        )
        project = server_editor.load_project(
            project_path,
            None,
            str(self.stickers),
            no_waveform=True,
            peaks_per_second=100,
        )

        page = server_editor.build_server_page(project).decode("utf-8")

        self.assertIn('"subtitles-only"', page)
        self.assertNotIn('__FILENAME_BASE_JSON__', page)
        self.assertIn('id="json-name" title="点击复制工程文件名">subtitles-only.mosp</span>', page)
        self.assertNotIn('class="json-name empty"', page)
        self.assertIn('id="media-name" title="">未导入媒体</span>', page)
        self.assertIn('"canSave": true', page)

    def test_startup_page_shows_project_loading_overlay_before_javascript_runs(self) -> None:
        project = server_editor.ServerProject(
            data={"segments": []},
            json_path=self.root / "loading.mosp",
            media_path=None,
            sticker_root=None,
            stickers=[],
        )

        loading = server_editor.build_server_page(
            project,
            startup_status={
                "status": "loading",
                "stage": "reading_project",
                "progress": 5,
                "error": "",
            },
        ).decode("utf-8")
        ready = server_editor.build_server_page(project).decode("utf-8")

        self.assertIn('id="editor-loading" aria-live="polite"', loading)
        self.assertIn('id="editor-loading-label">正在加载工程…</div>', loading)
        self.assertIn('id="editor-loading" hidden aria-live="polite"', ready)

    def test_build_server_page_defers_reapeaks_layers_to_waveform_endpoint(self) -> None:
        """延迟加载开启时页面不内联频谱 / reapeaks 层；关闭时（--no-waveform）仍保留内联。"""
        project = server_editor.ServerProject(
            data={
                "segments": [],
                "spectral": {"marker": "spectral-layer-payload"},
                "waveform_reapeaks": {"marker": "reapeaks-wave-layer-payload"},
                "loudness": {"marker": "loudness-layer-payload"},
            },
            json_path=self.root / "layered.mosp",
            media_path=None,
            sticker_root=None,
            stickers=[],
        )

        deferred = server_editor.build_server_page(project).decode("utf-8")
        self.assertNotIn("spectral-layer-payload", deferred)
        self.assertNotIn("reapeaks-wave-layer-payload", deferred)
        self.assertNotIn("loudness-layer-payload", deferred)

        inlined = server_editor.build_server_page(project, defer_reapeaks=False).decode("utf-8")
        self.assertIn("spectral-layer-payload", inlined)
        self.assertIn("reapeaks-wave-layer-payload", inlined)
        self.assertIn("loudness-layer-payload", inlined)

    def test_media_less_project_loads_without_a_sticker_directory(self) -> None:
        project_path = self.root / "no-stickers.mosp"
        project_path.write_text(
            json.dumps({"media": "", "segments": []}),
            encoding="utf-8",
        )

        with mock.patch.object(server_editor.edit, "get_default_sticker_dir", return_value=None):
            project = server_editor.load_project(
                project_path,
                None,
                None,
                no_waveform=True,
                peaks_per_second=100,
            )

        self.assertEqual(project.json_path, project_path)
        self.assertIsNone(project.media_path)
        self.assertIsNone(project.sticker_root)
        self.assertEqual(project.stickers, [])

    def test_nonempty_missing_media_is_still_rejected(self) -> None:
        project_path = self.root / "missing-media.mosp"
        project_path.write_text(
            json.dumps({"media": "missing.mp3", "segments": []}),
            encoding="utf-8",
        )

        with self.assertRaises(server_editor.MediaResolutionError):
            server_editor.load_project(
                project_path,
                None,
                str(self.stickers),
                no_waveform=True,
                peaks_per_second=100,
            )

    def test_relative_media_reference_survives_loading_for_future_saves(self) -> None:
        bundle = self.root / "成片"
        bundle.mkdir()
        media = bundle / "处理后.mp4"
        media.write_bytes(b"media")
        project_path = bundle / "处理后.mosp"
        project_path.write_text(
            json.dumps({"media": media.name, "segments": []}, ensure_ascii=False),
            encoding="utf-8",
        )

        project = server_editor.load_project(
            project_path,
            None,
            str(self.stickers),
            no_waveform=True,
            peaks_per_second=100,
        )

        self.assertEqual(project.media_path, media.resolve())
        self.assertEqual(project.data["media"], media.name)

    def test_local_name_fallback_repairs_a_stale_relative_reference(self) -> None:
        media = self.root / "新名字.mp4"
        media.write_bytes(b"media")
        project_path = self.root / "新名字.mosp"
        project_path.write_text(
            json.dumps({"media": "旧名字.mp4", "segments": []}, ensure_ascii=False),
            encoding="utf-8",
        )

        project = server_editor.load_project(
            project_path,
            None,
            str(self.stickers),
            no_waveform=True,
            peaks_per_second=100,
        )

        self.assertEqual(project.media_path, media.resolve())
        self.assertEqual(project.data["media"], media.name)

    def test_project_sticker_root_wins_over_launcher_root(self) -> None:
        project_root = self.root / "project-stickers"
        project_root.mkdir()
        (project_root / "project.png").write_bytes(b"project")
        project_path = self.root / "persisted.json"
        project_path.write_text(json.dumps({
            "media": str(self.media), "sticker_root": str(project_root), "segments": [],
        }), encoding="utf-8")

        project = server_editor.load_project(
            project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )

        self.assertEqual(project.sticker_root, project_root.resolve())
        self.assertEqual([sticker["rel"] for sticker in project.stickers], ["project.png"])

    def test_invalid_project_sticker_root_falls_back_to_launcher_root(self) -> None:
        project_path = self.root / "invalid-persisted.json"
        project_path.write_text(json.dumps({
            "media": str(self.media), "sticker_root": str(self.root / "missing-stickers"), "segments": [],
        }), encoding="utf-8")

        project = server_editor.load_project(
            project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )

        self.assertEqual(project.sticker_root, self.stickers.resolve())
        self.assertEqual([sticker["rel"] for sticker in project.stickers], ["nested/cat.png"])

    def test_unknown_resource_keeps_localized_detail_with_ascii_http_reason(self) -> None:
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        with server_editor.EditorServer(("127.0.0.1", 0), project) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                base_url = f"http://127.0.0.1:{server.server_address[1]}"
                with self.assertRaises(urllib.error.HTTPError) as context:
                    urllib.request.urlopen(f"{base_url}/.well-known/appspecific/com.chrome.devtools.json")
                error = context.exception
                self.assertEqual(error.code, 404)
                self.assertEqual(error.reason, "Not Found")
                self.assertIn("未知资源", error.read().decode("utf-8"))
            finally:
                server.shutdown()
                thread.join(timeout=2)

    def test_shutdown_endpoint_stops_the_loopback_server(self) -> None:
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        with server_editor.EditorServer(("127.0.0.1", 0), project) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base_url = f"http://127.0.0.1:{server.server_address[1]}"
            request = urllib.request.Request(
                f"{base_url}/api/shutdown",
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(request) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(json.loads(response.read()), {"ok": True, "service": "maw-editor"})
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive())

    def test_prproj_capability_endpoint_is_stable_and_loopback_only(self) -> None:
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        with server_editor.EditorServer(("127.0.0.1", 0), project) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                self.assertEqual(server.server_address[0], "127.0.0.1")
                base_url = f"http://127.0.0.1:{server.server_address[1]}"
                with urllib.request.urlopen(f"{base_url}/api/prproj-capability") as response:
                    self.assertEqual(response.status, 200)
                    self.assertEqual(response.headers["Content-Type"], "application/json; charset=utf-8")
                    self.assertEqual(int(response.headers["Content-Length"]), len(response.read()))
                with urllib.request.urlopen(f"{base_url}/api/prproj-capability") as response:
                    self.assertEqual(json.loads(response.read()), server_editor.PRPROJ_CAPABILITY)
            finally:
                server.shutdown()
                thread.join(timeout=2)

    def test_prproj_generation_route_refuses_without_writing(self) -> None:
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        output_path = self.root / "attempted.prproj"
        with server_editor.EditorServer(("127.0.0.1", 0), project) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                base_url = f"http://127.0.0.1:{server.server_address[1]}"
                request = urllib.request.Request(
                    f"{base_url}/api/prproj",
                    data=json.dumps({"output": str(output_path)}).encode("utf-8"),
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with self.assertRaises(urllib.error.HTTPError) as context:
                    urllib.request.urlopen(request)
                error = context.exception
                self.assertEqual(error.code, 501)
                self.assertEqual(json.loads(error.read()), server_editor.PRPROJ_CAPABILITY)
                self.assertFalse(output_path.exists())
            finally:
                server.shutdown()
                thread.join(timeout=2)

    def test_server_page_uses_shared_template_and_routes_stickers(self) -> None:
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        settings = server_editor.remember_project(server_editor.ServerSettings(), self.project_path)
        page = server_editor.build_server_page(project, settings).decode("utf-8")
        self.assertIn('src="/media"', page)
        self.assertIn('"/stickers"', page)
        self.assertIn('"/sfx/"', page)
        self.assertIn('{"saveUrl": "/api/project", ', page)
        for token in ('__STICKER_URL_PREFIX_JSON__', '__NINJA_SFX_BASE_URL_JSON__', '__SERVER_CONFIG_JSON__'):
            self.assertNotIn(token, page)
        self.assertNotIn('createUrl', page)
        self.assertIn('"requestToken": "", "stickerRootUrl": "/api/stickers/root", ', page)
        self.assertIn('"portableStickerExportUrl": "/api/exports/sticker-otio", ', page)
        self.assertIn('"otiozStickerExportUrl": "/api/exports/sticker-otioz", ', page)
        self.assertIn('"gapRemovedVideoExportUrl": "/api/exports/gap-removed-video", "gapRemovedVideoSourceName": "clip.mp3", "canGapRemovedVideoExport": false, ', page)
        self.assertIn('"canPortableStickerExport": true, "canOtozStickerExport": true, ', page)
        self.assertIn('"canOtozTimelineExport": true, "initialStickerCount": 1, ', page)
        self.assertIn('"autoLoadedMediaName": "clip.mp3", "recentProjectsUrl": "/api/recent-projects/open", ', page)
        self.assertIn('"attachUrl": "/api/project/attach", "settingsUrl": "/api/settings", ', page)
        self.assertIn('"settingsUrl": "/api/settings", "recentProjects": [{"path": "', page)
        self.assertIn('"name": "clip.json"}], "assStylesUrl": "/api/ass-styles", "assFrameUrl": "/api/ass-frame", "autoOpenLastProject": true, "savedWorkspaces": {}, ', page)
        self.assertIn('"presetWorkspaces": {}, ', page)
        self.assertIn('"activeWorkspaceName": "", "onboardingStatus": ""}', page)
        completed_page = server_editor.build_server_page(
            project,
            server_editor.replace(settings, onboarding_status="completed"),
        ).decode("utf-8")
        self.assertIn('"onboardingStatus": "completed"', completed_page)
        self.assertIn('id="save-project"', page)
        self.assertIn('id="save-project-as"', page)
        self.assertIn('id="save-project-dropdown"', page)
        self.assertIn('id="open-project-dropdown"', page)
        self.assertIn('id="load-srt"', page)
        self.assertIn('id="load-srt-file"', page)
        self.assertIn('id="download-gap-removed-video"', page)
        source = "\n\n".join(server_editor.edit.read_web_asset(name) for name in server_editor.edit.read_editor_script_manifest())
        self.assertIn('function parseSrtSegments(text)', source)
        self.assertIn('function isMawProject(data)', source)
        self.assertIn('请使用 MAW 生成的工程文件', page)

        video = self.root / "source.mkv"
        video.write_bytes(b"video")
        video_page = server_editor.build_server_page(
            server_editor.replace(project, media_path=video, source_media_path=video), settings,
        ).decode("utf-8")
        self.assertIn('"gapRemovedVideoSourceName": "source.mkv", "canGapRemovedVideoExport": true, ', video_page)

        self.assertIn('id="server-auto-save-settings"', page)
        self.assertIn('id="auto-save-project"', page)
        self.assertIn('id="auto-save-project" checked', page)
        self.assertIn('id="auto-save-interval"', page)
        self.assertIn('id="project-backup-enabled"', page)
        self.assertIn('id="project-backup-enabled" checked', page)
        self.assertIn('> 自动备份</label>', page)
        self.assertLess(page.index('id="editor-settings-page-export"'), page.index('id="server-auto-save-settings"'))
        self.assertLess(page.index('id="server-auto-save-settings"'), page.index('id="project-backup-settings"'))
        self.assertIn('function scheduleAutoSave()', source)
        self.assertIn('hasUnsavedProjectChanges() && !projectSaveInFlight', source)
        self.assertIn('id="recent-projects"', page)
        self.assertIn('id="auto-open-last-project"', page)
        self.assertLess(page.index('id="auto-open-last-project"'), page.index('id="recent-projects-list"'))
        self.assertIn("const STORAGE_KEY = 'mawe.language';", source)
        self.assertIn('class="waveform-mode-switch"', page)
        self.assertIn('data-saved-workspaces', page)
        self.assertIn('id="workspace-save-as"', page)
        self.assertIn('function configureServerWorkspaceLibrary()', source)

        with server_editor.EditorServer(("127.0.0.1", 0), project) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                base_url = f"http://127.0.0.1:{server.server_address[1]}"
                request = urllib.request.Request(f"{base_url}/media", headers={"Range": "bytes=2-5"})
                with urllib.request.urlopen(request) as response:
                    self.assertEqual(response.status, 206)
                    self.assertEqual(response.headers["Content-Range"], "bytes 2-5/10")
                    self.assertEqual(response.read(), b"2345")
                with urllib.request.urlopen(f"{base_url}/stickers/nested/cat.png") as response:
                    self.assertEqual(response.read(), b"png")
            finally:
                server.shutdown()
                thread.join(timeout=2)

    def test_sticker_root_endpoint_validates_token_and_preserves_state_on_failure(self) -> None:
        project = server_editor.load_blank_project(str(self.stickers))
        alternate = self.root / "alternate-stickers"
        alternate.mkdir()
        (alternate / "new.png").write_bytes(b"new")
        with server_editor.EditorServer(("127.0.0.1", 0), project) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                base_url = f"http://127.0.0.1:{server.server_address[1]}"

                def post(payload: dict) -> tuple[int, dict]:
                    request = urllib.request.Request(
                        f"{base_url}/api/stickers/root",
                        data=json.dumps(payload).encode(),
                        headers={"Content-Type": "application/json"}, method="POST",
                    )
                    try:
                        with urllib.request.urlopen(request) as response:
                            return response.status, json.loads(response.read())
                    except urllib.error.HTTPError as error:
                        return error.code, json.loads(error.read())

                original_root = server.project.sticker_root
                status, result = post({"requestToken": "wrong", "path": str(alternate)})
                self.assertEqual(status, 403)
                self.assertFalse(result["ok"])
                self.assertEqual(server.project.sticker_root, original_root)
                status, result = post({"requestToken": server.request_token, "path": str(alternate), "activate": False})
                self.assertEqual(status, 200)
                self.assertEqual(result["count"], 1)
                self.assertEqual(server.project.sticker_root, original_root)
                status, result = post({"requestToken": server.request_token, "path": str(alternate), "activate": "false"})
                self.assertEqual(status, 400)
                self.assertEqual(server.project.sticker_root, original_root)
                status, result = post({"requestToken": server.request_token, "path": str(self.root / "missing")})
                self.assertEqual(status, 400)
                self.assertFalse(result["ok"])
                self.assertEqual(server.project.sticker_root, original_root)
                status, result = post({"requestToken": server.request_token, "path": str(alternate)})
                self.assertEqual(status, 200)
                self.assertEqual(result["root"], alternate.as_posix())
                self.assertEqual(result["count"], 1)
                self.assertEqual(result["stickers"][0]["rel"], "new.png")
                status, result = post({"requestToken": server.request_token, "path": ""})
                self.assertEqual(status, 200)
                self.assertEqual(result["root"], "")
                self.assertEqual(result["stickers"], [])
                self.assertIsNone(server.project.sticker_root)
            finally:
                server.shutdown()
                thread.join(timeout=2)

    def test_sticker_otio_export_copies_used_stickers_portably(self) -> None:
        first = self.stickers / "a" / "x.png"
        second = self.stickers / "b" / "X.png"
        first.parent.mkdir()
        second.parent.mkdir()
        first.write_bytes(b"first")
        second.write_bytes(b"second")
        timeline = {
            "OTIO_SCHEMA": "Timeline.1",
            "name": "source",
            "metadata": {},
            "tracks": {"children": [{"children": [
                {"OTIO_SCHEMA": "Gap.1"},
                {"OTIO_SCHEMA": "Clip.2", "metadata": {"moy": {"sticker_rel": "a/x.png"}},
                 "media_references": {"DEFAULT_MEDIA": {"target_url": "old-a"}}},
                {"OTIO_SCHEMA": "Clip.2", "metadata": {"moy": {"sticker_rel": "a/x.png"}},
                 "media_references": {"DEFAULT_MEDIA": {"target_url": "old-a-2"}}},
                {"OTIO_SCHEMA": "Clip.2", "metadata": {"moy": {"sticker_rel": "b/X.png"}},
                 "media_references": {"DEFAULT_MEDIA": {"target_url": "old-b"}},
                 "source_media": "file:///do-not-copy.mp4"},
            ]}]},
        }
        with server_editor.EditorServer(("127.0.0.1", 0), server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                base_url = f"http://127.0.0.1:{server.server_address[1]}"
                def post(payload: dict) -> tuple[int, dict]:
                    request = urllib.request.Request(
                        f"{base_url}/api/exports/sticker-otio",
                        data=json.dumps(payload).encode(),
                        headers={"Content-Type": "application/json"}, method="POST",
                    )
                    try:
                        with urllib.request.urlopen(request) as response:
                            return response.status, json.loads(response.read())
                    except urllib.error.HTTPError as error:
                        return error.code, json.loads(error.read())

                server.set_sticker_root(str(self.stickers))
                status, result = post({"requestToken": server.request_token, "kind": "stickers", "timeline": timeline})
                self.assertEqual(status, 200)
                package = self.root / result["folderName"]
                self.assertEqual(package.parent, self.project_path.parent)
                self.assertEqual(result["folderPath"], str(package.resolve()))
                self.assertEqual(result["otioName"], "clip_stickers.otio")
                self.assertEqual(result["stickerCount"], 2)
                self.assertFalse((package / "do-not-copy.mp4").exists())
                copied = sorted((package / "stickers").iterdir())
                self.assertEqual({item.name for item in copied}, {"x.png", "X-2.png"})
                exported = json.loads((package / result["otioName"]).read_text(encoding="utf-8"))
                clips = exported["tracks"]["children"][0]["children"]
                urls = [clip["media_references"]["DEFAULT_MEDIA"]["target_url"] for clip in clips if "media_references" in clip]
                self.assertEqual(urls, ["stickers/x.png", "stickers/x.png", "stickers/X-2.png"])
                self.assertNotIn(b"\r\n", (package / result["otioName"]).read_bytes())
                occupied = package
                occupied.mkdir(exist_ok=True)
                status, result = post({"requestToken": server.request_token, "kind": "stickers", "timeline": timeline})
                self.assertEqual(status, 200)
                self.assertTrue(result["folderName"].endswith("-2"))
            finally:
                server.shutdown()
                thread.join(timeout=2)

    def test_sticker_otio_export_rejects_malicious_relative_path(self) -> None:
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        timeline = {"OTIO_SCHEMA": "Timeline.1", "tracks": {"children": [{"children": [
            {"metadata": {"moy": {"sticker_rel": "../clip.mp3"}}, "media_references": {"DEFAULT_MEDIA": {"target_url": "x"}}},
        ]}]}}
        with server_editor.EditorServer(("127.0.0.1", 0), project) as server:
            server.set_sticker_root(str(self.stickers))
            with self.assertRaises(ValueError):
                server_editor.export_sticker_otio(server.project, "stickers", timeline, self.stickers)

    def test_sticker_otio_export_requires_sticker_rel_on_each_clip(self) -> None:
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        server = server_editor.EditorServer(("127.0.0.1", 0), project)
        try:
            server.set_sticker_root(str(self.stickers))
            timeline = {"OTIO_SCHEMA": "Timeline.1", "tracks": {"children": [{"children": [
                {"OTIO_SCHEMA": "Clip.2", "metadata": {}, "media_references": {"DEFAULT_MEDIA": {"target_url": "x"}}},
            ]}]}}
            with self.assertRaises(ValueError):
                server_editor.export_sticker_otio(server.project, "stickers", timeline, self.stickers)
        finally:
            server.server_close()

    def test_sticker_otio_export_uri_encodes_filename_but_copies_raw_name(self) -> None:
        filename = "face #%.png"
        source = self.stickers / filename
        source.write_bytes(b"special")
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        server = server_editor.EditorServer(("127.0.0.1", 0), project)
        try:
            server.set_sticker_root(str(self.stickers))
            timeline = {"OTIO_SCHEMA": "Timeline.1", "tracks": {"children": [{"children": [
                {"OTIO_SCHEMA": "Clip.2", "metadata": {"moy": {"sticker_rel": filename}},
                 "media_references": {"DEFAULT_MEDIA": {"target_url": "old"}}},
            ]}]}}
            package, otio_name, count = server_editor.export_sticker_otio(
                server.project, "stickers", timeline, self.stickers,
            )
            self.assertEqual(count, 1)
            self.assertTrue((package / "stickers" / filename).is_file())
            exported = json.loads((package / otio_name).read_text(encoding="utf-8"))
            target = exported["tracks"]["children"][0]["children"][0]["media_references"]["DEFAULT_MEDIA"]["target_url"]
            self.assertEqual(target, "stickers/face%20%23%25.png")
        finally:
            server.server_close()

    def _sticker_otioz_serve(self) -> tuple[server_editor.EditorServer, threading.Thread, str]:
        server = server_editor.EditorServer(("127.0.0.1", 0), server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        ))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base_url = f"http://127.0.0.1:{server.server_address[1]}"
        return server, thread, base_url

    def _post_sticker_otioz(
        self, base_url: str, server: server_editor.EditorServer, timeline: dict, *, kind: str = "stickers",
    ) -> tuple[int, object, bytes]:
        request = urllib.request.Request(
            f"{base_url}/api/exports/sticker-otioz",
            data=json.dumps({"requestToken": server.request_token, "kind": kind, "timeline": timeline}).encode(),
            headers={"Content-Type": "application/json"}, method="POST",
        )
        try:
            with urllib.request.urlopen(request) as response:
                return response.status, dict(response.headers), response.read()
        except urllib.error.HTTPError as error:
            return error.code, dict(error.headers), error.read()

    def _post_timeline_otioz(
        self, base_url: str, server: server_editor.EditorServer, timeline: dict, *, kind: str = "gap-removed",
    ) -> tuple[int, object, bytes]:
        request = urllib.request.Request(
            f"{base_url}/api/exports/timeline-otioz",
            data=json.dumps({"requestToken": server.request_token, "kind": kind, "timeline": timeline}).encode(),
            headers={"Content-Type": "application/json"}, method="POST",
        )
        try:
            with urllib.request.urlopen(request) as response:
                return response.status, dict(response.headers), response.read()
        except urllib.error.HTTPError as error:
            return error.code, dict(error.headers), error.read()

    def test_timeline_otioz_export_packages_bound_media_and_rewrites_client_paths(self) -> None:
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        timeline = {
            "OTIO_SCHEMA": "Timeline.1",
            "tracks": {"children": [{"children": [{
                "OTIO_SCHEMA": "Clip.2",
                "source_range": {"OTIO_SCHEMA": "TimeRange.1"},
                "media_references": {
                    "DEFAULT_MEDIA": {
                        "OTIO_SCHEMA": "ExternalReference.1",
                        "target_url": "file:///outside/should-not-be-read.mp4",
                    },
                },
            }]}]},
        }
        source_before = json.dumps(timeline, sort_keys=True)
        zip_bytes, otio_name = server_editor.export_timeline_otioz(project, "gap-removed", timeline)
        self.assertEqual(otio_name, "clip_gap-removed.otio")
        self.assertEqual(json.dumps(timeline, sort_keys=True), source_before)
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as archive:
            self.assertEqual(
                set(archive.namelist()),
                {"content.otio", "version.txt", "media/clip.mp3"},
            )
            self.assertEqual(archive.read("media/clip.mp3"), b"0123456789")
            exported = json.loads(archive.read("content.otio").decode("utf-8"))
        target = exported["tracks"]["children"][0]["children"][0]["media_references"]["DEFAULT_MEDIA"]["target_url"]
        self.assertEqual(target, "media/clip.mp3")

    def test_timeline_otioz_export_supports_source_mode_without_gap_suffix(self) -> None:
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        timeline = {
            "OTIO_SCHEMA": "Timeline.1",
            "tracks": {"children": [{"children": [{
                "OTIO_SCHEMA": "Clip.2",
                "media_references": {
                    "DEFAULT_MEDIA": {
                        "OTIO_SCHEMA": "ExternalReference.1",
                        "target_url": "file:///client/source.mp4",
                    },
                },
            }]}]},
        }
        zip_bytes, otio_name = server_editor.export_timeline_otioz(project, "source", timeline)
        self.assertEqual(otio_name, "clip.otio")
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as archive:
            self.assertEqual(
                set(archive.namelist()),
                {"content.otio", "version.txt", "media/clip.mp3"},
            )
            exported = json.loads(archive.read("content.otio").decode("utf-8"))
        target = exported["tracks"]["children"][0]["children"][0]["media_references"]["DEFAULT_MEDIA"]["target_url"]
        self.assertEqual(target, "media/clip.mp3")

    def test_timeline_otioz_export_preserves_non_ascii_media_name(self) -> None:
        source = self.root / "中文 音频#.wav"
        source.write_bytes(b"unicode-media")
        project_path = self.root / "中文工程.json"
        project_path.write_text(
            json.dumps({"media": str(source), "segments": []}), encoding="utf-8",
        )
        project = server_editor.load_project(
            project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        timeline = {
            "OTIO_SCHEMA": "Timeline.1",
            "tracks": {"children": [{"children": [{
                "OTIO_SCHEMA": "Clip.2",
                "media_references": {
                    "DEFAULT_MEDIA": {
                        "OTIO_SCHEMA": "ExternalReference.1",
                        "target_url": "file:///outside/client-media.wav",
                    },
                },
            }]}]},
        }
        zip_bytes, otio_name = server_editor.export_timeline_otioz(project, "gap-removed", timeline)
        self.assertEqual(otio_name, "中文工程_gap-removed.otio")
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as archive:
            self.assertEqual(
                set(archive.namelist()),
                {"content.otio", "version.txt", "media/中文 音频#.wav"},
            )
            self.assertEqual(archive.read("media/中文 音频#.wav"), b"unicode-media")
            exported = json.loads(archive.read("content.otio").decode("utf-8"))
        target = exported["tracks"]["children"][0]["children"][0]["media_references"]["DEFAULT_MEDIA"]["target_url"]
        self.assertEqual(target, "media/中文 音频#.wav")

    def test_timeline_otioz_export_rejects_multiple_media_references(self) -> None:
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        timeline = {"OTIO_SCHEMA": "Timeline.1", "tracks": {"children": [{"children": [
            {"OTIO_SCHEMA": "Clip.2", "media_references": {
                "DEFAULT_MEDIA": {"OTIO_SCHEMA": "ExternalReference.1", "target_url": self.media.as_uri()},
            }},
            {"OTIO_SCHEMA": "Clip.2", "media_references": {
                "DEFAULT_MEDIA": {"OTIO_SCHEMA": "ExternalReference.1", "target_url": self.other_media.as_uri()},
            }},
        ]}]}}
        with self.assertRaisesRegex(ValueError, "只绑定一个源媒体"):
            server_editor.export_timeline_otioz(project, "source", timeline)

    def test_timeline_otioz_export_packages_merged_sticker_track(self) -> None:
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        timeline = {
            "OTIO_SCHEMA": "Timeline.1",
            "tracks": {"children": [
                {"children": [{
                    "OTIO_SCHEMA": "Clip.2",
                    "media_references": {
                        "DEFAULT_MEDIA": {
                            "OTIO_SCHEMA": "ExternalReference.1",
                            "target_url": "file:///outside/should-not-be-read.mp4",
                        },
                    },
                }]},
                {"children": [{
                    "OTIO_SCHEMA": "Clip.2",
                    "metadata": {"moy": {"sticker_rel": "nested/cat.png"}},
                    "media_references": {
                        "DEFAULT_MEDIA": {
                            "OTIO_SCHEMA": "ExternalReference.1",
                            "target_url": "file:///outside/should-not-be-read.png",
                        },
                    },
                }]},
            ]},
        }
        zip_bytes, otio_name = server_editor.export_timeline_otioz(
            project, "source", timeline, project.sticker_root,
        )
        self.assertEqual(otio_name, "clip.otio")
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as archive:
            self.assertEqual(
                set(archive.namelist()),
                {"content.otio", "version.txt", "media/clip.mp3", "media/cat.png"},
            )
            self.assertEqual(archive.read("media/clip.mp3"), b"0123456789")
            self.assertEqual(archive.read("media/cat.png"), b"png")
            exported = json.loads(archive.read("content.otio").decode("utf-8"))
        tracks = exported["tracks"]["children"]
        media_target = tracks[0]["children"][0]["media_references"]["DEFAULT_MEDIA"]["target_url"]
        self.assertEqual(media_target, "media/clip.mp3")
        sticker_reference = tracks[1]["children"][0]["media_references"]["DEFAULT_MEDIA"]
        self.assertEqual(sticker_reference["target_url"], "media/cat.png")
        self.assertEqual(
            sticker_reference["available_range"]["duration"],
            {"OTIO_SCHEMA": "RationalTime.1", "rate": 60, "value": 1.0},
        )

    def test_timeline_otioz_export_requires_sticker_root_for_merged_stickers(self) -> None:
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        timeline = {"OTIO_SCHEMA": "Timeline.1", "tracks": {"children": [{"children": [
            {"OTIO_SCHEMA": "Clip.2", "metadata": {"moy": {"sticker_rel": "nested/cat.png"}},
             "media_references": {"DEFAULT_MEDIA": {"target_url": "old"}}},
        ]}]}}
        with self.assertRaisesRegex(ValueError, "尚未验证表情包根目录"):
            server_editor.export_timeline_otioz(project, "source", timeline, None)

    def test_timeline_otioz_endpoint_requires_token_and_returns_zip(self) -> None:
        server, thread, base_url = self._sticker_otioz_serve()
        timeline = {
            "OTIO_SCHEMA": "Timeline.1",
            "tracks": {"children": [{"children": [{
                "OTIO_SCHEMA": "Clip.2",
                "media_references": {
                    "DEFAULT_MEDIA": {
                        "OTIO_SCHEMA": "ExternalReference.1",
                        "target_url": "file:///client/path.mp4",
                    },
                },
            }]}]},
        }
        try:
            request = urllib.request.Request(
                f"{base_url}/api/exports/timeline-otioz",
                data=json.dumps({"requestToken": "wrong", "kind": "gap-removed", "timeline": timeline}).encode(),
                headers={"Content-Type": "application/json"}, method="POST",
            )
            with self.assertRaises(urllib.error.HTTPError) as context:
                urllib.request.urlopen(request)
            self.assertEqual(context.exception.code, 403)

            status, headers, body = self._post_timeline_otioz(base_url, server, timeline)
            self.assertEqual(status, 200)
            self.assertEqual(headers["Content-Type"], "application/zip")
            self.assertIn("clip_gap-removed.otioz", headers["Content-Disposition"])
            with zipfile.ZipFile(io.BytesIO(body)) as archive:
                self.assertIn("content.otio", archive.namelist())
                self.assertIn("media/clip.mp3", archive.namelist())

            status, headers, body = self._post_timeline_otioz(
                base_url, server, timeline, kind="source",
            )
            self.assertEqual(status, 200)
            self.assertIn("clip.otioz", headers["Content-Disposition"])
            with zipfile.ZipFile(io.BytesIO(body)) as archive:
                self.assertIn("content.otio", archive.namelist())
                self.assertIn("media/clip.mp3", archive.namelist())
        finally:
            server.shutdown()
            thread.join(timeout=2)
            server.server_close()

    def test_sticker_otioz_export_returns_zip_with_media_and_metadata(self) -> None:
        first = self.stickers / "a" / "x.png"
        first.parent.mkdir()
        first.write_bytes(b"first")
        timeline = {
            "OTIO_SCHEMA": "Timeline.1",
            "name": "source",
            "metadata": {},
            "tracks": {"children": [{"children": [
                {"OTIO_SCHEMA": "Gap.1"},
                {"OTIO_SCHEMA": "Clip.2", "metadata": {"moy": {"sticker_rel": "a/x.png"}},
                 "source_range": {"OTIO_SCHEMA": "TimeRange.1", "duration": {"rate": 25, "value": 10}, "start_time": {"rate": 25, "value": 0}},
                 "media_references": {"DEFAULT_MEDIA": {"OTIO_SCHEMA": "ExternalReference.1", "target_url": "old-a"}}},
                {"OTIO_SCHEMA": "Clip.2", "metadata": {"moy": {"sticker_rel": "a/x.png"}},
                 "media_references": {"DEFAULT_MEDIA": {"OTIO_SCHEMA": "ExternalReference.1", "target_url": "old-a-2"}}},
                {"OTIO_SCHEMA": "Clip.2", "metadata": {"moy": {"sticker_rel": "nested/cat.png"}},
                 "media_references": {"DEFAULT_MEDIA": {"OTIO_SCHEMA": "ExternalReference.1", "target_url": "old-b",
                                                         "available_range": {"OTIO_SCHEMA": "TimeRange.1", "duration": {"value": 5.0}, "start_time": {}}}}},
            ]}]},
        }
        server, thread, base_url = self._sticker_otioz_serve()
        try:
            server.set_sticker_root(str(self.stickers))
            status, headers, body = self._post_sticker_otioz(base_url, server, timeline)
            self.assertEqual(status, 200)
            self.assertEqual(headers["Content-Type"], "application/zip")
            self.assertEqual(headers["Content-Disposition"], 'attachment; filename="clip_stickers.otioz"')
        finally:
            server.shutdown()
            thread.join(timeout=2)
            server.server_close()
        with zipfile.ZipFile(io.BytesIO(body)) as archive:
            names = set(archive.namelist())
            self.assertIn("content.otio", names)
            self.assertIn("version.txt", names)
            self.assertIn("media/x.png", names)
            self.assertIn("media/cat.png", names)
            self.assertEqual(len([name for name in names if name.startswith("media/")]), 2)
            self.assertEqual(archive.read("version.txt").decode("utf-8"), "1.0.0")
            self.assertEqual(archive.read("media/x.png"), b"first")
            self.assertEqual(archive.read("media/cat.png"), b"png")
            exported = json.loads(archive.read("content.otio").decode("utf-8"))
        clips = [clip for clip in exported["tracks"]["children"][0]["children"] if "media_references" in clip]
        urls = [clip["media_references"]["DEFAULT_MEDIA"]["target_url"] for clip in clips]
        self.assertEqual(urls, ["media/x.png", "media/x.png", "media/cat.png"])
        first_ref = clips[0]["media_references"]["DEFAULT_MEDIA"]
        self.assertEqual(first_ref["available_range"]["OTIO_SCHEMA"], "TimeRange.1")
        self.assertEqual(first_ref["available_range"]["duration"]["value"], 1.0)
        self.assertEqual(first_ref["available_range"]["duration"]["rate"], 25)
        self.assertEqual(first_ref["available_range"]["start_time"]["value"], 0.0)
        second_ref = clips[1]["media_references"]["DEFAULT_MEDIA"]
        self.assertIn("available_range", second_ref)
        self.assertEqual(second_ref["available_range"]["duration"]["rate"], 60)
        third_ref = clips[2]["media_references"]["DEFAULT_MEDIA"]
        self.assertEqual(third_ref["available_range"]["duration"]["value"], 5.0)

    def test_sticker_otioz_export_preserves_non_ascii_filename(self) -> None:
        filename = "猫 表情#.png"
        source = self.stickers / filename
        source.write_bytes(b"unicode-sticker")
        timeline = {"OTIO_SCHEMA": "Timeline.1", "tracks": {"children": [{"children": [
            {"OTIO_SCHEMA": "Clip.2", "metadata": {"moy": {"sticker_rel": filename}},
             "media_references": {"DEFAULT_MEDIA": {"target_url": "old"}}},
        ]}]}}
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        zip_bytes, otio_name, count = server_editor.export_sticker_otioz(
            project, "stickers", timeline, self.stickers,
        )
        self.assertEqual(otio_name, "clip_stickers.otio")
        self.assertEqual(count, 1)
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as archive:
            self.assertEqual(
                set(archive.namelist()),
                {"content.otio", "version.txt", "media/猫 表情#.png"},
            )
            self.assertEqual(archive.read("media/猫 表情#.png"), b"unicode-sticker")
            exported = json.loads(archive.read("content.otio").decode("utf-8"))
        target = exported["tracks"]["children"][0]["children"][0]["media_references"]["DEFAULT_MEDIA"]["target_url"]
        self.assertEqual(target, "media/猫 表情#.png")

    def test_sticker_otioz_export_dedupes_same_named_stickers(self) -> None:
        first = self.stickers / "a" / "x.png"
        second = self.stickers / "b" / "x.png"
        first.parent.mkdir()
        second.parent.mkdir()
        first.write_bytes(b"first")
        second.write_bytes(b"second")
        timeline = {"OTIO_SCHEMA": "Timeline.1", "tracks": {"children": [{"children": [
            {"OTIO_SCHEMA": "Clip.2", "metadata": {"moy": {"sticker_rel": "a/x.png"}},
             "media_references": {"DEFAULT_MEDIA": {"target_url": "old-a"}}},
            {"OTIO_SCHEMA": "Clip.2", "metadata": {"moy": {"sticker_rel": "b/x.png"}},
             "media_references": {"DEFAULT_MEDIA": {"target_url": "old-b"}}},
        ]}]}}
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        server = server_editor.EditorServer(("127.0.0.1", 0), project)
        try:
            server.set_sticker_root(str(self.stickers))
            zip_bytes, otio_name, count = server_editor.export_sticker_otioz(
                server.project, "stickers", timeline, self.stickers,
            )
            self.assertEqual(otio_name, "clip_stickers.otio")
            self.assertEqual(count, 2)
        finally:
            server.server_close()
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as archive:
            names = set(archive.namelist())
            self.assertIn("media/x.png", names)
            self.assertIn("media/x-2.png", names)
            self.assertEqual(archive.read("media/x.png"), b"first")
            self.assertEqual(archive.read("media/x-2.png"), b"second")
            exported = json.loads(archive.read("content.otio").decode("utf-8"))
        clips = [clip for clip in exported["tracks"]["children"][0]["children"] if "media_references" in clip]
        urls = [clip["media_references"]["DEFAULT_MEDIA"]["target_url"] for clip in clips]
        self.assertEqual(urls, ["media/x.png", "media/x-2.png"])

    def test_lottie_export_builds_dotlottie_v2_archive(self) -> None:
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        animation = {
            "v": "5.7.0", "fr": 30, "ip": 0, "op": 30,
            "w": 1920, "h": 1080, "assets": [], "layers": [],
        }
        archive_bytes, filename = server_editor.export_lottie(project, animation)
        self.assertEqual(filename, "clip_dynamic-caption.lottie")
        with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
            self.assertEqual(set(archive.namelist()), {"manifest.json", "a/maw-caption.json"})
            manifest = json.loads(archive.read("manifest.json").decode("utf-8"))
            self.assertEqual(manifest["version"], "2")
            self.assertEqual(manifest["initial"]["animation"], "maw-caption")
            self.assertEqual(manifest["animations"], [{"id": "maw-caption"}])
            self.assertEqual(json.loads(archive.read("a/maw-caption.json")), animation)

    def test_lottie_glyph_export_replaces_text_with_embedded_vector_shapes(self) -> None:
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        animation = {
            "v": "5.7.0", "fr": 30, "ip": 0, "op": 30,
            "w": 1920, "h": 1080, "assets": [],
            "fonts": {"list": [{"fName": "Microsoft YaHei", "fFamily": "Microsoft YaHei"}]},
            "layers": [{
                "ddd": 0, "ind": 1, "ty": 5, "nm": "测试字幕", "sr": 1,
                "ks": {
                    "o": {"a": 0, "k": 100}, "r": {"a": 0, "k": 0},
                    "p": {"a": 0, "k": [960, 540, 0]}, "a": {"a": 0, "k": [0, 0, 0]},
                    "s": {"a": 0, "k": [100, 100, 100]},
                },
                "ao": 0, "ip": 0, "op": 30, "st": 0, "bm": 0,
                "t": {"d": {"k": [{"s": {
                    "f": "Microsoft YaHei", "fc": [1, 1, 1], "s": 72,
                    "lh": 90, "t": "你好 Hello",
                }, "t": 0}]}, "a": []},
            }],
            "meta": {"renderMode": "glyph", "fontFamily": "Microsoft YaHei"},
        }
        archive_bytes, _ = server_editor.export_lottie(project, animation)
        with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
            exported = json.loads(archive.read("a/maw-caption.json"))
        self.assertEqual(exported["meta"]["renderMode"], "glyph")
        self.assertEqual(exported["fonts"]["list"], [])
        self.assertEqual(exported["layers"][0]["ty"], 4)
        self.assertTrue(exported["layers"][0]["shapes"])
        self.assertTrue(any(
            group.get("nm") == "你"
            for group in exported["layers"][0]["shapes"]
        ))
        first_fill = next(item for item in exported["layers"][0]["shapes"][0]["it"] if item.get("ty") == "fl")
        self.assertEqual(first_fill["c"]["k"][0]["s"], [1, 1, 1])
        self.assertNotIsInstance(first_fill["c"]["k"][0]["s"][0], list)

    def test_lottie_export_endpoint_requires_token_and_returns_dotlottie(self) -> None:
        server = server_editor.EditorServer(("127.0.0.1", 0), server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        ))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base_url = f"http://127.0.0.1:{server.server_address[1]}"
        animation = {
            "v": "5.7.0", "fr": 30, "ip": 0, "op": 30,
            "w": 1920, "h": 1080, "assets": [], "layers": [],
        }
        try:
            request = urllib.request.Request(
                f"{base_url}/api/exports/lottie",
                data=json.dumps({"requestToken": "wrong", "animation": animation}).encode(),
                headers={"Content-Type": "application/json"}, method="POST",
            )
            with self.assertRaises(urllib.error.HTTPError) as context:
                urllib.request.urlopen(request)
            self.assertEqual(context.exception.code, 403)

            request = urllib.request.Request(
                f"{base_url}/api/exports/lottie",
                data=json.dumps({"requestToken": server.request_token, "animation": animation}).encode(),
                headers={"Content-Type": "application/json"}, method="POST",
            )
            with urllib.request.urlopen(request) as response:
                body = response.read()
                self.assertEqual(response.status, 200)
                self.assertEqual(response.headers["Content-Type"], "application/zip+dotlottie")
                self.assertIn("dynamic-caption.lottie", response.headers["Content-Disposition"])
            with zipfile.ZipFile(io.BytesIO(body)) as archive:
                self.assertIn("manifest.json", archive.namelist())
        finally:
            server.shutdown()
            thread.join(timeout=2)
            server.server_close()

    def test_ograf_export_builds_manifest_and_web_component_archive(self) -> None:
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        graphic = {
            "manifestFilename": "maw-dynamic-captions.ograf.json",
            "mainFilename": "maw-dynamic-captions.mjs",
            "manifest": {
                "$schema": "https://ograf.ebu.io/v1/specification/json-schemas/graphics/schema.json",
                "id": "maw-dynamic-captions",
                "version": "1.0.0",
                "name": "MAW Dynamic Captions",
                "main": "maw-dynamic-captions.mjs",
                "schema": {"type": "object"},
                "supportsRealTime": True,
                "supportsNonRealTime": True,
            },
            "mainSource": (
                "class MawDynamicCaptions extends HTMLElement {"
                "async goToTime() {} async setActionsSchedule() {}"
                "} export default MawDynamicCaptions;"
            ),
        }
        archive_bytes, filename = server_editor.export_ograf(project, graphic)
        self.assertEqual(filename, "clip_dynamic-caption.ograf.zip")
        with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
            self.assertEqual(
                set(archive.namelist()),
                {"maw-dynamic-captions.ograf.json", "maw-dynamic-captions.mjs"},
            )
            manifest = json.loads(archive.read("maw-dynamic-captions.ograf.json"))
            self.assertEqual(manifest["$schema"], graphic["manifest"]["$schema"])
            self.assertEqual(manifest["main"], "maw-dynamic-captions.mjs")
            self.assertIn("extends HTMLElement", archive.read("maw-dynamic-captions.mjs").decode())

    def test_ograf_export_endpoint_requires_token_and_returns_zip(self) -> None:
        server = server_editor.EditorServer(("127.0.0.1", 0), server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        ))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base_url = f"http://127.0.0.1:{server.server_address[1]}"
        graphic = {
            "manifestFilename": "maw-dynamic-captions.ograf.json",
            "mainFilename": "maw-dynamic-captions.mjs",
            "manifest": {
                "$schema": "https://ograf.ebu.io/v1/specification/json-schemas/graphics/schema.json",
                "id": "maw-dynamic-captions",
                "name": "MAW Dynamic Captions",
                "main": "maw-dynamic-captions.mjs",
                "supportsRealTime": True,
                "supportsNonRealTime": True,
            },
            "mainSource": (
                "class MawDynamicCaptions extends HTMLElement {"
                "async goToTime() {} async setActionsSchedule() {}"
                "} export default MawDynamicCaptions;"
            ),
        }
        try:
            request = urllib.request.Request(
                f"{base_url}/api/exports/ograf",
                data=json.dumps({"requestToken": "wrong", "graphic": graphic}).encode(),
                headers={"Content-Type": "application/json"}, method="POST",
            )
            with self.assertRaises(urllib.error.HTTPError) as context:
                urllib.request.urlopen(request)
            self.assertEqual(context.exception.code, 403)

            request = urllib.request.Request(
                f"{base_url}/api/exports/ograf",
                data=json.dumps({"requestToken": server.request_token, "graphic": graphic}).encode(),
                headers={"Content-Type": "application/json"}, method="POST",
            )
            with urllib.request.urlopen(request) as response:
                body = response.read()
                self.assertEqual(response.status, 200)
                self.assertEqual(response.headers["Content-Type"], "application/zip")
                self.assertIn("dynamic-caption.ograf.zip", response.headers["Content-Disposition"])
            with zipfile.ZipFile(io.BytesIO(body)) as archive:
                self.assertIn("maw-dynamic-captions.ograf.json", archive.namelist())
        finally:
            server.shutdown()
            thread.join(timeout=2)
            server.server_close()

    def test_sticker_otioz_export_rejects_missing_sticker_rel(self) -> None:
        timeline = {"OTIO_SCHEMA": "Timeline.1", "tracks": {"children": [{"children": [
            {"OTIO_SCHEMA": "Clip.2", "metadata": {}, "media_references": {"DEFAULT_MEDIA": {"target_url": "x"}}},
        ]}]}}
        server, thread, base_url = self._sticker_otioz_serve()
        try:
            server.set_sticker_root(str(self.stickers))
            status, _, body = self._post_sticker_otioz(base_url, server, timeline)
        finally:
            server.shutdown()
            thread.join(timeout=2)
            server.server_close()
        self.assertEqual(status, 400)
        result = json.loads(body.decode("utf-8"))
        self.assertFalse(result["ok"])
        self.assertIn("缺少 sticker_rel", result["error"])

    def test_sticker_otioz_export_rejects_path_escape(self) -> None:
        timeline = {"OTIO_SCHEMA": "Timeline.1", "tracks": {"children": [{"children": [
            {"OTIO_SCHEMA": "Clip.2", "metadata": {"moy": {"sticker_rel": "../clip.jpg"}},
             "media_references": {"DEFAULT_MEDIA": {"target_url": "x"}}},
        ]}]}}
        server, thread, base_url = self._sticker_otioz_serve()
        try:
            server.set_sticker_root(str(self.stickers))
            status, _, body = self._post_sticker_otioz(base_url, server, timeline)
        finally:
            server.shutdown()
            thread.join(timeout=2)
            server.server_close()
        self.assertEqual(status, 400)
        result = json.loads(body.decode("utf-8"))
        self.assertFalse(result["ok"])
        self.assertIn("相对路径不安全", result["error"])

    def test_sticker_otioz_export_requires_verified_sticker_root(self) -> None:
        timeline = {"OTIO_SCHEMA": "Timeline.1", "tracks": {"children": [{"children": [
            {"OTIO_SCHEMA": "Clip.2", "metadata": {"moy": {"sticker_rel": "nested/cat.png"}},
             "media_references": {"DEFAULT_MEDIA": {"target_url": "x"}}},
        ]}]}}
        server, thread, base_url = self._sticker_otioz_serve()
        try:
            # load_project 会把 stickers_dir 兜底设为 root；显式清空验证未校验时的拒绝路径。
            server.project = replace(server.project, sticker_root=None, stickers=[])
            status, _, body = self._post_sticker_otioz(base_url, server, timeline)
        finally:
            server.shutdown()
            thread.join(timeout=2)
            server.server_close()
        self.assertEqual(status, 400)
        result = json.loads(body.decode("utf-8"))
        self.assertFalse(result["ok"])
        self.assertIn("尚未验证表情包根目录", result["error"])

    def test_reapeaks_loading_is_deferred_until_server_is_serving(self) -> None:
        self_waveform = {
            "schema": "moy.asr.waveform.v1",
            "encoding": "i8-minmax-base64",
            "peaks_per_second": 1000,
            "peak_count": 1,
            "duration_ms": 1,
            "data": "AIA=",
        }
        with (
            mock.patch.object(server_editor.edit, "load_or_extract_waveform", return_value=(self_waveform, False)) as waveform_load,
            mock.patch.object(server_editor.quapeaks, "load_spectral_payload") as spectral_load,
            mock.patch.object(server_editor.quapeaks, "load_waveform_payload") as reapeaks_wave_load,
        ):
            project = server_editor.load_project(
                self.project_path,
                None,
                str(self.stickers),
                no_waveform=False,
                load_reapeaks=False,
                peaks_per_second=100,
            )

        waveform_load.assert_called_once()
        spectral_load.assert_not_called()
        reapeaks_wave_load.assert_not_called()
        self.assertIs(project.data["waveform"], self_waveform)
        self.assertNotIn("spectral", project.data)
        self.assertNotIn("waveform_reapeaks", project.data)

        spectral_payload = {"peak_count": 2, "division": 80}
        reapeaks_wave_payload = {"peak_count": 4, "peaks_per_second": 1000}
        # 键必须照 moy.asr.loudness.v1 的真实形状给全：服务器加载完成后会按
        # p95/max 打一行日志，缺键会让后台线程整个死掉、状态永远停在 loading。
        loudness_payload = {
            "schema": "moy.asr.loudness.v1",
            "bin_count": 81,
            "channels": 1,
            "audio_track": 0,
            "max": 0.3357,
            "mean": 0.3315,
            "rms": 0.3336,
            "p95": 0.3357,
            "source": {"name": "clip.wav", "size": 10, "modified_ms": 1700000000000},
        }
        loader_started = threading.Event()
        release_loader = threading.Event()

        def blocking_spectral_load(*_args: object, **_kwargs: object) -> dict:
            loader_started.set()
            release_loader.wait(timeout=3)
            return spectral_payload

        def waveform_reapeaks_load(*_args: object, **_kwargs: object) -> dict:
            return reapeaks_wave_payload

        def loudness_load(*_args: object, **_kwargs: object) -> dict:
            return loudness_payload

        with (
            mock.patch.object(server_editor.quapeaks, "load_spectral_payload", side_effect=blocking_spectral_load),
            mock.patch.object(server_editor.quapeaks, "load_waveform_payload", side_effect=waveform_reapeaks_load),
            mock.patch.object(server_editor.quapeaks, "load_loudness_stats", side_effect=loudness_load),
            server_editor.EditorServer(
                ("127.0.0.1", 0),
                project,
                stickers_dir=str(self.stickers),
                no_waveform=False,
                defer_reapeaks=True,
                peaks_per_second=100,
            ) as server,
        ):
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base_url = f"http://127.0.0.1:{server.server_address[1]}"
            try:
                self.assertTrue(loader_started.wait(timeout=2))

                # If reapeaks were still on the request/startup path, this
                # request would wait for release_loader instead of returning.
                with urllib.request.urlopen(f"{base_url}/", timeout=1) as response:
                    self.assertEqual(response.status, 200)
                with urllib.request.urlopen(f"{base_url}/api/waveform", timeout=1) as response:
                    self.assertEqual(json.loads(response.read())["status"], "loading")

                release_loader.set()
                assert server.reapeaks_thread is not None
                server.reapeaks_thread.join(timeout=2)
                self.assertFalse(server.reapeaks_thread.is_alive())
                with urllib.request.urlopen(f"{base_url}/api/waveform", timeout=1) as response:
                    result = json.loads(response.read())
                self.assertEqual(result["status"], "ready")
                self.assertEqual(result["spectral"], spectral_payload)
                self.assertEqual(result["waveform_reapeaks"], reapeaks_wave_payload)
                # 响度统计走同一条延迟通道：它只是几个标量，但不该挡住首屏。
                self.assertEqual(result["loudness"], loudness_payload)
            finally:
                release_loader.set()
                server.shutdown()
                thread.join(timeout=2)

    def test_flv_project_uses_persistent_conversion_without_overwriting_project_media(self) -> None:
        source = self.root / "clip.flv"
        source.write_bytes(b"flv")
        project_path = self.root / "flv.json"
        project_path.write_text(json.dumps({"media": str(source), "segments": []}), encoding="utf-8")
        converted = self.root / "cache" / "clip.mp4"
        converted.parent.mkdir()
        converted.write_bytes(b"mp4")

        with mock.patch.object(server_editor, "convert_media_for_browser", return_value=converted) as convert:
            project = server_editor.load_project(
                project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
            )

        convert.assert_called_once_with(source.resolve(), ffmpeg_path=mock.ANY)
        self.assertEqual(project.media_path, converted)
        self.assertEqual(project.source_media_path, source.resolve())
        self.assertEqual(project.data["media"], str(source.resolve()))

    def test_flv_conversion_loads_source_reapeaks(self) -> None:
        """只有 flv（走转换）：.ReaPeaks 在 flv 旁，应按原始请求路径加载。"""
        source = self.root / "clip.flv"
        source.write_bytes(b"flv-content")
        _write_reapeaks_for(source)
        project_path = self.root / "flv.json"
        project_path.write_text(json.dumps({"media": str(source), "segments": []}), encoding="utf-8")
        converted = self.root / "cache" / "clip.mp4"
        converted.parent.mkdir()
        converted.write_bytes(b"mp4")

        with mock.patch.object(server_editor, "convert_media_for_browser", return_value=converted):
            project = server_editor.load_project(
                project_path, None, str(self.stickers), no_waveform=False, peaks_per_second=100,
            )

        self.assertIsNotNone(project.data.get("spectral"))
        self.assertIsNotNone(project.data.get("waveform_reapeaks"))

    def test_flv_paired_mp4_still_loads_source_reapeaks(self) -> None:
        """flv 旁已有配对 mp4（resolve 会把 resolved_path 升级为 mp4）：仍按原始 flv 找 .ReaPeaks。"""
        source = self.root / "clip.flv"
        source.write_bytes(b"flv-content")
        _write_reapeaks_for(source)
        paired = source.with_suffix(".mp4")
        paired.write_bytes(b"mp4-adjacent")
        project_path = self.root / "flv.json"
        project_path.write_text(json.dumps({"media": str(source), "segments": []}), encoding="utf-8")

        project = server_editor.load_project(
            project_path, None, str(self.stickers), no_waveform=False, peaks_per_second=100,
        )

        self.assertEqual(project.media_path, paired.resolve())
        self.assertIsNotNone(project.data.get("spectral"))
        self.assertIsNotNone(project.data.get("waveform_reapeaks"))

    def test_mosp_save_backup_keeps_mosp_extension(self) -> None:
        target = self.root / "copy.mosp"
        target.write_text('{"segments": []}\n', encoding="utf-8")
        backup = server_editor.write_project_json(target, {"segments": [{"start": 0, "end": 1, "text": "x"}]})

        self.assertIsNotNone(backup)
        self.assertEqual(backup.name, "copy.mosp.bak")
        self.assertEqual(backup.read_text(encoding="utf-8"), '{"segments": []}\n')

    def test_recent_projects_are_limited_to_ten_and_persisted_as_lf_json(self) -> None:
        settings = server_editor.ServerSettings()
        paths = []
        for index in range(12):
            project_path = self.root / f"project-{index}.json"
            paths.append(project_path)
            settings = server_editor.remember_project(settings, project_path)

        self.assertTrue(settings.auto_open_last_project)
        self.assertEqual(len(settings.recent_projects), 10)
        self.assertEqual(settings.recent_projects[0].path, paths[-1].resolve())
        self.assertNotIn(paths[0].resolve(), [item.path for item in settings.recent_projects])

        settings_path = self.root / "server-editor-settings.json"
        settings = server_editor.replace(settings, onboarding_status="completed")
        server_editor.write_server_settings(settings_path, settings)
        saved = settings_path.read_bytes()
        self.assertNotIn(b"\r\n", saved)
        self.assertTrue(saved.endswith(b"\n"))
        self.assertEqual(server_editor.read_server_settings(settings_path), settings)

    def test_recent_project_endpoint_reloads_media_and_updates_setting(self) -> None:
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        settings_path = self.root / "server-editor-settings.json"
        missing_project_path = self.root / "missing.json"
        settings = server_editor.remember_project(server_editor.ServerSettings(), self.project_path)
        settings = server_editor.remember_project(settings, self.other_project_path)
        settings = server_editor.remember_project(settings, missing_project_path)
        with server_editor.EditorServer(
            ("127.0.0.1", 0),
            project,
            settings=settings,
            settings_path=settings_path,
            stickers_dir=str(self.stickers),
            no_waveform=True,
            peaks_per_second=100,
        ) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                base_url = f"http://127.0.0.1:{server.server_address[1]}"

                def post(endpoint: str, payload: dict) -> tuple[int, dict]:
                    request = urllib.request.Request(
                        f"{base_url}{endpoint}",
                        data=json.dumps(payload).encode("utf-8"),
                        headers={"Content-Type": "application/json"},
                        method="POST",
                    )
                    try:
                        with urllib.request.urlopen(request) as response:
                            return response.status, json.loads(response.read())
                    except urllib.error.HTTPError as error:
                        return error.code, json.loads(error.read())

                status, result = post("/api/recent-projects/open", {"path": str(self.other_project_path)})
                self.assertEqual(status, 200)
                self.assertTrue(result["ok"])
                self.assertEqual(result["name"], "other.json")
                self.assertEqual(result["mediaName"], "other.mp3")
                self.assertEqual(server.project.json_path, self.other_project_path)
                self.assertEqual(server.project.media_path, self.other_media)
                self.assertEqual(server.settings.recent_projects[0].path, self.other_project_path)

                status, result = post("/api/settings", {"autoOpenLastProject": False})
                self.assertEqual(status, 200)
                self.assertTrue(result["ok"])
                self.assertFalse(server.settings.auto_open_last_project)
                self.assertFalse(server_editor.read_server_settings(settings_path).auto_open_last_project)

                status, result = post("/api/settings", {"onboardingStatus": "completed"})
                self.assertEqual(status, 200)
                self.assertTrue(result["ok"])
                self.assertEqual(result["onboardingStatus"], "completed")
                self.assertEqual(server.settings.onboarding_status, "completed")
                self.assertEqual(server_editor.read_server_settings(settings_path).onboarding_status, "completed")

                status, result = post("/api/settings", {"onboardingStatus": "unknown"})
                self.assertEqual(status, 400)
                self.assertFalse(result["ok"])
                self.assertEqual(server.settings.onboarding_status, "completed")

                workspace = {"schema": "moy.asr.editor.workspace.v1", "preset": "custom", "tree": {}}
                status, result = post("/api/settings", {
                    "saveWorkspace": {"name": "测试工作区", "workspace": workspace, "overwrite": False},
                })
                self.assertEqual(status, 200)
                self.assertTrue(result["ok"])
                self.assertEqual(server.settings.saved_workspaces["测试工作区"], workspace)

                status, result = post("/api/settings", {
                    "savePresetWorkspace": {"preset": "wave-right", "workspace": workspace},
                })
                self.assertEqual(status, 200)
                self.assertTrue(result["ok"])
                self.assertEqual(result["presetWorkspaces"]["wave-right"], workspace)

                status, result = post("/api/recent-projects/open", {"path": str(self.root / "unknown.json")})
                self.assertEqual(status, 400)
                self.assertFalse(result["ok"])

                status, result = post("/api/recent-projects/open", {"path": str(missing_project_path)})
                self.assertEqual(status, 400)
                self.assertFalse(result["ok"])
                self.assertTrue(result["missing"])
            finally:
                server.shutdown()
                thread.join(timeout=2)

    def test_recent_project_payload_marks_missing_paths(self) -> None:
        missing_project_path = self.root / "missing.json"
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        settings = server_editor.remember_project(server_editor.ServerSettings(), missing_project_path)
        page = server_editor.build_server_page(project, settings).decode("utf-8")
        self.assertIn('"name": "missing.json", "exists": false', page)

    def test_ass_style_endpoint_round_trips_the_shared_user_library(self) -> None:
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        style_path = self.root / "MAW" / "ass-styles.json"
        with mock.patch("maw.ass_styles.default_ass_styles_path", return_value=style_path):
            with server_editor.EditorServer(
                ("127.0.0.1", 0), project, no_waveform=True, peaks_per_second=100,
            ) as server:
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                try:
                    base_url = f"http://127.0.0.1:{server.server_address[1]}"

                    def request(endpoint: str, payload: dict | None = None) -> tuple[int, dict]:
                        data = None if payload is None else json.dumps(payload).encode("utf-8")
                        request = urllib.request.Request(
                            f"{base_url}{endpoint}", data=data,
                            headers={"Content-Type": "application/json"} if data is not None else {},
                            method="POST" if data is not None else "GET",
                        )
                        try:
                            with urllib.request.urlopen(request) as response:
                                return response.status, json.loads(response.read())
                        except urllib.error.HTTPError as error:
                            return error.code, json.loads(error.read())

                    status, initial = request("/api/ass-styles")
                    self.assertEqual(status, 200)
                    self.assertEqual(initial["assignments"]["srtBurnStyleId"], "default")

                    custom = {
                        "styles": [{"id": "studio", "name": "Studio", "fontName": "SimHei", "fontSize": 28}],
                        "assProfiles": [{"id": "studio-profile", "name": "Studio", "styleId": "studio"}],
                        "assignments": {"srtBurnStyleId": "studio", "assExportProfileId": "studio-profile"},
                    }

                    # 共享样式库是用户级配置：缺失或错误的请求令牌都不能改写。
                    status, forbidden = request("/api/ass-styles", custom)
                    self.assertEqual(status, 403)
                    self.assertFalse(forbidden["ok"])

                    wrong_token = {**custom, "requestToken": "wrong"}
                    status, forbidden = request("/api/ass-styles", wrong_token)
                    self.assertEqual(status, 403)
                    self.assertFalse(forbidden["ok"])
                    self.assertFalse(style_path.is_file())

                    status, saved = request("/api/ass-styles", {**custom, "requestToken": server.request_token})
                    self.assertEqual(status, 200)
                    self.assertEqual(saved["assignments"]["srtBurnStyleId"], "studio")
                    self.assertTrue(style_path.is_file())
                    self.assertNotIn("requestToken", saved)

                    status, loaded = request("/api/ass-styles")
                    self.assertEqual(status, 200)
                    self.assertEqual(loaded["styles"][-1]["fontName"], "SimHei")
                    self.assertEqual(loaded["assProfiles"][-1]["styleId"], "studio")
                finally:
                    server.shutdown()
                    thread.join(timeout=2)

    def test_saved_workspaces_are_persisted_and_reused_by_new_projects(self) -> None:
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        settings_path = self.root / "server-editor-settings.json"
        workspace = {
            "schema": 1,
            "preset": "custom",
            "columnPercent": 46,
            "rows": [30, 40, 30],
            "tree": {"type": "leaf", "id": "waveform"},
        }
        with server_editor.EditorServer(
            ("127.0.0.1", 0), project, settings_path=settings_path,
        ) as server:
            server.save_workspace("剪辑工作区", workspace, overwrite=False)
            self.assertEqual(server.settings.active_workspace_name, "剪辑工作区")
            self.assertEqual(server_editor.read_server_settings(settings_path).saved_workspaces["剪辑工作区"], workspace)

            page = server_editor.build_server_page(server.project, server.settings).decode("utf-8")
            self.assertIn('"workspace": {"schema": 1, "preset": "custom"', page)
            self.assertIn('"savedWorkspaces": {"剪辑工作区": {"schema": 1', page)

            with self.assertRaisesRegex(ValueError, "同名工作区"):
                server.save_workspace("剪辑工作区", workspace, overwrite=False)
            server.save_workspace("剪辑工作区", {**workspace, "columnPercent": 55}, overwrite=True)
            self.assertEqual(server.settings.saved_workspaces["剪辑工作区"]["columnPercent"], 55)
            server.delete_workspace("剪辑工作区")
            self.assertEqual(server.settings.active_workspace_name, "")
            self.assertEqual(server.settings.saved_workspaces, {})

            server.save_preset_workspace("wave-right", workspace)
            self.assertEqual(server.settings.preset_workspaces["wave-right"], workspace)
            server.save_preset_workspace("three-fold", workspace)
            self.assertEqual(server.settings.preset_workspaces["three-fold"], workspace)
            server.reset_preset_workspace("wave-right")
            self.assertEqual(server.settings.preset_workspaces, {"three-fold": workspace})
            server.reset_preset_workspace("three-fold")
            self.assertEqual(server.settings.preset_workspaces, {})
            with self.assertRaisesRegex(ValueError, "内置工作区"):
                server.save_preset_workspace("custom", workspace)

    def test_workspace_navigation_updates_merge_and_survive_server_restart(self) -> None:
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        settings_path = self.root / "server-editor-settings.json"
        workspace = {
            "schema": 1,
            "preset": "custom",
            "columnPercent": 46,
            "editorDisplay": {"cueListShowTime": True},
            "navigation": {"cueListScrollTop": 120, "waveformTopEdgeMs": 2400},
        }
        preset_workspace = {
            "schema": 1,
            "preset": "wave-right",
            "waveformSettings": {"secondsPerRow": 10},
        }
        with server_editor.EditorServer(
            ("127.0.0.1", 0), project, settings_path=settings_path,
        ) as server:
            server.save_workspace("剪辑工作区", workspace, overwrite=False)
            server.save_preset_workspace("wave-right", preset_workspace)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                base_url = f"http://127.0.0.1:{server.server_address[1]}"

                def post(payload: dict) -> tuple[int, dict]:
                    request = urllib.request.Request(
                        f"{base_url}/api/settings",
                        data=json.dumps(payload).encode("utf-8"),
                        headers={"Content-Type": "application/json"},
                        method="POST",
                    )
                    try:
                        with urllib.request.urlopen(request) as response:
                            return response.status, json.loads(response.read())
                    except urllib.error.HTTPError as error:
                        return error.code, json.loads(error.read())

                status, result = post({
                    "updateWorkspaceNavigation": {
                        "name": "剪辑工作区",
                        "navigation": {"cueListScrollTop": 840, "waveformTopEdgeMs": 12600},
                    },
                })
                self.assertEqual(status, 200)
                self.assertTrue(result["ok"])
                saved = server.settings.saved_workspaces["剪辑工作区"]
                self.assertEqual(saved["navigation"], {"cueListScrollTop": 840, "waveformTopEdgeMs": 12600})
                self.assertEqual(saved["columnPercent"], workspace["columnPercent"])
                self.assertEqual(saved["editorDisplay"], workspace["editorDisplay"])

                status, result = post({
                    "updateWorkspaceNavigation": {
                        "name": "剪辑工作区",
                        "navigation": {"cueListScrollTop": 900},
                    },
                })
                self.assertEqual(status, 200)
                self.assertTrue(result["ok"])
                self.assertEqual(
                    server.settings.saved_workspaces["剪辑工作区"]["navigation"],
                    {"cueListScrollTop": 900, "waveformTopEdgeMs": 12600},
                )

                status, result = post({
                    "updateWorkspaceNavigation": {
                        "preset": "wave-right",
                        "navigation": {"cueListScrollTop": 360, "waveformTopEdgeMs": 7200},
                    },
                })
                self.assertEqual(status, 200)
                self.assertTrue(result["ok"])
                self.assertEqual(
                    server.settings.preset_workspaces["wave-right"]["navigation"],
                    {"cueListScrollTop": 360, "waveformTopEdgeMs": 7200},
                )
            finally:
                server.shutdown()
                thread.join(timeout=2)

        reloaded = server_editor.read_server_settings(settings_path)
        self.assertEqual(
            reloaded.saved_workspaces["剪辑工作区"]["navigation"],
            {"cueListScrollTop": 900, "waveformTopEdgeMs": 12600},
        )
        self.assertEqual(
            reloaded.preset_workspaces["wave-right"]["navigation"],
            {"cueListScrollTop": 360, "waveformTopEdgeMs": 7200},
        )

    def test_workspace_navigation_rejects_invalid_targets_values_and_fields(self) -> None:
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        settings_path = self.root / "server-editor-settings.json"
        workspace = {"schema": 1, "columnPercent": 46, "editorDisplay": {"cueListShowTime": True}}
        with server_editor.EditorServer(
            ("127.0.0.1", 0), project, settings_path=settings_path,
        ) as server:
            server.save_workspace("剪辑工作区", workspace, overwrite=False)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                base_url = f"http://127.0.0.1:{server.server_address[1]}"

                def post(navigation: dict, *, target: dict | None = None) -> tuple[int, dict]:
                    update = {"navigation": navigation}
                    update.update(target or {"name": "剪辑工作区"})
                    request = urllib.request.Request(
                        f"{base_url}/api/settings",
                        data=json.dumps({"updateWorkspaceNavigation": update}).encode("utf-8"),
                        headers={"Content-Type": "application/json"},
                        method="POST",
                    )
                    try:
                        with urllib.request.urlopen(request) as response:
                            return response.status, json.loads(response.read())
                    except urllib.error.HTTPError as error:
                        return error.code, json.loads(error.read())

                invalid_cases = [
                    ({"cueListScrollTop": -1, "waveformTopEdgeMs": 20}, None),
                    ({"cueListScrollTop": 1.5, "waveformTopEdgeMs": 20}, None),
                    ({"cueListScrollTop": float("nan"), "waveformTopEdgeMs": 20}, None),
                    ({"cueListScrollTop": 20, "waveformTopEdgeMs": "20"}, None),
                    ({"cueListScrollTop": 20, "waveformTopEdgeMs": 20, "other": 1}, None),
                    ({"cueListScrollTop": 20, "waveformTopEdgeMs": 20}, {"name": "不存在"}),
                    ({"cueListScrollTop": 20, "waveformTopEdgeMs": 20}, {"preset": "custom"}),
                ]
                for navigation, target in invalid_cases:
                    with self.subTest(navigation=navigation, target=target):
                        status, result = post(navigation, target=target)
                        self.assertEqual(status, 400)
                        self.assertFalse(result["ok"])
                self.assertEqual(server.settings.saved_workspaces["剪辑工作区"], workspace)
            finally:
                server.shutdown()
                thread.join(timeout=2)

    def test_workspace_navigation_creates_navigation_only_preset_override(self) -> None:
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        settings_path = self.root / "server-editor-settings.json"
        with server_editor.EditorServer(
            ("127.0.0.1", 0), project, settings_path=settings_path,
        ) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                base_url = f"http://127.0.0.1:{server.server_address[1]}"

                def post(payload: dict) -> tuple[int, dict]:
                    request = urllib.request.Request(
                        f"{base_url}/api/settings",
                        data=json.dumps(payload).encode("utf-8"),
                        headers={"Content-Type": "application/json"},
                        method="POST",
                    )
                    try:
                        with urllib.request.urlopen(request) as response:
                            return response.status, json.loads(response.read())
                    except urllib.error.HTTPError as error:
                        return error.code, json.loads(error.read())

                # First save for builtin preset with no existing override
                status, result = post({
                    "updateWorkspaceNavigation": {
                        "preset": "wave-right",
                        "navigation": {"cueListScrollTop": 100, "waveformTopEdgeMs": 2000},
                    },
                })
                self.assertEqual(status, 200)
                self.assertTrue(result["ok"])
                self.assertEqual(
                    server.settings.preset_workspaces["wave-right"],
                    {"navigation": {"cueListScrollTop": 100, "waveformTopEdgeMs": 2000}},
                )

                # Second save updates the same navigation dict
                status, result = post({
                    "updateWorkspaceNavigation": {
                        "preset": "wave-right",
                        "navigation": {"cueListScrollTop": 300},
                    },
                })
                self.assertEqual(status, 200)
                self.assertTrue(result["ok"])
                self.assertEqual(
                    server.settings.preset_workspaces["wave-right"],
                    {"navigation": {"cueListScrollTop": 300, "waveformTopEdgeMs": 2000}},
                )

                # Full preset workspace save still works and preserves navigation
                status, result = post({
                    "savePresetWorkspace": {
                        "preset": "wave-right",
                        "workspace": {
                            "schema": 1,
                            "columnPercent": 50,
                            "editorDisplay": {"cueListShowTime": True},
                        },
                    },
                })
                self.assertEqual(status, 200)
                self.assertTrue(result["ok"])
                self.assertEqual(
                    server.settings.preset_workspaces["wave-right"],
                    {
                        "schema": 1,
                        "columnPercent": 50,
                        "editorDisplay": {"cueListShowTime": True},
                        "navigation": {"cueListScrollTop": 300, "waveformTopEdgeMs": 2000},
                    },
                )
            finally:
                server.shutdown()
                thread.join(timeout=2)

    def test_open_recent_project_does_not_hold_settings_lock(self) -> None:
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        settings_path = self.root / "server-editor-settings.json"
        # Write a recent-projects entry directly into settings
        initial_settings = server_editor.read_server_settings(settings_path)
        initial_settings = replace(
            initial_settings,
            recent_projects=[
                server_editor.RecentProject(
                    path=self.project_path,
                    name=self.project_path.name,
                ),
            ],
        )
        with server_editor.EditorServer(
            ("127.0.0.1", 0), project, settings=initial_settings, settings_path=settings_path,
        ) as server:
            load_started = threading.Event()
            original_load_project = server_editor.load_project

            def slow_load_project(*args, **kwargs):
                load_started.set()
                import time
                time.sleep(0.5)
                return original_load_project(*args, **kwargs)

            with mock.patch.object(server_editor, "load_project", slow_load_project):
                thread = threading.Thread(
                    target=server.open_recent_project, args=(str(self.project_path),),
                )
                thread.start()
                try:
                    load_started.wait(timeout=2)
                    # set_active_workspace should not block while load_project sleeps
                    server.save_workspace("x", {"schema": 1}, overwrite=False)
                    start = __import__("time").time()
                    server.set_active_workspace("x")
                    elapsed = __import__("time").time() - start
                    self.assertLess(elapsed, 0.3, "set_active_workspace blocked on load_project")
                finally:
                    thread.join(timeout=2)

    def test_server_saves_project_with_backup_and_rejects_unsafe_save_as(self) -> None:
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        original = self.project_path.read_bytes()
        with server_editor.EditorServer(("127.0.0.1", 0), project) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                base_url = f"http://127.0.0.1:{server.server_address[1]}"

                def post(payload: dict) -> tuple[int, dict]:
                    request = urllib.request.Request(
                        f"{base_url}/api/project",
                        data=json.dumps(payload).encode("utf-8"),
                        headers={"Content-Type": "application/json"},
                        method="POST",
                    )
                    try:
                        with urllib.request.urlopen(request) as response:
                            return response.status, json.loads(response.read())
                    except urllib.error.HTTPError as error:
                        return error.code, json.loads(error.read())

                saved_project = {
                    "media": str(self.media),
                    "segments": [{"start": 0, "end": 1000, "text": "保存后的字幕"}],
                }
                normalized_saved_project = {
                    "schema": PROJECT_SCHEMA,
                    "media": str(self.media),
                    "segments": [{"id": "main-001", "start": 0, "end": 1000, "text": "保存后的字幕"}],
                }
                status, result = post({"project": saved_project, "filename": None})
                self.assertEqual(status, 200)
                self.assertTrue(result["ok"])
                self.assertEqual(result["filename"], "clip.json")
                self.assertEqual(result["backup"], "clip.json.bak")
                self.assertEqual(self.project_path.with_suffix(".json.bak").read_bytes(), original)
                saved_bytes = self.project_path.read_bytes()
                self.assertNotIn(b"\r\n", saved_bytes)
                self.assertTrue(saved_bytes.endswith(b"\n"))
                self.assertEqual(json.loads(saved_bytes), normalized_saved_project)

                status, result = post({"project": saved_project, "filename": "copy.json"})
                copied_path = self.root / "copy.json"
                self.assertEqual(status, 200)
                self.assertEqual(result["filename"], "copy.json")
                self.assertIsNone(result["backup"])
                self.assertEqual(json.loads(copied_path.read_text(encoding="utf-8")), normalized_saved_project)
                self.assertEqual(server.project.json_path, copied_path)

                status, result = post({"project": saved_project, "filename": "../outside.json"})
                self.assertEqual(status, 400)
                self.assertFalse(result["ok"])
                self.assertFalse((self.root.parent / "outside.json").exists())
            finally:
                server.shutdown()
                thread.join(timeout=2)

    def test_save_keeps_runtime_caches_off_disk_and_intact_in_memory(self) -> None:
        """浏览器保存不带缓存：磁盘必须干净，运行态原生波形不得被清空。

        回归：save_project 曾把浏览器回传的 normalized_project 直接替换进
        运行态，保存→刷新后原生波形丢失、被 /api/waveform 的 REAPER 峰顶替。
        """
        waveform_payload = {
            "schema": "moy.asr.waveform.v1",
            "encoding": "i8-minmax-base64",
            "peaks_per_second": 100,
            "sample_rate": 1000,
            "division": 10,
            "peak_count": 4,
            "duration_ms": 40,
            "data": "AQIDBA==",
            "audio_track": 0,
            "source": {"name": self.media.name, "size": 1, "modified_ms": 1},
        }
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        project.data["waveform"] = waveform_payload

        with server_editor.EditorServer(("127.0.0.1", 0), project) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                base_url = f"http://127.0.0.1:{server.server_address[1]}"

                def post(payload: dict) -> tuple[int, dict]:
                    request = urllib.request.Request(
                        f"{base_url}/api/project",
                        data=json.dumps(payload).encode("utf-8"),
                        headers={"Content-Type": "application/json"},
                        method="POST",
                    )
                    with urllib.request.urlopen(request) as response:
                        return response.status, json.loads(response.read())

                # 等延迟加载线程落定（状态 pending/loading → ready/failed）；
                # 它收尾时会用快照整表替换运行态 data，注入必须发生在其后。
                deadline = time.time() + 5
                while server.reapeaks_status in ("pending", "loading") and time.time() < deadline:
                    time.sleep(0.05)
                server.project.data["spectral"] = dict(waveform_payload, schema="moy.asr.spectral.v1")
                server.project.data["waveform_reapeaks"] = dict(waveform_payload, peak_count=6, data="QUJDRA==")
                server.project.data["loudness"] = dict(
                    waveform_payload, schema="moy.asr.loudness.v1", p95=0.3357, max=0.3357,
                )

                browser_payload = {
                    "media": str(self.media),
                    "segments": [{"start": 0, "end": 1000, "text": "浏览器格式"}],
                    "media_metadata": {"selected_audio_track": 0},
                }
                status, _ = post({"project": browser_payload, "filename": None})
                self.assertEqual(status, 200)
                # 磁盘干净：内联缓存（含 loudness）不得落盘。
                saved = json.loads(self.project_path.read_text(encoding="utf-8"))
                for key in ("waveform", "spectral", "waveform_reapeaks", "loudness"):
                    self.assertNotIn(key, saved)
                # 运行态保留原生波形与各层缓存：保存→刷新不丢形状、不丢响度标尺。
                self.assertEqual(server.project.data["waveform"]["data"], "AQIDBA==")
                self.assertIn("spectral", server.project.data)
                self.assertIn("waveform_reapeaks", server.project.data)
                self.assertIn("loudness", server.project.data)

                # 同媒体换音轨：旧缓存描述的是另一条轨，必须失效。
                switched = dict(browser_payload, media_metadata={"selected_audio_track": 1})
                status, _ = post({"project": switched, "filename": None})
                self.assertEqual(status, 200)
                for key in ("waveform", "spectral", "waveform_reapeaks"):
                    self.assertNotIn(key, server.project.data)

                # 旧页面不带 selected_audio_track 字段时不得误清运行态缓存（防御路径）。
                server.project.data["waveform"] = waveform_payload
                legacy_payload = {"media": str(self.media), "segments": []}
                status, _ = post({"project": legacy_payload, "filename": None})
                self.assertEqual(status, 200)
                self.assertEqual(server.project.data["waveform"]["data"], "AQIDBA==")

                # 换媒体：缓存描述的是另一个文件，必须失效。
                other = self.root / "other.wav"
                other.write_bytes(b"audio")
                status, _ = post({
                    "project": {"media": str(other), "segments": []},
                    "filename": None,
                })
                self.assertEqual(status, 200)
                self.assertNotIn("waveform", server.project.data)
            finally:
                server.shutdown()
                thread.join(timeout=2)

    def test_server_accepts_reconciled_extension_ranges_but_rejects_overlap(self) -> None:
        project = server_editor.load_project(
            self.project_path, None, str(self.stickers), no_waveform=True, peaks_per_second=100,
        )
        with server_editor.EditorServer(("127.0.0.1", 0), project) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                base_url = f"http://127.0.0.1:{server.server_address[1]}"

                def post(payload: dict) -> tuple[int, dict]:
                    request = urllib.request.Request(
                        f"{base_url}/api/project",
                        data=json.dumps({"project": payload}).encode("utf-8"),
                        headers={"Content-Type": "application/json"},
                        method="POST",
                    )
                    try:
                        with urllib.request.urlopen(request) as response:
                            return response.status, json.loads(response.read())
                    except urllib.error.HTTPError as error:
                        return error.code, json.loads(error.read())

                valid_project = {
                    "media": str(self.media),
                    "segments": [{"id": "main-1", "start": 1000, "end": 4000, "text": "主字幕"}],
                    "multi_subtitle": {
                        "schema": "moy.asr.multi_subtitle.v1",
                        "enabled": True,
                        "display_mode": "both",
                        "tracks": [{
                            "id": "extension-1",
                            "role": "extension",
                            "name": "English",
                            "language": "English",
                            "split_mode": "word",
                            "source_name": "translation.srt",
                            "segments": [
                                {"id": "extension-1", "start": 1000, "end": 3000, "text": "前半"},
                                {"id": "extension-2", "start": 3000, "end": 4000, "text": "后半"},
                            ],
                        }],
                        "bindings": [{
                            "id": "binding-1",
                            "track_id": "extension-1",
                            "main_segment_ids": ["main-1"],
                            "extension_segment_ids": ["extension-1"],
                            "start_offset_ms": 0,
                            "end_offset_ms": -1000,
                        }],
                    },
                }
                status, result = post(valid_project)
                self.assertEqual(status, 200)
                self.assertTrue(result["ok"])

                invalid_project = json.loads(json.dumps(valid_project))
                invalid_project["multi_subtitle"]["tracks"][0]["segments"][1]["start"] = 2999
                status, result = post(invalid_project)
                self.assertEqual(status, 400)
                self.assertFalse(result["ok"])
                self.assertIn("must be >= previous segment end", result["error"])
            finally:
                server.shutdown()
                thread.join(timeout=2)


    def test_attach_endpoint_binds_browser_opened_project_and_enables_save(self) -> None:
        blank_project = server_editor.load_blank_project(str(self.stickers))
        settings_path = self.root / "server-editor-settings.json"
        with server_editor.EditorServer(
            ("127.0.0.1", 0),
            blank_project,
            settings=server_editor.ServerSettings(),
            settings_path=settings_path,
            stickers_dir=str(self.stickers),
            no_waveform=True,
            peaks_per_second=100,
        ) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                base_url = f"http://127.0.0.1:{server.server_address[1]}"

                def post(endpoint: str, payload: dict) -> tuple[int, dict]:
                    request = urllib.request.Request(
                        f"{base_url}{endpoint}",
                        data=json.dumps(payload).encode("utf-8"),
                        headers={"Content-Type": "application/json"},
                        method="POST",
                    )
                    try:
                        with urllib.request.urlopen(request) as response:
                            return response.status, json.loads(response.read())
                    except urllib.error.HTTPError as error:
                        return error.code, json.loads(error.read())

                legacy_project = {
                    "media": str(self.media),
                    "segments": [{"start": 0, "end": 1000, "text": "浏览器打开的字幕"}],
                }
                # The browser normalizes a legacy project before asking the
                # server to take it over, while the on-disk copy still has no
                # IDs. The server must apply the same deterministic repair to
                # both copies before comparing their subtitle content.
                browser_project = json.loads(json.dumps(legacy_project))
                browser_project["segments"][0]["id"] = "main-001"

                # 失败矩阵：任何一项不满足都不得绑定工程路径。
                notes = self.root / "notes.txt"
                notes.write_text("not media", encoding="utf-8")
                failure_cases = [
                    ({"fileName": "../outside.json", "project": browser_project}, "文件名"),
                    ({"fileName": "", "project": browser_project}, "文件名"),
                    ({"fileName": "clip.json", "project": "not-a-dict"}, "对象"),
                    ({"fileName": "clip.json", "project": {"segments": []}}, "媒体路径"),
                    ({"fileName": "clip.json", "project": {"media": "clip.mp3", "segments": []}}, "绝对路径"),
                    (
                        {"fileName": "clip.json", "project": {"media": str(self.root / "gone.mp3"), "segments": []}},
                        "不存在或已移动",
                    ),
                    (
                        {"fileName": "clip.json", "project": {"media": str(notes), "segments": []}},
                        "音视频",
                    ),
                    ({"fileName": "missing.json", "project": browser_project}, "同名工程"),
                    (
                        {
                            "fileName": "clip.json",
                            "project": {"media": str(self.media), "segments": [{"start": 5, "end": 900, "text": "旧副本"}]},
                        },
                        "内容不一致",
                    ),
                ]
                for payload, hint in failure_cases:
                    with self.subTest(hint=hint):
                        status, result = post("/api/project/attach", payload)
                        self.assertEqual(status, 400)
                        self.assertFalse(result["ok"])
                        self.assertIn(hint, result["error"])
                        self.assertIsNone(server.project.json_path)

                # 磁盘上的同名工程与浏览器副本一致：接管并恢复媒体与保存。
                self.project_path.write_text(json.dumps(legacy_project), encoding="utf-8")
                status, result = post("/api/project/attach", {"fileName": "clip.json", "project": browser_project})
                self.assertEqual(status, 200)
                self.assertTrue(result["ok"])
                self.assertEqual(result["name"], "clip.json")
                self.assertEqual(result["mediaName"], "clip.mp3")
                self.assertEqual(server.project.json_path, self.project_path.resolve())
                self.assertEqual(server.project.media_path, self.media.resolve())
                self.assertEqual(server.settings.recent_projects[0].path, self.project_path.resolve())
                self.assertEqual(
                    server_editor.read_server_settings(settings_path).recent_projects[0].path,
                    self.project_path.resolve(),
                )

                # 接管后保存直接写回绑定的工程文件。
                edited = {"media": str(self.media), "segments": [{"start": 0, "end": 1000, "text": "接管后保存"}]}
                status, result = post("/api/project", {"project": edited, "filename": None})
                self.assertEqual(status, 200)
                self.assertTrue(result["ok"])
                self.assertEqual(
                    json.loads(self.project_path.read_text(encoding="utf-8")),
                    {
                        "schema": PROJECT_SCHEMA,
                        "media": str(self.media.resolve()),
                        "segments": [{"id": "main-001", "start": 0, "end": 1000, "text": "接管后保存"}],
                    },
                )
            finally:
                server.shutdown()
                thread.join(timeout=2)


def _blank_project() -> "server_editor.ServerProject":
    """A minimal bind-only project; avoids scanning the developer sticker dir."""
    return server_editor.ServerProject(
        {"segments": [], "media": "", "language": "", "model": ""}, None, None, None, [],
    )


class EditorPortSelectionTests(unittest.TestCase):
    def test_open_editor_server_advances_when_omitted_port_is_busy(self) -> None:
        """Given 端口省略且起始端口被占用，When 绑定服务，Then 自动顺延到之后的空闲端口并标记 advanced。"""
        blocker = server_editor.EditorServer(("127.0.0.1", 0), _blank_project())
        try:
            busy_port = blocker.server_address[1]
            with mock.patch.object(server_editor, "DEFAULT_EDITOR_PORT", busy_port):
                server, advanced = server_editor.open_editor_server("127.0.0.1", None, _blank_project())
            try:
                self.assertTrue(advanced)
                chosen = server.server_address[1]
                self.assertNotEqual(chosen, busy_port)
                self.assertGreaterEqual(chosen, busy_port + 1)
            finally:
                server.server_close()
        finally:
            blocker.server_close()

    def test_open_editor_server_keeps_explicit_busy_port_failure(self) -> None:
        """Given 显式 --port 指向正被占用的端口，When 绑定服务，Then 抛出 OSError 而不是顺延。"""
        blocker = server_editor.EditorServer(("127.0.0.1", 0), _blank_project())
        try:
            with self.assertRaises(OSError):
                server_editor.open_editor_server("127.0.0.1", blocker.server_address[1], _blank_project())
        finally:
            blocker.server_close()


if __name__ == "__main__":
    unittest.main()
