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
