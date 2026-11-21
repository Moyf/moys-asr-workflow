"""Trusted whole PR/push diffs; the former unknown=>full expansion is withdrawn."""
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from scripts import ci_impact
from tests.compact_assertions import CompactContainerAssertions

ROOT = Path(__file__).resolve().parents[1]


class ScopeTests(CompactContainerAssertions, unittest.TestCase):
    def test_real_git_ci_policy_and_mixed_docs_do_not_request_preview(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            def git(*args):
                return subprocess.check_output(['git', '-c', 'user.name=Test', '-c',
                    'user.email=test@example.invalid', *args], cwd=root, stderr=subprocess.PIPE).decode().strip()
            def commit():
                git('add', '-A')
                git('commit', '--allow-empty', '-m', 'fixture')
                return git('rev-parse', 'HEAD')
            git('init')
            commit()
            for index, (paths, expected) in enumerate([
                (['.github/workflows/pr-release-windows.yml'], False),
                (['scripts/packaging/MAW.spec'], True),
                (['.github/workflows/pr-release-windows.yml', 'docs/plans/ci.md'], False),
                (['scripts/unknown-ci-helper.py'], False),
            ]):
                before = git('rev-parse', 'HEAD')
                for name in paths:
                    path = root / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(f'# fixture {index}\n', encoding='utf-8', newline='\n')
                head = commit()
                for event in ('pull_request', 'push'):
                    selected = ci_impact.select(event, before, root, before=before, after=head)
                    with self.subTest(paths=paths, event=event):
                        self.assertTrue(selected['trusted_diff'])
                        self.assertEqual(selected['preview'], expected)

    def test_website_input_exceptions_match_actual_curated_consumer(self):
        source = (ROOT / 'website/scripts/sync-maw-docs.mjs').read_text(encoding='utf-8')
        curated = source.split('const documents = [', 1)[1].split('\n];', 1)[0]
        actual = set(re.findall(r"source:\s*'([^']+)'", curated))
        exceptions = {p for p in actual if p != 'README.md' and not p.startswith('docs/user/')}
        self.assertEqual(ci_impact.WEBSITE_INPUT_EXCEPTIONS, exceptions)
        for path in actual:
            self.assertEqual(ci_impact.checks_for([path]), ['docs', 'website'])
        self.assertEqual(ci_impact.checks_for(['docs/engineering/unpublished.md']), ['docs'])

    def test_document_images_select_website_check(self):
        self.assertEqual(ci_impact.checks_for(['docs/assets/readme/overview.webp']), ['docs', 'website'])
        # Root assets are not website document inputs; unclassified code/assets
        # still conservatively select the existing full set of blocking checks.
        self.assertEqual(ci_impact.checks_for(['assets/example.png']), list(ci_impact.CHECKS))

    def test_preview_is_runtime_specific_and_manual_is_job_level(self):
        for path in ('maw_gui.py', 'maw/runtimes/base.py', 'scripts/build-windows.ps1',
                     'web/launcher/boot/launcher.js', 'web/editor/boot/editor.js', 'pyproject.toml',
                     'docs/user/FAQ-常见问题.txt'):
            self.assertTrue(ci_impact.preview_for([path]))
        for path in ('docs/plans/new.md', 'README.md', 'tests/test_new.py',
                     'web/editor/io/editor-project-save.js', 'CHANGELOG.md', 'tools/README.md'):
            self.assertFalse(ci_impact.preview_for([path]))
        workflow = (ROOT / '.github/workflows/pr-release-windows.yml').read_text(encoding='utf-8')
        job = workflow.split('  build-windows:', 1)[1]
        self.assertIn("github.event_name == 'workflow_dispatch'", job)
        self.assertIn("needs.selection.outputs.preview == 'true'", job)
        self.assertNotIn('outputs.light', job)
        ffmpeg = job.split('      - name: Install FFmpeg for media integration tests\n', 1)[1].split('\n      - name:', 1)[0]
        self.assertIn('uses: ./.github/actions/windows-ffmpeg', ffmpeg)
        self.assertNotIn('if:', ffmpeg)
        self.assertNotIn('run:', ffmpeg)
        self.assertFalse(ci_impact.plan('stable', 'unavailable scope', head='b' * 40)['preview'])

    def test_finite_admission_and_consumer_precedence(self):
        for paths in ([], ['web/shared/utils.js'], ['package.json'], ['uv.lock'], ['unknown.py'],
                      ['tests/test_unknown.py'], ['docs/fixtures/input.md'], ['docs/plans/data/input.md'],
                      ['../README.md'], ['a\\b'], ['a\nb'], ['C:/bad'], ['a//b']):
            with self.subTest(paths=paths):
                self.assertEqual(ci_impact.checks_for(paths), list(ci_impact.CHECKS))
                self.assertEqual(ci_impact.classify(paths)[0], 'stable')
        for path, consumer in [('README.md', 'website'), ('docs/user/WORKFLOW.md', 'website'),
                               ('CHANGELOG.md', 'release'), ('docs/releases/1.11.3.md', 'release'),
                               ('tools/shared/README.md', 'tools'), ('docs/INDEX.md', 'website'),
                               ('docs/logs/release1.11.3/task.checklist.md', 'tools'),
                               ('docs/engineering/JSON_SCHEMA.md', 'website'), ('docs/logs/a.md', 'docs')]:
            self.assertEqual(ci_impact.checks_for([path]), ['docs', consumer] if consumer != 'docs' else ['docs'])
        self.assertEqual(ci_impact.classify(['README.md', 'unknown.py'])[0], 'stable')

    def test_real_git_whole_pr_main_multicommit_rename_first_missing_shallow_and_sha(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)

            def git(*args):
                return subprocess.check_output(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
                                                *args], cwd=root, stderr=subprocess.PIPE).decode().strip()

            def write(name, text):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text, encoding='utf-8', newline='\n')

            def commit():
                git('add', '-A')
                git('commit', '--allow-empty', '-m', 'test')
                return git('rev-parse', 'HEAD')

            def push(before, after):
                return ci_impact.select('push', '', root, before=before, after=after)

            git('init')
            write('docs/plans/test.md', '# initial\n')
            base = commit()
            write('docs/plans/test.md', '# changed\n')
            head = commit()
            self.assertEqual(push(base, head)['checks'], ['docs'])
            self.assertTrue(push(base, head)['trusted_diff'])
            self.assertEqual(ci_impact.select('pull_request', base, root, after=head)['checks'], ['docs'])
            write('unknown.py', '# code\n')
            commit()
            write('docs/plans/test.md', '# last commit only docs\n')
            head = commit()
            # Push spans all commits. A PR checkout is a merge whose first parent
            # is base; its second parent may carry many commits.
            self.assertEqual(push(base, head)['checks'], list(ci_impact.CHECKS))
            git('checkout', '-b', 'merge', base)
            git('merge', '--no-ff', '-m', 'merge', head)
            merged = git('rev-parse', 'HEAD')
            self.assertEqual(ci_impact.select('pull_request', base, root, after=merged)['checks'], list(ci_impact.CHECKS))
            for before, after in [('', merged), ('HEAD', merged), ('0' * 40, merged), ('a' * 40, merged),
                                  (base, 'bad'), (base, head), (merged, merged)]:
                selected = push(before, after)
                self.assertEqual(selected['checks'], list(ci_impact.CHECKS))
                self.assertFalse(selected['trusted_diff'])
                self.assertFalse(selected['preview'])
            before = merged
            git('mv', 'unknown.py', 'docs/plans/moved.md')
            head = commit()
            self.assertEqual(push(before, head)['checks'], list(ci_impact.CHECKS))
            # Nonancestor, even if both objects exist.
            git('checkout', '--orphan', 'orphan')
            other = commit()
            self.assertFalse(push(base, other)['trusted_diff'])
            git('checkout', 'merge')
            (root / '.git/shallow').write_text(head + '\n', encoding='ascii')
            selected = push(before, head)
            self.assertFalse(selected['trusted_diff'])
            self.assertFalse(selected['preview'])

    def test_public_output_is_v2_for_documentation_push(self):
        with mock.patch.object(ci_impact, 'select', return_value=ci_impact.plan(
                'light', 'test', base='a' * 40, head='b' * 40, trusted=True, preview=False)):
            with tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                with mock.patch.dict(os.environ, {'GITHUB_OUTPUT': str(root / 'output')}), mock.patch.object(
                        sys, 'argv', ['ci_impact.py', '--plan', str(root / 'plan')]):
                    ci_impact.main()
                self.assertEqual(json.loads((root / 'plan').read_text())['version'], 2)
                self.assertIn('preview=false', (root / 'output').read_text())
                self.assertIn('matrix=', (root / 'output').read_text())

    def test_bad_git_utf8_unterminated_malformed_diff_expand_only_stable(self):
        for raw in (b'\xff\0', b'README.md', b'', b'\0', b'../README.md\0'):
            with self.subTest(raw=raw), mock.patch.object(ci_impact.subprocess, 'check_output', side_effect=[
                    b'b' * 40 + b'\n', b'a' * 40 + b'\n', b'false\n', b'', raw]):
                selected = ci_impact.select('pull_request', 'a' * 40)
                self.assertEqual(selected['checks'], list(ci_impact.CHECKS))
                self.assertFalse(selected['preview'])
        with mock.patch.object(ci_impact.subprocess, 'check_output', side_effect=OSError('missing git')):
            selected = ci_impact.select('push', '')
            self.assertEqual(selected['mode'], 'stable')
            self.assertFalse(selected['preview'])


if __name__ == '__main__':
    unittest.main()
