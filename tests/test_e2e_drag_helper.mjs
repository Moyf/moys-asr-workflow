import assert from 'node:assert/strict';
import test from 'node:test';
import { dragFloatingPanelAwayFrom } from './e2e/helpers.mjs';

test('floating drag fixture remeasures a header repositioned after opening', async () => {
  const originals = Object.fromEntries(['document', 'requestAnimationFrame', 'innerWidth', 'innerHeight']
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let left = 100;
  let dragging = false;
  let downAt;
  let point;
  const rect = (x, y, width, height) => ({ x, y, width, height, toJSON() { return { x, y, width, height }; } });
  const panel = { getBoundingClientRect: () => rect(left, 20, 300, 200), classList: { contains: () => dragging } };
  const handle = { getBoundingClientRect: () => rect(left, 20, 300, 30), contains: element => element === handle };
  const target = { getBoundingClientRect: () => rect(10, 500, 40, 30) };
  const selectors = { '#panel': panel, '#handle': handle, '#target': target };
  globalThis.innerWidth = 1280;
  globalThis.innerHeight = 800;
  globalThis.requestAnimationFrame = callback => { left = 600; callback(0); };
  globalThis.document = {
    querySelector: selector => selectors[selector],
    elementFromPoint: (x, y) => x >= left && x <= left + 300 && y >= 20 && y <= 50 ? handle : null,
  };
  const page = {
    locator: selector => ({ boundingBox: async () => selectors[selector].getBoundingClientRect().toJSON(),
      evaluate: async callback => callback(selectors[selector]) }),
    evaluateHandle: async callback => ({ value: callback(), dispose: async () => {} }),
    waitForFunction: async (callback, args) => {
      for (let attempt = 0; attempt < 4; attempt++) {
        // Match Playwright: truthiness is checked before Promise assimilation.
        // The original async predicate stopped on its first Promise, even when
        // that Promise later resolved false. Do not hide this in the mock.
        const value = callback({ ...args, sample: args.sample?.value });
        if (value) return { jsonValue: async () => await value, dispose: async () => {} };
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      throw new Error('Never found the relocated drag handle');
    },
    evaluate: async (callback, args) => callback(args),
    mouse: {
      move: async (x, y) => { point = { x, y }; if (dragging) left = x - 40; },
      down: async () => { downAt = point; dragging = true; },
      up: async () => { dragging = false; },
    },
  };
  try {
    const result = await dragFloatingPanelAwayFrom(page, '#panel', '#handle', '#target');
    assert.deepEqual(downAt, { x: 640, y: 35 });
    assert.equal(result.panelBefore.x, 600);
    assert.equal(result.overlaps, false);
  } finally {
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
