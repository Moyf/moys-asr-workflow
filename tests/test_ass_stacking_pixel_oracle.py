"""Small independent fixtures for the test oracle's sparse pixel metrics."""
from __future__ import annotations

import hashlib
import importlib.util
from pathlib import Path
import unittest

from PIL import Image


spec = importlib.util.spec_from_file_location(
    "ass_stacking_pixel_oracle",
    Path(__file__).parent / "helpers" / "ass-stacking-pixel-oracle.py",
)
oracle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oracle)


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
