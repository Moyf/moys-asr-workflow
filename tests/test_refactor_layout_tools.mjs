import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { requireLegacyEditor } from '../scripts/refactor-tools/editor-sources.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const web = path.join(root, 'web');

test('historical mutation CLIs refuse the sliced layout before writing', () => {
  assert.throws(() => requireLegacyEditor(web), /requires the unsliced/);
  const entry = path.join(web, 'editor/boot/editor-entry.mjs');
  const before = readFileSync(entry, 'utf8');
  for (const [script, ...args] of [
    ['tools/merge-flow.mjs', 'resolve', '--dry-run'],
    ['scripts/refactor-tools/ns-rewrite-editor.mjs', '--diff'],
    ['scripts/refactor-tools/fix-e2e-globals.mjs'],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0, script);
    assert.match(result.stderr, /requires the unsliced web\/editor\.js layout/, script);
  }
  const after = readFileSync(entry, 'utf8');
  assert.deepEqual(after, before);
});
