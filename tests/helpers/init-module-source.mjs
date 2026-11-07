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
  // 底部“兄弟 import 边”转发导出段是 ESM 侧通道：vm classic 体里
  // 调用方要么走门面要么直接同域解析，转发函数本身不被调用，剥掉
  // （保留 `function` 声明也无害，但剥净可避免与 context mock 混淆）。
  const stripped = source
    .replace(/^export function \w+\(\.\.\.args\) \{ return window\.[^\n]*\n/gm, '');
  // import 的兄弟符号在生产环境是静态 import；vm 里恢复为同语义
  // 垫片（调用时经 window 门面解析），保持测试的 context mock 语义。
  const importLines = [...source.matchAll(/^import \{([^}]*)\} from '\.\/([\w-]+)\.js';/gm)];
  const shims = [];
  for (const [, names, target] of importLines) {
    const targetSrc = fs.readFileSync(path.join(webDir, 'editor/cues', `${target}.js`), 'utf8');
    for (const raw of names.split(',')) {
      const name = raw.trim();
      if (!name) continue;
      // 转发导出行格式固定（脚本生成），用行前缀 + 回读门面名的字符串比对。
      const prefix = `export function ${name}(...args) { return window.`;
      const line = targetSrc.split('\n').find(l => l.startsWith(prefix));
      // prefix 里的正则元字符（括号、点）先转义再拼接。
      const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const facadeMatch = line ? line.match(new RegExp('^' + esc + '(Mawe\\w+)\\.')) : null;
      if (facadeMatch) shims.push(`var ${name} = (...args) => (globalThis.${facadeMatch[1]} ?? window.${facadeMatch[1]}).${name}(...args);`);
      else if (target !== 'overlay-track') {
        shims.push(`var ${name} = () => { throw new Error('No facade shim for ${name} (from ${target}.js)'); };`);
      }
      // 纯模块（overlay-track）不生成垫片：测试桩环境按 classic 时代语义
      // 直接提供同名全局（context 直查），生产环境走静态 import。
    }
  }
  const withoutImports = stripped.replace(/^import[^\n]*\n/gm, '');
  const head = withoutImports.match(/^export function \w+\(\)\s*\{\n('use strict';\n\n?)?/m);
  if (!head) throw new Error(`Not an init module: ${relativeWebPath}`);
  const body = withoutImports.slice(head.index + head[0].length);
  return shims.join('\n') + (shims.length ? '\n' : '') + body.replace(/\}\s*$/, '');
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
