"""Consumer selection: actual dependencies, bounded dynamic assembly and unions."""
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from scripts import local_test_impact as impact


class ConsumerSelectionTests(unittest.TestCase):
    def test_engineering_docs_use_curated_site_sources(self):
        ordinary = impact.select_packs(['docs/engineering/DEBUG_WORKFLOW.md'])
        self.assertEqual(ordinary['mode'], 'targeted')
        self.assertIn('docs', ordinary['packs'])
        self.assertNotIn('website', ordinary['packs'])
        self.assertEqual(ordinary['python_tests'], ['tests/test_docs_check.py'])
        website = impact.select_packs(['docs/engineering/DEVELOPMENT.md'])
        self.assertIn('website', website['packs'])
        self.assertEqual(website['python_tests'], ['tests/test_docs_check.py'])

    def test_real_browser_spec_and_unrelated_tool_only_prepare_actual_needs(self):
        path = 'tests/e2e/filmstrip-real.spec.mjs'
        plan = impact.select_packs([path])
        self.assertEqual(plan['mode'], 'targeted')
        self.assertEqual(plan['e2e_specs'], [path])
        self.assertEqual(plan['python_tests'], [])
        self.assertEqual(plan['node_tests'], [])
        self.assertTrue(plan['preparation']['application'])
        self.assertTrue(plan['preparation']['real_media'])
        self.assertFalse(plan['preparation']['preview_windows'])
        tool = impact.select_packs(['tests/e2e/tool-markdown.spec.mjs'])
        self.assertFalse(tool['preparation']['application'])
        self.assertFalse(tool['preparation']['real_media'])

    def test_color_filter_selects_observed_behavior_not_unrelated_helpers(self):
        plan = impact.select_packs(['web/editor/cues/editor-color-filter.js'])
        self.assertEqual(plan['mode'], 'targeted')
        self.assertIn('tests/e2e/cue-color-filter.spec.mjs', plan['e2e_specs'])
        self.assertIn('tests/e2e/speaker-identity-surfaces.spec.mjs', plan['e2e_specs'])
        self.assertIn('tests/e2e/overlay-track.spec.mjs', plan['e2e_specs'])
        self.assertIn('tests/test_editor_script_syntax.mjs', plan['node_tests'])
        self.assertIn('tests/test_editor_cues_imports.mjs', plan['node_tests'])
        self.assertNotIn('tests/test_v2_cue_panel_render.mjs', plan['node_tests'])
        self.assertNotIn('tests/test_track_semantics.mjs', plan['node_tests'])
        self.assertNotIn('tests/test_editor_assets.py', plan['python_tests'])
        self.assertLess(len(plan['node_tests']), 12)

    def test_shared_factory_selects_actual_facade_function_consumer(self):
        plan = impact.select_packs(['web/shared/utils/split-trim.js'])
        self.assertIn('tests/test_editor_utils.mjs', plan['node_tests'])
        self.assertNotIn('tests/test_track_semantics.mjs', plan['node_tests'])

    def test_save_primary_flows_without_secondary_heavy_consumers(self):
        plan = impact.select_packs(['web/editor/io/editor-project-save.js'])
        self.assertIn('tests/test_project_save_state.mjs', plan['node_tests'])
        self.assertIn('tests/test_editor_recovery_save.mjs', plan['node_tests'])
        self.assertIn('tests/e2e/editor-transactions.spec.mjs', plan['e2e_specs'])
        self.assertIn('tests/e2e/project-async-lifecycle.spec.mjs', plan['e2e_specs'])
        self.assertNotIn('tests/e2e/filmstrip-real.spec.mjs', plan['e2e_specs'])
        self.assertLess(len(plan['e2e_specs']), 16)

    def test_thumbnail_endpoint_and_function_local_test_import(self):
        plan = impact.select_packs(['maw/thumbnail_jobs.py'])
        self.assertIn('tests/test_thumbnail_jobs.py', plan['python_tests'])
        self.assertIn('tests/test_thumbnails.py', plan['python_tests'])
        self.assertIn('tests/e2e/filmstrip-real.spec.mjs', plan['e2e_specs'])
        self.assertIn('tests/e2e/filmstrip-cache.spec.mjs', plan['e2e_specs'])
        self.assertNotIn('tests/test_asr_errors.py', plan['python_tests'])
        self.assertLess(len(plan['python_tests']), 25)

    def test_document_real_read_is_discovered_without_fixture_name_false_positive(self):
        path = 'docs/logs/1.8.0-beta.1/2026-10-09/first-verification/maw-verification-v1.8.0b1-to-main.html'
        plan = impact.select_packs([path])
        self.assertIn('tests/test_verification_checklist.py', plan['python_tests'])
        readme = impact.select_packs(['README.md'])
        self.assertNotIn('tests/test_local_models.py', readme['python_tests'])
        self.assertNotIn('tests/e2e/tool-markdown.spec.mjs', readme['e2e_specs'])
        changelog = impact.select_packs(['CHANGELOG.md'])
        self.assertIn('tests/e2e/tool-pages.spec.mjs', changelog['e2e_specs'])
        self.assertNotIn('tests/e2e/changelog-write-lock.spec.mjs', changelog['e2e_specs'])

    def test_mixed_change_is_union_and_locks_stay_broad(self):
        source = 'web/editor/cues/editor-color-filter.js'
        domain = impact.select_packs([source])
        docs = impact.select_packs(['docs/engineering/DEBUG_WORKFLOW.md'])
        mixed = impact.select_packs([source, 'docs/engineering/DEBUG_WORKFLOW.md'])
        self.assertEqual(set(mixed['python_tests']), set(domain['python_tests']) | set(docs['python_tests']))
        self.assertEqual(set(mixed['node_tests']), set(domain['node_tests']) | set(docs['node_tests']))
        self.assertEqual(set(mixed['e2e_specs']), set(domain['e2e_specs']) | set(docs['e2e_specs']))
        self.assertEqual(impact.select_packs([source, 'uv.lock'])['mode'], 'full')

    def test_preparation_follows_real_bundle_and_python_imports(self):
        for path in ('tests/test_editor_assets.py', 'tests/test_editor_bundle.mjs'):
            self.assertTrue(impact.select_packs([path])['preparation']['application'], path)
        for path in ('tests/test_editor_manifest.py', 'tests/test_web_build.py', 'tests/test_web_build_artifact.mjs'):
            self.assertFalse(impact.select_packs([path])['preparation']['application'], path)
        self.assertFalse(impact.select_packs(['tests/test_editor_bundle.mjs'])['preparation']['python_dependencies'])
        self.assertTrue(impact.select_packs(['tests/e2e/filmstrip-real.spec.mjs'])['preparation']['python_dependencies'])
        self.assertFalse(impact.select_packs(['tests/test_docs_check.py'])['preparation']['python_dependencies'])
        self.assertFalse(impact.select_packs(['tests/test_ci_impact.py'])['preparation']['python_dependencies'])
        self.assertTrue(impact.select_packs(['tests/test_energy_valley.py'])['preparation']['python_dependencies'])

    def test_node_python_subprocess_dependencies_follow_actual_imports(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name, text in {'maw/pure.py': 'import json\n', 'maw/external.py': 'import requests\n',
                'tests/test_pure.mjs': "import { spawnSync } from 'node:child_process'; spawnSync(process.env.MAW_TEST_PYTHON, ['-c', 'from maw.pure import thing']);",
                'tests/test_external.mjs': "import { spawnSync } from 'node:child_process'; spawnSync(process.env.MAW_TEST_PYTHON, ['-c', 'from maw.external import thing']);"}.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text, encoding='utf-8')
            with mock.patch.object(impact, 'ROOT', root):
                self.assertFalse(impact.select_packs(['tests/test_pure.mjs'])['preparation']['python_dependencies'])
                self.assertTrue(impact.select_packs(['tests/test_external.mjs'])['preparation']['python_dependencies'])

    def test_no_changes_and_lazy_import_call_chain(self):
        self.assertEqual(impact.select_packs([])['packs'], [])
        self.assertFalse(impact.select_packs([])['fallback_checks'])
        self.assertEqual(impact.select_packs(None)['mode'], 'full')
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            files = {'maw/a.py': 'def value(): return 1\n',
                     'maw/b.py': 'def lazy():\n    from maw.a import value\n    return value()\ndef public(): return lazy()\n',
                     'maw/c.py': 'from .b import public as f\ndef consume(): return f()\n',
                     'tests/test_c.py': 'from maw.c import consume\ndef test_usage(): assert consume()\n',
                     'tests/test_unrelated.py': 'from maw.c import consume\ndef test_other(): assert True\n'}
            for name, text in files.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text, encoding='utf-8')
            with mock.patch.object(impact, 'ROOT', root):
                plan = impact.select_packs(['maw/a.py'])
                self.assertIn('tests/test_c.py', plan['python_tests'])
                self.assertNotIn('tests/test_unrelated.py', plan['python_tests'])

    def test_package_init_and_shared_test_helper_consumers(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            files = {'maw/__init__.py': 'VALUE=1\n', 'maw/b.py': 'from maw import VALUE\n',
                     'tests/test_b.py': 'from maw.b import VALUE\n',
                     'tests/helpers/example.mjs': 'export const value = 1;\n',
                     'tests/test_helper.mjs': "import {value} from './helpers/example.mjs';\n",
                     'tests/test_unrelated.mjs': "import test from 'node:test';\n"}
            for name, text in files.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text, encoding='utf-8')
            with mock.patch.object(impact, 'ROOT', root):
                self.assertIn('tests/test_b.py', impact.select_packs(['maw/__init__.py'])['python_tests'])
                helper = impact.select_packs(['tests/helpers/example.mjs'])
                self.assertIn('tests/test_helper.mjs', helper['node_tests'])
                self.assertNotIn('tests/test_unrelated.mjs', helper['node_tests'])

    def test_function_local_import_reaches_public_project_validator(self):
        plan = impact.select_packs(['maw/text_processing_presets.py'])
        self.assertIn('tests/test_project_tracks.py', plan['python_tests'])
        self.assertNotIn('tests/test_ass_canvas_raster.mjs', plan['node_tests'])

    def test_fixture_and_transitive_python_consumers_in_small_tree(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            files = {'maw/a.py':'VALUE=1\n', 'maw/b.py':'from maw.a import VALUE\n',
                     'tests/test_b.py':'from maw.b import VALUE\n',
                     'tests/test_other.py':'VALUE=2\n',
                     'tests/fixtures/example.json':'{}',
                     'tests/test_fixture.py':"from pathlib import Path\ndata = (Path('tests/fixtures/example.json')).read_text()\n"}
            for name, text in files.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text, encoding='utf-8')
            with mock.patch.object(impact, 'ROOT', root):
                plan = impact.select_packs(['maw/a.py'])
                self.assertIn('tests/test_b.py', plan['python_tests'])
                self.assertNotIn('tests/test_other.py', plan['python_tests'])
                fixture = impact.select_packs(['tests/fixtures/example.json'])
                self.assertIn('tests/test_fixture.py', fixture['python_tests'])
                (root / 'maw/a.py').unlink()
                self.assertIn('tests/test_b.py', impact.select_packs(['maw/a.py'])['python_tests'])

    def test_repository_path_reads_select_launcher_and_editor_consumers(self):
        for path, consumer in (
            ('web/launcher/postprocess.js', 'tests/test_gui_web.py'),
            ('web/editor-template.html', 'tests/test_editor_assets.py'),
        ):
            with self.subTest(path=path):
                self.assertIn(consumer, impact.select_packs([path])['python_tests'])

    def test_split_repository_path_read_ignores_literals_and_temporary_paths(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            files = {
                'web/launcher/example.html': '',
                'tests/test_reader.py': """from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
def test_read():
    source = (
        ROOT / 'web'
        / 'launcher' / 'example.html'
    )
    return source.read_text()
""",
                'tests/test_other.py': """import tempfile
from pathlib import Path
def test_temp():
    with tempfile.TemporaryDirectory() as tmp:
        source = (Path(tmp) / 'web/launcher/example.html').read_text()
        return source == "read_text('web/launcher/example.html')"
""",
            }
            for name, source in files.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(source, encoding='utf-8')
            with mock.patch.object(impact, 'ROOT', root):
                plan = impact.select_packs(['web/launcher/example.html'])
                self.assertEqual(plan['python_tests'], ['tests/test_reader.py'])

    def test_node_subprocesses_are_consumers_of_actual_python_inputs(self):
        for path in ('maw/ass_styles.py', 'maw/script_alignment.py'):
            with self.subTest(path=path):
                self.assertIn('tests/test_editor_utils.mjs', impact.select_packs([path])['node_tests'])
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            files = {
                'maw/a.py': 'VALUE = 1\n',
                'maw/b.py': 'from .a import VALUE\n',
                'tests/test_direct.mjs': """import { spawnSync } from 'node:child_process';
spawnSync(process.env.MAW_TEST_PYTHON, ['-c', 'from maw.a import VALUE']);
""",
                'tests/test_transitive.mjs': """import { spawnSync } from 'node:child_process';
spawnSync(process.env.MAW_TEST_PYTHON, ['-c', 'from maw.b import VALUE']);
""",
                'tests/test_unrelated.mjs': """import { spawnSync } from 'node:child_process';
const fixture = 'from maw.a import VALUE';
spawnSync(process.env.MAW_TEST_PYTHON, ['-c', 'import json']);
""",
            }
            for name, source in files.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(source, encoding='utf-8')
            with mock.patch.object(impact, 'ROOT', root):
                self.assertEqual(impact.select_packs(['maw/a.py'])['node_tests'],
                                 ['tests/test_direct.mjs', 'tests/test_transitive.mjs'])

    def test_server_preparation_follows_called_browser_fixture(self):
        selected = impact.select_packs(['tests/e2e/cue-scroll-stability.spec.mjs'])
        self.assertTrue(selected['preparation']['application'])
        self.assertTrue(selected['preparation']['python_dependencies'])
        for path in ('tests/e2e/tool-markdown.spec.mjs', 'tests/e2e/tool-compact.spec.mjs'):
            with self.subTest(path=path):
                tool = impact.select_packs([path])
                self.assertFalse(tool['preparation']['application'])
                self.assertFalse(tool['preparation']['python_dependencies'])
