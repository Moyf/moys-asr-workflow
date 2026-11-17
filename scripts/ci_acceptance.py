"""Finite blocking admission and strict receipts, independent of auxiliary matrix."""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
# Match run_tests.py's public CLI import context before discovering test IDs.
# Running this file directly otherwise sees scripts/, not the repository root.
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

if __package__:
    from . import ci_impact
    from .ci_matrix import validate_python_report
else:
    import ci_impact
    from ci_matrix import validate_python_report

# Explicit admission, NOT common/media ownership. Files below were inspected for
# real network, native media, browser, fixtures and skip guards. Full inspection
# still discovers every test; adding a test to an admitted file is a policy edit.
PYTHON = {
    'docs': ['tests/test_docs_check.py'],
    'release': ['tests/test_release_notes.py', 'tests/test_release_site.py', 'tests/test_release_publication.py'],
    'data': ['tests/test_project_contract.py', 'tests/test_project_io.py', 'tests/test_project_ass_export.py'],
    'runtime': [
        'tests.test_local_editor_server.LocalEditorServerTests.test_ass_frame_endpoint_requires_token_and_valid_payload',
        'tests.test_local_editor_server.LocalEditorServerTests.test_open_backup_folder_is_bound_and_requires_token',
        'tests.test_packaging_contract.PackagingContractTests.test_runtime_path_security_is_available_in_copied_runtime',
        'tests.test_packaging_contract.PackagingContractTests.test_image_editor_runtime_does_not_require_pillow_in_main_bundle',
        'tests.test_packaging_contract.PackagingContractTests.test_local_runtime_bundles_every_local_import_dependency',
    ],
    'ci': ['tests/test_ci_impact.py', 'tests/test_ci_acceptance.py', 'tests/test_test_workflow.py', 'tests/test_ci_summary.py',
           'tests/test_browser_results.py', 'tests/test_run_check.py'],
}
NODE = {
    'ci': ['tests/test_pr_preview_comment.mjs'],
    'build': ['tests/test_editor_script_syntax.mjs', 'tests/test_editor_script_order.mjs'],
    'website': ['tests/test_readme_content_sync.mjs'],
    'editor': ['tests/test_editor_recovery_save.mjs', 'tests/test_editor_export_srt.mjs', 'tests/test_word_timing.mjs'],
    'launcher': ['tests/test_launcher_local_model_paths.mjs', 'tests/test_launcher_recent_projects.mjs'],
    'tools': ['tests/test_tool_markdown.mjs'],
}
GAPS = ('Admitted contracts are not complete coverage: real HTTP/Origin/Host boundaries, '
        'atomic disk failure recovery, playback/drag/seek, native media and packaged startup '
        'still require targeted manual review and/or explicitly requested auxiliary inspection. '
        'No historical first-failure reliability claim is made for this new admission set.')


def inventory(root=Path('.'), *, discovered=None, observed=None):
    """No imports or execution: new test files require an explicit role decision."""
    if discovered is None:
        discovered = {p.as_posix() for pattern in ('test_*.py', 'test_*.mjs', '*.spec.mjs')
                      for p in (root / 'tests').rglob(pattern)}
        discovered = {str(Path(p).relative_to(root).as_posix()) if root != Path('.') else p for p in discovered}
    if observed is None:
        observed = [line for line in (root / 'scripts/ci_observation.txt').read_text(encoding='utf-8').splitlines()
                    if line and not line.startswith('#')]
    if len(observed) != len(set(observed)):
        raise ValueError('duplicate observation inventory entry')
    admitted = set()
    for targets in PYTHON.values():
        for target in targets:
            admitted.add(target if target.endswith('.py') else '/'.join(target.split('.')[:2]) + '.py')
    admitted.update(path for paths in NODE.values() for path in paths)
    missing = discovered - set(observed) - admitted
    stale = set(observed) - discovered
    if missing or stale:
        raise ValueError(f'test role decision required: unassigned={sorted(missing)}, stale={sorted(stale)}')
    return {path: ('blocking-file-or-explicit-IDs + full-inspection' if path in admitted else 'full-inspection-only')
            for path in sorted(discovered)}


def validate_plan(value):
    fields = {'version', 'namespace', 'mode', 'profile', 'light', 'reason', 'base', 'head',
              'trusted_diff', 'checks', 'preview', 'paths'}
    if not isinstance(value, dict) or set(value) != fields:
        raise ValueError('malformed blocking plan fields')
    if (type(value['version']) is not int or value['version'] != 2
            or value['namespace'] != 'blocking-v2' or value['profile'] not in ci_impact.PROFILES
            or value['mode'] != value['profile'] or type(value['light']) is not bool
            or value['light'] != (value['profile'] == 'light')
            or type(value['preview']) is not bool or type(value['trusted_diff']) is not bool
            or not isinstance(value['reason'], str) or not value['reason']
            or not isinstance(value['head'], str) or not ci_impact.SHA.fullmatch(value['head'])):
        raise ValueError('inconsistent blocking plan')
    selected = value['checks']
    if (not isinstance(selected, list) or not selected or any(not isinstance(c, str) for c in selected)
            or selected != [c for c in ci_impact.CHECKS if c in selected]):
        raise ValueError('invalid blocking check collection')
    if value['trusted_diff']:
        if not isinstance(value['base'], str) or not ci_impact.SHA.fullmatch(value['base']):
            raise ValueError('invalid trusted base')
        if (not isinstance(value['paths'], list) or not ci_impact.valid_paths(value['paths'])
                or value['paths'] != sorted(set(value['paths']))
                or selected != ci_impact.checks_for(value['paths'])
                or value['preview'] != ci_impact.preview_for(value['paths'])):
            raise ValueError('trusted paths/check selection mismatch')
    elif (value['base'] or selected != list(ci_impact.CHECKS) or value['light']
          or value['paths'] != [] or value['preview']):
        raise ValueError('untrusted plan cannot reduce admission')
    if value['light'] != (set(selected) <= {'docs', 'website', 'release', 'tools'}):
        raise ValueError('profile/check mismatch')
    return value


def fingerprint(plan):
    return hashlib.sha256(json.dumps(validate_plan(plan), sort_keys=True).encode()).hexdigest()


def gate(plan, needs, receipts, head, *, roots=None):
    validate_plan(plan)
    if head != plan['head']:
        raise ValueError('wrong workflow SHA')
    if (set(needs) != {'selection', 'checks'}
            or any(needs[job].get('result') != 'success' for job in needs)):
        raise ValueError('missing, failed, cancelled or unexpectedly skipped blocking job')
    if json.loads(needs['selection']['outputs']['plan']) != plan:
        raise ValueError('selection output differs from persisted plan')
    expected = plan['checks']
    identities = [r.get('check') for r in receipts]
    if len(identities) != len(expected) or set(identities) != set(expected):
        raise ValueError('missing, duplicate or unexpected blocking receipt')
    if roots is None or set(roots) != set(expected):
        raise ValueError('actual blocking report directories are required')
    for receipt in receipts:
        if (receipt.get('namespace') != 'blocking-v2' or receipt.get('head') != head
                or receipt.get('fingerprint') != fingerprint(plan) or receipt.get('status') != 'success'):
            raise ValueError('failed or mismatched blocking receipt')
        actual = report_evidence(plan, receipt['check'], roots[receipt['check']])
        if json.dumps(receipt.get('reports'), sort_keys=True) != json.dumps(actual, sort_keys=True):
            raise ValueError('missing, tampered or mismatched transported blocking reports')


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8', newline='\n')


def python_ids(check):
    """Audited static TestCase shape, verified against the real run's collection.

    No application imports in the transport gate. Dynamic load_tests/inherited
    collections are not admitted by this simple reader and mismatch will fail.
    """
    result = []
    for target in PYTHON.get(check, []):
        module = target[:-3].replace('/', '.') if target.endswith('.py') else '.'.join(target.split('.')[:2])
        tree = ast.parse((ROOT / (module.replace('.', '/') + '.py')).read_text(encoding='utf-8'))
        found = sorted(f'{module}.{cls.name}.{method.name}' for cls in tree.body if isinstance(cls, ast.ClassDef)
                       for method in cls.body if isinstance(method, (ast.FunctionDef, ast.AsyncFunctionDef))
                       and method.name.startswith('test_'))
        if not target.endswith('.py'):
            if target not in found:
                raise ValueError('admitted Python ID absent from source')
            found = [target]
        result.extend(found)
    if not result or len(result) != len(set(result)):
        raise ValueError('empty or ambiguous admitted Python collection')
    return result


def node_names(check):
    manifest = json.loads((ROOT / 'scripts/ci_node_tests.json').read_text(encoding='utf-8'))
    if set(manifest) != {path for paths in NODE.values() for path in paths}:
        raise ValueError('Node admission manifest/file drift')
    selected = [name for path in NODE[check] for name in manifest[path]]
    if not selected or any(not isinstance(n, str) or not n for n in selected) or len(selected) != len(set(selected)):
        raise ValueError('empty or ambiguous Node admission')
    return selected


def validate_node_report(expected, execution):
    selected = [case.get('name') for case in execution.iter('testcase')]
    if (execution.tag != 'testsuites' or not selected or len(selected) != len(set(selected))
            or len(selected) != len(expected) or set(selected) != set(expected)):
        raise ValueError('Node admission/execution collection mismatch')
    if any(list(execution.iter(tag)) for tag in ('failure', 'error')):
        raise ValueError('failed Node report')
    if list(execution.iter('skipped')):
        raise ValueError('blocking Node execution skipped tests')
    return len(selected)


def commands_for(check, plan):
    # Stable argv excludes producer workspace/report paths; gate can compare it
    # exactly after artifact relocation. Test results have separate reports.
    commands = {
        'docs': [['python', 'scripts/check_docs.py']],
        'tools': [['node', 'scripts/build-tool-docs.mjs', '--check']],
        'release': [['python', 'scripts/prepare_release_notes.py', '--check-all'],
                    ['python', 'scripts/build_release_site.py', '--preview']],
        'website': [['pnpm', '--dir', 'website', 'run', 'sync:docs'],
                    ['python', 'scripts/build_release_site.py', '--preview'],
                    ['pnpm', '--dir', 'website', 'run', 'build']],
        'build': [['pnpm', 'run', 'build'], ['pnpm', 'run', 'check:editor'],
                  ['pnpm', 'run', 'check:launcher'], ['pnpm', 'run', 'typecheck']],
    }
    result = commands.get(check, []).copy()
    if check == 'tools':
        result += [['python', 'tools/verification-checklist/build.py', '--check', path]
                   for path in plan['paths'] if path.endswith('.checklist.md') and (ROOT / path).is_file()]
    return result


def report_evidence(plan, check, root):
    """Re-read required transported bytes; never trust receipt-only validation."""
    root = Path(root)
    names = ['commands.json']
    if check in PYTHON:
        names.append('python.json')
    if check in NODE:
        names.append('node.xml')
    if check == 'ci':
        names.append('inventory.json')
    result = {}
    for name in names:
        path = root / name
        if path.is_symlink() or path.resolve().parent != root.resolve():
            raise ValueError('unsafe blocking report path')
        raw = path.read_bytes()
        summary = {'sha256': hashlib.sha256(raw).hexdigest()}
        if name == 'python.json':
            value = json.loads(raw)
            validated = validate_python_report(value, required=True)
            expected = python_ids(check)
            if (set(value['selected_ids']) != set(expected) or value['skips'] or value['expected_failures']
                    or validated['run'] != len(expected)):
                raise ValueError('blocking Python source/report collection mismatch')
            summary.update(selected=len(expected), run=validated['run'])
        elif name == 'node.xml':
            count = validate_node_report(node_names(check), ET.fromstring(raw))
            summary.update(selected=count, run=count)
        elif name == 'commands.json':
            commands = commands_for(check, plan)
            expected = {'check': check, 'head': plan['head'], 'fingerprint': fingerprint(plan),
                        'commands': [{'argv': command, 'exit_code': 0} for command in commands]}
            if json.dumps(json.loads(raw), sort_keys=True) != json.dumps(expected, sort_keys=True):
                raise ValueError('consumer/build command collection or outcome mismatch')
            summary.update(selected=len(commands), run=len(commands))
        else:
            value = inventory()
            if json.loads(raw) != value:
                raise ValueError('transported inventory differs from audited source')
            summary.update(selected=len(value), run=len(value))
        result[name] = summary
    return result


def run_check(plan, check, root):
    validate_plan(plan)
    if check not in plan['checks'] or root.exists():
        raise ValueError('unselected check or stale evidence directory')
    root.mkdir(parents=True)

    def run(command):
        subprocess.run([sys.executable, 'scripts/run_check.py', '--timeout', '180', '--', *command], check=True)

    if check in PYTHON:
        targets = PYTHON[check]
        report = root / 'python.json'
        run([sys.executable, 'scripts/run_tests.py', *targets, '--required', '--report', str(report)])
    if check in NODE:
        report = root / 'node.xml'
        # Exactly one execution. Explicit audited names replace the ineffective
        # --test-name-pattern listing (which ran bodies on Node 22.23.2).
        run(['node', '--test', '--test-reporter=junit', f'--test-reporter-destination={report}', *NODE[check]])
    if check == 'ci':
        write(root / 'inventory.json', inventory())
    commands = commands_for(check, plan)
    for command in commands:
        # Windows native pnpm is a cmd shim; CI blocking jobs run on Ubuntu.
        run([sys.executable, *command[1:]] if command[0] == 'python' else command)
    write(root / 'commands.json', {'check': check, 'head': plan['head'], 'fingerprint': fingerprint(plan),
                                  'commands': [{'argv': command, 'exit_code': 0} for command in commands]})
    reports = report_evidence(plan, check, root)
    write(root / 'receipt.json', {'namespace': 'blocking-v2', 'check': check, 'head': plan['head'],
                                'fingerprint': fingerprint(plan), 'status': 'success', 'reports': reports})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('run', 'gate', 'validate'))
    parser.add_argument('--plan', type=Path, default=Path('.artifacts/blocking/plan.json'))
    parser.add_argument('--root', type=Path, default=Path('.artifacts/blocking/evidence'))
    parser.add_argument('--check')
    args = parser.parse_args()
    plan = validate_plan(json.loads(args.plan.read_text(encoding='utf-8')))
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD']).decode('ascii').strip()
    if head != plan['head'] or (os.environ.get('GITHUB_SHA') and os.environ['GITHUB_SHA'] != head):
        raise ValueError('plan differs from workflow/checkout HEAD')
    if args.action == 'run':
        run_check(plan, args.check, args.root / args.check)
    elif args.action == 'gate':
        paths = list(args.root.rglob('receipt.json'))
        receipts = [json.loads(p.read_text(encoding='utf-8')) for p in paths]
        roots = {receipt.get('check'): path.parent for receipt, path in zip(receipts, paths)}
        gate(plan, json.loads(os.environ['CI_NEEDS']), receipts, head, roots=roots)
        message = ('Blocking checks passed: ' + ', '.join(plan['checks']) + '\n\n'
                   'Intentionally not selected: ' + ', '.join(c for c in ci_impact.CHECKS if c not in plan['checks'])
                   + '\n\nAuxiliary inspection/preview are independent; not claimed passed.\n\n'
                   + plan['reason'] + '\n\n' + GAPS)
        print(message)
        if os.environ.get('GITHUB_STEP_SUMMARY'):
            with Path(os.environ['GITHUB_STEP_SUMMARY']).open('a', encoding='utf-8') as stream:
                stream.write(message + '\n')
    else:
        write(args.plan.parent / 'inventory.json', inventory())


if __name__ == '__main__':
    main()
