// 作用域感知的 NS 改写：editor.js 中裸引用的已迁移符号 → NS.name。
// acorn 解析 + 手工作域链（函数/块级 let/const/var/参数/类名）。
// 用法: node scripts/refactor-tools/ns-rewrite-editor.mjs
import fs from "node:fs";
import path from "node:path";
import * as acorn from "acorn";
import * as walk from "acorn-walk";

const root = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..");
const webDir = path.join(root, "web");

// ---- 导出表: name -> ns ----
const nameNs = new Map();
for (const f of fs.readdirSync(webDir)) {
  if (!f.startsWith("editor-") || !f.endsWith(".js") || f === "editor.js") continue;
  const text = fs.readFileSync(path.join(webDir, f), "utf8");
  const m = text.match(/global\.(\w+) = Object\.freeze\(\{([\s\S]*?)\n  \}\);/);
  if (!m) continue;
  const ns = m[1];
  for (const line of m[2].split("\n")) {
    let name = line.match(/^\s{4}(\w+),?\s*$/)?.[1];
    if (!name) name = line.match(/^\s{4}get (\w+)\(/)?.[1];
    if (!name) name = line.match(/^\s{4}set (\w+)\(/)?.[1];
    if (name) nameNs.set(name, ns);
  }
}
console.log(`导出符号 ${nameNs.size} 个`);

const editorPath = path.join(webDir, "editor.js");
const source = fs.readFileSync(editorPath, "utf8");
const ast = acorn.parse(source, { ecmaVersion: "latest" });

const edits = [];

function patternNames(n, scope) {
  if (!n) return;
  if (n.type === "Identifier") { scope.add(n.name); return; }
  // 只收集绑定位置；默认值表达式是引用而非绑定，必须排除，
  // 否则 `kind = currentCuePanelKind` 这类参数默认值会被误当绑定而漏改写。
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

// 双遍历：先给所有节点挂 _parent，再作用域遍历
(function attachParent(node, parent) {
  if (!node || typeof node.type !== "string") return;
  node._parent = parent;
  for (const key of Object.keys(node)) {
    if (["loc", "range", "start", "end", "_parent"].includes(key)) continue;
    const v = node[key];
    if (Array.isArray(v)) {
      for (const c of v) { if (c && typeof c.type === "string") attachParent(c, node); }
    } else if (v && typeof v.type === "string") {
      attachParent(v, node);
    }
  }
})(ast, null);

function visit(node, scope) {
  if (!node || typeof node.type !== "string") return;
  switch (node.type) {
    case "Program": {
      const s = new Set(scope);
      collectScopeBindings(node.body, s);
      for (const stmt of node.body) visit(stmt, s);
      return;
    }
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression": {
      const s = new Set(scope);
      if (node.id) s.add(node.id.name);
      for (const p of node.params ?? []) {
        patternNames(p, s);
        // 默认值表达式是运行时引用，必须继续遍历改写（解构绑定名已在作用域内）。
        if (p.type !== "Identifier") visit(p, s);
      }
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
      const isShorthand = parent && parent.type === "Property" && parent.shorthand
        && parent.key === node && parent.value === node;
      const isPropKey = parent && ((parent.type === "Property" && parent.key === node && !parent.computed && !parent.shorthand)
        || (parent.type === "MemberExpression" && parent.property === node && !parent.computed));
      const isDeclPos = parent && ((parent.type === "VariableDeclarator" && parent.id === node)
        || (parent.type === "FunctionDeclaration" && parent.id === node)
        || ((parent.type === "FunctionDeclaration" || parent.type === "FunctionExpression" || parent.type === "ArrowFunctionExpression") && (parent.params ?? []).includes(node))
        || (parent.type === "CatchClause" && parent.param === node)
        || (parent.type === "AssignmentPattern" && parent.left === node));
      if (!isPropKey && !isDeclPos && nameNs.has(node.name) && !scope.has(node.name)) {
        edits.push({
          start: node.start, end: node.end, name: node.name, ns: nameNs.get(node.name),
          shorthand: Boolean(isShorthand),
        });
      }
      return;
    }
    default: {
      for (const key of Object.keys(node)) {
        if (["loc", "range", "start", "end", "_parent"].includes(key)) continue;
        const v = node[key];
        if (Array.isArray(v)) {
          for (const c of v) { if (c && typeof c.type === "string") visit(c, scope); }
        } else if (v && typeof v.type === "string") {
          visit(v, scope);
        }
      }
    }
  }
}
visit(ast, new Set());

finalSort: {
  edits.sort((a, b) => b.start - a.start);
}
let out = source;
let count = 0;
for (const e of edits) {
  const replacement = e.shorthand ? `${e.name}: ${e.ns}.${e.name}` : `${e.ns}.${e.name}`;
  out = out.slice(0, e.start) + replacement + out.slice(e.end);
  count += 1;
}
fs.writeFileSync(editorPath, out, "utf8");
console.log(`改写 ${count} 处`);
const byName = new Map();
for (const e of edits) byName.set(e.name, (byName.get(e.name) || 0) + 1);
console.log([...byName.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}:${c}`).join("  "));
