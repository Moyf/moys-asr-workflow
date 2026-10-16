// 转换体 → 普通 ESM 的机械转换（IIFE 门面形态）：
// 1) 去壳：`export function* initialize() { yield; <IIFE>(…); }`
//    → IIFE 解包为模块顶层（global.<Name> → window.<Name>）
// 2) 门面：window.<Name> = Object.freeze({...}) 拆为
//    export const <Name> = ...; window.<Name> = <Name>;
// 3) 非门面语句保持顶层顺序（import 期求值 ≈ 原 phase-2 位置前提：
//    该文件无立即消费者，由 inventory 验证——工具不验证，调用方负责）
// 用法：node scripts/esm-migration/unwrap-iife.mjs <file> [--dry]
import fs from 'node:fs';
import * as acorn from 'acorn';
import MagicString from 'magic-string';

const [file, ...rest] = process.argv.slice(2);
const dry = rest.includes('--dry');
const src = fs.readFileSync(file, 'utf8');
const ast = acorn.parse(src, { ecmaVersion: 16, sourceType: 'module', ranges: true });

// 壳定位
const gen = ast.body.find(s => s.type === 'ExportNamedDeclaration'
  && s.declaration?.type === 'FunctionDeclaration' && s.declaration.generator);
if (!gen) throw new Error('not a converter shell: ' + file);
const body = gen.declaration.body.body;
const yi = body.findIndex(s => s.type === 'ExpressionStatement'
  && s.expression.type === 'YieldExpression');
if (yi !== 0) throw new Error('unexpected statements before yield: ' + file);
const phase2 = body.slice(yi + 1);
if (phase2.length !== 1 || phase2[0].type !== 'ExpressionStatement')
  throw new Error('phase-2 must be exactly one IIFE expression: ' + file);

const iife = phase2[0].expression;
// 支持 (function(global){...})(arg) 与 ((global)=>{...})(arg)
let fn, arg;
if (iife.type === 'CallExpression') {
  fn = iife.callee.type === 'FunctionExpression' ? iife.callee
    : iife.callee.type === 'ParenthesizedExpression' ? iife.callee.expression : null;
  arg = iife.arguments?.[0];
} else if (iife.type === 'UnaryExpression' && iife.argument.type === 'CallExpression') {
  fn = iife.argument.callee; arg = iife.argument.arguments?.[0];
}
if (!fn || !arg) throw new Error('unrecognized IIFE shape: ' + file);
// 实参常为条件表达式（typeof window !== 'undefined' ? window :
// globalThis）；bundle 环境恒有 window，体内 global→window 语义等价。
const paramName = fn.params?.[0]?.name;
if (!paramName) throw new Error('IIFE function has no parameter: ' + file);

// 语义段：IIFE 体 = 'use strict' + 定义 + 门面赋值。
// 无门面赋值（纯接线 wiring）时退化为纯去壳：体内语句顶层化，
// 无导出发布（副作用 import 即装配）。
const stmts = fn.body.body;
const facadeStmt = stmts.find(s => s.type === 'ExpressionStatement'
  && s.expression.type === 'AssignmentExpression'
  && s.expression.left.type === 'MemberExpression'
  && ['window', 'global', 'globalThis'].includes(s.expression.left.object?.name));
const name = facadeStmt ? facadeStmt.expression.left.property.name : null;
const frozen = facadeStmt ? facadeStmt.expression.right : null; // Object.freeze({...})

const s = new MagicString(src);
// 壳与 IIFE 包裹去除：取 body 起点到 IIFE 前、IIFE 体内、IIFE 后
const prelude = src.slice(gen.start, iife.start); // 'export function* initialize() {\nyield;\n' + 注释等
const inner = src.slice(fn.body.start + 1, fn.body.end - 1); // 体内
const tail = src.slice(iife.end + 1, gen.end); // ';\n\n}' 等
void prelude; void tail;

let out = '';
// 保留壳外的模块级内容（import 语句与其上注释）——unwrap 不能丢 provider 边。
const modulePrelude = src.slice(0, gen.start);
const NL = "\n";
out += modulePrelude.includes('import ')
  ? modulePrelude.slice(0, modulePrelude.indexOf('export function*')).trimEnd() + NL + NL
  : '';
out += '// 真 ESM：模块顶层定义与发布（原转换体 phase-2 语义 = import 求值）。\n'
  + "// window.<Name> 与导出的 <Name> 是同一对象；消费者逐簇改 import 后移除 window 发布。\n"
  + "'use strict';\n";
// 体内语句：去 IIFE 自带 'use strict'、缩进 -2、折叠多空行。
const innerLines = inner.replace(/^\n+/, '').replace(/\n+$/, '').split("\n");
const dedented = [];
let strictSkipped = false;
for (const l of innerLines) {
  if (!strictSkipped && l.trim() === "'use strict';") { strictSkipped = true; continue; }
  dedented.push(l.startsWith('  ') && l.trim() ? l.slice(2) : l);
}
const body2 = dedented.join("\n").replace(/\n{3,}/g, "\n\n");
out += body2 + "\n";
if (name && frozen) {
  out += "\nexport const " + name + " = " + src.slice(frozen.start, frozen.end) + ";\n";
  out += "window." + name + " = " + name + ";\n";
}
const wordBoundary = String.fromCharCode(92) + 'b(?:global|globalThis)' + String.fromCharCode(92) + '.';
out = out.replace(new RegExp(wordBoundary, 'g'), 'window.');
if (dry) { console.log(out.slice(0, 1200)); process.exit(0); }
fs.writeFileSync(file, out, { encoding: 'utf8' });
console.log(name ? 'unwrapped: ' + file + ' (' + name + ')' : 'unwrapped-bare: ' + file);
