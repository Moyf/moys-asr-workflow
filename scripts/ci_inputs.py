"""Document inputs consumed by the public website."""
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
