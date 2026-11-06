import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

test('oracle reuse keys complete ASS bytes and times within one test and returns independent metrics', () => {
  const source = fs.readFileSync(new URL('./e2e/ass-stacking-boundaries.spec.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('const oracleSeries = new WeakMap();');
  const end = source.indexOf('\nasync function evidence', start);
  assert.ok(start >= 0 && end > start);
  let starts = 0;
  const context = {
    process: { env: {} }, tempDir: '/fixture',
    join: (...parts) => parts.join('/'), resolve: value => value,
    writeFileSync() {}, copyFileSync() {}, structuredClone,
    execFileSync(command, args) {
      starts++;
      const times = args.slice(args.indexOf('--times') + 1).map(Number);
      return JSON.stringify(times.map(time => ({ time, track: { painted: 7 } })));
    },
  };
  vm.createContext(context);
  vm.runInContext(`${source.slice(start, end)}\nthis.sample = libass;`, context);
  const first = { testId: 'first', outputPath: name => `/first/${name}` };
  const second = { testId: 'second', outputPath: name => `/second/${name}` };
  const ass = '[Script Info]\nPlayResX: 640\nDialogue: original\n';
  const result = context.sample(ass, 490, first, 'initial', [490, 500, 501]);
  result.track.painted = 0;
  assert.equal(context.sample(ass, 490, first, 'again', [490, 500, 501]).track.painted, 7);
  assert.equal(context.sample(ass, 501, first, 'boundary', [490, 500, 501]).time, 501);
  assert.equal(starts, 1, 'one unchanged source and clock sequence is prepared once');
  context.sample(`${ass} `, 490, first, 'changed-bytes', [490, 500, 501]);
  assert.equal(starts, 2, 'even one changed source byte requires a fresh preparation');
  context.sample(ass, 490, first, 'changed-clock', [490, 500, 502]);
  assert.equal(starts, 3, 'a different complete clock array cannot reuse prior frames');
  context.sample(ass, 490, second, 'different-test', [490, 500, 501]);
  assert.equal(starts, 4, 'another test cannot share mutable preparation state');
});
