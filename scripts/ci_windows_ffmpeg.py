"""Install the release-pinned Windows FFmpeg archive for CI media tests."""

import hashlib
from http.client import HTTPException
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
from urllib.request import urlopen
from zipfile import ZipFile

VERSION = '8.1.2'
SHA256 = 'db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec'
ARCHIVE = f'ffmpeg-{VERSION}-essentials_build.zip'
URLS = (
    f'https://www.gyan.dev/ffmpeg/builds/packages/{ARCHIVE}',
    f'https://github.com/GyanD/codexffmpeg/releases/download/{VERSION}/{ARCHIVE}',
)
ATTEMPTS = 3


def verified(path):
    if not path.is_file():
        return False
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest() == SHA256


def download_to_file(url, destination):
    with urlopen(url, timeout=120) as response, destination.open('wb') as output:
        shutil.copyfileobj(response, output)


def download(url, destination):
    # A socket timeout alone does not bound a slowly streaming response.
    subprocess.run([sys.executable, __file__, '--download', url, str(destination)],
                   check=True, timeout=120)


def prepare_archive(cache):
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / ARCHIVE
    if verified(archive):
        print('Using verified cached FFmpeg archive', flush=True)
        return archive
    if archive.exists():
        print('Cached FFmpeg archive failed SHA-256; downloading again', flush=True)
        archive.unlink()
    partial = cache / (ARCHIVE + '.part')
    for url in URLS:
        for attempt in range(1, ATTEMPTS + 1):
            try:
                print(f'Downloading {url} (attempt {attempt}/{ATTEMPTS})', flush=True)
                download(url, partial)
                if not verified(partial):
                    raise ValueError('FFmpeg archive SHA-256 mismatch')
                partial.replace(archive)
                return archive
            except (OSError, ValueError, HTTPException, subprocess.SubprocessError) as error:
                partial.unlink(missing_ok=True)
                print(f'FFmpeg download failed: {error}', flush=True)
                if attempt < ATTEMPTS:
                    time.sleep(10)
    raise RuntimeError('Unable to download a verified FFmpeg archive from either source')


def install(cache, destination):
    archive = prepare_archive(cache)
    # Only copy the two expected files. Never extract arbitrary ZIP paths.
    prefix = f'ffmpeg-{VERSION}-essentials_build/bin/'
    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True)
    with ZipFile(archive) as package:
        for name in ('ffmpeg.exe', 'ffprobe.exe'):
            with package.open(prefix + name) as source, (destination / name).open('wb') as target:
                shutil.copyfileobj(source, target)
    for name in ('ffmpeg.exe', 'ffprobe.exe'):
        subprocess.run([str(destination / name), '-version'], check=True, timeout=30)
    return destination.resolve()


def main():
    root = Path(os.environ['RUNNER_TEMP'])
    directory = install(root / 'maw-ffmpeg-cache', root / 'maw-ffmpeg-bin')
    with Path(os.environ['GITHUB_PATH']).open('a', encoding='utf-8', newline='\n') as stream:
        stream.write(str(directory) + '\n')


if __name__ == '__main__':
    try:
        if len(sys.argv) == 4 and sys.argv[1] == '--download':
            download_to_file(sys.argv[2], Path(sys.argv[3]))
        else:
            main()
    except (OSError, ValueError, RuntimeError, KeyError, HTTPException, subprocess.SubprocessError) as error:
        print(f'::error::Windows CI FFmpeg installation failed: {error}', file=sys.stderr)
        raise SystemExit(1)
