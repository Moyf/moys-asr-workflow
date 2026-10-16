from __future__ import annotations

import json
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from dataclasses import replace
from pathlib import Path
from unittest import mock

from maw.media_jobs import MediaJobManager, MediaJobBusy
from tests.test_local_editor_server import server_editor, fake_video_copy_plan


class MediaExportBackendTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="maw-media-backend-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "selected.m4a"
        self.source.write_bytes(b"original")
        self.project = server_editor.ServerProject(
            data={"segments": [], "media_metadata": {"selected_audio_track": 1}},
            json_path=self.root / "project.mosp", media_path=self.source,
            source_media_path=self.source, sticker_root=None, stickers=[],
        )
        self.server = server_editor.EditorServer(("127.0.0.1", 0), self.project, no_waveform=True)
        self.server.media_jobs.temp_root = self.root
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)
        self.base = "/api/exports/gap-removed-video"

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)

    def request(self, path, payload=None):
        headers = {"Content-Type": "application/json", "X-MAW-Request-Token": self.server.request_token}
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.server.server_address[1]}" + path,
            data=json.dumps(payload).encode() if payload is not None else None, headers=headers,
        )
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                body = response.read()
                return response.status, response.headers, json.loads(body) if "json" in response.headers.get("Content-Type", "") else body
        except urllib.error.HTTPError as error:
            return error.code, error.headers, json.loads(error.read())

    def payload(self):
        return {"requestToken": self.server.request_token, **self.server.project_binding_payload(),
                "intervals": [{"startMs": 101, "endMs": 305}]}

    def wait(self, job_id, state):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            snapshot = self.request(self.base + "/jobs/" + job_id)[2]
            if snapshot["state"] == state:
                return snapshot
            time.sleep(.01)
        self.fail(f"Task never reached {state}: {snapshot}")

    def test_audio_sync_returns_wav_and_pins_track_before_tools_lookup(self):
        captured = {}

        def tools():
            self.server.project.data["media_metadata"]["selected_audio_track"] = 0
            return mock.Mock(ffmpeg=Path("ffmpeg"), ffprobe=Path("ffprobe"))

        def rebuild(source, intervals, output, **kwargs):
            captured.update(source=source, intervals=intervals, track=kwargs["audio_track"], output=output)
            output.write_bytes(b"verified-wave")

        payload = self.payload()
        payload["audioTrack"] = 99
        payload["sourceMediaPath"] = "untrusted.mp4"
        with mock.patch.object(server_editor, "editor_ffmpeg_tools", side_effect=tools), \
             mock.patch.object(server_editor, "rebuild_gap_removed_audio", side_effect=rebuild), \
             mock.patch.object(server_editor, "rebuild_gap_removed_video", side_effect=AssertionError("audio only")):
            status, headers, body = self.request(self.base, payload)
        self.assertEqual((status, body), (200, b"verified-wave"))
        self.assertEqual(headers["Content-Type"], "audio/wav")
        self.assertIn("selected_gap-removed.wav", headers["Content-Disposition"])
        self.assertEqual((captured["source"], captured["track"], captured["intervals"]), (self.source, 1, [(101, 305)]))
        self.assertEqual(captured["output"].suffix, ".wav")
        deadline = time.monotonic() + 2
        while captured["output"].exists() and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertFalse(captured["output"].exists())
        self.assertEqual(self.source.read_bytes(), b"original")

    def test_audio_job_download_uses_output_format_and_terminal_cleanup(self):
        captured = {}

        def rebuild(source, intervals, output, **kwargs):
            captured["track"] = kwargs["audio_track"]
            output.write_bytes(b"wave-job")

        tools = mock.Mock(ffmpeg=Path("ffmpeg"), ffprobe=Path("ffprobe"))
        with mock.patch.object(server_editor, "editor_ffmpeg_tools", return_value=tools), \
             mock.patch.object(server_editor, "rebuild_gap_removed_audio", side_effect=rebuild):
            status, _, created = self.request(self.base + "/jobs", self.payload())
            self.assertEqual(status, 202)
            job_id = created["jobId"]
            self.assertFalse(self.wait(job_id, "ready")["cleanupComplete"])
            status, headers, body = self.request(self.base + "/jobs/" + job_id + "/download")
            self.assertEqual((status, headers["Content-Type"], body), (200, "audio/wav", b"wave-job"))
            self.assertIn("selected_gap-removed.wav", headers["Content-Disposition"])
            self.assertTrue(self.wait(job_id, "completed")["cleanupComplete"])
            self.assertEqual(captured["track"], 1)

    def test_failed_job_exposes_separate_details_and_cancel_reports_cleanup(self):
        tools = mock.Mock(ffmpeg=Path("ffmpeg"), ffprobe=Path("ffprobe"))
        error = server_editor.GapRemovedVideoExportError("源文件无法读取", details="No start code " * 1000)
        with mock.patch.object(server_editor, "editor_ffmpeg_tools", return_value=tools), \
             mock.patch.object(server_editor, "rebuild_gap_removed_audio", side_effect=error):
            _, _, created = self.request(self.base + "/jobs", self.payload())
            job_id = created["jobId"]
            failed = self.wait(job_id, "failed")
            self.assertTrue(failed["cleanupComplete"])
            self.assertEqual(failed["error"], "源文件无法读取")
            self.assertLessEqual(len(failed["errorDetails"]), 4000)
            status, _, cancelled = self.request(self.base + "/jobs/" + job_id + "/cancel",
                {"requestToken": self.server.request_token})
            self.assertEqual(status, 200)
            self.assertTrue(cancelled["cleanupComplete"])
            self.assertIsNone(cancelled["cleanupError"])
            self.assertIsNone(self.server.media_jobs.active)

    def test_stale_audio_binding_rejected_before_tools(self):
        payload = self.payload()
        with self.server.settings_lock:
            self.server._bind_project_locked(self.project)
        with mock.patch.object(server_editor, "editor_ffmpeg_tools", side_effect=AssertionError("stale")):
            self.assertEqual(self.request(self.base + "/jobs", payload)[0], 409)

    def test_picker_track_snapshot_rejects_same_binding_track_change(self):
        payload = {**self.payload(), "selectedAudioTrack": 1}
        self.server.project.data["media_metadata"]["selected_audio_track"] = 0
        with mock.patch.object(server_editor, "editor_ffmpeg_tools", side_effect=AssertionError("changed track")):
            for endpoint in (self.base, self.base + "/jobs"):
                status, _, result = self.request(endpoint, payload)
                self.assertEqual(status, 409)
                self.assertIn("所选音轨已变更", result["error"])
        self.assertIsNone(self.server.media_jobs.active)

    def test_default_track_and_audio_capability_use_bound_original(self):
        project = replace(self.project, data={"segments": [], "media_metadata": {
            "audio_tracks": [{"audio_index": 2, "default": True}]}}, media_path=self.root / "browser.mp4")
        with self.server.settings_lock:
            self.server._bind_project_locked(project)
        snapshot = self.server.gap_removed_media_source_snapshot(self.server.project_binding_payload())
        self.assertEqual((snapshot.path, snapshot.kind, snapshot.audio_track), (self.source, "audio", 2))
        with mock.patch.object(server_editor.edit, "render_editor_page", return_value="page") as render:
            server_editor.build_server_page(project)
        config = json.loads(render.call_args.kwargs["server_config_json"])
        self.assertTrue(config["canGapRemovedMediaExport"])
        self.assertFalse(config["canGapRemovedVideoExport"])
        self.assertEqual((config["gapRemovedMediaKind"], config["gapRemovedMediaOutputExtension"], config["gapRemovedMediaOutputMime"]), ("audio", ".wav", "audio/wav"))
        self.assertEqual(config["gapRemovedMediaAudioTrack"], 2)


class VideoHeaderAndCleanupTests(unittest.TestCase):
    @mock.patch.object(server_editor, "prepare_video_copy", new=fake_video_copy_plan)
    @mock.patch.object(server_editor, "verify_video_packets", new=lambda *_: None)
    def test_mixed_video_codecs_filter_each_hevc_stream_only(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "mixed.mkv"
            source.write_bytes(b"source")
            output = root / "output.mkv"
            streams = [{"codec_type": "video", "codec_name": "hevc"},
                       {"codec_type": "audio", "codec_name": "aac"},
                       {"codec_type": "video", "codec_name": "h264"},
                       {"codec_type": "video", "codec_name": "hevc"}]
            commands = []

            def run(command, **kwargs):
                commands.append(command)
                if command[0] == "ffprobe":
                    return subprocess.CompletedProcess(command, 0, json.dumps({"streams": streams}), "")
                output.write_bytes(b"valid")
                return subprocess.CompletedProcess(command, 0, "", "")

            with mock.patch.object(server_editor.subprocess, "run", side_effect=run):
                server_editor.rebuild_gap_removed_video(source, [(0, 1000)], output,
                    ffmpeg_path=Path("ffmpeg"), ffprobe_path=Path("ffprobe"))
            command = next(c for c in commands if c[0] == "ffmpeg")
            filters = [(flag, value) for flag, value in zip(command, command[1:]) if flag.startswith("-bsf:")]
            self.assertEqual([flag for flag, value in filters if value.startswith("hevc_mp4toannexb,")],
                             ["-bsf:0", "-bsf:3"])
            self.assertTrue(all("noise=amount=0:drop=" in value for _, value in filters))
            self.assertIn("-map", command)
            self.assertEqual(sum(c[0] == "ffprobe" for c in commands), 2)

    def test_cleanup_failure_retains_slot_and_retry_changes_cleanup_complete(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = MediaJobManager(temp_root=directory)
            self.addCleanup(manager.close)
            job = manager.start(Path("source.flac"), (1, "bound"), [(0, 10)],
                lambda job: job.output.write_bytes(b"wave"), output_extension=".wav")
            job.thread.join(2)
            self.assertEqual(job.output.suffix, ".wav")
            with mock.patch("maw.media_jobs.shutil.rmtree", side_effect=PermissionError("locked")):
                failed = manager.cancel(job.id)
                self.assertFalse(failed["cleanupComplete"])
                self.assertIsNotNone(failed["cleanupError"])
                with self.assertRaises(MediaJobBusy):
                    manager.start(Path("another.mp4"), (1, "bound"), [(0, 10)], lambda _: None)
            retried = manager.cancel(job.id)
            self.assertTrue(retried["cleanupComplete"])
            self.assertIsNone(retried["cleanupError"])
            self.assertIsNone(manager.active)


if __name__ == "__main__":
    unittest.main()
