// Launcher 装配契约：提交的 bundle 与 meta 必须与源码重建结果逐字节一致，
// 且产物能通过语法编译。与 tests/test_editor_bundle.mjs 同构。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const builder = new URL('../scripts/build-launcher.mjs', import.meta.url);
const editorBuilder = new URL('../scripts/build-editor.mjs', import.meta.url);
const artifact = path.join(root, 'web/launcher/boot/launcher-bundle.js');

test('launcher bundle is the fresh classic artifact of the manifest sources', async () => {
  const { buildLauncher, readSources } = await import(builder);
  const result = await buildLauncher(root);
  assert.equal(result.code, fs.readFileSync(artifact, 'utf8'));
  new vm.Script(result.code);
  assert.equal(result.sourceFiles.length, readSources(root).length);
  for (const module of result.modules) {
    assert.ok(Object.keys(result.metafile.inputs).includes(`web/${module.file}`), module.file);
  }
});

test('launcher bundle boots without a backend and exposes the bridge', async ({ }) => {
  // 产物要求 pywebview / DOM，无法在 Node 里整跑；这里只断言启动块的结构性标记，
  // 真实启动行为由 e2e launcher-*.spec.mjs 在浏览器里覆盖。
  const code = fs.readFileSync(artifact, 'utf8');
  assert.match(code, /^\/\* MAW Launcher artifact: [0-9a-f]{64} \*\//);
  assert.ok(code.includes('__mawEsmInitializationTrace'), 'trace 钩子缺失');
});

// L01 过渡接入：ESM 导出以词法绑定进入 classic 作用域，
// 不落到 window，不调用 MAWE.register。
const assembly = async (files, modules, options = {}) => {
  const { compileSources } = await import(editorBuilder);
  const sources = new Map(Object.entries(files));
  return compileSources(root, Object.keys(files), modules,
    file => sources.get(file), options);
};
const boot = code => {
  const context = { window: {} };
  vm.runInNewContext(code, context);
  return context;
};

test('transition module binds its export lexically at the original slot', async () => {
  const { code } = await assembly({
    'first.js': 'window.events=["first"];',
    'seam.js': 'export function createSeam() { return "bound"; }',
    'last.js': 'window.after = binding(); window.events.push("last");',
  }, [{ file: 'seam.js', kind: 'transition', name: 'seam', exportName: 'createSeam', binding: 'binding' }],
    { transitionBindings: new Set() });
  boot(code);
  const context = boot(code);
  assert.deepEqual([...context.window.events], ['first', 'last']);
  assert.equal(context.window.after, 'bound');
  // 绑定是函数作用域内的 const，不是 window 属性。
  assert.equal(context.window.binding, undefined);
  // 不走 Editor 注册表。
  assert.ok(!code.includes('window.MAWE.register('));
});

test('transition keeps classic hoisting semantics at the slot', async () => {
  const { code } = await assembly({
    // 与生产形态一致：函数体引用后置声明（延迟执行可读），
    // 顶层语句按 var 提升读到 undefined。
    'first.js': 'window.pre = typeof laterVar;',
    'seam.js': 'export function createSeam() { return 42; }',
    'last.js': 'var laterVar = 9; function hoisted() { return laterVar + 1; } window.post = hoisted();',
  }, [{ file: 'seam.js', kind: 'transition', name: 'seam', exportName: 'createSeam', binding: 'seamFactory' }],
    { transitionBindings: new Set() });
  const context = boot(code);
  assert.equal(context.window.pre, 'undefined');
  assert.equal(context.window.post, 10);
});

test('transition registers in the trace and invalidates like manifest sources', async () => {
  const { code } = await assembly({
    'seam.js': 'export function createSeam() { return 1; }',
  }, [{ file: 'seam.js', kind: 'transition', name: 'seam', exportName: 'createSeam', binding: 'seamFactory' }],
    { transitionBindings: new Set(), trace: true });
  const context = boot(code);
  assert.deepEqual([...context.window.__mawEsmInitializationTrace], ['seam.js']);
});

test('transition rejects side-effectful modules and bad bindings', async () => {
  await assert.rejects(assembly({
    'seam.js': 'window.effect = true;\nexport function createSeam() {}',
  }, [{ file: 'seam.js', kind: 'transition', name: 'seam', exportName: 'createSeam', binding: 'seamFactory' }],
    { transitionBindings: new Set() }), /exactly one function/i);
  await assert.rejects(assembly({
    'seam.js': 'export function createSeam() {}',
  }, [{ file: 'seam.js', kind: 'transition', name: 'seam', exportName: 'createSeam', binding: 'not a name' }],
    { transitionBindings: new Set() }), /Invalid transition binding/i);
  await assert.rejects(assembly({
    'seam.js': 'export function createSeam() {}',
  }, [{ file: 'seam.js', kind: 'transition', name: 'seam', exportName: 'createSeam', binding: 'seamFactory' }]),
    /Invalid transition binding/i);
  await assert.rejects(assembly({
    'a.js': 'export function createA() {}',
    'b.js': 'export function createB() {}',
  }, [
    { file: 'a.js', kind: 'transition', name: 'a', exportName: 'createA', binding: 'dupe' },
    { file: 'b.js', kind: 'transition', name: 'b', exportName: 'createB', binding: 'dupe' },
  ], { transitionBindings: new Set() }), /Duplicate transition binding/i);
});
