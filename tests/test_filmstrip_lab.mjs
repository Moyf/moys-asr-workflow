import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameCache, displayToSource, nearestFrame, visibleSamples } from '../web/experiments/filmstrip/core.mjs';
test('removed interval maps displayed boundary to next retained source', () => {
  const intervals = [{ start: 0, end: 1000 }, { start: 3000, end: 5000 }];
  assert.equal(displayToSource(1000, intervals), 3000);
  assert.equal(displayToSource(1600, intervals), 3600);
  assert.equal(displayToSource(99999, intervals), 5000);
  const cells = visibleSamples(1000, 2000, 600, 120, intervals, 5000);
  assert.equal(cells.length, 5); assert.equal(cells[0].sourceMs, 3200);
});
test('visible work is bounded even at extreme zoom', () => {
  const cells = visibleSamples(0, 7200000, 20000, 1, [{ start: 0, end: 7200000 }], 7200000);
  assert.equal(cells.length, 32);
  assert.ok(cells.at(-1).sourceMs < 7200000);
});
test('cache eviction closes resources and refreshes LRU', () => {
  const closed = [];
  const cache = new FrameCache(100, 2);
  cache.set('a', { close: () => closed.push('a') }, 40);
  cache.set('b', { close: () => closed.push('b') }, 40);
  cache.get('a'); cache.set('c', { close: () => closed.push('c') }, 40);
  assert.deepEqual(closed, ['b']); assert.equal(cache.bytes, 80);
  cache.clear(); assert.equal(cache.bytes, 0); assert.deepEqual(closed, ['b', 'a', 'c']);
});
test('nearest navigation sample handles ties and endpoints', () => {
  assert.equal(nearestFrame([1000, 3000, 5000], 3500), 1);
  assert.equal(nearestFrame([1000, 3000, 5000], 9999), 2);
});
