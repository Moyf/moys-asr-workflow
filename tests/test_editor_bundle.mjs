import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const builder = new URL('../scripts/build-editor.mjs', import.meta.url);
const artifact = path.join(root, 'web/editor/boot/editor-bundle.js');

test('source-only changes invalidate the artifact', async () => {
  const { buildEditor, assertFresh } = await import(builder);
  const original = fs.readFileSync(artifact,'utf8');
  assert.throws(() => assertFresh(original+'// stale\n', original), /stale/i);
  const changed = await buildEditor(root, { transform(file, source) {
    return file === 'shared/utils/data.js' ? source.replace('moy.asr.project.v1','deliberately.stale') : source;
  }});
  // The mutated schema string must reach the compiled
  // output — not only the metadata hash ledger
  // (review of #288).
  assert.ok(changed.code.includes('deliberately.stale'), 'mutated schema string must be compiled in');
  assert.ok(!original.includes('deliberately.stale'));
  assert.notEqual(changed.code,original);
  new vm.Script(changed.code);
  assert.equal(fs.readFileSync(artifact,'utf8'),original);
});

test('transitive imports invalidate the artifact through the production entry', async () => {
  const { buildEditor, ENTRY } = await import(builder);
  const project = fs.mkdtempSync(path.join(os.tmpdir(),'maw-import-freshness-'));
  try {
    fs.mkdirSync(path.dirname(path.join(project, 'web', ENTRY)), {recursive:true});
    fs.mkdirSync(path.join(project,'scripts'),{recursive:true});
    fs.writeFileSync(path.join(project,'web',ENTRY),"import { value } from '../../helper.js';\nwindow.result = value;\n");
    fs.writeFileSync(path.join(project,'web/helper.js'),"export const value = 'v1';\n");
    fs.writeFileSync(path.join(project,'scripts/build-editor.mjs'),fs.readFileSync(fileURLToPath(builder),'utf8'));
    fs.copyFileSync(new URL('../scripts/build-shared.mjs', import.meta.url), path.join(project, 'scripts/build-shared.mjs'));
    fs.writeFileSync(path.join(project,'package.json'),'{}\n');
    fs.writeFileSync(path.join(project,'pnpm-lock.yaml'),'lockfileVersion: 9\n');

    const first = await buildEditor(project);
    assert.ok(first.metadata.inputs['helper.js']);
    assert.ok(first.metafile.inputs['web/helper.js']);
    fs.writeFileSync(path.join(project,'web/helper.js'),"export const value = 'v2';\n");
    const second = await buildEditor(project);
    assert.notEqual(first.code,second.code);
    assert.notEqual(first.metadata.inputs['helper.js'],second.metadata.inputs['helper.js']);
  } finally {
    fs.rmSync(project,{recursive:true,force:true});
  }
});
