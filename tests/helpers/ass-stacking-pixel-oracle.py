"""Independent libass pixel oracle; never imports MAW layout calculations."""

import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path

from PIL import Image, ImageChops


def translate_ass(source: str, padding: int) -> str:
    """Add a guard band without changing the original viewport's geometry.

    Increased PlayRes and style margins cancel, including available wrap width.
    Explicit absolute position/move/origin coordinates also move by padding.
    The guard band exposes glyphs that a normal render would silently clip.
    """
    output = []
    for line in source.splitlines():
        if line.startswith(('PlayResX:', 'PlayResY:')):
            key, value = line.split(':', 1)
            line = f'{key}: {int(value) + 2 * padding}'
        elif line.startswith('Style: '):
            fields = line[7:].split(',')
            for index in (19, 20, 21):
                fields[index] = str(int(fields[index]) + padding)
            line = 'Style: ' + ','.join(fields)
        elif line.startswith('Dialogue: '):
            fields = line[10:].split(',', 9)
            for index in (5, 6, 7):
                if int(fields[index]):
                    fields[index] = str(int(fields[index]) + padding)

            def shift_position(match):
                values = match[2].split(',')
                count = 4 if match[1] == 'move' else 2
                for index in range(count):
                    values[index] = f'{float(values[index]) + padding:g}'
                return '\\' + match[1] + '(' + ','.join(values) + ')'

            fields[9] = re.sub(r'\\(pos|move|org)\(([^)]+)\)', shift_position, fields[9])
            line = 'Dialogue: ' + ','.join(fields)
        output.append(line)
    return '\n'.join(output) + '\n'


def render(path: Path, target: Path, width: int, height: int, time_ms: int) -> tuple[Image.Image, list[str]]:
    # A relative simple filename avoids Windows drive-colon filter escaping.
    command = [
        'ffmpeg', '-hide_banner', '-loglevel', 'info', '-f', 'lavfi', '-i',
        f'color=black:s={width}x{height}:r=100:d=0.01', '-vf',
        # Preserve 501ms/1501ms boundaries exactly: the input's 1/100 timebase
        # would otherwise truncate a fractional setpts value to the prior frame.
        f'format=rgb24,settb=1/1000,setpts=PTS+{time_ms},ass={path.name}',
        '-frames:v', '1', '-y', target.name,
    ]
    result = subprocess.run(command, cwd=path.parent, capture_output=True, timeout=30, check=False)
    if result.returncode:
        raise RuntimeError(result.stderr.decode('utf-8', errors='replace')[-2000:])
    log = result.stderr.decode('utf-8', errors='replace')
    target.with_suffix('.ffmpeg.log').write_text(log, encoding='utf-8', newline='\n')
    return Image.open(target).convert('RGB'), [line for line in log.splitlines() if 'fontselect:' in line]


def render_series(path: Path, stem: Path, width: int, height: int,
                  times: list[int]) -> list[str]:
    # libass sees the exact millisecond clock; only the encoded output clock
    # is reset afterwards. Each canvas is still rendered separately.
    clock = '+'.join(f'eq(N,{index})*{time_ms}' for index, time_ms in enumerate(times))
    command = [
        'ffmpeg', '-hide_banner', '-loglevel', 'info', '-f', 'lavfi', '-i',
        f'color=black:s={width}x{height}:r=100:d={len(times) / 100}', '-vf',
        f"format=rgb24,settb=1/1000,setpts='{clock}',ass={path.name},setpts=N*10",
        '-fps_mode', 'passthrough', '-frames:v', str(len(times)),
        '-threads', '1', '-start_number', '0', '-y', f'{stem.name}-%d.png',
    ]
    result = subprocess.run(command, cwd=path.parent, capture_output=True, timeout=30, check=False)
    log = result.stderr.decode('utf-8', errors='replace')
    stem.with_suffix('.ffmpeg.log').write_text(log, encoding='utf-8', newline='\n')
    if result.returncode:
        raise RuntimeError(log[-2000:])
    return [line for line in log.splitlines() if 'fontselect:' in line]


def foreground(image: Image.Image) -> Image.Image:
    return ImageChops.difference(image, Image.new('RGB', image.size)).convert('L').point(
        lambda value: 255 if value > 8 else 0
    )


def count(mask: Image.Image) -> int:
    return mask.histogram()[255]


def paint_colours(image: Image.Image) -> dict:
    # Black cannot match either paint colour, including the tolerance below.
    image = image.crop(image.getbbox() or (0, 0, 1, 1))
    result = {}
    for name, rgb in (('outline', (255, 153, 0)), ('shadow', (204, 0, 204))):
        mask = Image.new('L', image.size, 255)
        for channel, target in zip(image.split(), rgb):
            mask = ImageChops.darker(mask, channel.point(
                lambda value, expected=target: 255 if abs(value - expected) <= 12 else 0
            ))
        result[name] = count(mask)
    return result


def boxes(image: Image.Image, padding: int = 0) -> dict:
    # Black pixels contribute zero to every role's mask and peak. Exclude only
    # that empty border, retaining faint pixels below the painted threshold.
    bounds = image.getbbox() or (0, 0, 1, 1)
    image = image.crop(bounds)
    channels = image.split()
    output = {}
    for name, index in (('main', 0), ('extension', 1), ('overlay', 2)):
        others = ImageChops.lighter(channels[(index + 1) % 3], channels[(index + 2) % 3])
        dominance = ImageChops.subtract(channels[index], others).point(lambda value: 255 if value > 30 else 0)
        brightness = channels[index].point(lambda value: 255 if value > 60 else 0)
        mask = ImageChops.darker(dominance, brightness)
        box = mask.getbbox()
        bands = []
        max_row_painted = 0
        # Outside this box every mask pixel is zero. Keep every painted row
        # and interior gap, while avoiding empty margins in row histograms.
        rows = range(box[1], box[3]) if box else ()
        for row in rows:
            row_mask = mask.crop((box[0], row, box[2], row + 1))
            max_row_painted = max(max_row_painted, count(row_mask))
            present = bool(row_mask.getbbox())
            if present and (not bands or bands[-1][1] != row + bounds[1] - padding):
                bands.append([row + bounds[1] - padding, row + bounds[1] + 1 - padding])
            elif present:
                bands[-1][1] = row + bounds[1] + 1 - padding
        output[name] = {
            'box': [value + bounds[index % 2] - padding for index, value in enumerate(box)] if box else None,
            'painted': count(mask),
            'bands': bands,
            'maxRowPainted': max_row_painted,
            'peak': max(ImageChops.multiply(channels[index], dominance).getextrema()),
            'glyphSha256': hashlib.sha256(
                Image.composite(image.crop(box), Image.new('RGB', (
                    box[2] - box[0], box[3] - box[1])), mask.crop(box)).tobytes()
            ).hexdigest() if box else None,
        }
    return output


def _prepare(path: Path, stem: Path, padding: int) -> tuple:
    source = path.read_text(encoding='utf-8')
    width = int(re.search(r'^PlayResX:\s*(\d+)', source, re.M)[1])
    height = int(re.search(r'^PlayResY:\s*(\d+)', source, re.M)[1])
    padded_ass = stem.with_name(stem.name + '-guard.ass')
    guarded_source = translate_ass(source, padding)
    padded_ass.write_text(guarded_source, encoding='utf-8', newline='\n')
    return width, height, padded_ass


def _measure(native, guard, width, height, padding, fonts, guard_fonts) -> dict:
    full_mask = foreground(guard)
    inside = full_mask.crop((padding, padding, padding + width, padding + height))
    return {
        'width': width, 'height': height, 'tracks': boxes(guard, padding),
        'nativeTracks': boxes(native), 'outside': count(full_mask) - count(inside),
        'guardBox': full_mask.getbbox(),
        'fullPainted': count(foreground(native)), 'paintColours': paint_colours(native),
        'guardSize': list(guard.size), 'fontSelections': fonts, 'guardFontSelections': guard_fonts,
        'sha256': hashlib.sha256(native.tobytes()).hexdigest(),
        'guardCropSha256': hashlib.sha256(guard.crop(
            (padding, padding, padding + width, padding + height)).tobytes()).hexdigest(),
    }


def inspect(path: Path, time_ms: int, stem: Path, padding: int = 256) -> dict:
    width, height, padded_ass = _prepare(path, stem, padding)
    native, fonts = render(path, stem.with_suffix('.png'), width, height, time_ms)
    guard, guard_fonts = render(padded_ass, stem.with_name(stem.name + '-guard.png'),
                                width + 2 * padding, height + 2 * padding, time_ms)
    return _measure(native, guard, width, height, padding, fonts, guard_fonts)


def _can_render_series(source: str) -> bool:
    # libass retains automatic collision positions between frames. Only
    # explicitly positioned events avoid that state, as in MAW's layout slices.
    number = r'[-+]?(?:\d+(?:\.\d*)?|\.\d+)'
    position = re.compile(r'\\(pos|move)\(([^()]*)\)|[()]')
    for line in source.splitlines():
        if not line.startswith('Dialogue: '):
            continue
        positioned = False
        for block in re.findall(r'\{([^}]*)\}', line.split(',', 9)[-1]):
            depth = 0
            for token in position.finditer(block):
                if token[0] == '(':
                    depth += 1
                elif token[0] == ')':
                    depth -= 1
                elif depth == 0:
                    values = token[2].split(',')
                    valid_counts = (2,) if token[1] == 'pos' else (4, 6)
                    positioned |= len(values) in valid_counts and all(
                        re.fullmatch(number, value.strip()) for value in values)
        if not positioned:
            return False
    return True


def inspect_series(path: Path, times: list[int], stem: Path, padding: int = 256) -> list[dict]:
    width, height, padded_ass = _prepare(path, stem, padding)
    if not _can_render_series(path.read_text(encoding='utf-8')):
        # Preserve the original fresh-renderer oracle for automatic layout.
        # Native and guard remain separate real libass renders at every clock.
        rows = []
        logs = {'': [], '-guard': []}
        for index, time_ms in enumerate(times):
            native_path = stem.with_name(f'{stem.name}-{index}.png')
            guard_path = stem.with_name(f'{stem.name}-guard-{index}.png')
            native, fonts = render(path, native_path, width, height, time_ms)
            guard, guard_fonts = render(padded_ass, guard_path, width + 2 * padding,
                                        height + 2 * padding, time_ms)
            try:
                rows.append(_measure(native, guard, width, height, padding, fonts, guard_fonts))
            finally:
                native.close()
                guard.close()
            for suffix, target in (('', native_path), ('-guard', guard_path)):
                logs[suffix].append(f'=== sample {time_ms}ms ===\n' +
                                    target.with_suffix('.ffmpeg.log').read_text(encoding='utf-8'))
        for suffix, samples in logs.items():
            stem.with_name(stem.name + suffix).with_suffix('.ffmpeg.log').write_text(
                '\n'.join(samples), encoding='utf-8', newline='\n')
        return rows
    # fontselect diagnostics belong to this real ASS sequence: libass caches
    # selected faces across frames. Pixel metrics remain per timestamp.
    fonts = render_series(path, stem, width, height, times)
    guard_fonts = render_series(padded_ass, stem.with_name(stem.name + '-guard'),
                                width + 2 * padding, height + 2 * padding, times)
    rows = []
    for index in range(len(times)):
        # Measure the two original canvases one timestamp at a time.
        images = [Image.open(stem.with_name(f'{stem.name}{suffix}-{index}.png')).convert('RGB')
                  for suffix in ('', '-guard')]
        rows.append(_measure(*images, width, height, padding, fonts, guard_fonts))
        for image in images:
            image.close()
    return rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('ass', type=Path)
    parser.add_argument('time_ms', type=int)
    parser.add_argument('output', type=Path)
    parser.add_argument('--times', type=int, nargs='+', help='Render an ordered sequence of exact millisecond samples')
    args = parser.parse_args()
    if args.times is not None:
        if args.times != sorted(set(args.times)) or args.times[0] < 0 or args.time_ms not in args.times:
            parser.error('--times must be unique, increasing, nonnegative and include time_ms')
        result = inspect_series(args.ass.resolve(), args.times, args.output.resolve())
    else:
        result = inspect(args.ass.resolve(), args.time_ms, args.output.resolve())
    print(json.dumps(result))


if __name__ == '__main__':
    main()
