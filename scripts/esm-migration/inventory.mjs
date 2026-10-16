// 真 ESM 迁移盘点（计划第 2 步）：
// 对 web/editor + web/shared 的每个转换体，用 Acorn + eslint-scope
// 做作用域级分析（非正则计数），输出：
//  - owner：window/global/globalThis.<Name> 直接赋值/defineProperty 的唯一声明文件
//  - per-file：裸读（未解析标识符中命中 owner 名）、window.<Name> 读、
//    跨文件直接赋值（<Name> = 的 owner 非本文件）、属性写入（obj.f = / obj.f++）
//  - 立即/延迟：顶层语句与 IIFE 体立即执行；存储函数体延迟
//  - import 边与强连通分量（Tarjan）
// 用法：node scripts/esm-migration/inventory.mjs [--json out.json] [--md out.md]
// 报告写 .artifacts（派生物）；工具本体入库。
import fs from 'node:fs';
import path from 'node:path';
import * as acorn from 'acorn';
import { createRequire } from 'node:module';
const eslintScope = createRequire(import.meta.url)('eslint-scope');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '')), '../..');
const args = process.argv.slice(2);
const argOf = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const jsonOut = argOf('--json') ?? '.artifacts/esm-migration/inventory.json';
const mdOut = argOf('--md') ?? '.artifacts/esm-migration/inventory.md';

// 登记表退役：不再有工厂形态与保序转换体（classic 集为空）。
const factoryFiles = new Set();
const classic = [];

function sources() {
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    if (!e.name.endsWith('.js') || e.name.includes('.bundle.') || e.name === 'editor-bundle.js') return [];
    return [path.relative(path.join(ROOT, 'web'), full).replaceAll('\\', '/')];
  });
  const out = [...walk(path.join(ROOT, 'web/editor')), ...walk(path.join(ROOT, 'web/shared'))];
  const fixtureDir = path.join(ROOT, 'tests/fixtures/esm-inventory');
  if (fs.existsSync(fixtureDir)) {
    for (const e of fs.readdirSync(fixtureDir)) {
      if (e.endsWith('.js')) out.push('tests/fixtures/esm-inventory/' + e);
    }
  }
  return out.sort();
}
const files = sources();

const parseCache = new Map();
function readAt(file) {
  return file.startsWith('tests/')
    ? fs.readFileSync(path.join(ROOT, file), 'utf8')
    : fs.readFileSync(path.join(ROOT, 'web', file), 'utf8');
}
function parse(file) {
  if (parseCache.has(file)) return parseCache.get(file);
  const src = readAt(file);
  const ast = acorn.parse(src, { ecmaVersion: 16, sourceType: 'module', ranges: true });
  parseCache.set(file, { src, ast });
  return parseCache.get(file);
}

// 1) phase-2 顶层语句集合（转换体）；工厂/普通 ESM 全模块体即为顶层
function topLevelStatements(file) {
  const { src, ast } = parse(file);
  if (factoryFiles.has(file)) return { src, stmts: ast.body };
  const gen = ast.body.find(s => s.type === 'ExportNamedDeclaration'
    && s.declaration?.type === 'FunctionDeclaration' && s.declaration.generator);
  if (!gen) return { src, stmts: ast.body }; // 普通 ESM
  const body = gen.declaration.body.body;
  const yi = body.findIndex(s => s.type === 'ExpressionStatement' && s.expression.type === 'YieldExpression');
  return { src, stmts: body.slice(yi + 1) };
}

// 2) 立即语境：顶层语句；IIFE 体（callee 直调或括号包 unary）；
//    存储函数体（非 IIFE）整体延迟。返回每个立即标识符的语境位置。
function immediateIdentifiers(file) {
  const { src, stmts } = topLevelStatements(file);
  const out = { immediate: new Set(), delayedOnly: new Set() };
  function scanAllLocalNames(body) {
    const names = new Set();
    (function scan(n) {
      if (!n || typeof n.type !== 'string') return;
      if (n.type === 'FunctionDeclaration' && n.id) names.add(n.id.name);
      if (n.type === 'VariableDeclaration') for (const d of n.declarations) {
        if (d.id.type === 'Identifier') names.add(d.id.name);
      }
      for (const [k, v] of Object.entries(n)) {
        if (['loc', 'range', 'start', 'end'].includes(k)) continue;
        if (Array.isArray(v)) { for (const c of v) { if (c && typeof c.type === 'string') scan(c); } }
        else if (v && typeof v.type === 'string') scan(v);
      }
    })(body);
    return names;
  }
  function visit(node, parent, fnDepth) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'FunctionDeclaration') return; // 体延迟；提升名由 scope 分析管
    if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
      const isIIFE = (parent?.type === 'CallExpression' && parent.callee === node && node.type === 'FunctionExpression')
        || (parent?.type === 'UnaryExpression');
      if (!isIIFE) return;
      if (node.body.type === 'BlockStatement') {
        for (const s of node.body.body) visit(s, node.body, fnDepth + 1);
      } else visit(node.body, node, fnDepth + 1);
      return;
    }
    if (node.type === 'Identifier') {
      if (fnDepth === 0) out.immediate.add(node.name);
      else out.delayedOnly.add(node.name);
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (['loc', 'range', 'start', 'end'].includes(k)) continue;
      if (Array.isArray(v)) { for (const c of v) { if (c && typeof c.type === 'string') visit(c, node, fnDepth); } }
      else if (v && typeof v.type === 'string') visit(v, node, fnDepth);
    }
  }
  for (const s of stmts) visit(s, null, 0);
  return { src, stmts, ...out };
}

// 3) 发布 owner：window/global/globalThis.<Name> = 与 defineProperty(window, 'Name')
const publishers = {}; // name -> file
const publisherFiles = {}; // file -> Set(names)
// 两轮收集：defineProperty（活访问器，owner 的实现形态）优先于
// window 赋值（可能是消费者的写回语义，如 MaweBoot.FILENAME_BASE = x）。
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
      const arg = node.arguments?.[1];
      if (target?.type === 'Identifier'
          && ['window', 'global', 'globalThis'].includes(target.name)
          && arg?.type === 'Literal' && typeof arg.value === 'string') names.add(arg.value);
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
for (const want of ['define', 'assign']) {
  for (const file of files) {
    const { stmts } = topLevelStatements(file);
    const names = collectNames(stmts, want);
    if (names.size) {
      (publisherFiles[file] ??= new Set());
      for (const n of names) {
        publisherFiles[file].add(n);
        if (want === 'define' || !publishers[n]) publishers[n] = file;
      }
    }
  }
}

// 4) 逐文件：eslint-scope 未解析引用 + AST 立即/延迟分类
const perFile = {};
const importEdges = [];
for (const file of files) {
  const info = immediateIdentifiers(file);
  const { src, ast } = parse(file);
  const scope = eslintScope.analyze(ast, { ecmaVersion: 16, sourceType: 'module', ignoreEval: true });
  const unresolved = new Set(scope.globalScope.through.map(ref => ref.identifier.name));
  // window.<Name> 读（AST）
  const windowReads = new Set();
  const windowAssign = new Set();   // window.<Name> = 直接赋值
  const propWrites = new Set();     // obj.f = / obj[f] = （属性写入，对象属性操作）
  const crossAssign = new Set();    // 裸 <Name> = 且 owner 非本文件（跨文件绑定重赋值）
  (function visit(node) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'MemberExpression' && !node.computed
        && node.object?.type === 'Identifier' && ['window', 'global', 'globalThis'].includes(node.object.name)
        && node.property?.type === 'Identifier') {
      // 本文件自己的发布语句排除：发布已在 publishers 侧记录
      windowReads.add(node.property.name);
    }
    if (node.type === 'AssignmentExpression' && node.operator === '=') {
      const l = node.left;
      if (l.type === 'MemberExpression' && !l.computed
          && l.object?.type === 'Identifier' && ['window', 'global', 'globalThis'].includes(l.object.name)
          && l.property?.type === 'Identifier') {
        windowAssign.add(l.property.name);
              propWrites.add((l.property?.name ?? l.property?.value ?? '?') + '');
      } else if (l.type === 'Identifier' && publishers[l.name] && publishers[l.name] !== file) {
        crossAssign.add(l.name);
      }
    }
    for (const [k, v] of Object.entries(node)) {
      if (['loc', 'range', 'start', 'end'].includes(k)) continue;
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v.type === 'string') visit(v);
    }
  })(ast);
  // import 边
  for (const s of ast.body) {
    if (s.type === 'ImportDeclaration' && s.source.type === 'Literal' && typeof s.source.value === 'string'
        && s.source.value.startsWith('.')) {
      const t = path.posix.normalize(path.posix.join(path.posix.dirname(file), s.source.value));
      if (files.includes(t)) importEdges.push([file, t]);
    }
  }
  // 本文件的发布名不算“读”；eslint-scope 未解析引用交集排除
  // 局部同名遮蔽（参数/局部 const 的同名不算跨文件引用）。
  const ownPub = publisherFiles[file] ?? new Set();
  const bareReads = [...info.immediate].filter(n => !ownPub.has(n) && publishers[n]
    && publishers[n] !== file && unresolved.has(n));
  perFile[file] = {
    kind: factoryFiles.has(file) ? 'factory' : 'classic',
    publishes: [...ownPub],
    bareImmediateReads: bareReads,
    bareDelayedReads: [...info.delayedOnly].filter(n => !ownPub.has(n) && publishers[n] && publishers[n] !== file && unresolved.has(n)),
    unresolvedCount: unresolved.size,
    windowReads: [...windowReads].filter(n => publishers[n] && publishers[n] !== file),
    windowAssign: [...windowAssign],
    crossAssign: [...crossAssign],
    propWrites: [...propWrites],
  };
}

// 5) 强连通分量（Tarjan，import 边）
function tarjanSCC(nodes, edges) {
  const adj = new Map(nodes.map(n => [n, []]));
  for (const [a, b] of edges) adj.get(a)?.push(b);
  let index = 0; const stack = []; const onStack = new Set();
  const idx = new Map(), low = new Map(), sccs = [];
  function strong(v) {
    idx.set(v, index); low.set(v, index); index++;
    stack.push(v); onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!idx.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) === idx.get(v)) {
      const c = [];
      for (;;) { const w = stack.pop(); onStack.delete(w); c.push(w); if (w === v) break; }
      sccs.push(c);
    }
  }
  for (const n of nodes) if (!idx.has(n)) strong(n);
  return sccs;
}
const sccs = tarjanSCC(files, importEdges).filter(c => c.length > 1);

const report = {
  generatedWith: 'scripts/esm-migration/inventory.mjs',
  counts: { files: files.length, factories: factoryFiles.size, classic: classic.length, publishers: Object.keys(publishers).length, sccs: sccs.length },
  publishers, publisherFiles, perFile, importEdges, sccs,
};
fs.mkdirSync(path.dirname(path.join(ROOT, jsonOut)), { recursive: true });
fs.writeFileSync(path.join(ROOT, jsonOut), JSON.stringify(report, null, 2) + '\n');

// Markdown 摘要（派生）
const md = [];
md.push('# 真 ESM 迁移盘点（派生报告）\n');
md.push('files=' + report.counts.files + ' factories=' + report.counts.factories
  + ' classic=' + report.counts.classic + ' publishers=' + report.counts.publishers
  + ' scc>1=' + report.counts.sccs + '\n');
md.push('## 发布 owner（唯一声明文件）\n');
const multiOwner = Object.keys(publishers).filter((n) => {
  const owners = Object.entries(publisherFiles).filter(([file, names]) => names.has(n));
  return owners.length > 1;
});
for (const [n, f] of Object.entries(publishers)) md.push('- ' + n + ' <- ' + f);
if (multiOwner.length) {
  md.push('\n## 多 owner（人工处理）\n');
  for (const n of multiOwner) md.push('- ' + n);
}
md.push('\n## 强连通分量（import 环）\n');
for (const c of sccs) md.push('- ' + c.join(', '));
md.push('\n## 跨文件直接赋值（须改 owner setter）\n');
for (const [f, r] of Object.entries(perFile)) if (r.crossAssign.length) md.push('- ' + f + ': ' + r.crossAssign.join(', '));
fs.mkdirSync(path.dirname(path.join(ROOT, mdOut)), { recursive: true });
fs.writeFileSync(path.join(ROOT, mdOut), md.join('\n') + '\n');
console.log('inventory: files=' + report.counts.files + ' publishers=' + report.counts.publishers + ' sccs=' + report.counts.sccs);
console.log('json: ' + jsonOut);
console.log('md: ' + mdOut);
