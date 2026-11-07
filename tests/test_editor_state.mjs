import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { runtimeProject, projectModel } from './helpers/runtime-project.mjs';

// editor-state 已转 ESM 模块（register/resolve 注册表退役）：
// 源码在 vm 里还原后直调 createEditorState 工厂。
const STATE_SRC = readFileSync(new URL('../web/editor/state/editor-state.js', import.meta.url), 'utf8');
const { createEditorState } = (() => {
  const context = { window: {} };
  const stripped = STATE_SRC
    .replace(/^import .*$/gm, '')
    .replace(/^export function/gm, 'function');
  return vm.runInNewContext(`(function () { ${stripped}\nreturn { createEditorState }; })()`, context);
})();

function loadState(project = runtimeProject()) {
  return createEditorState(project);
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
  const { selection } = loadState(runtimeProject(Array.from({ length: 6 }, () => ({})), { extensions: [{ segments: Array.from({ length: 4 }, () => ({})) }], overlay: { segments: Array.from({ length: 9 }, () => ({})) } }));
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
  const project = runtimeProject(Array.from({ length: 5 }, () => ({})));
  const { selection } = loadState(project);
  selection.replace('main', [4, 3, 1]);
  selection.mainAnchor = 4;
  project.tracks[0].segments.splice(1, 1);
  const result = selection.removeAndShift('main', 1);
  assert.deepEqual({ ...result }, { wasSelected: true, nextAnchor: 3 });
  assert.deepEqual([...selection.indices('main')], [3, 2]);
  assert.equal(selection.mainAnchor, 3);
});

test('selection and panel follow cue IDs through insertion, removal, transfer, and history restoration', () => {
  const project = runtimeProject([{ id: 'a' }, { id: 'b' }, { id: 'c' }], {
    extensions: [{ id: 'secondary', segments: [{ id: 'translation' }] }],
    overlay: { id: 'overlay', segments: [{ id: 'overlay-cue' }] },
  });
  const { selection, panel, beginProjectSession } = loadState(project);
  const [main, overlay, secondary] = project.tracks;
  selection.add('main', 1);
  selection.mainAnchor = 1;
  panel.currentCuePanelIdx = 1;
  selection.add('extension', 0, { activate: false });
  assert.equal(selection.getCurrentTrack().id, main.id);
  assert.equal(selection.getCurrentCueRef().segment_id, 'b');
  selection.activateRef({ track_id: secondary.id, segment_id: 'translation' });
  assert.equal(selection.getCurrentTrack().id, secondary.id);
  selection.activateRef({ track_id: main.id, segment_id: 'b' });
  selection.activateRef({ track_id: main.id, segment_id: 'not-selected' });
  assert.equal(selection.getCurrentTrack().id, main.id);
  main.segments.unshift({ id: 'new' });
  assert.deepEqual([...selection.indices('main')], [2]);
  assert.equal(selection.mainAnchor, 2);
  assert.equal(panel.currentCuePanelIdx, 2);
  const before = selection.snapshot();
  const moved = main.segments.splice(2, 1)[0];
  overlay.segments.push(moved);
  assert.deepEqual({ ...selection.removeAndShift('main', 2) }, { wasSelected: true, nextAnchor: -1 });
  selection.add('overlay', 1);
  assert.equal(selection.getCurrentTrack().id, overlay.id);
  assert.equal(panel.currentCuePanelIdx, -1);
  const after = selection.snapshot();
  overlay.segments.pop(); main.segments.splice(2, 0, moved);
  selection.restore(before);
  assert.equal(selection.getCurrentCueRef().segment_id, 'b');
  assert.deepEqual([...selection.indices('main')], [2]);
  main.segments.splice(2, 1); overlay.segments.push(moved);
  selection.restore(after);
  assert.equal(selection.getCurrentTrack().id, overlay.id);
  assert.deepEqual([...selection.indices('overlay')], [1]);
  selection.clear('overlay'); selection.clear('extension');
  assert.equal(selection.getCurrentTrack().id, main.id);
  assert.equal(selection.getCurrentCueRef(), null);
  selection.add('extension', 0);
  beginProjectSession();
  assert.equal(selection.getSelectedCueRefs().length, 0);
  assert.equal(panel.currentCuePanelIdx, -1);
  assert.equal(secondary.segments[0].id, 'translation');
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
  const project = runtimeProject([{ id: 'one', text: 'written', _dirty: true }], {
    extensions: [{ _dirty: true, segments: [{ _dirty: true }] }],
    overlay: { _dirty: true, segments: [{ _dirty: true }] } });
  const state = loadState(project);
  const written = state.segmentsFingerprint();
  projectModel.getMainTrack(project).segments[0].text = 'later';
  state.noteSavedSegments(written);
  state.markSaved();
  assert.equal(state.hasProjectChanges(), true);
  state.rememberSessionHighlights();
  projectModel.getMainTrack(project).segments[0] = { id: 'one', start: 0, end: 1000, text: 'written' };
  state.restoreSessionHighlights();
  state.reconcileSegmentsDirty();
  assert.equal(state.hasProjectChanges(), false);
  assert.equal(projectModel.getMainTrack(project).segments[0]._dirty, true);
  assert.equal(JSON.stringify(state.persistenceSnapshot(project)).includes('_dirty'), false);
  assert.equal(JSON.stringify(project).includes('_dirty'), true, 'saving keeps current-session highlights');
  const epoch = state.projectEpoch;
  state.beginProjectSession();
  state.establishProjectCheckpoint();
  assert.equal(state.projectEpoch, epoch + 1);
  assert.equal(projectModel.getMainTrack(project).segments[0]._dirty, undefined);
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
  Object.assign(state.changes, { markersDirty: true, projectImportDirty: true });
  assert.equal(events, 4, 'bulk assignment must go through the same notify path');
});
