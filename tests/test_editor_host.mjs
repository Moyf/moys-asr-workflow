import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { createStorage } from '../web/shared/host/storage.js';
import { createFiles } from '../web/shared/host/files.js';
import { createServerApi } from '../web/shared/host/server-api.js';

const factories = new Map([
  ['shared/host/storage.js', ['host-storage',createStorage]],
  ['shared/host/files.js', ['host-files',createFiles]],
  ['shared/host/server-api.js', ['host-server-api',createServerApi]],
]);

// editor-host.js is an ESM init module (G03): it imports the host trio
// directly, so the loader strips the import statements and evaluates the
// remaining classic body, then invokes initEditorHost(). MAWE registration
// inside is optional-guarded.
function loadHost(environment = {}) {
  const context = { window: {}, console, ...environment };
  context.globalThis = context;
  // The host file imports the trio; after stripping imports the classic body
  // references the names — bind the real imported factories.
  context.createStorage = createStorage;
  context.createFiles = createFiles;
  context.createServerApi = createServerApi;
  const registered = new Map();
  context.window.MAWE = {
    register(name, factory) { registered.set(name, factory); },
    resolve(name, ...args) { const factory = registered.get(name); return factory ? factory(...args) : undefined; },
  };
  const host_source = readFileSync(new URL('../web/editor/boot/editor-host.js', import.meta.url), 'utf8');
  const classic = host_source
    .replace(/^import \{[^}]+\} from '[^']+';$/gm, '')
    .replace(/^export function initEditorHost/m, 'function initEditorHost');
  vm.runInNewContext(classic + '\ninitEditorHost();', context, { filename: 'editor/boot/editor-host.js' });
  return context;
}

test('host startup needs no DOM, storage, picker or network capability', () => {
  const context = loadHost();
  const host = context.window.MaweHost;
  assert.equal(host.files.hasSavePicker(), false);
  assert.throws(() => host.storage.getItem('settings'), { name: 'TypeError' });
  // Private-mode failure is left to each existing settings fallback.
  context.localStorage = { getItem() { throw new Error('denied'); } };
  assert.throws(() => host.storage.getItem('settings'), /denied/);
  context.window.showSaveFilePicker = () => {};
  assert.equal(host.files.hasSavePicker(), true);
});

test('file writes complete before close, and failed writes propagate to the caller', async () => {
  const { files } = loadHost().window.MaweHost;
  const calls = [];
  const blob = { payload: 'project' };
  const handle = { async createWritable() {
    calls.push('open');
    return { async write(value) { assert.equal(value, blob); calls.push('write'); },
      async close() { calls.push('close'); } };
  } };
  await files.writeBlob(handle, () => { calls.push('build'); return blob; });
  assert.deepEqual(calls, ['open', 'build', 'write', 'close']);
  let closed = false;
  await assert.rejects(files.writeBlob({ async createWritable() {
    return { async write() { throw new Error('disk full'); }, async close() { closed = true; } };
  } }, () => blob), /disk full/);
  assert.equal(closed, false);
});

test('picker cancellation remains distinguishable from a failed write', async () => {
  const context = loadHost();
  const cancelled = Object.assign(new Error('cancel'), { name: 'AbortError' });
  context.window.showSaveFilePicker = async () => { throw cancelled; };
  await assert.rejects(context.window.MaweHost.files.pickSaveFile({ suggestedName: 'demo.mosp' }), error => error === cancelled);
});

test('a cancelled snapshot aborts the writable stream and preserves the original error', async () => {
  const context = loadHost();
  const error = Object.assign(new Error('project changed'), {name: 'AbortError'});
  const calls = [];
  await assert.rejects(context.window.MaweHost.files.writeBlob({async createWritable() {
    return {write() {calls.push('write');}, close() {calls.push('close');}, abort() {calls.push('abort');}};
  }}, () => {throw error;}), found => found === error);
  assert.deepEqual(calls, ['abort']);
});

test('download fallback dispatches once and keeps the object URL until deferred cleanup', () => {
  const calls = [], anchor = { click() { calls.push('click'); } };
  let cleanup;
  const context = loadHost({
    document: { createElement: () => anchor, body: {
      appendChild: value => { assert.equal(value, anchor); calls.push('append'); },
      removeChild: value => { assert.equal(value, anchor); calls.push('remove'); },
    } },
    URL: { createObjectURL: () => 'blob:project', revokeObjectURL: value => calls.push(value) },
    setTimeout(callback, ms) { assert.equal(ms, 1000); cleanup = callback; },
  });
  context.window.MaweHost.files.downloadBlob({}, 'demo.mosp');
  assert.equal(anchor.download, 'demo.mosp');
  assert.equal(anchor.href, 'blob:project');
  assert.deepEqual(calls, ['append', 'click', 'remove']);
  cleanup();
  assert.equal(calls.at(-1), 'blob:project');
});

test('server transport resolves URLs and preserves request identity and rejection', async () => {
  const context = loadHost({ URL });
  context.window.location = { href: 'http://127.0.0.1:8765/editor/index.html' };
  const options = { method: 'POST', signal: new AbortController().signal };
  const response = { ok: false, status: 422 };
  context.fetch = async (url, init) => {
    assert.equal(String(url), 'http://127.0.0.1:8765/api/project/save');
    assert.equal(init, options);
    return response;
  };
  assert.equal(await context.window.MaweHost.server.fetch('/api/project/save', options), response);
  context.fetch = async () => { throw new TypeError('offline'); };
  await assert.rejects(context.window.MaweHost.server.fetch('/api/project/save'), /offline/);
});

test('a desktop host can replace every capability without initializing browser services', () => {
  const context = loadHost();
  const capabilities = Object.fromEntries(['storage', 'files', 'server', 'runtime'].map(name => [name, { name }]));
  const host = context.window.MAWE.resolve('editor-host', capabilities);
  for (const name of Object.keys(capabilities)) assert.equal(host[name], capabilities[name]);
});

test('resolve with an injected environment reads that environment for runtime', () => {
  const context = loadHost({ navigator: { platform: 'MacIntel' } });
  const capabilities = { environment: { navigator: { platform: 'Win32' } } };
  const host = context.window.MAWE.resolve('editor-host', capabilities);
  assert.equal(host.runtime.getNavigator().platform, 'Win32');
  assert.equal(host.runtime.hasUserActivation(), false);
  // 默认路径仍读当前页面环境。
  assert.equal(context.window.MaweHost.runtime.getNavigator().platform, 'MacIntel');
});
