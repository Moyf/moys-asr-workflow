// scope-core：ns-rewrite 与 merge-flow 共用的作用域分析内核。
//
// 基于 eslint-scope（ESLint 的作用域引擎，原生消费 acorn AST）。
// 未解析引用以 globalScope.through 为权威集合；for-of/for-in 头部声明、
// catch 参数、嵌套块内 var 提升、let/const 块级作用域等绑定形态按规范
// 全量解析——这是手工作域链（只覆盖 Program/Function/Block）反复漏形态
// 的根治方案。
//
// 陷阱：ecmaVersion 必须传数字。字符串 "latest" 与 eslint-scope 内部数字
// 比较恒为 false，会静默退回 ES5 语义，let/const/for-of 头绑定全部不登记。
import * as acorn from "acorn";
import * as eslintScope from "eslint-scope";

export const ECMA_VERSION = 16;

export function parseScript(source) {
  return acorn.parse(source, { ecmaVersion: ECMA_VERSION, sourceType: "script", ranges: true });
}

function analyze(source) {
  return eslintScope.analyze(parseScript(source), {
    ecmaVersion: ECMA_VERSION,
    sourceType: "script",
    ignoreEval: true,
  });
}

// node -> parent 映射，用于 shorthand 属性判定
function buildParentMap(ast) {
  const parents = new Map();
  (function attach(node, parent) {
    if (!node || typeof node.type !== "string") return;
    parents.set(node, parent);
    for (const key of Object.keys(node)) {
      if (["loc", "range", "start", "end"].includes(key)) continue;
      const v = node[key];
      if (Array.isArray(v)) {
        for (const c of v) { if (c && typeof c.type === "string") attach(c, node); }
      } else if (v && typeof v.type === "string") {
        attach(v, node);
      }
    }
  })(ast, null);
  return parents;
}

function isShorthandIdentifier(parents, ident) {
  // acorn 的 shorthand 属性 key/value 是两个不同节点对象（同名同位置），
  // 引用发生在 value 位，只能按 value 判定；key===value 恒为 false。
  const p = parents.get(ident);
  return Boolean(p && p.type === "Property" && p.shorthand && p.value === ident);
}

/**
 * 返回 source 中所有「未解析引用」（在该代码文本内无任何词法绑定的标识符）。
 * 属性键、成员访问位、声明位置天然不是引用；对象 shorthand 值位是引用，
 * 以 shorthand 标记区分，改写时应展开为 `name: NS.name` 形态。
 *
 * @returns {Array<{name: string, start: number, end: number, shorthand: boolean}>}
 */
export function unresolvedRefs(source) {
  const sm = analyze(source);
  const parents = buildParentMap(sm.globalScope.block);
  const out = [];
  const seen = new Set();
  for (const ref of sm.globalScope.through) {
    const ident = ref.identifier;
    if (seen.has(ident.start)) continue;
    seen.add(ident.start);
    out.push({
      name: ident.name,
      start: ident.start,
      end: ident.end,
      shorthand: isShorthandIdentifier(parents, ident),
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * 幂等自检：改写后的文本重解析后，未解析引用 ∩ 导出面 必须为空。
 *
 * @returns {{ok: boolean, leftoverNames: string[]}}
 */
export function selfCheck(output, nameNs) {
  const leftover = unresolvedRefs(output)
    .filter((ref) => nameNs.has(ref.name))
    .map((ref) => ref.name);
  return { leftoverNames: [...new Set(leftover)], ok: leftover.length === 0 };
}
