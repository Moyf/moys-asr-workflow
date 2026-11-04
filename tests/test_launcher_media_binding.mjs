import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import vm from 'node:vm';

function fixture() {
  const controls = new Map();
  const $ = id => {
    if (!controls.has(id)) controls.set(id, {
      value: '', checked: false,
      classList: {add() {}, remove() {}, toggle() {}},
    });
    return controls.get(id);
  };
  $('jsonPath').value = 'captions.mosp';
  $('serverMediaPath').value = 'clip.mp4';
  $('serverRememberMedia').checked = true;
  const calls = [];
  const context = vm.createContext({$, state: {
    lang: 'zh', serverRunning: true, serverProjectPath: 'captions.mosp',
  }, serverRestartProjectPath: null, serverStatusRequest: 0,
  window: {}, clearTimeout() {},
  refreshServerMedia: async () => ({hasMedia: false, mediaExists: false}),
  bridge: async (method, payload) => { calls.push({method, ...payload}); return {ok: false}; },
  applyErrorResult() {}, expandServer() {}, syncFlvHints() {},
  });
  for (const file of ['forms/launcher-form-sync.js', 'forms/launcher-media-form.js', 'boot/launcher-settings-startup.js']) {
    vm.runInContext(readFileSync(new URL(`../web/launcher/${file}`, import.meta.url), 'utf8'), context);
  }
  vm.runInContext('clearErrors = () => {}; renderServerButton = () => {}; applyErrorResult = () => {};', context);
  return {context, $, calls};
}

test('Launcher passes remember-media preference and does not bypass a changed association', async () => {
  for (const remember of [true, false]) {
    const {context, $, calls} = fixture();
    $('serverRememberMedia').checked = remember;
    await vm.runInContext('openServerEditor()', context);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'start_server');
    assert.equal(calls[0].mediaPath, 'clip.mp4');
    assert.equal(calls[0].rememberMedia, remember);
  }
});

test('without a new media selection the existing bound editor can be reused', async () => {
  const {context, $, calls} = fixture();
  $('serverMediaPath').value = '';
  await vm.runInContext('openServerEditor()', context);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'open_url');
});

test('resetting the project clears stale manual media and restores remember default', () => {
  const {context, $} = fixture();
  $('serverRememberMedia').checked = false;
  vm.runInContext('resetServerMediaSelection()', context);
  assert.equal($('serverMediaPath').value, '');
  assert.equal($('serverRememberMedia').checked, true);
});

function pendingMediaFixture() {
  const {context, $} = fixture();
  const pending = [];
  const hidden = new Map();
  $('serverMediaField').classList.toggle = (name, value) => hidden.set(name, value);
  context.renderMessage = () => {};
  context.bridge = (_method, payload) => new Promise(resolve => pending.push({payload, resolve}));
  vm.runInContext(readFileSync(new URL('../web/launcher/server/launcher-media-server.js', import.meta.url), 'utf8'), context);
  return {context, $, pending, hidden};
}

for (const currentHasMedia of [true, false]) {
  test(`a stale project media response cannot ${currentHasMedia ? 'show' : 'hide'} the current media picker`, async () => {
    const {context, $, pending, hidden} = pendingMediaFixture();
    vm.runInContext("setJsonPath('old.mosp'); setJsonPath('current.mosp');", context);
    assert.deepEqual(pending.map(call => call.payload.jsonPath), ['old.mosp', 'current.mosp']);

    pending[1].resolve({hasMedia: currentHasMedia, mediaExists: currentHasMedia});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(context.state.serverMediaOk, currentHasMedia);
    assert.equal(hidden.get('hidden'), currentHasMedia);

    pending[0].resolve({hasMedia: !currentHasMedia, mediaExists: !currentHasMedia});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal($('jsonPath').value, 'current.mosp');
    assert.equal(context.state.serverMediaOk, currentHasMedia);
    assert.equal(hidden.get('hidden'), currentHasMedia);
  });
}
