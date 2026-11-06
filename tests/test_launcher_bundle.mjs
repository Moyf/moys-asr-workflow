// Launcher 装配契约：提交的 bundle 与 meta 必须与源码重建结果逐字节一致，
// 且产物能通过语法编译。与 tests/test_editor_bundle.mjs 同构。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
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

test('transition registers in the trace and rejects unknown kinds', async () => {
  const { code } = await assembly({
    'seam.js': 'export function createSeam() { return 1; }',
  }, [{ file: 'seam.js', kind: 'transition', name: 'seam', exportName: 'createSeam', binding: 'seamFactory' }],
    { transitionBindings: new Set(), trace: true });
  const context = boot(code);
  assert.deepEqual([...context.window.__mawEsmInitializationTrace], ['seam.js']);
  // kind 拼写错误不能静默走 factory 注册路径。
  await assert.rejects(assembly({
    'seam.js': 'export function createSeam() { return 1; }',
  }, [{ file: 'seam.js', kind: 'Factory', name: 'seam', exportName: 'createSeam' }],
    { transitionBindings: new Set() }), /Unknown module kind/i);
});

test('transition invalidates when its transitive dependency changes', async () => {
  // transition 模块 import 的清单外传递依赖与清单源码一样进入
  // inputs 账本：变更后重建产物与哈希都变化。
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'maw-transition-dep-'));
  try {
    fs.mkdirSync(path.join(project, 'web'), { recursive: true });
    fs.writeFileSync(path.join(project, 'web/seam.js'),
      'import { value } from "./helper.js";\nexport function createSeam() { return value; }');
    fs.writeFileSync(path.join(project, 'web/helper.js'), 'export const value = "v1";\n');
    const { compileSources } = await import(editorBuilder);
    const read = file => fs.readFileSync(path.join(project, 'web', file), 'utf8');
    const modules = [{ file: 'seam.js', kind: 'transition', name: 'seam', exportName: 'createSeam', binding: 'seamFactory' }];
    const first = await compileSources(project, ['seam.js'], modules, read, { transitionBindings: new Set() });
    assert.ok(first.metafile.inputs['web/helper.js']);
    fs.writeFileSync(path.join(project, 'web/helper.js'), 'export const value = "v2";\n');
    const second = await compileSources(project, ['seam.js'], modules, read, { transitionBindings: new Set() });
    assert.notEqual(first.code, second.code);
    assert.notEqual(first.metafile.inputs['web/helper.js'], second.metafile.inputs['web/helper.js']);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
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
  // 与 externalBridges 桥名冲突：不可变桥的 window getter 会静默
  // 捕获同名词法绑定，必须在构建期拒绝。
  await assert.rejects(assembly({
    'seam.js': 'export function createSeam() {}',
  }, [{ file: 'seam.js', kind: 'transition', name: 'seam', exportName: 'createSeam', binding: 'loadAss' }],
    { transitionBindings: new Set(), bridges: [{ file: 'seam.js', name: 'loadAss', mutable: false }] }),
    /external bridge/i);
});

test('transitionBindings set is reusable across builds in one process', async () => {
  const files = { 'seam.js': 'export function createSeam() { return 1; }' };
  const modules = [{ file: 'seam.js', kind: 'transition', name: 'seam', exportName: 'createSeam', binding: 'seamFactory' }];
  const shared = new Set();
  await assembly(files, modules, { transitionBindings: shared });
  // 同进程第二次 build 复用同一 Set：入口 clear 后登记不残留、不误报重复。
  await assembly(files, modules, { transitionBindings: shared });
  const { code } = await assembly(files, modules, { transitionBindings: shared, trace: true });
  const context = boot(code);
  assert.deepEqual([...context.window.__mawEsmInitializationTrace], ['seam.js']);
});
