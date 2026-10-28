import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { loadEditorModule } from './helpers/editor-module-loader.mjs';
const context = { window: {} };
loadEditorModule(context, 'shared/editor-utils.js');
const u = context.window.AsrEditorUtils;
const plain = value => JSON.parse(JSON.stringify(value));
function fixture() {
  return { schema: 'moy.asr.project.v1', segments: [
    { id: 'a', start: 1000, end: 3000, text: 'one', sticker: { name: 'cat', filename: 'cat.png', start: 1000, end: 3000 } },
    { id: 'b', start: 5000, end: 7000, text: 'two', sticker_ref: { name: 'cat', headIdx: 0 } },
    { id: 'c', start: 8000, end: 10000, text: 'three', sticker_ref: { name: 'cat', headIdx: 0 } },
  ], overlay_track: { enabled: true, segments: [] } };
}

test('text restructuring reserves IDs in other tracks and hidden source cues before publishing', () => {
  const p = { segments: [{ id: 'a', start: 0, end: 3000, text: '甲乙丙', items: [
    { text: '甲', start: 0, end: 1000 }, { text: '乙', start: 1000, end: 2000 },
    { text: '丙', start: 2000, end: 3000 },
  ] }], overlay_track: { enabled: true, segments: [] } };
  u.normalizeMultiSubtitleProject(p);
  p.segments = u.applyTimedTextEdit(p.segments, ['甲乙', '丙']);
  u.moveSegmentBetweenTracks(p.segments, p.overlay_track.segments, 1);
  p.multi_subtitle.tracks.push({ id: 'ext', segments: [
    { id: 'a-text-2-2', start: 0, end: 1000, text: 'hidden extension' },
  ] });
  p.segments.push({ id: 'a-text-2-3', start: 4000, end: 5000, text: 'disabled', disabled: true });
  const source = p.segments.filter(s => !s.disabled);
  const options = { reservedSegments: u.subtitleGroupTracks(p).flatMap(t => t.segments) };
  const report = u.buildTimedTextEditReport(source, ['甲', '乙'], options);
  const next = u.applyTimedTextEdit(source, ['甲', '乙'], options);
  assert.equal(report.valid, true);
  assert.deepEqual(plain(report.structure.segments), plain(next));
  assert.equal(next[0].id, 'a');
  assert.equal(next[1].id, 'a-text-2-4');
  p.segments.splice(0, 1, ...next);
  assert.doesNotThrow(() => u.normalizeMultiSubtitleProject(p));
  const saved = u.serializeSubtitleGroups(plain(p));
  const reopened = plain(saved);
  assert.doesNotThrow(() => u.migrateSubtitleGroups(reopened, { fromFile: true }));
  assert.deepEqual(plain(u.subtitleGroupTracks(reopened).flatMap(t => t.segments.map(s => s.id))),
    ['a', 'a-text-2-4', 'a-text-2-3', 'a-text-2', 'a-text-2-2']);
});
test('legacy group resolves before moving and spans gaps, late end and deletion of its former head', () => {
  const p = fixture(); u.normalizeMultiSubtitleProject(p);
  const id = p.segments[0].sticker_group_id;
  assert.ok(id); assert.equal(p.subtitle_groups.sticker.length, 1);
  assert.deepEqual(plain(u.subtitleGroupRanges(p).map(r => [r.start, r.end])), [[1000, 10000]]);
  u.moveSegmentBetweenTracks(p.segments, p.overlay_track.segments, 1);
  u.refreshSubtitleGroupViews(p);
  assert.equal(p.overlay_track.segments[0].sticker_group_id, id);
  p.segments[1].end = 12000;
  assert.equal(u.subtitleGroupRanges(p)[0].end, 12000);
  p.segments.shift(); u.refreshSubtitleGroupViews(p);
  assert.deepEqual(plain(u.subtitleGroupRanges(p).map(r => [r.id, r.start, r.end])), [[id, 5000, 12000]]);
  p.segments[0].disabled = true;
  assert.equal(u.subtitleGroupRanges(p)[0].end, 12000);
  assert.equal(u.subtitleGroupRanges(p)[0].enabled, true);
  p.overlay_track.segments[0].disabled = true;
  assert.equal(u.subtitleGroupRanges(p)[0].enabled, false);
});
test('conflicting track cue IDs remap deterministically, update bindings and never conflate equal group names', () => {
  const p = fixture();
  p.multi_subtitle = { tracks: [{ id: 'ext', segments: [{ ...plain(p.segments[0]) }] }],
    bindings: [{ track_id: 'ext', main_segment_ids: ['a'], extension_segment_ids: ['a'] }] };
  const q = plain(p); u.normalizeMultiSubtitleProject(p); u.normalizeMultiSubtitleProject(q);
  assert.deepEqual(plain(p), plain(q));
  const ext = p.multi_subtitle.tracks[0].segments[0];
  assert.notEqual(ext.id, 'a');
  assert.notEqual(ext.sticker_group_id, p.segments[0].sticker_group_id);
  assert.equal(p.multi_subtitle.bindings[0].extension_segment_ids[0], ext.id);
  assert.equal(p.subtitle_group_migration.remapped_ids.length, 1);
});
test('invalid legacy reference is rejected even when a same-name head exists', () => {
  const p = fixture(); p.segments[1].sticker_ref.headIdx = 99;
  assert.throws(() => u.migrateSubtitleGroups(p), /invalid legacy headIdx/);
  assert.equal(p.subtitle_groups, undefined);
});

test('migration preserves third-party head and per-member reference extensions', () => {
  const p = fixture();
  p.segments[0].sticker.vendor = { asset: 1 };
  p.segments[1].sticker_ref.vendor = { member: 2 };
  u.normalizeMultiSubtitleProject(p);
  const saved = u.serializeSubtitleGroups(plain(p));
  assert.deepEqual(saved.subtitle_groups.sticker[0].value.vendor, { asset: 1 });
  assert.deepEqual(saved.segments[1].sticker_group_metadata, { vendor: { member: 2 } });
});
test('canonical serialization, Python normalization and writing preserve membership without index or range truth', () => {
  const p = fixture(); u.normalizeMultiSubtitleProject(p);
  u.moveSegmentBetweenTracks(p.segments, p.overlay_track.segments, 1);
  u.refreshSubtitleGroupViews(p);
  const saved = u.serializeSubtitleGroups(plain(p));
  assert.equal(saved.schema, 'moy.asr.project.v1.5');
  assert.doesNotMatch(JSON.stringify(saved), /headIdx/);
  assert.equal(saved.subtitle_groups.sticker[0].value.start, undefined);
  const result = spawnSync(process.env.MAW_TEST_PYTHON || 'python', ['-c',
    'import sys,json; from maw.project import normalize_project; from maw.project_io import serialize_mosp; print(serialize_mosp(normalize_project(json.load(sys.stdin))))'],
    { input: JSON.stringify(saved), encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' } });
  assert.equal(result.status, 0, result.stderr.slice(0, 1500));
  const reopened = JSON.parse(result.stdout); u.normalizeMultiSubtitleProject(reopened);
  assert.equal(reopened.schema, 'moy.asr.project.v1.5');
  assert.deepEqual(plain(u.subtitleGroupRanges(reopened).map(r => [r.id, r.start, r.end])),
    plain(u.subtitleGroupRanges(p).map(r => [r.id, r.start, r.end])));
});
test('empty groups are collected and same-name assignments remain independent', () => {
  const p = fixture(); u.normalizeMultiSubtitleProject(p);
  u.clearSubtitleGroupMembers(p, p.segments, [0, 1, 2], 'sticker');
  assert.equal(p.subtitle_groups.sticker.length, 0);
  const a = u.assignSubtitleGroup(p, p.segments, [0], 'sticker', { name: 'cat' });
  const b = u.assignSubtitleGroup(p, p.segments, [1], 'sticker', { name: 'cat' });
  assert.notEqual(a, b);
  assert.equal(u.subtitleGroupRanges(p).length, 2);
});

test('canonical groups reject ambiguous identity, dangling membership, independent ranges and bad counters', () => {
  const base = fixture(); u.normalizeMultiSubtitleProject(base);
  for (const mutate of [
    p => { p.segments[1].id = p.segments[0].id; },
    p => { p.segments[1].sticker_group_id = 'missing'; },
    p => { p.subtitle_groups.sticker[0].value.start = 0; },
    p => { p.subtitle_groups.next_id = Infinity; },
  ]) {
    const p = plain(base); mutate(p);
    assert.throws(() => u.migrateSubtitleGroups(p));
  }
  const p = fixture(); p.multi_subtitle = { tracks: [], bindings: [{ main_segment_ids: ['a'] }] };
  p.segments[1].id = 'a';
  assert.throws(() => u.migrateSubtitleGroups(p), /ambiguous binding/);
});

test('v1.5 file boundary rejects legacy fields while runtime may rebuild display views', () => {
  const p = fixture(); u.normalizeMultiSubtitleProject(p);
  const saved = u.serializeSubtitleGroups(plain(p));
  assert.doesNotThrow(() => u.migrateSubtitleGroups(saved, { fromFile: true }));
  saved.segments[0].sticker_ref = { headIdx: 99 };
  assert.throws(() => u.migrateSubtitleGroups(saved, { fromFile: true }), /legacy group fields/);
  assert.doesNotThrow(() => u.migrateSubtitleGroups(p));
});

test('export creates one continuous group clip and maps Gap once across tracks', () => {
  const p = fixture(); p.media = 'synthetic.wav'; u.normalizeMultiSubtitleProject(p);
  u.moveSegmentBetweenTracks(p.segments, p.overlay_track.segments, 1);
  p.segments[1].end = 12000;
  const source = u.buildProjectExportPlan(p, { durationMs: 15000, timelineMode: 'source' });
  assert.deepEqual(plain([...source.stickers, ...source.overlayStickers].map(s => [s.startMs, s.endMs])), [[1000, 12000]]);
  p.gap_remove = { enabled: true, gaps: [{ start: 3000, end: 4000 }] };
  const mapped = u.buildProjectExportPlan(p, { durationMs: 15000, timelineMode: 'gap_removed' });
  assert.deepEqual(plain(mapped.stickers.map(s => [s.startMs, s.endMs])), [[1000, 11000]]);
  p.segments.forEach(s => { s.disabled = true; }); p.overlay_track.segments[0].disabled = true;
  const disabled = u.buildProjectExportPlan(p, { durationMs: 15000, timelineMode: 'source' });
  assert.equal(disabled.stickers.length + disabled.overlayStickers.length, 0);
});

test('disabled tracks retain groups but cannot contribute stickers to presentation or FCP XML', () => {
  const p = fixture(); p.media = 'movie.mp4';
  p.segments.forEach(s => { if (s.sticker) s.sticker.rel = 'cat.png'; });
  u.normalizeMultiSubtitleProject(p);
  const groupId = p.segments[0].sticker_group_id;
  p.overlay_track.segments.push(...p.segments.splice(1));
  p.overlay_track.enabled = false;
  p.multi_subtitle.tracks.push({ id: 'ext', segments: [
    { id: 'ext-a', start: 14000, end: 15000, text: 'extension', sticker_group_id: groupId },
  ] });
  const presentation = () => u.subtitleGroupRanges(p, 'sticker', { activeTracksOnly: true });
  assert.equal(presentation()[0].end, 3000);
  u.refreshSubtitleGroupViews(p);
  assert.equal(p.subtitle_groups.sticker.length, 1);
  assert.equal(u.subtitleGroupRanges(p)[0].end, 15000);
  p.segments[0].disabled = true;
  const plan = u.buildProjectExportPlan(p, { durationMs: 16000 });
  assert.equal(plan.stickers.length + plan.overlayStickers.length, 0);
  const xml = u.buildFcp7ExportArtifacts(plan, { fps: '30', nativeTextObjects: true, baseName: 'disabled' })[0].content;
  assert.doesNotMatch(xml, /cat\.png/);
  p.overlay_track.enabled = true;
  assert.equal(presentation()[0].end, 10000);
  assert.equal(presentation()[0].enabled, true);
  p.multi_subtitle.enabled = true;
  assert.equal(presentation()[0].end, 15000);
  assert.equal(u.subtitleGroupRanges(u.serializeSubtitleGroups(plain(p)))[0].members.length, 4);
});

test('large legacy input keeps distinct groups and deterministically remaps all cross-track collisions', () => {
  const cues = () => Array.from({ length: 1000 }, (_, index) => ({
    id: `cue-${index}`, start: index * 2000, end: index * 2000 + 1000, text: `cue ${index}`,
    ...(index % 50 === 0 ? { sticker: { name: 'same-name', rel: 'cat.png' } }
      : { sticker_ref: { name: 'same-name', headIdx: index - index % 50 } }),
  }));
  const p = { segments: cues(), overlay_track: { enabled: true, segments: cues() } };
  u.normalizeMultiSubtitleProject(p);
  const all = u.subtitleGroupTracks(p).flatMap(t => t.segments);
  assert.equal(new Set(all.map(s => s.id)).size, 2000);
  assert.equal(p.subtitle_groups.sticker.length, 40);
  assert.equal(p.subtitle_group_migration.remapped_ids.length, 1000);
  const saved = u.serializeSubtitleGroups(plain(p));
  assert.doesNotMatch(JSON.stringify(saved), /headIdx/);
  u.normalizeMultiSubtitleProject(saved);
  assert.equal(u.subtitleGroupRanges(saved).length, 40);
});


test('replacing a displayed group head keeps cross-track members while a member assignment stays independent', () => {
  for (const kind of ['color', 'sticker']) for (const track of ['main', 'overlay', 'extension']) {
    const p = fixture(); u.normalizeMultiSubtitleProject(p);
    p.multi_subtitle.tracks.push({ id: 'ext', role: 'extension', segments: [] });
    const target = track === 'main' ? p.segments : track === 'overlay'
      ? p.overlay_track.segments : p.multi_subtitle.tracks[0].segments;
    if (target !== p.segments) u.moveSegmentBetweenTracks(p.segments, target, 0);
    const selected = target[0];
    const others = u.subtitleGroupTracks(p).flatMap(t => t.segments).filter(s => s !== selected);
    const all = [selected, ...others];
    u.assignSubtitleGroup(p, all, all.map((_, i) => i), kind, { name: 'first' });
    const oldId = selected[`${kind}_group_id`];
    u.refreshSubtitleGroupViews(p);
    assert.ok(selected[kind]);
    const newId = u.assignSubtitleGroup(p, target, [0], kind, { name: 'replacement' }, null, { replaceHead: true });
    assert.equal(newId, oldId);
    assert.ok(all.every(s => s[`${kind}_group_id`] === oldId));
    assert.equal(p.subtitle_groups[kind].find(g => g.id === oldId).value.name, 'replacement');
    const member = others.at(-1);
    const owner = u.subtitleGroupTracks(p).find(t => t.segments.includes(member)).segments;
    // The last main-track member is a reference, not a displayed head.
    const splitId = u.assignSubtitleGroup(p, owner, [owner.indexOf(member)], kind, { name: 'member-only' }, null, { replaceHead: true });
    assert.notEqual(splitId, oldId);
    assert.equal(selected[`${kind}_group_id`], oldId);
  }
});

test('legacy singular bindings survive collision remapping with an omitted track ID', () => {
  for (const legacyId of ['a', ' a ']) {
    const p = fixture();
    p.multi_subtitle = { enabled: true, tracks: [{ segments: [{ id: legacyId, start: 1000, end: 3000, text: 'translation' }] }],
      bindings: [{ main_segment_id: 'a', extension_segment_id: legacyId }] };
    u.normalizeMultiSubtitleProject(p);
    assert.equal(p.multi_subtitle.bindings.length, 1);
    assert.deepEqual(plain(p.multi_subtitle.bindings[0].main_segment_ids), ['a']);
    assert.deepEqual(plain(p.multi_subtitle.bindings[0].extension_segment_ids), [p.multi_subtitle.tracks[0].segments[0].id]);
  }
});

test('ambiguous or invalid binding tracks reject migration without changing the project', () => {
  const base = fixture();
  base.multi_subtitle = { tracks: ['one', 'two'].map(id => ({ id, segments: [plain(base.segments[0])] })),
    bindings: [{ main_segment_id: 'a', extension_segment_id: 'a' }] };
  for (const canonical of [false, true]) for (const trackId of [undefined, '', 'missing']) {
    const p = plain(base);
    if (canonical) {
      p.multi_subtitle.bindings[0].track_id = 'two';
      u.normalizeMultiSubtitleProject(p);
    }
    if (trackId === undefined) delete p.multi_subtitle.bindings[0].track_id;
    else p.multi_subtitle.bindings[0].track_id = trackId;
    const before = JSON.stringify(p);
    assert.throws(() => u.normalizeMultiSubtitleProject(p), /ambiguous.*extension track/);
    assert.equal(JSON.stringify(p), before);
  }
  base.multi_subtitle.bindings[0].track_id = 'two';
  u.normalizeMultiSubtitleProject(base);
  assert.deepEqual(plain(base.multi_subtitle.bindings[0].extension_segment_ids), [base.multi_subtitle.tracks[1].segments[0].id]);
});

test('schema support accepts v1 and v1.5 and rejects reserved v2 without changing input', () => {
  for (const schema of [undefined, 'moy.asr.project.v1', 'moy.asr.project.v1.5', 'moy.asr.project.v2', 'moy.asr.project.v99', null]) {
    const project = { ...(schema === undefined ? {} : { schema }), segments: [] };
    const before = plain(project);
    assert.equal(u.supportsProjectSchema(project), schema === undefined || schema === 'moy.asr.project.v1' || schema === 'moy.asr.project.v1.5', String(schema));
    assert.deepEqual(project, before);
  }
});
