import assert from 'node:assert/strict';
import test from 'node:test';
import { runFcp7PngExport } from '../web/editor/io/editor-fcp7-png.js';

function setup(t, handler) {
  const previous = new Map(['window', 'MaweBoot', 'MaweExportSrt', 'fetch'].map(key => [key, globalThis[key]]));
  const config = { fcp7PngJobsUrl: '/jobs', requestToken: 'token', bindingGeneration: 1, sourceMediaId: 'media' };
  globalThis.window = Object.assign(new EventTarget(), { MaweProjectLoad: { projectBindingEpoch: 1 },
    AsrEditorUtils: { serializeFcp7PngXml: () => '<xmeml/>' } });
  globalThis.MaweBoot = { SERVER_CONFIG: config };
  globalThis.MaweExportSrt = { currentAssVideoResolution: () => ({ width: 640, height: 360 }) };
  globalThis.fetch = async (url, options) => ({ ok: true, json: async () => handler(url, options) });
  t.after(() => { for (const [key, value] of previous) {
    if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  } });
  return { plan: { frameProfile: { name: '25' }, outputDurationMs: 1000 },
    config, ass: 'ASS snapshot', layers: [0], includeMedia: false, size: { width: 640, height: 360 }, signal: new AbortController().signal,
    onProgress: () => {} };
}

test('PNG client publishes its captured snapshot and does not cancel a completed export', async t => {
  const calls = [];
  const args = setup(t, (url, options) => {
    calls.push([url, options]);
    if (url === '/jobs') return { jobId: 'one', state: 'ready', manifest: { sourceKind: 'video' } };
    assert.equal(url, '/jobs/one/publish');
    return { xmlPath: 'result.xml' };
  });
  assert.equal((await runFcp7PngExport(args)).xmlPath, 'result.xml');
  assert.equal(calls.length, 2);
  const request = JSON.parse(calls[0][1].body);
  assert.equal(request.ass, 'ASS snapshot');
  assert.equal(request.width, 640);
  assert.equal(request.bindingGeneration, 1);
  assert.equal(request.imageFormat, 'png');
});

test('WebP client submits an explicit format without changing the captured ASS', async t => {
  const args = setup(t, (url, options) => {
    if (url === '/jobs') {
      const request = JSON.parse(options.body);
      assert.equal(request.imageFormat, 'webp');
      assert.equal(request.ass, 'ASS snapshot');
      return { jobId: 'one', state: 'ready', manifest: { sourceKind: 'video' } };
    }
    return { xmlPath: 'webp.xml' };
  });
  assert.equal((await runFcp7PngExport({ ...args, imageFormat: 'webp' })).xmlPath, 'webp.xml');
});

test('image client forwards selected dimensions and render progress', async t => {
  const updates = [];
  let request;
  const args = setup(t, (url, options) => {
    if (url === '/jobs') {
      request = JSON.parse(options.body);
      return { jobId: 'one', state: 'rendering', progress: 0.42 };
    }
    if (url === '/jobs/one') return { state: 'ready', manifest: { sourceKind: 'video' } };
    assert.equal(url, '/jobs/one/publish');
    return { xmlPath: 'result.xml' };
  });
  args.size = { width: 1280, height: 720 };
  args.onProgress = (text, value) => updates.push([text, value]);
  await runFcp7PngExport(args);
  assert.equal(request.width, 1280);
  assert.equal(request.height, 720);
  assert.deepEqual(updates[0], ['正在生成字幕图片：42%', 0.42]);
  assert.equal(updates[1][1], undefined);
});

test('PNG client waits for cancellation cleanup before returning AbortError', async t => {
  let cancellations = 0;
  const controller = new AbortController();
  const args = setup(t, url => {
    if (url === '/jobs') { controller.abort(); return { jobId: 'one', state: 'rendering' }; }
    if (url.endsWith('cancel-admission')) return { cleanupComplete: true };
    assert.equal(url, '/jobs/one/cancel');
    return { cleanupComplete: ++cancellations >= 2 };
  });
  args.signal = controller.signal;
  await assert.rejects(runFcp7PngExport(args), { name: 'AbortError' });
  assert.equal(cancellations, 2);
});

test('PNG client cleans up when the project binding changes before publication', async t => {
  let cancelled = false;
  const args = setup(t, url => {
    if (url === '/jobs') {
      window.MaweProjectLoad.projectBindingEpoch += 1;
      return { jobId: 'one', state: 'ready', manifest: {} };
    }
    assert.equal(url, '/jobs/one/cancel');
    cancelled = true;
    return { cleanupComplete: true };
  });
  await assert.rejects(runFcp7PngExport(args), /绑定已变更/);
  assert.equal(cancelled, true);
});

test('PNG client reports unconfirmed cleanup instead of claiming it stopped', async t => {
  const controller = new AbortController();
  const args = setup(t, url => {
    if (url === '/jobs') { controller.abort(); return { jobId: 'one', state: 'rendering' }; }
    if (url.endsWith('cancel-admission')) return { cleanupComplete: true };
    throw new Error('connection lost');
  });
  args.signal = controller.signal;
  await assert.rejects(runFcp7PngExport(args), /无法确认.*connection lost/);
});
