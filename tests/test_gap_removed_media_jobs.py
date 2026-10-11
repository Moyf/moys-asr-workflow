from __future__ import annotations

import subprocess
import hashlib
import json
import shutil
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
import urllib.error
from unittest import mock
from pathlib import Path

from maw.media_jobs import (MAX_MEDIA_JOB_STDERR_BYTES, MediaJobBusy,
                            MediaJobManager, MediaJobUnavailable)


class MediaJobsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1] / ".debug-runs")
        self.manager = MediaJobManager(temp_root=self.temp.name)
        self.source = Path("source.mp4")

    def tearDown(self):
        self.manager.close()
        self.temp.cleanup()

    def start(self, runner):
        return self.manager.start(self.source, (7, "opaque-source"), [(0, 1000)], runner)

    def wait(self, job, state):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if job.snapshot()["state"] == state:
                return
            if job.snapshot()["state"] == "failed":
                break
            time.sleep(0.01)
        self.assertEqual(job.snapshot()["state"], state, job.error)

    def test_ready_download_owns_slot_and_completion_is_stable(self):
        job = self.start(lambda job: job.output.write_bytes(b"media"))
        self.wait(job, "ready")
        with self.assertRaises(MediaJobBusy):
            self.start(lambda _: None)
        self.assertEqual(job.snapshot()["bindingGeneration"], 7)
        self.assertEqual(job.snapshot()["sourceMediaId"], "opaque-source")
        self.manager.begin_download(job.id)
        with self.assertRaises(MediaJobUnavailable):
            self.manager.begin_download(job.id)
        self.manager.finish_download(job, success=True)
        self.assertFalse(job.directory.exists())
        self.assertEqual(self.manager.cancel(job.id)["state"], "completed")
        self.assertIsNone(self.manager.active)

    def test_real_process_is_killed_and_waited_before_slot_release(self):
        started = threading.Event()
        def runner(job):
            job.output.write_bytes(b"partial")
            started.set()
            job.run_command([sys.executable, "-c", "import time; time.sleep(60)"])
        job = self.start(runner)
        self.assertTrue(started.wait(2))
        deadline = time.monotonic() + 2
        while job.process is None and time.monotonic() < deadline:
            time.sleep(0.01)
        process = job.process
        self.assertIsNotNone(process)
        self.manager.cancel(job.id)
        self.manager.cancel(job.id)
        self.wait(job, "cancelled")
        job.thread.join(2)
        self.assertIsNotNone(process.poll())
        self.assertFalse(job.directory.exists())
        retry = self.start(lambda _: None)
        self.wait(retry, "ready")

    def test_cancel_wins_late_success_and_intervals_are_frozen(self):
        started, release = threading.Event(), threading.Event()
        def runner(job):
            started.set()
            release.wait(2)
            job.output.write_bytes(b"late result")
        intervals = [(0, 1000)]
        job = self.manager.start(self.source, (1, "id"), intervals, runner)
        intervals.clear()
        self.assertEqual(job.intervals, ((0, 1000),))
        self.assertTrue(started.wait(2))
        self.assertEqual(self.manager.cancel(job.id)["state"], "cancelling")
        with self.assertRaises(MediaJobBusy):
            self.start(lambda _: None)
        release.set()
        self.wait(job, "cancelled")
        self.assertFalse(job.output.exists())

    def test_download_cancel_defers_cleanup_until_open_stream_closes(self):
        job = self.start(lambda job: job.output.write_bytes(b"media"))
        self.wait(job, "ready")
        self.manager.begin_download(job.id)
        self.assertEqual(self.manager.cancel(job.id)["state"], "cancelling")
        self.assertTrue(job.output.exists())
        self.manager.finish_download(job, success=True)
        self.assertEqual(job.state, "cancelled")
        self.assertFalse(job.directory.exists())

    def test_failure_and_timeout_clean_partial_output(self):
        def fail(job):
            job.output.write_bytes(b"partial")
            job.run_command([sys.executable, "-c", "import time; time.sleep(60)"], timeout=0.1)
        job = self.start(fail)
        self.wait(job, "failed")
        self.assertFalse(job.directory.exists())
        self.assertIn("timed out", job.error)

    def test_abandoned_ready_task_expires(self):
        self.manager.ready_timeout = 0.05
        job = self.start(lambda job: job.output.write_bytes(b"media"))
        self.wait(job, "cancelled")
        self.assertFalse(job.directory.exists())

    def test_queued_expiry_cannot_cancel_an_accepted_download(self):
        job = self.start(lambda job: job.output.write_bytes(b"media"))
        self.wait(job, "ready")
        entered = threading.Event()
        def expire():
            entered.set()
            self.manager._expire_ready(job.id)
        with self.manager.lock:
            expiry = threading.Thread(target=expire)
            expiry.start()
            self.assertTrue(entered.wait(2))
            self.manager.begin_download(job.id)
        expiry.join(2)
        self.assertFalse(expiry.is_alive())
        self.assertEqual(job.state, "downloading")
        self.assertFalse(job.cancelled.is_set())
        self.manager.finish_download(job, success=True)
        self.assertEqual(job.state, "completed")

    def test_giant_stdout_line_fails_with_explicit_size_error(self):
        job = self.start(lambda job: job.run_command([sys.executable, "-c",
            "import sys; sys.stdout.write('x' * (8*1024*1024)); sys.stdout.flush()"] ))
        self.wait(job, "failed")
        self.assertIn("标准输出超过安全大小上限", job.error)
        self.assertFalse(job.directory.exists())

    def test_giant_unicode_stderr_line_retains_only_bounded_diagnostics(self):
        captured = []
        def runner(job):
            captured.append(job.run_command([sys.executable, "-c",
                "import sys; sys.stderr.write('界' * (1024*1024)); sys.stderr.flush()"] ))
        job = self.start(runner)
        self.wait(job, "ready")
        self.assertEqual(captured[0].returncode, 0)
        self.assertGreater(len(captured[0].stderr), 0)
        self.assertLessEqual(len(captured[0].stderr.encode("utf-8")), MAX_MEDIA_JOB_STDERR_BYTES)

    def test_descendant_inheriting_pipes_is_reaped_after_parent_exits(self):
        def runner(job):
            job.run_command([sys.executable, "-c",
                "import subprocess,sys,time; subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']); time.sleep(.1)"])
        job = self.start(runner)
        self.wait(job, "ready")
        self.assertIsNone(job.process)

    def test_shutdown_cancels_and_refuses_new_jobs(self):
        started = threading.Event()
        def runner(job):
            started.set()
            job.cancelled.wait(5)
            job.check_cancelled()
        job = self.start(runner)
        self.assertTrue(started.wait(2))
        self.manager.close()
        self.assertEqual(job.state, "cancelled")
        self.assertFalse(job.directory.exists())
        with self.assertRaises(MediaJobUnavailable):
            self.start(lambda _: None)

    def test_cleanup_failure_keeps_slot_and_retry_disposes_result(self):
        job = self.start(lambda job: job.output.write_bytes(b"media"))
        self.wait(job, "ready")
        with mock.patch("maw.media_jobs.shutil.rmtree", side_effect=PermissionError("locked output")):
            self.manager.cancel(job.id)
            self.assertFalse(job.disposed)
            self.assertEqual(job.state, "failed")
            self.assertIsNotNone(job.cleanup_error)
            with self.assertRaises(MediaJobBusy):
                self.start(lambda _: None)
        self.manager.cancel(job.id)
        self.assertTrue(job.disposed)
        self.assertIsNone(self.manager.active)

    def test_real_progress_pipe_is_drained_during_process_execution(self):
        observed = threading.Event()
        def runner(job):
            job.update("rebuilding")
            result = job.run_command([sys.executable, "-u", "-c",
                "import time; print('out_time_us=500000', flush=True); time.sleep(.3)"], duration_ms=1000)
            self.assertEqual(result.returncode, 0)
        job = self.start(runner)
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline and job.state == "running":
            if job.snapshot()["progress"] == .5:
                observed.set()
                break
            time.sleep(.01)
        self.assertTrue(observed.is_set())
        self.wait(job, "ready")

    @unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg unavailable")
    def test_real_ffmpeg_cancel_removes_output_without_changing_source(self):
        source = Path(self.temp.name) / "source.mp4"
        source.write_bytes(b"immutable source sentinel")
        before = hashlib.sha256(source.read_bytes()).digest()
        def runner(job):
            job.update("rebuilding")
            job.run_command([shutil.which("ffmpeg"), "-y", "-nostdin", "-v", "error", "-re",
                "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=10", "-t", "30", "-c:v", "mpeg4",
                "-progress", "pipe:1", str(job.output)], duration_ms=30000)
        job = self.manager.start(source, (1, "id"), [(0, 30000)], runner)
        deadline = time.monotonic() + 5
        while job.snapshot()["progress"] is None and time.monotonic() < deadline:
            time.sleep(.01)
        process = job.process
        self.assertIsNotNone(job.snapshot()["progress"])
        self.assertIsNotNone(process)
        self.manager.cancel(job.id)
        self.wait(job, "cancelled")
        self.assertIsNotNone(process.poll())
        self.assertFalse(job.output.exists())
        self.assertEqual(hashlib.sha256(source.read_bytes()).digest(), before)

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg tools unavailable")
    def test_real_stream_copy_mp4_mkv_ts_multitrack_and_nonzero_origin(self):
        from tests.test_local_editor_server import server_editor
        ffmpeg, ffprobe = Path(shutil.which("ffmpeg")), Path(shutil.which("ffprobe"))
        for extension in (".mp4", ".mkv", ".ts"):
            with self.subTest(extension=extension):
                source = Path(self.temp.name) / ("source" + extension)
                generated = subprocess.run([str(ffmpeg), "-y", "-nostdin", "-v", "error",
                    "-f", "lavfi", "-i", "testsrc2=size=96x64:rate=10",
                    "-f", "lavfi", "-i", "sine=frequency=400:sample_rate=48000",
                    "-f", "lavfi", "-i", "sine=frequency=800:sample_rate=48000",
                    "-t", "2", "-map", "0:v", "-map", "1:a", "-map", "2:a",
                    "-c:v", "libx264", "-g", "1", "-c:a", "aac",
                    "-metadata:s:a:0", "language=eng", "-metadata:s:a:0", "title=English",
                    "-metadata:s:a:1", "language=deu", "-metadata:s:a:1", "title=German",
                    "-disposition:a:0", "0", "-disposition:a:1", "default",
                    "-output_ts_offset", "5", str(source)], capture_output=True, timeout=15)
                self.assertEqual(generated.returncode, 0, generated.stderr.decode(errors="replace")[-2000:])
                before = hashlib.sha256(source.read_bytes()).digest()
                source_probe = server_editor._probe_gap_removed_video(source, ffprobe)
                self.assertGreater(source_probe.start_time, 0)
                self.assertEqual(len(source_probe.streams), 3)
                def runner(job):
                    original_match = server_editor._gap_removed_video_streams_match
                    def compare(expected, actual):
                        if original_match(expected, actual):
                            return True
                        differences = []
                        for i, (left, right) in enumerate(zip(expected, actual)):
                            for key in left._fields:
                                if getattr(left, key) != getattr(right, key):
                                    differences.append(f"stream {i} {key}: {getattr(left, key)} -> {getattr(right, key)}")
                        raise RuntimeError("\n".join(differences))
                    try:
                        with mock.patch.object(server_editor, "_gap_removed_video_streams_match", side_effect=compare):
                            server_editor.rebuild_gap_removed_video(job.source, list(job.intervals), job.output,
                                ffmpeg_path=ffmpeg, ffprobe_path=ffprobe, job=job)
                    except Exception as error:
                        raise RuntimeError(f"{error}; source streams={source_probe.streams}") from error
                job = self.manager.start(source, (1, "id"), [(0, 500), (1000, 1500)], runner)
                self.wait(job, "ready")
                output_probe = server_editor._probe_gap_removed_video(job.output, ffprobe)
                self.assertTrue(server_editor._gap_removed_video_streams_match(source_probe.streams, output_probe.streams))
                self.assertEqual(hashlib.sha256(source.read_bytes()).digest(), before)
                self.manager.cancel(job.id)


class MediaJobsHttpTests(unittest.TestCase):
    def setUp(self):
        from tests.test_local_editor_server import server_editor
        self.server_editor = server_editor
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1] / ".debug-runs")
        self.root = Path(self.temp.name)
        self.source = self.root / "source.mp4"
        self.source.write_bytes(b"unchanged source")
        project = server_editor.ServerProject(data={"segments": []}, json_path=self.root / "project.json",
            media_path=self.source, source_media_path=self.source, sticker_root=None, stickers=[])
        self.server = server_editor.EditorServer(("127.0.0.1", 0), project, no_waveform=True)
        self.server.media_jobs.temp_root = self.root
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.base = "/api/exports/gap-removed-video/jobs"

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

    def payload(self):
        return {"requestToken": self.server.request_token, **self.server.project_binding_payload(),
                "intervals": [{"startMs": 0, "endMs": 1000}]}

    def wait(self, job_id, state):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            status, result = self.request(self.base + "/" + job_id)
            if result["state"] == state:
                return result
            time.sleep(.01)
        self.assertEqual(result["state"], state)

    def test_http_job_bound_snapshot_download_and_token(self):
        captured = {}
        def rebuild(source, intervals, output, **kwargs):
            captured["source"] = source
            captured["intervals"] = intervals
            output.write_bytes(b"verified-video")
        tools = mock.Mock(ffmpeg=Path("ffmpeg"), ffprobe=Path("ffprobe"))
        with mock.patch.object(self.server_editor, "editor_ffmpeg_tools", return_value=tools), \
             mock.patch.object(self.server_editor, "rebuild_gap_removed_video", side_effect=rebuild):
            payload = self.payload()
            payload["sourceMediaPath"] = "untrusted.mp4"
            status, job = self.request(self.base, payload)
            self.assertEqual(status, 202)
            job_id = job["jobId"]
            self.wait(job_id, "ready")
            self.assertEqual(self.request(self.base + "/" + job_id, token=False)[0], 403)
            self.assertEqual(self.request(self.base, self.payload())[0], 409)
            self.assertEqual(self.request(self.base + "/" + job_id + "/download"), (200, b"verified-video"))
            self.wait(job_id, "completed")
            self.assertEqual(captured["source"], self.source)
            self.assertEqual(captured["intervals"], [(0, 1000)])
            self.assertEqual(self.source.read_bytes(), b"unchanged source")
            self.assertEqual(self.request(self.base + "/" + job_id + "/download")[0], 409)

    def test_stale_binding_is_rejected_before_task_admission(self):
        payload = self.payload()
        payload["bindingGeneration"] += 1
        with mock.patch.object(self.server_editor, "editor_ffmpeg_tools", side_effect=AssertionError("must not start")):
            self.assertEqual(self.request(self.base, payload)[0], 409)
        self.assertIsNone(self.server.media_jobs.active)

    def test_rebinding_prevents_old_ready_result_download(self):
        tools = mock.Mock(ffmpeg=Path("ffmpeg"), ffprobe=Path("ffprobe"))
        def rebuild(source, intervals, output, **kwargs):
            output.write_bytes(b"old result")
        with mock.patch.object(self.server_editor, "editor_ffmpeg_tools", return_value=tools), \
             mock.patch.object(self.server_editor, "rebuild_gap_removed_video", side_effect=rebuild):
            _, job = self.request(self.base, self.payload())
            self.wait(job["jobId"], "ready")
            with self.server.settings_lock:
                self.server._bind_project_locked(self.server.project)
            self.assertEqual(self.request(self.base + "/" + job["jobId"] + "/download")[0], 409)
            self.assertEqual(self.server.media_jobs.get(job["jobId"]).state, "cancelled")

    def test_http_cancel_waits_for_background_cleanup_and_retry(self):
        started = threading.Event()
        def rebuild(source, intervals, output, **kwargs):
            output.write_bytes(b"partial")
            started.set()
            kwargs["job"].cancelled.wait(3)
            kwargs["job"].check_cancelled()
        tools = mock.Mock(ffmpeg=Path("ffmpeg"), ffprobe=Path("ffprobe"))
        with mock.patch.object(self.server_editor, "editor_ffmpeg_tools", return_value=tools), \
             mock.patch.object(self.server_editor, "rebuild_gap_removed_video", side_effect=rebuild):
            status, job = self.request(self.base, self.payload())
            self.assertEqual(status, 202)
            self.assertTrue(started.wait(2))
            job_id = job["jobId"]
            cancel_path = self.base + "/" + job_id + "/cancel"
            self.assertEqual(self.request(cancel_path, {"requestToken": "wrong"})[0], 403)
            self.assertEqual(self.request(cancel_path, {"requestToken": self.server.request_token})[0], 200)
            self.wait(job_id, "cancelled")
            self.assertFalse(self.server.media_jobs.get(job_id).directory.exists())
            self.assertEqual(self.request(cancel_path, {"requestToken": self.server.request_token})[1]["state"], "cancelled")
            self.assertEqual(self.request(self.base + "/" + job_id + "/download")[0], 409)
            self.assertEqual(self.source.read_bytes(), b"unchanged source")
            self.assertEqual(self.request(self.base, self.payload())[0], 202)

    def test_http_download_disconnect_releases_slot_and_private_file(self):
        tools = mock.Mock(ffmpeg=Path("ffmpeg"), ffprobe=Path("ffprobe"))
        def rebuild(source, intervals, output, **kwargs):
            with output.open("wb") as stream:
                stream.truncate(32 * 1024 * 1024)
        with mock.patch.object(self.server_editor, "editor_ffmpeg_tools", return_value=tools), \
             mock.patch.object(self.server_editor, "rebuild_gap_removed_video", side_effect=rebuild):
            _, job = self.request(self.base, self.payload())
            self.wait(job["jobId"], "ready")
            request = urllib.request.Request(self.origin + self.base + "/" + job["jobId"] + "/download",
                headers={"X-MAW-Request-Token": self.server.request_token})
            with urllib.request.urlopen(request, timeout=3) as response:
                response.read(1)
            self.wait(job["jobId"], "cancelled")
            self.assertFalse(self.server.media_jobs.get(job["jobId"]).directory.exists())
            self.assertIsNone(self.server.media_jobs.active)


if __name__ == "__main__":
    unittest.main()
