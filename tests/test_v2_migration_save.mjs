import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { invokedInitModuleSource } from './helpers/init-module-source.mjs';
import { runtimeProject, projectModel } from './helpers/runtime-project.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

function fixture() {
  const data = runtimeProject([{ id: 'cue', start: 0, end: 1000, text: 'migrated' }]);
  const calls = { pick: [], writes: [], fetch: 0, hints: [] };
  const context = {
    Blob, AsrEditorUtils: projectModel, document: { getElementById: () => null },
    MaweBoot: { DATA: data, SERVER_CONFIG: { saveUrl: '/save' }, PROJECT_NAME: 'old', FILENAME_BASE: 'old' },
    MaweInlineEdit: {}, MaweDom: {}, MaweCuePanel: { commitCuePanelEdit() {} },
    MaweCoreState: {}, MaweHint: { flashHint: (...args) => calls.hints.push(args) },
    MaweProjectLoad: { projectBindingEpoch: 0 },
    MaweSettings: { EDITOR_SETTINGS: { projectBackupEnabled: true } },
    MaweServerSave: { requiresMigrationSaveAs: true, projectFileHandle: null,
      serverProjectSavingEnabled: () => true, showProjectSaveError(error) { throw error; },
      configureServerSaveControls() {}, scheduleAutoSave() {} },
    MaweHost: { server: { fetch: async () => { calls.fetch++; return { ok: true, json: async () => ({ ok: true }) }; } },
      files: { hasSavePicker: () => true,
        pickSaveFile: async options => { calls.pick.push(options); throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); },
        writeBlob: async (handle, makeBlob) => { calls.writes.push({ handle, project: JSON.parse(await makeBlob().text()) }); } } },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL('../web/editor/boot/editor-runtime.js', import.meta.url), 'utf8'), context);
  vm.runInContext(invokedInitModuleSource('editor/state/editor-state.js', 'initMaweState'), context);
  vm.runInContext(invokedInitModuleSource('editor/io/editor-project-save.js', 'initMaweProjectSave'), context);
  context.MaweState.beginProjectSession();
  context.MaweState.establishProjectCheckpoint({ repaired: true });
  context.MaweJsonRepair = { buildJson: () => JSON.stringify(context.MaweState.persistenceSnapshot(data)) };
  return { context, calls };
}

test('migration silent save does not write; cancelling the v2 picker leaves the project pending', async () => {
  const { context: c, calls } = fixture();
  assert.equal(await c.MaweProjectSave.saveCurrentProject({ silent: true }), false);
  assert.equal(await c.MaweProjectSave.saveProjectToServer({ silent: true }), false);
  assert.equal(await c.MaweProjectSave.saveProjectToServer({ backupOnly: true }), false);
  assert.equal(calls.fetch, 0); assert.equal(calls.pick.length, 0); assert.equal(calls.writes.length, 0);
  await c.MaweProjectSave.saveCurrentProject();
  assert.equal(calls.pick.length, 1);
  assert.equal(calls.pick[0].suggestedName, 'old_v2.mosp');
  assert.equal(calls.writes.length, 0);
  assert.equal(c.MaweServerSave.requiresMigrationSaveAs, true);
  assert.equal(c.MaweState.hasProjectChanges(), true);
});

test('migration refuses a non-empty selected file without modifying it', async () => {
  const { context: c, calls } = fixture();
  c.MaweHost.files.pickSaveFile = async options => {
    calls.pick.push(options); return { name: 'existing.mosp', getFile: async () => ({ size: 42 }) };
  };
  assert.equal(await c.MaweProjectSave.saveCurrentProject(), false);
  assert.equal(calls.pick[0].suggestedName, 'old_v2.mosp');
  assert.equal(calls.writes.length, 0);
  assert.equal(c.MaweServerSave.projectFileHandle, null);
  assert.equal(c.MaweServerSave.requiresMigrationSaveAs, true);
  assert.equal(c.MaweState.hasProjectChanges(), true);
  assert.equal(calls.hints.length, 1);
});

test('successful migration saves a v2 file and later saves use its handle', async () => {
  const { context: c, calls } = fixture();
  const handle = { name: 'old_v2.mosp', getFile: async () => ({ size: 0 }) };
  c.MaweHost.files.pickSaveFile = async options => { calls.pick.push(options); return handle; };
  await c.MaweProjectSave.saveCurrentProject();
  assert.equal(calls.pick[0].suggestedName, 'old_v2.mosp');
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].handle, handle);
  assert.equal(calls.writes[0].project.schema, 'moy.asr.project.v2');
  assert.equal(c.MaweServerSave.requiresMigrationSaveAs, false);
  assert.equal(c.MaweServerSave.projectFileHandle, handle);
  assert.equal(c.MaweState.hasProjectChanges(), false);
  projectModel.getMainTrack(c.MaweBoot.DATA).segments[0].text = 'later';
  await c.MaweProjectSave.saveCurrentProject();
  assert.equal(calls.pick.length, 1);
  assert.equal(calls.fetch, 0);
  assert.equal(calls.writes.length, 2);
  assert.equal(calls.writes[1].handle, handle);
  assert.equal(projectModel.getMainTrack(calls.writes[1].project).segments[0].text, 'later');
});

test('an old in-flight migration save cannot clear the replacement project migration flag', async () => {
  const { context: c, calls } = fixture();
  const writeStarted = deferred(), finishWrite = deferred();
  const handle = { name: 'old_v2.mosp', getFile: async () => ({ size: 0 }) };
  c.MaweHost.files.pickSaveFile = async options => { calls.pick.push(options); return handle; };
  c.MaweHost.files.writeBlob = async (_handle, makeBlob) => {
    calls.writes.push(JSON.parse(await makeBlob().text())); writeStarted.resolve(); await finishWrite.promise;
  };
  const saving = c.MaweProjectSave.saveCurrentProject();
  await writeStarted.promise;
  c.MaweProjectLoad.projectBindingEpoch++;
  c.MaweBoot.DATA = runtimeProject([{ id: 'new', start: 0, end: 1000, text: 'replacement' }]);
  c.initMaweState();
  c.MaweState.beginProjectSession();
  c.MaweState.establishProjectCheckpoint({ repaired: true });
  c.MaweServerSave.requiresMigrationSaveAs = true;
  c.MaweServerSave.projectFileHandle = null;
  finishWrite.resolve();
  assert.equal(await saving, false);
  assert.equal(c.MaweServerSave.requiresMigrationSaveAs, true);
  assert.equal(c.MaweServerSave.projectFileHandle, null);
  assert.equal(c.MaweState.hasProjectChanges(), true);
  assert.equal(projectModel.getMainTrack(c.MaweBoot.DATA).segments[0].text, 'replacement');
  assert.equal(calls.writes.length, 1);
});
