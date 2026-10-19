from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts.publish_release import publish
from scripts.verify_release_site import verify
from io import BytesIO
from tests.compact_assertions import CompactContainerAssertions


class ReleasePublicationTests(CompactContainerAssertions, unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.notes = self.root / 'notes.md'
        self.notes.write_text('Release notes', encoding='utf-8')
        self.names = ['MAW-Windows-x64-v2.0.0.zip', 'MAW-lite-Windows-x64-v2.0.0.zip']
        for name in self.names:
            (self.root / name).write_bytes(b'package')
        self.assets = [dict(name=name, size=7, state='uploaded') for name in self.names]

    def test_draft_upload_verification_precedes_publication(self):
        found = json.dumps([dict(tag_name='v2.0.0', draft=True, prerelease=False, assets=self.assets)])
        published = json.dumps([dict(tag_name='v2.0.0', draft=False, prerelease=False, assets=self.assets)])
        with patch('scripts.publish_release.gh', side_effect=['[]', '', '', found, '', published]) as gh:
            publish('v2.0.0', self.notes, self.root)
        calls = [call.args for call in gh.call_args_list]
        self.assertEqual(calls[0][:2], ('api', 'repos/Moyf/moys-asr-workflow/releases?per_page=100&page=1'))
        self.assertIn('--draft', calls[1])
        self.assertIn('--verify-tag', calls[1])
        self.assertEqual(calls[2][:2], ('release', 'upload'))
        self.assertEqual(calls[3][0], 'api')
        self.assertIn('--draft=false', calls[4])
        self.assertNotIn('--latest', calls[4])

    def test_existing_draft_rerun_edits_instead_of_creating(self):
        draft = json.dumps([dict(tag_name='v2.0.0', draft=True, prerelease=False, assets=[])])
        published = json.dumps([dict(tag_name='v2.0.0', draft=False, prerelease=False, assets=self.assets)])
        with patch('scripts.publish_release.gh', side_effect=[draft, '', '', published, '', published]) as gh:
            publish('v2.0.0', self.notes, self.root)
        calls = [call.args for call in gh.call_args_list]
        self.assertNotIn('--draft', calls[1])
        self.assertNotIn('--verify-tag', calls[1])
        self.assertIn('release', calls[1][:2])

    def test_bad_upload_leaves_draft_unpublished(self):
        bad_assets = [dict(self.assets[0], size=1), self.assets[1]]
        found = json.dumps([dict(tag_name='v2.0.0', draft=True, prerelease=False, assets=bad_assets)])
        with patch('scripts.publish_release.gh', side_effect=['[]', '', '', found]) as gh:
            with self.assertRaisesRegex(ValueError, 'did not verify'):
                publish('v2.0.0', self.notes, self.root)
        self.assertFalse(any('--draft=false' in call.args for call in gh.call_args_list))

    def test_missing_required_package_never_contacts_github(self):
        (self.root / self.names[0]).write_bytes(b'')
        with patch('scripts.publish_release.gh') as gh:
            with self.assertRaisesRegex(ValueError, 'missing or empty'):
                publish('v2.0.0', self.notes, self.root)
        gh.assert_not_called()

    def test_existing_release_rerun_does_not_withdraw_it(self):
        existing = json.dumps([dict(tag_name='v2.0.0', draft=False, prerelease=False, assets=[])])
        uploaded = json.dumps([dict(tag_name='v2.0.0', draft=False, prerelease=False, assets=self.assets)])
        published = json.dumps([dict(tag_name='v2.0.0', draft=False, prerelease=False, assets=self.assets)])
        with patch('scripts.publish_release.gh', side_effect=[existing, '', '', uploaded, '', published]) as gh:
            publish('v2.0.0', self.notes, self.root)
        calls = [call.args for call in gh.call_args_list]
        self.assertNotIn('--draft', calls[1])
        self.assertNotIn('--verify-tag', calls[1])

    def test_refresh_is_explicit_and_serialized(self):
        root = Path(__file__).resolve().parents[1]
        release = (root / '.github/workflows/release.yml').read_text(encoding='utf-8')
        pages = (root / '.github/workflows/deploy-editor-pages.yml').read_text(encoding='utf-8')
        self.assertIn('uses: ./.github/workflows/deploy-editor-pages.yml', release)
        self.assertIn('needs: publish', release)
        self.assertIn('workflow_call:', pages)
        self.assertIn('cancel-in-progress: false', pages)
        self.assertIn('ref: main', pages)
        self.assertIn('--expected-tag "$EXPECTED_TAG"', pages)

    def test_deployed_verification_rejects_stale_index_and_checks_notes(self):
        index = dict(schema_version=1, latest_stable='2.0.0', releases=[dict(version='2.0.0')])
        with patch('scripts.verify_release_site.urlopen', return_value=BytesIO(json.dumps(index).encode())):
            with self.assertRaisesRegex(ValueError, 'caught up'):
                verify('https://example.test', 'v2.0.1')
        notes = dict(schema_version=1, version='2.0.0', body_markdown='Update')
        from unittest.mock import MagicMock
        response = MagicMock()
        response.__enter__.return_value.status = 200
        with patch('scripts.verify_release_site.urlopen', side_effect=[BytesIO(json.dumps(index).encode()),
                                                                       BytesIO(json.dumps(notes).encode()), response]):
            verify('https://example.test/project', 'v2.0.0')


if __name__ == '__main__':
    unittest.main()
