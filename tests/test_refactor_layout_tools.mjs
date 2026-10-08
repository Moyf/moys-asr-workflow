import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { editorScriptFiles, requireLegacyEditor } from '../scripts/refactor-tools/editor-sources.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const web = path.join(root, 'web');

test('developer source enumeration follows nested manifest order', () => {
  const files = editorScriptFiles(web);
  assert.equal(files[0], 'editor/boot/editor-boot.js');
  assert.equal(files.at(-1), 'editor/boot/editor-onboarding.js');
  for (const file of files) assert.ok(existsSync(path.join(web, file)), file);
});

test('historical mutation CLIs refuse the sliced layout before writing', () => {
  assert.throws(() => requireLegacyEditor(web), /requires the unsliced/);
  const before = editorScriptFiles(web).map((file) => readFileSync(path.join(web, file), 'utf8'));
  for (const [script, ...args] of [
    ['tools/merge-flow.mjs', 'resolve', '--dry-run'],
    ['scripts/refactor-tools/ns-rewrite-editor.mjs', '--diff'],
    ['scripts/refactor-tools/fix-e2e-globals.mjs'],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0, script);
    assert.match(result.stderr, /requires the unsliced web\/editor\.js layout/, script);
  }
  const after = editorScriptFiles(web).map((file) => readFileSync(path.join(web, file), 'utf8'));
  assert.deepEqual(after, before);
});
