"""Prepare a draft, upload and verify packages, then publish; only called by release CI."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess

try:
    from .prepare_release_notes import REPO, parse_tag
except ImportError:
    from prepare_release_notes import REPO, parse_tag


def gh(*args: str):
    result = subprocess.run(['gh', *args], capture_output=True, text=True, timeout=300)
    if result.returncode:
        raise RuntimeError(f'GitHub command failed ({result.returncode}): {result.stderr[:600]}')
    return result.stdout


def find_release(tag: str) -> dict | None:
    """Page the full release list; drafts are invisible to the by-tag endpoint."""
    for page in range(1, 11):
        batch = json.loads(gh('api', f'repos/{REPO}/releases?per_page=100&page={page}'))
        if not isinstance(batch, list):
            raise ValueError('GitHub releases response is not a list')
        for release in batch:
            if release.get('tag_name') == tag:
                return release
        if len(batch) < 100:
            return None
    raise ValueError('release lookup exceeded pagination limit')


def publish(tag: str, notes: Path, directory: Path) -> None:
    version = parse_tag(tag)
    prerelease = 'true' if version[4] else 'false'
    names = [f'MAW-Windows-x64-{tag}.zip', f'MAW-lite-Windows-x64-{tag}.zip']
    for platform, extension in [('macOS-arm64', 'zip'), ('Linux-x86_64', 'AppImage')]:
        name = f'MAW-{platform}-{tag}.{extension}'
        if (directory / name).is_file():
            names.append(name)
            if platform.startswith('macOS'):
                names.append(f'MAW-lite-{platform}-{tag}.{extension}')
    for name in names:
        if not (directory / name).is_file() or (directory / name).stat().st_size == 0:
            raise ValueError(f'missing or empty package: {name}')
    if not notes.is_file():
        raise ValueError('release notes missing')
    release = find_release(tag)
    if release is None:
        gh('release', 'create', tag, '--draft', '--verify-tag', '--title', tag,
           '--notes-file', str(notes), f'--prerelease={prerelease}')
    else:
        gh('release', 'edit', tag, '--title', tag, '--notes-file', str(notes), f'--prerelease={prerelease}')
    gh('release', 'upload', tag, *(str(directory / name) for name in names), '--clobber')
    uploaded = find_release(tag)
    if uploaded is None:
        raise ValueError(f'release disappeared during upload: {tag}')
    assets = {asset['name']: asset for asset in uploaded.get('assets', [])}
    for name in names:
        asset = assets.get(name, {})
        if asset.get('state') != 'uploaded' or asset.get('size') != (directory / name).stat().st_size:
            raise ValueError(f'uploaded package did not verify: {name}; draft remains unpublished')
    gh('release', 'edit', tag, '--draft=false', f'--prerelease={prerelease}')
    final = find_release(tag)
    if final is None or final.get('draft') or final.get('prerelease') != bool(version[4]):
        raise ValueError('release publication state did not verify')
    print(f'Published and verified {tag}: {len(names)} packages')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tag', required=True)
    parser.add_argument('--notes', type=Path, required=True)
    parser.add_argument('--artifacts', type=Path, required=True)
    args = parser.parse_args()
    publish(args.tag, args.notes, args.artifacts)
