"""Shared P0 fixtures prove the P1 protocol never changes persisted v1 data."""
import copy
import json
import unittest
from dataclasses import FrozenInstanceError
from maw.tracks import LegacyProjectAdapter, secondary_track_id
from tests.test_track_golden import FIXTURES, python_outputs


class TrackAccessTests(unittest.TestCase):
    def test_raw_round_trip_and_object_identity_for_all_fixtures(self):
        for path in sorted(FIXTURES.glob('*.input.json')):
            with self.subTest(fixture=path.name):
                project = json.loads(path.read_text())
                before = copy.deepcopy(project)
                store = LegacyProjectAdapter(project)
                self.assertIs(store.project, project)
                self.assertIs(store.get_segments('main'), project['segments'])
                self.assertIs(store.get_legacy_overlay_track(), project.get('overlay_track'))
                for track in store.tracks():
                    self.assertIs(track.segments, track.source['segments'])
                    with self.assertRaises(FrozenInstanceError):
                        track.id = 'changed'
                    for segment in track.segments:
                        if 'id' not in segment:
                            continue
                        found = store.resolve(dict(track_id=track.id, segment_id=segment['id']))
                        self.assertIs(found.segment, segment)
                        self.assertIs(found.track.source, track.source)
                        self.assertIs(found.track.segments[found.index], segment)
                self.assertEqual(json.loads(json.dumps(store.project)), before)
                self.assertEqual(project, before)
                self.assertEqual(python_outputs(store.project), python_outputs(before))

    def test_reserved_ids_disabled_tracks_and_live_metadata(self):
        project = json.loads((FIXTURES / 'three-tracks.input.json').read_text())
        project['multi_subtitle']['enabled'] = False
        project['overlay_track']['enabled'] = False
        project['multi_subtitle']['tracks'][0]['id'] = 'main'
        project['multi_subtitle']['tracks'].append(dict(id='overlay', segments=[dict(id='shared')]))
        store = LegacyProjectAdapter(project)
        self.assertEqual([track.id for track in store.tracks()], ['main', 'secondary:main', 'secondary:overlay', 'overlay'])
        for legacy_id in ('main', 'overlay'):
            track = store.get_track(secondary_track_id(legacy_id))
            self.assertIs(track.source, store.get_legacy_extension_track(legacy_id))
            self.assertFalse(track.enabled)
        for track_id, source in [('main', project), ('secondary:main', project['multi_subtitle']['tracks'][0]), ('overlay', project['overlay_track'])]:
            self.assertIs(store.resolve(dict(track_id=track_id, segment_id='shared')).segment, source['segments'][0])
        overlay = store.get_track('overlay')
        self.assertFalse(overlay.enabled)
        project['overlay_track']['enabled'] = True
        self.assertTrue(overlay.enabled)
        self.assertIsNone(store.get_legacy_extension_track('missing'))

    def test_resolve_after_reorder_delete_transfer_restore_and_project_switch(self):
        project = json.loads((FIXTURES / 'three-tracks.input.json').read_text())
        store = LegacyProjectAdapter(lambda: project)
        ref = dict(track_id='main', segment_id='shared')
        original = project['segments'][0]
        project['segments'].insert(0, dict(id='unbound'))
        self.assertEqual(store.resolve(ref).index, 1)
        self.assertIs(store.resolve(ref).segment, original)
        project['segments'].pop(1)
        self.assertIsNone(store.resolve(ref))
        project['overlay_track']['segments'] = [original]
        self.assertIs(store.resolve(dict(track_id='overlay', segment_id='shared')).segment, original)
        project['segments'] = [dict(original, text='restored object')]
        self.assertIs(store.resolve(ref).segment, project['segments'][0])
        self.assertIsNot(store.resolve(ref).segment, original)
        project = json.loads((FIXTURES / 'unbound-secondary.input.json').read_text())
        self.assertIsNone(store.resolve(ref))
        self.assertIs(store.get_segments('main'), project['segments'])
        self.assertIs(store.resolve(dict(track_id='secondary:translation', segment_id='unbound')).segment,
                      project['multi_subtitle']['tracks'][0]['segments'][1])

    def test_unknown_malformed_and_ambiguous_refs_fail_closed(self):
        project = json.loads((FIXTURES / 'three-tracks.input.json').read_text())
        store = LegacyProjectAdapter(project)
        for ref in (None, {}, dict(track_id=1, segment_id='shared'), dict(track_id='main', segment_id=''),
                    dict(track_id='missing', segment_id='shared'), dict(track_id='main', segment_id='missing')):
            self.assertIsNone(store.resolve(ref))
        self.assertIsNone(store.get_segments('missing'))
        project['segments'].append(dict(project['segments'][0]))
        self.assertIsNone(store.resolve(dict(track_id='main', segment_id='shared')))
        project['multi_subtitle']['tracks'].append(dict(project['multi_subtitle']['tracks'][0]))
        self.assertIsNone(store.get_track('secondary:translation'))


    def test_shared_js_python_enumeration_contract(self):
        contract = json.loads((FIXTURES / 'read-contract.json').read_text())
        self.assertEqual(sorted(contract), sorted(path.name.removesuffix('.input.json') for path in FIXTURES.glob('*.input.json')))
        for name, expected in contract.items():
            with self.subTest(fixture=name):
                store = LegacyProjectAdapter(json.loads((FIXTURES / f'{name}.input.json').read_text()))
                actual = [dict(id=track.id, role=track.role, legacy_id=track.legacy_id,
                               enabled=track.enabled, segment_ids=[s.get('id') for s in track.segments])
                          for track in store.tracks()]
                self.assertEqual(actual, expected)
