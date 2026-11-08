"""Transparent ASS image assets for FCP 7 handoff; XML stays in the frontend."""
from __future__ import annotations

import hashlib
import json
import math
import re
import shutil
import tempfile
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path

from maw.ass_fonts import normalize_ass_text_fontnames
from maw.postprocess_ffmpeg import libass_missing_glyphs

FRAME_RATES = {"24", "25", "30", "30000/1001", "50", "60", "60000/1001"}
MAX_RENDER_SAMPLES = 250_000
BATCH_SIZE = 24
IMAGE_FORMATS = {"png", "webp"}


def _frame_checks(root: Path, count: int, width: int, height: int) -> list[tuple[str, bool]]:
    """Read dense FFmpeg raw-RGBA hashes and explicit alpha records, fail closed."""
    try:
        hashes = []
        for line in (root / "frames.sha256").read_text(encoding="utf-8").splitlines():
            if not line.strip() or line.startswith("#"):
                continue
            stream, dts, pts, duration, size, digest = (item.strip() for item in line.split(","))
            index = len(hashes)
            if (int(stream) != 0 or int(dts) != index or int(pts) != index
                    or int(duration) != 1 or int(size) != width * height * 4
                    or not re.fullmatch(r"[0-9a-f]{64}", digest)):
                raise ValueError("invalid RGBA frame hash")
            hashes.append(digest)
        records = []
        for line in (root / "alpha.txt").read_text(encoding="utf-8").splitlines():
            if line.startswith("frame:"):
                match = re.fullmatch(r"frame:(\d+)\s+pts:(\d+)\s+pts_time:\S+", line)
                if not match or int(match[1]) != len(records) or int(match[2]) != len(records):
                    raise ValueError("invalid alpha frame index")
                records.append({})
            elif line.strip():
                key, value = line.split("=", 1)
                if not records or key in records[-1]:
                    raise ValueError("invalid alpha metadata")
                records[-1][key] = value
        if len(hashes) != count or len(records) != count:
            raise ValueError("frame count mismatch")
        result = []
        bounds = {"x1", "x2", "y1", "y2", "w", "h"}
        for digest, record in zip(hashes, records):
            if record.pop("maw.sample", None) != "1":
                raise ValueError("missing alpha record")
            if record:
                if set(record) != {"lavfi.bbox." + key for key in bounds}:
                    raise ValueError("incomplete alpha bounds")
                box = {key: int(record["lavfi.bbox." + key]) for key in bounds}
                if not (0 <= box["x1"] <= box["x2"] < width and 0 <= box["y1"] <= box["y2"] < height
                        and box["w"] == box["x2"] - box["x1"] + 1
                        and box["h"] == box["y2"] - box["y1"] + 1):
                    raise ValueError("invalid alpha bounds")
            result.append((digest, bool(record)))
        return result
    except (OSError, ValueError) as error:
        raise ValueError("图片字幕帧校验失败") from error


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
                        duration_ms: int, selected_layers: list[int], image_format: str = "png") -> dict:
    if not isinstance(image_format, str) or image_format not in IMAGE_FORMATS:
        raise ValueError("不支持的字幕图片格式")
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

    def frame(ms):
        return math.ceil(Fraction(str(ms)) * rate / 1000)

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
    return {"width": width, "height": height, "fps": fps, "durationFrames": total, "imageFormat": image_format,
            "tracks": tracks, "samples": samples, "fontNotices": font_notices}


def render_png_assets(job, plan: dict, ffmpeg: Path, package: Path, image_format: str | None = None) -> dict:
    """Render PNG by default or opt-in lossless WebP, without a Python image decoder."""
    image_format = plan.get("imageFormat", "png") if image_format is None else image_format
    if not isinstance(image_format, str) or image_format not in IMAGE_FORMATS:
        raise ValueError("不支持的字幕图片格式")
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
                command = [str(ffmpeg), "-hide_banner", "-nostdin", "-loglevel", "warning", "-y"]
                for color in ("black", "white"):
                    command += ["-f", "lavfi", "-i",
                        f"color={color}:s={plan['width']}x{plan['height']}:r={plan['fps']},format=rgb24"]
                timing = f"settb=1/{rate.numerator},setpts='{clock}',ass=filename='sub.ass',format=gbrp"
                coverage = "255-max(max(r(X,Y),g(X,Y)),b(X,Y))"
                # Divide RGB by coverage before adding alpha. FFmpeg 8.1 inserts
                # alpha-mode conversions around unpremultiply, which would
                # premultiply our already-premultiplied matte RGB a second time.
                straight = "if(gt(y,0),min(255,x*255/y),0)"
                graph = (f"[0:v]{timing},split[b][b2];[1:v]{timing}[w];"
                         "[w][b2]blend=all_mode=subtract[d];"
                         f"[d]geq=r='{coverage}':g=0:b=0,extractplanes=r[a];"
                         "[a]split[div][merge];[div]format=gbrp[denominator];"
                         f"[b][denominator]lut2=c0='{straight}':c1='{straight}':c2='{straight}'[rgb];"
                         "[rgb][merge]alphamerge,format=rgba,"
                         f"settb=1/1,setpts=N,trim=end_frame={len(batch)},split=3[v][hash][alpha];"
                         "[alpha]alphaextract,metadata=mode=add:key=maw.sample:value=1,"
                         "bbox=min_val=0,metadata=mode=print:file=alpha.txt[check]")
                codec = (["-c:v", "png", "-pix_fmt", "rgba"] if image_format == "png" else
                         ["-c:v", "libwebp", "-lossless", "1", "-compression_level", "6"])
                command += ["-filter_complex_threads", "2", "-filter_complex", graph, "-map", "[v]",
                    "-r", "1", "-fps_mode", "cfr", "-threads", "1", *codec,
                    "-start_number", "0", f"frame-%03d.{image_format}",
                    "-map", "[hash]", "-r", "1", "-fps_mode", "cfr", "-threads", "1",
                    "-c:v", "rawvideo", "-pix_fmt", "rgba", "-f", "framehash", "-hash", "sha256", "frames.sha256",
                    "-map", "[check]", "-r", "1", "-fps_mode", "cfr", "-threads", "1", "-f", "null", "-"]
                output = job.run_command(command, timeout=180, cwd=root)
                if output.returncode:
                    raise ValueError("图片字幕渲染失败：" + output.stderr[-2000:])
                missing = libass_missing_glyphs(output.stderr)
                if missing:
                    glyph, family = missing[0]
                    raise ValueError(f"字幕字体「{family}」缺少字形 {glyph}，请更换字体后导出")
                checks = _frame_checks(root, len(batch), plan["width"], plan["height"])
                if len(list(root.glob(f"frame-*.{image_format}"))) != len(batch):
                    raise ValueError("图片字幕帧校验失败")
                for index, (start, end) in enumerate(batch):
                    job.check_cancelled()
                    cue_id = next((name for a, b, name in track["cueSpans"] if a <= start < b), "")
                    frame_path = root / f"frame-{index:03d}.{image_format}"
                    if frame_path.stat().st_size == 0:
                        raise ValueError("图片字幕帧校验失败")
                    digest, visible = checks[index]
                    if visible:
                        filename = unique.get(digest)
                        if filename is None:
                            filename = f"subtitle_{len(unique) + 1:06d}.{image_format}"
                            shutil.copyfile(frame_path, assets / filename)
                            unique[digest] = filename
                        if clips and clips[-1]["filename"] == filename and clips[-1]["endFrame"] == start and clips[-1]["cueId"] == cue_id:
                            clips[-1]["endFrame"] = end
                        else:
                            clips.append({"cueId": cue_id, "filename": filename, "path": str(package / "images" / filename),
                                          "startFrame": start, "endFrame": end})
                    completed += 1
                    job.update("rendering", completed / plan["samples"])
        if clips:
            result_tracks.append({"layer": track["layer"], "lane": track["lane"], "clips": clips})
    if not unique:
        raise ValueError("所选字幕在输出帧上均为透明，请检查字幕颜色、位置和时长")
    manifest = {"version": 1, "width": plan["width"], "height": plan["height"], "fps": plan["fps"],
                "imageFormat": image_format,
                "durationFrames": plan["durationFrames"], "tracks": result_tracks,
                "sampleCount": plan["samples"], "imageCount": len(unique), "packagePath": str(package),
                "fontNotices": plan["fontNotices"]}
    manifest["renderer"] = {"method": "ffmpeg-rgb-dual-matte", "alpha": "straight", "pixelFormat": "rgba",
                            "encoding": "lossless",
                            "assSha256": hashlib.sha256("\n".join(t["ass"] for t in plan["tracks"]).encode("utf-8")).hexdigest()}
    job.output.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8", newline="\n")
    return manifest
