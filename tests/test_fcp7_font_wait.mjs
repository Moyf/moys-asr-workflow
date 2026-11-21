import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import { waitForFcp7Fonts } from '../web/editor/io/editor-fcp7-png.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

for (const stage of ['coverage', 'ready']) {
  test(`cancelling ${stage} leaves the shared font operation running`, async () => {
    const gate = deferred();
    const entered = deferred();
    const controller = new AbortController();
    const calls = [];
    const fonts = {
      ensureCoverage(...args) { calls.push(['coverage', args.length]); if (stage === 'coverage') { entered.resolve(); return gate.promise; } },
      whenReady(...args) { calls.push(['ready', args.length]); entered.resolve(); return gate.promise; },
    };
    let otherFinished = false;
    const other = gate.promise.then(() => { otherFinished = true; });
    const waiting = waitForFcp7Fonts(fonts, controller.signal);
    await entered.promise;
    controller.abort();
    await assert.rejects(waiting, { name: 'AbortError' });
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal(otherFinished, false);
    gate.resolve();
    await other;
    assert.equal(otherFinished, true);
    assert.deepEqual(calls, stage === 'coverage' ? [['coverage', 0]] : [['coverage', 0], ['ready', 0]]);
  });

  test(`cancelling as ${stage} resolves wins before the next operation`, async () => {
    const gate = deferred();
    const entered = deferred();
    const controller = new AbortController();
    let readyCalls = 0;
    const fonts = {
      ensureCoverage() { if (stage === 'coverage') { entered.resolve(); return gate.promise; } },
      whenReady() { readyCalls++; entered.resolve(); return gate.promise; },
    };
    const waiting = waitForFcp7Fonts(fonts, controller.signal);
    await entered.promise;
    gate.resolve();
    controller.abort();
    await assert.rejects(waiting, { name: 'AbortError' });
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal(readyCalls, stage === 'coverage' ? 0 : 1);
  });
}

test('already cancelled exports never start font loading', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(waitForFcp7Fonts({ ensureCoverage() { calls++; } }, controller.signal), { name: 'AbortError' });
  assert.equal(calls, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('successful and failed font waits remove the listener and preserve errors', async () => {
  const controller = new AbortController();
  await waitForFcp7Fonts(undefined, controller.signal);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  for (const stage of ['coverage', 'ready']) {
    const failure = new Error(`${stage} failed`);
    const fonts = { ensureCoverage() { if (stage === 'coverage') throw failure; },
      whenReady() { if (stage === 'ready') return Promise.reject(failure); } };
    await assert.rejects(waitForFcp7Fonts(fonts, controller.signal), error => error === failure);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
});

test('a shared font operation can reject after cancellation without an unhandled rejection', async () => {
  const gate = deferred();
  const entered = deferred();
  const controller = new AbortController();
  const waiting = waitForFcp7Fonts({ ensureCoverage() { entered.resolve(); return gate.promise; } }, controller.signal);
  await entered.promise;
  controller.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  gate.reject(new Error('late failure'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
