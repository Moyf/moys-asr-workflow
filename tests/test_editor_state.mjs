import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { runtimeProject, projectModel } from './helpers/runtime-project.mjs';

function loadState(project = runtimeProject()) {
  const context = { window: { AsrEditorUtils: projectModel, MaweBoot: { DATA: project } } };
  for (const file of ['editor/boot/editor-runtime.js', 'editor/state/editor-state.js']) {
    vm.runInNewContext(readFileSync(new URL('../web/' + file, import.meta.url), 'utf8'), context);
  }
  return context.window.MaweState;
}

test('only the current project load can release saving, and replacement cancels registered media work', () => {
  const state = loadState();
  let cancelled = 0;
  const stop = state.observeProjectLoad(() => cancelled++);
  const old = state.beginProjectLoad();
  const next = state.beginProjectLoad();
  state.finishProjectLoad(old);
  assert.equal(state.projectLoadPending, true);
  state.finishProjectLoad(next);
  assert.equal(state.projectLoadPending, false);
  assert.equal(cancelled, 2);
  stop();
  state.beginProjectLoad();
  assert.equal(cancelled, 2);
});

test('superseded project waits finish immediately while late transport completion remains observed', async () => {
  const state = loadState();
  const generation = state.beginProjectLoad();
  let reject;
  const transport = new Promise((_, fail) => {reject = fail;});
  const waiting = state.waitForProjectLoad(transport, generation);
  state.beginProjectLoad();
  assert.equal(await waiting, null);
  reject(new Error('late transport failure'));
  await Promise.resolve();
});

test('state keeps the original project identity and excludes transient state from project serialization', () => {
  const project = runtimeProject([{ id: 'one', text: 'original' }]);
  const expected = JSON.parse(JSON.stringify(project));
  const state = loadState(project);
  assert.equal(state.project, project);
  projectModel.getMainTrack(state.project).segments[0].text = 'edited';
  assert.equal(projectModel.getMainTrack(project).segments[0].text, 'edited');
  state.runtime.player = { transient: true };
  state.preferences.editor.theme = 'dark';
  state.selection.add('main', 0);
  expected.tracks[0].segments[0].text = 'edited';
  assert.deepEqual(JSON.parse(JSON.stringify(project)), expected);
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

test('dirty detection includes pending native text, every track and persistent project settings', () => {
  const project = runtimeProject([], { extensions: [{ segments: [{ text: 'extension' }] }], overlay: { segments: [{ text: 'overlay' }] } });
  const state = loadState(project);
  assert.equal(state.hasProjectChanges(), false);
  assert.equal(state.hasProjectChanges(true), true);
  const extension = projectModel.getExtensionTrack(project);
  extension.segments[0].text = 'edited extension';
  assert.equal(state.hasProjectChanges(), true);
  extension.segments[0].text = 'extension';
  projectModel.getOverlayTrack(project).enabled = false;
  assert.equal(state.hasProjectChanges(), true);
  projectModel.getOverlayTrack(project).enabled = true;
  for (const [key, value] of Object.entries({ markers: [{ id: 'marker', start: 0 }],
    gap_remove: { gaps: [] }, preview: { ass_mode: true }, workspace: { preset: 'wide' } })) {
    project[key] = value;
    assert.equal(state.hasProjectChanges(), true);
    delete project[key];
  }
  assert.equal(state.hasProjectChanges(), false);
});

test('saved content governs undo dirtiness while session highlights and rebuildable caches stay transient', () => {
  const project = runtimeProject([{ text: 'saved' }], { overlay: { segments: [] } });
  const segment = projectModel.getMainTrack(project).segments[0];
  const state = loadState(project);
  state.noteSavedSegments();
  segment._dirty = true;
  project.waveform = { cache: 'new' };
  state.changes.gapRemoveDirty = true;
  state.reconcileSegmentsDirty();
  assert.equal(state.changes.projectImportDirty, false);
  assert.equal(segment._dirty, true, 'saved-content comparison must preserve session highlights');
  assert.equal(state.changes.gapRemoveDirty, true);
  segment.text = 'undo';
  state.reconcileSegmentsDirty();
  assert.equal(state.changes.projectImportDirty, true);
  segment.text = 'saved';
  state.reconcileSegmentsDirty();
  assert.equal(state.changes.projectImportDirty, false);
});

test('saving an earlier snapshot keeps later edits dirty and excludes highlights from every saved track', () => {
  const project = runtimeProject([{ text: 'written', _dirty: true }], {
    extensions: [{ _dirty: true, segments: [{ _dirty: true }] }],
    overlay: { _dirty: true, segments: [{ _dirty: true }] } });
  const state = loadState(project);
  const written = state.segmentsFingerprint();
  projectModel.getMainTrack(project).segments[0].text = 'later';
  state.noteSavedSegments(written);
  state.reconcileSegmentsDirty();
  assert.equal(state.hasProjectChanges(), true);
  state.noteSavedSegments();
  state.markSaved();
  assert.equal(state.hasProjectChanges(), false);
  assert.equal(JSON.stringify(state.persistenceSnapshot(project)).includes('_dirty'), false);
  assert.equal(JSON.stringify(project).includes('_dirty'), true, 'saving keeps current-session highlights');
});

test('markProjectDirty increments the epoch and notifies registered listeners exactly once', () => {
  const state = loadState();
  assert.equal(state.getProjectDirtyEpoch(), 0);
  const seen = [];
  const unsubscribe = state.onProjectDirtyChange(epoch => seen.push(epoch));
  assert.equal(typeof unsubscribe, 'function');
  state.markProjectDirty();
  state.markProjectDirty();
  assert.equal(state.getProjectDirtyEpoch(), 2);
  assert.deepEqual(seen, [1, 2]);
  unsubscribe();
  state.markProjectDirty();
  assert.equal(state.getProjectDirtyEpoch(), 3);
  assert.deepEqual(seen, [1, 2]);
});

test('onProjectDirtyChange dedupes repeat registration and ignores non-functions', () => {
  const state = loadState();
  const seen = [];
  const listener = epoch => seen.push(epoch);
  const first = state.onProjectDirtyChange(listener);
  const second = state.onProjectDirtyChange(listener);
  state.markProjectDirty();
  assert.deepEqual(seen, [1], 'duplicate registration must not double-fire');
  first();
  second();
  state.markProjectDirty();
  assert.deepEqual(seen, [1], 'either unsubscribe must remove the shared listener');
  assert.equal(typeof state.onProjectDirtyChange(null), 'function');
  state.markProjectDirty();
  assert.equal(state.getProjectDirtyEpoch(), 3);
});

test('changes flag writes notify on dirty transitions only, and markSaved stays silent', () => {
  const state = loadState();
  let events = 0;
  state.onProjectDirtyChange(() => { events += 1; });
  state.changes.previewGeometryDirty = true;
  assert.equal(events, 1);
  state.changes.gapRemoveDirty = true;
  assert.equal(events, 2);
  state.changes.previewGeometryDirty = false;
  state.changes.gapRemoveDirty = false;
  assert.equal(events, 2, 'writing false must not fire the dirty event');
  state.markSaved();
  assert.equal(events, 2, 'clearing bookkeeping on save must not fire the dirty event');
  Object.assign(state.changes, { markersDirty: true, timedTextEditViewDirty: true });
  assert.equal(events, 4, 'bulk assignment must go through the same notify path');
});
