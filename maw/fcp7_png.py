"""Transparent ASS image assets for FCP 7 handoff; XML stays in the frontend."""
from __future__ import annotations

import hashlib
import json
import math
import re
import tempfile
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path

from PIL import Image, ImageChops, ImageMath

from maw.ass_fonts import normalize_ass_text_fontnames
from maw.postprocess_ffmpeg import libass_missing_glyphs

FRAME_RATES = {"24", "25", "30", "30000/1001", "50", "60", "60000/1001"}
MAX_RENDER_SAMPLES = 250_000
BATCH_SIZE = 24


def _ass_ms(value: str) -> int:
    match = re.fullmatch(r"(\d+):(\d{2}):(\d{2})[.](\d{2})", value.strip())
    if not match or int(match[2]) >= 60 or int(match[3]) >= 60:
        raise ValueError("ASS 时间格式无效")
    return ((int(match[1]) * 60 + int(match[2])) * 60 + int(match[3])) * 1000 + int(match[4]) * 10


def _tags(text: str):
    """Read override tags including nested transform parentheses."""
    for block in re.findall(r"\{([^}]*)\}", text):
        cursor = 0
        while match := re.search(r"\\([a-zA-Z]+)", block[cursor:]):
            start = cursor + match.end()
            name = match[1].lower()
            end = start
            if start < len(block) and block[start] == "(":
                depth = 1
                end += 1
                while end < len(block) and depth:
                    depth += (block[end] == "(") - (block[end] == ")")
                    end += 1
                yield name, block[start + 1:end - 1]
            else:
                while end < len(block) and block[end] != "\\":
                    end += 1
                yield name, block[start:end]
            cursor = end


def _dynamic_windows(text: str, duration: int) -> list[tuple[float, float]]:
    windows = []
    for tag, value in _tags(text):
        first_window = len(windows)
        try:
            if tag == "fad":
                fade_in, fade_out = map(float, value.split(","))
                windows.extend(((0, fade_in), (duration - fade_out, duration)))
            elif tag == "fade":
                a, b, c, t1, t2, t3, t4 = map(float, value.split(","))
                if a != b:
                    windows.append((t1, t2))
                if b != c:
                    windows.append((t3, t4))
            elif tag == "move":
                numbers = list(map(float, value.split(",")))
                windows.append(tuple(numbers[4:6]) if len(numbers) == 6 else (0, duration))
            elif tag == "t":
                prefix = value.split("\\", 1)[0].rstrip(",")
                numbers = list(map(float, prefix.split(","))) if prefix else []
                start, end = numbers[:2] if len(numbers) >= 2 else (0, duration)
                windows.append((start, duration if start == end == 0 else end))
            elif tag in {"k", "kf", "ko", "kt"}:
                windows.append((0, duration))
            # Equal transform/fade times are instantaneous changes, and
            # move(...,0,0) means movement across the entire event in libass.
            # Preserve those changes through conservative sampling, not a hold.
            if any(not math.isfinite(a) or not math.isfinite(b)
                   or (tag != "fad" and b <= a) for a, b in windows[first_window:]):
                windows[first_window:] = [(0, duration)]
        except (ValueError, TypeError):
            # Unknown temporal syntax is sampled, never silently frozen.
            windows.append((0, duration))
    return [(max(0, a), min(duration, b)) for a, b in windows if b > a and b > 0 and a < duration]


@dataclass(frozen=True)
class Event:
    line: str
    layer: int
    name: str
    start: int
    end: int
    text: str


def prepare_render_plan(ass: str, *, fps: str, width: int, height: int,
                        duration_ms: int, selected_layers: list[int]) -> dict:
    if not isinstance(ass, str) or not ass.strip() or len(ass.encode("utf-8")) > 4 * 1024 * 1024:
        raise ValueError("ASS 内容为空或超过 4 MB")
    if fps not in FRAME_RATES:
        raise ValueError("不支持的图片字幕帧率")
    if any(type(n) is not int for n in (width, height, duration_ms)) or not (
            1 <= width <= 8192 and 1 <= height <= 8192 and width * height <= 33_554_432
            and 1 <= duration_ms <= 86_400_000):
        raise ValueError("图片字幕尺寸或时长无效")
    if not isinstance(selected_layers, list) or not selected_layers or any(
            type(n) is not int or n not in (0, 1, 2) for n in selected_layers):
        raise ValueError("字幕轨选择无效")
    rate = Fraction(fps)
    frame = lambda ms: math.ceil(Fraction(str(ms)) * rate / 1000)
    total = frame(duration_ms)
    ass, font_notices = normalize_ass_text_fontnames(ass)
    header, events = [], []
    for line in ass.splitlines():
        if line.startswith("Dialogue:"):
            fields = line.partition(":")[2].strip().split(",", 9)
            if len(fields) != 10:
                raise ValueError("ASS 事件格式无效")
            start, end = _ass_ms(fields[1]), _ass_ms(fields[2])
            layer = int(fields[0])
            if layer in selected_layers and end > start and start < duration_ms:
                events.append(Event(line, layer, fields[4], start, end, fields[9]))
        else:
            header.append(line)
    # Names from the complete MAW layout identify each original cue, including
    # all its layout/shake slices. Keep a cue on one lane throughout its life.
    groups = {}
    for index, event in enumerate(events):
        key = (event.layer, event.name if re.fullmatch(r"maw:(main|extension|overlay):\d+", event.name)
               else f"event:{index}")
        groups.setdefault(key, []).append(event)
    tracks = []
    samples = 0
    for layer in sorted(set(selected_layers)):
        assigned = []
        for (event_layer, cue), items in groups.items():
            if event_layer != layer:
                continue
            first, last = min(e.start for e in items), max(e.end for e in items)
            # Later ASS events must stay above earlier overlapping events.
            lane = max((n + 1 for a, b, n, _ in assigned if a < last and first < b), default=0)
            assigned.append((first, last, lane, items))
        for lane in sorted({entry[2] for entry in assigned}):
            entries = [e for _, _, n, items in assigned if n == lane for e in items]
            boundaries, dynamic = set(), []
            active = []
            for event in entries:
                start, end = min(total, frame(event.start)), min(total, frame(event.end))
                if end <= start:
                    continue
                boundaries.update((start, end))
                active.append((start, end))
                for a, b in _dynamic_windows(event.text, event.end - event.start):
                    left, right = max(start, frame(event.start + a)), min(end, frame(event.start + b))
                    if right > left:
                        boundaries.update((left, right))
                        dynamic.append((left, right))
            edges = sorted(boundaries)
            spans = []
            for start, end in zip(edges, edges[1:]):
                if not any(a <= start < b for a, b in active):
                    continue
                moving = any(a < end and start < b for a, b in dynamic)
                added = end - start if moving else 1
                if samples + added > MAX_RENDER_SAMPLES:
                    raise ValueError("动态字幕帧数过多，请缩短导出范围或降低帧率")
                samples += added
                if moving:
                    spans.extend((n, n + 1) for n in range(start, end))
                else:
                    spans.append((start, end))
            tracks.append({"layer": layer, "lane": lane, "ass": "\n".join(header + [e.line for e in entries]) + "\n",
                           "spans": spans, "cueSpans": [(frame(e.start), frame(e.end), e.name) for e in entries]})
    if not samples:
        raise ValueError("所选轨道没有可导出的字幕")
    return {"width": width, "height": height, "fps": fps, "durationFrames": total,
            "tracks": tracks, "samples": samples, "fontNotices": font_notices}


def recover_straight_rgba(black: Image.Image, white: Image.Image) -> Image.Image:
    """Recover source-over coverage independently of libass's alpha drawing.

    RGB black/white renders avoid FFmpeg builds that square glyph alpha while
    drawing into RGBA. Work in full RGB, with at most byte-rounding differences.
    """
    difference = ImageChops.subtract(white.convert("RGB"), black.convert("RGB")).split()
    alpha = ImageChops.invert(ImageChops.lighter(ImageChops.lighter(difference[0], difference[1]), difference[2]))
    bounds = alpha.getbbox()
    output = Image.new("RGBA", black.size)
    if bounds is None:
        return output
    coverage = alpha.crop(bounds)
    channels = [ImageMath.lambda_eval(lambda p: p["c"] * 255 / (p["a"] + (p["a"] == 0)),
                c=c.crop(bounds).convert("F"), a=coverage.convert("F")).convert("L")
                for c in black.convert("RGB").split()]
    output.paste(Image.merge("RGBA", (*channels, coverage)), bounds[:2])
    return output


def render_png_assets(job, plan: dict, ffmpeg: Path, package: Path) -> dict:
    """Render bounded batches and keep only unique visible straight-alpha PNGs."""
    assets = job.directory / "images"
    assets.mkdir()
    rate = Fraction(plan["fps"])
    completed = 0
    result_tracks, unique = [], {}
    for track_index, track in enumerate(plan["tracks"]):
        clips = []
        for offset in range(0, len(track["spans"]), BATCH_SIZE):
            job.check_cancelled()
            batch = track["spans"][offset:offset + BATCH_SIZE]
            with tempfile.TemporaryDirectory(prefix="frames-", dir=job.directory) as temporary:
                root = Path(temporary)
                (root / "sub.ass").write_text(track["ass"], encoding="utf-8", newline="\n")
                clock = "+".join(f"eq(N,{i})*{span[0] * rate.denominator}" for i, span in enumerate(batch))
                for color in ("black", "white"):
                    command = [str(ffmpeg), "-hide_banner", "-nostdin", "-loglevel", "warning", "-y",
                        "-f", "lavfi", "-i", f"color={color}:s={plan['width']}x{plan['height']}:r={plan['fps']},format=rgb24",
                        "-vf", f"settb=1/{rate.numerator},setpts='{clock}',ass=filename='sub.ass',setpts=N",
                        "-frames:v", str(len(batch)), "-fps_mode", "passthrough", "-threads", "1",
                        "-start_number", "0", f"{color}-%03d.png"]
                    output = job.run_command(command, timeout=180, cwd=root)
                    if output.returncode:
                        raise ValueError("图片字幕渲染失败：" + output.stderr[-2000:])
                    missing = libass_missing_glyphs(output.stderr)
                    if missing:
                        glyph, family = missing[0]
                        raise ValueError(f"字幕字体「{family}」缺少字形 {glyph}，请更换字体后导出")
                for index, (start, end) in enumerate(batch):
                    job.check_cancelled()
                    cue_id = next((name for a, b, name in track["cueSpans"] if a <= start < b), "")
                    with Image.open(root / f"black-{index:03d}.png") as black, Image.open(root / f"white-{index:03d}.png") as white:
                        rgba = recover_straight_rgba(black, white)
                    try:
                        if rgba.getchannel("A").getbbox() is not None:
                            digest = hashlib.sha256(rgba.tobytes()).hexdigest()
                            filename = unique.get(digest)
                            if filename is None:
                                filename = f"subtitle_{len(unique) + 1:06d}.png"
                                rgba.save(assets / filename)
                                unique[digest] = filename
                            if clips and clips[-1]["filename"] == filename and clips[-1]["endFrame"] == start and clips[-1]["cueId"] == cue_id:
                                clips[-1]["endFrame"] = end
                            else:
                                clips.append({"cueId": cue_id, "filename": filename, "path": str(package / "images" / filename),
                                              "startFrame": start, "endFrame": end})
                    finally:
                        rgba.close()
                    completed += 1
                    job.update("rendering", completed / plan["samples"])
        if clips:
            result_tracks.append({"layer": track["layer"], "lane": track["lane"], "clips": clips})
    if not unique:
        raise ValueError("所选字幕在输出帧上均为透明，请检查字幕颜色、位置和时长")
    manifest = {"version": 1, "width": plan["width"], "height": plan["height"], "fps": plan["fps"],
                "durationFrames": plan["durationFrames"], "tracks": result_tracks,
                "sampleCount": plan["samples"], "imageCount": len(unique), "packagePath": str(package),
                "fontNotices": plan["fontNotices"]}
    manifest["renderer"] = {"method": "rgb-dual-matte", "alpha": "straight", "pixelFormat": "rgba",
                            "assSha256": hashlib.sha256("\n".join(t["ass"] for t in plan["tracks"]).encode("utf-8")).hexdigest()}
    job.output.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8", newline="\n")
    return manifest
