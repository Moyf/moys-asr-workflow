"""Approved rollback: unknown changes select admitted checks, not the full matrix."""
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import shutil
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from contextlib import redirect_stdout
from unittest import mock

from scripts import ci_impact
from tests.compact_assertions import CompactContainerAssertions


def success_evidence(plan, check, root):
    """Synthetic unit fixture only; public transport test below uses real output."""
    from scripts import ci_acceptance as acceptance
    commands = acceptance.commands_for(check, plan)
    acceptance.write(root / 'commands.json', {'check': check, 'head': plan['head'],
        'fingerprint': acceptance.fingerprint(plan), 'commands': [{'argv': c, 'exit_code': 0} for c in commands]})
    if check in acceptance.PYTHON:
        ids = acceptance.python_ids(check)
        acceptance.write(root / 'python.json', {'selected_ids': ids, 'run': len(ids), 'failures': 0,
            'errors': 0, 'expected_failures': 0, 'unexpected_successes': 0, 'exit_code': 0, 'skips': []})
    if check in acceptance.NODE:
        xml = ET.Element('testsuites')
        for name in acceptance.node_names(check):
            ET.SubElement(xml, 'testcase', name=name)
        (root / 'node.xml').write_bytes(ET.tostring(xml))
    if check == 'ci':
        acceptance.write(root / 'inventory.json', acceptance.inventory())
    return {'namespace': 'blocking-v2', 'check': check, 'head': plan['head'],
            'fingerprint': acceptance.fingerprint(plan), 'status': 'success',
            'reports': acceptance.report_evidence(plan, check, root)}


class AcceptanceTests(CompactContainerAssertions, unittest.TestCase):
    def test_node_import_failure_keeps_readable_console_error_and_junit_once(self):
        from scripts import ci_acceptance as acceptance
        plan = ci_impact.plan('stable', 'import failure diagnostics', head='b' * 40)
        original = subprocess.run
        captured = []
        def command(argv, **kwargs):
            try:
                return original(argv, **kwargs, capture_output=True, text=True, encoding='utf-8')
            except subprocess.CalledProcessError as error:
                captured.append((error.stdout or '') + (error.stderr or ''))
                raise
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = root / 'import-failure.mjs'
            fixture.write_text("import 'maw-ci-selfcheck-missing-import';\n", encoding='utf-8', newline='\n')
            with mock.patch.dict(acceptance.NODE, {'launcher': [str(fixture)]}), mock.patch.object(
                    acceptance.subprocess, 'run', side_effect=command) as run:
                with self.assertRaises(subprocess.CalledProcessError):
                    acceptance.run_check(plan, 'launcher', root / 'output')
                self.assertEqual(run.call_count, 1)
            self.assertIn('maw-ci-selfcheck-missing-import', ''.join(captured))
            self.assertTrue((root / 'output/node.xml').exists())
            self.assertFalse((root / 'output/receipt.json').exists())

    def test_real_public_transport_rechecks_missing_tampered_and_forged_reports(self):
        from scripts import ci_acceptance as acceptance
        head = subprocess.check_output(['git', 'rev-parse', 'HEAD']).decode().strip()
        plan = ci_impact.plan('light', 'real transported documentation output', base='a' * 40, head=head, trusted=True)
        needs = {'selection': {'result': 'success', 'outputs': {'plan': json.dumps(plan)}},
                 'checks': {'result': 'success'}}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            acceptance.write(root / 'plan.json', plan)
            script = str(Path(acceptance.__file__).resolve())
            env = {**os.environ, 'GITHUB_SHA': head, 'CI_NEEDS': json.dumps(needs)}
            produced = subprocess.run([sys.executable, script, 'run', '--check', 'docs', '--plan',
                str(root / 'plan.json'), '--root', str(root / 'producer')], env=env, capture_output=True, timeout=60)
            self.assertEqual(produced.returncode, 0, produced.stderr.decode(errors='replace')[-1200:])
            for scenario in ('positive', 'missing', 'tampered', 'fake-digest', 'collection-digest',
                             'commands-missing', 'commands-bad-digest'):
                transported = root / scenario
                shutil.copytree(root / 'producer', transported)
                folder = transported / 'docs'
                receipt = json.loads((folder / 'receipt.json').read_text(encoding='utf-8'))
                report = folder / 'python.json'
                if scenario == 'missing':
                    report.unlink()
                elif scenario == 'tampered':
                    report.write_bytes(report.read_bytes() + b'\n')
                elif scenario in ('fake-digest', 'collection-digest'):
                    value = json.loads(report.read_text(encoding='utf-8'))
                    value = {} if scenario == 'fake-digest' else {**value,
                        'selected_ids': value['selected_ids'][:1], 'run': 1}
                    acceptance.write(report, value)
                    receipt['reports']['python.json'].update(sha256=hashlib.sha256(report.read_bytes()).hexdigest(),
                                                            selected=1, run=1)
                elif scenario == 'commands-missing':
                    (folder / 'commands.json').unlink()
                elif scenario == 'commands-bad-digest':
                    report = folder / 'commands.json'
                    value = json.loads(report.read_text(encoding='utf-8'))
                    value['commands'][0]['exit_code'] = 1
                    acceptance.write(report, value)
                    receipt['reports']['commands.json']['sha256'] = hashlib.sha256(report.read_bytes()).hexdigest()
                acceptance.write(folder / 'receipt.json', receipt)
                result = subprocess.run([sys.executable, script, 'gate', '--plan', str(root / 'plan.json'),
                    '--root', str(transported)], env=env, capture_output=True, timeout=15)
                with self.subTest(scenario=scenario):
                    self.assertEqual(result.returncode == 0, scenario == 'positive',
                                     result.stderr.decode(errors='replace')[-1000:])

    def test_node_admission_runs_once_without_a_collect_execution(self):
        from scripts import ci_acceptance as acceptance
        plan = ci_impact.plan('stable', 'single execution', head='b' * 40)
        def command(argv, **kwargs):
            report = next(a.split('=', 1)[1] for a in argv
                          if a.startswith('--test-reporter-destination=') and a != '--test-reporter-destination=stdout')
            xml = ET.Element('testsuites')
            for name in acceptance.node_names('launcher'):
                ET.SubElement(xml, 'testcase', name=name)
            Path(report).write_bytes(ET.tostring(xml))
            return subprocess.CompletedProcess(argv, 0)
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(
                acceptance.subprocess, 'run', side_effect=command) as run:
            acceptance.run_check(plan, 'launcher', Path(temporary) / 'fresh')
            self.assertEqual(run.call_count, 1)
            self.assertNotIn('--test-name-pattern=^$', run.call_args.args[0])
            self.assertIn('--test-reporter=spec', run.call_args.args[0])
            self.assertIn('--test-reporter=junit', run.call_args.args[0])
            self.assertIn('--test-reporter-destination=stdout', run.call_args.args[0])

    def test_public_main_light_gate_ignores_auxiliary_failure_but_not_missing_blocking(self):
        from scripts import ci_acceptance
        head = subprocess.check_output(['git', 'rev-parse', 'HEAD']).decode().strip()
        plan = ci_impact.plan('light', 'documentation push', base='a' * 40, head=head, trusted=True)
        needs = {'selection': {'result': 'success', 'outputs': {'plan': json.dumps(plan)}},
                 'checks': {'result': 'success'}}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            receipt = success_evidence(plan, 'docs', root / 'blocking/docs')
            ci_acceptance.write(root / 'plan.json', plan)
            ci_acceptance.write(root / 'blocking/docs/receipt.json', receipt)
            ci_acceptance.write(root / 'auxiliary/receipt.json', {'status': 'failure', 'namespace': 'auxiliary-v1'})
            command = [sys.executable, str(Path(ci_acceptance.__file__).resolve()), 'gate',
                       '--plan', str(root / 'plan.json'), '--root', str(root / 'blocking')]
            env = {**os.environ, 'GITHUB_EVENT_NAME': 'push', 'GITHUB_SHA': head, 'CI_NEEDS': json.dumps(needs)}
            result = subprocess.run(command, env=env, capture_output=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr.decode(errors='replace')[-1000:])
            self.assertIn(b'Intentionally not selected:', result.stdout)
            self.assertIn(b'not claimed passed', result.stdout)
            for broken in ({**receipt, 'head': 'c' * 40}, {**receipt, 'namespace': 'auxiliary-v1'}, {}):
                ci_acceptance.write(root / 'blocking/docs/receipt.json', broken)
                self.assertNotEqual(subprocess.run(command, env=env, capture_output=True, timeout=15).returncode, 0)
            ci_acceptance.write(root / 'blocking/docs/receipt.json', receipt)
            needs['checks']['result'] = 'cancelled'
            env['CI_NEEDS'] = json.dumps(needs)
            self.assertNotEqual(subprocess.run(command, env=env, capture_output=True, timeout=15).returncode, 0)

    def test_public_python_runner_matches_discovery_and_writes_positive_receipt(self):
        from scripts import ci_acceptance
        head = subprocess.check_output(['git', 'rev-parse', 'HEAD']).decode().strip()
        plan = ci_impact.plan('stable', 'real pure-data positive control', head=head)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            ci_acceptance.write(root / 'plan.json', plan)
            result = subprocess.run([sys.executable, str(Path(ci_acceptance.__file__).resolve()), 'run',
                                     '--plan', str(root / 'plan.json'), '--root', str(root / 'output'),
                                     '--check', 'data'], env={**os.environ, 'GITHUB_SHA': head},
                                    capture_output=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr.decode(errors='replace')[-1500:])
            self.assertTrue((root / 'output/data/receipt.json').exists())

    def test_node_reports_reject_omission_fake_empty_success_and_actual_skips(self):
        from scripts.ci_acceptance import validate_node_report
        good = ET.fromstring('<testsuites><testcase name="one"/></testsuites>')
        validate_node_report(['one'], good)
        for xml in ('<testsuites/>', '<testsuites><testcase name="other"/></testsuites>',
                    '<testsuites><testcase name="one"><skipped/></testcase></testsuites>',
                    '<testsuites><testcase name="one"><failure/></testcase></testsuites>',
                    '<testsuites><testcase name="one"/><testcase name="one"/></testsuites>'):
            with self.subTest(xml=xml), self.assertRaises(ValueError):
                validate_node_report(['one'], ET.fromstring(xml))

    def test_real_cli_exit_zero_without_reports_cannot_issue_blocking_receipt(self):
        from scripts import ci_acceptance
        head = subprocess.check_output(['git', 'rev-parse', 'HEAD']).decode().strip()
        plan = ci_impact.plan('stable', 'controlled fake command', head=head)
        wrapper = '''import subprocess, sys
from unittest import mock
sys.path.insert(0, sys.argv.pop(1))
from scripts import ci_acceptance
original = subprocess.run
def command(args, **kwargs):
    if args[0] == 'git':
        return original(args, **kwargs)
    return subprocess.CompletedProcess(args, 0)
with mock.patch.object(ci_acceptance.subprocess, 'run', side_effect=command):
    ci_acceptance.main()
'''
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'fake.py').write_text(wrapper, encoding='utf-8', newline='\n')
            ci_acceptance.write(root / 'plan.json', plan)
            for check in ('data', 'launcher'):
                result = subprocess.run([sys.executable, str(root / 'fake.py'), str(Path('.').resolve()),
                                         'run', '--plan', str(root / 'plan.json'), '--root', str(root / check),
                                         '--check', check], env={**os.environ, 'GITHUB_SHA': head},
                                        capture_output=True, timeout=20)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((root / check / check / 'receipt.json').exists())

    def test_failed_and_cancelled_commands_never_issue_receipts(self):
        from scripts import ci_acceptance
        plan = ci_impact.plan('stable', 'test', head='b' * 40)
        for code in (1, 124, 130):
            with tempfile.TemporaryDirectory() as temporary:
                output = Path(temporary) / 'fresh'
                with mock.patch.object(ci_acceptance.subprocess, 'run', side_effect=
                                       subprocess.CalledProcessError(code, 'controlled command')):
                    with self.assertRaises(subprocess.CalledProcessError):
                        ci_acceptance.run_check(plan, 'launcher', output)
                self.assertFalse((output / 'receipt.json').exists())

    def test_test_inventory_keeps_unreviewed_and_stale_visible_without_blocking(self):
        from scripts.ci_acceptance import inventory
        baseline = inventory()
        self.assertIn('tests/e2e/editor-bundle.spec.mjs', baseline)
        self.assertEqual(baseline['tests/e2e/editor-bundle.spec.mjs'], 'full-inspection-only')
        with redirect_stdout(io.StringIO()) as output:
            result = inventory(discovered=set(baseline) | {'tests/e2e/zz-unregistered-fixture.spec.mjs'})
            stale = inventory(discovered=set(baseline) - {'tests/e2e/editor-bundle.spec.mjs'})
        self.assertEqual(result['tests/e2e/zz-unregistered-fixture.spec.mjs'], 'unreviewed observation/full inspection')
        self.assertEqual(stale['tests/e2e/editor-bundle.spec.mjs'], 'stale observation metadata (not discovered)')
        self.assertIn('unreviewed observation/full inspection', output.getvalue())
        self.assertIn('stale observation metadata', output.getvalue())

    def test_inventory_diagnostics_are_json_escaped_and_bounded(self):
        from scripts.ci_acceptance import inventory
        baseline = inventory()
        paths = {f'tests/e2e/::error::\n{index}-' + 'x' * 300 + '.spec.mjs' for index in range(20)}
        with redirect_stdout(io.StringIO()) as output:
            result = inventory(discovered=set(baseline) | paths, observed=list(baseline))
        lines = output.getvalue().splitlines()
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0].startswith('Inventory advisory: '))
        note = json.loads(lines[0].removeprefix('Inventory advisory: '))
        self.assertEqual(note['count'], 20)
        self.assertEqual(len(note['paths']), 5)
        self.assertLess(len(lines[0]), 1200)
        self.assertTrue(all(result[p] == 'unreviewed observation/full inspection' for p in paths))

    def test_inventory_keeps_missing_admitted_source_and_manifest_strict(self):
        from scripts.ci_acceptance import inventory
        baseline = inventory()
        with self.assertRaisesRegex(ValueError, 'admitted blocking sources missing'):
            inventory(discovered=set(baseline) - {'tests/test_ci_impact.py'})
        with tempfile.TemporaryDirectory() as temporary, self.assertRaisesRegex(ValueError, 'case manifest missing'):
            inventory(root=Path(temporary), discovered=set(baseline), observed=[])

    def test_inherited_unreviewed_e2e_does_not_fail_selection_or_transport_gate(self):
        from scripts import ci_acceptance as acceptance
        original = acceptance.inventory
        baseline = original()
        extra = 'tests/e2e/zz-unregistered-fixture.spec.mjs'
        head = subprocess.check_output(['git', 'rev-parse', 'HEAD']).decode().strip()
        plan = ci_impact.plan('stable', 'inherited main test audit', head=head)
        needs = {'selection': {'result': 'success', 'outputs': {'plan': json.dumps(plan)}},
                 'checks': {'result': 'success'}}
        with tempfile.TemporaryDirectory() as temporary, redirect_stdout(io.StringIO()), mock.patch.object(
                acceptance, 'inventory', side_effect=lambda: original(discovered=set(baseline) | {extra})):
            root = Path(temporary)
            acceptance.write(root / 'plan.json', plan)
            with mock.patch.object(sys, 'argv', ['ci_acceptance.py', 'validate', '--plan', str(root / 'plan.json')]):
                acceptance.main()
            self.assertEqual(json.loads((root / 'inventory.json').read_text(encoding='utf-8'))[extra],
                             'unreviewed observation/full inspection')
            roots = {check: root / check for check in plan['checks']}
            receipts = [success_evidence(plan, check, roots[check]) for check in plan['checks']]
            acceptance.gate(plan, needs, receipts, head, roots=roots)
            report = roots['ci'] / 'python.json'
            report.write_bytes(report.read_bytes() + b'\n')
            with self.assertRaisesRegex(ValueError, 'tampered'):
                acceptance.gate(plan, needs, receipts, head, roots=roots)

    def test_bad_or_downscoped_v2_plans_cannot_turn_light(self):
        from scripts import ci_acceptance, ci_full_plan
        fallback = ci_impact.plan('stable', 'unknown diff', head='b' * 40)
        ci_acceptance.validate_plan(fallback)
        self.assertFalse(fallback['preview'])
        with self.assertRaises(ValueError):
            ci_acceptance.validate_plan({**fallback, 'preview': True})
        plan = ci_impact.plan('stable', 'test', base='a' * 40, head='b' * 40, trusted=True)
        for field, value in [('version', 1), ('version', True), ('checks', []), ('checks', ['data']),
                             ('checks', ['docs']), ('paths', []), ('paths', ['../README.md']),
                             ('head', 'bad'), ('trusted_diff', False), ('preview', 'false')]:
            bad = {**plan, field: value}
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                ci_acceptance.validate_plan(bad)
        with self.assertRaises(ValueError):
            ci_acceptance.validate_plan(ci_full_plan.plan('full', 'inspection', head='b' * 40))

    def test_documentation_and_unknown_code_have_distinct_roles(self):
        for path in ('docs/engineering/DEBUG_WORKFLOW.md', 'docs/plans/new.md', 'docs/logs/new.md'):
            self.assertEqual(ci_impact.classify([path])[0], 'light')
        self.assertEqual(ci_impact.classify(['unknown.py'])[0], 'stable')

    def test_consumers_precede_documentation_exemptions(self):
        self.assertIn('website', ci_impact.checks_for(['docs/user/WORKFLOW.md']))
        self.assertIn('release', ci_impact.checks_for(['CHANGELOG.md']))
        self.assertIn('tools', ci_impact.checks_for(['tools/README.md']))
        self.assertEqual(ci_impact.checks_for(['docs/fixtures/input.md']), list(ci_impact.CHECKS))

    def test_blocking_receipts_and_job_results_are_fail_closed(self):
        from scripts import ci_acceptance
        plan = ci_impact.plan('stable', 'test', base='a' * 40, head='b' * 40, trusted=True)
        needs = {'selection': {'result': 'success', 'outputs': {'plan': json.dumps(plan)}},
                 'checks': {'result': 'success'}}
        with tempfile.TemporaryDirectory() as temporary:
            roots = {check: Path(temporary) / check for check in plan['checks']}
            receipts = [success_evidence(plan, check, roots[check]) for check in plan['checks']]
            ci_acceptance.gate(plan, needs, receipts, plan['head'], roots=roots)
            with self.assertRaises(ValueError):
                ci_acceptance.gate(plan, needs, receipts, plan['head'])
            for state in ('failure', 'cancelled', 'skipped', ''):
                bad = copy.deepcopy(needs)
                bad['checks']['result'] = state
                with self.subTest(state=state), self.assertRaises(ValueError):
                    ci_acceptance.gate(plan, bad, receipts, plan['head'], roots=roots)
            for bad in (receipts[:-1], receipts + receipts[:1],
                        [{**r, 'namespace': 'auxiliary-v1'} for r in receipts],
                        [{**r, 'head': 'c' * 40} for r in receipts],
                        [{**r, 'status': 'failure'} for r in receipts]):
                with self.assertRaises(ValueError):
                    ci_acceptance.gate(plan, needs, bad, plan['head'], roots=roots)
            with self.assertRaises(ValueError):
                ci_acceptance.gate(plan, needs, receipts, 'c' * 40, roots=roots)

    def test_acceptance_has_no_auxiliary_dependencies(self):
        workflow = Path('.github/workflows/editor-checks.yml').read_text(encoding='utf-8')
        gate = workflow.split('  acceptance:', 1)[1]
        self.assertIn('name: Change acceptance', gate)
        self.assertIn('needs: [selection, checks]', gate)
        self.assertNotIn('browser', gate)
        self.assertNotIn('preview', gate)
        auxiliary = Path('.github/workflows/test-matrix.yml').read_text(encoding='utf-8').split('permissions:', 1)[0]
        self.assertNotIn('pull_request:', auxiliary)
        self.assertNotIn('push:', auxiliary)
