import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

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
    MaweSettings: { EDITOR_SETTINGS: { projectBackupEnabled: true } },
    MaweServerSave: { serverProjectSavingEnabled: () => true, showProjectSaveError() {}, configureServerSaveControls() {}, scheduleAutoSave() {} },
    MaweHost: { server: {}, files: { hasSavePicker: () => true } },
  };
  context.window = context;
  vm.createContext(context);
  for (const file of ['boot/editor-runtime', 'state/editor-state', 'io/editor-project-save']) {
    vm.runInContext(readFileSync(new URL(`../web/editor/${file}.js`, import.meta.url), 'utf8'), context);
  }
  context.MaweState.beginProjectSession();
  context.MaweState.establishProjectCheckpoint();
  context.MaweJsonRepair = { buildJson: () => JSON.stringify(context.MaweState.persistenceSnapshot(data)) };
  return context;
}
const ok = filename => ({ ok: true, json: async () => ({ ok: true, filename }) });

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
