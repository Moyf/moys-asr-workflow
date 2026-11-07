import assert from 'node:assert/strict';
import test from 'node:test';
import { TrackPolicy } from '../web/shared/utils/track-policy.js';

const { isTrackEnabled, selectTracks, unsupportedVariant } = TrackPolicy;

test('track surfaces apply independent gates and preserve unsupported variants', () => {
  for (const enabled of [true, false]) for (const preview of [undefined, true, false]) for (const exported of [undefined, true, false]) {
    const track = { role: 'overlay', enabled, preview_visible: preview, export: { enabled: exported } };
    assert.equal(isTrackEnabled(track, 'preview'), enabled && preview !== false);
    assert.equal(isTrackEnabled(track, 'export'), enabled && exported !== false);
  }
  const unknown = { role: 'overlay', enabled: true, variant: 'future', data: { keep: true } };
  assert.equal(unsupportedVariant(unknown), true);
  assert.equal(isTrackEnabled(unknown, 'preview'), false);
  assert.equal(isTrackEnabled(unknown, 'export'), false);
  assert.deepEqual(unknown.data, { keep: true });
  assert.equal(unsupportedVariant({ role: 'overlay' }), false);
  assert.throws(() => isTrackEnabled(unknown, 'bogus'));
});

test('ordinary selection includes main and overlay; secondary requires explicit selection', () => {
  const main = { id: 'm', role: 'main', enabled: true };
  const overlay = { id: 'o', role: 'overlay', enabled: true, preview_visible: false };
  const secondary = { id: 's', role: 'secondary', enabled: true, export: { enabled: false } };
  const project = { tracks: [main, overlay, secondary], bilingual: { active_track_id: 's' } };
  assert.deepEqual(selectTracks(project), [main, overlay]);
  assert.deepEqual(selectTracks(project, 'all', 'preview'), [main, secondary]);
  assert.deepEqual(selectTracks(project, 'extension', 'export'), []);
  overlay.variant = 'future';
  assert.deepEqual(selectTracks(project), [main]);
});
test('export diagnostics apply only to selected enabled overlay', () => {
  const overlay = { id: 'o', role: 'overlay', name: 'future track', enabled: true, variant: 'future' };
  const project = { tracks: [overlay] };
  assert.throws(() => TrackPolicy.assertExportable(project, 'main'), /future track.*future/);
  assert.throws(() => TrackPolicy.assertExportable(project, 'all'), /future/);
  assert.doesNotThrow(() => TrackPolicy.assertExportable(project, 'extension'));
  assert.doesNotThrow(() => TrackPolicy.assertExportable(project, 'main', { includeOverlay: false }));
  overlay.export = { enabled: false };
  assert.doesNotThrow(() => TrackPolicy.assertExportable(project));
  overlay.export.enabled = true;
  overlay.enabled = false;
  assert.doesNotThrow(() => TrackPolicy.assertExportable(project));
});
