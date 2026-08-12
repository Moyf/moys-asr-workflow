#!/usr/bin/env python3
"""为指定 AppImage 生成 XDG 缩略图缓存（normal/large），无 root。

用法: python3 make_thumbnail.py <AppImage 路径>
输出: ~/.cache/thumbnails/{normal,large}/<uri-md5>.png
"""
import hashlib
import struct
import sys
import zlib
from pathlib import Path

from PyQt6.QtCore import Qt
from PyQt6.QtGui import QImage


def make_png(uri: str, mtime: int, size: int, mimetype: str, rgba: bytes, w: int, h: int) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    def text(key: str, value: str) -> bytes:
        return chunk(b"tEXt", key.encode("latin-1") + b"\x00" + value.encode("utf-8"))

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    raw = bytearray()
    stride = w * 4
    for y in range(h):
        raw.append(0)  # filter: None
        raw.extend(rgba[y * stride : (y + 1) * stride])
    idat = zlib.compress(bytes(raw), 9)
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", ihdr)
    png += text("Thumb::URI", uri)
    png += text("Thumb::MTime", str(mtime))
    png += text("Thumb::Size", str(size))
    png += text("Thumb::Mimetype", mimetype)
    png += chunk(b"IDAT", idat)
    png += chunk(b"IEND", b"")
    return png


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    appimage = Path(sys.argv[1]).resolve()
    if not appimage.exists():
        print(f"文件不存在: {appimage}")
        return 1

    icon_path = Path(__file__).resolve().parents[1] / "build-appimage" / "MAW.AppDir" / "MAW.png"
    source = QImage(str(icon_path))
    if source.isNull():
        print(f"无法加载图标: {icon_path}")
        return 1

    uri = f"file://{appimage}"
    digest = hashlib.md5(uri.encode("utf-8")).hexdigest()
    stat = appimage.stat()
    mimetype = "application/vnd.appimage"

    for folder, target in (("normal", 128), ("large", 256)):
        img = source.scaled(target, target, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation)
        img = img.convertToFormat(QImage.Format.Format_RGBA8888)
        w, h = img.width(), img.height()
        ptr = img.constBits()
        ptr.setsize(img.sizeInBytes())
        rgba = bytes(ptr)
        png = make_png(uri, int(stat.st_mtime), stat.st_size, mimetype, rgba, w, h)
        out = Path.home() / ".cache" / "thumbnails" / folder / f"{digest}.png"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(png)
        print(f"写入: {out} ({len(png)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
