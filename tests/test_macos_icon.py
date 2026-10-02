from __future__ import annotations

import io
import struct
import unittest

from scripts.build_macos_icon import SOURCE, TARGET, ICNS_TYPES, build_icns, read_png_frames, verify_icns

try:
    from PIL import Image
except ImportError:
    Image = None


@unittest.skipUnless(Image is not None, "Pillow from the build dependency group is required")
class MacosIconTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.frames = read_png_frames(SOURCE)

    def test_tracked_icon_matches_rounded_source_at_every_size(self) -> None:
        verify_icns(TARGET.read_bytes(), self.frames)

    def test_wrong_pixels_are_rejected_even_in_a_valid_container(self) -> None:
        altered = dict(self.frames)
        output = io.BytesIO()
        Image.new("RGBA", (128, 128), "red").save(output, format="PNG")
        altered[128] = output.getvalue()
        with self.assertRaisesRegex(ValueError, "does not match"):
            verify_icns(build_icns(altered), self.frames)

    def test_missing_truncated_and_duplicate_sizes_are_rejected(self) -> None:
        data = build_icns(self.frames)
        first_length = int.from_bytes(data[12:16], "big")
        first = data[8:8 + first_length]
        bodies = [data[8 + first_length:], data[8:-1], data[8:] + first]
        for body in bodies:
            with self.subTest(length=len(body)), self.assertRaises(ValueError):
                verify_icns(b"icns" + struct.pack(">I", len(body) + 8) + body, self.frames)

    def test_different_png_compression_is_accepted(self) -> None:
        frames = dict(self.frames)
        for size in ICNS_TYPES:
            with Image.open(io.BytesIO(frames[size])) as image:
                output = io.BytesIO()
                image.save(output, format="PNG", compress_level=0)
                frames[size] = output.getvalue()
        verify_icns(build_icns(frames), self.frames)


if __name__ == "__main__":
    unittest.main()
