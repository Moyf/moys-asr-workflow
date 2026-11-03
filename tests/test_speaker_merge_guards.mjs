import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { loadEditorModule } from './helpers/editor-module-loader.mjs';
import { plainModuleSource } from './helpers/init-module-source.mjs';
import { runtimeProject } from './helpers/runtime-project.mjs';
import * as identity from '../web/shared/utils/speaker-identity.js';
import { createEditorCommands } from '../web/editor/state/editor-commands.js';

const loaded = { window: {} };
loadEditorModule(loaded, 'shared/editor-utils.js');
const baseUtils = loaded.window.AsrEditorUtils;
const plain = value => JSON.parse(JSON.stringify(value));
const cue = (id, speaker, start = 0, end = start + 1000) => ({ id, start, end, text: id,
  ...(speaker === undefined ? {} : { speaker }), items: [{ text: id, start, end }], vendor: { keep: id } });
const conflict = '不同说话人的字幕不能合并，请先统一归属';

function fixture({ main = [], secondary = [], overlay = [], bindings = [] } = {}) {
  const data = runtimeProject(main, { bindings,
    ...(secondary.length ? { extensions: [{ id: 'secondary', segments: secondary }] } : {}),
    ...(overlay.length ? { overlay: { id: 'overlay', segments: overlay } } : {}),
  });
  const effects = { history: 0, commits: 0, selection: 0, panel: 0, bindings: 0, dirty: 0, updates: 0, hints: [] };
  const utils = { ...baseUtils, canMergeSpeakerSegments: identity.canMergeSpeakerSegments };
  const context = { AsrEditorUtils: utils, MaweBoot: { DATA: data },
    MaweMultiSubtitleCore: {
      getMultiSubtitleState: () => data, multiSubtitleVisible: () => secondary.length > 0,
      getActiveExtensionTrack: () => data.tracks.find(track => track.role === 'secondary'),
      getMainSubtitleSplitMode: () => 'continuous', getExtensionSubtitleSplitMode: () => 'continuous',
      mergeJoinSeparatorForMode: () => '', MULTI_SUBTITLE_MERGE_OVERLAP_TOLERANCE_MS: 100,
      removeBindingsForSegmentIds() { effects.bindings++; }, markMultiSubtitleDirty() { effects.dirty++; },
    },
    MaweCommands: { run(_label, mutate) { effects.history++; return mutate({ commit() { effects.commits++; } }); } },
    MaweCoreState: { container: { querySelector: () => null } },
    MaweCueListAnchor: { captureVisibleCueListVisualAnchor: () => null },
    MaweCuePanel: { commitCuePanelEdit() { effects.panel++; }, setCuePanelTarget() { effects.panel++; } },
    MaweCuePanelState: { currentCuePanelIdx: 9, resetCuePanelEditState() { effects.panel++; } },
    MaweSelection: { clearSelection() { effects.selection++; }, selectOnly() { effects.selection++; }, selectOnlyExtension() { effects.selection++; } },
    MaweState: { selection: { clear() { effects.selection++; }, add() { effects.selection++; } } },
    MaweSettings: { EDITOR_SETTINGS: { assSpecialSymbolRule: 'both' } },
    MaweTextCleanup: { syncTimelineGroupRanges() {} }, MaweInlineEdit: {},
    MaweViewUpdates: { invalidate() { effects.updates++; } },
    MaweHint: { flashHint(text) { effects.hints.push(text); } },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL('../web/editor/cues/editor-segment-ops.js', import.meta.url), 'utf8'), context);
  vm.runInContext(plainModuleSource('editor/cues/overlay-track.js'), context);
  return { data, context, effects, utils, api: context.MaweSegmentOps };
}

function rejectsWithoutChanges(f, action) {
  const before = plain(f.data);
  action();
  assert.deepEqual(plain(f.data), before);
  assert.equal(f.context.MaweCuePanelState.currentCuePanelIdx, 9);
  assert.deepEqual(f.effects, { history: 0, commits: 0, selection: 0, panel: 0, bindings: 0, dirty: 0, updates: 0, hints: [conflict] });
}

function useRealTransactions(f) {
  const selected = ['m0', 'm1'];
  f.context.MaweSelection.clearSelection = () => { f.effects.selection++; selected.splice(0); };
  f.context.MaweCommands = createEditorCommands({
    capture: () => ({ data: baseUtils.buildSegmentsHistorySnapshot(f.data), selection: [...selected] }),
    hasChanges: snapshot => JSON.stringify(baseUtils.buildSegmentsHistorySnapshot(f.data)) !== JSON.stringify(snapshot.data),
    publish() { f.effects.history++; },
    restore(snapshot) {
      baseUtils.restoreSegmentsHistorySnapshot(f.data, snapshot.data);
      selected.splice(0, selected.length, ...snapshot.selection);
    },
    refresh() { f.effects.commits++; },
  });
  return selected;
}

for (const speakers of [['a', 'b'], ['a', null], [undefined, 'b']]) {
  test(`main merge refuses ${speakers} before committing pending edits or history`, () => {
    const f = fixture({ main: speakers.map((speaker, i) => cue(`m${i}`, speaker, i * 1000)) });
    rejectsWithoutChanges(f, () => f.api.mergeSegments([0, 1]));
  });
}

for (const linked of [true, false]) {
  test(`main merge checks ${linked ? 'bound out-of-range' : 'overlapping unbound'} secondary identities`, () => {
    const f = fixture({ main: [cue('m0', 'a'), cue('m1', 'a', 1000)],
      secondary: [cue('s0', 'x', linked ? 4000 : 0), cue('s1', 'y', linked ? 5000 : 1000)],
      bindings: linked ? [0, 1].map(i => ({ id: `b${i}`, source: { track_id: 'main', segment_id: `m${i}` },
        target: { track_id: 'secondary', segment_id: `s${i}` }, start_offset_ms: 4000, end_offset_ms: 4000 })) : [],
    });
    rejectsWithoutChanges(f, () => f.api.mergeSegments([0, 1]));
  });
}

test('independent secondary merge refuses a mixed assigned/unassigned selection', () => {
  const f = fixture({ main: [cue('m', 'a')], secondary: [cue('s0', 'a'), cue('s1', null, 1000)] });
  rejectsWithoutChanges(f, () => f.api.mergeExtensionSegments([0, 1]));
});

for (const entry of ['mergeOverlaySegments', 'mergeOverlayCues']) {
  test(`${entry} rejects differing identities before panel detachment or history`, () => {
    const f = fixture({ overlay: [cue('o0', 'a'), cue('o1', 'b', 1000)] });
    rejectsWithoutChanges(f, () => f.context[entry]([0, 1]));
  });
}

test('automatic main merging refuses linked secondary identity loss before snaps or history', () => {
  const f = fixture({ main: [cue('m0', 'a'), cue('m1', 'a', 1000)], secondary: [cue('s0', 'x'), cue('s1', 'y', 1000)] });
  f.utils.planAutoMerge = () => ({ groups: [[0, 1]], snaps: [{ sentinel: true }] });
  rejectsWithoutChanges(f, () => f.api.autoMergeSegments());
});

test('automatic snaps introducing a different secondary identity cancel data, history and selection together', () => {
  const f = fixture({ main: [cue('m0', 'a', 1000, 2000), cue('m1', 'a', 2000, 3000)],
    secondary: [cue('outside', 'x', 0, 900), cue('inside', 'y', 1000, 3000)] });
  const before = plain(f.data);
  const selected = useRealTransactions(f);
  f.utils.planAutoMerge = () => ({ groups: [[0, 1]], snaps: [{ index: 0, edge: 'start', time: 500 }] });
  f.context.MaweMultiSubtitleCore.syncBoundExtensionForMain = () => false;
  assert.equal(f.api.autoMergeSegments(), false);
  assert.deepEqual(plain(f.data), before);
  assert.deepEqual(selected, ['m0', 'm1']);
  assert.equal(f.effects.history, 0);
  assert.equal(f.effects.commits, 0);
  assert.equal(f.effects.selection, 1, 'selection was cleared only after capture, then restored');
  assert.deepEqual(f.effects.hints, [conflict]);
});

test('a later automatic merge guard rolls back earlier successful merges and suppresses success counts', () => {
  const f = fixture({ main: [cue('m0', 'a'), cue('m1', 'a', 1000), cue('m2', 'b', 2000), cue('m3', 'b', 3000)] });
  const before = plain(f.data);
  const selected = useRealTransactions(f);
  f.utils.planAutoMerge = () => ({ groups: [[0, 1], [2, 3]], snaps: [] });
  // A completed later-index merge makes a new earlier conflict observable to
  // the guard. Exercise the loop's refusal result, not a thrown exception.
  f.context.MaweTextCleanup.syncTimelineGroupRanges = () => {
    if (baseUtils.getMainTrack(f.data).segments.length === 3) baseUtils.getMainTrack(f.data).segments[1].speaker = 'changed';
  };
  assert.equal(f.api.autoMergeSegments(), false);
  assert.deepEqual(plain(f.data), before);
  assert.deepEqual(selected, ['m0', 'm1']);
  assert.equal(f.effects.history, 0);
  assert.equal(f.effects.commits, 0);
  assert.deepEqual(f.effects.hints, [conflict]);
});

test('a linked merge may retain a different but internally consistent speaker on each track', () => {
  const f = fixture({ main: [cue('m0', 'a'), cue('m1', 'a', 1000)],
    secondary: [cue('s0', 'b'), cue('s1', 'b', 1000)] });
  f.api.mergeSegments([0, 1]);
  assert.equal(baseUtils.getMainTrack(f.data).segments[0].speaker, 'a');
  assert.equal(baseUtils.getExtensionTrack(f.data).segments[0].speaker, 'b');
  assert.equal(f.data.bindings.length, 1);
  assert.equal(f.effects.history, 1);
  assert.equal(f.effects.commits, 1);
});

for (const speakers of [['a', 'a'], [null, undefined]]) {
  test(`equal identity ${speakers} remains mergeable regardless of null spelling`, () => {
    const f = fixture({ main: speakers.map((speaker, i) => cue(`m${i}`, speaker, i * 1000)) });
    f.api.mergeSegments([0, 1]);
    const merged = baseUtils.getMainTrack(f.data).segments[0];
    assert.equal(baseUtils.getMainTrack(f.data).segments.length, 1);
    assert.equal(merged.speaker ?? null, speakers[0] ?? null);
    assert.equal(merged.text, 'm0m1');
    assert.equal(f.effects.history, 1);
    assert.equal(f.effects.commits, 1);
  });
}
