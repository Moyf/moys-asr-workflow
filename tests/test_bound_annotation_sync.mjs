import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { loadEditorModule } from './helpers/editor-module-loader.mjs';
import { invokedInitModuleSource } from './helpers/init-module-source.mjs';
import { runtimeProject } from './helpers/runtime-project.mjs';
import { createEditorCommands } from '../web/editor/state/editor-commands.js';
import * as experience from '../web/shared/utils/speaker-experience.js';

const loaded = { window: {} };
loadEditorModule(loaded, 'shared/editor-utils.js');
const utils = loaded.window.AsrEditorUtils;
const copy = value => JSON.parse(JSON.stringify(value));
const cue = (id, start = 0, end = start + 1000) => ({ id, start, end, text: id, speaker: 'old', items: [{ start, end, text: id }] });
const mainIndices = [0, 2];
const mainRefs = () => ['m0', 'm2'].map(segment_id => ({ track_id: 'extension-1', segment_id }));

function fixture(mode = 'speaker') {
  const data = runtimeProject([cue('m0', 0, 2000), cue('m1', 2000), cue('m2', 3000)], {
    extensions: [{ id: 'main', enabled: false, segments: [cue('bound', 0, 500), cue('overlap', 500, 1000), cue('hidden', 3000)] }],
    overlay: { segments: [cue('overlay')] }, annotation_mode: mode, palette_size: 9,
    speakers: [{ id: 'old', name: 'Old', color: '#123456' }, { id: 'new', name: 'New', color: '#654321' }],
    speaker_shortcuts: {},
  });
  utils.getMainTrack(data).id = 'extension-1';
  data.bilingual.display_mode = 'main';
  data.bilingual.active_track_id = 'main';
  data.bindings = ['m0', 'm2'].map((segment_id, index) => ({ id: `binding-${index}`,
    source: { track_id: 'extension-1', segment_id },
    target: { track_id: 'main', segment_id: index ? 'hidden' : 'bound' }, start_offset_ms: 0, end_offset_ms: index ? 0 : -1500 }));
  const past = [], future = [];
  const restore = snapshot => {
    for (const key of Object.keys(data)) delete data[key];
    Object.assign(data, copy(snapshot));
  };
  const colors = Object.fromEntries(experience.SPEAKER_SHORTCUT_COLORS.map((name, i) => [name,
    { name, label: name, value: ['#f9ca1f', '#66bb6a', '#f07f6f', '#bf89e6', '#61a7fa', '#f2a65a', '#49c5c1', '#d675b9', '#969fab'][i] }]));
  const context = { ...experience, AsrEditorUtils: utils, MaweBoot: { DATA: data },
    MaweSettings: { EDITOR_SETTINGS: { exportSpeakerLabels: false } },
    MaweColors: { COLOR_BY_NAME: colors }, MaweHint: { flashHint() {} },
    MaweColorFilter: { refreshColorAssignmentUi() {} },
    refreshColorAssignmentUi() {},
    splitGroupsAtCutPoints(indices, kind, _ref, segments = utils.getMainTrack(data).segments) {
      utils.clearSubtitleGroupMembers(data, segments, indices, kind);
    },
    MaweSegmentOps: { splitGroupsAtCutPoints(indices, kind, _ref, segments = utils.getMainTrack(data).segments) {
      utils.clearSubtitleGroupMembers(data, segments, indices, kind);
    } },
  };
  context.window = context;
  context.MaweCommands = createEditorCommands({ capture: () => copy(data),
    hasChanges: snapshot => JSON.stringify(snapshot) !== JSON.stringify(data),
    publish(snapshot) { past.push(snapshot); future.length = 0; }, restore, refresh() {},
  });
  vm.createContext(context);
  vm.runInContext(invokedInitModuleSource('editor/styles/editor-speaker-labels.js', 'initMaweSpeakerLabels'), context);
  vm.runInContext(invokedInitModuleSource('editor/cues/editor-sticker-picker.js', 'initMaweStickerPicker'), context);
  return { data, context, past, speakers: context.MaweSpeakerLabels, picker: context.MaweStickerPicker,
    cue: id => data.tracks.flatMap(track => track.segments).find(segment => segment.id === id),
    undo() { future.push(copy(data)); restore(past.pop()); },
    redo() { past.push(copy(data)); restore(future.pop()); },
    reopen() { return utils.importProject(JSON.parse(JSON.stringify(utils.snapshotProjectContent(data)))).project; },
  };
}

function assertIdentity(f, identity) {
  for (const id of ['m0', 'm2', 'bound', 'hidden']) assert.equal(f.cue(id).speaker ?? null, identity, id);
  for (const id of ['m1', 'overlap', 'overlay']) assert.equal(f.cue(id).speaker, 'old', id);
}

test('explicit manager/panel identity assignment follows all bindings, clears, undoes and reopens atomically', () => {
  const f = fixture(), before = copy(f.data);
  const refs = mainRefs();
  f.speakers.assignIdentity(refs, 'new');
  assertIdentity(f, 'new');
  assert.equal(f.past.length, 1);
  assert.deepEqual(f.data.bindings, before.bindings);
  assert.deepEqual(f.data.subtitle_groups, before.subtitle_groups);
  const assigned = copy(f.data);
  f.undo(); assert.deepEqual(f.data, before);
  f.redo(); assert.deepEqual(f.data, assigned);
  assert.deepEqual(copy(f.reopen()), assigned);
  f.speakers.clearIdentity(refs);
  assertIdentity(f, null);
  assert.equal(f.past.length, 2);
  const cleared = copy(f.data);
  f.undo(); assert.deepEqual(f.data, assigned);
  f.redo(); assert.deepEqual(f.data, cleared);
  assert.deepEqual(copy(f.reopen()), cleared);
});

for (let slot = 1; slot <= 9; slot++) {
  test(`speaker shortcut ${slot} and its context-menu color slot synchronize only bound targets`, () => {
    for (const entry of ['shortcut', 'color', 'panel']) {
      const f = fixture(), before = copy(f.data);
      if (entry === 'shortcut') f.speakers.assignShortcut(mainRefs(), slot);
      else if (entry === 'color') f.picker.assignColor(mainIndices, experience.SPEAKER_SHORTCUT_COLORS[slot - 1]);
      else f.picker.assignTrackColor(utils.getMainTrack(f.data), mainIndices, experience.SPEAKER_SHORTCUT_COLORS[slot - 1]);
      const identity = f.data.speaker_shortcuts[String(slot)];
      assert.ok(identity);
      assertIdentity(f, identity);
      assert.equal(f.past.length, 1, entry);
      assert.deepEqual(f.data.subtitle_groups, before.subtitle_groups);
      f.picker.clearColorOnTargets(mainIndices);
      assertIdentity(f, null);
      assert.equal(f.past.length, 2);
    }
  });
}

test('independent secondary and overlay identity assignment/clear never flows backwards', () => {
  const f = fixture();
  for (const [track_id, segment_id] of [['main', 'bound'], ['overlay', 'overlay']]) {
    f.speakers.assignIdentity([{ track_id, segment_id }], 'new');
    assert.equal(f.cue(segment_id).speaker, 'new');
    assert.equal(f.cue('m0').speaker, 'old');
    assert.equal(f.cue('hidden').speaker, 'old');
    f.speakers.clearIdentity([{ track_id, segment_id }]);
    assert.equal(f.cue(segment_id).speaker ?? null, null);
    assert.equal(f.cue('m0').speaker, 'old');
  }
});

for (const entry of ['color', 'panel']) {
  test(`${entry} color assignment follows bindings without changing speakers, undo/redo and save retain groups`, () => {
    const f = fixture('color'), before = copy(f.data);
    // The bound and unbound secondary cues initially share a group. A main
    // assignment must detach only its explicit target, not recolor that peer.
    const secondary = f.data.tracks.find(track => track.id === 'main');
    utils.assignSubtitleGroup(f.data, secondary.segments, [0, 1], 'color', { name: 'red', value: '#f07f6f' });
    const initial = copy(f.data);
    if (entry === 'color') f.picker.assignColor(mainIndices, 'green');
    else f.picker.assignTrackColor(utils.getMainTrack(f.data), mainIndices, 'green');
    for (const id of ['m0', 'bound', 'hidden']) assert.equal(utils.getSubtitleGroupValue(f.data, f.cue(id)).name, 'green');
    assert.equal(utils.getSubtitleGroupValue(f.data, f.cue('overlap')).name, 'red');
    assert.equal(utils.getSubtitleGroupValue(f.data, f.cue('m1')), null);
    assert.equal(utils.getSubtitleGroupValue(f.data, f.cue('overlay')), null);
    for (const track of f.data.tracks) for (const cue of track.segments) assert.equal(cue.speaker, 'old');
    assert.deepEqual(f.data.bindings, before.bindings);
    assert.equal(f.past.length, 1);
    const assigned = copy(f.data);
    f.undo(); assert.deepEqual(f.data, initial);
    f.redo(); assert.deepEqual(f.data, assigned);
    assert.deepEqual(copy(f.reopen()), assigned);
    f.picker.clearColorOnTargets(mainIndices);
    for (const id of ['m0', 'bound', 'hidden']) assert.equal(utils.getSubtitleGroupValue(f.data, f.cue(id)), null);
    assert.equal(utils.getSubtitleGroupValue(f.data, f.cue('overlap')).name, 'red');
    assert.equal(f.past.length, 2);
    const cleared = copy(f.data);
    f.undo(); assert.deepEqual(f.data, assigned);
    f.redo(); assert.deepEqual(f.data, cleared);
    assert.deepEqual(copy(f.reopen()), cleared);
  });
}

test('independent secondary/overlay color assignment and clear never flow backwards to main', () => {
  const f = fixture('color');
  f.picker.assignColor(mainIndices, 'green');
  for (const id of ['main', 'overlay']) {
    const track = f.data.tracks.find(track => track.id === id);
    f.picker.assignTrackColor(track, [0], 'red');
    assert.equal(utils.getSubtitleGroupValue(f.data, track.segments[0]).name, 'red');
    assert.equal(utils.getSubtitleGroupValue(f.data, f.cue('m0')).name, 'green');
    f.picker.assignTrackColor(track, [0], null);
    assert.equal(utils.getSubtitleGroupValue(f.data, track.segments[0]), null);
    assert.equal(utils.getSubtitleGroupValue(f.data, f.cue('m0')).name, 'green');
  }
});

test('invalid mixed references do not partially assign any main or bound cue', () => {
  const f = fixture(), before = copy(f.data);
  assert.throws(() => f.speakers.assignIdentity([
    { track_id: 'extension-1', segment_id: 'm0' }, { track_id: 'main', segment_id: 'missing' },
  ], 'new'), /reference/);
  assert.deepEqual(f.data, before);
  assert.equal(f.past.length, 0);
});

test('reassigning the current main identity still repairs a differing bound identity, including clear', () => {
  const f = fixture();
  f.cue('bound').speaker = 'new';
  f.speakers.assignIdentity(mainRefs(), 'old');
  assertIdentity(f, 'old');
  assert.equal(f.past.length, 1);
  delete f.cue('m0').speaker;
  delete f.cue('m2').speaker;
  f.speakers.clearIdentity(mainRefs());
  assertIdentity(f, null);
  assert.equal(f.past.length, 2);
});

test('all nine color shortcut routes synchronize groups without assigning a speaker', () => {
  const f = fixture('color');
  for (const name of experience.SPEAKER_SHORTCUT_COLORS) {
    f.picker.assignTrackColor(utils.getMainTrack(f.data), mainIndices, name);
    for (const id of ['m0', 'bound', 'hidden']) {
      assert.equal(utils.getSubtitleGroupValue(f.data, f.cue(id)).name, name);
      assert.equal(f.cue(id).speaker, 'old');
    }
    assert.equal(utils.getSubtitleGroupValue(f.data, f.cue('overlap')), null);
  }
  assert.equal(f.past.length, 9);
  assert.equal(f.data.speakers.length, 2);
});

test('recoloring one main group member follows every affected binding without manufacturing repeat history', () => {
  const f = fixture('color');
  utils.assignSubtitleGroup(f.data, utils.getMainTrack(f.data).segments, mainIndices, 'color',
    { name: 'red', value: '#f07f6f' });
  f.picker.assignColor([0], 'green');
  for (const id of ['m0', 'm2', 'bound', 'hidden']) {
    assert.equal(utils.getSubtitleGroupValue(f.data, f.cue(id)).name, 'green');
  }
  assert.equal(utils.getSubtitleGroupValue(f.data, f.cue('overlap')), null);
  assert.equal(f.past.length, 1);
  const assigned = copy(f.data);
  f.picker.assignColor([0], 'green');
  assert.deepEqual(f.data, assigned);
  assert.equal(f.past.length, 1, 'same-color repeat creates neither another secondary group nor an undo record');
});

test('multi-select repeating the same color group creates no group, next_id increment or history', () => {
  const f = fixture('color');
  f.picker.assignColor(mainIndices, 'green');
  const assigned = copy(f.data);
  const nextId = f.data.subtitle_groups.next_id;
  assert.equal(f.past.length, 1);
  f.picker.assignColor(mainIndices, 'green');
  assert.equal(f.data.subtitle_groups.next_id, nextId);
  assert.deepEqual(f.data, assigned);
  assert.equal(f.past.length, 1);
});

test('multi-select same-color main group still synchronizes differing bound colors without rebuilding main', () => {
  const f = fixture('color');
  const main = utils.getMainTrack(f.data);
  const groupId = utils.assignSubtitleGroup(f.data, main.segments, mainIndices, 'color',
    { name: 'green', value: '#66bb6a' });
  const secondary = f.data.tracks.find(track => track.role === 'secondary');
  utils.assignSubtitleGroup(f.data, secondary.segments, [0], 'color', { name: 'red', value: '#f07f6f' });
  const nextId = f.data.subtitle_groups.next_id;
  f.picker.assignColor(mainIndices, 'green');
  for (const index of mainIndices) assert.equal(main.segments[index].color_group_id, groupId);
  for (const id of ['bound', 'hidden']) assert.equal(utils.getSubtitleGroupValue(f.data, f.cue(id)).name, 'green');
  assert.equal(utils.getSubtitleGroupValue(f.data, f.cue('overlap')), null);
  assert.equal(f.data.subtitle_groups.next_id, nextId + 1, 'only the changed secondary targets need a new group');
  assert.equal(f.past.length, 1);
});

test('multi-select same-color different groups still unifies the selected main memberships', () => {
  const f = fixture('color');
  const main = utils.getMainTrack(f.data);
  for (const index of mainIndices) utils.assignSubtitleGroup(f.data, main.segments, [index], 'color',
    { name: 'green', value: '#66bb6a' });
  const oldIds = mainIndices.map(index => main.segments[index].color_group_id);
  assert.notEqual(oldIds[0], oldIds[1]);
  f.picker.assignColor(mainIndices, 'green');
  const mergedId = main.segments[mainIndices[0]].color_group_id;
  assert.equal(main.segments[mainIndices[1]].color_group_id, mergedId);
  assert.ok(!oldIds.includes(mergedId));
  assert.equal(f.past.length, 1);
});
