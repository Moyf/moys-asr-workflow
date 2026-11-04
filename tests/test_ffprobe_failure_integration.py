"""Real FFprobe failure compatibility; selected with the media gate."""
from __future__ import annotations

import json
import subprocess
import tempfile
import threading
import unittest
import urllib.request
import wave
from pathlib import Path
from unittest import mock

from maw import media
from maw.ffmpeg import media_duration_seconds
from tests.compact_assertions import CompactContainerAssertions
from tests.test_local_editor_server import server_editor


class FFprobeFailureIntegrationTests(CompactContainerAssertions, unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.enterContext(mock.patch.dict("os.environ", {"MAW_APP_DATA_ROOT": str(self.root / "app")}))
        self.ffprobe = media.find_ffprobe()
        if self.ffprobe is None:
            self.skipTest("Real FFprobe is required for failure compatibility")
        self.source = self.root / "broken.mp4"
        self.source.write_bytes(b"0123456789")
        self.failures = []
        real_run = subprocess.run

        def observe(command, *args, **kwargs):
            # Observe the actual executable and its error; supply no fake result.
            try:
                return real_run(command, *args, **kwargs)
            except subprocess.CalledProcessError as error:
                if Path(command[0]).stem.lower() == "ffprobe":
                    self.failures.append((command, error.returncode))
                raise

        self.enterContext(mock.patch.object(subprocess, "run", side_effect=observe))

    def assert_failed_audio_and_video_probes(self):
        self.assertTrue(self.failures, "FFprobe must actually fail on the broken file")
        streams = set()
        for command, returncode in self.failures:
            self.assertNotEqual(returncode, 0)
            self.assertIn(str(self.source), command)
            if "-select_streams" in command:
                streams.add(command[command.index("-select_streams") + 1])
        self.assertTrue({"v:0", "a"}.issubset(streams))

    def test_real_bad_file_probes_return_unknown_information(self):
        self.assertIsNone(media.probe_video_fps(self.source, ffprobe_path=self.ffprobe))
        self.assertIsNone(media.probe_audio_tracks(self.source, ffprobe_path=self.ffprobe))
        self.assertIsNone(media_duration_seconds(self.source, ffprobe_path=self.ffprobe))
        self.assert_failed_audio_and_video_probes()
        self.assertTrue(any("format=duration" in command for command, _ in self.failures))

        # Positive control for the known WAV metadata used by binding fixtures.
        known = self.root / "known.wav"
        with wave.open(str(known), "wb") as stream:
            stream.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
            stream.writeframes(b"\0\0" * 800)
        self.assertEqual(media.probe_audio_tracks(known, ffprobe_path=self.ffprobe), [
            {"audio_index": 0, "stream_index": 0, "codec": "pcm_s16le", "channels": 1,
             "sample_rate": 8000, "language": "", "title": "", "default": False}])
        self.assertAlmostEqual(media_duration_seconds(known, ffprobe_path=self.ffprobe), 0.1, places=3)

    def test_real_bad_file_can_load_and_save_after_probe_failure(self):
        project_path = self.root / "project.mosp"
        project_path.write_text(json.dumps({"media": self.source.name, "segments": [
            {"start": 0, "end": 1000, "text": "before"}]}), encoding="utf-8")
        original_project = project_path.read_bytes()
        original_media = self.source.read_bytes()
        project = server_editor.load_project(
            project_path, None, str(self.root), no_waveform=True, peaks_per_second=100)
        self.assertNotIn("media_metadata", project.data)
        self.assertEqual(project.data["segments"][0]["text"], "before")
        self.assert_failed_audio_and_video_probes()

        server = server_editor.EditorServer(("127.0.0.1", 0), project,
            no_waveform=True, settings_path=self.root / "settings.json")
        self.addCleanup(server.server_close)
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()

        def stop():
            server.shutdown()
            thread.join(3)
            self.assertFalse(thread.is_alive())

        self.addCleanup(stop)
        binding = server.project_binding_payload()
        self.assertFalse(binding["thumbnailBaseReady"])
        incoming = {"media": self.source.name, "segments": [
            {"start": 0, "end": 1000, "text": "after"}]}
        request = urllib.request.Request(
            f"http://127.0.0.1:{server.server_address[1]}/api/project",
            data=json.dumps({**binding, "project": incoming, "filename": None}).encode(),
            headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(request, timeout=5) as response:
            self.assertEqual(response.status, 200)
            result = json.loads(response.read())
        self.assertTrue(result["ok"])
        self.assertIsNotNone(result["backup"])
        self.assertEqual((self.root / result["backup"]).read_bytes(), original_project)
        saved = json.loads(project_path.read_text(encoding="utf-8"))
        self.assertEqual(saved["segments"][0]["text"], "after")
        self.assertEqual(server.project.data["segments"][0]["text"], "after")
        self.assertEqual(self.source.read_bytes(), original_media)
        self.assertNotIn("media_metadata", saved)
