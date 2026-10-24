"""Small independent fixtures for the test oracle's sparse pixel metrics."""
from __future__ import annotations

import hashlib
import importlib.util
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest import mock

from PIL import Image

from tests.compact_assertions import CompactContainerAssertions


spec = importlib.util.spec_from_file_location(
    "ass_stacking_pixel_oracle",
    Path(__file__).parent / "helpers" / "ass-stacking-pixel-oracle.py",
)
oracle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oracle)


class SeriesRendererTests(CompactContainerAssertions, unittest.TestCase):
    def test_automatic_dialogue_uses_independent_frames_and_preserves_artifact_names(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "automatic.ass"
            source.write_text("PlayResX: 16\nPlayResY: 12\n"
                              "Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,{\\t(0,1000,\\fs40)}Clock\n",
                              encoding="utf-8")
            calls = []

            def render(path, target, width, height, time_ms):
                calls.append((path.name, target.name, time_ms))
                image = Image.new("RGB", (width, height))
                image.save(target)
                target.with_suffix(".ffmpeg.log").write_text(f"actual frame {time_ms}\n", encoding="utf-8")
                return image, [f"fontselect: {time_ms}"]

            with mock.patch.object(oracle, "render", side_effect=render), mock.patch.object(
                    oracle, "render_series", side_effect=AssertionError("automatic layout must start fresh per frame")):
                rows = oracle.inspect_series(source, [500, 1501], root / "sample", padding=2)
            self.assertEqual(calls, [
                ("automatic.ass", "sample-0.png", 500), ("sample-guard.ass", "sample-guard-0.png", 500),
                ("automatic.ass", "sample-1.png", 1501), ("sample-guard.ass", "sample-guard-1.png", 1501),
            ])
            self.assertEqual([row["fontSelections"] for row in rows], [["fontselect: 500"], ["fontselect: 1501"]])
            self.assertEqual([row["guardFontSelections"] for row in rows], [["fontselect: 500"], ["fontselect: 1501"]])
            for suffix in ("", "-guard"):
                log = (root / f"sample{suffix}.ffmpeg.log").read_text(encoding="utf-8")
                self.assertIn("actual frame 500", log)
                self.assertIn("actual frame 1501", log)
                for index in (0, 1):
                    self.assertTrue((root / f"sample{suffix}-{index}.png").is_file())
                    self.assertTrue((root / f"sample{suffix}-{index}.ffmpeg.log").is_file())

    def test_series_fast_path_requires_effective_top_level_position_tags(self):
        dialogue = "Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,"
        for text, safe in ((r"{\an2\pos(10,20)\fs40}Clock", True),
                           (r"{\move(10,20,30,40,500,501)}Clock", True),
                           (r"{\fade(255,0,255,0,1000,1500,2000)\t(0,1000,2,\fs120)}Clock", False),
                           (r"{\t(0,1000,\pos(10,20))}Clock", False),
                           (r"Clock \pos(10,20)", False)):
            with self.subTest(text=text):
                self.assertEqual(oracle._can_render_series(dialogue + text), safe)
        self.assertFalse(oracle._can_render_series(dialogue + r"{\pos(10,20)}Fixed" + "\n" + dialogue + "Automatic"))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "fixed.ass"
            source.write_text("PlayResX: 16\nPlayResY: 12\n" + dialogue + r"{\pos(10,20)}Fixed", encoding="utf-8")
            calls = []

            def render_series(path, stem, width, height, times):
                calls.append((path.name, stem.name, list(times)))
                for index in range(len(times)):
                    Image.new("RGB", (width, height)).save(stem.with_name(f"{stem.name}-{index}.png"))
                return []

            with mock.patch.object(oracle, "render_series", side_effect=render_series), mock.patch.object(
                    oracle, "render", side_effect=AssertionError("fixed positions keep the two-process fast path")):
                oracle.inspect_series(source, [500, 1501], root / "fixed-series", padding=2)
            self.assertEqual(calls, [("fixed.ass", "fixed-series", [500, 1501]),
                                     ("fixed-series-guard.ass", "fixed-series-guard", [500, 1501])])

    @unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg is required")
    def test_automatic_collision_frames_match_fresh_scalar_native_and_guard(self):
        # Real overlapping cues and changing text size exercise libass's own
        # automatic placement; no MAW anchor calculation supplies expectations.
        source = """[Script Info]
ScriptType: v4.00+
PlayResX: 320
PlayResY: 180
WrapStyle: 0
ScaledBorderAndShadow: yes
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H000000FF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,20,20,20,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,{\\t(0,1000,2,\\fs48)}Clock
Dialogue: 0,0:00:00.50,0:00:02.00,Default,,0,0,0,,Second cue
"""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "collision.ass"
            path.write_text(source, encoding="utf-8")
            times = [750, 1501]
            series = oracle.inspect_series(path, times, root / "series", padding=32)
            for index, time_ms in enumerate(times):
                scalar = oracle.inspect(path, time_ms, root / f"scalar-{index}", padding=32)
                # libass's diagnostic prefix includes this process's address.
                # Compare face decisions, while retaining the original logs.
                for key in ("fontSelections", "guardFontSelections"):
                    self.assertEqual([line.split("fontselect:", 1)[-1] for line in series[index][key]],
                                     [line.split("fontselect:", 1)[-1] for line in scalar[key]])
                self.assertEqual({key: value for key, value in series[index].items()
                                  if key not in ("fontSelections", "guardFontSelections")},
                                 {key: value for key, value in scalar.items()
                                  if key not in ("fontSelections", "guardFontSelections")})
                self.assertGreater(scalar["fullPainted"], 0)
                for series_name, scalar_name in (
                    (f"series-{index}.png", f"scalar-{index}.png"),
                    (f"series-guard-{index}.png", f"scalar-{index}-guard.png"),
                ):
                    with Image.open(root / series_name) as actual, Image.open(root / scalar_name) as expected:
                        self.assertEqual(actual.size, expected.size)
                        self.assertEqual(actual.tobytes(), expected.tobytes())


class SparsePixelMetricsTests(unittest.TestCase):
    def test_sparse_bands_gaps_thresholds_and_padding_preserve_all_metrics(self):
        """Given known RGB pixels, inspect sparse/empty roles without inferring expected bounds from the oracle."""
        image = Image.new("RGB", (9, 8))
        for point, colour in (
            ((2, 1), (255, 0, 0)), ((3, 1), (200, 0, 0)),
            ((2, 2), (255, 0, 0)), ((4, 5), (255, 0, 0)),
            ((1, 4), (0, 240, 0)), ((1, 5), (0, 240, 0)),
            ((0, 0), (60, 0, 0)), ((7, 0), (0, 0, 60)),
            ((8, 7), (31, 0, 61)),  # Exactly 30 dominance is not painted.
        ):
            image.putpixel(point, colour)
        red, dark_red, black = (255, 0, 0), (200, 0, 0), (0, 0, 0)
        main_glyph = bytes(channel for pixel in (
            red, dark_red, black,
            red, black, black,
            black, black, black,
            black, black, black,
            black, black, red,
        ) for channel in pixel)
        for padding in (0, 2, 256):
            with self.subTest(padding=padding):
                self.assertEqual(oracle.boxes(image, padding), {
                    "main": {
                        "box": [2 - padding, 1 - padding, 5 - padding, 6 - padding],
                        "painted": 4,
                        "bands": [[1 - padding, 3 - padding], [5 - padding, 6 - padding]],
                        "maxRowPainted": 2, "peak": 255,
                        "glyphSha256": hashlib.sha256(main_glyph).hexdigest(),
                    },
                    "extension": {
                        "box": [1 - padding, 4 - padding, 2 - padding, 6 - padding],
                        "painted": 2, "bands": [[4 - padding, 6 - padding]],
                        "maxRowPainted": 1, "peak": 240,
                        "glyphSha256": hashlib.sha256(bytes((0, 240, 0)) * 2).hexdigest(),
                    },
                    "overlay": {
                        "box": None, "painted": 0, "bands": [],
                        # Peak uses dominance, while painted also requires >60.
                        "maxRowPainted": 0, "peak": 60, "glyphSha256": None,
                    },
                })
        self.assertEqual(oracle.boxes(Image.new("RGB", (9, 8)), 256), {
            role: {"box": None, "painted": 0, "bands": [],
                   "maxRowPainted": 0, "peak": 0, "glyphSha256": None}
            for role in ("main", "extension", "overlay")
        })
        # Unequal black borders expose lost crop origins independently on X/Y.
        shifted = Image.new("RGB", (51, 37))
        shifted.paste(image, (13, 7))
        actual = oracle.boxes(shifted, 2)
        self.assertEqual(actual["main"], {
            "box": [13, 6, 16, 11], "painted": 4,
            "bands": [[6, 8], [10, 11]], "maxRowPainted": 2,
            "peak": 255, "glyphSha256": hashlib.sha256(main_glyph).hexdigest(),
        })
        self.assertEqual(actual["extension"], {
            "box": [12, 9, 13, 11], "painted": 2, "bands": [[9, 11]],
            "maxRowPainted": 1, "peak": 240,
            "glyphSha256": hashlib.sha256(bytes((0, 240, 0)) * 2).hexdigest(),
        })
        self.assertEqual(actual["overlay"], {
            "box": None, "painted": 0, "bands": [],
            "maxRowPainted": 0, "peak": 60, "glyphSha256": None,
        })
        # Known paint colours, including the inclusive 12 / excluded 13 edge.
        colours = Image.new("RGB", (23, 17))
        for point, colour in (
            ((9, 4), (255, 153, 0)), ((10, 4), (243, 141, 12)),
            ((11, 4), (242, 153, 0)),
            ((9, 5), (204, 0, 204)), ((10, 5), (192, 12, 192)),
            ((11, 5), (191, 0, 204)), ((20, 15), (1, 1, 1)),
        ):
            colours.putpixel(point, colour)
        self.assertEqual(oracle.paint_colours(colours), {"outline": 2, "shadow": 2})
        self.assertEqual(oracle.paint_colours(Image.new("RGB", (23, 17))), {"outline": 0, "shadow": 0})


if __name__ == "__main__":
    unittest.main()
