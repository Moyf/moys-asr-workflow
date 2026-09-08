from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from maw.media import resolve_default_audio_track
from maw.project import PROJECT_SCHEMA
from maw.project_io import (
    default_audio_track_from_metadata,
    enrich_project_media_metadata,
    selected_audio_track_from_metadata,
    write_mosp,
)


class ProjectIoTests(unittest.TestCase):
    def test_write_mosp_enriches_project_once_and_writes_utf8_lf(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            media = root / "clip.mp4"
            output = root / "nested" / "clip.mosp"
            ffprobe = root / "ffprobe.exe"
            project = {
                "media": str(media),
                "segments": [],
                "language": "中文",
            }
            metadata = {
                "video_fps": 30000 / 1001,
                "video_fps_ratio": "30000/1001",
            }

            with mock.patch("maw.project_io.probe_video_fps", return_value=metadata) as probe:
                result = write_mosp(
                    output,
                    project,
                    media_path=media,
                    ffprobe_path=ffprobe,
                )

            self.assertEqual(result, output)
            probe.assert_called_once_with(media, ffprobe_path=ffprobe)
            saved = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(saved["schema"], PROJECT_SCHEMA)
            self.assertEqual(saved["media_metadata"], metadata)
            self.assertEqual(list(saved)[:3], ["schema", "media", "media_metadata"])
            raw = output.read_bytes()
            self.assertTrue(raw.endswith(b"\n"))
            self.assertNotIn(b"\r\n", raw)
            self.assertNotIn("media_metadata", project)

    def test_write_mosp_replaces_missing_or_stale_schema_with_current_schema(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir) / "project.mosp"

            write_mosp(output, {"schema": "moy.asr.project.draft", "segments": []})

            saved = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(saved["schema"], PROJECT_SCHEMA)

    def test_write_mosp_persists_selected_audio_track_without_caches(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir) / "project.mosp"

            with (
                mock.patch("maw.project_io.probe_video_fps", return_value=None),
                mock.patch("maw.project_io.probe_audio_tracks", return_value=None),
            ):
                write_mosp(
                    output,
                    {"media": "clip.mp4", "segments": []},
                    selected_audio_track=2,
                )

            saved = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(saved["media_metadata"]["selected_audio_track"], 2)

    def test_existing_media_metadata_is_preserved_without_reprobing(self) -> None:
        existing = {"video_fps": 24, "video_fps_ratio": "24/1"}
        project = {
            "media": "clip.mp4",
            "segments": [],
            "language": "en",
            "media_metadata": existing,
        }

        with mock.patch("maw.project_io.probe_video_fps") as probe:
            enriched = enrich_project_media_metadata(project, media_path="other.mp4")

        self.assertEqual(enriched["media_metadata"], existing)
        self.assertEqual(list(enriched), ["media", "segments", "language", "media_metadata"])
        self.assertIsNot(enriched, project)
        probe.assert_not_called()

    def test_project_media_is_used_when_no_explicit_media_path_is_given(self) -> None:
        project = {"media": "clip.mp4", "segments": []}
        metadata = {"video_fps": 25.0, "video_fps_ratio": "25/1"}

        with mock.patch("maw.project_io.probe_video_fps", return_value=metadata) as probe:
            enriched = enrich_project_media_metadata(project)

        self.assertEqual(enriched["media_metadata"], metadata)
        probe.assert_called_once_with("clip.mp4", ffprobe_path=None)

    def test_enriches_existing_video_metadata_with_audio_track_inventory(self) -> None:
        media = Path("clip.mp4")
        tracks = [{
            "audio_index": 0,
            "stream_index": 1,
            "codec": "aac",
            "channels": 2,
            "sample_rate": 48000,
            "language": "zh",
            "title": "中文",
            "default": True,
        }]
        project = {
            "media": str(media),
            "segments": [],
            "media_metadata": {"video_fps": 24.0, "video_fps_ratio": "24/1"},
        }

        with mock.patch("maw.project_io.probe_video_fps") as video_probe:
            with mock.patch("maw.project_io.probe_audio_tracks", return_value=tracks) as audio_probe:
                enriched = enrich_project_media_metadata(project, media_path=media, ffprobe_path="ffprobe")

        self.assertEqual(enriched["media_metadata"]["audio_tracks"], tracks)
        self.assertEqual(enriched["media_metadata"]["video_fps"], 24.0)
        video_probe.assert_not_called()
        audio_probe.assert_called_once_with(media, ffprobe_path="ffprobe")

    def test_audio_track_identity_uses_selected_and_default_metadata(self) -> None:
        metadata = {
            "selected_audio_track": 0,
            "audio_tracks": [
                {"audio_index": 0, "stream_index": 1, "default": False},
                {"audio_index": 1, "stream_index": 2, "default": True},
            ],
        }

        self.assertEqual(selected_audio_track_from_metadata(metadata), 0)
        self.assertEqual(default_audio_track_from_metadata(metadata), 1)

    def test_default_audio_track_without_disposition_is_zero(self) -> None:
        metadata = {
            "audio_tracks": [
                {"audio_index": 0, "stream_index": 1, "default": False},
                {"audio_index": 1, "stream_index": 2, "default": False},
            ],
        }

        self.assertEqual(default_audio_track_from_metadata(metadata), 0)

    def test_resolve_default_audio_track_probes_when_cli_value_is_missing(self) -> None:
        tracks = [
            {"audio_index": 0, "default": False},
            {"audio_index": 1, "default": True},
        ]

        with mock.patch("maw.media.probe_audio_tracks", return_value=tracks) as probe:
            result = resolve_default_audio_track(
                "clip.mp4",
                None,
                ffprobe_path="ffprobe",
            )

        self.assertEqual(result, 1)
        probe.assert_called_once_with("clip.mp4", ffprobe_path="ffprobe")

    def test_resolve_default_audio_track_uses_explicit_cli_value_without_probe(self) -> None:
        with mock.patch("maw.media.probe_audio_tracks") as probe:
            result = resolve_default_audio_track("clip.mp4", 2, ffprobe_path="ffprobe")

        self.assertEqual(result, 2)
        probe.assert_not_called()


if __name__ == "__main__":
    unittest.main()
