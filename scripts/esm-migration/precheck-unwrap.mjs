// unwrap 前置安全检查：文件 phase-2 顶层（非函数体内）是否有
// 对外部门面（Mawe*/MAWE*/Asr*）的立即读（裸名或 window. 形式）。
// 用法：node precheck-unwrap.mjs <file> → exit 0=安全 / 1=有立即读（打印）
import fs from 'node:fs';
import * as acorn from 'acorn';
const file = process.argv[2];
const src = fs.readFileSync(file, 'utf8');
const ast = acorn.parse(src, { ecmaVersion: 16, sourceType: 'module', ranges: true });
const gen = ast.body.find(s => s.type === 'ExportNamedDeclaration'
  && s.declaration?.type === 'FunctionDeclaration' && s.declaration.generator);
if (!gen) { console.log('not-converter'); process.exit(0); }
const facadeRe = /^(Mawe|MAWE|MAWE_|Asr)/;
const reads = new Set();
(function walk(node, immediate) {
  if (!node || typeof node.type !== 'string') return;
  const isFn = node.type === 'FunctionExpression' || node.type === 'FunctionDeclaration'
    || node.type === 'ArrowFunctionExpression';
  if (isFn) return; // 不深入函数体
  if (node.type === 'MemberExpression' && !node.computed
    && node.object?.type === 'Identifier'
    && ['window', 'global', 'globalThis'].includes(node.object.name)
    && node.property?.type === 'Identifier' && facadeRe.test(node.property.name)) {
    reads.add('window.' + node.property.name);
  }
  if (node.type === 'Identifier' && facadeRe.test(node.name)
    && !['window', 'global', 'globalThis'].includes(node.name)) {
    // 裸名（门面名作标识符）
    reads.add(node.name);
  }
  for (const [k, v] of Object.entries(node)) {
    if (['loc', 'range', 'start', 'end'].includes(k)) continue;
    if (Array.isArray(v)) v.forEach(n => walk(n, immediate));
    else if (v && typeof v === 'object' && v.type) walk(v, immediate);
  }
})(gen.declaration.body, true);
// 排除本文件发布（赋值左侧）
if (reads.size) { console.log([...reads].join(',')); process.exit(1); }
console.log('safe'); process.exit(0);
