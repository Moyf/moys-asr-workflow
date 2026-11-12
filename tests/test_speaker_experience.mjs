import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import * as experience from '../web/shared/utils/speaker-experience.js';
import * as identity from '../web/shared/utils/speaker-identity.js';
import { createEditorCommands } from '../web/editor/state/editor-commands.js';
import { invokedInitModuleSource } from './helpers/init-module-source.mjs';
import { runtimeProject } from './helpers/runtime-project.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const cue = id => ({ id, start: 0, end: 1000, text: id, items: [{ start: 0, end: 1000, text: id }], color_group_id: 'group' });
const project = () => runtimeProject([cue('main-1'), { ...cue('main-2'), start: 1000, end: 2000, items: [{ text: 'main-2', start: 1000, end: 2000 }] }], {
  extensions: [{ id: 'secondary', segments: [cue('secondary-1')] }], overlay: { segments: [cue('overlay-1')] },
  speakers: [], annotation_mode: 'speaker', palette_size: 5, speaker_shortcuts: {},
  subtitle_groups: { next_id: 2, color: [{ id: 'group', value: { name: 'yellow', value: '#f9ca1f' } }], sticker: [] },
  preview: { subtitle: { speaker_labels: { enabled: false, export_enabled: false, mapping_enabled: false } } },
});

function fixture() {
  const data = project();
  const past = [], future = [];
  const restore = snapshot => {
    for (const key of Object.keys(data)) delete data[key];
    Object.assign(data, copy(snapshot));
  };
  const context = { ...experience, AsrEditorUtils: identity, MaweBoot: { DATA: data },
    MaweSettings: { EDITOR_SETTINGS: { exportSpeakerLabels: false } },
  };
  context.window = context;
  context.MaweCommands = createEditorCommands({ capture: () => copy(data),
    hasChanges: snapshot => JSON.stringify(snapshot) !== JSON.stringify(data),
    publish(snapshot) { past.push(snapshot); future.length = 0; }, restore, refresh() {},
  });
  vm.createContext(context);
  vm.runInContext(invokedInitModuleSource('editor/styles/editor-speaker-labels.js', 'initMaweSpeakerLabels'), context);
  return { data, api: context.MaweSpeakerLabels, past,
    undo() { future.push(copy(data)); restore(past.pop()); },
    redo() { past.push(copy(data)); restore(future.pop()); },
  };
}

test('empty shortcut creates, binds and assigns across three tracks as one undoable command', () => {
  const f = fixture(), before = copy(f.data);
  const refs = ['main', 'secondary', 'overlay'].map(track_id => ({ track_id, segment_id: `${track_id}-1` }));
  assert.equal(f.api.assignShortcut(refs, 2), true);
  assert.equal(f.past.length, 1);
  assert.deepEqual(f.data.speakers, [{ id: 'spk-001', name: '说话人 1', color: '#66bb6a' }]);
  assert.equal(f.data.speaker_shortcuts['2'], 'spk-001');
  for (const track of f.data.tracks) assert.equal(track.segments[0].speaker, 'spk-001');
  assert.equal(f.data.tracks[0].segments[1].speaker, undefined, 'unselected member of the same color group is unchanged');
  assert.deepEqual(f.data.subtitle_groups, before.subtitle_groups);
  assert.deepEqual(f.data.tracks.flatMap(t => t.segments.map(c => c.items)), before.tracks.flatMap(t => t.segments.map(c => c.items)));
  assert.equal(f.api.assignShortcut(refs, 2), false);
  assert.equal(f.past.length, 1);
  const assigned = copy(f.data);
  f.undo(); assert.deepEqual(f.data, before);
  f.redo(); assert.deepEqual(f.data, assigned);
});

test('an empty target or inactive sixth shortcut never creates an identity', () => {
  const f = fixture(), before = copy(f.data);
  assert.equal(f.api.assignShortcut([], 1), false);
  assert.equal(f.api.assignShortcut([{ track_id: 'main', segment_id: 'main-1' }], 6), false);
  assert.deepEqual(f.data, before);
  assert.equal(f.past.length, 0);
});

test('unknown refs or invalid names and colors cannot partially create or update an identity', () => {
  const f = fixture(), before = copy(f.data);
  assert.throws(() => f.api.assignShortcut([{ track_id: 'main', segment_id: 'missing' }], 1), /reference/);
  assert.throws(() => f.api.createIdentity({ name: 'bad\nname' }), /name/);
  assert.deepEqual(f.data, before);
  assert.equal(f.past.length, 0);
  const speaker = f.api.createIdentity({ name: 'Original' });
  const created = copy(f.data);
  assert.throws(() => f.api.updateIdentity(speaker.id, { name: 'Changed', color: 'bad' }), /color/);
  assert.deepEqual(f.data, created);
  assert.equal(f.past.length, 1);
});

test('rename, recolor, slot binding and explicit identity merging keep references and undo separately', () => {
  const f = fixture();
  const first = f.api.createIdentity({ name: 'Same', color: '#969fab' });
  const second = f.api.createIdentity({ name: 'Same', color: '#969fab' });
  assert.notEqual(first.id, second.id);
  f.api.assignIdentity([{ track_id: 'main', segment_id: 'main-1' }], first.id);
  f.api.assignIdentity([{ track_id: 'overlay', segment_id: 'overlay-1' }], second.id);
  f.api.bindShortcut(9, second.id);
  const beforeRename = copy(f.data);
  f.api.updateIdentity(second.id, { name: 'New name', color: '#49c5c1' });
  assert.equal(f.data.speaker_shortcuts['9'], second.id);
  assert.equal(f.data.tracks.find(t => t.id === 'overlay').segments[0].speaker, second.id);
  f.undo(); assert.deepEqual(f.data, beforeRename); f.redo();
  const beforeMerge = copy(f.data);
  f.api.mergeIdentities([second.id], first.id);
  assert.equal(f.data.speakers.length, 1);
  assert.equal(f.data.speaker_shortcuts['9'], first.id);
  assert.equal(f.data.tracks.find(t => t.id === 'overlay').segments[0].speaker, first.id);
  f.undo(); assert.deepEqual(f.data, beforeMerge);
});

test('palette and annotation switches preserve identity, groups, slots and independent prefix settings', () => {
  const f = fixture();
  f.api.setPaletteSize(9);
  f.api.assignShortcut([{ track_id: 'main', segment_id: 'main-1' }], 9);
  const assigned = copy(f.data);
  f.api.setPaletteSize(5);
  assert.deepEqual({ ...f.data, palette_size: 9 }, assigned);
  f.undo(); assert.deepEqual(f.data, assigned); f.redo();
  const collapsed = copy(f.data);
  f.api.setAnnotationMode('color');
  assert.deepEqual({ ...f.data, annotation_mode: 'speaker' }, collapsed);
  f.undo(); assert.deepEqual(f.data, collapsed);
  const historyCount = f.past.length;
  assert.equal(f.api.setPaletteSize(5), false);
  assert.equal(f.api.setAnnotationMode('speaker'), false);
  assert.equal(f.past.length, historyCount);
});
