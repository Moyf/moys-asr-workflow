// 检查所有 plain 文件：顶层立即读的门面 vs import 绑定，
// 报告缺失的 import（含 window. 形式的顶层读）。
import fs from 'node:fs';
import path from 'node:path';
import * as acorn from 'acorn';
const root = process.cwd();
// 门面发布者映射（module → export 名），从全部源码扫 export const + window 双发布
const files = [];
const webRoot = path.join(root, 'web');
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js') && !e.name.includes('bundle')) files.push(p.split(path.sep).join('/').slice(webRoot.length + 1));
  }
})(webRoot);
const publishers = new Map(); // facade → {module, export}
for (const f of files) {
  const src = fs.readFileSync(path.join(webRoot, f), 'utf8');
  for (const m of src.matchAll(/export const (Mawe\w+|Asr\w+|MAWE_\w+) =/g)) {
    publishers.set(m[1], { module: f.replace(/^web\//, ''), export: m[1] });
  }
}
const facadeRe = /^(Mawe|MAWE_|Asr)/;
const webFiles = files.map(f => f.replace(/^web\//, ''));
const report = [];
for (const f of webFiles) {
  const src = fs.readFileSync(path.join(root, 'web', f), 'utf8');
  let ast;
  try { ast = acorn.parse(src, { ecmaVersion: 16, sourceType: 'module', ranges: true }); }
  catch { continue; }
  if (/export function\*\s+initialize/.test(src)) continue; // 转换体跳过
  const imported = new Set();
  for (const st of ast.body) {
    if (st.type === 'ImportDeclaration') {
      for (const sp of st.specifiers) imported.add(sp.imported?.name ?? sp.local.name);
    }
  }
  const selfPublish = new Set();
  const need = new Set();
  for (const st of ast.body) {
    (function pub(n) {
      if (!n || typeof n.type !== 'string') return;
      if (n.type === 'AssignmentExpression' && n.operator === '='
        && n.left.type === 'MemberExpression' && !n.left.computed
        && ['window', 'globalThis'].includes(n.left.object?.name)
        && n.left.property?.type === 'Identifier') selfPublish.add(n.left.property.name);
      for (const [k, v] of Object.entries(n)) {
        if (['loc', 'range', 'start', 'end'].includes(k)) continue;
        if (Array.isArray(v)) v.forEach(pub);
        else if (v && typeof v === 'object' && v.type) pub(v);
      }
    })(st);
    (function walk(n) {
      if (!n || typeof n.type !== 'string') return;
      if (n.type === 'FunctionExpression' || n.type === 'FunctionDeclaration'
        || n.type === 'ArrowFunctionExpression') return;
      if (n.type === 'MemberExpression' && !n.computed
        && n.object?.type === 'Identifier'
        && ['window', 'global', 'globalThis'].includes(n.object.name)
        && n.property?.type === 'Identifier' && facadeRe.test(n.property.name)
        && !selfPublish.has(n.property.name)) {
        need.add(n.property.name);
      } else if (n.type === 'Identifier' && facadeRe.test(n.name)
        && publishers.has(n.name) && !selfPublish.has(n.name)
        && !['window', 'global', 'globalThis'].includes(n.name)) {
        need.add(n.name);
      }
      for (const [k, v] of Object.entries(n)) {
        if (['loc', 'range', 'start', 'end'].includes(k)) continue;
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object' && v.type) walk(v);
      }
    })(st);
  }
  const missing = [...need].filter(n => !imported.has(n) && publishers.get(n)?.module !== f);
  if (missing.length) {
    report.push({ file: f, missing: missing.map(n => ({ name: n, from: publishers.get(n)?.module })) });
  }
}
for (const r of report) {
  console.log(r.file);
  for (const m of r.missing) console.log('  ' + m.name + ' ← ' + (m.from ?? '?'));
}
console.log('files with missing imports:', report.length);
if (process.argv.includes('--check') && report.length) process.exitCode = 1;
