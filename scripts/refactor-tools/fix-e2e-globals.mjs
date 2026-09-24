// e2e spec 全局符号改写：编辑器拆分后，tests/e2e 里 page.evaluate 引用的
// 顶层符号（DATA / renderAll / waveformEditor / …）已迁入各 IIFE 模块的
// 冻结命名空间。本脚本按模块导出表把 spec 代码里的裸标识符改写为
// NS.name。只处理代码上下文（跳过字符串、属性名、spec 自身声明/导入）。
// 用法: node docs/temp/fix-e2e-globals.mjs  （幂等，可重复运行）

import fs from "node:fs";
import path from "node:path";
import * as acorn from "acorn";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..");
const WEB = path.join(ROOT, "web");
const E2E = path.join(ROOT, "tests", "e2e");

// ---- 1. 模块导出表: name -> ns ----
const nameNs = new Map();
for (const f of fs.readdirSync(WEB)) {
  if (!f.startsWith("editor-") || !f.endsWith(".js")) continue;
  const text = fs.readFileSync(path.join(WEB, f), "utf8");
  const m = text.match(/global\.(\w+) = Object\.freeze\(\{([\s\S]*?)\n  \}\);/);
  if (!m) continue;
  const ns = m[1];
  for (const line of m[2].split("\n")) {
    let name = line.match(/^\s{4}(\w+),?\s*$/)?.[1];
    if (!name) name = line.match(/^\s{4}get (\w+)\(/)?.[1];
    if (name) nameNs.set(name, ns);
  }
}
console.log(`模块导出符号 ${nameNs.size} 个`);

// ---- 2. 改写每个 spec/helpers 文件 ----
const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

function collectBindings(root) {
  // 文件内所有本地绑定名（声明/参数/导入），这些名字不改写
  const names = new Set();
  const visitNode = (node) => {
    if (!node || typeof node.type !== "string") return;
    switch (node.type) {
      case "VariableDeclaration":
        for (const d of node.declarations) patternNames(d.id, names);
        break;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        if (node.id) names.add(node.id.name);
        for (const p of node.params ?? []) patternNames(p, names);
        break;
      case "ClassDeclaration":
      case "ClassExpression":
        if (node.id) names.add(node.id.name);
        break;
      case "CatchClause":
        if (node.param) patternNames(node.param, names);
        break;
    }
  };
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (Array.isArray(node)) { stack.push(...node); continue; }
    if (typeof node.type !== "string") continue;
    visitNode(node);
    for (const key of Object.keys(node)) {
      if (["loc", "range", "start", "end"].includes(key)) continue;
      const v = node[key];
      if (Array.isArray(v) || (v && typeof v === "object" && typeof v.type === "string")) stack.push(v);
    }
  }
  function patternNames(n, out) {
    if (!n) return;
    if (n.type === "Identifier") { out.add(n.name); return; }
    const stack2 = [n];
    while (stack2.length) {
      const cur = stack2.pop();
      if (!cur || typeof cur !== "object") continue;
      if (Array.isArray(cur)) { stack2.push(...cur); continue; }
      if (typeof cur.type !== "string") continue;
      if (cur.type === "Identifier") { out.add(cur.name); continue; }
      for (const key of Object.keys(cur)) {
        if (["loc", "range", "start", "end"].includes(key)) continue;
        const v = cur[key];
        if (Array.isArray(v) || (v && typeof v === "object" && typeof v.type === "string")) stack2.push(v);
      }
    }
  }
  return names;
}

function isReferenceContext(node, parent) {
  if (!parent) return false;
  if (parent.type === "MemberExpression" && parent.property === node && !parent.computed) return false;
  if ((parent.type === "Property" || parent.type === "PropertyDefinition")
    && parent.key === node && !parent.computed && !parent.shorthand) return false;
  if (parent.type === "VariableDeclarator" && parent.id === node) return false;
  if (FUNCTION_TYPES.has(parent.type) && parent.id === node) return false;
  if ((parent.type === "ClassDeclaration" || parent.type === "ClassExpression") && parent.id === node) return false;
  if (parent.type === "CatchClause" && parent.param === node) return false;
  if (parent.type === "ObjectPattern" || parent.type === "ArrayPattern" || parent.type === "RestElement") return false;
  if (parent.type === "AssignmentPattern" && parent.left === node) return false;
  if (parent.type === "LabeledStatement" || parent.type === "BreakStatement" || parent.type === "ContinueStatement") return false;
  return true;
}

let grandTotal = 0;
for (const file of [...fs.readdirSync(E2E).map((f) => path.join(E2E, f))]) {
  if (!file.endsWith(".spec.mjs") && !file.endsWith(".mjs")) continue;
  const source = fs.readFileSync(file, "utf8");
  let ast;
  try {
    ast = acorn.parse(source, { ecmaVersion: "latest", sourceType: "module" });
  } catch (e) {
    console.warn(`[跳过] ${path.basename(file)} 解析失败: ${e.message}`);
    continue;
  }
  const localBindings = collectBindings(ast);
  const edits = [];
  (function visit(node, parent) {
    if (!node || typeof node.type !== "string") return;
    if (node.type === "Identifier") {
      const ns = nameNs.get(node.name);
      if (ns && isReferenceContext(node, parent) && !localBindings.has(node.name)) {
        edits.push({ start: node.start, end: node.end, text: `${ns}.${node.name}` });
      }
    }
    for (const key of Object.keys(node)) {
      if (["loc", "range", "start", "end"].includes(key)) continue;
      const v = node[key];
      if (Array.isArray(v)) {
        for (const c of v) if (c && typeof c.type === "string") visit(c, node);
      } else if (v && typeof v === "object" && typeof v.type === "string") {
        visit(v, node);
      }
    }
  })(ast, null);

  if (!edits.length) continue;
  edits.sort((a, b) => b.start - a.start);
  let out = source;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  fs.writeFileSync(file, out, "utf8");
  grandTotal += edits.length;
  console.log(`${path.basename(file)}: 改写 ${edits.length} 处`);
}
console.log(`合计改写 ${grandTotal} 处`);
