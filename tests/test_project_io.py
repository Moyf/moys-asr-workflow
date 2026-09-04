from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from maw.project_io import enrich_project_media_metadata, write_mosp


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
            self.assertEqual(json.loads(output.read_text(encoding="utf-8"))["media_metadata"], metadata)
            raw = output.read_bytes()
            self.assertTrue(raw.endswith(b"\n"))
            self.assertNotIn(b"\r\n", raw)
            self.assertNotIn("media_metadata", project)

    def test_existing_media_metadata_is_preserved_without_reprobing(self) -> None:
        existing = {"video_fps": 24, "video_fps_ratio": "24/1"}
        project = {
            "media": "clip.mp4",
            "media_metadata": existing,
            "segments": [],
        }

        with mock.patch("maw.project_io.probe_video_fps") as probe:
            enriched = enrich_project_media_metadata(project, media_path="other.mp4")

        self.assertEqual(enriched["media_metadata"], existing)
        self.assertIsNot(enriched, project)
        probe.assert_not_called()

    def test_project_media_is_used_when_no_explicit_media_path_is_given(self) -> None:
        project = {"media": "clip.mp4", "segments": []}
        metadata = {"video_fps": 25.0, "video_fps_ratio": "25/1"}

        with mock.patch("maw.project_io.probe_video_fps", return_value=metadata) as probe:
            enriched = enrich_project_media_metadata(project)

        self.assertEqual(enriched["media_metadata"], metadata)
        probe.assert_called_once_with("clip.mp4", ffprobe_path=None)


if __name__ == "__main__":
    unittest.main()
