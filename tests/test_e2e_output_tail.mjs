import assert from 'node:assert/strict';
import test from 'node:test';
import { createOutputTail } from './e2e/output-tail.mjs';

test('noisy server retains the final diagnostic with bounded output', () => {
  const output = createOutputTail();
  output.append(Buffer.from('x'.repeat(2_000_000)));
  for (let i = 0; i < 1000; i++) output.append(Buffer.from('request completed\n'));
  output.append(Buffer.from('ERROR: port unavailable'));
  assert.ok(output.text().length < 4200);
  assert.ok(output.text().endsWith('ERROR: port unavailable'));
  assert.ok(output.text().startsWith('[earlier server output omitted]'));
});

test('UTF-8 split across chunks remains readable', () => {
  const output = createOutputTail();
  const bytes = Buffer.from('启动失败：端口占用 😀');
  for (const byte of bytes) output.append(Buffer.from([byte]));
  assert.equal(output.text(), '启动失败：端口占用 😀');
});

test('small output is preserved without an omission marker', () => {
  const output = createOutputTail();
  output.append('first\n');
  output.append('second');
  assert.equal(output.text(), 'first\nsecond');
});

test('interleaved stderr does not corrupt a partial stdout character', () => {
  const output = createOutputTail();
  const bytes = Buffer.from('中');
  output.append(bytes.subarray(0, 1));
  output.append(Buffer.from('error: '), 'stderr');
  output.append(bytes.subarray(1));
  assert.equal(output.text(), 'error: 中');
});
