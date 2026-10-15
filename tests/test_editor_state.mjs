import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

function loadState(project = { segments: [] }) {
  const context = { window: { MaweBoot: { DATA: project } } };
  for (const file of ['editor/boot/editor-runtime.js', 'editor/state/editor-state.js']) {
    vm.runInNewContext(readFileSync(new URL('../web/' + file, import.meta.url), 'utf8'), context);
  }
  return context.window.MaweState;
}

test('state keeps the original project identity and excludes transient state from project serialization', () => {
  const project = { segments: [{ id: 'one', text: 'original' }] };
  const state = loadState(project);
  assert.equal(state.project, project);
  state.project.segments[0].text = 'edited';
  assert.equal(project.segments[0].text, 'edited');
  state.runtime.player = { transient: true };
  state.preferences.editor.theme = 'dark';
  state.selection.add('main', 0);
  assert.deepEqual(JSON.parse(JSON.stringify(project)), { segments: [{ id: 'one', text: 'edited' }] });
});

test('selection views stay live while every mutation goes through the owner', () => {
  const { selection } = loadState();
  const main = selection.indices('main');
  assert.equal(main.add, undefined);
  assert.equal(main.clear, undefined);
  selection.add('main', 2);
  selection.add('main', -1);
  selection.add('extension', 3);
  assert.deepEqual([...main], [2]);
  assert.deepEqual([...selection.indices('extension')], [3]);
  selection.replace('main', main);
  assert.deepEqual([...main], [2]);
  selection.replace('main', [4, 4, 5]);
  assert.deepEqual([...main], [4, 5]);
  main.forEach((index, key, view) => { assert.equal(index, key); assert.equal(view, main); });
  assert.throws(() => selection.clear('unknown'), { name: 'TypeError' });
  selection.overlayAnchor = 8;
  selection.reset();
  assert.equal(main.size, 0);
  assert.equal(selection.indices('extension').size, 0);
  assert.equal(selection.overlayAnchor, -1);
});

test('separate editor instances share neither selection nor runtime or preference state', () => {
  const first = loadState(), second = loadState();
  first.selection.add('overlay', 1);
  first.panel.currentCuePanelIdx = 1;
  first.preferences.editor.theme = 'light';
  assert.equal(second.selection.indices('overlay').size, 0);
  assert.equal(second.panel.currentCuePanelIdx, -1);
  assert.equal(second.preferences.editor.theme, undefined);
});

test('track transfers remap selection and its anchor without exposing a mutable Set', () => {
  const { selection } = loadState();
  selection.replace('main', [4, 3, 1]);
  selection.mainAnchor = 4;
  const result = selection.removeAndShift('main', 1);
  assert.deepEqual({ ...result }, { wasSelected: true, nextAnchor: 3 });
  assert.deepEqual([...selection.indices('main')], [3, 2]);
  assert.equal(selection.mainAnchor, 3);
});

test('legacy flags and caches are not persistent changes, but every content domain is', () => {
  const project = { segments: [{ id: 's', text: 'saved', _dirty: true }],
    multi_subtitle: { _dirty: true, tracks: [{ id: 'e', segments: [{ id: 'e1', _dirty: true }] }] },
    overlay_track: { _dirty: true, segments: [{ id: 'o', _dirty: true }] } };
  const state = loadState(project);
  state.beginProjectSession();
  state.establishProjectCheckpoint();
  assert.equal(JSON.stringify(project).includes('_dirty'), false);
  project.segments[0]._dirty = true;
  project.waveform = { cache: 'new' };
  for (const key of Object.keys(state.changes)) state.changes[key] = true;
  assert.equal(state.hasProjectChanges(), false);
  assert.equal(state.hasProjectChanges(true), true);
  for (const [key, value] of Object.entries({ timebase: { fps: 30, fps_source: 'user' },
    groups: { g1: ['s'] }, workspace: { a: 1 }, gap_remove: { gaps: [[0, 20]] },
    markers: [{ start: 12 }], preview: { x: 9 }, media: 'changed', vendor: { extra: true } })) {
    project[key] = value;
    assert.equal(state.hasProjectChanges(), true, key);
    delete project[key];
    assert.equal(state.hasProjectChanges(), false, key + ' restored');
  }
  assert.equal(project.segments[0]._dirty, true);
});

test('snapshot provider follows actual serialized extensions and does not call a repair writer', () => {
  const state = loadState();
  const output = { segments: [], extension: { _dirty: 'vendor data', future: 1 } };
  state.setSnapshotReader(() => output);
  state.establishProjectCheckpoint();
  output.extension.future = 2;
  assert.equal(state.hasProjectChanges(), true);
  assert.equal(JSON.parse(state.projectFingerprint()).extension._dirty, 'vendor data');
  output.extension = { future: 1, _dirty: 'vendor data' };
  assert.equal(state.hasProjectChanges(), false, 'object key order is immaterial');
});

test('saving a captured snapshot retains new edits and session highlights; undo can reach save point', () => {
  const project = { segments: [{ id: 'one', text: 'written', _dirty: true }] };
  const state = loadState(project);
  const written = state.projectFingerprint();
  project.segments[0].text = 'later';
  state.noteSavedSegments(written);
  state.markSaved();
  assert.equal(state.hasProjectChanges(), true);
  state.rememberSessionHighlights();
  project.segments = [{ id: 'one', text: 'written' }];
  state.restoreSessionHighlights();
  state.reconcileSegmentsDirty();
  assert.equal(state.hasProjectChanges(), false);
  assert.equal(project.segments[0]._dirty, true);
  const epoch = state.projectEpoch;
  state.beginProjectSession();
  state.establishProjectCheckpoint();
  assert.equal(state.projectEpoch, epoch + 1);
  assert.equal(project.segments[0]._dirty, undefined);
});

test('actual import repairs remain unsaved until successful save acknowledgement', () => {
  const state = loadState();
  state.beginProjectSession();
  state.establishProjectCheckpoint({ repaired: true });
  assert.equal(state.hasProjectChanges(), true);
  state.noteSavedSegments();
  state.markSaved();
  assert.equal(state.hasProjectChanges(), false);
});
