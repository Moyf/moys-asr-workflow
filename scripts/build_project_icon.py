"""Generate the MOSP document icon in the three native desktop formats."""

from __future__ import annotations

import argparse
import io
from pathlib import Path

from scripts.build_macos_icon import build_icns, ICNS_TYPES, verify_icns


ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "assets" / "mosp"


def render_icon():
    from PIL import Image, ImageDraw

    image = Image.new("RGBA", (1024, 1024))
    draw = ImageDraw.Draw(image)
    # A folded document with a subtitle panel; distinct from the app icon even
    # at Explorer's 16px size. Geometry is the reproducible source of truth.
    draw.polygon([(180, 80), (654, 80), (848, 274), (848, 932), (180, 932)],
                 fill="#f5f8ff", outline="#9ab4dd", width=24)
    draw.polygon([(654, 80), (654, 274), (848, 274)], fill="#c6d8f4")
    draw.line([(654, 80), (654, 274), (848, 274)], fill="#9ab4dd", width=24)
    draw.rounded_rectangle((100, 428, 924, 818), radius=72, fill="#3565db")
    for x, top, bottom in ((210, 592, 654), (275, 545, 698), (340, 576, 669), (405, 523, 720)):
        draw.rounded_rectangle((x, top, x + 35, bottom), radius=17, fill="#ffffff")
    draw.rounded_rectangle((506, 540, 820, 580), radius=20, fill="#ffffff")
    draw.rounded_rectangle((506, 618, 768, 658), radius=20, fill="#ffffff")
    draw.rounded_rectangle((506, 696, 804, 736), radius=20, fill="#d3e2ff")
    return image


def frames_for(image) -> dict[int, bytes]:
    from PIL import Image

    frames = {}
    for size in ICNS_TYPES:
        output = io.BytesIO()
        image.resize((size, size), Image.Resampling.LANCZOS).save(output, format="PNG")
        frames[size] = output.getvalue()
    return frames


def main() -> int:
    from PIL import Image

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    icon = render_icon()
    if args.check:
        with Image.open(TARGET.with_suffix(".png")) as actual:
            if actual.convert("RGBA").tobytes() != icon.tobytes():
                raise ValueError("MOSP PNG does not match the geometry source")
        verify_icns(TARGET.with_suffix(".icns").read_bytes(), frames_for(icon))
        with Image.open(TARGET.with_suffix(".ico")) as actual:
            if not {(16, 16), (32, 32), (48, 48), (256, 256)} <= actual.ico.sizes():
                raise ValueError("MOSP ICO is missing native sizes")
        print("MOSP PNG/ICO/ICNS verified")
    else:
        icon.save(TARGET.with_suffix(".png"))
        icon.save(TARGET.with_suffix(".ico"), sizes=[(n, n) for n in (16, 24, 32, 48, 64, 128, 256)])
        TARGET.with_suffix(".icns").write_bytes(build_icns(frames_for(icon)))
        print("Generated MOSP PNG/ICO/ICNS")
    return 0


if __name__ == "__main__":
    # Run with python -m scripts.build_project_icon so the shared ICNS builder
    # is resolved from the repository package on all platforms.
    raise SystemExit(main())
