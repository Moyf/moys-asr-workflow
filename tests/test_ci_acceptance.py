from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import xml.etree.ElementTree as ET

from scripts import ci_acceptance as acceptance
from scripts import ci_impact as impact
from tests.compact_assertions import CompactContainerAssertions

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW_ROOT = Path(os.environ.get('MAW_CI_CONTRACT_ROOT', ROOT))


class AcceptanceTests(CompactContainerAssertions, unittest.TestCase):
    def test_empty_admission_requires_intentional_skip_and_no_receipts(self):
        with mock.patch.object(impact, 'checks_for', return_value=[]):
            plan = impact.plan(['tests/e2e/filmstrip-real.spec.mjs'], base='a' * 40, head='b' * 40, trusted=True)
            needs = {'selection': {'result': 'success', 'outputs': {'plan': json.dumps(plan)}},
                     'checks': {'result': 'skipped'}}
            acceptance.gate(plan, needs, [], plan['head'], Path('.'))
            with self.assertRaises(ValueError):
                acceptance.gate(plan, {**needs, 'checks': {'result': 'success'}}, [], plan['head'], Path('.'))
            with self.assertRaises(ValueError):
                acceptance.gate(plan, needs, [{'check': 'docs'}], plan['head'], Path('.'))

    def fixture(self, path='docs/plans/example.md', head='b' * 40):
        plan = impact.plan([path], base='a' * 40, head=head, trusted=True)
        needs = {'selection': {'result': 'success', 'outputs': {'plan': json.dumps(plan)}},
                 'checks': {'result': 'success'}}
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name) / 'evidence'
        receipts = []
        for check in plan['checks']:
            root = self.root / check
            if check in acceptance.PYTHON:
                ids = [c.id() for c in acceptance.cases(acceptance.build_suite(acceptance.PYTHON[check], 'tests', 'test_*.py'))]
                acceptance.write(root / 'admitted-python-ids.json', ids)
                acceptance.write(root / 'python.json', dict(selected_ids=ids, run=len(ids), skips=[], exit_code=0,
                                                           failures=0, errors=0, expected_failures=0, unexpected_successes=0))
            if check in acceptance.NODE:
                entry = acceptance.node_admission()[check]
                acceptance.write(root / 'admitted-node-files.json', entry['files'])
                acceptance.write(root / 'admitted-node-names.json', entry['names'])
                suite = ET.Element('testsuites')
                for name in entry['names']:
                    ET.SubElement(suite, 'testcase', name=name)
                (root / 'node.xml').write_bytes(ET.tostring(suite))
            records = []
            count = len(acceptance.commands_for(check)) + int(check in acceptance.PYTHON) + int(check in acceptance.NODE)
            for index in range(count):
                result = f'checks/example{index}/result.json'
                command = ['python', 'fixture']
                acceptance.write(root / result, dict(status='completed', exit_code=0, cleanup_error=None, command=command))
                records.append(dict(result=result, command=command))
            acceptance.write(root / 'command-results.json', records)
            receipt = dict(namespace='blocking-2dev', check=check, head=plan['head'],
                           fingerprint=acceptance.fingerprint(plan), status='success',
                           manifest=acceptance.manifest_fingerprint(check), evidence=acceptance.seal_evidence(root))
            acceptance.write(root / 'receipt.json', receipt)
            receipts.append(receipt)
        return plan, needs, receipts

    def test_receipts_reject_missing_duplicate_wrong_sha_failed_skipped_cancelled(self):
        plan, needs, receipts = self.fixture()
        acceptance.gate(plan, needs, receipts, plan['head'], self.root)
        for evidence in ([], receipts * 2, [{**receipts[0], 'head': 'c' * 40}],
                         [{**receipts[0], 'status': 'failure'}], [{**receipts[0], 'fingerprint': 'old'}]):
            with self.assertRaises(ValueError):
                acceptance.gate(plan, needs, evidence, plan['head'], self.root)
        for outcome in ('failure', 'skipped', 'cancelled', 'timed_out', ''):
            for job in ('selection', 'checks'):
                bad = copy.deepcopy(needs)
                bad[job]['result'] = outcome
                with self.assertRaises(ValueError):
                    acceptance.gate(plan, bad, receipts, plan['head'], self.root)
        with self.assertRaises(ValueError):
            acceptance.gate(plan, needs, receipts, 'c' * 40, self.root)
        # Advisory results deliberately never enter the exact needs contract.
        with self.assertRaises(ValueError):
            acceptance.gate(plan, {**needs, 'preview': {'result': 'failure'}}, receipts, plan['head'], self.root)

    def test_bad_plan_cannot_reduce_unknown_admission(self):
        plan, needs, receipts = self.fixture()
        for change in ({'version': 1}, {'checks': []}, {'checks': ['docs', 'docs']},
                       {'checks': ['full']}, {'preview': True}, {'paths': ['unknown.py']},
                       {'head': 'invalid'}, {'trusted_diff': False}, {'light': False}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                acceptance.validate_plan({**plan, **change})
        bad_needs = copy.deepcopy(needs)
        bad_needs['selection']['outputs']['plan'] = '{}'
        with self.assertRaises(ValueError):
            acceptance.gate(plan, bad_needs, receipts, plan['head'], self.root)

    def test_python_report_matches_exact_discovery_without_skips(self):
        good = dict(selected_ids=['tests.example.Case.test_one'], run=1, skips=[], exit_code=0,
                    failures=0, errors=0, expected_failures=0, unexpected_successes=0)
        acceptance.validate_python_report(good, good['selected_ids'])
        for change in ({'selected_ids': []}, {'run': 0}, {'run': True}, {'skips': [{'id': 'x'}]},
                       {'exit_code': 1}, {'failures': 1}, {'errors': 1}, {'expected_failures': 1},
                       {'unexpected_successes': 1}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                acceptance.validate_python_report({**good, **change}, good['selected_ids'])

    def test_node_report_requires_exact_discovery_and_no_unsupported_results(self):
        good = ET.fromstring('<testsuites><testsuite><testcase name="one"/></testsuite></testsuites>')
        acceptance.validate_node_report(['one'], good)
        for body in ('', '<testcase name="two"/>', '<testcase name="one"><skipped/></testcase>',
                     '<testcase name="one"><failure/></testcase>', '<testcase name="one"><error/></testcase>',
                     '<testcase name="one"/><testcase name="one"/>'):
            with self.assertRaises(ValueError):
                acceptance.validate_node_report(['one'], ET.fromstring('<testsuites><testsuite>' + body + '</testsuite></testsuites>'))

    def test_public_gate_cli_reopens_transported_reports_collections_and_results(self):
        head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT).decode().strip()
        plan, needs, _ = self.fixture('tools/example/README.md', head=head)
        planfile = self.root.parent / 'plan.json'
        acceptance.write(planfile, plan)
        transported = self.root.parent / 'transported'
        env = {**os.environ, 'CI_NEEDS': json.dumps(needs), 'GITHUB_SHA': head}
        mutations = [None, ('docs/python.json', 'delete'), ('docs/python.json', 'change'),
                     ('docs/admitted-python-ids.json', 'change'), ('tools/node.xml', 'delete'),
                     ('tools/node.xml', 'change'), ('tools/admitted-node-names.json', 'change'),
                     ('docs/checks/example0/result.json', 'delete'), ('docs/checks/example0/result.json', 'cancelled'),
                     ('docs/python.json', 'invalid-report'), ('tools/node.xml', 'skipped-report'),
                     ('docs/admitted-python-ids.json', 'wrong-collection')]
        for index, mutation in enumerate(mutations):
            target = transported / str(index)
            shutil.copytree(self.root, target)
            if mutation:
                filename, action = mutation
                file = target / filename
                if action == 'delete':
                    # Tests remove only their own generated temporary fixture.
                    file.unlink()
                elif action in {'cancelled', 'invalid-report', 'skipped-report', 'wrong-collection'}:
                    if action == 'skipped-report':
                        xml = ET.parse(file)
                        ET.SubElement(next(xml.getroot().iter('testcase')), 'skipped')
                        xml.write(file, encoding='utf-8')
                    elif action == 'wrong-collection':
                        acceptance.write(file, ['tests.not_admitted.Case.test_missing'])
                    else:
                        value = json.loads(file.read_text(encoding='utf-8'))
                        change = {'status': 'interrupted', 'exit_code': 130} if action == 'cancelled' else {'run': 0}
                        acceptance.write(file, {**value, **change})
                    check = filename.split('/')[0]
                    receiptfile = target / check / 'receipt.json'
                    receipt = json.loads(receiptfile.read_text(encoding='utf-8'))
                    # Even a renewed byte binding cannot conceal bad outcomes or
                    # a collection that disagrees with the checked-out admission.
                    acceptance.write(receiptfile, {**receipt, 'evidence': acceptance.seal_evidence(target / check)})
                else:
                    file.write_text('{}', encoding='utf-8')
            result = subprocess.run([sys.executable, 'scripts/ci_acceptance.py', 'gate', '--plan', str(planfile),
                                     '--root', str(target)], cwd=ROOT, env=env, capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode == 0, mutation is None, result.stderr[-1000:])
            if mutation:
                summary = json.loads((target.parent / 'failures.json').read_text(encoding='utf-8'))
                self.assertEqual(summary['head'], head)
                self.assertTrue(summary['gate_error'])

    def test_node_admission_executes_each_test_body_once_without_name_filter(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture = root / 'once.mjs'
            counter = root / 'counter.txt'
            fixture.write_text("import test from 'node:test'; import {appendFileSync} from 'node:fs';\n"
                               + 'test("exactly once", () => appendFileSync(' + json.dumps(str(counter)) + ', "x"));\n', encoding='utf-8')
            policy = {'launcher': {'files': [str(fixture)], 'names': ['exactly once']}}
            with mock.patch.object(acceptance, 'NODE', {'launcher': [str(fixture)]}), \
                    mock.patch.object(acceptance, 'node_admission', return_value=policy):
                acceptance.run_check(impact.plan([], head='b' * 40), 'launcher', root / 'evidence')
            self.assertEqual(counter.read_text(), 'x')
            records = json.loads((root / 'evidence/command-results.json').read_text())
            self.assertEqual(len(records), 1)
            self.assertFalse(any('--test-name-pattern' in arg for arg in records[0]['command']))

    def test_build_failure_blocks_only_its_consumer_and_keeps_later_failures(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            evidence = root / 'evidence'
            node_fixture = root / 'late.mjs'
            node_fixture.write_text("import test from 'node:test';\n"
                                    "test('late failure', () => { throw new Error('late diagnostic'); });\n",
                                    encoding='utf-8')
            names = []
            execute = acceptance.execute_check

            def build_fixture(command, timeout, logs):
                name = command[-1]
                names.append(name)
                if command[:2] == ['pnpm', 'run']:
                    code = {'build:editor': 7, 'typecheck': 9}.get(name, 0)
                    command = [sys.executable, '-c', f'raise SystemExit({code})']
                return execute(command, timeout, logs)

            with mock.patch.object(acceptance, 'NODE', {'build': [str(node_fixture)]}), \
                    mock.patch.object(acceptance, 'execute_check', side_effect=build_fixture):
                with self.assertRaises(ValueError):
                    acceptance.run_check(impact.plan([], head='b' * 40), 'build', evidence)

            self.assertEqual(names, ['build:editor', 'build:launcher', 'check:launcher', 'typecheck', str(node_fixture)])
            records = json.loads((evidence / 'command-results.json').read_text(encoding='utf-8'))
            codes = [json.loads((evidence / item['result']).read_text(encoding='utf-8'))['exit_code'] for item in records]
            self.assertEqual(codes, [7, 0, 0, 9, 1])
            failed = json.loads((evidence / 'failures.json').read_text(encoding='utf-8'))['failures']
            self.assertEqual([(item['gate'], item['kind']) for item in failed], [
                ('build-editor', 'process'), ('check-editor', 'blocked'),
                ('typecheck', 'process'), ('node', 'failure'),
            ])
            self.assertIn('late diagnostic', failed[-1]['error'])
            self.assertFalse((evidence / 'receipt.json').exists())

    def test_manifest_targets_exist_and_python_ids_are_auditable(self):
        for group, targets in acceptance.PYTHON.items():
            found = [c.id() for c in acceptance.cases(acceptance.build_suite(targets, 'tests', 'test_*.py'))]
            self.assertTrue(found, group)
            self.assertFalse(any('_FailedTest' in identity for identity in found), found)
            self.assertEqual(len(found), len(set(found)))
        for targets in acceptance.NODE.values():
            for target in targets:
                self.assertTrue((ROOT / target).is_file(), target)
        self.assertEqual(set(acceptance.node_admission()), set(acceptance.NODE))

    def test_failure_summary_retains_blocked_missing_and_unreadable_reports(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'evidence'
            plan = {'head': 'b' * 40, 'checks': ['docs', 'tools', 'build', 'data']}
            acceptance.write(root / 'docs/receipt.json', {'status': 'success'})
            acceptance.write(root / 'tools/failures.json', {'report_errors': [], 'failures': [
                {'gate': 'tools-docs', 'kind': 'blocked', 'requires': ['node-runtime']},
            ]})
            acceptance.write(root / 'data/failures.json', {})
            acceptance.summarize_failures(plan, root)
            summary = json.loads((root.parent / 'failures.json').read_text(encoding='utf-8'))
            self.assertEqual(summary['checks'], plan['checks'])
            self.assertEqual(summary['failures'], [
                {'check': 'tools', 'gate': 'tools-docs', 'kind': 'blocked', 'requires': ['node-runtime']},
            ])
            self.assertEqual([record['check'] for record in summary['report_errors']], ['build', 'data'])

    def test_cold_editor_helper_missing_acorn_is_visible_with_both_reporters(self):
        # Outside the nested worktree: parent node_modules cannot hide the
        # actual helper's acorn import dependency, as it did in local testing.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            helpers = root / 'helpers'
            helpers.mkdir()
            shutil.copyfile(ROOT / 'tests/helpers/init-module-source.mjs', helpers / 'init-module-source.mjs')
            fixture = root / 'cold-editor.mjs'
            fixture.write_text("import './helpers/init-module-source.mjs';\n", encoding='utf-8')
            report = root / 'node.xml'
            code, result = acceptance.execute_check(acceptance.node_command([str(fixture)], report), 30, root / 'checks')
            self.assertNotEqual(code, 0)
            output = Path(result['log']).read_text(encoding='utf-8')
            self.assertIn('ERR_MODULE_NOT_FOUND', output)
            self.assertIn("Cannot find package 'acorn'", output)
            self.assertTrue(report.is_file())
            self.assertTrue(list(ET.parse(report).getroot().iter('failure')))

    def test_contract_dependency_is_explicit_hash_pinned_and_matches_lock(self):
        requirement = (ROOT / 'scripts/ci-contract-requirements.txt').read_text(encoding='utf-8')
        self.assertIn('send2trash==2.1.0', requirement)
        self.assertEqual(requirement.count('--hash=sha256:'), 2)
        lock = (ROOT / 'uv.lock').read_text(encoding='utf-8')
        self.assertIn('name = "send2trash"\nversion = "2.1.0"', lock)


class WorkflowPolicyTests(CompactContainerAssertions, unittest.TestCase):
    def read_workflow(self, name):
        return (WORKFLOW_ROOT / '.github/workflows' / name).read_text(encoding='utf-8')

    def test_daily_gate_has_only_selected_dependencies_no_heavy_commands(self):
        workflow = self.read_workflow('editor-checks.yml')
        self.assertIn('name: Change acceptance', workflow)
        self.assertIn('needs: [selection, checks]', workflow)
        self.assertIn('if: always()', workflow)
        self.assertIn('branches: [main, 2.0dev]', workflow)
        self.assertIn('PUSH_BEFORE_SHA: ${{ github.event.before }}', workflow)
        self.assertIn('fetch-depth: 0', workflow)
        admission = workflow.split('\n  checks:\n', 1)[1].split('\n  acceptance:\n', 1)[0]
        for forbidden in ('test:unit', 'playwright', 'ffmpeg', 'windows-', 'continue-on-error', 'uv sync', 'schedule:'):
            self.assertNotIn(forbidden, admission)
        self.assertIn('name: Targeted auxiliary tests', workflow)
        self.assertIn('pattern: blocking-receipt-*', workflow)
        self.assertIn('path: .artifacts/blocking/evidence', workflow)
        self.assertIn('pip install --no-deps --require-hashes -r scripts/ci-contract-requirements.txt', workflow)
        acceptance = workflow.split('\n  acceptance:\n', 1)[1]
        self.assertLess(acceptance.index('ci_acceptance.py gate'), acceptance.index('ci_acceptance.py summarize'))
        self.assertIn("if: ${{ failure() && steps.plan.outcome == 'success' }}", acceptance)
        self.assertIn('path: .artifacts/blocking/failures.json', acceptance)

    def test_existing_complete_coverage_is_manual_only(self):
        for name in ('full-checks-manual.yml', 'windows-full-manual.yml'):
            workflow = self.read_workflow(name)
            trigger = workflow.split('permissions:', 1)[0]
            self.assertIn('workflow_dispatch:', trigger)
            for forbidden in ('pull_request:', 'push:', 'schedule:'):
                self.assertNotIn(forbidden, trigger)
            self.assertNotIn('continue-on-error', workflow)
        self.assertIn('pnpm run test:unit', self.read_workflow('full-checks-manual.yml'))
        self.assertIn('tests/e2e/review-data-safety.spec.mjs', self.read_workflow('full-checks-manual.yml'))
        self.assertIn('windows-cache-report-check', self.read_workflow('windows-full-manual.yml'))
        self.assertIn('windows-launcher-report-check', self.read_workflow('windows-full-manual.yml'))

    def test_editor_job_installs_frozen_root_dependencies_without_postinstall(self):
        workflow = self.read_workflow('editor-checks.yml').split('\n  checks:\n', 1)[1].split('\n  acceptance:\n', 1)[0]
        steps = workflow.split('\n      - ')
        setup = next(step for step in steps if 'uses: pnpm/action-setup@' in step)
        install = next(step for step in steps if 'run: pnpm install --frozen-lockfile --ignore-scripts' in step)
        self.assertIn("if: ${{ matrix.check == 'build' || matrix.check == 'editor' || matrix.check == 'website' }}", setup)
        self.assertIn("if: ${{ matrix.check == 'build' || matrix.check == 'editor' }}", install)
        self.assertIn('run_install: false', setup)
        self.assertLess(workflow.index('run: pnpm install --frozen-lockfile --ignore-scripts'),
                        workflow.index('name: Run admitted check and validate evidence'))
        self.assertNotIn('playwright install', workflow)

    def test_advisory_preview_is_scoped_and_has_no_full_suite(self):
        workflow = self.read_workflow('pr-release-windows.yml')
        self.assertIn('name: Windows release preview (advisory)', workflow)
        self.assertIn("if: ${{ needs.selection.outputs.preview == 'true' }}", workflow)
        self.assertIn('runs-on: windows-2022', workflow)
        self.assertIn('scripts/packaging/smoke_editor.py', workflow)
        for forbidden in ('playwright', 'Install FFmpeg', 'windows-python.json', 'continue-on-error', 'edit.py --blank'):
            self.assertNotIn(forbidden, workflow)

    def test_formal_release_is_byte_unchanged_from_branch_baseline(self):
        # Pin the independently reviewed release boundary, not a Git object that
        # would be absent from a shallow CI checkout. Intentional release changes
        # must review/update this boundary explicitly.
        self.assertEqual(hashlib.sha256((ROOT / '.github/workflows/release.yml').read_bytes()).hexdigest(),
                         'b80066d70ab4ce77186dfa36988314fc096476249e39831f37d2a7212a883ed6')
