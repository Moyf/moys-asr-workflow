"""Summarize run_check evidence; missing stages remain visible, never count as passes."""
import json
import os
from pathlib import Path

STAGES = ('python-deps', 'node-deps', 'media-foundation', 'chromium', 'ffmpeg',
          'media-tests', 'browser-media')


def summarize(root: Path) -> str:
    image_path = root / 'image.json'
    image = json.loads(image_path.read_text(encoding='utf-8-sig')) if image_path.exists() else {}
    lines = ['## Windows setup benchmark', '',
             f"Runner: {image.get('runner', 'unknown')}; image: {image.get('image', 'unknown')}; "
             f"sample: {image.get('sample', 'unknown')}",
             f"Media Foundation initially installed: {image.get('mediaFeatureInstalled', 'unknown')}",
             '', '| Stage | Seconds | Result |', '| --- | ---: | --- |']
    for stage in STAGES:
        paths = sorted((root / stage).glob('*/result.json'))
        if len(paths) != 1:
            lines.append(f'| {stage} | — | Missing or ambiguous evidence |')
            continue
        result = json.loads(paths[0].read_text(encoding='utf-8'))
        lines.append(f"| {stage} | {result['duration_seconds']} | "
                     f"{result['status']}, exit {result['exit_code']} |")
    lines += ['', 'Tool setup/cache restore durations are separate GitHub job steps. '
              'Read cache hit/miss logs before comparing samples; samples are not guaranteed cold/warm pairs.',
              'Compare end-to-end job time as well as installation time. '
              'Passing these smoke checks does not establish full product regression equivalence.']
    return '\n'.join(lines) + '\n'


if __name__ == '__main__':
    result = summarize(Path('.artifacts/setup-benchmark'))
    print(result)
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as stream:
            stream.write(result)
