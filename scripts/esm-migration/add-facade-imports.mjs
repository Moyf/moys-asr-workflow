// 裸全局门面读 → 具名 import 批量转换器。
// 对每个（文件，门面名）：owner 由 bare-reads.json 的 publishers 提供，
// eslint-scope 确认该文件无同名局部声明后，插入 `import { MaweX } from owner`
// 并保持代码文本不变（裸名在 ESM 下自动解析为导入绑定）。
// 运行前先 bare-reads 扫描；运行后必须重建 bundle + 全量测试。
// 用法：node scripts/esm-migration/add-facade-imports.mjs [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import * as acorn from 'acorn';
import { createRequire } from 'node:module';
const eslintScope = createRequire(import.meta.url)('eslint-scope');

const BS = String.fromCharCode(92);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '')), '../..');
const dry = process.argv.includes('--dry-run');
const data = JSON.parse(fs.readFileSync(path.join(ROOT, '.artifacts/esm-migration/bare-reads.json'), 'utf8'));
const publishers = data.publishers; // name -> file (web-relative posix)
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
  const names = [...new Set(hits.map(h => h.name))].sort();
  const abs = path.join(ROOT, 'web', file);
  const s0 = fs.readFileSync(abs, 'utf8');
  // 局部遮蔽拒绝：本文件声明的同名绑定存在则跳过该名
  const ast = acorn.parse(s0, { ecmaVersion: 16, sourceType: 'module', ranges: true });
  const scope = eslintScope.analyze(ast, { ecmaVersion: 16, sourceType: 'module', ignoreEval: true });
  const declared = new Set();
  for (const sc of scope.scopes) for (const v of sc.variables) if (v.defs.length) declared.add(v.name);
  const safe = names.filter(n => !declared.has(n));
  const skip = names.filter(n => declared.has(n));
  if (skip.length) console.log('SHADOW-SKIP', file, skip.join(','));
  if (!safe.length) continue;
  // 生成 import 块（相对路径）
  const lines = safe.map(n => {
    const owner = publishers[n];
    let rel = path.relative(path.dirname(abs), path.join(ROOT, 'web', owner)).replaceAll(BS, '/');
    if (!rel.startsWith('.')) rel = './' + rel;
    return `import { ${n} } from "${rel}";`;
  });
  let s = s0;
  if (!dry) {
    // 插入到现有 import 块末尾之后；无 import 则文件头（'use strict' 之后）
    const importEnds = [...s0.matchAll(/^import[^\n]*from\s+"[^"]+";\s*$/gm)].map(m => m.index + m[0].length);
    let insertAt;
    if (importEnds.length) insertAt = Math.max(...importEnds);
    else {
      const us = s0.indexOf("'use strict';");
      insertAt = us >= 0 ? us + "'use strict';".length : 0;
    }
    const block = '\n' + lines.join('\n');
    s = s.slice(0, insertAt) + block + s.slice(insertAt);
    fs.writeFileSync(abs, s, 'utf8');
  }
  changed++;
  console.log((dry ? 'DRY ' : 'ADD '), file, safe.join(','));
}
console.log((dry ? 'would change ' : 'changed ') + changed + ' files');
