import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { loadEditorModule } from './helpers/editor-module-loader.mjs';
const context = { window: {} };
loadEditorModule(context, 'shared/editor-utils.js');
const u = context.window.AsrEditorUtils;
const plain = value => JSON.parse(JSON.stringify(value));
const main = project => u.getMainTrack(project).segments;
const overlay = project => u.getOverlayTrack(project).segments;
function fixture() {
  return { schema: 'moy.asr.project.v1', segments: [
    { id: 'a', start: 1000, end: 3000, text: 'one', sticker: { name: 'cat', filename: 'cat.png', start: 1000, end: 3000 } },
    { id: 'b', start: 5000, end: 7000, text: 'two', sticker_ref: { name: 'cat', headIdx: 0 } },
    { id: 'c', start: 8000, end: 10000, text: 'three', sticker_ref: { name: 'cat', headIdx: 0 } },
  ], overlay_track: { enabled: true, segments: [] } };
}

test('text restructuring reserves IDs in other tracks and hidden source cues before publishing', () => {
  const p = u.importProject({ segments: [{ id: 'a', start: 0, end: 3000, text: '甲乙丙', items: [
    { text: '甲', start: 0, end: 1000 }, { text: '乙', start: 1000, end: 2000 },
    { text: '丙', start: 2000, end: 3000 },
  ] }], overlay_track: { enabled: true, segments: [] } }).project;
  u.getMainTrack(p).segments = u.applyTimedTextEdit(main(p), ['甲乙', '丙']);
  u.moveSegmentBetweenTracks(main(p), overlay(p), 1);
  u.ensureExtensionTrack(p, { id: 'ext', segments: [
    { id: 'a-text-2-2', start: 0, end: 1000, text: 'hidden extension' },
  ] });
  main(p).push({ id: 'a-text-2-3', start: 4000, end: 5000, text: 'disabled', disabled: true });
  const source = main(p).filter(s => !s.disabled);
  const options = { reservedSegments: u.subtitleGroupTracks(p).flatMap(t => t.segments) };
  const report = u.buildTimedTextEditReport(source, ['甲', '乙'], options);
  const next = u.applyTimedTextEdit(source, ['甲', '乙'], options);
  assert.equal(report.valid, true);
  assert.deepEqual(plain(report.structure.segments), plain(next));
  assert.equal(next[0].id, 'a');
  assert.equal(next[1].id, 'a-text-2-4');
  main(p).splice(0, 1, ...next);
  assert.doesNotThrow(() => u.normalizeMultiSubtitleProject(p));
  const saved = u.serializeSubtitleGroups(plain(p));
  const reopened = plain(saved);
  assert.doesNotThrow(() => u.migrateSubtitleGroups(reopened, { fromFile: true }));
  assert.deepEqual(plain(u.subtitleGroupTracks(reopened).flatMap(t => t.segments.map(s => s.id))),
    ['a', 'a-text-2-4', 'a-text-2-3', 'a-text-2', 'a-text-2-2']);
});
test('legacy group resolves before moving and spans gaps, late end and deletion of its former head', () => {
  const p = u.importProject(fixture()).project;
  const id = main(p)[0].sticker_group_id;
  assert.ok(id); assert.equal(p.subtitle_groups.sticker.length, 1);
  assert.deepEqual(plain(u.subtitleGroupRanges(p).map(r => [r.start, r.end])), [[1000, 10000]]);
  u.moveSegmentBetweenTracks(main(p), overlay(p), 1);
  u.refreshSubtitleGroupViews(p);
  assert.equal(overlay(p)[0].sticker_group_id, id);
  main(p)[1].end = 12000;
  assert.equal(u.subtitleGroupRanges(p)[0].end, 12000);
  main(p).shift(); u.refreshSubtitleGroupViews(p);
  assert.deepEqual(plain(u.subtitleGroupRanges(p).map(r => [r.id, r.start, r.end])), [[id, 5000, 12000]]);
  main(p)[0].disabled = true;
  assert.equal(u.subtitleGroupRanges(p)[0].end, 12000);
  assert.equal(u.subtitleGroupRanges(p)[0].enabled, true);
  overlay(p)[0].disabled = true;
  assert.equal(u.subtitleGroupRanges(p)[0].enabled, false);
});
test('conflicting track cue IDs remap deterministically, update bindings and never conflate equal group names', () => {
  const p = fixture();
  p.multi_subtitle = { tracks: [{ id: 'ext', segments: [{ ...plain(p.segments[0]) }] }],
    bindings: [{ track_id: 'ext', main_segment_ids: ['a'], extension_segment_ids: ['a'] }] };
  const before = plain(p), imported = u.importProject(p).project, other = u.importProject(before).project;
  assert.deepEqual(plain(imported), plain(other));
  assert.deepEqual(p, before);
  const ext = u.getExtensionTrack(imported).segments[0];
  assert.notEqual(ext.id, 'a');
  assert.notEqual(ext.sticker_group_id, main(imported)[0].sticker_group_id);
  assert.equal(imported.bindings[0].target.segment_id, ext.id);
});
test('invalid legacy reference is rejected even when a same-name head exists', () => {
  const p = fixture(); p.segments[1].sticker_ref.headIdx = 99;
  assert.throws(() => u.importProject(p), /earlier head segment/);
  assert.equal(p.subtitle_groups, undefined);
});

test('migration preserves third-party head and per-member reference extensions', () => {
  const p = fixture();
  p.segments[0].sticker.vendor = { asset: 1 };
  p.segments[1].sticker_ref.vendor = { member: 2 };
  const saved = u.serializeSubtitleGroups(plain(u.importProject(p).project));
  assert.deepEqual(saved.subtitle_groups.sticker[0].value.vendor, { asset: 1 });
  assert.deepEqual(main(saved)[1].sticker_group_metadata, { vendor: { member: 2 } });
});
test('canonical serialization, Python normalization and writing preserve membership without index or range truth', () => {
  const p = u.importProject(fixture()).project;
  u.moveSegmentBetweenTracks(main(p), overlay(p), 1);
  u.refreshSubtitleGroupViews(p);
  const saved = u.serializeSubtitleGroups(plain(p));
  assert.equal(saved.schema, 'moy.asr.project.v2');
  assert.doesNotMatch(JSON.stringify(saved), /headIdx/);
  assert.equal(saved.subtitle_groups.sticker[0].value.start, undefined);
  const result = spawnSync(process.env.MAW_TEST_PYTHON || 'python', ['-c',
    'import sys,json; from maw.project import normalize_project; from maw.project_io import serialize_mosp; print(serialize_mosp(normalize_project(json.load(sys.stdin))))'],
    { input: JSON.stringify(saved), encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' } });
  assert.equal(result.status, 0, result.stderr.slice(0, 1500));
  const reopened = JSON.parse(result.stdout); u.normalizeMultiSubtitleProject(reopened);
  assert.equal(reopened.schema, 'moy.asr.project.v2');
  assert.deepEqual(plain(u.subtitleGroupRanges(reopened).map(r => [r.id, r.start, r.end])),
    plain(u.subtitleGroupRanges(p).map(r => [r.id, r.start, r.end])));
});
test('empty groups are collected and same-name assignments remain independent', () => {
  const p = u.importProject(fixture()).project;
  u.clearSubtitleGroupMembers(p, main(p), [0, 1, 2], 'sticker');
  assert.equal(p.subtitle_groups.sticker.length, 0);
  const a = u.assignSubtitleGroup(p, main(p), [0], 'sticker', { name: 'cat' });
  const b = u.assignSubtitleGroup(p, main(p), [1], 'sticker', { name: 'cat' });
  assert.notEqual(a, b);
  assert.equal(u.subtitleGroupRanges(p).length, 2);
});

test('canonical groups reject ambiguous identity, dangling membership, independent ranges and bad counters', () => {
  const base = u.importProject(fixture()).project;
  for (const mutate of [
    p => { main(p)[1].id = main(p)[0].id; },
    p => { main(p)[1].sticker_group_id = 'missing'; },
    p => { p.subtitle_groups.sticker[0].value.start = 0; },
    p => { p.subtitle_groups.next_id = Infinity; },
  ]) {
    const p = plain(base); mutate(p);
    assert.throws(() => u.importProject(p));
  }
  const p = fixture(); p.multi_subtitle = { tracks: [], bindings: [{ main_segment_ids: ['a'] }] };
  p.segments[1].id = 'a';
  assert.throws(() => u.importProject(p));
});

test('v2 file boundary rejects legacy fields while renderers can materialize detached views', () => {
  const p = u.importProject(fixture()).project;
  const saved = u.serializeSubtitleGroups(plain(p));
  assert.doesNotThrow(() => u.importProject(saved));
  main(saved)[0].sticker_ref = { headIdx: 99 };
  assert.throws(() => u.importProject(saved));
  assert.ok(u.materializeTrackSegments(p, u.getMainTrack(p).id)[0].sticker);
  assert.equal(Object.hasOwn(main(p)[0], 'sticker'), false);
});

test('export creates one continuous group clip and maps Gap once across tracks', () => {
  const raw = fixture(); raw.media = 'synthetic.wav'; const p = u.importProject(raw).project;
  u.moveSegmentBetweenTracks(main(p), overlay(p), 1);
  main(p)[1].end = 12000;
  const source = u.buildProjectExportPlan(p, { durationMs: 15000, timelineMode: 'source' });
  assert.deepEqual(plain([...source.stickers, ...source.overlayStickers].map(s => [s.startMs, s.endMs])), [[1000, 12000]]);
  p.gap_remove = { enabled: true, gaps: [{ start: 3000, end: 4000 }] };
  const mapped = u.buildProjectExportPlan(p, { durationMs: 15000, timelineMode: 'gap_removed' });
  assert.deepEqual(plain(mapped.stickers.map(s => [s.startMs, s.endMs])), [[1000, 11000]]);
  main(p).forEach(s => { s.disabled = true; }); overlay(p)[0].disabled = true;
  const disabled = u.buildProjectExportPlan(p, { durationMs: 15000, timelineMode: 'source' });
  assert.equal(disabled.stickers.length + disabled.overlayStickers.length, 0);
});

test('disabled tracks retain groups but cannot contribute stickers to presentation or FCP XML', () => {
  const raw = fixture(); raw.media = 'movie.mp4';
  raw.segments.forEach(s => { if (s.sticker) s.sticker.rel = 'cat.png'; });
  const p = u.importProject(raw).project;
  const groupId = main(p)[0].sticker_group_id;
  overlay(p).push(...main(p).splice(1));
  u.getOverlayTrack(p).enabled = false;
  const secondary = u.ensureExtensionTrack(p, { id: 'ext', enabled: false, segments: [
    { id: 'ext-a', start: 14000, end: 15000, text: 'extension', sticker_group_id: groupId },
  ] });
  const presentation = () => u.subtitleGroupRanges(p, 'sticker', { activeTracksOnly: true });
  assert.equal(presentation()[0].end, 3000);
  u.refreshSubtitleGroupViews(p);
  assert.equal(p.subtitle_groups.sticker.length, 1);
  assert.equal(u.subtitleGroupRanges(p)[0].end, 15000);
  main(p)[0].disabled = true;
  const plan = u.buildProjectExportPlan(p, { durationMs: 16000 });
  assert.equal(plan.stickers.length + plan.overlayStickers.length, 0);
  const xml = u.buildFcp7ExportArtifacts(plan, { fps: '30', nativeTextObjects: true, baseName: 'disabled' })[0].content;
  assert.doesNotMatch(xml, /cat\.png/);
  u.getOverlayTrack(p).enabled = true;
  assert.equal(presentation()[0].end, 10000);
  assert.equal(presentation()[0].enabled, true);
  secondary.enabled = true;
  assert.equal(presentation()[0].end, 15000);
  assert.equal(u.subtitleGroupRanges(u.serializeSubtitleGroups(plain(p)))[0].members.length, 4);
});

test('large legacy input keeps distinct groups and deterministically remaps all cross-track collisions', () => {
  const cues = () => Array.from({ length: 1000 }, (_, index) => ({
    id: `cue-${index}`, start: index * 2000, end: index * 2000 + 1000, text: `cue ${index}`,
    ...(index % 50 === 0 ? { sticker: { name: 'same-name', rel: 'cat.png' } }
      : { sticker_ref: { name: 'same-name', headIdx: index - index % 50 } }),
  }));
  const p = u.importProject({ segments: cues(), overlay_track: { enabled: true, segments: cues() } }).project;
  const all = u.subtitleGroupTracks(p).flatMap(t => t.segments);
  assert.equal(new Set(all.map(s => s.id)).size, 2000);
  assert.equal(p.subtitle_groups.sticker.length, 40);
  assert.equal(overlay(p).filter(s => s.id.startsWith('overlay-cue-')).length, 1000);
  const saved = u.serializeSubtitleGroups(plain(p));
  assert.doesNotMatch(JSON.stringify(saved), /headIdx/);
  u.normalizeMultiSubtitleProject(saved);
  assert.equal(u.subtitleGroupRanges(saved).length, 40);
});


test('replacing a displayed group head keeps cross-track members while a member assignment stays independent', () => {
  for (const kind of ['color', 'sticker']) for (const track of ['main', 'overlay', 'extension']) {
    const p = u.importProject(fixture()).project;
    const secondary = u.ensureExtensionTrack(p, { id: 'ext', segments: [] });
    const target = track === 'main' ? main(p) : track === 'overlay' ? overlay(p) : secondary.segments;
    if (target !== main(p)) u.moveSegmentBetweenTracks(main(p), target, 0);
    const selected = target[0];
    const others = u.subtitleGroupTracks(p).flatMap(t => t.segments).filter(s => s !== selected);
    const all = [selected, ...others];
    u.assignSubtitleGroup(p, all, all.map((_, i) => i), kind, { name: 'first' });
    const oldId = selected[`${kind}_group_id`];
    u.refreshSubtitleGroupViews(p);
    const targetTrack = u.subtitleGroupTracks(p).find(t => t.segments === target);
    assert.ok(u.materializeTrackSegments(p, targetTrack.id)[0][kind]);
    const newId = u.assignSubtitleGroup(p, target, [0], kind, { name: 'replacement' }, null, { replaceHead: true });
    assert.equal(newId, oldId);
    assert.ok(all.every(s => s[`${kind}_group_id`] === oldId));
    assert.equal(p.subtitle_groups[kind].find(g => g.id === oldId).value.name, 'replacement');
    const member = others.at(-1);
    const owner = u.subtitleGroupTracks(p).find(t => t.segments.includes(member)).segments;
    // Member-only assignment creates an independent group.
    const splitId = u.assignSubtitleGroup(p, owner, [owner.indexOf(member)], kind, { name: 'member-only' });
    assert.notEqual(splitId, oldId);
    assert.equal(selected[`${kind}_group_id`], oldId);
  }
});

test('legacy singular bindings survive collision remapping with an omitted track ID', () => {
  for (const legacyId of ['a', ' a ']) {
    const p = fixture();
    p.multi_subtitle = { enabled: true, tracks: [{ segments: [{ id: legacyId, start: 1000, end: 3000, text: 'translation' }] }],
      bindings: [{ main_segment_id: 'a', extension_segment_id: legacyId }] };
    const imported = u.importProject(p).project;
    assert.equal(imported.bindings.length, 1);
    assert.equal(imported.bindings[0].source.segment_id, 'a');
    assert.equal(imported.bindings[0].target.segment_id, u.getExtensionTrack(imported).segments[0].id);
  }
});

test('multiple legacy secondary tracks reject migration without changing the project', () => {
  const base = fixture();
  base.multi_subtitle = { tracks: ['one', 'two'].map(id => ({ id, segments: [plain(base.segments[0])] })),
    bindings: [{ main_segment_id: 'a', extension_segment_id: 'a' }] };
  for (const trackId of [undefined, '', 'missing', 'two']) {
    const p = plain(base);
    if (trackId === undefined) delete p.multi_subtitle.bindings[0].track_id;
    else p.multi_subtitle.bindings[0].track_id = trackId;
    const before = JSON.stringify(p);
    assert.throws(() => u.importProject(p));
    assert.equal(JSON.stringify(p), before);
  }
});

test('schema support accepts v1, v1.5 and v2 and rejects future versions without changing input', () => {
  for (const schema of [undefined, 'moy.asr.project.v1', 'moy.asr.project.v1.5', 'moy.asr.project.v2', 'moy.asr.project.v3', 'moy.asr.project.v99', null]) {
    const project = { ...(schema === undefined ? {} : { schema }), segments: [] };
    const before = plain(project);
    assert.equal(u.supportsProjectSchema(project), schema === undefined || ['moy.asr.project.v1', 'moy.asr.project.v1.5', 'moy.asr.project.v2'].includes(schema), String(schema));
    assert.deepEqual(project, before);
  }
});
