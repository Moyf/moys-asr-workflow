from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts.build_release_site import build, downloads_for, fetch_facts, localize_images, write_outputs
from scripts.prepare_release_notes import build_release_document, REPO
from tests.compact_assertions import CompactContainerAssertions


class ReleaseSiteTests(CompactContainerAssertions, unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'docs/releases').mkdir(parents=True)

    def archive(self, version, text='- A useful update.', base=None):
        source = f'## [{version}] - 2026-10-18\n\n'
        if base:
            source += f'<!-- release-base: {base} -->\n\n'
        source += text + '\n'
        (self.root / f'docs/releases/{version}.md').write_bytes(
            build_release_document(source, 'v' + version).encode('utf-8'))

    def fact(self, version, platforms=('windows',)):
        tag = 'v' + version
        names = {'windows': f'MAW-Windows-x64-{tag}.zip',
                 'linux': f'MAW-Linux-x86_64-{tag}.AppImage'}
        return dict(tag_name=tag, draft=False, prerelease=False, published_at='2026-10-18T02:00:00Z',
                    assets=[dict(name=names[p], size=120, state='uploaded',
                                 browser_download_url=f'https://github.com/{REPO}/releases/download/{tag}/{names[p]}')
                            for p in platforms])

    def test_publication_filters_and_semver_order_keep_partial_platforms(self):
        for version in ('2.9.0', '2.10.0', '3.0.0'):
            self.archive(version)
        draft = dict(self.fact('3.0.0'), draft=True)
        beta = dict(self.fact('3.0.0-beta.1'), prerelease=True)
        malformed_beta = dict(beta, prerelease=False)
        result, _, _, notes = build(self.root, [self.fact('2.9.0'), self.fact('2.10.0'), draft, beta, malformed_beta],
                                    'https://example.test/project', '/project/')
        self.assertEqual(result['latest_stable'], '2.10.0')
        self.assertEqual([e['version'] for e in result['releases']], ['2.10.0', '2.9.0'])
        self.assertEqual(result['releases'][0]['notes_url'], 'https://example.test/project/releases/2.10.0/')
        self.assertEqual(len(result['releases'][0]['downloads']), 1)
        self.assertIn('2.10.0', notes)

    def test_missing_archive_and_expected_version_fail_instead_of_empty_feed(self):
        with self.assertRaisesRegex(ValueError, 'no archive'):
            build(self.root, [self.fact('2.0.0')], 'https://example.test', '/')
        self.archive('2.0.0')
        with self.assertRaisesRegex(ValueError, 'expected published'):
            build(self.root, [self.fact('2.0.0', ())], 'https://example.test', '/', 'v2.0.0')
        result, *_ = build(self.root, [self.fact('2.0.0', ())], 'https://example.test', '/')
        self.assertIsNone(result['latest_stable'])
        self.assertTrue(result['notices'])

    def test_unuploaded_and_external_attachments_are_rejected(self):
        fact = self.fact('2.0.0')
        fact['assets'][0]['state'] = 'new'
        with self.assertRaisesRegex(ValueError, 'not uploaded'):
            downloads_for(fact, fact['tag_name'])
        fact['assets'][0]['state'] = 'uploaded'
        fact['assets'][0]['browser_download_url'] = 'https://example.test/installer.zip'
        with self.assertRaisesRegex(ValueError, 'invalid download'):
            downloads_for(fact, fact['tag_name'])

    def test_legacy_xff_is_full_and_old_maw_package_is_lite(self):
        fact = self.fact('1.4.0')
        legacy = dict(fact['assets'][0])
        legacy['name'] = legacy['name'].replace('MAW-', 'MAWxFF-')
        legacy['browser_download_url'] = legacy['browser_download_url'].replace('/MAW-', '/MAWxFF-')
        fact['assets'].append(legacy)
        self.assertEqual([d['variant'] for d in downloads_for(fact, 'v1.4.0')], ['full', 'lite'])

    def test_preview_writes_pages_but_never_advertises_an_update(self):
        self.archive('2.0.0')
        result = build(self.root, None, 'http://localhost:4321', '/')
        write_outputs(self.root, *result)
        feed_path = self.root / 'website/public/releases/index.json'
        feed = json.loads(feed_path.read_text(encoding='utf-8'))
        self.assertEqual(feed['releases'], [])
        self.assertIsNone(feed['latest_stable'])
        self.assertTrue((self.root / 'website/src/pages/releases/2.0.0.md').exists())
        self.assertFalse((self.root / 'website/public/releases/2.0.0/notes.json').exists())

    def test_rebuild_removes_withdrawn_pages_and_notes_preserving_template(self):
        self.archive('2.0.0')
        result = build(self.root, [self.fact('2.0.0')], 'https://example.test', '/')
        write_outputs(self.root, *result)
        template = self.root / 'website/src/pages/releases/index.astro'
        template.write_text('template', encoding='utf-8')
        write_outputs(self.root, *build(self.root, [], 'https://example.test', '/'))
        self.assertFalse((template.parent / '2.0.0.md').exists())
        self.assertFalse((self.root / 'website/public/releases/2.0.0/notes.json').exists())
        self.assertEqual(template.read_text(), 'template')

    def test_images_are_fixed_version_deduplicated_and_examples_untouched(self):
        url = f'https://raw.githubusercontent.com/{REPO}/v2.0.0/docs/assets/a.webp'
        assets = {}
        body = f'![a]({url})\n<img src="{url}">\n`![example]({url})`\n```md\n![example]({url})\n```'
        with patch('scripts.build_release_site.git_bytes', return_value=b'fixed bytes') as reader:
            result = localize_images(body, self.root, '/project/', None, assets)
        self.assertEqual(len(assets), 1)
        self.assertEqual(reader.call_args.args[1:], ('v2.0.0', 'docs/assets/a.webp'))
        self.assertEqual(result.count('/project/release-assets/'), 2)
        self.assertIn(f'`![example]({url})`', result)
        with patch('scripts.build_release_site.git_bytes', side_effect=ValueError('missing fixed resource')):
            with self.assertRaisesRegex(ValueError, 'missing fixed'):
                localize_images(f'![a]({url})', self.root, '/', None, {})

    def test_notes_images_have_absolute_url_and_base_must_be_published(self):
        image = f'![图](https://raw.githubusercontent.com/{REPO}/v2.0.0/docs/assets/a.webp)'
        self.archive('2.0.0', image)
        self.archive('2.0.1', base='2.0.0')
        with self.assertRaisesRegex(ValueError, 'base .* not available'):
            build(self.root, [self.fact('2.0.1')], 'https://example.test', '/project/')
        with patch('scripts.build_release_site.git_bytes', return_value=b'image'):
            _, _, _, notes = build(self.root, [self.fact('2.0.1'), self.fact('2.0.0')],
                                   'https://example.test', '/project/')
        self.assertIn('https://example.test/project/release-assets/', notes['2.0.0']['body_markdown'])
        self.assertEqual(notes['2.0.1']['base'], '2.0.0')

    def test_fetch_failure_never_silently_returns_empty(self):
        with patch('scripts.build_release_site.urlopen', side_effect=OSError('offline')):
            with self.assertRaises(OSError):
                fetch_facts()


if __name__ == '__main__':
    unittest.main()
