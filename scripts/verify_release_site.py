"""Verify a deployed update index and its target detail/notes pages."""
from __future__ import annotations

import argparse
import json
import time
from urllib.request import urlopen

try:
    from .build_release_site import stable_key
except ImportError:
    from build_release_site import stable_key


def verify(base_url: str, expected_tag: str = '') -> None:
    with urlopen(base_url.rstrip('/') + '/releases/index.json', timeout=15) as response:
        index = json.load(response)
    if index.get('schema_version') != 1:
        raise ValueError('unsupported update feed schema')
    versions = [entry['version'] for entry in index['releases']]
    if versions != sorted(set(versions), key=stable_key, reverse=True):
        raise ValueError('update feed is not in unique stable version order')
    if index['latest_stable'] != (versions[0] if versions else None):
        raise ValueError('latest_stable does not match catalog')
    target = expected_tag.removeprefix('v') if expected_tag else index['latest_stable']
    if target is None:
        return
    if target not in versions:
        raise ValueError(f'deployed catalog has not caught up to {expected_tag}')
    base = base_url.rstrip('/')
    with urlopen(f'{base}/releases/{target}/notes.json', timeout=15) as response:
        notes = json.load(response)
    if notes.get('schema_version') != 1 or notes.get('version') != target or not notes.get('body_markdown'):
        raise ValueError('version notes did not verify')
    with urlopen(f'{base}/releases/{target}/', timeout=15) as response:
        if response.status != 200:
            raise ValueError('version detail page unavailable')
    print(f'Deployed release site verified: {target}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', required=True)
    parser.add_argument('--expected-tag', default='')
    args = parser.parse_args()
    for attempt in range(4):
        try:
            verify(args.base_url, args.expected_tag)
            break
        except (ValueError, OSError):
            if attempt == 3:
                raise
            time.sleep(5)
