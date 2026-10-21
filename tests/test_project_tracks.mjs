import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../web/shared/utils/project-tracks.js', import.meta.url), 'utf8');
const model = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/project-tracks/${name}.json`, import.meta.url), 'utf8'));
const canonical = () => fixture('canonical');
const json = value => JSON.parse(JSON.stringify(value));
function rejects(raw, path) {
  const before = json(raw);
  assert.throws(() => model.importProject(raw), error => error instanceof model.ProjectTracksError
    && error.errors.some(entry => entry.path === path), path);
  assert.deepEqual(raw, before);
}

test('canonical import is an independent, lossless and idempotent snapshot', () => {
  const input = canonical();
  const before = json(input);
  const result = model.importProject(input);
  assert.deepEqual(result, { project: before, changes: [] });
  result.project.tracks[0].segments[0].text = 'independent';
  assert.deepEqual(input, before);
  assert.deepEqual(model.importProject(input).project, model.importProject(model.importProject(input).project).project);
});

test('v1 three shapes migrate to the shared exact canonical fixture without metadata loss', () => {
  const input = fixture('legacy-three-tracks.input');
  const before = json(input);
  const { project, changes } = model.importProject(input);
  assert.deepEqual(project, fixture('legacy-three-tracks.expected'));
  assert.deepEqual(input, before);
  assert.ok(changes.some(change => change.path === '$.tracks' && change.kind === 'add'));
  assert.deepEqual(model.importProject(project), { project, changes: [] });
  for (const field of ['segments', 'multi_subtitle', 'overlay_track', 'language', 'split_mode']) assert.equal(Object.hasOwn(project, field), false);
});

test('missing legacy IDs reserve all explicit identities before generation', () => {
  const input = { segments: [{ start: 0, end: 1000, text: 'new' }, { id: 'main-cue-1', start: 1000, end: 2000, text: 'reserved' }],
    multi_subtitle: { tracks: [{ id: 'main', segments: [{ start: 0, end: 1000, text: 'translation' }] }] } };
  const project = model.migrateProjectTracks(input);
  assert.equal(project.tracks[0].id, 'main-2');
  assert.deepEqual(project.tracks[0].segments.map(cue => cue.id), ['main-2-cue-1', 'main-cue-1']);
  assert.equal(project.tracks[1].id, 'main');
  assert.equal(project.tracks[1].segments[0].id, 'main-cue-1-2');
});

test('legacy ID generation remains bounded for a maximum-length track ID', () => {
  const project = model.migrateProjectTracks({ segments: [], multi_subtitle: { tracks: [{ id: 'x'.repeat(160), segments: [{ start: 0, end: 10, text: 'new', color: { name: 'red' } }] }] } });
  assert.ok(project.tracks[1].segments[0].id.length <= 160);
  assert.ok(project.subtitle_groups.color[0].id.length <= 160);
});

test('v2 groups and IDs survive migration including cross-track membership', () => {
  const current = canonical();
  const main = current.tracks[0]; const extension = current.tracks[1];
  const raw = { schema: 'moy.asr.project.v2', media: current.media, language: main.language,
    segments: main.segments, subtitle_groups: current.subtitle_groups,
    multi_subtitle: { enabled: true, tracks: [extension], bindings: [{ id: 'binding-1', track_id: extension.id,
      main_segment_ids: ['cue-main'], extension_segment_ids: ['cue-en'], start_offset_ms: 50, end_offset_ms: 50 }] } };
  const before = json(raw);
  const migrated = model.importProject(raw).project;
  assert.deepEqual(migrated.subtitle_groups, current.subtitle_groups);
  assert.deepEqual(migrated.tracks.flatMap(track => track.segments.map(cue => cue.id)), ['cue-main', 'cue-en']);
  assert.deepEqual(raw, before);
});

test('unknown/future schemas and mixed containers fail before any migration', () => {
  rejects({ schema: 'moy.asr.project.v4', segments: [] }, '$.schema');
  rejects({ schema: null, segments: [] }, '$.schema');
  rejects({ ...canonical(), segments: [] }, '$.segments');
  rejects({ segments: [], tracks: [] }, '$.tracks');
});

test('invalid canonical track structures fail with paths instead of throwing internal TypeErrors', () => {
  for (const tracks of [null, [null], [], [canonical().tracks[0], { ...canonical().tracks[0], id: 'other' }]]) {
    rejects({ ...canonical(), tracks }, '$.tracks');
  }
  const wrongRole = canonical(); wrongRole.tracks[0].role = 'video';
  rejects(wrongRole, '$.tracks[0].role');
  const disabledMain = canonical(); disabledMain.tracks[0].enabled = false;
  rejects(disabledMain, '$.tracks[0].enabled');
});

test('duplicate cue IDs are repaired only for valid cross-track v1 identities', () => {
  const legacy = fixture('legacy-three-tracks.input');
  legacy.segments[1].id = legacy.segments[0].id;
  rejects(legacy, '$.tracks[0].segments[1].id');
  const v3 = canonical(); v3.tracks[1].segments[0].id = v3.tracks[0].segments[0].id;
  rejects(v3, '$.tracks[1].segments[0].id');
});

test('dangling active track, binding endpoint, group and explicit wrong offsets fail', () => {
  const active = canonical(); active.bilingual.active_track_id = 'overlay';
  rejects(active, '$.bilingual.active_track_id');
  const binding = canonical(); binding.bindings[0].target_segment_ids = ['absent'];
  rejects(binding, '$.bindings[0].target_segment_ids');
  const group = canonical(); group.tracks[0].segments[0].color_group_id = 'absent';
  rejects(group, '$.tracks[0].segments[0].color_group_id');
  const offset = canonical(); offset.bindings[0].start_offset_ms = 0;
  rejects(offset, '$.bindings[0].start_offset_ms');
});

test('a main cue may bind independently to multiple translation tracks', () => {
  const project = canonical();
  project.tracks.push({ ...json(project.tracks[1]), id: 'translation-fr', segments: [{ id: 'cue-fr', start: 1300, end: 2400, text: 'Bonjour' }] });
  project.bindings.push({ ...json(project.bindings[0]), id: 'binding-fr', target_track_id: 'translation-fr', target_segment_ids: ['cue-fr'], start_offset_ms: 100, end_offset_ms: 100 });
  assert.equal(model.validateTracksProject(project).ok, true);
  project.bindings.push({ ...json(project.bindings[0]), id: 'duplicate-binding' });
  rejects(project, '$.bindings[2].source_segment_ids');
});

test('bad legacy head references are rejected rather than degraded to default groups', () => {
  const raw = fixture('legacy-three-tracks.input'); raw.segments[1].color_ref.headIdx = 10;
  rejects(raw, '$.tracks.main.segments[1].color_ref');
});

test('integer cue and item timing validation retains zero-duration punctuation', () => {
  const good = canonical(); good.tracks[0].segments[0].items.push({ start: 2300, end: 2300, text: '。' });
  assert.equal(model.validateTracksProject(good).ok, true);
  const bad = canonical(); bad.tracks[0].segments[0].items[0].end = 2400;
  rejects(bad, '$.tracks[0].segments[0].items[0].end');
});

test('selectors return original entities and export selection never deletes hidden data', () => {
  const project = canonical();
  assert.equal(model.getMainTrack(project), project.tracks[0]);
  assert.equal(model.getTrack(project, 'translation-en'), project.tracks[1]);
  assert.deepEqual([...model.iterSegments(project)], [project.tracks[0].segments[0], project.tracks[1].segments[0]]);
  assert.deepEqual(model.selectSubtitleTracks(project, { subtitleTracks: 'all' }), project.tracks.slice(0, 2));
  project.tracks[1].enabled = false;
  assert.deepEqual(model.selectSubtitleTracks(project, { subtitleTracks: 'main_and_extension' }), [project.tracks[0]]);
  assert.equal(project.tracks[1].segments.length, 1);
});

test('checkpoint snapshots include all persistent content and exclude known derived caches and highlights', () => {
  const project = canonical(); project.waveform = { samples: [1] }; project.tracks[0].segments[0]._dirty = true;
  const snapshot = model.snapshotProjectContent(project);
  assert.equal(Object.hasOwn(snapshot, 'waveform'), false);
  assert.equal(Object.hasOwn(snapshot.tracks[0].segments[0], '_dirty'), false);
  assert.deepEqual(snapshot.bindings, project.bindings);
  assert.deepEqual(snapshot.subtitle_groups, project.subtitle_groups);
  assert.equal(project.tracks[0].segments[0]._dirty, true);
});
