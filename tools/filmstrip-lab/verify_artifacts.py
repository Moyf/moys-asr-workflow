"""Read-only fixture and portable HTML validation, never opens or executes a page."""
import argparse
import base64
from html.parser import HTMLParser
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from maw.ffmpeg import resolve_ffmpeg_tools  # noqa: E402
from backend import probe  # noqa: E402


class PortableParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.in_script = False
        self.scripts = []
        self.external = []
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "script":
            self.in_script = True
            self.scripts.append((attrs, ""))
            if "src" in attrs:
                self.external.append(attrs["src"])
        if tag == "link" and attrs.get("rel") == "stylesheet":
            self.external.append(attrs.get("href"))
    def handle_endtag(self, tag):
        if tag == "script":
            self.in_script = False
    def handle_data(self, data):
        if self.in_script:
            attrs, source = self.scripts[-1]
            self.scripts[-1] = attrs, source + data


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--portable", type=Path, required=True)
    args = parser.parse_args()
    art = ROOT / ".artifacts/filmstrip"
    page = PortableParser()
    page.feed(args.portable.read_text(encoding="utf-8"))
    assert len(page.scripts) == 2, "Expected a JSON payload and bundled lab module"
    assert not page.external, "Portable page must have inline JS and CSS"
    (data_attrs, data), (code_attrs, code) = page.scripts
    assert data_attrs == {"id": "filmstrip-portable-data", "type": "application/json"}
    assert code_attrs == {"type": "module"}
    payload = json.loads(data)
    image = base64.b64decode(payload["sprite"]["dataUrl"].split(",", 1)[1], validate=True)
    assert hashlib.sha256(image).hexdigest() == payload["sprite"]["sha256"]
    script_path = art / "portable-script.mjs"
    script_path.write_text(code, encoding="utf-8", newline="\n")
    result = {"portableBytes": args.portable.stat().st_size, "spriteBytes": len(image),
              "inlineScripts": len(page.scripts), "externalScriptStyleLinks": page.external,
              "offlineBrowserReopen": "not covered by this structural check"}
    media = art / "media"
    ffprobe = str(resolve_ffmpeg_tools().ffprobe)
    info = probe(media / "rotated.mp4")
    rotation = info["videos"][0]["side_data_list"][0]["rotation"]
    assert abs(rotation) == 90, "Rotation fixture must have a real display matrix"
    pts = subprocess.run([ffprobe, "-v", "error", "-select_streams", "v:0",
                          "-show_entries", "frame=best_effort_timestamp_time", "-of", "json",
                          str(media / "vfr.mp4")], capture_output=True, timeout=20, check=True)
    times = [float(frame["best_effort_timestamp_time"]) for frame in json.loads(pts.stdout)["frames"]]
    deltas = sorted(set(round(b - a, 5) for a, b in zip(times, times[1:])))
    assert len(deltas) >= 2, "VFR fixture must actually have varying timestamp spacing"
    result.update(rotation=rotation, vfrFrameDeltasSeconds=deltas,
                  longDuration=probe(media / "long.mp4")["duration"],
                  videoStreams=len(probe(media / "multistream.mp4")["videos"]))
    assert result["longDuration"] >= 7200 and result["videoStreams"] == 2
    (art / "artifact-validation.json").write_text(json.dumps(result, indent=2) + "\n",
                                               encoding="utf-8", newline="\n")
    print(json.dumps(result, ensure_ascii=False))
    print("Syntax-only check next: node --check .artifacts/filmstrip/portable-script.mjs")


if __name__ == "__main__":
    main()
