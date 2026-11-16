import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { createUtilsModule as createGroups } from '../web/shared/utils/subtitle-groups.js';
import { createUtilsModule as createMulti } from '../web/shared/utils/multi-subtitle.js';
import { projectModel, runtimeProject } from './helpers/runtime-project.mjs';
import { invokedInitModuleSource, plainModuleSource } from './helpers/init-module-source.mjs';

const cue = (id, index, color) => ({
  id, start: index * 1000, end: (index + 1) * 1000, text: id,
  ...(color ? { color_group_id: color } : {}),
});

function fixture() {
  const main = [cue('m1', 0, 'red-1'), cue('m2', 1, 'red-2'), cue('m3', 2, 'red-1')];
  const extension = [cue('e1', 0, 'red-1'), cue('e2', 1, 'red-2'), cue('e3', 2, 'red-1')];
  const overlay = [cue('o1', 0, 'red-1'), cue('o2', 1, 'red-2'), cue('o3', 2, 'red-1')];
  const project = runtimeProject(main, {
    speakers: [], annotation_mode: 'color', palette_size: 5, speaker_shortcuts: {},
    overlay: { id: 'overlay', segments: overlay },
    extensions: [{ id: 'en', segments: extension }],
    subtitle_groups: { next_id: 4, sticker: [], color: [
      { id: 'red-1', value: { name: 'red', value: '#f00', extra: { kept: true } } },
      { id: 'red-2', value: { name: 'red', value: '#f00' } },
      { id: 'blue', value: { name: 'blue', value: '#00f' } },
    ] },
    bindings: [0, 1].map(i => ({ id: `binding-${i}`,
      source: { track_id: 'main', segment_id: main[i].id },
      target: { track_id: 'en', segment_id: extension[i].id },
      start_offset_ms: 0, end_offset_ms: 0 })),
  });
  const groups = createGroups({ cloneJsonValue: structuredClone });
  const utils = createMulti({ cloneJsonValue: structuredClone, stableId: value => value, getProject: () => context.MaweBoot.DATA });
  const history = [];
  const noop = () => {};
  const context = {
    MaweBoot: { DATA: project },
    AsrEditorUtils: {
      ...groups, ...utils, ...projectModel, cloneJsonValue: structuredClone,
      getOverlayTrack: data => data.tracks.find(track => track.role === 'overlay'),
      canMergeSpeakerSegments: () => true,
      joinSegmentTextsMassFold: segments => ({ text: segments.map(segment => segment.text).join(' '), items: [] }),
    },
    MaweSettings: { EDITOR_SETTINGS: { multiSubtitleAutoSyncDuration: false } },
    MaweSelection: { clearSelection: noop, lastClickedExtensionIdx: -1 },
    MaweState: { selection: { clear: noop, add: noop } },
    MaweCoreState: { container: { querySelector: () => null } },
    MaweCueListAnchor: { captureVisibleCueListVisualAnchor: () => null },
    MaweCuePanel: { setCuePanelTarget: noop },
    MaweViewUpdates: { invalidate: noop },
    MaweHint: { flashHint: noop },
    clearSelection: noop, selectOnly: noop, selectOnlyExtension: noop, commitCuePanelEdit: noop,
    captureVisibleCueListVisualAnchor: () => null, syncTimelineGroupRanges: noop,
    MaweCommands: { run(_label, callback) {
      history.push(structuredClone(context.MaweBoot.DATA));
      return callback({ commit: noop, cancel: noop });
    } },
    MaweMultiSubtitleCore: {
      MULTI_SUBTITLE_MERGE_OVERLAP_TOLERANCE_MS: 500,
      getMultiSubtitleState: () => context.MaweBoot.DATA,
      getActiveExtensionTrack: () => context.MaweBoot.DATA.tracks.find(track => track.role === 'secondary'),
      multiSubtitleVisible: () => true,
      getMainSubtitleSplitMode: () => 'continuous',
      getExtensionSubtitleSplitMode: () => 'continuous',
      mergeJoinSeparatorForMode: () => '',
      removeBindingsForSegmentIds(mainIds, extensionIds) {
        context.MaweBoot.DATA.bindings = context.MaweBoot.DATA.bindings.filter(binding =>
          !mainIds.includes(binding.source.segment_id) && !extensionIds.includes(binding.target.segment_id));
      },
      markMultiSubtitleDirty: noop,
      boundSyncImpactText: () => '',
    },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(invokedInitModuleSource('editor/cues/editor-segment-ops.js', 'initMaweSegmentOps'), context);
  vm.runInContext(plainModuleSource('editor/cues/overlay-track.js'), context);
  return { context, history, original: structuredClone(project) };
}

function assertRoundTrip(project) {
  const saved = projectModel.snapshotProjectContent(project);
  const validation = projectModel.validateTracksProject(saved);
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  assert.deepEqual(projectModel.importProject(saved).project, saved);
  for (const track of saved.tracks) for (const segment of track.segments) {
    assert.equal(Object.hasOwn(segment, 'color'), false);
    assert.equal(Object.hasOwn(segment, 'color_ref'), false);
  }
}

function assertIndependentRed(project, track) {
  const merged = track.segments[0];
  assert.ok(merged.color_group_id);
  assert.notEqual(merged.color_group_id, 'red-1');
  assert.notEqual(merged.color_group_id, 'red-2');
  const group = project.subtitle_groups.color.find(entry => entry.id === merged.color_group_id);
  assert.deepEqual(group.value, { name: 'red', value: '#f00', extra: { kept: true } });
  assert.equal(track.segments[1].color_group_id, 'red-1');
}

test('main merge preserves same-color groups on both linked tracks in one transaction', () => {
  const { context, history, original } = fixture();
  context.MaweSegmentOps.mergeSegments([0, 1]);
  assert.equal(history.length, 1);
  assert.deepEqual(history[0], original);
  const project = context.MaweBoot.DATA;
  assertIndependentRed(project, project.tracks.find(track => track.role === 'main'));
  assertIndependentRed(project, project.tracks.find(track => track.role === 'secondary'));
  assert.equal(project.bindings.length, 1);
  assertRoundTrip(project);
});

test('direct secondary merge gives different same-color groups a fresh canonical group', () => {
  const { context, history, original } = fixture();
  context.MaweSegmentOps.mergeExtensionSegments([0, 1]);
  assert.equal(history.length, 1);
  assert.deepEqual(history[0], original);
  assertIndependentRed(context.MaweBoot.DATA, context.MaweBoot.DATA.tracks.find(track => track.role === 'secondary'));
  assert.equal(context.MaweBoot.DATA.bindings.length, 0);
  assertRoundTrip(context.MaweBoot.DATA);
});

test('overlay merge retains a fresh same-color group without legacy refs', () => {
  const { context, history, original } = fixture();
  context.mergeOverlaySegments([0, 1]);
  assert.equal(history.length, 1);
  assert.deepEqual(history[0], original);
  assertIndependentRed(context.MaweBoot.DATA, context.MaweBoot.DATA.tracks.find(track => track.role === 'overlay'));
  assertRoundTrip(context.MaweBoot.DATA);
});

test('merging different colors does not create an invalid group reference', () => {
  const { context } = fixture();
  const track = context.MaweBoot.DATA.tracks.find(item => item.role === 'overlay');
  track.segments[1].color_group_id = 'blue';
  context.mergeOverlaySegments([0, 1]);
  assert.equal(Object.hasOwn(track.segments[0], 'color_group_id'), false);
  assertRoundTrip(context.MaweBoot.DATA);
});

test('merging the same group preserves its ID and remaining members', () => {
  const { context } = fixture();
  const project = context.MaweBoot.DATA;
  const track = project.tracks.find(item => item.role === 'secondary');
  track.segments[1].color_group_id = 'red-1';
  context.MaweSegmentOps.mergeExtensionSegments([0, 1]);
  assert.equal(track.segments[0].color_group_id, 'red-1');
  assert.equal(track.segments[1].color_group_id, 'red-1');
  assert.equal(project.subtitle_groups.next_id, 4);
  assertRoundTrip(project);
});

test('merging an uncolored cue does not inherit the other cue color', () => {
  const { context } = fixture();
  const track = context.MaweBoot.DATA.tracks.find(item => item.role === 'overlay');
  delete track.segments[1].color_group_id;
  context.mergeOverlaySegments([0, 1]);
  assert.equal(Object.hasOwn(track.segments[0], 'color_group_id'), false);
  assert.equal(track.segments[1].color_group_id, 'red-1');
  assertRoundTrip(context.MaweBoot.DATA);
});

test('cross-group secondary merge preserves surviving groups with the same name', () => {
  const { context, history } = fixture();
  const project = context.MaweBoot.DATA;
  const track = project.tracks.find(item => item.role === 'secondary');
  const otherGroup = project.subtitle_groups.color.find(group => group.id === 'red-2');
  otherGroup.value.value = '#b00';
  track.segments.push(cue('e4', 3, 'red-2'));
  const before = structuredClone(project);

  assert.equal(context.MaweSegmentOps.mergeExtensionSegments([0, 1]), true);
  assert.deepEqual(history[0], before);
  assert.equal(track.segments.length, 3);
  assert.equal(track.segments[1].color_group_id, 'red-1');
  assert.equal(track.segments[2].color_group_id, 'red-2');
  assert.deepEqual(project.subtitle_groups.color.find(group => group.id === 'red-2'),
    before.subtitle_groups.color.find(group => group.id === 'red-2'));
  const mergedGroup = project.subtitle_groups.color.find(group => group.id === track.segments[0].color_group_id);
  assert.notEqual(mergedGroup.id, 'red-1');
  assert.notEqual(mergedGroup.id, 'red-2');
  assert.deepEqual(mergedGroup.value, before.subtitle_groups.color.find(group => group.id === 'red-1').value);
  assertRoundTrip(project);
});
