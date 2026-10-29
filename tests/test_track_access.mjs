import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { loadEditorModule } from './helpers/editor-module-loader.mjs';
import { fixtureNames, fixtureRoot, readFixture, createProjectHarness, browserOutputs } from './helpers/track-golden.mjs';
const context = { window: {} };
loadEditorModule(context, 'shared/editor-utils.js');
const api = context.window.MAWE.resolve('project-tracks');
const { LegacyProjectAdapter, secondaryTrackId } = api;
const plain = value => JSON.parse(JSON.stringify(value));

for (const name of fixtureNames) {
  test(`TrackStore preserves every raw v1 field and reference: ${name}`, () => {
    const project = readFixture(name), before = structuredClone(project);
    const store = new LegacyProjectAdapter(project);
    assert.equal(store.project, project);
    assert.deepEqual(plain(store.project), before, 'raw v1 → read runtime → raw v1');
    assert.equal(store.getSegments('main'), project.segments);
    assert.equal(store.getLegacyOverlayTrack(), project.overlay_track);
    const secondary = project.multi_subtitle?.tracks[0];
    assert.equal(store.getLegacyExtensionTrack(), secondary || null);
    const expectedRoles = ['main', ...(secondary ? ['secondary'] : []), ...(project.overlay_track ? ['overlay'] : [])];
    assert.deepEqual(plain(store.tracks().map(track => track.role)), expectedRoles);
    for (const track of store.tracks()) {
      assert.equal(track.segments, track.source.segments);
      assert.ok(Object.isFrozen(track));
      for (const segment of track.segments) {
        if (!segment.id) continue; // legacy IDs are supplied at the existing load boundary, never by reads
        const found = store.resolve({ track_id: track.id, segment_id: segment.id });
        assert.equal(found.segment, segment);
        assert.equal(found.track.source, track.source);
        assert.equal(found.track.segments[found.index], segment);
      }
    }
    assert.deepEqual(project, before, 'enumeration and resolution add no IDs/schema/keys and preserve unknown nested fields');
    assert.deepEqual(browserOutputs(store.project), browserOutputs(before), 'old output projection is unaffected by reads');
  });
}

test('main/secondary/overlay same cue IDs resolve independently; reserved legacy track IDs cannot collide', () => {
  const project = readFixture('three-tracks');
  project.multi_subtitle.enabled = false;
  project.overlay_track.enabled = false;
  project.multi_subtitle.tracks[0].id = 'main';
  project.multi_subtitle.tracks.push({ id: 'overlay', segments: [{ id: 'shared', text: 'inactive stored track' }] });
  const store = new LegacyProjectAdapter(project);
  assert.deepEqual(plain(store.tracks().map(t => t.id)), ['main', 'secondary:main', 'secondary:overlay', 'overlay']);
  for (const id of ['main', 'overlay']) {
    assert.equal(store.getTrack(secondaryTrackId(id)).source, store.getLegacyExtensionTrack(id));
    assert.equal(store.getTrack(secondaryTrackId(id)).enabled, false);
  }
  assert.equal(store.getTrack('overlay').enabled, false);
  assert.equal(store.resolve({ track_id: 'main', segment_id: 'shared' }).segment, project.segments[0]);
  assert.equal(store.resolve({ track_id: 'overlay', segment_id: 'shared' }).segment, project.overlay_track.segments[0]);
  assert.equal(store.resolve({ track_id: 'secondary:main', segment_id: 'shared' }).segment, project.multi_subtitle.tracks[0].segments[0]);
  assert.equal(store.getLegacyExtensionTrack('missing'), null);
  const view = store.getTrack('overlay');
  project.overlay_track.enabled = true;
  assert.equal(view.enabled, true);
});

test('resolve uses current identity after reorder, deletion, transfer, restore and project replacement', () => {
  let project = readFixture('three-tracks');
  const store = new LegacyProjectAdapter(() => project);
  const ref = { track_id: 'main', segment_id: 'shared' }, original = project.segments[0];
  const unbound = { id: 'unbound', text: 'added' };
  project.segments.unshift(unbound);
  assert.equal(store.resolve(ref).index, 1);
  assert.equal(store.resolve(ref).segment, original);
  project.segments.splice(1, 1);
  assert.equal(store.resolve(ref), null);
  project.overlay_track.segments = [original];
  assert.equal(store.resolve({ ...ref, track_id: 'overlay' }).segment, original);
  project.segments = [{ ...original, text: 'restored object' }];
  assert.equal(store.resolve(ref).segment, project.segments[0]);
  assert.notEqual(store.resolve(ref).segment, original);
  project = readFixture('unbound-secondary');
  assert.equal(store.resolve(ref), null);
  assert.equal(store.getSegments('main'), project.segments);
  assert.equal(store.resolve({ track_id: 'secondary:translation', segment_id: 'unbound' }).segment, project.multi_subtitle.tracks[0].segments[1]);
});

test('unknown, malformed and ambiguous CueRefs fail closed without repairing input', () => {
  const project = readFixture('three-tracks');
  const store = new LegacyProjectAdapter(project);
  for (const ref of [null, {}, { track_id: 1, segment_id: 'shared' }, { track_id: 'main', segment_id: '' },
    { track_id: 'missing', segment_id: 'shared' }, { track_id: 'main', segment_id: 'missing' }]) {
    assert.equal(store.resolve(ref), null);
  }
  assert.equal(store.getSegments('missing'), null);
  project.segments.push({ ...project.segments[0] });
  assert.equal(store.resolve({ track_id: 'main', segment_id: 'shared' }), null);
  project.multi_subtitle.tracks.push({ ...project.multi_subtitle.tracks[0] });
  assert.equal(store.getTrack('secondary:translation'), null);
});

test('production getters proxy the same live project objects after load/restore', () => {
  const { data, context, h } = createProjectHarness(readFixture('three-tracks'));
  const legacy = context.MaweMultiSubtitleCore;
  const beforeReads = plain(data);
  const store = legacy.getTrackStore();
  store.tracks();
  assert.deepEqual(plain(data), beforeReads, 'pure accessor never normalizes/creates legacy state');
  assert.equal(legacy.getActiveExtensionTrack(), h.getExtensionTrack(data));
  assert.equal(legacy.getExtensionTrack('translation'), store.getTrack('translation').source);
  assert.equal(context.MAWE.resolve('overlay-track').getOverlayTrack(), store.getTrack('overlay').source);
  assert.equal(store.getSegments('main'), h.getMainTrack(data).segments);
  context.MaweBoot.DATA = h.importProject(readFixture('unbound-secondary')).project;
  const restored = legacy.getExtensionTrack('translation');
  assert.equal(legacy.getTrackStore(), store);
  assert.equal(restored, store.getTrack('translation').source);
  assert.equal(store.getSegments('main'), h.getMainTrack(context.MaweBoot.DATA).segments);
  assert.equal(context.MAWE.resolve('overlay-track').getOverlayTrack(), h.getOverlayTrack(context.MaweBoot.DATA));
});


test('JS and Python share the same explicit v1 track enumeration contract', () => {
  const contract = JSON.parse(fs.readFileSync(new URL('read-contract.json', fixtureRoot), 'utf8'));
  assert.deepEqual(Object.keys(contract).sort(), fixtureNames);
  for (const [name, expected] of Object.entries(contract)) {
    const store = new LegacyProjectAdapter(readFixture(name));
    const actual = store.tracks().map(track => ({ id: track.id, role: track.role,
      legacy_id: track.legacyId, enabled: track.enabled, segment_ids: track.segments.map(s => s.id ?? null) }));
    assert.deepEqual(plain(actual), expected, name);
  }
});

test('ESM overlay getter and TrackStore follow import and container replacement', () => {
  const { context, h } = createProjectHarness(readFixture('three-tracks'));
  const core = context.MaweMultiSubtitleCore;
  const store = core.getTrackStore();
  const overlay = context.MAWE.resolve('overlay-track');
  const ref = { track_id: 'overlay', segment_id: 'replacement' };
  const legacy = readFixture('three-tracks');
  const incoming = { enabled: false, segments: [{ id: ref.segment_id, start: 0, end: 1000, text: 'replacement' }] };
  legacy.overlay_track = incoming;
  context.MaweBoot.DATA = legacy;
  const beforeReads = plain(legacy);
  assert.equal(store.getTrack('overlay').source, incoming);
  assert.deepEqual(plain(legacy), beforeReads, 'adapter reads do not modify the project');
  const data = h.importProject(legacy).project;
  context.MaweBoot.DATA = data;
  const normalized = overlay.getOverlayTrack();
  assert.notEqual(normalized, incoming, 'import replaces the legacy overlay container');
  assert.equal(normalized, h.getOverlayTrack(data));
  assert.equal(store.getTrack('overlay').source, normalized);
  assert.equal(store.resolve(ref).segment, normalized.segments[0]);
  assert.equal(store.resolve({ track_id: 'overlay', segment_id: 'shared' }), null);
  const replacement = { ...normalized, segments: [{ ...normalized.segments[0] }] };
  data.tracks[data.tracks.indexOf(normalized)] = replacement;
  assert.equal(overlay.getOverlayTrack(), replacement);
  assert.equal(store.getSegments('overlay'), replacement.segments);
  assert.equal(store.resolve(ref).segment, replacement.segments[0]);
});
