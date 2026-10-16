// 裸全局门面读扫描（验证器复核要求的全文件覆盖）：
// 对 web/editor + web/shared 每个 JS 文件做 Acorn 解析 +
// eslint-scope 全作用域未解析引用分析，命中「发布者名」的
// 未解析读即裸门面读（函数体内也算，补 inventory.mjs 只查
// 顶层/IIFE 的盲区）。输出 per-file 命中与全量计数。
// 用法：node scripts/esm-migration/bare-reads.mjs [--json out]
import fs from 'node:fs';
import path from 'node:path';
import * as acorn from 'acorn';
import { createRequire } from 'node:module';
const eslintScope = createRequire(import.meta.url)('eslint-scope');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '')), '../..');
const args = process.argv.slice(2);
const argOf = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const jsonOut = argOf('--json') ?? '.artifacts/esm-migration/bare-reads.json';

function sources() {
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    if (!e.name.endsWith('.js') || e.name.includes('.bundle.') || e.name === 'editor-bundle.js' || e.name.endsWith('.d.ts')) return [];
    return [path.relative(path.join(ROOT, 'web'), full).replaceAll(String.fromCharCode(92), '/')];
  });
  return [...walk(path.join(ROOT, 'web/editor')), ...walk(path.join(ROOT, 'web/shared'))].sort();
}
const files = sources();

// 发布者名：与 inventory.mjs 同口径（define 优先于 assign 两轮）。
const publishers = {}; // name -> file
function collectNames(stmts, want) {
  const names = new Set();
  (function visit(node) {
    if (!node || typeof node.type !== 'string') return;
    if (want === 'define' && node.type === 'CallExpression'
        && node.callee?.type === 'MemberExpression'
        && node.callee.object?.type === 'Identifier'
        && node.callee.object.name === 'Object'
        && node.callee.property?.name === 'defineProperty') {
      const target = node.arguments?.[0];
      const name = node.arguments?.[1];
      if (target?.type === 'Identifier'
          && ['window', 'global', 'globalThis'].includes(target.name)
          && name?.type === 'Literal' && typeof name.value === 'string') names.add(name.value);
    }
    if (want === 'assign' && node.type === 'AssignmentExpression' && node.operator === '='
        && node.left?.type === 'MemberExpression' && !node.left.computed
        && node.left.object?.type === 'Identifier'
        && ['window', 'global', 'globalThis'].includes(node.left.object.name)
        && node.left.property?.type === 'Identifier') {
      names.add(node.left.property.name);
    }
    for (const [k, v] of Object.entries(node)) {
      if (['loc', 'range', 'start', 'end'].includes(k)) continue;
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v.type === 'string') visit(v);
    }
  })({ type: 'Block', body: stmts });
  return names;
}
const parseCache = new Map();
function parseAt(file) {
  if (parseCache.has(file)) return parseCache.get(file);
  const src = fs.readFileSync(path.join(ROOT, 'web', file), 'utf8');
  const ast = acorn.parse(src, { ecmaVersion: 16, sourceType: 'module', ranges: true });
  parseCache.set(file, { src, ast });
  return parseCache.get(file);
}
for (const want of ['define', 'assign']) {
  for (const file of files) {
    const { ast } = parseAt(file);
    for (const n of collectNames(ast.body, want)) {
      if (want === 'define' || !publishers[n]) publishers[n] = file;
    }
  }
}

const perFile = {};
let total = 0, filesWith = 0;
function lineAt(src, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src.charCodeAt(i) === 10) line++;
  return line;
}
for (const file of files) {
  const { src, ast } = parseAt(file);
  const scope = eslintScope.analyze(ast, { ecmaVersion: 16, sourceType: 'module', ignoreEval: true });
  // 全部未解析引用（任何作用域层，含函数体）→ 行号去重
  const hits = new Map();
  for (const ref of scope.globalScope.through) {
    const name = ref.identifier.name;
    if (!publishers[name] || publishers[name] === file) continue;
    const line = lineAt(src, ref.identifier.range[0]);
    hits.set(name + ':' + line, { name, line });
  }
  // 局部遮蔽复核：eslint-scope 的 through 已排除作用域内声明的名字。
  if (hits.size) {
    filesWith++;
    perFile[file] = [...hits.values()].sort((a, b) => a.line - b.line);
    total += hits.size;
  }
}
fs.mkdirSync(path.dirname(path.join(ROOT, jsonOut)), { recursive: true });
fs.writeFileSync(path.join(ROOT, jsonOut), JSON.stringify({
  generatedWith: 'scripts/esm-migration/bare-reads.mjs',
  counts: { files: files.length, publishers: Object.keys(publishers).length, filesWithBareReads: filesWith, bareReads: total },
  publishers,
  perFile,
}, null, 1));
console.log(`bare-reads: files=${files.length} publishers=${Object.keys(publishers).length} filesWithBareReads=${filesWith} bareReads=${total}`);
if (args.includes('--check') && total) process.exitCode = 1;
