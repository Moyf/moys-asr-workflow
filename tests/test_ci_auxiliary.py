from unittest import TestCase, mock
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

from scripts import ci_auxiliary, ci_impact


class AuxiliaryPlanTests(TestCase):
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
