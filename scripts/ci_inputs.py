"""Shared inputs for website, preview and auxiliary checks."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
WEBSITE_INPUTS = frozenset(match[1] for match in re.findall(
    r'''\bsource\s*:\s*(['"])(.*?)\1''', (ROOT / 'website/scripts/sync-maw-docs.mjs').read_text(encoding='utf-8')
    .split('const documents = [', 1)[1].split('\n];', 1)[0]))


def preview_for(paths):
    return any(p.startswith(('maw/', 'server-editor/', 'web/launcher/', 'web/editor/boot/',
                             'web/shared/host/', 'scripts/packaging/', 'scripts/build-', 'desktop/'))
               or p in {'maw_gui.py', 'edit.py', 'pyproject.toml', 'uv.lock', 'package.json', 'pnpm-lock.yaml',
                        'web/editor-scripts.txt', 'web/launcher-scripts.txt', 'web/editor-modules.json',
                        'web/editor-template.html', 'docs/user/FAQ-常见问题.txt'} for p in paths)


def auxiliary_flags(plan):
    flags = {layer: bool(plan[field]) for layer, field in
             (('python', 'python_tests'), ('node', 'node_tests'), ('browser', 'e2e_specs'))}
    flags['selected'] = any(flags.values())
    flags['website'] = 'tests/e2e/editor-entry-retirement.spec.mjs' in plan['e2e_specs']
    prep = plan.get('preparation', {})
    for name in ('application', 'real_media', 'python_dependencies', 'node_browser'):
        flags[name] = bool(prep.get(name, False))
    for name in ('editor_bundle', 'launcher_bundle'):
        flags[name] = bool(prep.get(name, flags['application']))
    return flags
