import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const runtimeSource = fs.readFileSync(new URL('../web/editor-runtime.js', import.meta.url), 'utf8');
const servicesSource = fs.readFileSync(new URL('../web/editor-services.js', import.meta.url), 'utf8');

function loadServices() {
  const context = {
    Blob,
    URL,
    console,
    setTimeout,
    window: {},
  };
  vm.runInNewContext(runtimeSource, context);
  vm.runInNewContext(servicesSource, context);
  return context.window.MAWE.resolve('editor-services');
}

function fakeDocument(clicks = []) {
  return {
    body: {
      appendChild() {},
      removeChild() {},
    },
    createElement(tagName) {
      assert.equal(tagName, 'a');
      return {
        click() { clicks.push({ href: this.href, download: this.download }); },
      };
    },
  };
}

test('settings store normalizes reads and degrades when storage is unavailable', () => {
  const services = loadServices();
  const values = new Map();
  const store = services.createSettingsStore({
    key: 'editor',
    storage: {
      getItem: (key) => values.get(key) || null,
      setItem: (key, value) => values.set(key, value),
    },
    normalize: (value) => ({ ...value, normalized: true }),
  });
  assert.deepEqual(JSON.parse(JSON.stringify(store.read())), { normalized: true });
  assert.equal(store.write({ theme: 'dark' }), true);
  assert.deepEqual(JSON.parse(JSON.stringify(store.read())), { theme: 'dark', normalized: true });

  const unavailable = services.createSettingsStore({
    key: 'editor',
    storage: {
      getItem() { throw new Error('denied'); },
      setItem() { throw new Error('denied'); },
    },
    normalize: (value) => value,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(unavailable.read())), {});
  assert.equal(unavailable.write({ theme: 'light' }), false);
});

test('download service falls back to an anchor and supports picker writes', async () => {
  const services = loadServices();
  const clicks = [];
  const revoked = [];
  const fallbackWindow = {
    Blob,
    URL: {
      createObjectURL: () => 'blob:test',
      revokeObjectURL: (url) => revoked.push(url),
    },
    setTimeout: (callback) => callback(),
  };
  const fallback = services.createDownloadService({
    windowRef: fallbackWindow,
    documentRef: fakeDocument(clicks),
  });
  assert.equal(fallback.downloadBlob('text', 'demo.txt', 'text/plain'), true);
  assert.deepEqual(clicks, [{ href: 'blob:test', download: 'demo.txt' }]);
  assert.deepEqual(revoked, ['blob:test']);
  assert.deepEqual(JSON.parse(JSON.stringify(await fallback.save('text', 'demo.txt', 'text/plain'))), {
    ok: true,
    method: 'download',
    name: 'demo.txt',
  });

  let written = '';
  const pickerWindow = {
    Blob,
    URL: fallbackWindow.URL,
    setTimeout: (callback) => callback(),
    showSaveFilePicker: async (options) => ({
      name: options.suggestedName,
      async createWritable() {
        return {
          async write(blob) { written = await blob.text(); },
          async close() {},
        };
      },
    }),
  };
  const picker = services.createDownloadService({
    windowRef: pickerWindow,
    documentRef: fakeDocument(),
  });
  assert.deepEqual(JSON.parse(JSON.stringify(
    await picker.saveWithPicker('payload', 'demo.json', 'application/json'),
  )), {
    ok: true,
    name: 'demo.json',
  });
  assert.equal(written, 'payload');
  assert.deepEqual(JSON.parse(JSON.stringify(await picker.pickFilename('prefix.srt', {
    desc: 'SRT', types: { 'text/plain': ['.srt'] },
  }))), { ok: true, name: 'prefix.srt' });
});

test('server API resolves URLs and exposes structured server errors', async () => {
  const services = loadServices();
  const calls = [];
  const api = services.createServerApi({
    baseUrl: 'https://example.test/editor/index.html',
    fetchRef: async (url, options) => {
      calls.push({ url: String(url), options });
      return { ok: true, status: 200, json: async () => ({ ok: true, value: 42 }) };
    },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await api.postJson('/api/save', { name: 'demo' }))), {
    ok: true,
    value: 42,
  });
  assert.equal(calls[0].url, 'https://example.test/api/save');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), { name: 'demo' });

  const failing = services.createServerApi({
    baseUrl: 'https://example.test/editor/index.html',
    fetchRef: async () => ({
      ok: false,
      status: 409,
      json: async () => ({ ok: false, error: '工程不存在', missing: true }),
    }),
  });
  await assert.rejects(
    failing.postJson('/api/recent', { path: 'missing.mosp' }),
    (error) => error.message === '工程不存在' && error.status === 409 && error.missing === true,
  );
});
