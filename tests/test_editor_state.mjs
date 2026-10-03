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

test('dirty detection includes pending native text, all tracks and project-level flags', () => {
  const project = { segments: [], multi_subtitle: { tracks: [{ segments: [{}] }] }, overlay_track: { segments: [{}] } };
  const state = loadState(project);
  assert.equal(state.hasProjectChanges(), false);
  assert.equal(state.hasProjectChanges(true), true);
  project.multi_subtitle.tracks[0].segments[0]._dirty = true;
  assert.equal(state.hasProjectChanges(), true);
  delete project.multi_subtitle.tracks[0].segments[0]._dirty;
  project.overlay_track._dirty = true;
  assert.equal(state.hasProjectChanges(), true);
  delete project.overlay_track._dirty;
  for (const key of Object.keys(state.changes)) {
    state.changes[key] = true;
    assert.equal(state.hasProjectChanges(), true);
    state.changes[key] = false;
  }
  assert.equal(state.hasProjectChanges(), false);
});

test('saved subtitle truth governs undo dirtiness without involving rebuildable caches or other edit domains', () => {
  const project = { segments: [{ text: 'saved' }], overlay_track: { segments: [] } };
  const state = loadState(project);
  state.noteSavedSegments();
  project.segments[0]._dirty = true;
  project.waveform = { cache: 'new' };
  state.changes.gapRemoveDirty = true;
  state.reconcileSegmentsDirty();
  assert.equal(state.changes.projectImportDirty, false);
  assert.equal(project.segments[0]._dirty, undefined);
  assert.equal(state.changes.gapRemoveDirty, true);
  project.segments[0].text = 'undo';
  state.reconcileSegmentsDirty();
  assert.equal(state.changes.projectImportDirty, true);
  project.segments[0].text = 'saved';
  state.reconcileSegmentsDirty();
  assert.equal(state.changes.projectImportDirty, false);
});

test('saving an earlier snapshot keeps subsequent edits dirty and clears every track only when saved', () => {
  const project = { segments: [{ text: 'written', _dirty: true }],
    multi_subtitle: { _dirty: true, tracks: [{ _dirty: true, segments: [{ _dirty: true }] }] },
    overlay_track: { _dirty: true, segments: [{ _dirty: true }] } };
  const state = loadState(project);
  const written = state.segmentsFingerprint();
  project.segments[0].text = 'later';
  state.noteSavedSegments(written);
  state.reconcileSegmentsDirty();
  assert.equal(state.hasProjectChanges(), true);
  state.noteSavedSegments();
  state.markSaved();
  assert.equal(state.hasProjectChanges(), false);
  assert.equal(JSON.stringify(project).includes('_dirty'), false);
});
