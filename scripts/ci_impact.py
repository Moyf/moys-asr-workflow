"""Finite admission for 2.0dev; unknown inputs never select full inspection."""
from __future__ import annotations

import argparse
from functools import lru_cache
import json
import os
from pathlib import Path
import re
import subprocess

VERSION = 2
CHECKS = ('docs', 'website', 'release', 'tools', 'build', 'data', 'editor', 'launcher', 'runtime', 'ci')
SHA = re.compile(r'[0-9a-f]{40}')
ROOT = Path(__file__).resolve().parents[1]
if __package__:
    from .ci_inputs import WEBSITE_INPUTS as WEBSITE_INPUTS, preview_for
else:
    from ci_inputs import WEBSITE_INPUTS as WEBSITE_INPUTS, preview_for


def valid_paths(paths):
    return isinstance(paths, list) and bool(paths) and all(
        isinstance(p, str) and p and not p.startswith('/') and '\\' not in p and ':' not in p
        and not any(ord(c) < 32 or ord(c) == 127 for c in p)
        and not any(part in {'', '.', '..'} for part in p.split('/')) for p in paths)


@lru_cache(maxsize=8)
def _impact_for(paths, base_ref):
    if __package__:
        from .local_test_impact import select_packs
    else:
        from local_test_impact import select_packs
    return select_packs(list(paths), base_ref=base_ref)


def checks_for(paths, *, base_ref=None):
    if not valid_paths(paths):
        return list(CHECKS)
    # The local and CI paths share concrete consumers; admission remains the
    # existing, explicitly audited subset rather than another domain graph.
    if __package__:
        from .ci_acceptance import NODE, PYTHON
    else:
        from ci_acceptance import NODE, PYTHON
    impact = _impact_for(tuple(sorted(paths)), base_ref)
    if impact['mode'] == 'full' or impact.get('fallback_checks'):
        return list(CHECKS)
    selected = set(impact['packs']) & {'docs', 'website', 'release', 'tools'}
    python_files = set(impact['python_tests'])
    node_files = set(impact['node_tests'])
    for check, targets in PYTHON.items():
        files = {target if target.endswith('.py') else target.split('.')[0] + '/' + target.split('.')[1] + '.py'
                 for target in targets}
        if python_files & files:
            selected.add(check)
    for check, files in NODE.items():
        if node_files.intersection(files):
            selected.add(check)
    return [c for c in CHECKS if c in selected]


def plan(paths, *, base='', head='', trusted=False, manual_preview=False):
    checks = checks_for(paths, base_ref=base) if trusted else list(CHECKS)
    light = set(checks) <= {'docs', 'website', 'release', 'tools'}
    if trusted and _impact_for(tuple(sorted(paths)), base).get('fallback_checks'):
        reason = 'WARNING: unknown impact; finite admission and manual risk review required'
    elif not checks:
        reason = 'No admitted consumer identified; review separate auxiliary results.'
    else:
        reason = 'declared consumers' if light else 'finite admission; not full coverage'
    return dict(version=VERSION, namespace='blocking-2dev', checks=checks, head=head, base=base,
                paths=sorted(paths) if trusted else [], trusted_diff=trusted, light=light,
                preview=preview_for(paths) if trusted else manual_preview, manual_preview=manual_preview,
                reason=reason)


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
    parser.add_argument('--aux-plan', type=Path)
    args = parser.parse_args()
    value = select(os.environ.get('GITHUB_EVENT_NAME', ''), os.environ.get('PR_BASE_SHA', ''),
                   before=os.environ.get('PUSH_BEFORE_SHA', ''), after=os.environ.get('GITHUB_SHA', ''))
    encoded = json.dumps(value, separators=(',', ':'))
    if args.plan:
        args.plan.parent.mkdir(parents=True, exist_ok=True)
        args.plan.write_text(encoded + '\n', encoding='utf-8', newline='\n')
    if args.aux_plan:
        try:
            if __package__:
                from . import ci_auxiliary
            else:
                import ci_auxiliary
            impact = _impact_for(tuple(value['paths']), value['base']) if value['trusted_diff'] else None
            auxiliary = ci_auxiliary.auxiliary_plan(value, impact=impact, validated=True)
            ci_auxiliary.write_plan(auxiliary, args.aux_plan)
        except Exception as error:
            # Auxiliary planning is deliberately not an admission dependency;
            # its own job will show the error and fail visibly.
            args.aux_plan.parent.mkdir(parents=True, exist_ok=True)
            args.aux_plan.write_text(json.dumps({'generation_error': str(error)}) + '\n', encoding='utf-8')
            if os.environ.get('GITHUB_OUTPUT'):
                with Path(os.environ['GITHUB_OUTPUT']).open('a', encoding='utf-8', newline='\n') as stream:
                    stream.write('aux_selected=true\naux_error=true\n')
    print(encoded)
    if os.environ.get('GITHUB_OUTPUT'):
        with Path(os.environ['GITHUB_OUTPUT']).open('a', encoding='utf-8', newline='\n') as stream:
            stream.write(f'light={str(value["light"]).lower()}\npreview={str(value["preview"]).lower()}\nplan={encoded}\n')
            stream.write(f'has_checks={str(bool(value["checks"])).lower()}\n')
            stream.write('matrix=' + json.dumps({'include': [{'check': c} for c in value['checks']] or [{'check': 'none'}]}) + '\n')


if __name__ == '__main__':
    main()
