"""Finite admission for 2.0dev; unknown inputs never select full inspection."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess

VERSION = 2
CHECKS = ('docs', 'website', 'release', 'tools', 'build', 'data', 'editor', 'launcher', 'runtime', 'ci')
SHA = re.compile(r'[0-9a-f]{40}')
ROOT = Path(__file__).resolve().parents[1]
# The website's curated source map is the authority, including the few
# engineering/log pages it really publishes. Ordinary engineering prose stays light.
WEBSITE_INPUTS = frozenset(match[1] for match in re.findall(
    r'''\bsource\s*:\s*(['"])(.*?)\1''', (ROOT / 'website/scripts/sync-maw-docs.mjs').read_text(encoding='utf-8')
    .split('const documents = [', 1)[1].split('\n];', 1)[0]))


def valid_paths(paths):
    return isinstance(paths, list) and bool(paths) and all(
        isinstance(p, str) and p and not p.startswith('/') and '\\' not in p and ':' not in p
        and not any(ord(c) < 32 or ord(c) == 127 for c in p)
        and not any(part in {'', '.', '..'} for part in p.split('/')) for p in paths)


def consumers(path):
    # Fixtures and data are executable inputs even when their extension is .md.
    if any(part in {'fixtures', 'data'} for part in path.split('/')):
        return None
    if path == 'docs/user/FAQ-常见问题.txt':
        return None  # Frozen package input, not an explanatory guide.
    if path.endswith('.checklist.md'):
        return {'docs', 'tools'}
    if path == 'CHANGELOG.md' or path.startswith('docs/releases/'):
        return {'docs', 'release'}
    if path.startswith('tools/') and path.endswith('.md'):
        return {'docs', 'tools'}
    if path in WEBSITE_INPUTS or path == 'README.md' or path.startswith(('docs/user/', 'docs/assets/', 'website/')):
        return {'docs', 'website'}
    if path.endswith('.md') and (path.startswith(('docs/engineering/', 'docs/plans/', 'docs/logs/'))
                                or path in {'AGENTS.md', 'docs/AGENTS.md', 'docs/README.md', 'docs/INDEX.md'}):
        return {'docs'}
    if path in {'web/editor/io/editor-project-save.js', 'web/editor/state/editor-state.js',
                'web/editor/state/editor-commands.js'}:
        return {'build', 'data', 'editor', 'runtime'}
    return None


def checks_for(paths):
    if not valid_paths(paths):
        return list(CHECKS)
    selected = set()
    for path in paths:
        owned = consumers(path)
        if owned is None:
            return list(CHECKS)
        selected.update(owned)
    return [c for c in CHECKS if c in selected]


def preview_for(paths):
    return any(p.startswith(('maw/', 'server-editor/', 'web/launcher/', 'web/editor/boot/',
                             'web/shared/host/', 'scripts/packaging/', 'scripts/build-', 'desktop/'))
               or p in {'maw_gui.py', 'edit.py', 'pyproject.toml', 'uv.lock', 'package.json', 'pnpm-lock.yaml',
                        'web/editor-scripts.txt', 'web/launcher-scripts.txt', 'web/editor-modules.json',
                        'web/editor-template.html', 'docs/user/FAQ-常见问题.txt',
                        '.github/workflows/pr-release-windows.yml'} for p in paths)


def plan(paths, *, base='', head='', trusted=False, manual_preview=False):
    checks = checks_for(paths) if trusted else list(CHECKS)
    light = set(checks) <= {'docs', 'website', 'release', 'tools'}
    return dict(version=VERSION, namespace='blocking-2dev', checks=checks, head=head, base=base,
                paths=sorted(paths) if trusted else [], trusted_diff=trusted, light=light,
                preview=preview_for(paths) if trusted else manual_preview, manual_preview=manual_preview,
                reason='declared consumers' if light else 'finite admission; not full coverage')


def select(event, base='', cwd=None, *, before='', after=''):
    def git(*args):
        return subprocess.check_output(['git', *args], cwd=cwd, stderr=subprocess.PIPE)
    head = ''
    try:
        head = git('rev-parse', 'HEAD').decode('ascii').strip()
        if not SHA.fullmatch(head) or (after and after != head):
            raise ValueError('wrong event SHA')
        if event == 'pull_request':
            if not SHA.fullmatch(base) or git('rev-parse', 'HEAD^1').decode('ascii').strip() != base:
                raise ValueError('untrusted merge base')
        elif event == 'push':
            base = before
            if not after or not SHA.fullmatch(base) or base == '0' * 40:
                raise ValueError('missing push before/after')
        else:
            raise ValueError('no event diff')
        if git('rev-parse', '--is-shallow-repository').strip() != b'false':
            raise ValueError('shallow history')
        git('merge-base', '--is-ancestor', base, head)
        raw = git('diff', '--name-only', '--no-renames', '-z', base, head)
        if not raw.endswith(b'\0'):
            raise ValueError('empty or truncated diff')
        paths = [p.decode('utf-8') for p in raw.split(b'\0')[:-1]]
        if not valid_paths(paths):
            raise ValueError('invalid paths')
        return plan(paths, base=base, head=head, trusted=True)
    except (OSError, subprocess.SubprocessError, UnicodeError, ValueError):
        result = plan([], head=head, manual_preview=event == 'workflow_dispatch')
        result['reason'] = 'WARNING: untrusted diff; finite fallback, manual risk review required'
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path)
    args = parser.parse_args()
    value = select(os.environ.get('GITHUB_EVENT_NAME', ''), os.environ.get('PR_BASE_SHA', ''),
                   before=os.environ.get('PUSH_BEFORE_SHA', ''), after=os.environ.get('GITHUB_SHA', ''))
    encoded = json.dumps(value, separators=(',', ':'))
    if args.plan:
        args.plan.parent.mkdir(parents=True, exist_ok=True)
        args.plan.write_text(encoded + '\n', encoding='utf-8', newline='\n')
    print(encoded)
    if os.environ.get('GITHUB_OUTPUT'):
        with Path(os.environ['GITHUB_OUTPUT']).open('a', encoding='utf-8', newline='\n') as stream:
            stream.write(f'light={str(value["light"]).lower()}\npreview={str(value["preview"]).lower()}\nplan={encoded}\n')
            stream.write('matrix=' + json.dumps({'include': [{'check': c} for c in value['checks']]}) + '\n')


if __name__ == '__main__':
    main()
