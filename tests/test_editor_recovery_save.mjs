import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../web/editor/io/editor-project-save.js', import.meta.url), 'utf8');

function fixture({accept = true, failure = new TypeError('Failed to fetch'), replacement = false} = {}) {
  const calls = {build: [], posted: [], downloaded: [], errors: [], saved: 0, confirmed: 0};
  const data = {media: replacement ? 'replacement.mp4' : '../clip.mp4', segments: []};
  const context = vm.createContext({
    Blob,
    TypeError,
    document: {getElementById: () => null},
    confirm: () => {calls.confirmed += 1; return accept;},
    MaweBoot: {DATA: data, SERVER_CONFIG: {saveUrl: '/api/project'}, FILENAME_BASE: 'captions'},
    MaweSettings: {EDITOR_SETTINGS: {projectBackupEnabled: false}},
    MaweInlineEdit: {}, MaweDom: {}, MaweCuePanel: {commitCuePanelEdit() {}},
    MaweHistory: {}, MaweAppearance: {},
    MaweCoreState: {container: {querySelectorAll: () => []}},
    MaweState: {segmentsFingerprint: () => 'segments', noteSavedSegments() {}, markSaved() {calls.saved += 1;}},
    MaweProjectLoad: {projectBindingEpoch: 0},
    MaweServerSave: {serverProjectSavingEnabled: () => true, showProjectSaveError(error) {calls.errors.push(error);}},
    MaweJsonRepair: {buildJson(options) {
      calls.build.push(options?.forFileExport === true);
      const media = options?.forFileExport && !replacement ? 'D:/demo/clip.mp4' : data.media;
      return JSON.stringify({...data, media});
    }},
    MaweHost: {server: {fetch: async (_url, request) => {
      calls.posted.push(JSON.parse(request.body));
      if (failure) throw failure;
      return {ok: true, json: async () => ({ok: true, filename: 'captions.mosp'})};
    }}},
    MaweExportTimeline: {downloadFile: async (body, filename) => {
      calls.downloaded.push({project: JSON.parse(body), filename});
      return true;
    }},
    MaweHint: {flashHint() {}},
  });
  vm.runInContext(source, context);
  return {context, calls, save: options => context.MaweProjectSave.saveProjectToServer(options)};
}

test('connection-loss recovery downloads use a file-export reference without changing server saves', async () => {
  const {context, calls, save} = fixture();
  assert.equal(await save(), false);
  assert.equal(calls.posted[0].project.media, '../clip.mp4');
  assert.equal(calls.downloaded[0].project.media, 'D:/demo/clip.mp4');
  assert.equal(calls.downloaded[0].filename, 'captions.mosp');
  assert.deepEqual(calls.build, [false, true]);
  assert.equal(calls.errors.length, 1);
  assert.equal(calls.saved, 0);
  assert.equal(context.MaweBoot.DATA.media, '../clip.mp4');
  assert.equal(context.MaweServerSave.projectSaveInFlight, false);
});

test('recovery respects browser-local replacement media rather than the old native source', async () => {
  const {calls, save} = fixture({replacement: true});
  await save();
  assert.deepEqual(calls.build, [false, true]);
  assert.equal(calls.downloaded[0].project.media, 'replacement.mp4');
});

test('silent autosave failures never prompt or start a recovery download', async () => {
  const {calls, save} = fixture();
  assert.equal(await save({silent: true}), false);
  assert.equal(calls.confirmed, 0);
  assert.equal(calls.downloaded.length, 0);
  assert.deepEqual(calls.build, [false]);
});

test('declining recovery leaves the project unsaved and does not build an export copy', async () => {
  const {calls, save} = fixture({accept: false});
  assert.equal(await save(), false);
  assert.equal(calls.confirmed, 1);
  assert.equal(calls.saved, 0);
  assert.equal(calls.downloaded.length, 0);
  assert.deepEqual(calls.build, [false]);
});

test('successful server saves keep their project-relative reference', async () => {
  const {calls, save} = fixture({failure: null});
  assert.equal(await save(), true);
  assert.equal(calls.posted[0].project.media, '../clip.mp4');
  assert.equal(calls.downloaded.length, 0);
  assert.equal(calls.saved, 1);
  assert.deepEqual(calls.build, [false]);
});

test('non-connection errors do not trigger the recovery-download branch', async () => {
  const {calls, save} = fixture({failure: new Error('Invalid project')});
  assert.equal(await save(), false);
  assert.equal(calls.confirmed, 0);
  assert.equal(calls.downloaded.length, 0);
  assert.deepEqual(calls.build, [false]);
});

test('all pending-load save entrances refuse before writing or opening a picker', async () => {
  const {context, calls} = fixture({failure: null});
  context.MaweState.projectLoadPending = true;
  context.MaweServerSave.projectFileHandle = {name: 'old.mosp'};
  for (const method of ['saveProjectToServer', 'saveProjectToHandle', 'saveCurrentProject', 'saveProjectAsToFile']) {
    assert.equal(await context.MaweProjectSave[method](), false);
  }
  assert.equal(await context.MaweProjectSave.saveProjectToServer({silent: true, backupOnly: true}), false);
  assert.deepEqual(calls.build, []);
  assert.deepEqual(calls.posted, []);
  assert.equal(calls.saved, 0);
});

test('old server success and failure never mark a newly opened project or offer its recovery download', async () => {
  for (const failure of [false, true]) {
    const {context, calls, save} = fixture();
    let release;
    context.MaweHost.server.fetch = () => new Promise((resolve, reject) => {
      release = () => failure ? reject(new TypeError('offline'))
        : resolve({ok: true, json: async () => ({ok: true, filename: 'old.mosp'})});
    });
    const pending = save();
    context.MaweProjectLoad.projectBindingEpoch++;
    release();
    assert.equal(await pending, false);
    assert.equal(calls.saved, 0);
    assert.equal(calls.confirmed, 0);
    assert.equal(calls.errors.length, 0);
  }
});

test('old handle write completes only for its captured content and cannot rename a new project', async () => {
  const {context, calls} = fixture();
  let release;
  context.MaweServerSave.projectFileHandle = {name: 'old.mosp'};
  context.MaweHost.files = {writeBlob: async (handle, build) => {
    assert.equal(handle.name, 'old.mosp');
    assert.ok(build());
    await new Promise(resolve => { release = resolve; });
  }};
  const pending = context.MaweProjectSave.saveProjectToHandle();
  context.MaweProjectLoad.projectBindingEpoch++;
  context.MaweServerSave.projectFileHandle = null;
  release();
  assert.equal(await pending, false);
  assert.equal(calls.saved, 0);
});

test('save-as picker completing after a project switch cannot write or take its handle', async () => {
  const {context, calls} = fixture();
  let release;
  let writes = 0;
  context.MaweHost.files = {hasSavePicker: () => true,
    pickSaveFile: () => new Promise(resolve => {release = resolve;}),
    writeBlob: () => {writes++;},
  };
  const pending = context.MaweProjectSave.saveProjectAsToFile();
  context.MaweProjectLoad.projectBindingEpoch++;
  release({name: 'stale.mosp'});
  assert.equal(await pending, false);
  assert.equal(writes, 0);
  assert.equal(calls.saved, 0);
});
