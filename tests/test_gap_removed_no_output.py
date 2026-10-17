from __future__ import annotations

import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

from maw.media_jobs import MediaJobManager, MediaJobUnavailable

TEMP_ROOT = Path(__file__).resolve().parents[1] / ".artifacts" / "no-output-tests"


class NoOutputLifecycleTests(unittest.TestCase):
    def setUp(self):
        TEMP_ROOT.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=TEMP_ROOT)
        self.addCleanup(self.temp.cleanup)
        self.manager = MediaJobManager(temp_root=self.temp.name)
        self.addCleanup(self.manager.close)

    def start(self, runner):
        return self.manager.start(Path("source.mp4"), (1, "opaque"), [(0, 1000)], runner)

    def test_no_output_completes_without_ready_timer_or_output_file_and_releases_slot(self):
        job = self.start(lambda job: job.complete_without_output())
        job.thread.join(2)
        snapshot = job.snapshot()
        self.assertEqual((snapshot["state"], snapshot["stage"]), ("completed", "no-output"))
        self.assertTrue(snapshot["noOutput"])
        self.assertTrue(snapshot["cleanupComplete"])
        self.assertFalse(job.directory.exists())
        self.assertIsNone(job.timer)
        self.assertIsNone(self.manager.active)
        with self.assertRaises(MediaJobUnavailable):
            self.manager.begin_download(job.id)
        second = self.start(lambda job: job.output.write_bytes(b"normal"))
        second.thread.join(2)
        self.assertEqual(second.snapshot()["state"], "ready")

    def test_cancellation_winning_the_race_does_not_publish_no_output_completion(self):
        waiting, release = threading.Event(), threading.Event()
        def runner(job):
            waiting.set()
            release.wait(2)
            job.complete_without_output()
        job = self.start(runner)
        self.assertTrue(waiting.wait(2))
        self.manager.cancel(job.id)
        release.set()
        job.thread.join(2)
        self.assertEqual(job.snapshot()["state"], "cancelled")
        self.assertNotIn("noOutput", job.snapshot())
        self.assertTrue(job.snapshot()["cleanupComplete"])

    def test_completion_winning_the_race_remains_terminal_when_cancelled(self):
        completed, release = threading.Event(), threading.Event()
        def runner(job):
            job.complete_without_output()
            completed.set()
            release.wait(2)
        job = self.start(runner)
        self.assertTrue(completed.wait(2))
        self.assertEqual(self.manager.cancel(job.id)["state"], "completed")
        release.set()
        job.thread.join(2)
        self.assertEqual(job.snapshot()["state"], "completed")
        self.assertIsNone(job.timer)
        self.assertTrue(job.snapshot()["cleanupComplete"])


class NoOutputHttpTests(unittest.TestCase):
    def setUp(self):
        from tests.test_local_editor_server import server_editor
        self.api = server_editor
        TEMP_ROOT.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=TEMP_ROOT)
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        source = root / "source.mp4"
        source.write_bytes(b"source")
        project = self.api.ServerProject(data={"segments": []}, json_path=root / "project.mosp",
            media_path=source, source_media_path=source, sticker_root=None, stickers=[])
        self.server = self.api.EditorServer(("127.0.0.1", 0), project, no_waveform=True)
        self.server.media_jobs.temp_root = root
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)
        self.base = "/api/exports/gap-removed-video"

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)

    def request(self, suffix="", payload=None):
        request = urllib.request.Request(f"http://127.0.0.1:{self.server.server_address[1]}{self.base}{suffix}",
            data=json.dumps(payload).encode() if payload is not None else None,
            headers={"Content-Type": "application/json", "X-MAW-Request-Token": self.server.request_token})
        try:
            with urllib.request.urlopen(request, timeout=3) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())

    def payload(self):
        return {"requestToken": self.server.request_token, **self.server.project_binding_payload(),
                "intervals": [{"startMs": 0, "endMs": 1000}]}

    def test_polling_returns_completed_timeline_without_download_and_legacy_route_is_explicit(self):
        timeline = {"requestedRemovedMs": 1000, "actualRemovedMs": 0, "retainedGapMs": 1000, "intervals": []}
        def no_output(_source, _intervals, _output, **kwargs):
            if kwargs.get("job"):
                kwargs["job"].video_timeline = timeline
            raise self.api.VideoNoOutput(timeline)
        with mock.patch.object(self.api, "editor_ffmpeg_tools", return_value=mock.Mock(
                ffmpeg=Path("ffmpeg"), ffprobe=Path("ffprobe"))), \
                mock.patch.object(self.api, "rebuild_gap_removed_video", side_effect=no_output):
            status, admitted = self.request("/jobs", self.payload())
            self.assertEqual(status, 202)
            job = self.server.media_jobs.get(admitted["jobId"])
            job.thread.join(2)
            status, result = self.request("/jobs/" + job.id)
            self.assertEqual(status, 200)
            self.assertEqual((result["state"], result["stage"]), ("completed", "no-output"))
            self.assertTrue(result["noOutput"])
            self.assertTrue(result["cleanupComplete"])
            self.assertEqual(result["videoTimeline"], timeline)
            self.assertEqual(self.request("/jobs/" + job.id + "/download")[0], 409)
            self.assertEqual(self.request("/jobs/" + job.id + "/cancel", {"requestToken": self.server.request_token})[1]["state"], "completed")
            status, legacy = self.request(payload=self.payload())
            self.assertEqual(status, 200)
            self.assertTrue(legacy["noOutput"])
            self.assertEqual(legacy["videoTimeline"], timeline)
