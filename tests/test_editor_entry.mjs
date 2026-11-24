import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { assertFresh, buildEditor, BUNDLE, ENTRY } from '../scripts/build-editor.mjs';

import { editorInitializerImports, editorInitializers } from './helpers/editor-entry.mjs';

test('the production Editor entry covers every Editor runtime source', async () => {
  const { metadata } = await buildEditor();
  assert.equal(metadata.entry, ENTRY);
  const missing = metadata.discovery.files.filter(file =>
    file.startsWith('editor/')
    && /\.(?:[cm]?js|jsx|tsx?)$/.test(file)
    && !file.endsWith('.d.ts')
    && !Object.hasOwn(metadata.inputs, file));
  assert.deepEqual(missing, [], 'Editor sources missing from the production import graph');
});

test('every imported production Editor initializer is called once', () => {
  for (const initializer of editorInitializerImports) {
    assert.equal(editorInitializers.filter(item => item === initializer).length, 1,
      `${initializer.file} must initialize exactly once`);
  }
});

test('the production Editor bundle is fresh and runs as a classic script', async () => {
  const { code } = await buildEditor();
  const artifact = readFileSync(new URL('../web/' + BUNDLE, import.meta.url), 'utf8');
  assertFresh(artifact, code);
  new vm.Script(artifact);
});
