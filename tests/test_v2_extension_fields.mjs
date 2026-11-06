import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectHarness } from './helpers/track-golden.mjs';

const plain = value => JSON.parse(JSON.stringify(value));
function projectWithExtensions() {
  return {
    schema: 'moy.asr.project.v2',
    tracks: [{ id: 'main', role: 'main', name: 'Main', enabled: true,
      segments: [{ id: 'cue', start: 0, end: 1000, text: 'test' }] }],
    bilingual: { display_mode: 'both' }, bindings: [],
    subtitle_groups: { next_id: 1, color: [], sticker: [] },
    timebase: { unit: 'milliseconds', fps: 30, vendor: { flag: false, zero: 0, list: [], object: {} } },
    markers: { schema: 'moy.asr.markers.v1', vendor: { flag: false, zero: 0, list: [], object: {} }, items: [
      { id: 'later', start: 400, end: 500, name: 'later', color: '#3e63dd', note: '', vendor: { flag: false, zero: 0, list: [], object: {} }, _inputIndex: 'vendor' },
      { id: 'earlier', start: 100, name: 'earlier', color: '#3e63dd', note: '', review: { status: 'pending', reason: 'check', vendor: { flag: false } } },
    ] },
  };
}

function openAndSave(input) {
  const { data, h, context, save } = createProjectHarness(input);
  // The real startup/import paths capture the wrapper before replacing it with the editable array.
  context.MaweJsonRepair.setMarkerContainer(data.markers);
  data.markers = h.normalizeMarkers(data.markers);
  return { data, h, context, saved: save() };
}

test('v2 timebase and marker extension fields survive editor normalization, save and reopen', () => {
  const source = projectWithExtensions();
  const before = structuredClone(source);
  const { saved } = openAndSave(source);
  assert.deepEqual(source, before);
  assert.deepEqual(saved.timebase, source.timebase);
  assert.deepEqual(saved.markers.vendor, source.markers.vendor);
  assert.deepEqual(saved.markers.items.map(item => item.id), ['earlier', 'later']);
  assert.deepEqual(saved.markers.items[0].review.vendor, { flag: false });
  assert.deepEqual(saved.markers.items[1].vendor, source.markers.items[0].vendor);
  assert.equal(saved.markers.items[1]._inputIndex, 'vendor');
  const reopened = openAndSave(saved).saved;
  assert.deepEqual(reopened.timebase, saved.timebase);
  assert.deepEqual(reopened.markers, saved.markers);
});

test('known normalization remains authoritative while empty wrapper extensions survive', () => {
  const input = projectWithExtensions();
  input.timebase.fps = 400;
  // Standalone utility normalization retains the existing FPS clamp.
  const { h, context } = createProjectHarness(projectWithExtensions());
  assert.deepEqual(plain(h.normalizeTimelineTimebase(input.timebase)), { ...input.timebase, fps: 240 });
  assert.throws(() => h.normalizeTimelineTimebase({ fps_source: false }), /fps_source/);
  const normalized = h.normalizeMarkers({ schema: 'moy.asr.markers.v1', items: [
    { id: '', start: 2, end: 1, color: 'invalid', review: { status: 'invalid', reason: '  reason  ', extra: 0 }, vendor: false },
  ] });
  assert.equal(normalized[0].id, 'marker-001');
  assert.equal(normalized[0].color, '#3e63dd');
  assert.equal(normalized[0].end, undefined);
  assert.deepEqual(plain(normalized[0].review), { status: 'pending', reason: 'reason', extra: 0 });
  assert.equal(normalized[0].vendor, false);
  assert.equal(h.markersToProjectField([]), null);
  assert.equal(h.markersToProjectField({ items: 'invalid', vendor: false }), null);
  const empty = plain(h.markersToProjectField([], { schema: 'old', items: [], vendor: { zero: 0 } }));
  assert.deepEqual(empty, { schema: 'moy.asr.markers.v1', items: [], vendor: { zero: 0 } });
  context.MaweJsonRepair.setMarkerContainer({ schema: 'moy.asr.markers.v1', items: [], vendor: { zero: 0 } });
  context.MaweBoot.DATA.markers = [];
  assert.deepEqual(plain(context.MaweJsonRepair.projectSnapshot().markers), empty);
  context.MaweJsonRepair.setMarkerContainer(null);
  assert.equal(context.MaweJsonRepair.projectSnapshot().markers, undefined);
});

test('marker AI extensions survive while invalid known AI data is still omitted', () => {
  const { h } = createProjectHarness(projectWithExtensions());
  const ai = { schema: 'maw.ai-annotation.v1', task: 'review', run_id: 'a'.repeat(32), key: 'b'.repeat(64),
    vendor: { enabled: false }, generated: { start: 0, end: 1, name: 'x', color: '#3e63dd', note: '', review: null,
      vendor: { list: [], zero: 0 } } };
  const markers = h.normalizeMarkers([{ start: 0, ai }, { start: 1, ai: { ...ai, key: 'bad' } }]);
  assert.deepEqual(plain(markers[0].ai.vendor), ai.vendor);
  assert.deepEqual(plain(markers[0].ai.generated.vendor), ai.generated.vendor);
  assert.equal(markers[1].ai, undefined);
});
