// 最小复现 ns-rewrite 的 start 误替换：直接用工具逻辑跑重放后的函数。
import fs from "node:fs";
import * as acorn from "acorn";
import * as walk from "acorn-walk";

// === 完整复刻 ns-rewrite-editor.mjs 的作用域逻辑 ===
function patternNames(n, scope) {
  if (!n) return;
  if (n.type === "Identifier") { scope.add(n.name); return; }
  if (n.type === "AssignmentPattern") { patternNames(n.left, scope); return; }
  if (n.type === "RestElement") { patternNames(n.argument, scope); return; }
  walk.full(n, (child, _state, type) => {
    if (type === "Identifier") scope.add(child.name);
  });
}
function collectScopeBindings(stmts, scope) {
  for (const n of stmts) {
    if (n.type === "VariableDeclaration") {
      for (const d of n.declarations) patternNames(d.id, scope);
    } else if ((n.type === "FunctionDeclaration" || n.type === "ClassDeclaration") && n.id) {
      scope.add(n.id.name);
    }
  }
}
function attachParent(node, parent) {
  if (!node || typeof node.type !== "string") return;
  node._parent = parent;
  for (const key of Object.keys(node)) {
    if (["loc", "range", "start", "end", "_parent"].includes(key)) continue;
    const v = node[key];
    if (Array.isArray(v)) { for (const c of v) { if (c && typeof c.type === "string") attachParent(c, node); } }
    else if (v && typeof v.type === "string") attachParent(v, node);
  }
}

// 重放后的函数文本（从 499b0900 提取）
const src = fs.readFileSync(process.env.TEMP + "/replayed-fn.txt", "utf8");
const ast = acorn.parse(src, { ecmaVersion: "latest" });
attachParent(ast, null);

const edits = [];
function visit(node, scope) {
  if (!node || typeof node.type !== "string") return;
  switch (node.type) {
    case "Program": {
      const s = new Set(scope);
      collectScopeBindings(node.body, s);
      for (const stmt of node.body) visit(stmt, s);
      return;
    }
    case "FunctionDeclaration": {
      const s = new Set(scope);
      if (node.id) s.add(node.id.name);
      for (const p of node.params ?? []) patternNames(p, s);
      if (node.body) {
        collectScopeBindings(node.body.type === "BlockStatement" ? node.body.body : [], s);
        visit(node.body, s);
      }
      return;
    }
    case "BlockStatement": {
      const s = new Set(scope);
      collectScopeBindings(node.body, s);
      for (const stmt of node.body) visit(stmt, s);
      return;
    }
    case "Identifier": {
      const parent = node._parent;
      const isPropKey = parent && ((parent.type === "Property" && parent.key === node && !parent.computed && !parent.shorthand)
        || (parent.type === "MemberExpression" && parent.property === node && !parent.computed));
      const isDeclPos = parent && ((parent.type === "VariableDeclarator" && parent.id === node)
        || (parent.type === "FunctionDeclaration" && parent.id === node)
        || ((parent.type === "FunctionDeclaration" || parent.type === "FunctionExpression" || parent.type === "ArrowFunctionExpression") && (parent.params ?? []).includes(node))
        || (parent.type === "CatchClause" && parent.param === node)
        || (parent.type === "AssignmentPattern" && parent.left === node));
      if (!isPropKey && !isDeclPos && node.name === "start" && !scope.has(node.name)) {
        edits.push({ line: src.slice(0, node.start).split("\n").length, ctx: src.slice(Math.max(0, node.start - 30), node.start + 15) });
      }
      return;
    }
    default: {
      for (const key of Object.keys(node)) {
        if (["loc", "range", "start", "end", "_parent"].includes(key)) continue;
        const v = node[key];
        if (Array.isArray(v)) { for (const c of v) { if (c && typeof c.type === "string") visit(c, scope); } }
        else if (v && typeof v.type === "string") visit(v, scope);
      }
    }
  }
}
visit(ast, new Set());
console.log("误判 start 为全局的位置:", edits.length);
edits.slice(0, 5).forEach((e) => console.log(`  L${e.line}: [${e.ctx.replace(/\n/g, " ")}]`));
