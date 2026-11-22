from unittest import TestCase, mock
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

from scripts import ci_auxiliary, ci_impact, ci_run_layer
from tests.compact_assertions import CompactContainerAssertions


class AuxiliaryPlanTests(CompactContainerAssertions, TestCase):
    def test_real_document_and_independent_spec_routes(self):
        root = Path(__file__).resolve().parents[1]
        head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
        base = head  # These test paths do not require reading a previous manifest.
        doc = ci_impact.plan(['docs/engineering/DEBUG_WORKFLOW.md'], base=base, head=head, trusted=True)
        self.assertEqual(doc['checks'], ['docs'])
        aux_doc = ci_auxiliary.auxiliary_plan(doc)
        self.assertFalse(aux_doc['python_tests'] or aux_doc['node_tests'] or aux_doc['e2e_specs'])
        film = ci_impact.plan(['tests/e2e/filmstrip-real.spec.mjs'], base=base, head=head, trusted=True)
        self.assertEqual(film['checks'], [])
        aux_film = ci_auxiliary.auxiliary_plan(film)
        self.assertEqual(aux_film['e2e_specs'], ['tests/e2e/filmstrip-real.spec.mjs'])
        self.assertTrue(aux_film['preparation']['real_media'])

    def test_browser_shards_follow_selected_file_count(self):
        specs = ['tests/e2e/cue-list-count-layout.spec.mjs', 'tests/e2e/multi-subtitle.spec.mjs',
                 'tests/e2e/settings-structure.spec.mjs']
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for count, groups in ((0, []), (1, [specs[:1]]), (2, [specs[:2]]),
                                  (3, [specs[::2], specs[1::2]])):
                with self.subTest(count=count):
                    output = root / f'outputs-{count}'
                    plan = {'python_tests': ['tests/test_asr_presets.py'], 'node_tests': [],
                            'e2e_specs': specs[:count], 'reasons': []}
                    env = {'GITHUB_OUTPUT': str(output), 'GITHUB_STEP_SUMMARY': str(root / 'summary')}
                    with mock.patch.dict(os.environ, env):
                        ci_auxiliary.write_plan(plan, root / 'plan.json')
                    values = dict(line.split('=', 1) for line in output.read_text(encoding='utf-8').splitlines())
                    self.assertEqual(json.loads(values['aux_browser_shards']), [1, 2] if count == 3 else [1])
                    written = json.loads((root / 'plan.json').read_text(encoding='utf-8'))
                    self.assertEqual(written['browser_file_groups'], groups)
                    self.assertEqual(values['aux_python'], 'true')
                    self.assertEqual(values['aux_browser'], str(bool(count)).lower())

    def test_only_selected_complete_admissions_are_removed(self):
        blocking = {'trusted_diff': True, 'paths': ['maw/project.py'], 'base': 'a' * 40,
                    'head': 'b' * 40, 'checks': ['data']}
        impact = {'mode': 'targeted', 'packs': [],
                  'python_tests': ['tests/test_project_io.py', 'tests/test_v2_migration_save.py', 'tests/test_other.py'],
                  'node_tests': ['tests/test_editor_state.mjs'], 'e2e_specs': ['tests/e2e/filmstrip-real.spec.mjs'],
                  'preparation': {}, 'tools_scope': 'all', 'reasons': ['test']}
        with mock.patch.object(ci_auxiliary.ci_acceptance, 'validate_plan'), \
                mock.patch.object(ci_auxiliary, 'select_packs', return_value=impact):
            plan = ci_auxiliary.auxiliary_plan(blocking)
        self.assertEqual(plan['python_tests'], ['tests/test_v2_migration_save.py', 'tests/test_other.py'])
        self.assertEqual(plan['node_tests'], ['tests/test_editor_state.mjs'])
        self.assertEqual(plan['e2e_specs'], ['tests/e2e/filmstrip-real.spec.mjs'])

    def test_untrusted_or_full_impact_does_not_schedule_full_suite(self):
        base = {'trusted_diff': False, 'head': 'b' * 40}
        with mock.patch.object(ci_auxiliary.ci_acceptance, 'validate_plan'):
            self.assertEqual(ci_auxiliary.auxiliary_plan(base)['e2e_specs'], [])
            with mock.patch.object(ci_auxiliary, 'select_packs', return_value={'mode': 'full'}):
                plan = ci_auxiliary.auxiliary_plan({**base, 'trusted_diff': True, 'paths': ['x'], 'base': 'a' * 40})
        self.assertEqual(plan['python_tests'], [])
        self.assertIn('review manually', plan['reasons'][0])

    def test_advisory_job_is_not_an_acceptance_dependency(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/editor-checks.yml').read_text(encoding='utf-8')
        acceptance = workflow.split('\n  acceptance:\n', 1)[1]
        self.assertIn('needs: [selection, checks]', acceptance)
        self.assertNotIn('auxiliary', acceptance)

    def test_failed_auxiliary_layer_does_not_skip_later_selected_layers(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/editor-checks.yml').read_text(encoding='utf-8')
        auxiliary = workflow.split('\n  auxiliary:\n', 1)[1].split('\n  checks:\n', 1)[0]
        self.assertIn('aux_browser_shards: ${{ steps.scope.outputs.aux_browser_shards }}', workflow)
        self.assertIn("fromJSON(needs.selection.outputs.aux_browser_shards || '[1]')", auxiliary)
        for layer, label in (('python', 'Python'), ('node', 'Node'), ('browser', 'browser')):
            step = auxiliary.split(f'- name: Selected additional {label} tests\n', 1)[1].split('\n      - ', 1)[0]
            self.assertIn("!cancelled() &&", step)
            self.assertIn("steps.plan.outcome == 'success'", step)
            self.assertIn(f"needs.selection.outputs.aux_{layer} == 'true'", step)
            if layer != 'browser':
                self.assertIn('matrix.shard == 1', step)
            self.assertIn(f'ci_run_layer.py --layer {layer}', step)
        self.assertNotIn('continue-on-error', auxiliary)

    def test_layer_passes_preparation_outcomes_and_preserves_python_entry_point(self):
        venv = Path('.venv/Scripts/python.exe' if os.name == 'nt' else '.venv/bin/python').absolute()
        plan = {'python_tests': [], 'node_tests': ['tests/test_editor_bundle.mjs'], 'e2e_specs': [],
                'preparation': {'application': True, 'editor_bundle': True, 'launcher_bundle': False,
                                'python_dependencies': True}}
        steps = {'js_install': {'outcome': 'success'}, 'build_editor': {'outcome': 'failure'},
                 'build_launcher': {'outcome': 'skipped'}, 'chromium': {'outcome': 'skipped'}}
        for installed, node in ((True, 'success'), (False, 'skipped'), (False, 'failure')):
            python = str(venv) if installed else sys.executable
            steps['py_install'] = {'outcome': 'success' if installed else 'failure'}
            steps['node'] = {'outcome': node}
            with self.subTest(installed=installed, node=node), \
                    mock.patch.dict(os.environ, {'CI_PREPARATION': json.dumps(steps)}), \
                    mock.patch.object(Path, 'read_text', return_value=json.dumps(plan)), \
                    mock.patch.object(Path, 'resolve', return_value=Path(sys.executable)), \
                    mock.patch.object(ci_run_layer.subprocess, 'run', return_value=mock.Mock(returncode=7)) as run:
                code = ci_run_layer.main(['--layer', 'node', '--report-dir', 'evidence'])
            self.assertEqual(code, 7)
            command = run.call_args.args[0]
            self.assertEqual(command[:2], [python, 'scripts/test_workflow.py'])
            self.assertEqual(run.call_args.kwargs['env']['MAW_TEST_PYTHON'], python)
            self.assertEqual(run.call_args.kwargs['env']['MAW_E2E_PYTHON'], python)
            blocked = [command[index + 1] for index, arg in enumerate(command) if arg == '--blocked-preparation']
            expected = ['build']
            if node != 'success':
                expected.append('node-runtime')
            if not installed:
                expected.append('python-dependencies')
            self.assertEqual(blocked, expected)

    def test_unrequested_browser_and_bundle_preparation_does_not_block_python(self):
        plan = {'python_tests': ['tests/test_asr_presets.py'], 'node_tests': [], 'e2e_specs': [],
                'preparation': {}}
        steps = {step: {'outcome': 'skipped'} for step in (
            'node', 'js_install', 'py_install', 'build_editor', 'build_launcher', 'chromium', 'ffmpeg',
        )}
        with mock.patch.dict(os.environ, {'CI_PREPARATION': json.dumps(steps)}), \
                mock.patch.object(Path, 'read_text', return_value=json.dumps(plan)), \
                mock.patch.object(ci_run_layer.subprocess, 'run', return_value=mock.Mock(returncode=0)) as run:
            self.assertEqual(ci_run_layer.main(['--layer', 'python', '--report-dir', 'evidence']), 0)
        self.assertEqual(run.call_args.args[0][0], sys.executable)
        self.assertNotIn('--blocked-preparation', run.call_args.args[0])

    def test_browser_layer_passes_ci_matrix_shard(self):
        plan = {'python_tests': [], 'node_tests': [],
                'e2e_specs': [f'tests/e2e/case-{index}.spec.mjs' for index in range(20)],
                'preparation': {}}
        with mock.patch.dict(os.environ, {'CI_PREPARATION': '{}'}), \
                mock.patch.object(Path, 'read_text', return_value=json.dumps(plan)), \
                mock.patch.object(ci_run_layer.subprocess, 'run', return_value=mock.Mock(returncode=7)) as run:
            self.assertEqual(ci_run_layer.main(['--layer', 'browser', '--report-dir', 'evidence', '--shard', '2/2']), 7)
        command = run.call_args.args[0]
        self.assertEqual(command[command.index('--shard') + 1], '2/2')
        self.assertEqual(command[command.index('--report-dir') + 1], 'evidence')

    def test_auxiliary_planning_failure_is_visible_without_failing_admission(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            out = root / 'outputs'
            blocking = {'trusted_diff': False, 'head': 'b' * 40, 'checks': ['docs'],
                        'light': True, 'preview': False}
            env = {**os.environ, 'GITHUB_OUTPUT': str(out)}
            with mock.patch.object(sys, 'argv', ['ci_impact', '--plan', str(root / 'blocking.json'),
                                               '--aux-plan', str(root / 'aux.json')]), \
                    mock.patch.dict(os.environ, env, clear=True), mock.patch.object(ci_impact, 'select', return_value=blocking), \
                    mock.patch.object(ci_auxiliary, 'auxiliary_plan', side_effect=ValueError('fixture failure')):
                ci_impact.main()
            self.assertEqual(json.loads((root / 'blocking.json').read_text(encoding='utf-8')), blocking)
            self.assertEqual(json.loads((root / 'aux.json').read_text(encoding='utf-8'))['generation_error'], 'fixture failure')
            self.assertIn('aux_error=true', out.read_text(encoding='utf-8'))
