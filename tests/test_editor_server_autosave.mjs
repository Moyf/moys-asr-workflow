import assert from 'node:assert/strict';
import {test} from 'node:test';
import vm from 'node:vm';
import {invokedInitModuleSource} from './helpers/init-module-source.mjs';

for (const dirty of [true, false]) test(`debounced autosave waits for a held waveform gesture (${dirty ? 'dirty' : 'clean'} project)`, () => {
  const pending = new Map();
  let nextTimer = 0, snapshotReads = 0, pendingTextChecks = 0, saves = 0;
  const context = vm.createContext({
    document: {getElementById: () => null},
    MaweBoot: {SERVER_CONFIG: {saveUrl: '/api/project', canSave: true}},
    MaweState: {projectLoadPending: false, hasProjectChanges() { snapshotReads++; return dirty; }},
    MaweSettings: {EDITOR_SETTINGS: {autoSaveProject: true}},
    MaweCoreState: {waveformEditor: {drag: {pointerId: 1}}},
    MaweProjectSave: {inlineEditHasUncommittedText() { pendingTextChecks++; return false; }, saveCurrentProject({silent}) { assert.equal(silent, true); saves++; }},
    setTimeout(fn, delay) { const id = ++nextTimer; pending.set(id, {fn, delay}); return id; },
    clearTimeout(id) { pending.delete(id); },
  });
  context.window = context;
  vm.runInContext(invokedInitModuleSource('editor/io/editor-server-save.js', 'initMaweServerSave'), context);
  const runTimer = () => {
    assert.equal(pending.size, 1);
    const [id, {fn, delay}] = pending.entries().next().value;
    assert.equal(delay, 400);
    pending.delete(id);
    fn();
  };
  context.MaweServerSave.scheduleAutoSaveFlush();
  runTimer();
  assert.equal(snapshotReads, 0);
  assert.equal(pendingTextChecks, 0);
  assert.equal(saves, 0);
  assert.equal(pending.size, 1);
  runTimer();
  assert.equal(snapshotReads, 0);
  assert.equal(pendingTextChecks, 0);
  assert.equal(saves, 0);
  assert.equal(pending.size, 1);
  context.MaweCoreState.waveformEditor.drag = null;
  runTimer();
  assert.equal(snapshotReads, 1);
  assert.equal(pendingTextChecks, 1);
  assert.equal(saves, dirty ? 1 : 0);
  assert.equal(pending.size, 0);
});
