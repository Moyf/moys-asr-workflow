"""Independent lifecycle check for a slow local video download during exit."""

from __future__ import annotations

import time
import urllib.request
import unittest
from pathlib import Path
from unittest import mock

from tests import test_gap_removed_media_jobs as fixtures


class MediaJobShutdownTests(unittest.TestCase):
    def setUp(self):
        fixture = fixtures.MediaJobsHttpTests()
        fixture.setUp()
        self.addCleanup(fixture.tearDown)
        for attribute in ("server_editor", "server", "origin", "base", "request", "payload", "wait"):
            setattr(self, attribute, getattr(fixture, attribute))

    def test_shutdown_waits_for_open_download_disposal(self):
        tools = mock.Mock(ffmpeg=Path("ffmpeg"), ffprobe=Path("ffprobe"))

        def rebuild(source, intervals, output, **kwargs):
            with output.open("wb") as stream:
                stream.truncate(32 * 1024 * 1024)

        response = None
        job = None
        try:
            with mock.patch.object(self.server_editor, "editor_ffmpeg_tools", return_value=tools), \
                 mock.patch.object(self.server_editor, "rebuild_gap_removed_video", side_effect=rebuild):
                _, snapshot = self.request(self.base, self.payload())
                self.wait(snapshot["jobId"], "ready")
                job = self.server.media_jobs.get(snapshot["jobId"])
                request = urllib.request.Request(self.origin + self.base + "/" + job.id + "/download",
                    headers={"X-MAW-Request-Token": self.server.request_token})
                response = urllib.request.urlopen(request, timeout=3)
                # Keep the client open and do not consume its large body, forcing
                # the real HTTP worker to retain a private output file handle.
                time.sleep(.1)
                self.assertEqual(job.state, "downloading")
                self.server.shutdown()
                self.server.server_close()
                self.assertTrue(job.disposed, "server exit must wait for its open download cleanup")
                self.assertFalse(job.directory.exists())
                self.assertIsNone(self.server.media_jobs.active)
        finally:
            if response is not None:
                response.close()
            if job is not None:
                deadline = time.monotonic() + 5
                while not job.disposed and time.monotonic() < deadline:
                    time.sleep(.01)
