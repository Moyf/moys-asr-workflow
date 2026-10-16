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
