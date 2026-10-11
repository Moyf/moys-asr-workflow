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


def foreground(image: Image.Image) -> Image.Image:
    return ImageChops.difference(image, Image.new('RGB', image.size)).convert('L').point(
        lambda value: 255 if value > 8 else 0
    )


def count(mask: Image.Image) -> int:
    return mask.histogram()[255]


def paint_colours(image: Image.Image) -> dict:
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
        for row in range(image.height):
            row_mask = mask.crop((0, row, image.width, row + 1))
            max_row_painted = max(max_row_painted, count(row_mask))
            present = bool(row_mask.getbbox())
            if present and (not bands or bands[-1][1] != row - padding):
                bands.append([row - padding, row + 1 - padding])
            elif present:
                bands[-1][1] = row + 1 - padding
        output[name] = {
            'box': [value - padding for value in box] if box else None,
            'painted': count(mask),
            'bands': bands,
            'maxRowPainted': max_row_painted,
            'peak': max(ImageChops.multiply(channels[index], dominance).getextrema()),
            'glyphSha256': hashlib.sha256(
                Image.composite(image, Image.new('RGB', image.size), mask).crop(box).tobytes()
            ).hexdigest() if box else None,
        }
    return output


def inspect(path: Path, time_ms: int, stem: Path, padding: int = 256) -> dict:
    source = path.read_text(encoding='utf-8')
    width = int(re.search(r'^PlayResX:\s*(\d+)', source, re.M)[1])
    height = int(re.search(r'^PlayResY:\s*(\d+)', source, re.M)[1])
    native, fonts = render(path, stem.with_suffix('.png'), width, height, time_ms)
    padded_ass = stem.with_name(stem.name + '-guard.ass')
    padded_ass.write_text(translate_ass(source, padding), encoding='utf-8', newline='\n')
    guard, guard_fonts = render(padded_ass, stem.with_name(stem.name + '-guard.png'),
                   width + 2 * padding, height + 2 * padding, time_ms)
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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('ass', type=Path)
    parser.add_argument('time_ms', type=int)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    print(json.dumps(inspect(args.ass.resolve(), args.time_ms, args.output.resolve())))


if __name__ == '__main__':
    main()
