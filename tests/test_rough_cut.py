from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from maw.rough_cut import (
    RoughCutError,
    build_filter_script,
    normalize_intervals,
    render_rough_cut,
    sanitize_output_stem,
)


class RoughCutTests(unittest.TestCase):
    def test_sanitizes_output_name_and_validates_intervals(self) -> None:
        self.assertEqual(sanitize_output_stem(" 海口/粗剪?.mp4 ", "fallback"), "粗剪_")
        self.assertEqual(sanitize_output_stem("CON", "fallback"), "CON_")
        self.assertEqual(
            normalize_intervals([{"start": 0, "end": 1000}, {"start": 1200, "end": 2000}], 2000),
            [(0, 1000), (1200, 2000)],
        )
        with self.assertRaises(RoughCutError):
            normalize_intervals([{"start": 1000, "end": 1200}, {"start": 1100, "end": 1300}], 2000)

    def test_filter_script_trims_video_audio_and_concats_kept_ranges(self) -> None:
        script = build_filter_script(
            [(0, 1000), (1800, 3000)],
            source_duration_ms=3000,
            has_audio=True,
        )

        self.assertIn("[0:v:0]trim=start=0.000:end=1.000", script)
        self.assertIn("afade=t=out", script)
        self.assertIn("afade=t=in", script)
        self.assertIn("concat=n=2:v=1:a=1[vout][aout]", script)

    def test_render_writes_video_and_srt_without_overwriting(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name)
            source = root / "source.mp4"
            source.write_bytes(b"video")
            (root / "demo.mp4").write_bytes(b"existing")
            (root / "demo.srt").write_text("existing", encoding="utf-8")

            def fake_run(command: list[str], **_: object) -> SimpleNamespace:
                if "-show_entries" in command:
                    return SimpleNamespace(
                        returncode=0,
                        stdout=json.dumps({
                            "format": {"duration": "3.0"},
                            "streams": [{"codec_type": "video"}, {"codec_type": "audio"}],
                        }),
                        stderr="",
                    )
                Path(command[-1]).write_bytes(b"rendered")
                return SimpleNamespace(returncode=0, stdout="", stderr="")

            with mock.patch("maw.rough_cut.subprocess.run", side_effect=fake_run):
                result = render_rough_cut(
                    source=source,
                    project_directory=root,
                    output_name="demo",
                    fallback_stem="source",
                    intervals=[{"start": 0, "end": 1000}, {"start": 1800, "end": 3000}],
                    srt_text="1\n00:00:00,000 --> 00:00:01,000\n保留\n",
                    ffmpeg=Path("ffmpeg"),
                    ffprobe=Path("ffprobe"),
                )

            self.assertEqual(result.video_path.name, "demo-2.mp4")
            self.assertEqual(result.srt_path.name, "demo-2.srt")
            self.assertEqual(result.output_duration_ms, 2200)
            self.assertEqual(result.video_path.read_bytes(), b"rendered")
            self.assertIn("保留", result.srt_path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
