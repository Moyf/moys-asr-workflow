// register+resolve 对 → 普通 ESM：
//   window.MAWE.register('name', function createX(dep){...});
//   window.MaweX = window.MAWE.resolve('name', args);
// → export function createX(dep){...}
//   export const MaweX = createX(args);
//   window.MaweX = MaweX;
// 同一实例；resolve 参数原文保留（未迁 provider 裸名继续可用）。
// 前提（调用方经 inventory 验证）：门面无 phase-2 立即消费者，
// 或其消费者已先转（import 期求值早于一切 phase-2）。
// 用法：node unwrap-register.mjs <file> [--dry]
import fs from 'node:fs';
import * as acorn from 'acorn';
import MagicString from 'magic-string';

const [file, ...rest] = process.argv.slice(2);
const dry = rest.includes('--dry');
const src = fs.readFileSync(file, 'utf8');
const ast = acorn.parse(src, { ecmaVersion: 16, sourceType: 'module', ranges: true });
const gen = ast.body.find(s => s.type === 'ExportNamedDeclaration'
  && s.declaration?.type === 'FunctionDeclaration' && s.declaration.generator);
if (!gen) throw new Error('not a converter: ' + file);
const body = gen.declaration.body.body;
const yi = body.findIndex(s => s.type === 'ExpressionStatement'
  && s.expression.type === 'YieldExpression');
if (yi !== 0) throw new Error('statements before yield: ' + file);
const phase2 = body.slice(yi + 1);
if (phase2.length !== 2) throw new Error('expect register+resolve pair, got '
  + phase2.length + ': ' + file);
const [regStmt, resStmt] = phase2;
const reg = regStmt.expression;
const res = resStmt.expression;
if (reg.type !== 'CallExpression' || reg.callee.property?.name !== 'register')
  throw new Error('stmt1 not register: ' + file);
if (res.type !== 'AssignmentExpression' || res.operator !== '='
  || res.left.property?.type !== 'Identifier')
  throw new Error('stmt2 not facade assignment: ' + file);
if (res.right.type !== 'CallExpression' || res.right.callee.property?.name !== 'resolve')
  throw new Error('stmt2 not resolve: ' + file);

const factoryFn = reg.arguments[1];
if (factoryFn.type !== 'FunctionExpression') throw new Error('factory not fn-expr: ' + file);
const factoryName = factoryFn.id?.name;
if (!factoryName) throw new Error('factory has no name: ' + file);
const resolveName = reg.arguments[0].value;
const facadeName = res.left.property.name;
const resolveArgs = res.right.arguments.slice(1)
  .map(a => src.slice(a.start, a.end)).join(', ');
const factoryParams = factoryFn.params.map(p => src.slice(p.start, p.end)).join(', ');

// 工厂体语句（去 'use strict'）
const factoryStmts = factoryFn.body.body.filter(s => !(
  s.type === 'ExpressionStatement' && s.expression.type === 'Literal'
  && s.expression.value === 'use strict'));
const factorySrc = factoryStmts.map(st => src.slice(st.start, st.end).replace(/^ {2}/gm, '')).join('\n\n');

const s = new MagicString(src);
const prelude = src.slice(0, gen.start);
if (prelude.includes('import ')) {
  // 保留壳外 import：剪掉 export function* 起点之后、import 结束前的内容
  // （import 在最前，直接保留到 export 前即可）
  s.remove(prelude.indexOf('export function*'), gen.end);
} else {
  s.remove(gen.start, gen.end);
}
const tail = '\n// 真 ESM：register+resolve 对 → 具名工厂导出（原注册名 '
  + resolveName + '）。\n'
  + 'export function ' + factoryName + '(' + factoryParams + ') {\n'
  + factorySrc + '\n}\n\n'
  + 'export const ' + facadeName + ' = ' + factoryName + '(' + resolveArgs + ');\n'
  + 'window.' + facadeName + ' = ' + facadeName + ';\n';
s.append(tail);
const out = s.toString();
if (dry) { console.log(out.slice(0, 900)); process.exit(0); }
fs.writeFileSync(file, out, { encoding: 'utf8' });
console.log('unwrapped-register:', file, '(' + facadeName + ')');
