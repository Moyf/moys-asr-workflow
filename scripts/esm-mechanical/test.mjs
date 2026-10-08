import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import test from 'node:test';
import { applyBatch, buildBundle, convertFactory, inventory, loadEsbuild } from './research.mjs';

const converted = process.env.MAW_ESM_TEST_ROOT;
if (!converted) throw new Error('Set MAW_ESM_TEST_ROOT to the isolated converted copy');
const modules = JSON.parse(fs.readFileSync(path.join(converted, 'scripts/esm-mechanical/batch.json'), 'utf8'));

test('ESM factories retain caller injection and per-call construction', async () => {
  const { createUtilsModule } = await import(pathToFileURL(path.join(converted, 'web/shared/utils/speakers.js')).href);
  const first = createUtilsModule({ effectiveColorName: () => 'yellow' });
  const second = createUtilsModule({ effectiveColorName: () => 'blue' });
  assert.equal(first.speakerLabelForSegment({}, [], {}), 'SP1');
  assert.equal(second.speakerLabelForSegment({}, [], {}), 'SP5');
  assert.notEqual(first, second);
});

test('explicit Node module scope works with syntax detection disabled', () => {
  const url = pathToFileURL(path.join(converted, 'web/shared/utils/data.js')).href;
  const result = execFileSync(process.execPath, ['--no-experimental-detect-module', '--input-type=module', '-e',
    `const module = await import(${JSON.stringify(url)}); console.log(module.createUtilsModule({}).PROJECT_SCHEMA);`],
  { encoding: 'utf8', windowsHide: true });
  assert.equal(result.trim(), 'moy.asr.project.v1');
});

test('unknown wrappers and noncontiguous migrations fail before mutation', async () => {
  assert.throws(() => convertFactory('(function(){ window.MAWE.register("x", () => ({})); })();'), /requires review/);
  assert.throws(() => convertFactory('window.MAWE.register("x", function f(){}); window.extra = 1;'), /requires review/);
  const manifestPath = path.join(converted, 'web/editor-scripts.txt');
  const before = fs.readFileSync(manifestPath, 'utf8');
  await assert.rejects(applyBatch(converted, ['shared/utils/text-processing.js', 'shared/utils/settings.js']), /contiguous/);
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), before);
});

test('freshness detects a semantic source change without rewriting the artifact', async () => {
  const artifact = path.join(converted, 'web/editor/boot/esm-mechanical-bundle.js');
  const before = fs.readFileSync(artifact, 'utf8');
  assert.equal((await buildBundle(converted, modules)).code, before);
  const sourcePath = path.join(converted, 'web/shared/utils/data.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  try {
    fs.writeFileSync(sourcePath, source.replace('moy.asr.project.v1', 'deliberately.stale'));
    assert.notEqual((await buildBundle(converted, modules)).code, before);
    assert.equal(fs.readFileSync(artifact, 'utf8'), before);
  } finally { fs.writeFileSync(sourcePath, source); }
});

test('importing the builder has no write side effects', async () => {
  const artifact = path.join(converted, 'web/editor/boot/esm-mechanical-bundle.js');
  const before = fs.readFileSync(artifact);
  await import('./research.mjs?independent-import');
  assert.deepEqual(fs.readFileSync(artifact), before);
});

test('inventory detects dynamic names and imported-binding write hazards', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maw-esm-inventory-'));
  fs.mkdirSync(path.join(root, 'web'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests/e2e'), { recursive: true });
  fs.writeFileSync(path.join(root, 'web/editor-scripts.txt'), 'owner.js\nconsumer.js\n');
  fs.writeFileSync(path.join(root, 'web/owner.js'), 'let counter = 0;');
  fs.writeFileSync(path.join(root, 'web/consumer.js'), 'counter++; window.MAWE.resolve(getName(), {});');
  const result = inventory(root);
  assert.equal(result.summary.dynamicResolveNames, 1);
  assert.equal(result.crossLexicalWrites.length, 1);
  assert.equal(result.crossLexicalWrites[0].name, 'counter');
});

test('bundling boot preserves template tokens and mutable facade accessors', async () => {
  const source = fs.readFileSync(path.join(converted, 'web/editor/boot/editor-boot.js'), 'utf8');
  const esbuild = await loadEsbuild(converted);
  const result = esbuild.buildSync({ stdin: { contents: source + '\nexport {};', loader: 'js' },
    bundle: true, format: 'iife', write: false, minifyWhitespace: true });
  let code = result.outputFiles[0].text;
  const context = { URLSearchParams, window: { location: { search: '' } } };
  const project = { segments: [{ start: 0, end: 500, text: 'synthetic' }] };
  const tokens = { __DATA_JSON__: project, __FILENAME_BASE_JSON__: 'untitled', __STICKERS_JSON__: [],
    __STICKER_ROOT_JSON__: '', __STICKER_URL_PREFIX_JSON__: '', __SERVER_CONFIG_JSON__: null,
    __NINJA_SFX_BASE_URL_JSON__: '' };
  for (const [token, value] of Object.entries(tokens)) {
    assert.ok(code.includes(token), `${token} was lost by bundling`);
    code = code.replaceAll(token, JSON.stringify(value));
  }
  vm.runInNewContext(code, context);
  assert.equal(context.window.MaweBoot.DATA.segments[0].end, 500);
  context.window.MaweBoot.PROJECT_NAME = 'updated';
  assert.equal(context.window.MaweBoot.PROJECT_NAME, 'updated');
});

test('ordered entry imports do not by themselves preserve side-effect order', async () => {
  const esbuild = await loadEsbuild(converted);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maw-esm-order-'));
  fs.writeFileSync(path.join(root, 'a.js'), "window.trace.push('A'); export const value = 1;\n");
  fs.writeFileSync(path.join(root, 'b.js'), "import {value} from './a.js'; window.trace.push('B'+value);\n");
  const result = esbuild.buildSync({ stdin: { contents: "import './b.js'; import './a.js';",
    resolveDir: root, loader: 'js' }, bundle: true, format: 'iife', write: false });
  const context = { window: { trace: [] } };
  vm.runInNewContext(result.outputFiles[0].text, context);
  assert.deepEqual(context.window.trace, ['A', 'B1']);
});
