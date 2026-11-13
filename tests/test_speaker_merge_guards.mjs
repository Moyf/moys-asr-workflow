import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { loadEditorModule } from './helpers/editor-module-loader.mjs';
import { initModuleSource, plainModuleSource } from './helpers/init-module-source.mjs';
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
const speakerSync = '副字幕说话人已按主字幕统一';

function fixture({ main = [], secondary = [], overlay = [], bindings = [], language = 'zh' } = {}) {
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
      mergeJoinSeparatorForMode: () => '', MULTI_SUBTITLE_MERGE_OVERLAP_TOLERANCE_MS: 500,
      removeBindingsForSegmentIds() { effects.bindings++; }, markMultiSubtitleDirty() { effects.dirty++; },
      boundSyncImpactText: () => '',
    },
    MaweCommands: { run(_label, mutate) { effects.history++; return mutate({ commit() { effects.commits++; } }); } },
    MaweCoreState: { container: { querySelector: () => null } },
    MaweCueListAnchor: { captureVisibleCueListVisualAnchor: () => null },
    MaweCuePanel: { commitCuePanelEdit() { effects.panel++; }, setCuePanelTarget() { effects.panel++; } },
    MaweCuePanelState: { currentCuePanelIdx: 9, resetCuePanelEditState() { effects.panel++; } },
    MaweSelection: { clearSelection() { effects.selection++; }, selectOnly() { effects.selection++; }, selectOnlyExtension() { effects.selection++; } },
    MaweState: { selection: { clear() { effects.selection++; }, add() { effects.selection++; } } },
    MaweSettings: { EDITOR_SETTINGS: { assSpecialSymbolRule: 'both' },
      clampAutoMergeGapMs: Number, clampAutoMergeShortCount: Number },
    MaweDom: { autoMergeGapMsInput: { value: '300' }, autoMergeSnapDirectionSelect: { value: 'backward' },
      autoMergeAbsorbShortToggle: { checked: false }, autoMergeShortCountInput: { value: '2' },
      autoMergeAbsorbDirectionSelect: { value: 'previous' } },
    MaweTextCleanup: { syncTimelineGroupRanges() {} }, MaweInlineEdit: {},
    MaweViewUpdates: { invalidate() { effects.updates++; } },
    MaweHint: { flashHint(text) { effects.hints.push(text); } },
  };
  context.window = context;
  vm.runInNewContext(readFileSync(new URL('../web/shared/editor-i18n.js', import.meta.url), 'utf8'), context);
  const translateText = context.MAWE_I18N.translateText;
  context.MAWE_I18N.translateText = text => translateText(text, language);
  vm.createContext(context);
  vm.runInContext(initModuleSource('editor/cues/editor-segment-ops.js'), context);
  vm.runInContext(plainModuleSource('editor/cues/overlay-track.js'), context);
  return { data, context, effects, utils, api: context.MaweSegmentOps };
}

function rejectsWithoutChanges(f, action, message = conflict) {
  const before = plain(f.data);
  action();
  assert.deepEqual(plain(f.data), before);
  assert.equal(f.context.MaweCuePanelState.currentCuePanelIdx, 9);
  assert.deepEqual(f.effects, { history: 0, commits: 0, selection: 0, panel: 0, bindings: 0, dirty: 0, updates: 0, hints: [message] });
}

function useRealTransactions(f) {
  const selected = ['m0', 'm1'];
  const past = [], future = [];
  const snapshot = () => ({ data: baseUtils.buildSegmentsHistorySnapshot(f.data), selection: [...selected] });
  const restore = record => {
    baseUtils.restoreSegmentsHistorySnapshot(f.data, record.data);
    selected.splice(0, selected.length, ...record.selection);
  };
  f.context.MaweSelection.clearSelection = () => { f.effects.selection++; selected.splice(0); };
  f.context.MaweCommands = createEditorCommands({
    capture: snapshot,
    hasChanges: snapshot => JSON.stringify(baseUtils.buildSegmentsHistorySnapshot(f.data)) !== JSON.stringify(snapshot.data),
    publish(record) { f.effects.history++; past.push(record); future.length = 0; },
    restore,
    refresh() { f.effects.commits++; },
  });
  f.undo = () => { future.push(snapshot()); restore(past.pop()); };
  f.redo = () => { past.push(snapshot()); restore(future.pop()); };
  return selected;
}

for (const speakers of [['a', 'b'], ['a', null], [undefined, 'b']]) {
  test(`main merge refuses ${speakers} before committing pending edits or history`, () => {
    const f = fixture({ main: speakers.map((speaker, i) => cue(`m${i}`, speaker, i * 1000)) });
    rejectsWithoutChanges(f, () => f.api.mergeSegments([0, 1]));
  });
}

for (const linked of [true, false]) {
  test(`main merge unifies ${linked ? 'bound out-of-range' : 'overlapping unbound'} secondary identities`, () => {
    const f = fixture({ main: [cue('m0', 'a'), cue('m1', 'a', 1000)],
      secondary: [cue('s0', 'x', linked ? 4000 : 0), cue('s1', 'y', linked ? 5000 : 1000)],
      bindings: linked ? [0, 1].map(i => ({ id: `b${i}`, source: { track_id: 'main', segment_id: `m${i}` },
        target: { track_id: 'secondary', segment_id: `s${i}` }, start_offset_ms: 4000, end_offset_ms: 4000 })) : [],
    });
    f.api.mergeSegments([0, 1]);
    assert.equal(baseUtils.getMainTrack(f.data).segments.length, 1);
    assert.equal(baseUtils.getExtensionTrack(f.data).segments.length, 1);
    assert.equal(baseUtils.getExtensionTrack(f.data).segments[0].speaker, 'a');
    assert.match(f.effects.hints[0], new RegExp(speakerSync));
    assert.equal(f.effects.history, 1);
  });
}

for (const language of ['zh', 'en']) {
  test(`role-based main merge unifies secondary speakers with a ${language} notification`, () => {
    const f = fixture({ language,
      main: [cue('m0', 'spk2', 1240, 2050), cue('m1', 'spk2', 2050, 3740)],
      secondary: [cue('s0', 'spk1', 480, 1520), cue('s1', 'spk4', 1720, 2760), cue('s2', 'spk3', 2760, 3880)],
    });
    baseUtils.getMainTrack(f.data).id = 'extension-1';
    baseUtils.getExtensionTrack(f.data).id = 'main';
    f.data.bilingual.active_track_id = 'main';
    const excluded = plain(baseUtils.getExtensionTrack(f.data).segments[0]);
    f.api.mergeSegments([0, 1]);
    const secondary = baseUtils.getExtensionTrack(f.data).segments;
    assert.equal(baseUtils.getMainTrack(f.data).segments[0].speaker, 'spk2');
    assert.equal(secondary.length, 2);
    assert.deepEqual(plain(secondary[0]), excluded, '280ms overlap must not participate');
    assert.equal(secondary[1].speaker, 'spk2');
    assert.equal(secondary[1].text, 's1s2');
    assert.deepEqual(plain(secondary[1].items.map(item => item.text)), ['s1', 's2']);
    assert.equal(f.data.bindings[0].source.track_id, 'extension-1');
    assert.equal(f.data.bindings[0].target.track_id, 'main');
    assert.match(f.effects.hints[0], language === 'zh' ? new RegExp(speakerSync) : /Secondary subtitle speakers now match the main subtitles/);
  });
}

for (const overlap of [499, 500]) {
  test(`unbound secondary overlap of ${overlap}ms respects the inclusive 500ms threshold`, () => {
    const f = fixture({ main: [cue('m0', 'a', 1000, 2000), cue('m1', 'a', 2000, 3000)],
      secondary: [cue('s0', 'x', 0, 1000 + overlap), cue('s1', 'y', 2000, 3000)] });
    if (overlap === 500) {
      f.api.mergeSegments([0, 1]);
      assert.equal(baseUtils.getExtensionTrack(f.data).segments.length, 1);
      assert.equal(baseUtils.getExtensionTrack(f.data).segments[0].speaker, 'a');
      assert.match(f.effects.hints[0], new RegExp(speakerSync));
    } else {
      f.api.mergeSegments([0, 1]);
      assert.equal(baseUtils.getMainTrack(f.data).segments.length, 1);
      assert.equal(baseUtils.getExtensionTrack(f.data).segments[0].speaker, 'x');
      assert.equal(baseUtils.getExtensionTrack(f.data).segments[1].speaker, 'a');
      assert.equal(f.effects.commits, 1);
    }
  });
}

test('independent secondary speaker conflict uses the existing English translation mechanism', () => {
  const f = fixture({ language: 'en', secondary: [cue('s0', 'a'), cue('s1', 'b', 1000)] });
  rejectsWithoutChanges(f, () => f.api.mergeExtensionSegments([0, 1]),
    'Subtitles with different speakers cannot be merged; assign them to the same speaker first.');
});

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

test('automatic main merging unifies linked secondary speakers in one transaction', () => {
  const f = fixture({ main: [cue('m0', 'a'), cue('m1', 'a', 1000)], secondary: [cue('s0', 'x'), cue('s1', 'y', 1000)] });
  f.utils.planAutoMerge = () => ({ groups: [[0, 1]], snaps: [] });
  assert.equal(f.api.autoMergeSegments(), true);
  assert.equal(baseUtils.getExtensionTrack(f.data).segments[0].speaker, 'a');
  assert.equal(baseUtils.getExtensionTrack(f.data).segments.length, 1);
  assert.equal(f.effects.history, 1);
  assert.match(f.effects.hints[0], new RegExp(speakerSync));
});

test('automatic snaps introducing a different main identity cancel data, history and selection together', () => {
  const f = fixture({ main: [cue('m0', 'a', 1000, 2000), cue('m1', 'a', 2000, 3000)],
    secondary: [cue('outside', 'x', 0, 1000), cue('inside', 'y', 1000, 3000)] });
  const before = plain(f.data);
  const selected = useRealTransactions(f);
  f.utils.planAutoMerge = () => ({ groups: [[0, 1]], snaps: [{ index: 0, edge: 'start', time: 500 }] });
  f.context.MaweMultiSubtitleCore.syncBoundExtensionForMain = () => {
    baseUtils.getMainTrack(f.data).segments[1].speaker = 'changed';
    return false;
  };
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

test('a linked merge updates even an internally consistent secondary speaker to the main speaker', () => {
  const f = fixture({ main: [cue('m0', 'a'), cue('m1', 'a', 1000)],
    secondary: [cue('s0', 'b'), cue('s1', 'b', 1000)] });
  f.api.mergeSegments([0, 1]);
  assert.equal(baseUtils.getMainTrack(f.data).segments[0].speaker, 'a');
  assert.equal(baseUtils.getExtensionTrack(f.data).segments[0].speaker, 'a');
  assert.match(f.effects.hints[0], new RegExp(speakerSync));
  assert.equal(f.data.bindings.length, 1);
  assert.equal(f.effects.history, 1);
  assert.equal(f.effects.commits, 1);
});

for (const speaker of ['a', undefined]) {
  test(`a single secondary cue follows main identity ${speaker} and survives undo/redo serialization`, () => {
    const f = fixture({ main: [cue('m0', speaker), cue('m1', speaker, 1000)], secondary: [cue('s0', 'b', 0, 2000)] });
    f.data.speakers = ['a', 'b'].map(id => ({ id, name: id, color: '#123456' }));
    const before = plain(f.data);
    useRealTransactions(f);
    f.api.mergeSegments([0, 1]);
    const merged = baseUtils.getExtensionTrack(f.data).segments[0];
    assert.equal(merged.speaker, speaker);
    if (speaker === undefined) assert.equal(Object.hasOwn(merged, 'speaker'), false);
    assert.equal(merged.text, 's0');
    assert.deepEqual(plain(merged.items), before.tracks.find(t => t.role === 'secondary').segments[0].items);
    assert.match(f.effects.hints[0], new RegExp(speakerSync));
    const after = plain(f.data);
    f.undo(); assert.deepEqual(plain(f.data), before);
    f.redo(); assert.deepEqual(plain(f.data), after);
    const reopened = baseUtils.importProject(JSON.parse(JSON.stringify(baseUtils.snapshotProjectContent(f.data)))).project;
    assert.equal(baseUtils.getExtensionTrack(reopened).segments[0].speaker, speaker);
    assert.equal(reopened.bindings.length, 1);
    assert.equal(f.effects.history, 1);
  });
}

test('matching secondary identity adds no unnecessary speaker notice', () => {
  const f = fixture({ main: [cue('m0', 'a'), cue('m1', 'a', 1000)], secondary: [cue('s0', 'a', 0, 2000)] });
  f.api.mergeSegments([0, 1]);
  assert.deepEqual(f.effects.hints, ['已合并 2 条']);
});

test('unassigned main merges clear all differing secondary identities with a success notice', () => {
  const f = fixture({ main: [cue('m0', null), cue('m1', undefined, 1000)],
    secondary: [cue('s0', 'b'), cue('s1', 'c', 1000)] });
  let type;
  f.context.MaweHint.flashHint = (text, value) => { f.effects.hints.push(text); type = value; };
  f.api.mergeSegments([0, 1]);
  const secondary = baseUtils.getExtensionTrack(f.data).segments;
  assert.equal(secondary.length, 1);
  assert.equal(Object.hasOwn(secondary[0], 'speaker'), false);
  assert.equal(secondary[0].text, 's0s1');
  assert.match(f.effects.hints[0], new RegExp(speakerSync));
  assert.equal(type, 'success', 'identity synchronization is informational, not a failed-merge warning');
});

for (const mode of ['color', 'speaker']) {
  test(`linked merge retains each track's color groups while ${mode} mode resolves identity correctly`, () => {
    const f = fixture({ main: [cue('m0', 'a'), cue('m1', 'a', 1000)],
      secondary: [cue('s0', 'b'), cue('s1', 'c', 1000)] });
    f.data.annotation_mode = mode;
    f.data.speakers = ['a', 'b', 'c'].map((id, i) => ({ id, name: id, color: ['#112233', '#445566', '#778899'][i] }));
    const main = baseUtils.getMainTrack(f.data), secondary = baseUtils.getExtensionTrack(f.data);
    baseUtils.assignSubtitleGroup(f.data, main.segments, [0, 1], 'color', { name: 'green', value: '#66bb6a' });
    baseUtils.assignSubtitleGroup(f.data, secondary.segments, [0, 1], 'color', { name: 'red', value: '#f07f6f' });
    const groups = plain(f.data.subtitle_groups);
    f.api.mergeSegments([0, 1]);
    assert.equal(secondary.segments[0].speaker, 'a');
    assert.equal(baseUtils.getSubtitleGroupValue(f.data, main.segments[0]).name, 'green');
    assert.equal(baseUtils.getSubtitleGroupValue(f.data, secondary.segments[0]).name, 'red');
    assert.deepEqual(plain(f.data.subtitle_groups), groups);
    assert.equal(baseUtils.effectiveSegmentColor(f.data, secondary.segments[0], secondary.segments).value,
      mode === 'speaker' ? '#112233' : '#f07f6f');
  });
}

test('automatic snaps may introduce a different secondary speaker without blocking the merge', () => {
  const f = fixture({ main: [cue('m0', 'a', 1000, 2000), cue('m1', 'a', 2000, 3000)],
    secondary: [cue('outside', 'x', 0, 1000), cue('inside', 'y', 1000, 3000)] });
  f.utils.planAutoMerge = () => ({ groups: [[0, 1]], snaps: [{ index: 0, edge: 'start', time: 500 }] });
  f.context.MaweMultiSubtitleCore.syncBoundExtensionForMain = () => false;
  assert.equal(f.api.autoMergeSegments(), true);
  assert.equal(baseUtils.getExtensionTrack(f.data).segments.length, 1);
  assert.equal(baseUtils.getExtensionTrack(f.data).segments[0].speaker, 'a');
  assert.equal(baseUtils.getExtensionTrack(f.data).segments[0].text, 'outsideinside');
  assert.match(f.effects.hints[0], new RegExp(speakerSync));
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

test('same-name same-color identities remain distinct for linked merges with indexed and linear binding lookup', () => {
  for (const indexed of [true, false]) {
    baseUtils.setBindingIndexEnabled(indexed);
    try {
      const f = fixture({ main: [cue('m0', 'a'), cue('m1', 'a', 1000)],
        secondary: [cue('s0', 'a', 4000), cue('s1', 'b', 5000)],
        bindings: [0, 1].map(i => ({ id: `b${i}`, source: { track_id: 'main', segment_id: `m${i}` },
          target: { track_id: 'secondary', segment_id: `s${i}` }, start_offset_ms: 4000, end_offset_ms: 4000 })) });
      f.data.speakers = [{ id: 'a', name: 'same', color: '#f9ca1f' }, { id: 'b', name: 'same', color: '#f9ca1f' }];
      baseUtils.rebuildBindingOffsets(f.data);
      f.api.mergeSegments([0, 1]);
      assert.equal(baseUtils.getExtensionTrack(f.data).segments[0].speaker, 'a');
      assert.match(f.effects.hints[0], new RegExp(speakerSync));
    } finally { baseUtils.setBindingIndexEnabled(true); }
  }
});
