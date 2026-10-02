"""Build and verify the macOS ICNS from the tracked rounded PNG source."""

from __future__ import annotations

import argparse
import io
import struct
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "maw-icon-rounded.png"
TARGET = ROOT / "assets" / "maw.icns"

ICNS_TYPES = {
    16: b"icp4",
    32: b"icp5",
    64: b"icp6",
    128: b"ic07",
    256: b"ic08",
    512: b"ic09",
    1024: b"ic10",
}


def read_png_frames(path: Path) -> dict[int, bytes]:
    from PIL import Image

    frames: dict[int, bytes] = {}
    with Image.open(path) as image:
        source = image.convert("RGBA")
        if source.width != source.height or source.width < max(ICNS_TYPES):
            raise ValueError("The rounded icon source must be square and at least 1024 pixels")
        for size in ICNS_TYPES:
            frame = source.resize((size, size), Image.Resampling.LANCZOS)
            output = io.BytesIO()
            frame.save(output, format="PNG")
            frames[size] = output.getvalue()
    return frames


def build_icns(frames: dict[int, bytes]) -> bytes:
    entries = []
    for size, icon_type in ICNS_TYPES.items():
        payload = frames[size]
        entries.append(icon_type + struct.pack(">I", len(payload) + 8) + payload)
    body = b"".join(entries)
    return b"icns" + struct.pack(">I", len(body) + 8) + body


def verify_icns(actual: bytes, frames: dict[int, bytes]) -> None:
    """Check all decoded sizes and pixels, independent of PNG compression."""
    from PIL import Image

    if len(actual) < 8 or actual[:4] != b"icns" or int.from_bytes(actual[4:8], "big") != len(actual):
        raise ValueError("Invalid ICNS header or size")
    entries: dict[bytes, bytes] = {}
    offset = 8
    while offset < len(actual):
        if offset + 8 > len(actual):
            raise ValueError("Truncated ICNS entry")
        icon_type, length = struct.unpack(">4sI", actual[offset:offset + 8])
        if length < 8 or offset + length > len(actual) or icon_type in entries:
            raise ValueError("Invalid or duplicate ICNS entry")
        entries[icon_type] = actual[offset + 8:offset + length]
        offset += length
    for size, icon_type in ICNS_TYPES.items():
        if icon_type not in entries:
            raise ValueError(f"Missing ICNS size {size}")
        with Image.open(io.BytesIO(entries[icon_type])) as image, Image.open(io.BytesIO(frames[size])) as expected:
            actual_pixels = image.convert("RGBA")
            if actual_pixels.size != (size, size) or actual_pixels.tobytes() != expected.convert("RGBA").tobytes():
                raise ValueError(f"ICNS size {size} does not match the rounded source")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify every icon size against the rounded PNG")
    args = parser.parse_args()
    try:
        frames = read_png_frames(SOURCE)
        if args.check:
            verify_icns(TARGET.read_bytes(), frames)
            print(f"{TARGET} matches the rounded source")
        else:
            expected = build_icns(frames)
            TARGET.write_bytes(expected)
            print(f"Wrote {TARGET} ({len(expected)} bytes)")
    except (ImportError, OSError, ValueError) as error:
        raise SystemExit(f"macOS icon check/build failed: {error}") from error
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
