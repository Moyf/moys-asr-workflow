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

const utilsModule = async name => import(`data:text/javascript;base64,${Buffer.from(readFileSync(new URL(`../web/shared/utils/${name}.js`, import.meta.url), 'utf8')).toString('base64')}`);
const dependencies = { ...model, cloneJsonValue: json, stableId: value => typeof value === 'string' ? value.trim() : '' };
const subtitle = (await utilsModule('multi-subtitle')).createUtilsModule(dependencies);
const history = (await utilsModule('history')).createUtilsModule(dependencies);
const groups = (await utilsModule('subtitle-groups')).createUtilsModule(dependencies);
const planners = { getNavigator: () => ({ platform: 'Win32' }) };
for (const name of ['data', 'ass-style', 'text-processing', 'timed-text-core', 'timed-text-plans']) Object.assign(planners, (await utilsModule(name)).createUtilsModule(planners));
Object.assign(planners, (await utilsModule('word-timing')).createWordTiming(planners));
test('canonical bindings use both actual track IDs and rebuild offsets without an alias tree', () => {
  const project = canonical();
  project.tracks[0].id = 'source-identity';
  project.bindings = [subtitle.buildSubtitleBinding(project.tracks[0].segments[0], project.tracks[1].segments[0], 'translation-en', 'custom-bind', 'source-identity')];
  project.tracks[1].segments[0].start += 10;
  subtitle.rebuildBindingOffsets(project);
  assert.equal(project.bindings[0].start_offset_ms, 60);
  assert.equal(subtitle.bindingForSegment(project, 'cue-main', 'main', 'translation-en'), project.bindings[0]);
  assert.equal(Object.hasOwn(project, 'multi_subtitle'), false);
  assert.equal(model.validateTracksProject(project).ok, true);
  assert.equal(subtitle.removeBindingsForSegments(project, ['cue-main']).length, 1);
  assert.equal(project.bindings.length, 0);
});

test('role swap preserves entities, group memberships and metadata while remapping other languages', () => {
  const project = canonical();
  const oldMain = project.tracks[0]; const promoted = project.tracks[1];
  oldMain.segments.push({ id: 'untranslated', start: 2500, end: 3000, text: 'extra', metadata: { keep: false } });
  const french = { id: 'fr', role: 'extension', name: 'French', enabled: true,
    segments: [{ id: 'fr-1', start: 1200, end: 2300, text: 'Bonjour' }, { id: 'fr-2', start: 2500, end: 3000, text: 'Autre' }] };
  project.tracks.push(french);
  project.bindings.push(subtitle.buildSubtitleBinding(oldMain.segments[0], french.segments[0], 'fr', 'fr-bind-1', oldMain.id));
  const oldSegments = oldMain.segments; const cueEntity = promoted.segments[0];
  const groupsBefore = json(project.subtitle_groups);
  const result = subtitle.swapMainAndExtensionSubtitle(project);
  assert.equal(result.swapped, true);
  assert.equal(result.removedBindingCount, 0); assert.equal(result.remappedBindingCount, 1);
  assert.equal(model.getMainTrack(project), promoted);
  assert.equal(oldMain.segments, oldSegments);
  assert.equal(promoted.segments[0], cueEntity);
  assert.equal(project.bilingual.active_track_id, oldMain.id);
  assert.equal(project.bindings[0].start_offset_ms, -50);
  assert.equal(project.bindings[1].source_segment_ids[0], 'cue-en');
  assert.deepEqual(project.subtitle_groups, groupsBefore);
  assert.equal(model.validateTracksProject(project).ok, true);
});

test('track snapshots restore roles, metadata, relations and groups while retaining existing track arrays', () => {
  const project = canonical();
  const trackArray = project.tracks; const main = project.tracks[0]; const segments = main.segments;
  const snapshot = history.buildSegmentsHistorySnapshot(project);
  subtitle.swapMainAndExtensionSubtitle(project);
  project.tracks[0].temporary = 'remove on undo'; project.subtitle_groups.color = [];
  history.restoreSegmentsHistorySnapshot(project, snapshot);
  assert.equal(project.tracks, trackArray); assert.equal(project.tracks[0], main); assert.equal(main.segments, segments);
  assert.deepEqual(history.buildSegmentsHistorySnapshot(project), snapshot);
  assert.equal(model.validateTracksProject(project).ok, true);
});

test('group assignment and clearing modify only memberships and preserve cross-track group values', () => {
  const project = canonical(); const segments = project.tracks[0].segments;
  const groupId = groups.assignSubtitleGroup(project, segments, [0], 'sticker', { name: 'smile', start: 0, end: 5, payload: { vendor: false } });
  assert.equal(groupId, 'sticker-2');
  assert.equal(segments[0].sticker_group_id, groupId);
  assert.equal(Object.hasOwn(segments[0], 'sticker'), false);
  assert.deepEqual(groups.getSubtitleGroupValue(project, segments[0], 'sticker'), { name: 'smile', payload: { vendor: false } });
  assert.equal(model.validateTracksProject(project).ok, true);
  groups.clearSubtitleGroupMembers(project, segments, [0], 'sticker');
  assert.equal(Object.hasOwn(segments[0], 'sticker_group_id'), false);
  assert.equal(project.subtitle_groups.sticker[0].id, groupId);
});

test('detached group materialization preserves a disabled first head without polluting DATA or snapshots', () => {
  const project = fixture('legacy-three-tracks.expected');
  project.tracks[0].segments[0].disabled = true;
  const before = json(project);
  const detached = groups.materializeTrackSegments(project, 'main');
  assert.equal(detached[0].color.name, '暖黄');
  assert.equal(detached[1].color_ref.headIdx, 0);
  assert.equal(detached[1].color_ref.custom_ref, 0);
  detached[0].color.name = 'mutated renderer';
  assert.deepEqual(project, before);
  assert.deepEqual(groups.serializeSubtitleGroups(project), before);
  assert.equal(model.validateTracksProject(project).ok, true);
});

test('new role tracks reserve existing identities and reuse the active track', () => {
  const project = model.migrateProjectTracks({ segments: [] });
  const extension = subtitle.ensureExtensionTrack(project, { id: 'main', language: 'en' });
  assert.equal(extension.id, 'main-2');
  assert.equal(subtitle.ensureExtensionTrack(project), extension);
  const overlay = subtitle.ensureOverlayTrack(project);
  assert.equal(subtitle.ensureOverlayTrack(project), overlay);
  assert.equal(model.validateTracksProject(project).ok, true);
});

test('track metadata and ASS extension values obey shared strict and lossless contracts', () => {
  const good = canonical(); good.tracks[0].segments[0].assOverride = { vendor: { enabled: false } };
  assert.deepEqual(model.importProject(good).project, good);
  const source = canonical(); source.tracks[0].language_source = 'guessed';
  rejects(source, '$.tracks[0].language_source');
  const speaker = canonical(); speaker.tracks[0].segments[0].speaker = '';
  rejects(speaker, '$.tracks[0].segments[0].speaker');
  const frame = canonical(); frame.tracks[0].segments[0].items[0].start_frame = 0;
  rejects(frame, '$.tracks[0].segments[0].items[0].start_frame');
});

test('export group ranges use selected, enabled cues without hidden tracks extending stickers', () => {
  const project = canonical();
  project.subtitle_groups.sticker.push({ id: 'sticker-shared', value: { name: 'smile' } });
  for (const track of project.tracks.slice(0, 2)) track.segments[0].sticker_group_id = 'sticker-shared';
  project.tracks[2].segments.push({ id: 'hidden', start: 5000, end: 6000, text: 'hidden', sticker_group_id: 'sticker-shared' });
  project.tracks[0].segments.push({ id: 'disabled', start: 7000, end: 8000, text: 'disabled', disabled: true, sticker_group_id: 'sticker-shared' });
  const options = { trackIds: ['main', 'translation-en'], includeDisabled: false };
  const ranges = groups.subtitleGroupRanges(project, 'sticker', options);
  assert.equal(ranges.length, 1); assert.equal(ranges[0].start, 1200); assert.equal(ranges[0].end, 2350);
  assert.deepEqual(ranges[0].members.map(member => member.trackId), ['main', 'translation-en']);
  const projection = groups.materializeTrackSegments(project, 'main', options);
  assert.equal(projection[0].sticker.end, 2350);
  assert.equal(Object.hasOwn(project.tracks[0].segments[0], 'sticker'), false);
});

test('an impossible swap leaves every canonical field unchanged', () => {
  const project = canonical(); project.tracks[1].segments = [];
  const before = json(project);
  assert.deepEqual(subtitle.swapMainAndExtensionSubtitle(project), { swapped: false, reason: 'empty-track' });
  assert.deepEqual(project, before);
});

test('unmapped multilingual bindings reject a role swap atomically without losing any relation', () => {
  const project = canonical();
  const main = project.tracks[0];
  main.segments.push({ id: 'unmapped-source', start: 2500, end: 3000, text: 'not translated into active language' });
  const french = { id: 'fr', role: 'extension', name: 'French', enabled: true,
    segments: [{ id: 'fr-unmapped', start: 2500, end: 3000, text: 'Autre' }] };
  project.tracks.push(french);
  project.bindings.push(subtitle.buildSubtitleBinding(main.segments[1], french.segments[0], 'fr', 'fr-unmapped-binding', main.id));
  assert.equal(model.validateTracksProject(project).ok, true);
  const before = json(project); const bindings = project.bindings; const tracks = project.tracks;
  assert.deepEqual(subtitle.swapMainAndExtensionSubtitle(project), { swapped: false, reason: 'unmapped-bindings', unmappedBindingCount: 1 });
  assert.deepEqual(project, before);
  assert.equal(project.bindings, bindings); assert.equal(project.tracks, tracks);
});

test('word conversion avoids IDs on other tracks and retains canonical group memberships', () => {
  const source = { id: 'source', start: 0, end: 1000, text: '甲乙', color_group_id: 'group', sticker_group_id: 'sticker',
    items: [{ start: 0, end: 500, text: '甲' }, { start: 500, end: 1000, text: '乙' }] };
  const reserved = [{ id: 'source-item-1' }, { id: 'source-item-2' }];
  const before = json(source);
  const plan = planners.planWordTimingConversion([source], [0], undefined, { reservedSegments: reserved });
  assert.deepEqual(plan.segments.map(cue => cue.id), ['source', 'source-item-2-2']);
  for (const cue of plan.segments) {
    assert.equal(cue.color_group_id, 'group'); assert.equal(cue.sticker_group_id, 'sticker');
    assert.equal(Object.hasOwn(cue, 'color_ref'), false);
  }
  assert.deepEqual(source, before); assert.deepEqual(reserved, [{ id: 'source-item-1' }, { id: 'source-item-2' }]);
});

test('word conversion still generates first-piece IDs for sources without an identity', () => {
  const source = { start: 0, end: 1000, text: '甲乙',
    items: [{ start: 0, end: 500, text: '甲' }, { start: 500, end: 1000, text: '乙' }] };
  const plan = planners.planWordTimingConversion([source], [0], undefined, { reservedSegments: [{ id: 'main-item-1' }] });
  assert.deepEqual(plan.segments.map(cue => cue.id), ['main-item-1-2', 'main-item-2']);
  assert.equal(Object.hasOwn(source, 'id'), false);
});

test('timed text splits reserve all project IDs and merged rows inherit only common memberships', () => {
  const source = [{ id: 'source', start: 0, end: 1000, text: '甲乙', color_group_id: 'same',
    items: [{ start: 0, end: 500, text: '甲' }, { start: 500, end: 1000, text: '乙' }] }];
  const split = planners.buildTimedTextStructurePlan(source, ['甲', '乙'], { reservedSegments: [{ id: 'source-text-2' }] });
  assert.equal(split.valid, true);
  assert.deepEqual(split.segments.map(cue => cue.id), ['source', 'source-text-2-2']);
  assert.deepEqual(split.segments.map(cue => cue.color_group_id), ['same', 'same']);
  const mergedSource = [{ id: 'one', start: 0, end: 500, text: '甲', color_group_id: 'same', sticker_group_id: 'first' },
    { id: 'two', start: 500, end: 1000, text: '乙', color_group_id: 'same', sticker_group_id: 'second' }];
  const merge = planners.buildTimedTextStructurePlan(mergedSource, ['甲乙']);
  assert.equal(merge.valid, true); assert.equal(merge.segments[0].color_group_id, 'same');
  assert.equal(Object.hasOwn(merge.segments[0], 'sticker_group_id'), false);
});
