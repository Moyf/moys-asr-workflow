import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { invokedInitModuleSource } from './helpers/init-module-source.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function fixture() {
  const data = { segments: [{ id: 'one', text: 'saved', items: [] }] };
  const context = {
    Blob, document: { getElementById: () => null },
    MaweBoot: { DATA: data, SERVER_CONFIG: { saveUrl: '/api/project' }, PROJECT_NAME: 'old', FILENAME_BASE: 'old' },
    MaweInlineEdit: {}, MaweDom: {}, MaweCuePanel: { commitCuePanelEdit() {} },
    MaweCoreState: {}, MaweHint: { flashHint() {} },
    MaweProjectLoad: { projectBindingEpoch: 0 },
    MaweSettings: { EDITOR_SETTINGS: { projectBackupEnabled: true } },
    MaweServerSave: { serverProjectSavingEnabled: () => true, showProjectSaveError() {}, configureServerSaveControls() {}, scheduleAutoSave() {} },
    MaweHost: { server: {}, files: { hasSavePicker: () => true } },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL('../web/editor/boot/editor-runtime.js', import.meta.url), 'utf8'), context);
  vm.runInContext(invokedInitModuleSource('editor/state/editor-state.js', 'initMaweState'), context);
  vm.runInContext(invokedInitModuleSource('editor/io/editor-project-save.js', 'initMaweProjectSave'), context);
  context.MaweState.beginProjectSession();
  context.MaweState.establishProjectCheckpoint();
  context.MaweJsonRepair = { buildJson: () => JSON.stringify(context.MaweState.persistenceSnapshot(data)) };
  return context;
}
const ok = filename => ({ ok: true, json: async () => ({ ok: true, filename }) });

test('audio settings participate in content checkpoints and in-flight save confirmation', async () => {
  const c = fixture(), response = deferred();
  c.MaweBoot.DATA.audio_processing = { gain_db: 0, target_lufs: -14, peak_ceiling_dbtp: -1 };
  c.MaweState.establishProjectCheckpoint();
  c.MaweBoot.DATA.audio_processing.gain_db = 6;
  c.MaweState.changes.audioProcessingDirty = true;
  assert.equal(c.MaweState.hasProjectChanges(), true);
  c.MaweBoot.DATA.audio_processing.gain_db = 0;
  assert.equal(c.MaweState.hasProjectChanges(), false);
  c.MaweBoot.DATA.audio_processing.gain_db = 6;
  let sent;
  c.MaweHost.server.fetch = (_url, options) => { sent = JSON.parse(options.body).project; return response.promise; };
  const saving = c.MaweProjectSave.saveCurrentProject();
  c.MaweBoot.DATA.audio_processing.gain_db = 12;
  response.resolve(ok('audio.mosp'));
  assert.equal(await saving, true);
  assert.equal(sent.audio_processing.gain_db, 6);
  assert.equal(c.MaweState.hasProjectChanges(), true);
  c.MaweBoot.DATA.audio_processing.gain_db = 6;
  assert.equal(c.MaweState.hasProjectChanges(), false);
});

test('an in-flight server save cannot confirm after a new load or binding intent', async () => {
  for (const invalidate of [
    c => c.MaweState.beginProjectLoad(),
    c => { c.MaweProjectLoad.projectBindingEpoch += 1; },
  ]) {
    const c = fixture(), response = deferred();
    c.MaweBoot.DATA.segments[0].text = 'sent';
    c.MaweHost.server.fetch = () => response.promise;
    const saving = c.MaweProjectSave.saveCurrentProject();
    invalidate(c);
    response.resolve(ok('stale.mosp'));
    assert.equal(await saving, false);
    assert.equal(c.MaweState.hasProjectChanges(), true);
    assert.equal(c.MaweBoot.PROJECT_NAME, 'old');
  }
});

test('pending project loading blocks all three save destinations', async () => {
  const c = fixture();
  c.MaweState.beginProjectLoad();
  const unexpected = () => { throw new Error('pending load must not start a write or picker'); };
  c.MaweHost.server.fetch = unexpected;
  c.MaweHost.files.writeBlob = unexpected;
  c.MaweHost.files.pickSaveFile = unexpected;
  c.MaweServerSave.projectFileHandle = { name: 'old.mosp' };
  assert.equal(await c.MaweProjectSave.saveProjectToServer(), false);
  assert.equal(await c.MaweProjectSave.saveProjectToHandle(), false);
  assert.equal(await c.MaweProjectSave.saveProjectAsToFile(), false);
});

test('server failure and backup do not advance the saved checkpoint', async () => {
  const c = fixture();
  c.MaweBoot.DATA.segments[0].text = 'changed';
  c.MaweHost.server.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: 'write failure' }) });
  assert.equal(await c.MaweProjectSave.saveCurrentProject(), false);
  assert.equal(c.MaweState.hasProjectChanges(), true);
  c.MaweHost.server.fetch = async () => ok('backup.mosp');
  assert.equal(await c.MaweProjectSave.saveProjectToServer({ backupOnly: true }), true);
  assert.equal(c.MaweState.hasProjectChanges(), true);
  assert.equal(c.MaweBoot.PROJECT_NAME, 'old');
});

test('successful request confirms sent content and keeps in-flight edits plus highlights', async () => {
  const c = fixture(), response = deferred();
  c.MaweBoot.DATA.segments[0].text = 'sent';
  c.MaweBoot.DATA.segments[0]._dirty = true;
  let sent;
  c.MaweHost.server.fetch = (_url, options) => { sent = JSON.parse(options.body).project; return response.promise; };
  const saving = c.MaweProjectSave.saveCurrentProject();
  c.MaweBoot.DATA.segments[0].text = 'later';
  response.resolve(ok('saved.mosp'));
  assert.equal(await saving, true);
  assert.equal(sent.segments[0].text, 'sent');
  assert.equal(sent.segments[0]._dirty, undefined);
  assert.equal(c.MaweState.hasProjectChanges(), true);
  c.MaweBoot.DATA.segments[0].text = 'sent';
  assert.equal(c.MaweState.hasProjectChanges(), false);
  assert.equal(c.MaweBoot.DATA.segments[0]._dirty, true);
});

test('pending inline text after a save remains unsaved even with identical project bytes', async () => {
  const c = fixture(), response = deferred();
  c.MaweHost.server.fetch = () => response.promise;
  const saving = c.MaweProjectSave.saveCurrentProject();
  c.MaweInlineEdit.editingState = { idx: 0, textEl: { innerText: 'uncommitted\r\ntext' } };
  response.resolve(ok('saved.mosp'));
  await saving;
  assert.equal(c.MaweProjectSave.inlineEditHasUncommittedText(), true);
  assert.equal(c.MaweState.hasProjectChanges(c.MaweProjectSave.inlineEditHasUncommittedText()), true);
});

test('late handle completion cannot rename or acknowledge a different project', async () => {
  const c = fixture(), write = deferred();
  c.MaweServerSave.projectFileHandle = { name: 'old-handle.mosp' };
  c.MaweHost.files.writeBlob = () => write.promise;
  const saving = c.MaweProjectSave.saveCurrentProject();
  c.MaweState.beginProjectSession();
  c.MaweBoot.DATA.segments[0].text = 'new project';
  c.MaweState.establishProjectCheckpoint();
  c.MaweBoot.DATA.segments[0].text = 'new edit';
  c.MaweBoot.PROJECT_NAME = 'new';
  write.resolve();
  assert.equal(await saving, false);
  assert.equal(c.MaweBoot.PROJECT_NAME, 'new');
  assert.equal(c.MaweState.hasProjectChanges(), true);
});

test('save-as pending picker is exclusive and cannot write a newly switched project', async () => {
  const c = fixture(), picker = deferred();
  c.MaweHost.files.pickSaveFile = () => picker.promise;
  let writes = 0;
  c.MaweHost.files.writeBlob = async () => { writes++; };
  const saving = c.MaweProjectSave.saveProjectAsToFile();
  assert.equal(await c.MaweProjectSave.saveCurrentProject(), false);
  c.MaweState.beginProjectSession();
  c.MaweBoot.PROJECT_NAME = 'new';
  picker.resolve({ name: 'picked.mosp' });
  assert.equal(await saving, false);
  assert.equal(writes, 0);
  assert.equal(c.MaweServerSave.projectSaveInFlight, false);
  assert.equal(c.MaweBoot.PROJECT_NAME, 'new');
});

test('save-as acknowledges its snapshot after close, without clearing highlights or later edits', async () => {
  const c = fixture(), close = deferred(), written = deferred();
  const handle = { name: 'picked.mosp' };
  c.MaweHost.files.pickSaveFile = async () => handle;
  c.MaweHost.files.writeBlob = async (_handle, build) => { written.resolve(JSON.parse(await build().text())); await close.promise; };
  c.MaweBoot.DATA.segments[0].text = 'sent';
  c.MaweBoot.DATA.segments[0]._dirty = true;
  const saving = c.MaweProjectSave.saveProjectAsToFile();
  assert.equal((await written.promise).segments[0].text, 'sent');
  c.MaweBoot.DATA.segments[0].text = 'later';
  close.resolve(); await saving;
  assert.equal(c.MaweServerSave.projectFileHandle, handle);
  assert.equal(c.MaweState.hasProjectChanges(), true);
  assert.equal(c.MaweBoot.DATA.segments[0]._dirty, true);
});


test('a failed old handle save cannot show an error on a different project', async () => {
  const c = fixture(), write = deferred(), hints = [];
  c.MaweHint.flashHint = message => hints.push(message);
  c.MaweServerSave.projectFileHandle = { name: 'old-handle.mosp' };
  c.MaweHost.files.writeBlob = () => write.promise;
  const saving = c.MaweProjectSave.saveCurrentProject();
  c.MaweState.beginProjectSession();
  c.MaweState.establishProjectCheckpoint();
  c.MaweBoot.PROJECT_NAME = 'new';
  write.reject(new Error('old handle failed'));
  assert.equal(await saving, false);
  assert.deepEqual(hints, []);
  assert.equal(c.MaweBoot.PROJECT_NAME, 'new');
  assert.equal(c.MaweState.hasProjectChanges(), false);
});

for (const destination of ['server', 'handle', 'save-as']) {
  test(`view preference ${destination} completion acknowledges its bytes and preserves later switches`, async () => {
    const c = fixture(), completion = deferred(), started = deferred();
    const handle = { name: 'view.mosp' };
    let written;
    c.MaweBoot.DATA.timed_text_edit_view = 'single';
    c.MaweHost.server.fetch = (_url, options) => {
      written = JSON.parse(options.body).project;
      started.resolve();
      return completion.promise;
    };
    c.MaweHost.files.pickSaveFile = async () => handle;
    c.MaweHost.files.writeBlob = async (_handle, build) => {
      written = JSON.parse(await build().text());
      started.resolve();
      await completion.promise;
    };
    if (destination === 'handle') c.MaweServerSave.projectFileHandle = handle;
    const saving = destination === 'save-as' ? c.MaweProjectSave.saveProjectAsToFile() : c.MaweProjectSave.saveCurrentProject();
    await started.promise;
    c.MaweBoot.DATA.timed_text_edit_view = 'rows';
    completion.resolve(ok('view.mosp'));
    await saving;
    assert.equal(written.timed_text_edit_view, 'single');
    assert.equal(c.MaweState.hasProjectChanges(), true);
    c.MaweBoot.DATA.timed_text_edit_view = 'single';
    assert.equal(c.MaweState.hasProjectChanges(), false);
  });
}

test('view-only failed writes, cancelled save-as and backup-only preserve the saved preference', async () => {
  const c = fixture();
  c.MaweBoot.DATA.timed_text_edit_view = 'single';
  c.MaweHost.server.fetch = async () => ok('backup.mosp');
  assert.equal(await c.MaweProjectSave.saveProjectToServer({ backupOnly: true }), true);
  assert.equal(c.MaweState.hasProjectChanges(), true);
  c.MaweHost.files.pickSaveFile = async () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); };
  await c.MaweProjectSave.saveProjectAsToFile();
  assert.equal(c.MaweState.hasProjectChanges(), true);
  c.MaweServerSave.projectFileHandle = { name: 'failure.mosp' };
  c.MaweHost.files.writeBlob = async () => { throw new Error('disk full'); };
  assert.equal(await c.MaweProjectSave.saveCurrentProject(), false);
  assert.equal(c.MaweState.hasProjectChanges(), true);
  delete c.MaweBoot.DATA.timed_text_edit_view;
  assert.equal(c.MaweState.hasProjectChanges(), false);
});

test('an old server view save cannot acknowledge or rename a new project', async () => {
  const c = fixture(), response = deferred();
  c.MaweBoot.DATA.timed_text_edit_view = 'single';
  c.MaweHost.server.fetch = () => response.promise;
  const saving = c.MaweProjectSave.saveCurrentProject();
  c.MaweState.beginProjectSession();
  c.MaweBoot.DATA.timed_text_edit_view = 'rows';
  c.MaweState.establishProjectCheckpoint();
  c.MaweBoot.PROJECT_NAME = 'new';
  c.MaweBoot.DATA.timed_text_edit_view = 'single';
  response.resolve(ok('old.mosp'));
  assert.equal(await saving, false);
  assert.equal(c.MaweBoot.PROJECT_NAME, 'new');
  assert.equal(c.MaweState.hasProjectChanges(), true);
  c.MaweBoot.DATA.timed_text_edit_view = 'rows';
  assert.equal(c.MaweState.hasProjectChanges(), false);
});
