// 终态切换后构建器收敛：本文件保留为契约测试的兼容垫片，
// 全部装配逻辑在 scripts/build-editor.mjs（compileEsmSources 两阶段入口）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildEditor, deriveSources } from '../../scripts/build-editor.mjs';
export { buildEditor, deriveSources };
export const BUNDLE = 'editor/boot/editor-bundle.js';
export function sourceFiles(root) {
  return deriveSources(root);
}
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  const [mode, rootArg] = process.argv.slice(2);
  if (!['--write', '--check'].includes(mode) || !rootArg) throw new Error('Usage: full-build.mjs --write|--check ROOT');
  const root = path.resolve(rootArg), output = path.join(root, 'web', BUNDLE);
  const result = await buildEditor(root);
  const meta = path.join(root, 'web', 'editor/boot/editor-bundle.meta.json');
  if (mode === '--check') {
    if (!fs.existsSync(output) || fs.readFileSync(output, 'utf8') !== result.code) throw new Error('Full bundle is stale');
    console.log('Full bundle is fresh');
  } else {
    fs.writeFileSync(output, result.code);
    fs.writeFileSync(meta, JSON.stringify(result.metadata ?? {}, null, 2) + '\n');
    console.log('Full bundle written:', output);
  }
}
