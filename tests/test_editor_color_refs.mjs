import assert from 'node:assert/strict';
import test from 'node:test';
import { loadEditorModule } from './helpers/editor-module-loader.mjs';
import { initMaweMultiSubtitleCore } from '../web/editor/state/editor-multi-subtitle-core.js';
import { initMaweSegmentOps } from '../web/editor/cues/editor-segment-ops.js';
import { initMaweTextCleanup } from '../web/editor/cues/editor-text-cleanup.js';
import { initMaweBoundDrag } from '../web/editor/cues/editor-bound-drag.js';
import { createEditorCommands } from '../web/editor/state/editor-commands.js';
import { mergeOverlaySegments } from '../web/editor/cues/overlay-track.js';

// Run real domain factories; only their UI/selection bridges are inert. Node
// isolates this file's globals, and these stateful tests run sequentially.
const context = { window: {}, TextDecoder, TextEncoder, Uint8Array };
loadEditorModule(context, 'shared/editor-utils.js');
globalThis.window = globalThis;
globalThis.AsrEditorUtils = context.window.AsrEditorUtils;
const noop = () => {};
globalThis.MaweState = {
  markProjectDirty: noop,
  selection: { clear: noop, add: noop, indices: () => new Set() },
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
function fixture(extension, main = []) {
  const track = { id: 'translation', role: 'extension', split_mode: 'word', segments: extension };
  globalThis.MaweBoot = { DATA: {
    schema: 'moy.asr.project.v1', segments: main,
    multi_subtitle: {
      schema: 'moy.asr.multi_subtitle.v1', enabled: true, display_mode: 'both',
      tracks: [track], bindings: [],
    },
    overlay_track: { enabled: true, segments: [] },
  } };
  MaweMultiSubtitleCore.normalizedMultiSubtitleReference = MaweBoot.DATA.multi_subtitle;
  history = [];
  globalThis.MaweCommands = createEditorCommands({
    capture: () => structuredClone(MaweBoot.DATA),
    hasChanges: (snapshot) => JSON.stringify(snapshot) !== JSON.stringify(MaweBoot.DATA),
    publish: (snapshot) => history.push(snapshot),
    restore: (snapshot) => {
      MaweBoot.DATA = snapshot;
      MaweMultiSubtitleCore.normalizedMultiSubtitleReference = snapshot.multi_subtitle;
    },
    refresh: noop,
  });
  return track;
}

function cue(i) {
  return { id: `cue-${i}`, start: i * 1000, end: i * 1000 + 500, text: `Cue ${i}` };
}

function colored(n = 6) {
  const segments = Array.from({ length: n }, (_, i) => cue(i));
  segments[n - 2].color = {
    name: 'green', value: '#2ecc71', start: segments[n - 2].start, end: segments[n - 1].end,
  };
  segments[n - 1].color_ref = { name: 'green', headIdx: n - 2 };
  return segments;
}

function assertValidColorRefs(segments) {
  segments.forEach((segment, index) => {
    const ref = segment.color_ref;
    if (!ref) return;
    assert.ok(Number.isInteger(ref.headIdx) && ref.headIdx >= 0 && ref.headIdx < index,
      `cue ${index} must reference an earlier head, got ${ref.headIdx}`);
    assert.ok(segments[ref.headIdx].color, `cue ${index} must reference a color head`);
    assert.equal(segments[ref.headIdx].color.name, ref.name);
  });
}

// Main merges select extension cues by their actual overlap, not a mocked list.
const mergeEntrypoints = {
  extension(segments, indexes) {
    const track = fixture(segments);
    assert.equal(MaweSegmentOps.mergeExtensionSegments(indexes), true);
    return track.segments;
  },
  main(segments, indexes) {
    const start = segments[indexes[0]].start;
    const end = segments[indexes.at(-1)].end;
    const track = fixture(segments, [
      { ...cue(20), start, end: start + 500 },
      { ...cue(21), start: start + 1000, end },
    ]);
    MaweSegmentOps.mergeSegments([0, 1]);
    assert.equal(MaweBoot.DATA.multi_subtitle.bindings.length, 1);
    return track.segments;
  },
  overlay(segments, indexes) {
    fixture([]);
    MaweBoot.DATA.overlay_track.segments = segments;
    assert.equal(mergeOverlaySegments(indexes), true);
    return MaweBoot.DATA.overlay_track.segments;
  },
};

// Cover the top-level main track separately from main merges' linked extension.
const colorMergeEntrypoints = {
  mainTrack(segments, indexes) {
    fixture([], segments);
    MaweSegmentOps.mergeSegments(indexes);
    return MaweBoot.DATA.segments;
  },
  linkedExtension: mergeEntrypoints.main,
  extension: mergeEntrypoints.extension,
  overlay: mergeEntrypoints.overlay,
};

function adjacentColorGroups() {
  const segments = Array.from({ length: 9 }, (_, index) => cue(index));
  for (const [headIdx, name, value] of [[0, 'red', '#aa0000'], [3, 'red', '#bb0000'], [6, 'green', '#2ecc71']]) {
    const lastIdx = headIdx === 6 ? 7 : headIdx + 2;
    segments[headIdx].color = { name, value, start: segments[headIdx].start, end: segments[lastIdx].end };
    for (let index = headIdx + 1; index <= lastIdx; index += 1) {
      segments[index].color_ref = { name, headIdx };
    }
  }
  return segments;
}

for (const [name, merge] of Object.entries(colorMergeEntrypoints)) {
  test(`same-color cross-group ${name}: ref/head boundary splits surviving groups and keeps undo snapshot`, () => {
    const segments = adjacentColorGroups();
    const before = structuredClone(segments);
    const result = merge(segments, [2, 3]);
    const value = timelineValue(result); // shared helpers clone objects in a VM realm
    assert.equal(result.length, 8);
    assertValidColorRefs(result);
    assert.deepEqual(value[2].color, { name: 'red', value: '#aa0000', start: 2000, end: 3500 });
    assert.equal(result[2].color_ref, null);
    assert.deepEqual(value[0].color, { name: 'red', value: '#aa0000', start: 0, end: 1500 });
    assert.deepEqual(value[1].color_ref, { name: 'red', headIdx: 0 });
    assert.deepEqual(value[3].color, { name: 'red', value: '#bb0000', start: 4000, end: 5500 });
    assert.deepEqual(value[4].color_ref, { name: 'red', headIdx: 3 });
    assert.deepEqual(value[5].color, before[6].color);
    assert.deepEqual(value[6].color_ref, { name: 'green', headIdx: 5 });
    assert.equal(result[7].color, undefined);
    assert.equal(result[7].color_ref, undefined);
    assert.equal(history.length, 1);
    const snapshot = name === 'mainTrack' ? history[0].segments
      : name === 'overlay' ? history[0].overlay_track.segments : history[0].multi_subtitle.tracks[0].segments;
    assert.deepEqual(snapshot, before);
    result[2].color.value = '#ffffff';
    result[3].color.value = '#ffffff';
    assert.deepEqual(snapshot, before, 'post-merge head edits cannot mutate undo data');
  });

  for (const mixed of ['different-colors', 'uncolored']) {
    test(`same-color cross-group ${name}: ${mixed} does not inherit`, () => {
      const segments = adjacentColorGroups();
      if (mixed === 'different-colors') {
        segments[3].color.name = 'blue';
        segments[4].color_ref.name = 'blue';
        segments[5].color_ref.name = 'blue';
      } else {
        delete segments[2].color_ref;
      }
      const result = merge(segments, [2, 3]);
      assertValidColorRefs(result);
      assert.equal(result[2].color, null);
      assert.equal(result[2].color_ref, null);
      assert.equal(result[3].color.name, mixed === 'different-colors' ? 'blue' : 'red');
    });
  }
}

for (const name of ['mainTrack', 'overlay']) {
  for (const sameStickerGroup of [true, false]) {
    test(`same-color cross-group ${name}: stickers remain strictly ${sameStickerGroup ? 'same-group' : 'cross-group'}`, () => {
      const segments = adjacentColorGroups();
      const sticker = { name: 'demo', value: 'demo.png', start: 0, end: 5500 };
      segments[0].sticker = structuredClone(sticker);
      segments[1].sticker_ref = { name: 'demo', headIdx: 0 };
      segments[2].sticker_ref = { name: 'demo', headIdx: 0 };
      if (sameStickerGroup) segments[3].sticker_ref = { name: 'demo', headIdx: 0 };
      else segments[3].sticker = { ...sticker, start: 3000 };
      segments[4].sticker_ref = { name: 'demo', headIdx: sameStickerGroup ? 0 : 3 };
      segments[5].sticker_ref = { name: 'demo', headIdx: sameStickerGroup ? 0 : 3 };
      const result = colorMergeEntrypoints[name](segments, [2, 3]);
      assert.equal(result[2].color.name, 'red');
      assert.equal(result[2].sticker, null);
      assert.deepEqual(timelineValue(result[2].sticker_ref), sameStickerGroup ? { name: 'demo', headIdx: 0 } : null);
      assert.equal(result[0].sticker.end, sameStickerGroup ? 5500 : 1500);
      if (!sameStickerGroup) {
        assert.equal(result[3].sticker.name, 'demo');
        assert.equal(result[3].sticker.start, 4000);
      }
      for (const [index, segment] of result.entries()) {
        if (!segment.sticker_ref) continue;
        assert.ok(segment.sticker_ref.headIdx < index);
        assert.equal(result[segment.sticker_ref.headIdx].sticker.name, segment.sticker_ref.name);
      }
    });
  }
}

for (const [name, merge] of Object.entries(mergeEntrypoints)) {
  test(`merge ${name}: four of six cues retain the trailing color group`, () => {
    const result = merge(colored(), [0, 1, 2, 3]);
    assert.equal(result.length, 3);
    assertValidColorRefs(result);
    assert.equal(result[1].color.value, '#2ecc71');
    assert.equal(result[2].color_ref.headIdx, 1);
  });

  test(`merge ${name}: true tail merge preserves earlier color refs`, () => {
    const segments = colored();
    segments[0].color = { name: 'red', start: 0, end: 1500 };
    segments[1].color_ref = { name: 'red', headIdx: 0 };
    const result = merge(segments, [4, 5]);
    assert.equal(result.length, 5);
    assertValidColorRefs(result);
    assert.equal(result[1].color_ref.headIdx, 0);
    assert.equal(result[4].color.name, 'green');
  });

  test(`merge ${name}: full same-group merge leaves one head and no refs`, () => {
    const segments = Array.from({ length: 6 }, (_, i) => cue(i));
    segments[0].color = { name: 'red', value: '#aa0000', start: 0, end: 5500 };
    for (const segment of segments.slice(1)) segment.color_ref = { name: 'red', headIdx: 0 };
    const result = merge(segments, [0, 1, 2, 3, 4, 5]);
    assert.equal(result.length, 1);
    assertValidColorRefs(result);
    assert.equal(result[0].color.value, '#aa0000');
    assert.equal(result[0].color_ref, null);
  });
}

test('merge extension: mixed groups promote surviving heads and preserve the undo snapshot', () => {
  const segments = Array.from({ length: 7 }, (_, i) => cue(i));
  segments[0].color = { name: 'red', start: 0, end: 2500 };
  segments[1].color_ref = { name: 'red', headIdx: 0 };
  segments[2].color_ref = { name: 'red', headIdx: 0 };
  segments[3].color = { name: 'green', start: 3000, end: 5500 };
  segments[4].color_ref = { name: 'green', headIdx: 3 };
  segments[5].color_ref = { name: 'green', headIdx: 3 };
  const before = structuredClone(segments);
  const result = mergeEntrypoints.extension(segments, [2, 3]);
  assertValidColorRefs(result);
  assert.equal(result[2].color, null);
  assert.equal(result[3].color.name, 'green');
  assert.equal(result[4].color_ref.headIdx, 3);
  assert.equal(history.length, 1);
  assert.deepEqual(history[0].multi_subtitle.tracks[0].segments, before);
});

test('merge extension: adjacent same-color groups keep the color after merging', () => {
  // 用户回归：两次「标记颜色」各建一个组，相邻同色分属两组；跨组边界合并不应丢色。
  const segments = Array.from({ length: 7 }, (_, i) => cue(i));
  segments[0].color = { name: 'red', value: '#e74c3c', start: 0, end: 1500 };
  segments[1].color_ref = { name: 'red', headIdx: 0 };
  segments[2].color = { name: 'red', value: '#e74c3c', start: 2000, end: 5500 };
  segments[3].color_ref = { name: 'red', headIdx: 2 };
  segments[4].color_ref = { name: 'red', headIdx: 2 };
  const result = mergeEntrypoints.extension(segments, [1, 2]);
  assert.equal(result.length, 6);
  assertValidColorRefs(result);
  assert.equal(result[1].color.name, 'red', '跨组同色合并产物物化自持 head');
  assert.equal(result[1].color.value, '#e74c3c');
  assert.equal(result[1].color.start, 1000);
  assert.equal(result[1].color.end, 2500);
  assert.equal(result[1].color_ref, null);
  assert.equal(result[0].color.name, 'red', '前一个组的 head 保持独立');
  assert.equal(result[2].color.name, 'red', '后一个组的幸存成员晋升新 head');
  assert.equal(result[3].color_ref.headIdx, 2);
  assert.equal(result[4].color_ref, undefined, '未标记段保持未标记');
});

test('merge main: adjacent same-color groups keep the color on both tracks', () => {
  // 用户场景：主轨（交换副字幕而来）两条红字分属相邻两组，C 合并后主/副轨都保留红色。
  const segments = Array.from({ length: 7 }, (_, i) => cue(i));
  segments[0].color = { name: 'red', value: '#e74c3c', start: 0, end: 1500 };
  segments[1].color_ref = { name: 'red', headIdx: 0 };
  segments[2].color = { name: 'red', value: '#e74c3c', start: 2000, end: 5500 };
  segments[3].color_ref = { name: 'red', headIdx: 2 };
  segments[4].color_ref = { name: 'red', headIdx: 2 };
  const start = segments[1].start;
  const end = segments[2].end;
  const track = fixture(segments, [
    { ...cue(20), start, end: start + 500, color: { name: 'red', value: '#e74c3c', start, end: start + 500 } },
    { ...cue(21), start: start + 1000, end, color: { name: 'red', value: '#e74c3c', start: start + 1000, end } },
  ]);
  MaweSegmentOps.mergeContiguousIndices([0, 1]);
  assert.equal(MaweBoot.DATA.segments.length, 1);
  assert.equal(MaweBoot.DATA.segments[0].color.name, 'red', '主轨合并产物保留红色');
  assert.equal(MaweBoot.DATA.segments[0].color.value, '#e74c3c');
  assertValidColorRefs(MaweBoot.DATA.segments);
  assert.equal(track.segments[1].color.name, 'red', '联动副轨合并产物同样保留红色');
  assertValidColorRefs(track.segments);
});

test('merge keeps no color when names differ or a member is uncolored', () => {
  const mixedNames = Array.from({ length: 4 }, (_, i) => cue(i));
  mixedNames[0].color = { name: 'red', start: 0, end: 500 };
  mixedNames[1].color = { name: 'green', start: 1000, end: 1500 };
  let result = mergeEntrypoints.extension(mixedNames, [0, 1]);
  assertValidColorRefs(result);
  assert.equal(result[0].color, null, '红 + 绿不继承');

  const withUncolored = Array.from({ length: 4 }, (_, i) => cue(i));
  withUncolored[0].color = { name: 'red', start: 0, end: 500 };
  result = mergeEntrypoints.extension(withUncolored, [0, 1]);
  assertValidColorRefs(result);
  assert.equal(result[0].color, null, '红 + 未标记不继承');
});

test('sort maps refs by head identity even when distinct heads have the same name', () => {
  const segments = Array.from({ length: 6 }, (_, i) => cue(i));
  segments[0].color = { name: 'red', value: '#aa0000', start: 0, end: 2500 };
  segments[1].color_ref = { name: 'red', headIdx: 0 };
  segments[2].color_ref = { name: 'red', headIdx: 0 };
  segments[3].color = { name: 'red', value: '#bb0000', start: 3000, end: 5500 };
  segments[4].color_ref = { name: 'red', headIdx: 3 };
  segments[5].color_ref = { name: 'red', headIdx: 3 };
  const oldHead = segments[0];
  oldHead.start = 1800;
  oldHead.end = 1900;
  const track = fixture(segments);
  assert.equal(MaweMultiSubtitleCore.sortExtensionTrackSegments(track), true);
  assertValidColorRefs(track.segments);
  assert.equal(track.segments[0].color.value, '#aa0000');
  assert.equal(track.segments[2].color_ref.headIdx, 1);
  assert.equal(track.segments[1], oldHead);
  assert.equal(track.segments[5].color_ref.headIdx, 3);
});

test('reconcile removes a head but preserves member colors and later refs', () => {
  const segments = Array.from({ length: 7 }, (_, i) => cue(i));
  segments[0].color = { name: 'red', value: '#aa0000', start: 0, end: 2500 };
  segments[1].color_ref = { name: 'red', headIdx: 0 };
  segments[2].color_ref = { name: 'red', headIdx: 0 };
  segments[4].color = { name: 'green', start: 4000, end: 5500 };
  segments[5].color_ref = { name: 'green', headIdx: 4 };
  segments[6].start = 0;
  segments[6].end = 600;
  const track = fixture(segments);
  assert.equal(MaweMultiSubtitleCore.reconcileExtensionTrack(track, [segments[6]]).removedCount, 1);
  assertValidColorRefs(track.segments);
  for (const id of ['cue-1', 'cue-2']) {
    assert.equal(track.segments.find(segment => segment.id === id).color.value, '#aa0000');
  }
  assert.equal(track.segments.find(segment => segment.id === 'cue-5').color_ref.headIdx,
    track.segments.findIndex(segment => segment.id === 'cue-4'));
});

function boundDragFixture(segments = colored()) {
  const main = { ...cue(1), id: 'main-001' };
  const track = fixture(segments, [main]);
  MaweBoot.DATA.multi_subtitle.bindings.push(AsrEditorUtils.buildSubtitleBinding(main, segments[1], track.id));
  const drag = {
    track: 'main', kind: 'move', indices: [0], allowSqueeze: true,
    originals: new Map([[0, { start: main.start, end: main.end }]]),
  };
  function preview(start) {
    main.start = start;
    main.end = start + 500;
    MaweBoundDrag.syncBoundCueDrag(drag);
  }
  return { track, drag, preview };
}

// Dirty flags intentionally persist across previews; the timeline and saved
// color fields must return exactly, including absent properties versus null.
function timelineValue(segments) {
  return JSON.parse(JSON.stringify(segments, (key, value) => key === '_dirty' ? undefined : value));
}

function colorFields(segments) {
  return segments.map(segment => Object.fromEntries(['color', 'color_ref']
    .filter(field => Object.hasOwn(segment, field))
    .map(field => [field, structuredClone(segment[field])])));
}

test('bound drag: deleting an earlier cue then returning restores original refs and cue identities', () => {
  const { track, preview } = boundDragFixture();
  const before = timelineValue(track.segments);
  const originals = track.segments.slice();
  preview(0);
  assert.equal(track.segments.length, 5);
  assertValidColorRefs(track.segments);
  assert.equal(track.segments[4].color_ref.headIdx, 3);
  preview(1000);
  assert.equal(track.segments.length, 6);
  assertValidColorRefs(track.segments);
  assert.deepEqual(timelineValue(track.segments), before);
  originals.forEach((segment, index) => assert.equal(track.segments[index], segment));
});

test('bound drag: repeated squeeze previews do not cumulatively shift color refs', () => {
  const { track, drag, preview } = boundDragFixture();
  const before = timelineValue(track.segments);
  for (const start of [0, 0, 1000, 0, 0, 1000]) {
    preview(start);
    assertValidColorRefs(track.segments);
    assert.equal(track.segments.length, start === 0 ? 5 : 6);
    assert.equal(track.segments.at(-1).color_ref.headIdx, start === 0 ? 3 : 4);
  }
  assert.deepEqual(timelineValue(track.segments), before);
  const entries = drag.boundDragTimelineOriginals.tracks[0].segments;
  assert.deepEqual(colorFields(entries), colorFields(before));
});

test('bound drag: temporarily deleting a head materializes colors only for that preview', () => {
  const segments = colored();
  segments[0].color = { name: 'red', value: '#aa0000', start: 0, end: 2500 };
  segments[1].color = null;
  segments[1].color_ref = { name: 'red', headIdx: 0 };
  segments[2].color_ref = { name: 'red', headIdx: 0 };
  const { track, preview } = boundDragFixture(segments);
  const before = timelineValue(track.segments);
  preview(0);
  assert.equal(track.segments.some(segment => segment.id === 'cue-0'), false);
  for (const id of ['cue-1', 'cue-2']) {
    const member = track.segments.find(segment => segment.id === id);
    assert.equal(member.color.value, '#aa0000');
    assert.equal(member.color_ref, null);
  }
  assertValidColorRefs(track.segments);
  preview(1000);
  assert.equal(track.segments.length, 6);
  assertValidColorRefs(track.segments);
  assert.deepEqual(timelineValue(track.segments), before);
  assert.equal(track.segments[1].color, null);
  assert.equal(Object.hasOwn(track.segments[2], 'color'), false);
});

test('bound drag snapshot restores absent, explicit null and own undefined color fields', () => {
  const originals = [
    {}, { color: null }, { color_ref: null }, { color: null, color_ref: null },
    { color: undefined, color_ref: undefined },
  ];
  const track = fixture(originals.map((fields, index) => ({ ...cue(index), ...fields })));
  const drag = { track: 'main' };
  MaweBoundDrag.ensureBoundDragTimelineOriginals(drag);
  track.segments.forEach(segment => {
    segment.color = { name: 'temporary' };
    segment.color_ref = { name: 'temporary', headIdx: 0 };
  });
  MaweBoundDrag.restoreBoundDragTimelineOriginals(drag);
  assert.deepEqual(colorFields(track.segments), originals);
});

test('bound drag snapshot deep-clones colors and refs again on each restoration', () => {
  const segments = colored();
  segments[4].color.metadata = { palette: ['green'] };
  segments[5].color_ref.metadata = { source: { name: 'original' } };
  const track = fixture(segments);
  const before = colorFields(segments);
  const drag = { track: 'main' };
  MaweBoundDrag.ensureBoundDragTimelineOriginals(drag);
  const entries = drag.boundDragTimelineOriginals.tracks[0].segments;
  for (let pass = 0; pass < 2; pass += 1) {
    track.segments[4].color.value = '#ffffff';
    track.segments[4].color.metadata.palette.push('changed');
    track.segments[5].color_ref.headIdx = 3;
    track.segments[5].color_ref.metadata.source.name = 'changed';
    assert.deepEqual(colorFields(entries), before, 'preview mutations must not change the snapshot');
    MaweBoundDrag.restoreBoundDragTimelineOriginals(drag);
    assert.deepEqual(colorFields(track.segments), before);
    assert.notEqual(track.segments[4].color, entries[4].color);
    assert.notEqual(track.segments[5].color_ref, entries[5].color_ref);
    assertValidColorRefs(track.segments);
  }
});
