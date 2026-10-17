import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../web/editor/io/editor-project-save.js', import.meta.url), 'utf8');

function fixture({accept = true, failure = new TypeError('Failed to fetch'), replacement = false} = {}) {
  const calls = {build: [], posted: [], downloaded: [], errors: [], saved: 0, confirmed: 0};
  const data = {media: replacement ? 'replacement.mp4' : '../clip.mp4', segments: []};
  const context = vm.createContext({
    TypeError,
    document: {getElementById: () => null},
    confirm: () => {calls.confirmed += 1; return accept;},
    MaweBoot: {DATA: data, SERVER_CONFIG: {saveUrl: '/api/project'}, FILENAME_BASE: 'captions'},
    MaweSettings: {EDITOR_SETTINGS: {projectBackupEnabled: false}},
    MaweInlineEdit: {}, MaweDom: {}, MaweCuePanel: {commitCuePanelEdit() {}},
    MaweHistory: {}, MaweAppearance: {},
    MaweCoreState: {container: {querySelectorAll: () => []}},
    MaweState: {segmentsFingerprint: () => 'segments', noteSavedSegments() {}, markSaved() {calls.saved += 1;}},
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

test('changing only the timed-text view during a save keeps the newer preference dirty', async () => {
  const {context, calls, save} = fixture({failure: null});
  let finish;
  context.MaweHost.server.fetch = async () => new Promise(resolve => { finish = resolve; });
  context.MaweBoot.DATA.timed_text_edit_view = 'single';
  const pending = save();
  context.MaweBoot.DATA.timed_text_edit_view = 'rows';
  finish({ok: true, json: async () => ({ok: true, filename: 'captions.mosp'})});
  assert.equal(await pending, true);
  assert.equal(calls.saved, 0);
  context.MaweHost.server.fetch = async () => ({ok: true, json: async () => ({ok: true, filename: 'captions.mosp'})});
  assert.equal(await save(), true);
  assert.equal(calls.saved, 1);
});

test('non-connection errors do not trigger the recovery-download branch', async () => {
  const {calls, save} = fixture({failure: new Error('Invalid project')});
  assert.equal(await save(), false);
  assert.equal(calls.confirmed, 0);
  assert.equal(calls.downloaded.length, 0);
  assert.deepEqual(calls.build, [false]);
});

// 脏态指示器事件层：模拟浏览器环境（window/document/setInterval 存在），
// 验证 markProjectDirty 事件即时刷新指示器，且 1s 轮询退化为 O(1) epoch 比较。
function indicatorFixture() {
  const listeners = new Set();
  const state = {epoch: 0, unsaved: false};
  let tick = null;
  let recomputes = 0;
  const jsonEl = {
    classList: {
      contains: name => name === 'empty' ? false : jsonEl._classes.has(name),
      add: name => jsonEl._classes.add(name),
      remove: name => jsonEl._classes.delete(name),
      toggle(name, value) {
        recomputes += 1;
        if (value) jsonEl._classes.add(name); else jsonEl._classes.delete(name);
      },
    },
    _classes: new Set(),
    textContent: 'captions.mosp',
    title: '',
  };
  const context = vm.createContext({
    window: {},
    document: {getElementById: () => jsonEl, addEventListener() {}},
    setInterval: (fn) => { tick = fn; return 7; },
    confirm: () => false,
    MaweBoot: {DATA: {segments: []}, SERVER_CONFIG: {saveUrl: '/api/project'}, FILENAME_BASE: 'captions'},
    MaweSettings: {EDITOR_SETTINGS: {projectBackupEnabled: false}},
    MaweInlineEdit: {}, MaweDom: {}, MaweCuePanel: {commitCuePanelEdit() {}},
    MaweHistory: {}, MaweAppearance: {},
    MaweCoreState: {container: {querySelectorAll: () => []}},
    MaweState: {
      segmentsFingerprint: () => 'segments',
      noteSavedSegments() {},
      markSaved() {},
      onProjectDirtyChange(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getProjectDirtyEpoch: () => state.epoch,
    },
    MaweServerSave: {serverProjectSavingEnabled: () => true, showProjectSaveError() {}, hasUnsavedProjectChanges: () => state.unsaved},
    MaweJsonRepair: {buildJson: () => JSON.stringify({segments: []})},
    MaweHost: {server: {fetch: async () => ({ok: true, json: async () => ({ok: true, filename: 'captions.mosp'})})}},
    MaweHint: {flashHint() {}},
  });
  context.window = context;
  vm.runInContext(source, context);
  return {
    listeners,
    jsonEl,
    state,
    fireDirtyEvent() { state.epoch += 1; for (const listener of [...listeners]) listener(state.epoch); },
    bumpEpochOnly() { state.epoch += 1; },
    runTick() { assert.ok(tick, 'poll must be scheduled in a browser-like environment'); tick(); },
    recomputeCount: () => recomputes,
    save: options => context.MaweProjectSave.saveProjectToServer(options),
    markSaved: () => context.MaweProjectSave.markProjectSaved('captions.mosp', null),
  };
}

test('dirty events refresh the unsaved indicator immediately and drive it from markProjectSaved', () => {
  const view = indicatorFixture();
  assert.equal(view.listeners.size, 1, 'save module must register exactly one dirty listener');
  assert.equal(view.recomputeCount(), 0);
  view.runTick();
  assert.equal(view.recomputeCount(), 0, 'unchanged epoch must not recompute (O(1) poll, baseline set at registration)');
  view.fireDirtyEvent();
  assert.equal(view.recomputeCount(), 1, 'dirty event must refresh the indicator synchronously');
  assert.equal(view.jsonEl._classes.has('dirty'), false, 'stub reports a clean project');
  view.markSaved();
  assert.equal(view.recomputeCount(), 2, 'successful save must refresh the indicator directly');
});

test('the O(1) poll self-heals when an epoch bump was missed by the event path', () => {
  const view = indicatorFixture();
  view.bumpEpochOnly();
  view.runTick();
  assert.equal(view.recomputeCount(), 1, 'epoch change without an event must still trigger one recompute');
  view.runTick();
  assert.equal(view.recomputeCount(), 1, 'second tick with the same epoch stays idle');
});

test('the indicator dot reflects the dirty state reported by the save module on every refresh', () => {
  const view = indicatorFixture();
  view.state.unsaved = true;
  view.fireDirtyEvent();
  assert.equal(view.jsonEl._classes.has('dirty'), true);
  assert.match(view.jsonEl.title, /有未保存的修改/);
  view.state.unsaved = false;
  view.fireDirtyEvent();
  assert.equal(view.jsonEl._classes.has('dirty'), false);
  assert.doesNotMatch(view.jsonEl.title, /有未保存的修改/);
});
