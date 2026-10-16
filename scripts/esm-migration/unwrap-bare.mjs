// 转换体 → 普通 ESM 的机械转换（wiring legacyBindings 形态）：
// `export let legacyBindings; export function* initialize() {
//    legacyBindings = Object.freeze({...}); yield; <phase-2 语句> }`
// → 顶层 `export let legacyBindings = Object.freeze({...});` + 语句顶层化。
// phase-1 的 legacyBindings 赋值移到 import 期（模块求值即发布），
// phase-2 语句顶层化（立即读语义前提：inventory 已验证无立即消费者，
// 工具不验证，调用方负责）。也支持无 legacyBindings 赋值的纯语句形态。
// 用法：node scripts/esm-migration/unwrap-bare.mjs <file> [--dry]
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
if (yi < 0) throw new Error('no yield in shell: ' + file);
const prePhase = body.slice(0, yi); // phase-1 提升（legacyBindings 赋值等）
const phase2 = body.slice(yi + 1); // 语句序列（不是 IIFE）
if (prePhase.length > 1) throw new Error('unexpected multi-statement phase-1: ' + file);

const lbStmt = prePhase[0];
let lbAssign = null;
if (lbStmt) {
  if (!(lbStmt.type === 'ExpressionStatement'
    && lbStmt.expression.type === 'AssignmentExpression'
    && lbStmt.expression.left.type === 'Identifier'
    && lbStmt.expression.left.name === 'legacyBindings')) {
    throw new Error('phase-1 is not legacyBindings assignment: ' + file);
  }
  lbAssign = lbStmt.expression.right;
}

const s = new MagicString(src);
// 1) 删除壳语句（从 export let 到 generate 末尾之间全部）：
//    保留壳外内容（import 头 + export let legacyBindings 声明）。
const genEnd = gen.end;
// 壳外前奏 = src 到 export let 声明结束（含）。壳里的 export let 是
// ExportNamedDeclaration（de declaration VariableDeclaration）。
const letDecl = gen; // export let legacyBindings;
const NL_CH = String.fromCharCode(92) + 'n';
const beforeShell = src.slice(0, letDecl.start)
  .replace(new RegExp('^export let legacyBindings;[ ]*' + NL_CH + '?', 'm'), '');
// 2) 重写：export let 声明 + 顶层赋值/语句 + phase-2 语句。
let out = beforeShell.replace(/\n+$/, '\n\n');
out += '// 真 ESM：wiring 顶层接线（原转换体 phase-1/phase-2 = import 求值）。\n'
  + "'use strict';\n";
if (lbAssign) {
  // export let legacyBindings; → export let legacyBindings = <rhs>;
  const rhs = src.slice(lbAssign.start, lbAssign.end);
  out += 'export let legacyBindings = ' + rhs + ';\n';
  out += '\n' + src.slice(phase2[0].start, phase2[phase2.length - 1].end).trimEnd() + '\n';
} else {
  out += src.slice(phase2[0].start, phase2[phase2.length - 1].end).trimEnd() + '\n';
}
const wordBoundary = String.fromCharCode(92) + 'b(?:global|globalThis)' + String.fromCharCode(92) + '.';
out = out.replace(new RegExp(wordBoundary, 'g'), 'window.');
if (dry) { console.log(out.slice(0, 1200)); process.exit(0); }
fs.writeFileSync(file, out, { encoding: 'utf8' });
console.log('unwrapped-bare:', file);
