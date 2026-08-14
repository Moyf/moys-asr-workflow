import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';


const source = fs.readFileSync(new URL('../web/editor-runtime.js', import.meta.url), 'utf8');


test('MAWE runtime exposes a factory-only module registry', () => {
  const context = { window: {} };
  vm.runInNewContext(source, context);

  const runtime = context.window.MAWE;
  assert.equal(runtime.version, 1);
  assert.deepEqual(Array.from(runtime.list()), []);
  assert.equal(runtime.has('demo'), false);
  runtime.register('demo', (value) => ({ value }));
  assert.equal(runtime.has('demo'), true);
  assert.equal(runtime.resolve('demo', 42).value, 42);
  assert.deepEqual(Array.from(runtime.list()), ['demo']);
  assert.throws(() => runtime.register('demo', () => null), /already registered/);
  assert.throws(() => runtime.register('Demo', () => null), /Invalid MAWE module name/);
  assert.throws(() => runtime.register('bad', {}), /must register a factory/);
});


test('MAWE runtime does not replace an existing compatible registry', () => {
  const existing = Object.freeze({ version: 1, register() {} });
  const context = { window: { MAWE: existing } };
  vm.runInNewContext(source, context);
  assert.equal(context.window.MAWE, existing);
});
