// Target architecture tests. These intentionally fail against the old assembly.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import vm from 'node:vm';
import test from 'node:test';
import { inventory } from './research.mjs';

const root = process.env.MAW_ESM_FULL_ROOT;
const baseline = process.env.MAW_ESM_BASELINE_ROOT;
const python = process.env.MAW_ESM_PYTHON;
if (!root || !baseline || !python) throw new Error('Set MAW_ESM_FULL_ROOT, MAW_ESM_BASELINE_ROOT and MAW_ESM_PYTHON');
const here = path.dirname(fileURLToPath(import.meta.url));
const builderPath = path.join(here, 'full-build.mjs');
const bundlePath = path.join(root, 'web/editor/boot/editor-bundle.js');
const baselineInventory = inventory(baseline);
const sharedNames = new Set(baselineInventory.files.flatMap(f => f.declarations));
async function api() {
  assert.ok(fs.existsSync(builderPath), 'E1: complete esbuild builder is absent');
  return import(pathToFileURL(builderPath).href);
}
const pythonRun = code => execFileSync(python, ['-c', code], { cwd: root, encoding: 'utf8', windowsHide: true,
  env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });

test('E1: every required source is an esbuild input and output is classic', async () => {
  const { buildEditor } = await api();
  const result = await buildEditor(root);
  const inputs = new Set(Object.keys(result.metafile.inputs).map(p => p.replaceAll('\\', '/')));
  for (const file of baselineInventory.files) assert.ok(inputs.has(`web/${file.file}`), `Missing input: ${file.file}`);
  new vm.Script(result.code);
  assert.equal(result.sourceFiles.length, baselineInventory.files.length);
});

test('E2: full artifact does not leak old shared lexical bindings', async () => {
  const { buildEditor } = await api();
  const { unresolvedRefs } = await import('../refactor-tools/scope-core.mjs');
  const result = await buildEditor(root);
  const leaks = [...new Set(unresolvedRefs(result.code).filter(r => sharedNames.has(r.name)).map(r => r.name))];
  assert.deepEqual(leaks, [], 'Classic shared bindings need explicit module connections');
});

test('E3: formal Python assembly reads one artifact without source-manifest assembly', async () => {
  const output = JSON.parse(pythonRun(`import edit, json, hashlib
reads = []
original = edit.read_web_asset
def read(name):
    if name.endswith('.js'): reads.append(name)
    return original(name)
edit.read_web_asset = read
def forbidden(): raise AssertionError('Python is still assembling source manifest')
edit.read_editor_script_manifest = forbidden
payload = edit.build_editor_scripts()
page = edit.build_blank_html()
print(json.dumps({'reads': reads, 'hash': hashlib.sha256(payload.encode()).hexdigest(), 'embedded': payload.splitlines()[0] in page}))
`));
  assert.ok(fs.existsSync(bundlePath), 'E3: full artifact is absent');
  const { createHash } = await import('node:crypto');
  assert.equal(output.hash, createHash('sha256').update(fs.readFileSync(bundlePath, 'utf8').trimEnd()).digest('hex'));
  assert.ok(output.embedded);
  assert.deepEqual(output.reads, ['editor/boot/editor-bundle.js', 'editor/boot/editor-bundle.js']);
});

test('E4: freshness is deterministic and semantic source changes fail the read-only check', async () => {
  const { buildEditor } = await api();
  assert.ok(fs.existsSync(bundlePath), 'E4: full artifact is absent');
  const artifact = fs.readFileSync(bundlePath, 'utf8');
  assert.equal((await buildEditor(root)).code, artifact);
  const fromDifferentCwd = spawnSync(process.execPath, [builderPath, '--check', root],
    { cwd: baseline, encoding: 'utf8', windowsHide: true });
  assert.equal(fromDifferentCwd.status, 0, fromDifferentCwd.stderr);
  const sourcePath = path.join(root, 'web/shared/utils/data.js');
  const before = fs.readFileSync(sourcePath, 'utf8');
  try {
    assert.ok(before.includes('moy.asr.project.v1'));
    fs.writeFileSync(sourcePath, before.replace('moy.asr.project.v1', 'deliberately.stale'));
    const result = spawnSync(process.execPath, [builderPath, '--check', root], { encoding: 'utf8', windowsHide: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /stale/i);
    assert.equal(fs.readFileSync(bundlePath, 'utf8'), artifact);
  } finally { fs.writeFileSync(sourcePath, before); }
});

test('E5: invalid ESM exports and absent inputs are build failures', async () => {
  const { buildEditor } = await api();
  const sourcePath = path.join(root, 'web/editor/boot/editor-host.js');
  const before = fs.readFileSync(sourcePath, 'utf8');
  try {
    fs.writeFileSync(sourcePath, "import { definitelyMissingExport } from '../state/editor-state.js';\n"
      + before + '\nwindow.__missingExportCanary = definitelyMissingExport;\n');
    await assert.rejects(buildEditor(root), /No matching export/);
  } finally { fs.writeFileSync(sourcePath, before); }
  const manifestPath = path.join(root, 'web/editor-sources.txt');
  const manifest = fs.readFileSync(manifestPath, 'utf8');
  try {
    fs.writeFileSync(manifestPath, manifest + '\nmissing-input.js\n');
    await assert.rejects(buildEditor(root), /missing-input|Could not resolve|ENOENT/);
  } finally { fs.writeFileSync(manifestPath, manifest); }
});

test('E6: real file and localhost pages satisfy behavioral probes', async () => {
  await api();
  const verifier = path.join(here, 'full-verify.mjs');
  assert.ok(fs.existsSync(verifier), 'E6: real assembly probe is absent');
  const result = spawnSync(process.execPath, [verifier, baseline, root, python],
    { encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const verdict = JSON.parse(fs.readFileSync(path.join(root, 'full-browser-verdict.json'), 'utf8'));
  assert.equal(verdict.ok, true);
  assert.ok(verdict.checks.projectInjection && verdict.checks.sharedStateWrite && verdict.checks.exportSrt);
});

test('E8: live cross-file writes retain postfix, const and shadowing semantics', async () => {
  const { buildEditor } = await api();
  const codemodPath = path.join(here, 'full-convert.mjs');
  assert.ok(fs.existsSync(codemodPath), 'E8: full source codemod is absent');
  const { convertAll } = await import(pathToFileURL(codemodPath).href);
  const fixture = path.join(root, 'live-binding-probe');
  fs.mkdirSync(path.join(fixture, 'web'), { recursive: true });
  fs.writeFileSync(path.join(fixture, '.esm-mechanical-sandbox.json'), '{"purpose":"esm-mechanical-research"}\n');
  fs.writeFileSync(path.join(fixture, 'web/editor-scripts.txt'), 'owner.js\nconsumer.js\n');
  fs.writeFileSync(path.join(fixture, 'web/owner.js'),
    'let counter=1; const fixed=7; function current(){return counter;} window.readCounter=current;\n');
  fs.writeFileSync(path.join(fixture, 'web/consumer.js'),
    'window.postfix=counter++; window.snapshot={counter}; counter+=3; '
    + 'window.shadow=(function(counter){return ++counter;})(40); '
    + 'try { fixed++; } catch(error){ window.constError=error.name; }\n');
  await convertAll(fixture);
  const { code } = await buildEditor(fixture);
  const context = { window: {} };
  vm.runInNewContext(code, context);
  assert.equal(context.window.postfix, 1);
  assert.equal(context.window.snapshot.counter, 2);
  assert.equal(context.window.readCounter(), 5);
  assert.equal(context.window.shadow, 41);
  assert.equal(context.window.constError, 'TypeError');
});

test('E9: forward function/var hoisting and lexical TDZ retain classic semantics', async () => {
  const { buildEditor } = await api();
  const { convertAll } = await import(pathToFileURL(path.join(here, 'full-convert.mjs')).href);
  const fixture = path.join(root, 'hoisting-probe');
  fs.mkdirSync(path.join(fixture, 'web'), { recursive: true });
  fs.writeFileSync(path.join(fixture, '.esm-mechanical-sandbox.json'), '{"purpose":"esm-mechanical-research"}\n');
  fs.writeFileSync(path.join(fixture, 'web/editor-scripts.txt'), 'consumer.js\nowner.js\n');
  fs.writeFileSync(path.join(fixture, 'web/consumer.js'),
    'window.forwardFunction=futureFunction(); window.forwardVar=futureVar; '
    + 'try { window.forwardLet=futureLet; } catch(error){window.tdz=error.name;}\n');
  fs.writeFileSync(path.join(fixture, 'web/owner.js'),
    'var futureVar=9; let futureLet=4; function futureFunction(){return 42;}\n');
  await convertAll(fixture);
  const { code } = await buildEditor(fixture);
  const context = { window: {} };
  vm.runInNewContext(code, context);
  assert.equal(context.window.forwardFunction, 42);
  assert.equal(context.window.forwardVar, undefined);
  assert.equal(context.window.tdz, 'ReferenceError');
});

test('E10: an imported builder never repairs a corrupted artifact before freshness checks', async () => {
  await api();
  const before = fs.readFileSync(bundlePath, 'utf8');
  const corrupted = before + '\n// deliberately corrupted artifact\n';
  try {
    fs.writeFileSync(bundlePath, corrupted);
    execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(builderPath).href)});`],
      { encoding: 'utf8', windowsHide: true });
    assert.equal(fs.readFileSync(bundlePath, 'utf8'), corrupted);
    const result = spawnSync(process.execPath, [builderPath, '--check', root], { encoding: 'utf8', windowsHide: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /stale/i);
    assert.equal(fs.readFileSync(bundlePath, 'utf8'), corrupted);
  } finally { fs.writeFileSync(bundlePath, before); }
});
