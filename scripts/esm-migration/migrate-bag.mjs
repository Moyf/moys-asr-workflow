// legacyBindings 袋 → 具名导出迁移器（逐袋执行，机械部分自动化）。
// 袋形态：export let legacyBindings = Object.freeze({ get a(){return a;}, ... });
// 动作：
//  1) owner：袋声明替换为 `export { a, b, ... };`（含 set 访问器的成员报错拒绝）
//  2) 消费者：`import { legacyBindings as X } from "...owner"` →
//     `import { a, b } from "...owner"`（只列该文件用到的成员）
//  3) 消费者：`X.a` → `a`（eslint-scope 未解析引用排除局部遮蔽）
// 用法：node scripts/esm-migration/migrate-bag.mjs <owner-rel-under-web> [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import * as acorn from 'acorn';
import { createRequire } from 'node:module';
const eslintScope = createRequire(import.meta.url)('eslint-scope');

const BS = String.fromCharCode(92); // 反斜杠（避免本文件被转义脚本改写）
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '')), '../..');
const ownerRel = process.argv[2];
const dry = process.argv.includes('--dry-run');
const ownerAbs = path.join(ROOT, 'web', ownerRel);

const src = fs.readFileSync(ownerAbs, 'utf8');
const m = src.match(/export let legacyBindings = Object\.freeze\(\{([\s\S]*?)\n\}\);/);
if (!m) { console.error('bag not found in', ownerRel); process.exit(1); }
const body = m[1];
// 成员只接受 `get x() { return x; }`（袋约定的活绑定透传）；带 set 的拒绝。
const memberRe = /get ([A-Za-z_$][\w$]*)\(\) \{ return [A-Za-z_$][\w$]*; \}(?!\s*,\s*set )/g;
const memberSetRe = /get ([A-Za-z_$][\w$]*)\(\) \{ return [A-Za-z_$][\w$]*; \}, set /g;
const members = [];
let mm;
const bad = [];
while ((mm = memberSetRe.exec(body))) bad.push(mm[1]);
while ((mm = memberRe.exec(body))) members.push(mm[1]);
if (bad.length) { console.error('members with setters rejected:', bad.join(', ')); process.exit(1); }
// acorn 形态校验：袋内只能是 getter（无 init/set）
const inner = acorn.parse(`Object.freeze({${body}})`, { ecmaVersion: 16 });
const objNode = inner.body[0].expression.arguments[0];
const kinds = new Set(objNode.properties.map(p => p.kind));
if (!kinds.has('get') || objNode.properties.some(p => p.kind === 'init' || p.kind === 'set')) {
  console.error('unexpected bag property kinds:', [...kinds].join(','));
  process.exit(1);
}
console.log('members:', members.join(', '));

// 消费者发现：web/ 全树（bundle 排除）
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!/bundle|\.meta\./.test(e.name)) walk(p); }
    else if (e.name.endsWith('.js')) files.push(p);
  }
})(path.join(ROOT, 'web'));

const ownerPosix = ownerRel.split(BS).join('/');
const base = path.posix.basename(ownerPosix);
const escapedBase = base.replace(/[./]/g, (ch) => BS + ch);
const importRe = new RegExp(
  `import ${BS}{ legacyBindings as (${BS}w+) ${BS}} from "([^"]*/${escapedBase})";`);
const ownerMod = path.posix.join('web', ownerPosix);

for (const f of files) {
  const s0 = fs.readFileSync(f, 'utf8');
  let s = s0;
  const im = s.match(importRe);
  if (!im) continue;
  const alias = im[1];
  // 实际用到的成员：扫描 `alias.x` 词法出现。import 绑定不会进
  // globalScope.through，作用域表不能判 alias 是否使用。
  const usedSet = new Set();
  const useScan = new RegExp(BS + 'b' + alias + BS + '.([A-Za-z_$][' + BS + 'w$]*)', 'g');
  let um;
  while ((um = useScan.exec(s))) usedSet.add(um[1]);
  if (!usedSet.size) {
    // 已导入但未使用：删除该 import 行
    s = s.replace(im[0] + '\n', '');
  } else {
    const unknown = [...usedSet].filter(x => !members.includes(x));
    if (unknown.length) {
      console.error(path.relative(ROOT, f), 'uses unknown members:', unknown.join(', '));
      process.exit(1);
    }
    // 局部遮蔽排除：消费者本文件声明了同名绑定时报错人工处理
    // （改成裸名会绑到局部名）。作用域变量 defs 非空即本文件声明。
    const ast = acorn.parse(s0, { ecmaVersion: 16, sourceType: 'module', ranges: true });
    const scope = eslintScope.analyze(ast, { ecmaVersion: 16, sourceType: 'module', ignoreEval: true });
    for (const name of [...usedSet]) {
      const declared = [...scope.scopes].some(sc => sc.variables.some(v => v.name === name && v.defs.length > 0));
      if (declared) {
        console.error(path.relative(ROOT, f), 'shadows member locally:', name);
        process.exit(1);
      }
    }
    const relRaw = path.relative(path.dirname(f), path.join(ROOT, ownerMod));
    const rel = relRaw.split(BS).join('/');
    const importLine = `import { ${[...usedSet].join(', ')} } from "${rel.startsWith('.') ? rel : './' + rel}";`;
    s = s.replace(im[0], importLine);
    for (const name of usedSet) {
      s = s.replace(new RegExp(BS + 'b' + alias + BS + '.' + name + BS + 'b', 'g'), name);
    }
  }
  if (s !== s0) {
    console.log('consumer:', path.relative(ROOT, f).split(BS).join('/'));
    if (!dry) fs.writeFileSync(f, s, 'utf8');
  }
}

// owner：袋声明 → 具名导出
let ownerSrc = fs.readFileSync(ownerAbs, 'utf8');
const exportLine = `export { ${members.join(', ')} };`;
ownerSrc = ownerSrc.replace(m[0], exportLine);
if (!dry) fs.writeFileSync(ownerAbs, ownerSrc, 'utf8');
console.log('owner updated with:', exportLine);
