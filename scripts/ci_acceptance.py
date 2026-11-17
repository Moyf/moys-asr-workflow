"""2.0dev finite admission manifest and fail-closed receipts (no full scheduler)."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
if __package__:
    from . import ci_impact
    from .ci_run_layer import unavailable_preparation
    from .run_tests import build_suite, cases
    from .run_check import run as execute_check
    from .test_result_details import collect_failures
else:
    import ci_impact
    from ci_run_layer import unavailable_preparation
    from run_tests import build_suite, cases
    from run_check import run as execute_check
    from test_result_details import collect_failures

# Admission is explicit: neither the full Node collection nor Python common is
# labelled stable. These files use mocks/VM/temporary files, not real media or browsers.
PYTHON = {
    'docs': ['tests/test_docs_check.py'],
    'release': ['tests/test_release_notes.py', 'tests/test_release_site.py', 'tests/test_release_publication.py'],
    'data': ['tests/test_project_contract.py', 'tests/test_project_io.py',
             'tests.test_v2_migration_save.MigrationSaveTests.test_failed_exclusive_publish_never_overwrites_source_or_existing_target',
             'tests.test_v2_migration_save.MigrationSaveTests.test_remember_media_preserves_legacy_format'],
    'runtime': [
        'tests.test_packaging_contract.PackagingContractTests.test_runtime_path_security_is_available_in_copied_runtime',
        'tests.test_packaging_contract.PackagingContractTests.test_image_editor_runtime_does_not_require_pillow_in_main_bundle',
        'tests.test_packaging_contract.PackagingContractTests.test_local_runtime_bundles_every_local_import_dependency',
        'tests.test_project_boundary.ProjectBoundaryTests.test_server_import_and_save_future_schema_preserve_disk',
    ],
    'ci': ['tests/test_ci_impact.py', 'tests/test_ci_acceptance.py', 'tests/test_run_check.py'],
}
NODE = {
    'build': ['tests/test_editor_script_syntax.mjs', 'tests/test_editor_script_order.mjs'],
    'website': ['tests/test_readme_content_sync.mjs'],
    'editor': ['tests/test_editor_recovery_save.mjs', 'tests/test_project_save_state.mjs',
               'tests/test_v2_migration_save.mjs', 'tests/test_editor_state.mjs', 'tests/test_editor_commands.mjs'],
    'launcher': ['tests/test_launcher_local_model_paths.mjs', 'tests/test_launcher_recent_projects.mjs'],
    'tools': ['tests/test_tool_markdown.mjs'],
    'ci': ['tests/test_pr_preview_comment.mjs', 'tests/test_browser_evidence_workflow.mjs'],
}
GAPS = ('Finite contracts are not complete coverage or a historical reliability claim. '
        'Real Host/Origin/HTTP routing, disk failure recovery, playback/drag/seek, native media '
        'and packaged startup still need targeted review or manual auxiliary inspection. '
        'Auxiliary failures remain visible and must be triaged; they are not acceptance dependencies.')


def validate_plan(value):
    fields = {'version', 'namespace', 'checks', 'head', 'base', 'paths', 'trusted_diff', 'light', 'preview', 'reason', 'manual_preview'}
    if not isinstance(value, dict) or set(value) != fields:
        raise ValueError('malformed plan')
    if (type(value['version']) is not int or value['version'] != 2 or value['namespace'] != 'blocking-2dev'
            or not isinstance(value['head'], str) or not ci_impact.SHA.fullmatch(value['head'])
            or any(type(value[k]) is not bool for k in ('light', 'preview', 'trusted_diff', 'manual_preview'))
            or not isinstance(value['reason'], str) or not value['reason']):
        raise ValueError('invalid plan identity')
    checks = value['checks']
    if (not isinstance(checks, list) or any(not isinstance(c, str) for c in checks)
            or checks != [c for c in ci_impact.CHECKS if c in checks]):
        raise ValueError('unknown, duplicate or unordered checks')
    if value['trusted_diff']:
        if (not isinstance(value['base'], str) or not ci_impact.SHA.fullmatch(value['base'])
                or not ci_impact.valid_paths(value['paths']) or value['paths'] != sorted(set(value['paths']))
                or checks != ci_impact.checks_for(value['paths'], base_ref=value['base'])
                or value['preview'] != ci_impact.preview_for(value['paths']) or value['manual_preview']):
            raise ValueError('trusted diff does not match consumers')
    elif (value['base'] or value['paths'] != [] or checks != list(ci_impact.CHECKS)
          or value['preview'] != value['manual_preview']):
        raise ValueError('untrusted diff cannot reduce admission')
    if value['light'] != (set(checks) <= {'docs', 'website', 'release', 'tools'}):
        raise ValueError('light/check mismatch')
    return value


def fingerprint(value):
    return hashlib.sha256(json.dumps(validate_plan(value), sort_keys=True).encode()).hexdigest()


def gate(plan, needs, receipts, head, root):
    validate_plan(plan)
    if head != plan['head']:
        raise ValueError('wrong workflow SHA')
    # Only selection and finite checks are required. Never pass an advisory job here.
    checks_result = 'success' if plan['checks'] else 'skipped'
    if (set(needs) != {'selection', 'checks'} or needs['selection'].get('result') != 'success'
            or needs['checks'].get('result') != checks_result):
        raise ValueError('missing, failed, cancelled or skipped selected job')
    if json.loads(needs['selection']['outputs']['plan']) != plan:
        raise ValueError('selection differs from persisted plan')
    identities = [r.get('check') for r in receipts]
    if len(identities) != len(plan['checks']) or set(identities) != set(plan['checks']):
        raise ValueError('missing, duplicate or unexpected receipt')
    for receipt in receipts:
        if (receipt.get('namespace') != 'blocking-2dev' or receipt.get('head') != head
                or receipt.get('fingerprint') != fingerprint(plan) or receipt.get('status') != 'success'):
            raise ValueError('failed or mismatched receipt')
        validate_evidence(plan, receipt, root / receipt['check'])


def validate_python_report(report, expected):
    if (not expected or len(expected) != len(set(expected)) or report.get('selected_ids') != expected
            or type(report.get('run')) is not int or report['run'] != len(expected)
            or report.get('skips') != []
            or any(type(report.get(k)) is not int or report[k] != 0 for k in
                   ('exit_code', 'failures', 'errors', 'expected_failures', 'unexpected_successes'))):
        raise ValueError('incomplete, skipped or failed Python report')


def validate_node_report(expected, execution):
    found = [case.get('name') for case in execution.iter('testcase')]
    if (execution.tag != 'testsuites' or not expected or len(expected) != len(set(expected))
            or len(found) != len(expected) or set(found) != set(expected)):
        raise ValueError('Node static admission/execution mismatch')
    if any(list(execution.iter(tag)) for tag in ('failure', 'error')):
        raise ValueError('Node failure')
    if list(execution.iter('skipped')):
        raise ValueError('Node skip')


def node_admission():
    value = json.loads((ROOT / 'scripts/ci-node-admission.json').read_text(encoding='utf-8'))
    if set(value) != set(NODE):
        raise ValueError('Node admission groups drifted')
    for check, files in NODE.items():
        entry = value[check]
        if (set(entry) != {'files', 'names'} or entry['files'] != files
                or not isinstance(entry['names'], list) or not entry['names']
                or any(not isinstance(n, str) or not n for n in entry['names'])
                or len(entry['names']) != len(set(entry['names']))):
            raise ValueError('Node files/names require an explicit admission decision')
    return value


def manifest_fingerprint(check):
    return hashlib.sha256(json.dumps({'python': PYTHON.get(check), 'node': node_admission().get(check)},
                                     sort_keys=True).encode()).hexdigest()


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def seal_evidence(root):
    return {p.relative_to(root).as_posix(): digest(p) for p in sorted(root.rglob('*'))
            if p.is_file() and p.name != 'receipt.json'}


def validate_evidence(plan, receipt, root):
    check = receipt['check']
    bound = receipt.get('evidence')
    if (receipt.get('manifest') != manifest_fingerprint(check) or not isinstance(bound, dict)
            or not ci_impact.valid_paths(list(bound)) or root.is_symlink() or any(p.is_symlink() for p in root.rglob('*'))
            or seal_evidence(root) != bound):
        raise ValueError('missing, changed or unbound transported evidence')
    required = {'command-results.json'}
    if check in PYTHON:
        required.update({'python.json', 'admitted-python-ids.json'})
    if check in NODE:
        required.update({'node.xml', 'admitted-node-files.json', 'admitted-node-names.json'})
    if not required <= set(bound):
        raise ValueError('missing required report/collection')
    def read(name):
        return json.loads((root / name).read_text(encoding='utf-8'))
    if check in PYTHON:
        expected = [c.id() for c in cases(build_suite(PYTHON[check], 'tests', 'test_*.py'))]
        if read('admitted-python-ids.json') != expected:
            raise ValueError('transported Python collection differs from checkout')
        validate_python_report(read('python.json'), expected)
    if check in NODE:
        entry = node_admission()[check]
        if read('admitted-node-files.json') != entry['files'] or read('admitted-node-names.json') != entry['names']:
            raise ValueError('transported Node collection differs from admission')
        validate_node_report(entry['names'], ET.parse(root / 'node.xml').getroot())
    records = read('command-results.json')
    checklist_count = sum(p.endswith('.checklist.md') and Path(p).is_file() for p in plan['paths']) if check == 'tools' else 0
    expected_count = len(commands_for(check)) + int(check in PYTHON) + int(check in NODE) + checklist_count
    if not isinstance(records, list) or len(records) != expected_count:
        raise ValueError('incomplete command result collection')
    result_paths = [record.get('result') for record in records]
    if not ci_impact.valid_paths(result_paths) or len(set(result_paths)) != len(result_paths):
        raise ValueError('invalid command result paths')
    for record in records:
        if record['result'] not in bound:
            raise ValueError('unbound command result')
        result = read(record['result'])
        if (result.get('status') != 'completed' or type(result.get('exit_code')) is not int
                or result['exit_code'] != 0 or result.get('cleanup_error') is not None
                or not record.get('command') or result.get('command') != record['command']):
            raise ValueError('failed, cancelled or mismatched transported command result')


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8', newline='\n')


def summarize_failures(plan, root, *, gate_error=None):
    summary = {'head': plan['head'], 'checks': plan['checks'], 'failures': [], 'report_errors': []}
    if gate_error is not None:
        summary['gate_error'] = gate_error
    for check in plan['checks']:
        report = root / check / 'failures.json'
        if not report.exists():
            if not (report.parent / 'receipt.json').is_file():
                summary['report_errors'].append({'check': check, 'error': 'No failure report or receipt was available'})
            continue
        try:
            value = json.loads(report.read_text(encoding='utf-8'))
            for field in ('failures', 'report_errors'):
                if not isinstance(value[field], list) or any(not isinstance(entry, dict) for entry in value[field]):
                    raise ValueError(f'invalid {field} list')
        except (OSError, ValueError, TypeError, KeyError) as error:
            summary['report_errors'].append({'check': check, 'error': f'Cannot read the failure report: {error}'})
            continue
        for field in ('failures', 'report_errors'):
            summary[field].extend({**entry, 'check': check} for entry in value[field])
    path = root.parent / 'failures.json'
    write(path, summary)
    print(f'Admitted diagnostics: {len(summary["failures"])} failure/block records, '
          f'{len(summary["report_errors"])} report issues; {path}')


def commands_for(check):
    return {
        'docs': [('docs-navigation', [sys.executable, 'scripts/check_docs.py'], ())],
        'tools': [('tools-docs', ['node', 'scripts/build-tool-docs.mjs', '--check'], ('node-runtime',))],
        'release': [
            ('release-docs', [sys.executable, 'scripts/prepare_release_notes.py', '--check-all'], ()),
            ('release-site', [sys.executable, 'scripts/build_release_site.py', '--preview'], ()),
        ],
        'website': [
            ('website-docs', ['node', 'website/scripts/sync-maw-docs.mjs'], ('node-runtime',)),
            ('website-docs-freshness', ['git', 'diff', '--exit-code', '--', 'website/src/pages/docs/',
                                        'website/public/docs-assets/'], ('website-docs',)),
            ('website-releases', [sys.executable, 'scripts/build_release_site.py', '--preview'], ()),
            ('website-check', ['pnpm', '--dir', 'website', 'run', 'check'],
             ('website-dependencies', 'website-docs', 'website-releases')),
            ('website-build', ['pnpm', '--dir', 'website', 'run', 'build'],
             ('website-dependencies', 'website-docs', 'website-releases')),
        ],
        'build': [
            ('build-editor', ['pnpm', 'run', 'build:editor'], ('node-dependencies',)),
            ('build-launcher', ['pnpm', 'run', 'build:launcher'], ('node-dependencies',)),
            ('check-editor', ['pnpm', 'run', 'check:editor'], ('build-editor',)),
            ('check-launcher', ['pnpm', 'run', 'check:launcher'], ('build-launcher',)),
            ('typecheck', ['pnpm', 'run', 'typecheck'], ('node-dependencies',)),
        ],
    }.get(check, [])


def node_command(files, report):
    return ['node', '--test', '--test-reporter=spec', '--test-reporter-destination=stdout',
            '--test-reporter=junit', f'--test-reporter-destination={report}', *files]


def run_check(plan, check, root, *, unavailable=()):
    validate_plan(plan)
    if check not in plan['checks'] or root.exists():
        raise ValueError('unselected check or stale evidence')
    root.mkdir(parents=True)
    records = []
    failed = set(unavailable)
    failures = [{'gate': name, 'kind': 'preparation', 'error': 'CI preparation unavailable'}
                for name in sorted(failed)]
    report_errors = []
    interrupted = None

    def run(name, command, needs=(), *, validate=None, python_report=None, node_report=None):
        nonlocal interrupted
        blocked = [interrupted] if interrupted else [dependency for dependency in needs if dependency in failed]
        if blocked:
            failed.add(name)
            failures.append({'gate': name, 'kind': 'blocked', 'requires': blocked})
            print(f'{check}/{name}: blocked by {", ".join(blocked)}')
            return
        code, result = execute_check(command, 180, root / 'checks')
        records.append({'command': command,
                        'result': (Path(result['log']).parent / 'result.json').resolve().relative_to(root.resolve()).as_posix()})
        print(f'{check}/{name}: {result["status"]}, exit={code}, seconds={result["duration_seconds"]}')
        error = None
        if code == 0 and result['status'] == 'completed' and result['cleanup_error'] is None:
            if validate is None:
                return
            try:
                validate()
                return
            except (OSError, ValueError, TypeError, AttributeError, ET.ParseError) as exc:
                error = str(exc)
        if result['status'] == 'interrupted':
            interrupted = name
        failed.add(name)
        for line in dict.fromkeys(result['diagnostics'] + result['tail']):
            print(line)
        if error:
            print(f'{check}/{name}: {error[:300]}')
        print(f'Log: {result["log"]}')
        detail = collect_failures({**result, 'gate': name, 'process_exit_code': code, 'exit_code': code or 1,
                                   'error': error}, python_report=python_report, node_report=node_report)
        failures.extend(detail['failures'])
        report_errors.extend({'gate': name, 'error': issue} for issue in detail['report_errors'])

    for name, command, needs in commands_for(check):
        run(name, command, needs)
    if check in PYTHON:
        targets = PYTHON[check]
        report = root / 'python.json'

        def validate_python():
            expected = [c.id() for c in cases(build_suite(targets, 'tests', 'test_*.py'))]
            write(root / 'admitted-python-ids.json', expected)
            validate_python_report(json.loads(report.read_text(encoding='utf-8')), expected)

        # Discovery records missing imports as failed cases while unrelated cases can still run.
        run('python', [sys.executable, 'scripts/run_tests.py', *targets, '--required', '--report', str(report)],
            validate=validate_python, python_report=report)
    if check in NODE:
        report = root / 'node.xml'
        write(root / 'admitted-node-files.json', NODE[check])

        def validate_node():
            expected = node_admission()[check]['names']
            write(root / 'admitted-node-names.json', expected)
            validate_node_report(expected, ET.parse(report).getroot())

        needs = ('node-runtime', 'node-dependencies') if check in {'build', 'editor'} else ('node-runtime',)
        run('node', node_command(NODE[check], report), needs, validate=validate_node, node_report=report)
    if check == 'tools':
        for path in plan['paths']:
            if path.endswith('.checklist.md') and Path(path).is_file():
                run(path, [sys.executable, 'tools/verification-checklist/build.py', '--check', path])
    write(root / 'command-results.json', records)
    if failed:
        write(root / 'failures.json', {'failures': failures, 'report_errors': report_errors})
        raise ValueError(f'{check}: {len(failed)} failed or blocked checks/preparations; inspect {root / "failures.json"}')
    write(root / 'receipt.json', dict(namespace='blocking-2dev', check=check, head=plan['head'],
                                      fingerprint=fingerprint(plan), status='success',
                                      manifest=manifest_fingerprint(check), evidence=seal_evidence(root)))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('run', 'gate', 'validate', 'summarize'))
    parser.add_argument('--plan', type=Path, default=Path('.artifacts/blocking/plan.json'))
    parser.add_argument('--root', type=Path, default=Path('.artifacts/blocking/evidence'))
    parser.add_argument('--check')
    args = parser.parse_args()
    plan = validate_plan(json.loads(args.plan.read_text(encoding='utf-8')))
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD']).decode('ascii').strip()
    if head != plan['head'] or (os.environ.get('GITHUB_SHA') and os.environ['GITHUB_SHA'] != head):
        raise ValueError('plan differs from checkout/workflow SHA')
    if args.action == 'run':
        requirements = {'node-runtime': 'node'} if args.check in NODE else {}
        if args.check in {'editor', 'build'}:
            requirements['node-dependencies'] = 'js_install'
        if args.check in {'ci', 'data', 'runtime'}:
            requirements['python-dependencies'] = 'py_install'
        if args.check == 'website':
            requirements['website-dependencies'] = 'website_install'
        preparation = os.environ.get('CI_PREPARATION')
        unavailable = unavailable_preparation(json.loads(preparation), requirements) if preparation else ()
        run_check(plan, args.check, args.root / args.check, unavailable=unavailable)
    elif args.action == 'summarize':
        summarize_failures(plan, args.root)
    elif args.action == 'gate':
        try:
            receipts = [json.loads(p.read_text(encoding='utf-8')) for p in args.root.rglob('receipt.json')]
            gate(plan, json.loads(os.environ['CI_NEEDS']), receipts, head, args.root)
        except (OSError, ValueError, TypeError, KeyError) as error:
            summarize_failures(plan, args.root, gate_error=str(error))
            raise
        selected = ('Selected admitted checks passed: ' + ', '.join(plan['checks']) if plan['checks']
                    else 'No admitted checks selected; inspect the separate targeted auxiliary results.')
        message = selected + '\n\n' + plan['reason'] + '\n\n' + GAPS
        print(message)
        if os.environ.get('GITHUB_STEP_SUMMARY'):
            with Path(os.environ['GITHUB_STEP_SUMMARY']).open('a', encoding='utf-8') as stream:
                stream.write(message + '\n')


if __name__ == '__main__':
    main()
