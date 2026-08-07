"""Build the PNG-based ICNS asset used by the macOS PyInstaller bundle."""

from __future__ import annotations

import argparse
import struct
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "maw.ico"
TARGET = ROOT / "assets" / "maw.icns"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

# These are the PNG-backed ICNS types supported by current macOS icon tooling.
# The ICO already contains the required pixel sizes, so no resampling is needed.
ICNS_TYPES = {
    16: b"icp4",
    32: b"icp5",
    64: b"icp6",
    128: b"ic07",
    256: b"ic08",
}


def read_png_frames(path: Path) -> dict[int, bytes]:
    data = path.read_bytes()
    if len(data) < 6 or data[:2] != b"\x00\x00" or data[2:4] != b"\x01\x00":
        raise ValueError(f"{path} is not an ICO file")

    count = int.from_bytes(data[4:6], "little")
    frames: dict[int, bytes] = {}
    for index in range(count):
        entry_offset = 6 + index * 16
        if entry_offset + 16 > len(data):
            raise ValueError(f"{path} has a truncated ICO directory")
        width = data[entry_offset] or 256
        height = data[entry_offset + 1] or 256
        size = int.from_bytes(data[entry_offset + 8 : entry_offset + 12], "little")
        offset = int.from_bytes(data[entry_offset + 12 : entry_offset + 16], "little")
        payload = data[offset : offset + size]
        if width != height or len(payload) != size or not payload.startswith(PNG_SIGNATURE):
            raise ValueError(f"ICO frame {width}x{height} is not a complete PNG payload")
        if width in ICNS_TYPES:
            frames[width] = payload

    missing = sorted(set(ICNS_TYPES) - set(frames))
    if missing:
        sizes = ", ".join(f"{size}x{size}" for size in missing)
        raise ValueError(f"{path} is missing required icon sizes: {sizes}")
    return frames


def build_icns(frames: dict[int, bytes]) -> bytes:
    entries = []
    for size, icon_type in ICNS_TYPES.items():
        payload = frames[size]
        entries.append(icon_type + struct.pack(">I", len(payload) + 8) + payload)
    body = b"".join(entries)
    return b"icns" + struct.pack(">I", len(body) + 8) + body


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify that the tracked ICNS matches the source ICO without writing it",
    )
    args = parser.parse_args()

    expected = build_icns(read_png_frames(SOURCE))
    if args.check:
        actual = TARGET.read_bytes() if TARGET.is_file() else None
        if actual != expected:
            raise SystemExit(f"{TARGET} is missing or out of date; run this script without --check")
        print(f"{TARGET} is up to date")
        return 0

    TARGET.write_bytes(expected)
    print(f"Wrote {TARGET} ({len(expected)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
