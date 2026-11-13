import assert from 'node:assert/strict';
import test from 'node:test';
import { loadEditorModule } from './helpers/editor-module-loader.mjs';
import { initMaweMultiSubtitleCore } from '../web/editor/state/editor-multi-subtitle-core.js';
import { initMaweSegmentOps } from '../web/editor/cues/editor-segment-ops.js';
import { initMaweTextCleanup } from '../web/editor/cues/editor-text-cleanup.js';
import { initMaweBoundDrag } from '../web/editor/cues/editor-bound-drag.js';
import { createEditorCommands } from '../web/editor/state/editor-commands.js';
import { mergeOverlaySegments } from '../web/editor/cues/overlay-track.js';
import { projectModel, runtimeProject } from './helpers/runtime-project.mjs';

// Run real domain factories; only their UI/selection bridges are inert. Node
// isolates this file's globals, and these stateful tests run sequentially.
const context = { window: {}, TextDecoder, TextEncoder, Uint8Array };
loadEditorModule(context, 'shared/editor-utils.js');
globalThis.window = globalThis;
globalThis.AsrEditorUtils = context.window.AsrEditorUtils;
const noop = () => {};
globalThis.MaweState = {
  markProjectDirty: noop,
  selection: { clear: noop, add: noop, indices: () => new Set(), getCurrentCueRef: () => null },
};
globalThis.MaweSelection = {
  selectedIdxs: new Set(), selectedExtensionIdxs: new Set(),
  clearSelection: noop, selectOnly: noop, selectOnlyExtension: noop,
  lastClickedExtensionIdx: -1,
};
globalThis.MaweCuePanel = {
  commitCuePanelEdit: noop, setCuePanelTarget: noop,
  remapPanelItems: (items) => items,
};
globalThis.MaweCuePanelWiring = { updateSelectionCountText: noop };
globalThis.MaweCuePanelState = {
  currentCuePanelIdx: -1, currentCuePanelKind: 'main', currentCuePanelTrackId: null,
};
globalThis.MaweCoreState = { container: { querySelector: () => null }, waveformEditor: null };
globalThis.MaweCueListAnchor = { captureVisibleCueListVisualAnchor: () => null };
globalThis.MaweViewUpdates = { invalidate: noop };
globalThis.MaweHint = { flashHint: noop };
globalThis.MaweSettings = {
  EDITOR_SETTINGS: {
    mainSplitModeOverride: null, mergeJoinTextWord: ' ', mergeJoinTextContinuous: '',
    multiSubtitleAutoSyncDuration: false,
  },
};
initMaweMultiSubtitleCore();
initMaweSegmentOps();
initMaweTextCleanup();
initMaweBoundDrag();

let history = [];

function cue(i) {
  return { id: `cue-${i}`, start: i * 1000, end: i * 1000 + 500, text: `Cue ${i}` };
}

// These tests exercise the canonical runtime, not the legacy import format.
function v2Fixture(segments, groups) {
  const project = runtimeProject([], {
    extensions: [{ id: 'translation', segments }],
    speakers: [], annotation_mode: 'color', palette_size: 5, speaker_shortcuts: {},
    subtitle_groups: { next_id: 10, color: groups, sticker: [] },
  });
  globalThis.MaweBoot = { DATA: project };
  return { project, track: project.tracks.find(item => item.role === 'secondary') };
}

function assertV2RoundTrip(project) {
  const saved = projectModel.snapshotProjectContent(project);
  const result = projectModel.validateTracksProject(saved);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(projectModel.importProject(saved).project, saved);
}

function v2StickerMergeFixture(segments, role, sameGroup) {
  const colors = [
    { id: 'red-a', value: { name: 'red', value: '#aa0000' } },
    { id: 'red-b', value: { name: 'red', value: '#bb0000' } },
    { id: 'green', value: { name: 'green', value: '#2ecc71' } },
  ];
  const stickers = [
    { id: 'sticker-a', value: { name: 'demo', value: 'demo.png' } },
    { id: 'sticker-b', value: { name: 'demo', value: 'demo.png' } },
  ];
  segments.forEach((segment, index) => {
    if (index < 6) segment.color_group_id = index < 3 ? 'red-a' : 'red-b';
    else if (index < 8) segment.color_group_id = 'green';
    if (index < 6) segment.sticker_group_id = sameGroup || index < 3 ? 'sticker-a' : 'sticker-b';
  });
  const project = runtimeProject(role === 'main' ? segments : [], {
    speakers: [], annotation_mode: 'color', palette_size: 5, speaker_shortcuts: {},
    ...(role === 'overlay' ? { overlay: { id: 'overlay', segments } } : {}),
    subtitle_groups: { next_id: 10, color: colors, sticker: stickers },
  });
  globalThis.MaweBoot = { DATA: project };
  history = [];
  globalThis.MaweCommands = createEditorCommands({
    capture: () => structuredClone(MaweBoot.DATA),
    hasChanges: snapshot => JSON.stringify(snapshot) !== JSON.stringify(MaweBoot.DATA),
    publish: snapshot => history.push(snapshot),
    restore: snapshot => { MaweBoot.DATA = snapshot; },
    refresh: noop,
  });
  return { project, track: project.tracks.find(item => item.role === role) };
}

function v2ColorMergeFixture(name, variant = 'same') {
  const segments = Array.from({ length: 9 }, (_, index) => cue(index));
  segments.forEach((segment, index) => {
    if (index < 6) segment.color_group_id = index < 3 ? 'red-a' : 'red-b';
    else if (index < 8) segment.color_group_id = 'green';
  });
  if (variant === 'uncolored') delete segments[2].color_group_id;
  const main = name === 'mainTrack' ? segments : name === 'linkedExtension' ? [
    { ...cue(20), start: segments[2].start, end: segments[2].end },
    { ...cue(21), start: segments[3].start, end: segments[3].end },
  ] : [];
  const role = name === 'mainTrack' ? 'main' : name === 'overlay' ? 'overlay' : 'secondary';
  const project = runtimeProject(main, {
    speakers: [], annotation_mode: 'color', palette_size: 5, speaker_shortcuts: {},
    ...(role === 'overlay' ? { overlay: { id: 'overlay', segments } } : {}),
    ...(role === 'secondary' ? { extensions: [{ id: 'translation', segments }] } : {}),
    subtitle_groups: { next_id: 10, sticker: [], color: [
      { id: 'red-a', value: { name: 'red', value: '#aa0000' } },
      { id: 'red-b', value: { name: variant === 'different-colors' ? 'blue' : 'red', value: '#bb0000' } },
      { id: 'green', value: { name: 'green', value: '#2ecc71' } },
    ] },
  });
  globalThis.MaweBoot = { DATA: project };
  history = [];
  globalThis.MaweCommands = createEditorCommands({
    capture: () => structuredClone(MaweBoot.DATA),
    hasChanges: snapshot => JSON.stringify(snapshot) !== JSON.stringify(MaweBoot.DATA),
    publish: snapshot => history.push(snapshot),
    restore: snapshot => { MaweBoot.DATA = snapshot; },
    refresh: noop,
  });
  return { project, track: project.tracks.find(item => item.role === role) };
}

function mergeV2ColorFixture(name, variant = 'same') {
  const fixture = v2ColorMergeFixture(name, variant);
  fixture.before = structuredClone(fixture.project);
  if (name === 'mainTrack') MaweSegmentOps.mergeSegments([2, 3]);
  else if (name === 'linkedExtension') MaweSegmentOps.mergeSegments([0, 1]);
  else if (name === 'extension') assert.equal(MaweSegmentOps.mergeExtensionSegments([2, 3]), true);
  else assert.equal(mergeOverlaySegments([2, 3]), true);
  if (name === 'linkedExtension') {
    assert.equal(fixture.project.bindings.length, 1);
    assert.equal(fixture.project.bindings[0].target.segment_id, fixture.track.segments[2].id);
    assert.equal(fixture.project.bindings[0].source.segment_id, fixture.project.tracks[0].segments[0].id);
  }
  return fixture;
}

function mergeV2Explicit(name, segments, groups, indexes, { colorMain = false } = {}) {
  const linked = name === 'main';
  const role = name === 'overlay' ? 'overlay' : 'secondary';
  const main = linked ? indexes.map((index, i) => ({
    id: `main-${i}`, start: segments[index].start, end: segments[index].end, text: `Main ${i}`,
    ...(colorMain ? { color_group_id: segments[index].color_group_id } : {}),
  })) : [];
  const project = runtimeProject(main, {
    speakers: [], annotation_mode: 'color', palette_size: 5, speaker_shortcuts: {},
    ...(role === 'overlay' ? { overlay: { id: 'overlay', segments } } : { extensions: [{ id: 'translation', segments }] }),
    subtitle_groups: { next_id: 10, color: groups, sticker: [] },
  });
  globalThis.MaweBoot = { DATA: project };
  history = [];
  globalThis.MaweCommands = createEditorCommands({
    capture: () => structuredClone(MaweBoot.DATA),
    hasChanges: snapshot => JSON.stringify(snapshot) !== JSON.stringify(MaweBoot.DATA),
    publish: snapshot => history.push(snapshot),
    restore: snapshot => { MaweBoot.DATA = snapshot; },
    refresh: noop,
  });
  const track = project.tracks.find(item => item.role === role);
  const before = structuredClone(project);
  if (linked) MaweSegmentOps.mergeSegments(indexes.map((_, i) => i));
  else if (name === 'extension') assert.equal(MaweSegmentOps.mergeExtensionSegments(indexes), true);
  else assert.equal(mergeOverlaySegments(indexes), true);
  if (linked) {
    assert.equal(project.bindings.length, 1);
    assert.equal(project.bindings[0].source.segment_id, project.tracks[0].segments[0].id);
    assert.equal(project.bindings[0].target.segment_id, track.segments[indexes[0]].id);
  }
  assert.equal(history.length, 1);
  assert.deepEqual(history[0], before);
  return { project, track };
}

for (const name of ['mainTrack', 'linkedExtension', 'extension', 'overlay']) {
  test(`same-color cross-group ${name}: surviving stable groups and undo snapshot`, () => {
    const { project, track, before } = mergeV2ColorFixture(name);
    const result = track.segments;
    assert.equal(result.length, 8);
    assert.deepEqual(result.map(cue => cue.color_group_id).slice(0, 2), ['red-a', 'red-a']);
    assert.deepEqual(result.map(cue => cue.color_group_id).slice(3, 7), ['red-b', 'red-b', 'green', 'green']);
    assert.equal(result[7].color_group_id, undefined);
    const mergedId = result[2].color_group_id;
    assert.ok(mergedId);
    assert.notEqual(mergedId, 'red-a');
    assert.notEqual(mergedId, 'red-b');
    const mergedGroup = project.subtitle_groups.color.find(group => group.id === mergedId);
    assert.deepEqual(timelineValue(mergedGroup.value), { name: 'red', value: '#aa0000' });
    for (const id of ['red-a', 'red-b', 'green']) {
      assert.deepEqual(project.subtitle_groups.color.find(group => group.id === id),
        before.subtitle_groups.color.find(group => group.id === id));
    }
    assert.equal(history.length, 1);
    assert.deepEqual(history[0], before);
    const snapshot = structuredClone(history[0]);
    assert.equal(snapshot.tracks.find(item => item.id === track.id).segments.length, 9);
    mergedGroup.value.value = '#ffffff';
    project.subtitle_groups.color.find(group => group.id === 'red-b').value.value = '#ffffff';
    assert.deepEqual(history[0], snapshot, 'post-merge color edits cannot mutate undo data');
    assertV2RoundTrip(project);
  });

  for (const mixed of ['different-colors', 'uncolored']) {
    test(`same-color cross-group ${name}: ${mixed} does not inherit`, () => {
      const { project, track } = mergeV2ColorFixture(name, mixed);
      const result = track.segments;
      assert.equal(result[2].color_group_id, undefined);
      assert.equal(result[3].color_group_id, 'red-b');
      assert.equal(project.subtitle_groups.color.find(group => group.id === 'red-b').value.name,
        mixed === 'different-colors' ? 'blue' : 'red');
      assertV2RoundTrip(project);
    });
  }
}

for (const name of ['mainTrack', 'overlay']) {
  for (const sameStickerGroup of [true, false]) {
    test(`same-color cross-group ${name}: stickers remain strictly ${sameStickerGroup ? 'same-group' : 'cross-group'}`, () => {
      const segments = Array.from({ length: 9 }, (_, index) => cue(index));
      const { project, track } = v2StickerMergeFixture(segments, name === 'mainTrack' ? 'main' : 'overlay', sameStickerGroup);
      const before = structuredClone(project);
      if (name === 'mainTrack') MaweSegmentOps.mergeSegments([2, 3]);
      else assert.equal(mergeOverlaySegments([2, 3]), true);
      const result = track.segments;
      assert.equal(result.length, 8);
      const color = project.subtitle_groups.color.find(group => group.id === result[2].color_group_id);
      assert.equal(color.value.name, 'red');
      assert.equal(color.value.value, '#aa0000');
      assert.equal(result[2].sticker_group_id, sameStickerGroup ? 'sticker-a' : undefined);
      assert.equal(result[0].sticker_group_id, 'sticker-a');
      assert.equal(result[1].sticker_group_id, 'sticker-a');
      assert.equal(result[3].sticker_group_id, sameStickerGroup ? 'sticker-a' : 'sticker-b');
      assert.equal(result[4].sticker_group_id, sameStickerGroup ? 'sticker-a' : 'sticker-b');
      assert.equal(history.length, 1);
      assert.deepEqual(history[0], before);
      assertV2RoundTrip(project);
    });
  }
}

for (const name of ['extension', 'main', 'overlay']) {
  test(`merge ${name}: four of six cues retain the trailing color group`, () => {
    const segments = Array.from({ length: 6 }, (_, index) => cue(index));
    segments.slice(4).forEach(segment => { segment.color_group_id = 'green'; });
    const { project, track } = mergeV2Explicit(name, segments, [
      { id: 'green', value: { name: 'green', value: '#2ecc71' } },
    ], [0, 1, 2, 3]);
    const result = track.segments;
    assert.equal(result.length, 3);
    assert.equal(result[1].color_group_id, 'green');
    assert.equal(result[2].color_group_id, 'green');
    assert.equal(project.subtitle_groups.color.find(group => group.id === 'green').value.value, '#2ecc71');
    assertV2RoundTrip(project);
  });

  test(`merge ${name}: true tail merge preserves earlier color groups`, () => {
    const segments = Array.from({ length: 6 }, (_, index) => cue(index));
    segments.slice(0, 2).forEach(segment => { segment.color_group_id = 'red'; });
    segments.slice(4).forEach(segment => { segment.color_group_id = 'green'; });
    const { project, track } = mergeV2Explicit(name, segments, [
      { id: 'red', value: { name: 'red' } }, { id: 'green', value: { name: 'green' } },
    ], [4, 5]);
    const result = track.segments;
    assert.equal(result.length, 5);
    assert.equal(result[0].color_group_id, 'red');
    assert.equal(result[1].color_group_id, 'red');
    assert.equal(result[4].color_group_id, 'green');
    assertV2RoundTrip(project);
  });

  test(`merge ${name}: full same-group merge retains its stable group`, () => {
    const segments = Array.from({ length: 6 }, (_, i) => cue(i));
    segments.forEach(segment => { segment.color_group_id = 'red'; });
    const { project, track } = mergeV2Explicit(name, segments, [
      { id: 'red', value: { name: 'red', value: '#aa0000' } },
    ], [0, 1, 2, 3, 4, 5]);
    const result = track.segments;
    assert.equal(result.length, 1);
    assert.equal(result[0].color_group_id, 'red');
    assert.equal(project.subtitle_groups.color.find(group => group.id === 'red').value.value, '#aa0000');
    assertV2RoundTrip(project);
  });
}

test('merge extension: mixed groups preserve surviving members and the undo snapshot', () => {
  const segments = Array.from({ length: 7 }, (_, i) => cue(i));
  segments.slice(0, 3).forEach(segment => { segment.color_group_id = 'red'; });
  segments.slice(3, 6).forEach(segment => { segment.color_group_id = 'green'; });
  const { project, track } = mergeV2Explicit('extension', segments, [
    { id: 'red', value: { name: 'red' } }, { id: 'green', value: { name: 'green' } },
  ], [2, 3]);
  assert.equal(track.segments[2].color_group_id, undefined);
  assert.equal(track.segments[3].color_group_id, 'green');
  assert.equal(track.segments[4].color_group_id, 'green');
  assertV2RoundTrip(project);
});

test('merge extension: adjacent same-color groups keep the color after merging', () => {
  // 用户回归：两次「标记颜色」各建一个组，相邻同色分属两组；跨组边界合并不应丢色。
  const segments = Array.from({ length: 7 }, (_, i) => cue(i));
  segments.slice(0, 2).forEach(segment => { segment.color_group_id = 'red-a'; });
  segments.slice(2, 5).forEach(segment => { segment.color_group_id = 'red-b'; });
  const { project, track } = mergeV2Explicit('extension', segments, [
    { id: 'red-a', value: { name: 'red', value: '#e74c3c' } },
    { id: 'red-b', value: { name: 'red', value: '#e74c3c' } },
  ], [1, 2]);
  const result = track.segments;
  assert.equal(result.length, 6);
  const mergedGroup = project.subtitle_groups.color.find(group => group.id === result[1].color_group_id);
  assert.equal(mergedGroup.value.name, 'red');
  assert.equal(mergedGroup.value.value, '#e74c3c');
  assert.notEqual(mergedGroup.id, 'red-a');
  assert.notEqual(mergedGroup.id, 'red-b');
  assert.equal(result[1].start, 1000);
  assert.equal(result[1].end, 2500);
  assert.equal(result[0].color_group_id, 'red-a');
  assert.equal(result[2].color_group_id, 'red-b');
  assert.equal(result[3].color_group_id, 'red-b');
  assert.equal(result[4].color_group_id, undefined);
  assertV2RoundTrip(project);
});

test('merge main: adjacent same-color groups keep the color on both tracks', () => {
  // 用户场景：主轨（交换副字幕而来）两条红字分属相邻两组，C 合并后主/副轨都保留红色。
  const segments = Array.from({ length: 7 }, (_, i) => cue(i));
  segments.slice(0, 2).forEach(segment => { segment.color_group_id = 'red-a'; });
  segments.slice(2, 5).forEach(segment => { segment.color_group_id = 'red-b'; });
  const { project, track } = mergeV2Explicit('main', segments, [
    { id: 'red-a', value: { name: 'red', value: '#e74c3c' } },
    { id: 'red-b', value: { name: 'red', value: '#e74c3c' } },
  ], [1, 2], { colorMain: true });
  const main = project.tracks.find(item => item.role === 'main');
  assert.equal(main.segments.length, 1);
  for (const segment of [main.segments[0], track.segments[1]]) {
    const group = project.subtitle_groups.color.find(item => item.id === segment.color_group_id);
    assert.equal(group.value.name, 'red');
    assert.equal(group.value.value, '#e74c3c');
    assert.notEqual(group.id, 'red-a');
    assert.notEqual(group.id, 'red-b');
  }
  assertV2RoundTrip(project);
});

test('merge keeps no color when names differ or a member is uncolored', () => {
  const mixedNames = Array.from({ length: 4 }, (_, i) => cue(i));
  mixedNames[0].color_group_id = 'red';
  mixedNames[1].color_group_id = 'green';
  const groups = [{ id: 'red', value: { name: 'red' } }, { id: 'green', value: { name: 'green' } }];
  let { project, track } = mergeV2Explicit('extension', mixedNames, groups, [0, 1]);
  assert.equal(track.segments[0].color_group_id, undefined, '红 + 绿不继承');
  assertV2RoundTrip(project);

  const withUncolored = Array.from({ length: 4 }, (_, i) => cue(i));
  withUncolored[0].color_group_id = 'red';
  ({ project, track } = mergeV2Explicit('extension', withUncolored, structuredClone(groups), [0, 1]));
  assert.equal(track.segments[0].color_group_id, undefined, '红 + 未标记不继承');
  assertV2RoundTrip(project);
});

test('sort preserves distinct same-name group identities and the original cue objects', () => {
  const segments = Array.from({ length: 6 }, (_, i) => cue(i));
  segments.forEach((segment, index) => { segment.color_group_id = index < 3 ? 'red-a' : 'red-b'; });
  const oldHead = segments[0];
  oldHead.start = 1800;
  oldHead.end = 1900;
  const { project, track } = v2Fixture(segments, [
    { id: 'red-a', value: { name: 'red', value: '#aa0000' } },
    { id: 'red-b', value: { name: 'red', value: '#bb0000' } },
  ]);
  const groups = structuredClone(project.subtitle_groups);
  assert.equal(MaweMultiSubtitleCore.sortExtensionTrackSegments(track), true);
  assert.deepEqual(track.segments.map(segment => segment.id), ['cue-1', 'cue-0', 'cue-2', 'cue-3', 'cue-4', 'cue-5']);
  assert.equal(track.segments[1], oldHead);
  assert.deepEqual(track.segments.map(segment => segment.color_group_id), ['red-a', 'red-a', 'red-a', 'red-b', 'red-b', 'red-b']);
  assert.deepEqual(project.subtitle_groups, groups);
  assertV2RoundTrip(project);
});

test('reconcile removes a cue but preserves surviving stable color groups', () => {
  const segments = Array.from({ length: 7 }, (_, i) => cue(i));
  segments.slice(0, 3).forEach(segment => { segment.color_group_id = 'red'; });
  segments.slice(4, 6).forEach(segment => { segment.color_group_id = 'green'; });
  segments[6].start = 0;
  segments[6].end = 600;
  const { project, track } = v2Fixture(segments, [
    { id: 'red', value: { name: 'red', value: '#aa0000' } },
    { id: 'green', value: { name: 'green' } },
  ]);
  const groups = structuredClone(project.subtitle_groups);
  assert.equal(MaweMultiSubtitleCore.reconcileExtensionTrack(track, [segments[6]]).removedCount, 1);
  assert.equal(track.segments.some(segment => segment.id === 'cue-0'), false);
  for (const id of ['cue-1', 'cue-2']) {
    assert.equal(track.segments.find(segment => segment.id === id).color_group_id, 'red');
  }
  for (const id of ['cue-4', 'cue-5']) {
    assert.equal(track.segments.find(segment => segment.id === id).color_group_id, 'green');
  }
  assert.deepEqual(project.subtitle_groups, groups);
  assertV2RoundTrip(project);
});

function boundDragFixture(segments = Array.from({ length: 6 }, (_, index) => cue(index))) {
  const main = { ...cue(1), id: 'main-001' };
  const groups = [
    { id: 'red', value: { name: 'red', value: '#aa0000', metadata: { palette: ['red'] } } },
    { id: 'green', value: { name: 'green', value: '#2ecc71' } },
  ];
  const project = runtimeProject([main], {
    speakers: [], annotation_mode: 'color', palette_size: 5, speaker_shortcuts: {},
    extensions: [{ id: 'translation', segments }],
    subtitle_groups: { next_id: 10, color: groups, sticker: [] },
  });
  globalThis.MaweBoot = { DATA: project };
  const track = project.tracks.find(item => item.role === 'secondary');
  project.bindings.push(AsrEditorUtils.buildSubtitleBinding(main, segments[1], track.id, null, 'main', project.bindings));
  const drag = {
    track: 'main', kind: 'move', indices: [0], allowSqueeze: true,
    originals: new Map([[0, { start: main.start, end: main.end }]]),
  };
  function preview(start) {
    main.start = start;
    main.end = start + 500;
    MaweBoundDrag.syncBoundCueDrag(drag);
  }
  return { project, track, drag, preview };
}

// Dirty flags intentionally persist across previews; timeline values must
// otherwise return exactly, including stable group membership.
function timelineValue(segments) {
  return JSON.parse(JSON.stringify(segments, (key, value) => key === '_dirty' ? undefined : value));
}

test('bound drag: deleting an earlier cue then returning restores stable groups and cue identities', () => {
  const segments = Array.from({ length: 6 }, (_, index) => cue(index));
  segments[4].color_group_id = segments[5].color_group_id = 'green';
  const { project, track, preview } = boundDragFixture(segments);
  const before = timelineValue(track.segments);
  const groups = structuredClone(project.subtitle_groups);
  const originals = track.segments.slice();
  preview(0);
  assert.equal(track.segments.length, 5);
  assert.equal(track.segments[4].color_group_id, 'green');
  preview(1000);
  assert.equal(track.segments.length, 6);
  assert.deepEqual(timelineValue(track.segments), before);
  assert.deepEqual(project.subtitle_groups, groups);
  originals.forEach((segment, index) => assert.equal(track.segments[index], segment));
  assertV2RoundTrip(project);
});

test('bound drag: repeated squeeze previews preserve stable color membership', () => {
  const segments = Array.from({ length: 6 }, (_, index) => cue(index));
  segments[4].color_group_id = segments[5].color_group_id = 'green';
  const { project, track, preview } = boundDragFixture(segments);
  const before = timelineValue(track.segments);
  const groups = structuredClone(project.subtitle_groups);
  for (const start of [0, 0, 1000, 0, 0, 1000]) {
    preview(start);
    assert.equal(track.segments.length, start === 0 ? 5 : 6);
    assert.equal(track.segments.at(-1).color_group_id, 'green');
    assert.deepEqual(project.subtitle_groups, groups);
  }
  assert.deepEqual(timelineValue(track.segments), before);
  assertV2RoundTrip(project);
});

test('bound drag: temporarily removing a group member retains the other members', () => {
  const segments = Array.from({ length: 6 }, (_, index) => cue(index));
  segments.slice(0, 3).forEach(segment => { segment.color_group_id = 'red'; });
  segments.slice(4).forEach(segment => { segment.color_group_id = 'green'; });
  const { project, track, preview } = boundDragFixture(segments);
  const before = timelineValue(track.segments);
  const groups = structuredClone(project.subtitle_groups);
  preview(0);
  assert.equal(track.segments.some(segment => segment.id === 'cue-0'), false);
  for (const id of ['cue-1', 'cue-2']) {
    const member = track.segments.find(segment => segment.id === id);
    assert.equal(member.color_group_id, 'red');
  }
  preview(1000);
  assert.equal(track.segments.length, 6);
  assert.deepEqual(timelineValue(track.segments), before);
  assert.deepEqual(project.subtitle_groups, groups);
  assertV2RoundTrip(project);
});

test('bound drag snapshot restores absent, explicit null and own undefined group fields', () => {
  const originals = [
    {}, { color_group_id: null }, { color_group_metadata: null },
    { color_group_id: null, color_group_metadata: null },
    { color_group_id: undefined, color_group_metadata: undefined },
  ];
  const { track } = v2Fixture(originals.map((fields, index) => ({ ...cue(index), ...fields })), []);
  const drag = { track: 'main' };
  MaweBoundDrag.ensureBoundDragTimelineOriginals(drag);
  track.segments.forEach(segment => {
    segment.color_group_id = 'temporary';
    segment.color_group_metadata = { source: 'temporary' };
  });
  MaweBoundDrag.restoreBoundDragTimelineOriginals(drag);
  const fields = track.segments.map(segment => Object.fromEntries(['color_group_id', 'color_group_metadata']
    .filter(field => Object.hasOwn(segment, field)).map(field => [field, segment[field]])));
  assert.deepEqual(fields, originals);
});

test('bound drag snapshot deep-clones group metadata again on each restoration', () => {
  const segments = Array.from({ length: 6 }, (_, index) => cue(index));
  segments[4].color_group_id = segments[5].color_group_id = 'green';
  segments[4].color_group_metadata = { palette: ['green'] };
  segments[5].color_group_metadata = { source: { name: 'original' } };
  const { track } = v2Fixture(segments, [{ id: 'green', value: { name: 'green' } }]);
  const before = segments.map(segment => structuredClone(segment.color_group_metadata));
  const drag = { track: 'main' };
  MaweBoundDrag.ensureBoundDragTimelineOriginals(drag);
  const entries = drag.boundDragTimelineOriginals.tracks[0].segments;
  for (let pass = 0; pass < 2; pass += 1) {
    track.segments[4].color_group_metadata.palette.push('changed');
    track.segments[5].color_group_metadata.source.name = 'changed';
    assert.deepEqual(entries.map(entry => entry.color_group_metadata), before,
      'preview mutations must not change the snapshot');
    MaweBoundDrag.restoreBoundDragTimelineOriginals(drag);
    assert.deepEqual(track.segments.map(segment => segment.color_group_metadata), before);
    assert.notEqual(track.segments[4].color_group_metadata, entries[4].color_group_metadata);
    assert.notEqual(track.segments[5].color_group_metadata, entries[5].color_group_metadata);
    assert.equal(track.segments[4].color_group_id, 'green');
    assert.equal(track.segments[5].color_group_id, 'green');
  }
});
