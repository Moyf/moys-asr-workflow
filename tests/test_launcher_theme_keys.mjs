// Launcher ESM 过渡接入（L01/L02）行为契约测试：
// 用真实构建器装配主题叶子 + 两个 classic 消费者，在 vm 里执行，
// 断言词法绑定语义（不落 window、MAWE.register 不被调用、
// 常量经工厂对象在原位置创建）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const editorBuilder = new URL('../scripts/build-editor.mjs', import.meta.url);
const leafSource = () => fs.readFileSync(
  fileURLToPath(new URL('../web/launcher/theme/launcher-theme-keys.js', import.meta.url)), 'utf8');

const assemble = async (project, files, modules, options = {}) => {
  const { compileSources } = await import(editorBuilder);
  return compileSources(project, files, modules,
    file => fs.readFileSync(path.join(project, 'web', file), 'utf8'), options);
};

const themeProject = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maw-theme-keys-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'web'), { recursive: true });
  fs.writeFileSync(path.join(root, 'web/keys.js'), leafSource());
  return root;
};

test('theme keys leaf carries the exact string and predicate behavior', async () => {
  // 直接 import 实际模块：文案/常量与旧 classic 实现逐值一致。
  const { createThemeKeys } = await import('../web/launcher/theme/launcher-theme-keys.js');
  const keys = createThemeKeys();
  assert.equal(keys.THEME_KEY, 'MAW_GUI_THEME');
  assert.equal(keys.isThemePreference('light'), true);
  assert.equal(keys.isThemePreference('dark'), true);
  assert.equal(keys.isThemePreference('system'), true);
  assert.equal(keys.isThemePreference('Light'), false); // 大小写敏感
  assert.equal(keys.isThemePreference(''), false);      // 空值
  assert.equal(keys.isThemePreference(undefined), false);
});

test('theme keys leaf stays import-free and side-effect-free', async () => {
  // 装配测试把叶子按平铺布局复制进临时目录；叶子一旦引入相对
  // import，fixture 与生产路径会静默分叉。当前契约是零 import、
  // 顶层零副作用（与 validateTransitionModule 的白名单一致）。
  const acorn = await import('acorn');
  const ast = acorn.parse(leafSource(), { ecmaVersion: 'latest', sourceType: 'module' });
  assert.equal(ast.body.filter(node => node.type === 'ImportDeclaration').length, 0, '叶子必须保持零 import');
  const nonExport = ast.body.filter(node => node.type !== 'ExportNamedDeclaration');
  assert.deepEqual(nonExport, [], '顶层只允许一个 export 声明');
});

test('assembled theme leaf serves classic consumers without window or registry', async t => {
  const root = themeProject(t);
  fs.writeFileSync(path.join(root, 'web/consumer.js'),
    `const themeKeys = createThemeKeys();
     window.key = themeKeys.THEME_KEY;
     window.light = themeKeys.isThemePreference("light");
     window.upper = themeKeys.isThemePreference("Light");
     window.missing = themeKeys.isThemePreference("");
     window.bindingOnWindow = typeof window.createThemeKeys;`);
  const { code } = await assemble(root, ['keys.js', 'consumer.js'],
    [{ file: 'keys.js', kind: 'transition', name: 'theme_keys', exportName: 'createThemeKeys', binding: 'createThemeKeys' }],
    { transitionBindings: new Set(), trace: true });
  const context = { window: {} };
  vm.runInNewContext(code, context);
  assert.equal(context.window.key, 'MAW_GUI_THEME');
  assert.equal(context.window.light, true);
  assert.equal(context.window.upper, false);
  assert.equal(context.window.missing, false);
  // 词法绑定不落到 window。
  assert.equal(context.window.bindingOnWindow, 'undefined');
  assert.deepEqual([...context.window.__mawEsmInitializationTrace], ['keys.js', 'consumer.js']);
});
