import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeDocument } from '../website/scripts/sync-maw-docs.mjs';

test('preserves an ordinary Star History disclosure verbatim', () => {
  const markdown = '# MAW\n<details>\n<summary>Star History</summary>\n\n![Chart](https://example.test/chart)\n</details>';
  assert.equal(sanitizeDocument(markdown, 'README.md'), markdown);
});

test('redacts the credential block while preserving other disclosures', () => {
  const chart = '<details><summary>Star History</summary>Chart</details>';
  const credential = '<details open><summary>共享演示 API Key</summary>private value</details>';
  const result = sanitizeDocument(chart + '\n' + credential + '\n' + chart, 'README.md');
  assert.equal(result.split(chart).length - 1, 2);
  assert(!result.includes('private value'));
  assert(result.includes('请使用你自己的 ASR API Key'));
});

test('recognizes English credential summaries', () => {
  const result = sanitizeDocument('<details><summary>Shared demo credentials</summary>private value</details>', 'README.md');
  assert(!result.includes('private value'));
});

test('redacts a key value even when the summary is generic', () => {
  const fixture = '<details><summary>More</summary>sk-example-placeholder-key</details>';
  assert(!sanitizeDocument(fixture, 'README.md').includes('sk-example-placeholder-key'));
});

test('keeps ordinary API setup help and leaves other sources unchanged', () => {
  const help = '<details><summary>How to configure an API key</summary>Use your own provider.</details>';
  assert.equal(sanitizeDocument(help, 'README.md'), help);
  const other = '<details><summary>Shared credentials</summary>example</details>';
  assert.equal(sanitizeDocument(other, 'docs/example.md'), other);
});
