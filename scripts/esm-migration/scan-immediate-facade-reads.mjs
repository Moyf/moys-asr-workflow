// plain 文件顶层立即位置对外部门面的读（裸名/window.），
// 排除发布赋值（window.X = 与 X 在 windowAssign 左侧）。
// 用法：node scan-immediate-facade-reads.mjs [--json]
import fs from 'node:fs';
import * as acorn from 'acorn';
const facadeRe = /^(Mawe|MAWE|MAWE_|Asr)/;
const files = process.argv.slice(2).filter(a => !a.startsWith('--'));
const report = {};
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  let ast;
  try { ast = acorn.parse(src, { ecmaVersion: 16, sourceType: 'module', ranges: true }); }
  catch { continue; }
  const reads = new Set();
  const selfPublish = new Set();
  for (const stmt of ast.body) {
    // 发布检测：window.X = 或 const/let X =
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
    })(stmt);
    (function walk(n) {
      if (!n || typeof n.type !== 'string') return;
      const isFn = n.type === 'FunctionExpression' || n.type === 'FunctionDeclaration'
        || n.type === 'ArrowFunctionExpression';
      if (isFn) return;
      if (n.type === 'MemberExpression' && !n.computed
        && n.object?.type === 'Identifier'
        && ['window', 'global', 'globalThis'].includes(n.object.name)
        && n.property?.type === 'Identifier' && facadeRe.test(n.property.name)) {
        reads.add('window.' + n.property.name);
      } else if (n.type === 'Identifier' && facadeRe.test(n.name)
        && !['window', 'global', 'globalThis'].includes(n.name)
        && !(n.parentCheck)) {
        reads.add(n.name);
      }
      for (const [k, v] of Object.entries(n)) {
        if (['loc', 'range', 'start', 'end'].includes(k)) continue;
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object' && v.type) walk(v);
      }
    })(stmt);
  }
  const bad = [...reads].filter(n => !selfPublish.has(n.replace(/^window\./, '')));
  if (bad.length) report[f] = bad;
}
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  for (const [f, bad] of Object.entries(report)) console.log(f, '→', bad.join(','));
}
