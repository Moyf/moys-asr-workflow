// 把 init 模块源码还原为可在 vm 沙箱里执行的 classic 文本：
// 剥掉顶层 import 声明与 `export function initXxx() {`…`}` 外壳。函数体本身
// 仍是共享作用域风格的 classic 代码，测试的 context mock 语义保持不变
// （import 进来的领域函数名与 classic 时代一样从 context 解析）。
// 仅用于 node 单测的源码直跑；生产行为以 esbuild bundle 为准。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { editorInitializers } from './editor-entry.mjs';
import { fixtureFacadeForExport, fixtureImports, privateFixtureFacadeForExport } from './editor-fixture-imports.mjs';
import { isPrivateFixtureFacade, publishFixtureBindings } from './editor-fixture-bindings.mjs';

const webDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

function vmFixtureImports(source, relativeWebPath) {
  return fixtureImports(source, () => true, (specifier, name) => {
    if (!specifier.startsWith('.')) return null;
    const provider = path.posix.normalize(path.posix.join(path.posix.dirname(relativeWebPath), specifier));
    return privateFixtureFacadeForExport(fs.readFileSync(path.join(webDir, provider), 'utf8'), name, provider);
  }, { preferNamed: true });
}

export function initModuleSource(relativeWebPath, { isolate = true } = {}) {
  const source = fs.readFileSync(path.join(webDir, relativeWebPath), 'utf8');
  const initializer = editorInitializers.find(item => item.file === relativeWebPath)?.exportName;
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const init = ast.body.find(node => node.type === 'ExportNamedDeclaration'
    && node.declaration?.type === 'FunctionDeclaration' && node.declaration.id.name === initializer)?.declaration;
  if (initializer && !init) throw new Error(`Missing initializer: ${relativeWebPath}`);
  // 底部“兄弟 import 边”转发导出段是 ESM 侧通道：vm classic 体里
  // 调用方要么走门面要么直接同域解析，转发函数本身不被调用，剥掉
  // （保留 `function` 声明也无害，但剥净可避免与 context mock 混淆）。
  // import 的兄弟符号在生产环境是静态 import；vm 里恢复为同语义
  // 垫片（调用时经 window 门面解析），保持测试的 context mock 语义。
  const importLines = [...source.matchAll(/^import \{([^}]*)\} from '\.\/([\w-]+)\.js';/gm)];
  const shims = [];
  for (const [, names, target] of importLines) {
    const targetSrc = fs.readFileSync(
      path.resolve(webDir, path.dirname(relativeWebPath), `${target}.js`), 'utf8');
    for (const raw of names.split(',')) {
      const [name, localName = name] = raw.trim().split(/\s+as\s+/);
      if (!name) continue;
      if (privateFixtureFacadeForExport(targetSrc, name, path.posix.join(path.posix.dirname(relativeWebPath), `${target}.js`))) continue;
      const facade = fixtureFacadeForExport(targetSrc, name);
      if (facade) shims.push(`var ${localName} = (...args) => (globalThis.${facade} ?? window.${facade}).${name}(...args);`);
      else if (target === 'editor-ass-preview-refresh') {
        shims.push(`var ${localName} = (...args) => window.MaweAssPreviewRefresh.${name}(...args);`);
      }
      else if (target !== 'overlay-track' && !/^Mawe[A-Z]/.test(name)) {
        shims.push(`var ${localName} = () => { throw new Error('No facade shim for ${name} (from ${target}.js)'); };`);
      }
      // 纯模块（overlay-track）不生成垫片：测试桩环境按 classic 时代语义
      // 直接提供同名全局（context 直查），生产环境走静态 import。
    }
  }
  if (source.includes('import { getAssStyleLibrary }')) {
    shims.push('var getAssStyleLibrary = () => globalThis.ASS_STYLE_LIBRARY;');
  }
  if (source.includes('import { getMaweDomPanels }')) {
    shims.push('var getMaweDomPanels = () => globalThis.MaweDomPanelsWiring ?? window.MaweDomPanelsWiring;');
  }
  if (!init) return `(() => {\n${shims.join('\n')}\n${plainModuleSource(relativeWebPath)}\n})();`;
  // 将顶层常量和模块级门面绑定带入 VM classic 体。
  const constants = ast.body.filter(node =>
    (node.type === 'VariableDeclaration' && (node.kind === 'const'
      || node.declarations.every(entry => isPrivateFixtureFacade(entry.id.name)
        || /^(activeBurnVideoTask|activeGapRemovedVideoTask)$/.test(entry.id.name))))
    || (node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'VariableDeclaration'
      && (node.declaration.kind === 'const' || node.declaration.declarations.every(
        entry => /^(Mawe\w+|MAWE_I18N|AsrEditorUtils)$/.test(entry.id.name)
          && !entry.init))))
    .map(node => source.slice(node.start, node.end).replace(/^export\s+/m, '')
      // vm 无脚本级词法隔离：const 会与后续脚本的同名 var 冲突，统一降为 var。
      .replace(/^(?:const|let)\s+/m, 'var '));
  const body = publishFixtureBindings(source, vmFixtureImports(source, relativeWebPath)).slice(init.body.start + 1, init.body.end - 1);
  const script = isolate ? `(function runEditorFixtureInitializer() {\n${body}\n})();` : body;
  return [...shims, ...constants, script].join('\n');
}

// 把无副作用的 ESM 纯模块（如 cues/overlay-track.js）还原为 classic 文本：
// 去掉 import 与 re-export 块、剥掉 `export ` 前缀。模块在 vm 沙箱求值后，
// 其函数闭包里的自由变量（Mawe* 门面）与 classic 时代一样从 context 解析。
export function plainModuleSource(relativeWebPath) {
  const source = fs.readFileSync(path.join(webDir, relativeWebPath), 'utf8');
  const withoutImports = publishFixtureBindings(source, vmFixtureImports(source, relativeWebPath), { file: relativeWebPath }).toString().replace(/^import[^\n]*\n/gm, '');
  const withoutExportBlock = withoutImports.replace(/^export \{[\s\S]*?\n\};?\s*$/gm, '');
  // 与 initModuleSource 同因：vm 无脚本级词法隔离，顶层 const
  // 与后续脚本的同名 var 冲突；统一降为 var。
  return withoutExportBlock
    .replace(/^(?:export )?let (Mawe\w+|MAWE_I18N|AsrEditorUtils);$/gm, 'var $1;')
    .replace(/^export (?=(?:function|const|let|var)\b)/gm, '')
    .replace(/^const\s+/gm, 'var ');
}

// Run an ESM init module inside a fixture's VM context while retaining its
// function bodies and named helpers. The fixture supplies any imported globals.
export function invokedInitModuleSource(relativeWebPath, initializer) {
  return `${plainModuleSource(relativeWebPath)}\n${initializer}();`;
}
