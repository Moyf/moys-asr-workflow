// 把 init 模块源码还原为可在 vm 沙箱里执行的 classic 文本：
// 剥掉顶层 import 声明与 `export function initXxx() {`…`}` 外壳。函数体本身
// 仍是共享作用域风格的 classic 代码，测试的 context mock 语义保持不变
// （import 进来的领域函数名与 classic 时代一样从 context 解析）。
// 仅用于 node 单测的源码直跑；生产行为以 esbuild bundle 为准。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

export function initModuleSource(relativeWebPath) {
  const source = fs.readFileSync(path.join(webDir, relativeWebPath), 'utf8');
  const stripped = source.replace(/^import[^\n]*\n/gm, '');
  const head = stripped.match(/^export function \w+\(\)\s*\{\n('use strict';\n\n?)?/m);
  if (!head) throw new Error(`Not an init module: ${relativeWebPath}`);
  const body = stripped.slice(head.index + head[0].length);
  return body.replace(/\}\s*$/, '');
}

// 把无副作用的 ESM 纯模块（如 cues/overlay-track.js）还原为 classic 文本：
// 去掉 import 与 re-export 块、剥掉 `export ` 前缀。模块在 vm 沙箱求值后，
// 其函数闭包里的自由变量（Mawe* 门面）与 classic 时代一样从 context 解析。
export function plainModuleSource(relativeWebPath) {
  const source = fs.readFileSync(path.join(webDir, relativeWebPath), 'utf8');
  const withoutImports = source.replace(/^import[^\n]*\n/gm, '');
  const withoutExportBlock = withoutImports.replace(/^export \{[\s\S]*?\n\};?\s*$/gm, '');
  return withoutExportBlock
    .replace(/^export (?=(?:function|const|let|var)\b)/gm, '');
}

// Run an ESM init module inside a fixture's VM context while retaining its
// function bodies and named helpers. The fixture supplies any imported globals.
export function invokedInitModuleSource(relativeWebPath, initializer) {
  return `${plainModuleSource(relativeWebPath)}\n${initializer}();`;
}
