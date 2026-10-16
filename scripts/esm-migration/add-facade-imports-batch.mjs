// 按门面名逐批转换（与 add-facade-imports.mjs 同逻辑，但只处理指定名单，
// 每批后需跑 e2e assembly-order 验证 boot 顺序仍绿）。
// 用法：node scripts/esm-migration/add-facade-imports-batch.mjs Name1,Name2 [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import * as acorn from 'acorn';
import { createRequire } from 'node:module';
const eslintScope = createRequire(import.meta.url)('eslint-scope');

const BS = String.fromCharCode(92);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '')), '../..');
const arg = process.argv[2] || '';
const names = arg.split(',').map(s => s.trim()).filter(Boolean);
const dry = process.argv.includes('--dry-run');
const data = JSON.parse(fs.readFileSync(path.join(ROOT, '.artifacts/esm-migration/bare-reads.json'), 'utf8'));
const publishers = data.publishers;
const perFile = data.perFile;

function sources() {
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    if (!e.name.endsWith('.js') || e.name.includes('.bundle.') || e.name === 'editor-bundle.js' || e.name.endsWith('.d.ts')) return [];
    return [path.relative(path.join(ROOT, 'web'), full).replaceAll(BS, '/')];
  });
  return [...walk(path.join(ROOT, 'web/editor')), ...walk(path.join(ROOT, 'web/shared'))].sort();
}
const files = sources();
let changed = 0;
for (const file of files) {
  const hits = perFile[file];
  if (!hits || !hits.length) continue;
  const wanted = names.filter(n => hits.some(h => h.name === n));
  if (!wanted.length) continue;
  const abs = path.join(ROOT, 'web', file);
  const s0 = fs.readFileSync(abs, 'utf8');
  const ast = acorn.parse(s0, { ecmaVersion: 16, sourceType: 'module', ranges: true });
  const scope = eslintScope.analyze(ast, { ecmaVersion: 16, sourceType: 'module', ignoreEval: true });
  const declared = new Set();
  for (const sc of scope.scopes) for (const v of sc.variables) if (v.defs.length) declared.add(v.name);
  const safe = wanted.filter(n => !declared.has(n));
  if (!safe.length) continue;
  const lines = safe.map(n => {
    const owner = publishers[n];
    let rel = path.relative(path.dirname(abs), path.join(ROOT, 'web', owner)).replaceAll(BS, '/');
    if (!rel.startsWith('.')) rel = './' + rel;
    return `import { ${n} } from "${rel}";`;
  });
  let s = s0;
  if (!dry) {
    const firstExport = s0.match(/^export (function|const)|^function /m);
    const headerEnd = firstExport ? firstExport.index : 0;
    const importEnds = [...s0.matchAll(/^import[^\n]*from\s+"[^"]+";\s*$/gm)]
      .map(m => m.index + m[0].length)
      .filter(i => i <= headerEnd);
    let insertAt;
    if (importEnds.length) insertAt = Math.max(...importEnds);
    else insertAt = headerEnd;
    const block = '\n' + lines.join('\n');
    s = s.slice(0, insertAt) + block + s.slice(insertAt);
    fs.writeFileSync(abs, s, 'utf8');
  }
  changed++;
  console.log((dry ? 'DRY ' : 'ADD '), file, safe.join(','));
}
console.log((dry ? 'would change ' : 'changed ') + changed + ' files');
