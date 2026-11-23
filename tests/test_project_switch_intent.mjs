import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { invokedInitModuleSource } from './helpers/init-module-source.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
const response = result => ({ ok: true, json: async () => ({ ok: true, ...result }) });

function fixture(transport) {
  const calls = [], hints = [];
  let detached = 0, reloads = 0;
  const context = vm.createContext({
    document: { getElementById: () => null, body: { inert: false } },
    MaweBoot: { DATA: { segments: [] }, SERVER_CONFIG: {
      canSave: true, attachUrl: '/api/project/attach', projectSwitchPageId: 'page-a',
      requestToken: 'page-token', bindingGeneration: 1, sourceMediaId: 'original',
    } },
    MaweProjectLoad: { projectBindingEpoch: 0, detachServerProjectSaving() { detached++; } },
    MaweProjectSave: { inlineEditHasUncommittedText: () => false },
    MaweHint: { flashHint: message => hints.push(message) },
    MaweHost: { server: { fetch(url, options) {
      const body = JSON.parse(options.body);
      calls.push({ url, body });
      return transport(url, body);
    } } },
    window: { location: { reload() { reloads++; } }, addEventListener() {}, removeEventListener() {} },
  });
  context.window.MaweBoot = context.MaweBoot;
  vm.runInContext(readFileSync(new URL('../web/editor/boot/editor-runtime.js', import.meta.url), 'utf8'), context);
  vm.runInContext(invokedInitModuleSource('editor/state/editor-state.js', 'initMaweState'), context);
  context.MaweState = context.window.MaweState;
  vm.runInContext(invokedInitModuleSource('editor/io/editor-server-save.js', 'initMaweServerSave'), context);
  return { context, calls, hints, state: context.MaweState, api: context.window.MaweServerSave,
    detached: () => detached, reloads: () => reloads };
}

test('local-only loads notify immediately while an older attach is still blocked', async () => {
  const entered = deferred(), release = deferred();
  const f = fixture(async url => {
    if (url === '/api/project/switch-intent') return response({});
    entered.resolve();
    await release.promise;
    return response({ bindingGeneration: 2, sourceMediaId: 'old-attach' });
  });
  f.state.beginProjectLoad();
  const old = f.api.attachProjectToServer('a.mosp', {});
  await entered.promise;
  f.state.beginProjectLoad(); // portable B does not call attach
  assert.deepEqual(f.calls.map(c => c.url), [
    '/api/project/switch-intent', '/api/project/attach', '/api/project/switch-intent',
  ]);
  assert.equal(f.calls[2].body.switchGeneration, 2);
  assert.equal(f.calls[1].body.switchGeneration, 1);
  assert.equal(await old, false);
  release.resolve();
  await Promise.resolve();
  assert.equal(f.reloads(), 0);
});

test('attach waits for its intent acknowledgement and carries the matching page and generation', async () => {
  const acknowledged = deferred(), attached = deferred();
  const f = fixture(async url => {
    if (url === '/api/project/switch-intent') { await acknowledged.promise; return response({}); }
    attached.resolve();
    return response({ bindingGeneration: 2, sourceMediaId: 'attached' });
  });
  f.state.beginProjectLoad();
  const opening = f.api.attachProjectToServer('a.mosp', {});
  await Promise.resolve();
  assert.equal(f.calls.length, 1);
  acknowledged.resolve();
  await attached.promise;
  assert.equal(await opening, true);
  assert.equal(f.calls[1].body.switchPageId, 'page-a');
  assert.equal(f.calls[1].body.switchGeneration, 1);
  assert.equal(f.calls[1].body.bindingGeneration, 1);
});

test('failed invalidation detaches server saving and never sends or retries an attach', async () => {
  const f = fixture(async () => { throw new TypeError('offline'); });
  f.state.beginProjectLoad();
  assert.equal(await f.api.attachProjectToServer('a.mosp', {}), false);
  assert.equal(f.calls.length, 1);
  assert.equal(f.detached(), 1);
  assert.equal(f.hints.length, 1);
  assert.equal(f.reloads(), 0);
});

test('a later explicit open recovers when an accepted intent response was lost', async () => {
  let serverGeneration = -1;
  const f = fixture(async (url, body) => {
    if (url === '/api/project/switch-intent') {
      serverGeneration = body.switchGeneration;
      if (serverGeneration === 1) throw new TypeError('accepted response lost');
      return response({});
    }
    assert.equal(body.switchGeneration, serverGeneration);
    return response({ bindingGeneration: 2, sourceMediaId: 'recovered' });
  });
  f.state.beginProjectLoad();
  assert.equal(await f.api.attachProjectToServer('a.mosp', {}), false);
  assert.equal(serverGeneration, 1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.detached(), 1);
  assert.equal(f.reloads(), 0);
  f.state.beginProjectLoad(); // Only another explicit open starts recovery.
  assert.equal(await f.api.attachProjectToServer('b.mosp', {}), true);
  assert.equal(serverGeneration, 2);
  assert.deepEqual(f.calls.map(c => c.url), [
    '/api/project/switch-intent', '/api/project/switch-intent', '/api/project/attach',
  ]);
  assert.equal(f.reloads(), 1);
});

test('late failed notification cannot detach or warn in a newer local project', async () => {
  const old = deferred();
  const f = fixture(async (_url, body) => {
    if (body.switchGeneration === 1) { await old.promise; throw new TypeError('old failure'); }
    return response({});
  });
  f.state.beginProjectLoad();
  f.state.beginProjectLoad();
  old.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.detached(), 0);
  assert.deepEqual(f.hints, []);
});

test('native switch asks to discard a project settings edit that settled after picking', async () => {
  const settingsSettling = deferred(), entered = deferred();
  const f = fixture(url => {
    assert.equal(url, '/api/project/native-pick');
    return response({ selection: 'selected' });
  });
  f.context.window.MaweStickerRoot = { waitForPending() { entered.resolve(); return settingsSettling.promise; } };
  let confirms = 0;
  f.context.confirm = () => { confirms++; return false; };
  const opening = f.api.openNativeProject('session');
  // Yield for the picker response (the old flow does not await settings).
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 1);
  await entered.promise;
  f.state.changes.projectImportDirty = true;
  settingsSettling.resolve();
  await opening;
  assert.equal(confirms, 1);
  assert.equal(f.reloads(), 0);
  assert.equal(f.detached(), 0);
  assert.equal(f.context.document.body.inert, false);
});

test('native switch never binds if the ASS style library could not be saved', async () => {
  const f = fixture(url => {
    assert.equal(url, '/api/project/native-pick');
    return response({ selection: 'selected' });
  });
  f.context.window.MaweAssStorageWiring = { flushBeforeProjectSwitch: async () => false };
  await f.api.openNativeProject('session');
  assert.equal(f.calls.length, 1);
  assert.equal(f.reloads(), 0);
  assert.equal(f.context.document.body.inert, false);
  assert.match(f.hints[0], /ASS 样式库/);
});
