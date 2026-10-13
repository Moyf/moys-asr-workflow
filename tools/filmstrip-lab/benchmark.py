"""Deterministic synthetic fixtures and backend measurement, no private media."""
from __future__ import annotations

import argparse
import base64
import json
import platform
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from backend import generate, probe  # noqa: E402
from maw.ffmpeg import resolve_ffmpeg_tools  # noqa: E402

ART = ROOT / ".artifacts/filmstrip"


def fixtures():
    media = ART / "media"
    media.mkdir(parents=True, exist_ok=True)
    ffmpeg = str(resolve_ffmpeg_tools().ffmpeg)
    commands = {
        "short.mp4": ["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24:duration=30",
                      "-f", "lavfi", "-i", "sine=frequency=440:duration=30",
                      "-c:v", "libx264", "-preset", "ultrafast", "-g", "240",
                      "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"],
        "long.mp4": ["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=2:duration=7200",
                     "-c:v", "libx264", "-preset", "ultrafast", "-g", "20", "-pix_fmt", "yuv420p"],
        "vfr.mp4": ["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=8",
                    "-vf", "select='if(lt(t,4),not(mod(n,3)),not(mod(n,7)))'",
                    "-fps_mode", "vfr", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"],
        "prores.mov": ["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=12:duration=6",
                       "-c:v", "prores_ks", "-profile:v", "0", "-threads", "2"],
        "hevc.mp4": ["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=12:duration=6",
                     "-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "pools=2:log-level=error",
                     "-pix_fmt", "yuv420p"],
        "multistream.mp4": ["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=12:duration=6",
                            "-f", "lavfi", "-i", "testsrc2=size=180x320:rate=12:duration=6",
                            "-map", "0:v", "-map", "1:v", "-c:v", "libx264", "-preset", "ultrafast",
                            "-pix_fmt", "yuv420p"],
        "audio.wav": ["-f", "lavfi", "-i", "sine=frequency=220:duration=6", "-c:a", "pcm_s16le"],
    }
    for name, args in commands.items():
        if (media / name).is_file():
            continue
        began = time.perf_counter()
        with (ART / (name + ".generation.log")).open("wb") as log:
            subprocess.run([ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
                            *args, str(media / name)], stdout=log, stderr=log, timeout=120, check=True)
        print(f"fixture {name}: {time.perf_counter() - began:.3f}s", flush=True)
    if not (media / "rotated.mp4").exists() or not probe(media / "rotated.mp4")["videos"][0].get("side_data_list"):
        subprocess.run([ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
                        "-display_rotation:v:0", "90", "-i", str(media / "vfr.mp4"), "-c", "copy",
                        str(media / "rotated.mp4")], capture_output=True, timeout=20, check=True)
    (ART / "fixtures.json").write_text(json.dumps({
        "scope": "synthetic testsrc2 only; long=2h 320x180 2fps GOP10s, short=30s 640x360 24fps GOP10s",
        "files": [p.name for p in media.iterdir()],
    }, indent=2) + "\n", encoding="utf-8", newline="\n")


def measure():
    results = []
    previous = {}
    result_file = ART / "backend-results.json"
    if result_file.exists():
        previous = {r.get("key"): r for r in json.loads(result_file.read_text(encoding="utf-8"))["results"]}
    for path in sorted((ART / "media").iterdir()):
        info = probe(path)
        if not info["videos"]:
            results.append({"media": path.name, "info": info, "result": "audio: lane hidden"})
            continue
        for stream in info["videos"]:
            modes = ("fixed", "adaptive", "window") if path.name in ("short.mp4", "long.mp4") else ("window",)
            for mode in modes:
                kwargs = {"mode": mode, "count": 8 if mode == "window" else 100,
                          "stream": stream["index"], "span": min(30, info["duration"])}
                if mode == "window" and path.name == "long.mp4":
                    kwargs.update(start=3000, span=1800)
                cold = generate(path, info, ART / "benchmark-cache", **kwargs)
                warm = generate(path, info, ART / "benchmark-cache", **kwargs)
                row = {
                    "media": path.name, "info": info, "mode": mode, "stream": stream["index"],
                    "frames": cold["config"]["count"], "bytes": cold["bytes"],
                    "coldSeconds": cold["elapsed"], "coldWasHit": cold["hit"],
                    "warmSeconds": warm["elapsed"], "key": cold["key"],
                    "firstBatchSeconds": cold["elapsed"], "completeSeconds": cold["elapsed"],
                    "cpuSeconds": cold.get("cpu_seconds"), "peakWorkingSetBytes": cold.get("peak_working_set_bytes"),
                    "base64Bytes": len(base64.b64encode((ART / "benchmark-cache" / cold["key"] / "sprite.jpg").read_bytes())),
                    "precision": cold["precision"],
                }
                if cold["hit"] and cold["key"] in previous:
                    row.update({k: previous[cold["key"]][k] for k in
                                ("coldSeconds", "coldWasHit", "firstBatchSeconds", "completeSeconds")})
                    row["measurementReused"] = True
                results.append(row)
                print(f"{path.name} stream={stream['index']} {mode}: recorded-cold={row['coldSeconds']:.3f}s warm={warm['elapsed']:.4f}s bytes={cold['bytes']} cache-hit={cold['hit']} reused={row.get('measurementReused', False)}", flush=True)
    version = subprocess.run([str(resolve_ffmpeg_tools().ffmpeg), "-version"], capture_output=True, text=True, timeout=10).stdout.splitlines()[0]
    (ART / "backend-results.json").write_text(json.dumps({
        "platform": platform.platform(), "python": platform.python_version(), "ffmpeg": version,
        "scope": "single run synthetic fixtures; cold means no experiment sprite; OS file cache uncontrolled",
        "results": results,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixtures", action="store_true")
    parser.add_argument("--measure", action="store_true")
    args = parser.parse_args()
    ART.mkdir(parents=True, exist_ok=True)
    if args.fixtures:
        fixtures()
    if args.measure:
        measure()
