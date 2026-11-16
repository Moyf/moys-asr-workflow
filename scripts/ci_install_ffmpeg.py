"""Install Windows CI FFmpeg with bounded retries for transient feed failures.

This only prepares binaries; the composite action still requires real codecs.
"""
import os
from pathlib import Path
import re
import sys
import time

if __package__:
    from .run_check import run
else:
    from run_check import run

ATTEMPTS = 3
TRANSIENT = re.compile(r'\b(?:408|429|50[0-9])\b|timed?\s*out|temporary failure|name resolution', re.I)


def find_binaries(root):
    directory = root / 'lib' / 'ffmpeg' / 'tools'
    return next((p for p in sorted(directory.rglob('ffmpeg.exe'))
                 if p.is_file() and p.with_name('ffprobe.exe').is_file()), None)


def install(root):
    for attempt in range(1, ATTEMPTS + 1):
        print(f'FFmpeg installation attempt {attempt}/{ATTEMPTS}', flush=True)
        code, result = run(['choco', 'install', 'ffmpeg', '--yes', '--no-progress'],
                           180, Path('.artifacts/checks'))
        print(f"Chocolatey exit={code}; log: {result['log']}", flush=True)
        for line in result['diagnostics'] + result['tail']:
            print(line, flush=True)
        # Do not retry timeouts/cleanup failures: a partially stopped installer
        # must never race another attempt. run_check owns process-tree cleanup.
        if result['status'] != 'completed' or result['cleanup_error']:
            raise RuntimeError(f"FFmpeg installation stopped: {result['status']}; "
                               f"cleanup={result['cleanup_error']}; see installation log")
        binary = find_binaries(root)
        if code == 0 and binary is not None:
            return binary.parent
        with Path(result['log']).open('rb') as stream:
            output = stream.read(1024 * 1024).decode('utf-8', errors='replace')
        transient = bool(TRANSIENT.search(output))
        reason = f'exit={code}; ffmpeg/ffprobe pair present={binary is not None}'
        if not transient or attempt == ATTEMPTS:
            raise RuntimeError(f'FFmpeg installation failed: {reason}; no usable installation accepted')
        print(f'Transient FFmpeg feed/install failure ({reason}); retrying in 5 seconds', flush=True)
        time.sleep(5)
    raise AssertionError('unreachable')


def main():
    root = Path(os.environ['ChocolateyInstall'])
    path_file = Path(os.environ['GITHUB_PATH'])
    directory = install(root)
    with path_file.open('a', encoding='utf-8', newline='\n') as stream:
        stream.write(str(directory) + '\n')


if __name__ == '__main__':
    try:
        main()
    except (OSError, RuntimeError, KeyError) as error:
        print(f'::error::{error}', file=sys.stderr)
        raise SystemExit(1)
