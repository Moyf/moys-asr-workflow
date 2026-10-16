// editor-utils/waveform 类「compose facade」转换：
// `export function* initialize() { yield; (function () { 'use strict';
//    const helpers = {...}; Object.assign(helpers, MAWE.resolve(N, helpers));
//    ...; window.X = {...} = helpers 展开; })(); }`
// → import 直连工厂（名称映射由调用方传入 JSON）+ 顶层组装 + export。
// 此处只处理 editor-utils 一个文件；通用化留待出现第二例。
import fs from 'node:fs';
const file = process.argv[2];
const dry = process.argv.includes('--dry');
const src = fs.readFileSync(file, 'utf8');
const ast = (await import('acorn')).parse(src, { ecmaVersion: 16, sourceType: 'module', ranges: true });
const gen = ast.body.find(s => s.type === 'ExportNamedDeclaration'
  && s.declaration?.type === 'FunctionDeclaration' && s.declaration.generator);
if (!gen) throw new Error('not a converter shell: ' + file);
// IIFE 定位
const body = gen.declaration.body.body;
const yi = body.findIndex(s => s.type === 'ExpressionStatement' && s.expression.type === 'YieldExpression');
const iifeStmt = body[yi + 1];
if (!iifeStmt || iifeStmt.type !== 'ExpressionStatement'
  || !(iifeStmt.expression.type === 'CallExpression'
    || iifeStmt.expression.type === 'UnaryExpression')) {
  throw new Error('no IIFE: ' + file);
}
const call = iifeStmt.expression.type === 'UnaryExpression' ? iifeStmt.expression.argument : iifeStmt.expression;
const fn = call.callee;
const inner = src.slice(fn.body.start + 1, fn.body.end - 1);
// helpers 定义保留原文；resolve 行由调用方 sed 替换。
const out = src.slice(0, gen.start).replace(/\n+$/, '\n\n')
  + '// 真 ESM：compose facade 直连工厂实例化（原 MAWE.resolve 组装 = import 求值）。\n'
  + "'use strict';\n"
  + inner.replace(/^\n/, '').replace(/\n+$/, '\n').split('\n').map(l => l.startsWith('  ') ? l.slice(2) : l).join('\n');
if (dry) { console.log(out.slice(0, 1500)); process.exit(0); }
fs.writeFileSync(file, out, { encoding: 'utf8' });
console.log('unwrapped-compose:', file);
