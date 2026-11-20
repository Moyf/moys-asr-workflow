"""Select test consumers for local feedback and the finite CI gate."""
from __future__ import annotations

from hashlib import sha256
import json
from pathlib import Path
import re
import subprocess

try:
    from .ci_inputs import WEBSITE_INPUTS, preview_for
    from .test_impact_graph import file_consumers, python_consumers, web_behavior_consumers, node_python_dependencies, document_consumers, python_test_dependencies, bundles_consumed, browser_application_consumed, browser_ffmpeg_consumed
    from .test_policy import MEDIA_CLASSES, MEDIA_METHODS, MEDIA_MODULES
except ImportError:
    from ci_inputs import WEBSITE_INPUTS, preview_for
    from test_impact_graph import file_consumers, python_consumers, web_behavior_consumers, node_python_dependencies, document_consumers, python_test_dependencies, bundles_consumed, browser_application_consumed, browser_ffmpeg_consumed
    from test_policy import MEDIA_CLASSES, MEDIA_METHODS, MEDIA_MODULES

ROOT = Path(__file__).resolve().parents[1]
NODE_BROWSER = {'test_asr_presets_browser.mjs', 'test_ass_canvas_raster.mjs', 'test_shared_tooltip_browser.mjs'}
NODE_TOOLS = {'test_ns_rewrite_scope.mjs', 'test_refactor_layout_tools.mjs', 'test_type_gate.mjs', 'test_verification_checklist.mjs'}
CHECKLIST_PYTHON = ('tests.test_verification_checklist', 'tests.test_verification_checklist_build')
CHECKLIST_NODE = 'tests/test_verification_checklist.mjs'
CHECKLIST_SPEC = 'tests/e2e/verification-checklist.spec.mjs'
CHECKLIST_SPECS = (CHECKLIST_SPEC, 'tests/e2e/tool-compact.spec.mjs', 'tests/e2e/tool-pages.spec.mjs')
DEV_PYTHON = ('tests.test_project_contract', 'tests.test_project_io', 'tests.test_project_backups')
DEV_NODE = ('test_editor_runtime.mjs', 'test_editor_state.mjs', 'test_editor_commands.mjs',
            'test_editor_host.mjs', 'test_editor_history_gestures.mjs')
ALL_MERGE = {'common', 'browser', 'smoke', 'media', 'long-media', 'lifecycle', 'tools', 'editor-e2e', 'website'}
MARKER_RUNTIME_SPECS = (
    'marker-editing-gate', 'marker-feedback', 'markers-batch',
    'ai-cleanup-marker-restore', 'ai-cleanup-local-review-fallback',
    'ai-cleanup-local-punctuation',
)
# Pin the source pairs reviewed for G12 against 2.0dev at 4fd058e0.
# This exception expires automatically when either side changes. A textual
# rewrite of JavaScript cannot distinguish calls from strings or shadowed names.
MARKER_MIGRATION_FILES = {
    'web/editor/io/editor-project-load.js': (
        '3154cab3d8d9a8e67182057eb64dd98ef49357c700865d33a3bdf605745d7609',
        'f20a17551985c736f48c7db3040bd62b1482fe108af6a1625d52270328208987',
    ),
    'web/editor/markers/editor-marker-editing.js': (
        'e7270b3e8d3e6f00e52c0f7a82a54c3e2d48a9b5fd97da047c3d997a531f4d11',
        'b2d6937077db673ce943482dd30124b5156682f0f28d98a5e77193e845d655aa',
    ),
    'web/editor/markers/editor-markers-panel.js': (
        '1a52f3f9522b410c9e9126b92d7f117b925171468e3e84ef69dd74e5cf088ca3',
        '6595260e64b0e26f4bedc17e63a7b28306ec47dad801545624d01eefc08c4a84',
    ),
    'web/editor/media/editor-waveform-init.js': (
        '514ae260fe15edad4720c8a968afb00a6a3ffa7fa5fea975f8b9c18b39b7ad24',
        '4920df727e924715075934af9a4bbb57f6e0e11412012a018f4d4bd258d103e2',
    ),
    'web/editor/state/editor-history.js': (
        'b39fd2f7057dea3dd5ee58be19df1f42b2b69a1e531bac72b6f5ba4bcc711ae8',
        '0d2e6a3b6d624530e2a51ac83f222db2132a1bb2bd87fa81f102228b84faf82f',
    ),
    'web/editor/ui/editor-gap-remove-ui.js': (
        '97392ff4a69d7394bf0a35f72bf1e0d4d7babcc67c8c6881eb9749e734455d4c',
        '5b85cf104a42a2dc8af5baaac84cf3ce710fd6b8567ceecf174fce8b6f4db352',
    ),
    'web/editor/ui/editor-settings-panels.js': (
        'f429fc15cd21d03e90408a23d0dff57a34c09b9d66dc9cfb5ede2bfeb26c068e',
        '7c599450712783e88a1ff12afdc853188192e33876f735b3bd2c016b9c049dcf',
    ),
}
MARKER_MODULES = {
    'web/editor/markers/editor-marker-editing.js',
    'web/editor/markers/editor-markers-panel.js',
}


def marker_migration_only(path: str, base_ref: str | None) -> bool:
    pair = MARKER_MIGRATION_FILES.get(path)
    if not base_ref or pair is None:
        return False
    try:
        before = subprocess.check_output(['git', 'show', f'{base_ref}:{path}'], cwd=ROOT, stderr=subprocess.DEVNULL)
        after = (ROOT / path).read_bytes().replace(b'\r\n', b'\n')
    except (OSError, subprocess.SubprocessError):
        return False
    return (sha256(before).hexdigest(), sha256(after).hexdigest()) == pair


def node_pack(filename: str) -> str:
    if filename in NODE_BROWSER:
        return 'browser'
    if filename.startswith('test_e2e_'):
        return 'lifecycle'
    if filename in NODE_TOOLS:
        return 'tools'
    return 'common'


def select_packs(paths: list[str], *, release: bool = False, base_ref: str | None = None) -> dict:
    def full(reason):
        return {'mode': 'full', 'packs': sorted(ALL_MERGE | {'docs'}), 'python_tests': [], 'node_tests': [],
                'e2e_specs': [], 'tools_scope': 'all', 'reasons': [reason], 'fallback_checks': True,
                'preparation': {'application': True, 'editor_bundle': True, 'launcher_bundle': True,
                                'real_media': True, 'lint': True, 'preview_windows': True,
                                'python_dependencies': True, 'node_browser': True}}
    if release or paths is None:
        return full('release or unavailable change list')
    if paths == []:
        return {'mode': 'targeted', 'packs': [], 'python_tests': [], 'node_tests': [], 'e2e_specs': [],
                'tools_scope': 'all', 'fallback_checks': False, 'reasons': ['no changes'],
                'preparation': {'application': False, 'editor_bundle': False, 'launcher_bundle': False,
                                'real_media': False, 'lint': False, 'preview_windows': False,
                                'python_dependencies': False, 'node_browser': False}}
    if any(not isinstance(path, str) for path in paths):
        return full('invalid change list')
    normalized = sorted(set(p.replace('\\', '/').removeprefix('./') for p in paths))
    if any(not p or p.startswith('/') or ':' in p or any(ord(c) < 32 or ord(c) == 127 for c in p)
           or any(part in {'', '.', '..'} for part in p.split('/')) for p in normalized):
        return full('invalid change path')
    if any(p in {'uv.lock', 'pyproject.toml', 'pnpm-lock.yaml', 'website/pnpm-lock.yaml'} for p in normalized):
        return full('shared dependency or runtime contract')
    if 'package.json' in normalized:
        try:
            before = json.loads(subprocess.check_output(['git', 'show', f'{base_ref or "HEAD"}:package.json'], cwd=ROOT))
            after = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
            if {k: v for k, v in before.items() if k != 'scripts'} != {k: v for k, v in after.items() if k != 'scripts'}:
                return full('package dependencies or runtime contract changed')
        except (OSError, ValueError, TypeError, subprocess.SubprocessError):
            return full('cannot verify shared package dependency changes')

    python, node, specs, packs, reasons = set(), set(), set(), set(), []
    fallback = False
    media = False
    bundles = set()
    lint = any(p.endswith('.py') and p.startswith(('maw/', 'scripts/', 'server-editor/')) for p in normalized)
    docs = []
    domains = []
    for path in normalized:
        parts = path.split('/')
        is_document = (path in {'README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'AGENTS.md'}
                       or path.startswith(('docs/', 'website/'))
                       or path.startswith('tools/') and path.endswith('.md'))
        if any(part in {'fixtures', 'data'} for part in parts) or path == 'docs/user/FAQ-常见问题.txt':
            is_document = False
        if path.startswith('website/scripts/'):
            is_document = False
        if is_document:
            docs.append(path)
            packs.add('docs')
            if (ROOT / 'tests/test_docs_check.py').is_file():
                python.add('tests/test_docs_check.py')
            if path in WEBSITE_INPUTS or path == 'README.md' or path.startswith(('docs/user/', 'docs/assets/', 'website/')):
                packs.add('website')
            if path == 'CHANGELOG.md' or path.startswith('docs/releases/'):
                packs.add('release')
                python.update(p for p in ('tests/test_release_notes.py', 'tests/test_release_site.py',
                                          'tests/test_release_publication.py') if (ROOT / p).is_file())
            if path.startswith('tools/') or path.endswith('.checklist.md'):
                packs.add('tools')
                if (ROOT / 'tests/test_tool_markdown.mjs').is_file():
                    node.add('tests/test_tool_markdown.mjs')
            continue
        domains.append(path)
    if docs:
        reasons.append('document, website, release and tool consumers')
        for consumer in document_consumers(ROOT, docs):
            if consumer.endswith('.py'):
                python.add(consumer)
            elif consumer.endswith('.spec.mjs'):
                specs.add(consumer)
            else:
                node.add(consumer)
        if any(p in {'docs/engineering/JSON_SCHEMA.md', 'website/src/pages/docs/json-schema.md'} for p in docs):
            python.update(p for p in ('tests/test_project_contract.py', 'tests/test_project_io.py') if (ROOT / p).is_file())
            specs.update(p for p in ('tests/e2e/project-boundary.spec.mjs', 'tests/e2e/v2-migration-save.spec.mjs') if (ROOT / p).is_file())
            reasons.append('project schema and migration consumers')

    def add_consumers(path, consumers):
        if consumers:
            covered.add(path)
        for consumer in consumers:
            if consumer.endswith('.py'):
                python.add(consumer)
            elif consumer.endswith('.spec.mjs'):
                specs.add(consumer)
            elif consumer.endswith('.mjs'):
                node.add(consumer)

    covered = set()
    inputs = []
    for path in domains:
        if (path.startswith('tests/test_') and path.endswith(('.py', '.mjs'))
                or path.startswith('tests/e2e/') and path.endswith('.spec.mjs')):
            if (ROOT / path).is_file():
                add_consumers(path, [path])
        else:
            inputs.append(path)

    python_inputs = [p for p in inputs if p.endswith('.py')]
    if python_inputs:
        reached, bad = python_consumers(ROOT, python_inputs)
        for path, consumers in reached.items():
            add_consumers(path, consumers)
        if bad:
            fallback = True
            reasons.append('unparseable Python input: finite contract checks need review')
    if inputs:
        web = [p for p in inputs if p.startswith('web/') and p.endswith(('.js', '.mjs'))]
        marker_migrations = {p for p in web if marker_migration_only(p, base_ref)}
        for path, consumers in file_consumers(ROOT, inputs).items():
            add_consumers(path, consumers)
        if web:
            for path, consumers in web_behavior_consumers(
                    ROOT, [p for p in web if p not in marker_migrations or p in MARKER_MODULES]).items():
                add_consumers(path, consumers)
            for path in marker_migrations:
                add_consumers(path, [f'tests/e2e/{name}.spec.mjs' for name in MARKER_RUNTIME_SPECS
                                     if (ROOT / f'tests/e2e/{name}.spec.mjs').is_file()])
                if path in MARKER_MODULES:
                    add_consumers(path, [p for p in ('tests/test_editor_marker_esm.mjs',
                                                    'tests/test_editor_marker_preferences.mjs') if (ROOT / p).is_file()])
        for path in web:
            if path.startswith(('web/editor/', 'web/shared/')):
                add_consumers(path, [p for p in (
                    'tests/test_editor_script_syntax.mjs', 'tests/test_editor_script_order.mjs'
                ) if (ROOT / p).is_file()])
            if path.startswith(('web/launcher/', 'web/shared/')):
                add_consumers(path, ['tests/test_launcher_script_syntax.mjs']
                              if (ROOT / 'tests/test_launcher_script_syntax.mjs').is_file() else [])
        for path in web:
            component = path.split('/')[1]
            bundles.update({component} if component in {'editor', 'launcher'} else {'editor', 'launcher'})
        reasons.append('direct imports, reads and exercised UI consumers')

    # Thumbnail jobs are reached through a dynamically loaded server endpoint;
    # the specs actually call that endpoint rather than merely starting Server.
    thumbnail_inputs = [p for p in domains if p.startswith('maw/thumbnail')]
    if thumbnail_inputs:
        thumbnail_specs = []
        for file in (ROOT / 'tests/e2e').glob('*.spec.mjs'):
            try:
                if '/api/thumbnails' in file.read_text(encoding='utf-8'):
                    thumbnail_specs.append(file.relative_to(ROOT).as_posix())
            except (OSError, UnicodeError):
                fallback = True
        for path in thumbnail_inputs:
            add_consumers(path, thumbnail_specs)
        reasons.append('thumbnail server endpoint consumers')
    checklist_inputs = [p for p in domains if p.startswith('tools/verification-checklist/')]
    if checklist_inputs:
        packs.update({'docs', 'tools'})
        checklist_tests = [f'tests/{name.rsplit(".", 1)[-1]}.py' for name in CHECKLIST_PYTHON]
        consumers = [p for p in (*checklist_tests, CHECKLIST_NODE, *CHECKLIST_SPECS) if (ROOT / p).is_file()]
        for path in checklist_inputs:
            add_consumers(path, consumers)
    if 'scripts/build-tool-docs.mjs' in domains:
        packs.add('docs')
    if any(p.startswith('website/scripts/') for p in domains):
        packs.add('website')
    # Missing/deleted files remain graph inputs. An unknown input is sent to the
    # finite admission checks, not silently treated as covered or as full suite.
    known_roots = ('maw/', 'web/', 'tests/', 'scripts/', 'server-editor/', 'tools/', 'website/')
    if any(not p.startswith(known_roots) and p not in {'edit.py', 'maw_gui.py', 'package.json'} for p in domains):
        fallback = True
        reasons.append('unknown input: finite admission and manual risk review')
    if set(domains) - covered:
        fallback = True
        reasons.append('no identified consumer: finite admission and manual risk review')
    if any(not (ROOT / p).is_file() for p in domains):
        fallback = True
        reasons.append('deleted or unavailable input: finite admission and manual risk review')
    for path in specs:
        try:
            source = (ROOT / path).read_text(encoding='utf-8')
        except (OSError, UnicodeError):
            continue
        if browser_ffmpeg_consumed(source):
            media = True
    media_modules = MEDIA_MODULES | {name for name, _ in MEDIA_CLASSES} | {'test_reapeaks', 'test_reapeaks_fixture', 'test_thumbnails'}
    for path in python:
        if Path(path).stem in media_modules:
            media = True
        else:
            try:
                text = (ROOT / path).read_text(encoding='utf-8')
                if any(f'def {name}(' in text for name in MEDIA_METHODS):
                    media = True
            except (OSError, UnicodeError):
                pass
    if 'tests/e2e/editor-entry-retirement.spec.mjs' in specs:
        packs.add('website')
    if python or node:
        packs.add('common')
    if specs:
        packs.add('e2e')
    if media:
        packs.add('media')
    node_browser = any(Path(path).name in NODE_BROWSER for path in node)
    for path in node:
        try:
            if re.search(r'\bchromium\.launch\s*\(', (ROOT / path).read_text(encoding='utf-8')):
                node_browser = True
        except (OSError, UnicodeError):
            pass
    server_python = browser_application_consumed(ROOT, specs)
    bundles.update(bundles_consumed(ROOT, python | node | specs))
    if server_python:
        bundles.add('editor')
    return {'mode': 'targeted', 'packs': sorted(packs), 'python_tests': sorted(python), 'node_tests': sorted(node),
            'e2e_specs': sorted(specs), 'tools_scope': 'checklist' if any(p.startswith('tools/verification-checklist/') for p in domains) else 'all',
            'fallback_checks': fallback, 'reasons': reasons or ['direct test consumer'],
            'preparation': {'application': bool(bundles), 'editor_bundle': 'editor' in bundles,
                            'launcher_bundle': 'launcher' in bundles, 'real_media': media, 'lint': lint,
                            'preview_windows': preview_for(normalized),
                            'python_dependencies': server_python or python_test_dependencies(ROOT, python) or node_python_dependencies(ROOT, node | specs),
                            'node_browser': node_browser}}
