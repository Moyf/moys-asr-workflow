import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../web/shared/utils/project-tracks.js', import.meta.url), 'utf8');
const model = (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).createUtilsModule();
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

test('legacy implicit binding identities resolve without overwriting reserved explicit IDs', () => {
  const input = fixture('legacy-implicit-ids.input');
  const before = json(input);
  const project = model.importProject(input).project;
  assert.deepEqual(project, fixture('legacy-implicit-ids.expected'));
  assert.deepEqual(input, before);
  assert.deepEqual(model.importProject(project), { project, changes: [] });
  project.bindings[0].source_segment_ids = ['main-001-generated'];
  rejects(project, '$.bindings[0].source_segment_ids');
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

for (const name of ['v2-cross-track', 'reserved-ids']) test(`shared ${name} migration is exact and idempotent`, () => {
  const input = fixture(`${name}.input`); const before = json(input);
  const { project } = model.importProject(input);
  assert.deepEqual(project, fixture(`${name}.expected`));
  assert.deepEqual(input, before);
  assert.deepEqual(model.importProject(project), { project, changes: [] });
});
for (const example of fixture('invalid')) test(`shared invalid case: ${example.name}`, () => rejects(example.input, example.error_path));

test('v2 whitespace identities normalize while canonical v3 identities remain strict', () => {
  const legacy = fixture('v2-cross-track.input'); legacy.segments[0].id = ' source ';
  legacy.multi_subtitle.bindings[0].track_id = ' fr ';
  assert.equal(model.importProject(legacy).project.tracks[0].segments[0].id, 'source');
  const current = canonical(); current.tracks[0].segments[0].id = ' cue-main ';
  rejects(current, '$.tracks[0].segments[0].id');
});

test('opaque Unicode IDs count characters consistently across Python and JavaScript', () => {
  const input = { segments: [], multi_subtitle: { tracks: [{ id: '😀'.repeat(160), segments: [{ start: 0, end: 10, text: 'A' }] }] } };
  const project = model.importProject(input).project;
  assert.equal(Array.from(project.tracks[1].id).length, 160);
  assert.equal(Array.from(project.tracks[1].segments[0].id).length, 150);
});

test('opaque IDs with colons cannot collide in binding uniqueness keys', () => {
  const project = model.migrateProjectTracks({ segments: [{ id: 'c', start: 0, end: 10, text: 'A' }, { id: 'b:c', start: 10, end: 20, text: 'B' }] });
  for (const [targetId, sourceId, cueId, start] of [['a:b', 'c', 'target-one', 0], ['a', 'b:c', 'target-two', 10]]) {
    project.tracks.push({ id: targetId, role: 'extension', name: targetId, enabled: true, segments: [{ id: cueId, start, end: start + 10, text: targetId }] });
    project.bindings.push({ id: `binding-${targetId}`, source_track_id: 'main', target_track_id: targetId,
      source_segment_ids: [sourceId], target_segment_ids: [cueId], start_offset_ms: 0, end_offset_ms: 0 });
  }
  project.bilingual.active_track_id = 'a:b';
  assert.equal(model.validateTracksProject(project).ok, true);
});

test('legacy optional nulls retain original defaults without swallowing conflicting metadata', () => {
  const project = model.importProject({ segments: [], overlay_track: null,
    multi_subtitle: { schema: null, enabled: null, display_mode: null, main_split_mode: null, bindings: null, tracks: [{ role: null, split_mode: null, segments: null }] } }).project;
  assert.equal(project.tracks[1].split_mode, 'word');
  assert.equal(Object.hasOwn(project.tracks[0], 'split_mode_override'), false);
  assert.equal(project.bilingual.display_mode, 'both');
  rejects({ segments: [], multi_subtitle: { tracks: [{ name: null }] } }, '$.multi_subtitle.tracks[0].name');
});

test('legacy ASS normalization preserves unknown fields while canonical import stays read-only', () => {
  const input = fixture('legacy-ass-normalization.input');
  const before = json(input);
  assert.deepEqual(model.importProject(input).project, fixture('legacy-ass-normalization.expected'));
  assert.deepEqual(input, before);
  const v2 = { ...input, schema: 'moy.asr.project.v2', subtitle_groups: { next_id: 1, color: [], sticker: [] } };
  assert.deepEqual(model.importProject(v2).project, fixture('legacy-ass-normalization.expected'));
  const v3 = fixture('legacy-ass-normalization.expected');
  v3.tracks[0].segments[0].assOverride.scale = 1.004;
  v3.tracks[0].segments[1].assOverride.scale = 1.234;
  v3.tracks[0].segments[2].assOverride = {};
  assert.deepEqual(model.importProject(v3), { project: v3, changes: [] });
});

test('only legacy ASS failures use the original input container paths', () => {
  const invalid = { start: 0, end: 10, text: 'A', assOverride: { scale: 6 } };
  for (const schema of ['moy.asr.project.v1', 'moy.asr.project.v2']) {
    const root = { schema, segments: [{ id: 'bad', ...invalid }] };
    if (schema.endsWith('v2')) root.subtitle_groups = { next_id: 1, color: [], sticker: [] };
    rejects(root, '$.segments[0].assOverride.scale');
    rejects({ ...root, segments: [], overlay_track: { segments: [{ id: 'bad', ...invalid }] } }, '$.overlay_track.segments[0].assOverride.scale');
    rejects({ ...root, segments: [], multi_subtitle: { tracks: [{ segments: [{ id: 'bad', ...invalid }] }] } }, '$.multi_subtitle.tracks[0].segments[0].assOverride.scale');
  }
  const v3 = canonical(); v3.tracks[0].segments[0].assOverride = { scale: 6 };
  rejects(v3, '$.tracks[0].segments[0].assOverride.scale');
});

test('legacy import reports independent metadata, cue, group and binding shape paths together', () => {
  const input = { timebase: { unit: 'seconds', fps: 0 }, segments: [
    { start: -1, end: 0, text: 42, color_ref: { headIdx: 5 } },
  ], multi_subtitle: { tracks: [{ language_source: 'bad', segments: [] }], bindings: [{ main_segment_ids: [], extension_segment_ids: [] }] } };
  const before = json(input);
  assert.throws(() => model.importProject(input), error => {
    const paths = new Set(error.errors.map(entry => entry.path));
    for (const path of ['$.timebase.unit', '$.timebase.fps', '$.tracks[0].segments[0].start', '$.tracks[0].segments[0].text',
      '$.tracks.main.segments[0].color_ref', '$.tracks[1].language_source', '$.multi_subtitle.bindings[0].main_segment_ids',
      '$.multi_subtitle.bindings[0].extension_segment_ids']) assert.ok(paths.has(path), path);
    return true;
  });
  assert.deepEqual(input, before);
});

test('new producers construct canonical projects without a temporary legacy tree', () => {
  const input = [{ start: 0, end: 1000, text: 'generated', metadata: { keep: false } },
    { id: 'custom-cue-1', start: 1000, end: 2000, text: 'reserved' }];
  const before = json(input);
  const project = model.makeProject(input, { mainFields: { id: 'custom', language: 'en' }, projectFields: { media: 'clip.mp4', vendor: [] } });
  assert.equal(project.schema, 'moy.asr.project.v3');
  assert.deepEqual(project.tracks[0].segments.map(cue => cue.id), ['custom-cue-1-2', 'custom-cue-1']);
  assert.deepEqual(input, before);
  assert.equal(Object.hasOwn(project, 'segments'), false);
  assert.equal(Object.hasOwn(project, 'language'), false);
  assert.throws(() => model.makeProject([], { projectFields: { tracks: [] } }), model.ProjectTracksError);
  const invalid = [{ id: 'bad', start: 0, end: 10, text: 'A' }, { id: 'bad', start: 10, end: 20, text: 'B' }];
  assert.throws(() => model.makeProject(invalid), model.ProjectTracksError);
});
