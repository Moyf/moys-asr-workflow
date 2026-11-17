from __future__ import annotations

import os
from pathlib import Path
import subprocess
import re
import tempfile
import unittest

from scripts import ci_impact as impact


class ImpactTests(unittest.TestCase):
    def test_explanations_and_actual_consumers_are_distinct(self):
        for path in ('docs/engineering/DEBUG_WORKFLOW.md', 'docs/plans/a.md', 'docs/logs/a.md', 'AGENTS.md'):
            self.assertEqual(impact.checks_for([path]), ['docs'])
        for path in ('README.md', 'docs/user/CLI.md', 'website/src/pages/index.astro', 'website/src/generated/a.json',
                     'docs/engineering/DEVELOPMENT.md', 'docs/INDEX.md'):
            self.assertEqual(impact.checks_for([path]), ['docs', 'website'])
        self.assertEqual(impact.checks_for(['docs/engineering/JSON_SCHEMA.md']), ['docs', 'website', 'data'])
        self.assertEqual(impact.checks_for(['CHANGELOG.md']), ['docs', 'release'])
        self.assertEqual(impact.checks_for(['tools/a/README.md']), ['docs', 'tools'])
        self.assertEqual(impact.checks_for(['docs/logs/a.checklist.md']), ['docs', 'tools'])

    def test_shared_unknown_fixtures_and_malformed_paths_use_finite_fallback(self):
        for paths in (['unknown.py'], ['web/shared/utils/a.js'], ['tests/fixtures/README.md'],
                      ['docs/logs/data/example.md'], [], ['../escape.md'], ['a\\b'], ['a\nfile']):
            self.assertEqual(impact.checks_for(paths), list(impact.CHECKS))
        self.assertNotIn('full', impact.CHECKS)
        self.assertIn('editor', impact.checks_for(['web/editor/io/editor-project-save.js']))

    def test_unmapped_input_keeps_finite_fallback_when_other_files_have_consumers(self):
        config = 'tests/config/playwright.config.mjs'
        self.assertEqual(impact.checks_for([config]), list(impact.CHECKS))
        for known in ('tests/e2e/tool-markdown.spec.mjs', 'web/editor/cues/editor-color-filter.js'):
            with self.subTest(known=known):
                self.assertEqual(impact.checks_for([config, known]), list(impact.CHECKS))

    def test_preview_scope_is_packaging_startup_runtime_or_manual(self):
        for path in ('docs/plans/a.md', 'web/editor/cues/editor-word-timing.js', 'tests/test_something.py',
                     'web/shared/utils/text.js', 'unknown.py', '.github/workflows/pr-release-windows.yml',
                     '.github/workflows/editor-checks.yml', 'scripts/ci_acceptance.py'):
            self.assertFalse(impact.preview_for([path]), path)
        for path in ('scripts/packaging/MAW.spec', 'maw/gui_web.py', 'web/editor/boot/editor.js',
                     'pyproject.toml', 'desktop/main.js', 'docs/user/FAQ-常见问题.txt'):
            self.assertTrue(impact.preview_for([path]), path)
        self.assertTrue(impact.select('workflow_dispatch')['preview'])
        self.assertFalse(impact.select('pull_request', 'bad')['preview'])
        self.assertFalse(impact.select('push', before='bad', after='bad')['preview'])

    def test_every_curated_website_source_is_selected_before_generic_docs(self):
        script = (impact.ROOT / 'website/scripts/sync-maw-docs.mjs').read_text(encoding='utf-8')
        curated = script.split('const documents = [', 1)[1].split('\n];', 1)[0]
        declarations = re.findall(r'\bsource\s*:', curated)
        self.assertGreater(len(declarations), 0)
        self.assertEqual(len(declarations), len(impact.WEBSITE_INPUTS), 'Website source syntax drift requires review')
        for path in impact.WEBSITE_INPUTS:
            self.assertTrue((impact.ROOT / path).is_file(), path)
            self.assertTrue({'docs', 'website'} <= set(impact.checks_for([path])), path)

    def test_real_whole_pr_merge_diff_and_push_before_after(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            env = {**os.environ, 'GIT_CONFIG_NOSYSTEM': '1'}
            def git(*args):
                return subprocess.check_output(['git', *args], cwd=root, env=env, stderr=subprocess.PIPE).decode().strip()
            def commit(path, text):
                target = root / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(text, encoding='utf-8')
                git('add', '.')
                git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture')
                return git('rev-parse', 'HEAD')
            git('init', '-q', '-b', 'target')
            base = commit('seed', 'base')
            git('checkout', '-qb', 'feature')
            commit('docs/engineering/a.md', 'first')
            feature = commit('docs/plans/b.md', 'second')
            pushed = impact.select('push', cwd=root, before=base, after=feature)
            self.assertTrue(pushed['trusted_diff'])
            self.assertEqual(pushed['checks'], ['docs'])
            self.assertFalse(pushed['preview'])
            git('checkout', '-q', 'target')
            git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'merge', '--no-ff', '-qm', 'merge', 'feature')
            merged = git('rev-parse', 'HEAD')
            pr = impact.select('pull_request', base, cwd=root, after=merged)
            self.assertEqual(pr['checks'], ['docs'])
            self.assertEqual(pr['paths'], ['docs/engineering/a.md', 'docs/plans/b.md'])
            self.assertTrue(pr['trusted_diff'])
            git('checkout', '-qb', 'ci-policy')
            policy_head = commit('.github/workflows/pr-release-windows.yml', 'policy-only')
            policy = impact.select('push', cwd=root, before=merged, after=policy_head)
            self.assertTrue(policy['trusted_diff'])
            self.assertFalse(policy['preview'])
            git('checkout', '-q', 'target')
            git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'merge', '--no-ff', '-qm', 'policy-merge', 'ci-policy')
            policy_merge = git('rev-parse', 'HEAD')
            self.assertFalse(impact.select('pull_request', merged, cwd=root, after=policy_merge)['preview'])
            packaging_head = commit('scripts/packaging/MAW.spec', 'actual-payload')
            packaging = impact.select('push', cwd=root, before=policy_merge, after=packaging_head)
            self.assertTrue(packaging['trusted_diff'])
            self.assertTrue(packaging['preview'])
            for bad in (impact.select('pull_request', feature, cwd=root, after=merged),
                        impact.select('push', cwd=root, before='0' * 40, after=merged),
                        impact.select('push', cwd=root, before=base, after=feature)):
                self.assertFalse(bad['trusted_diff'])
                self.assertEqual(bad['checks'], list(impact.CHECKS))
                self.assertFalse(bad['preview'])
