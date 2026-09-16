// 复现 ns-rewrite 漏洞：对当前 editor.js 跑工具逻辑，打印它想替换 start/snapshotSegments 的位置。
import fs from "node:fs";
import * as acorn from "acorn";
import * as walk from "acorn-walk";

// 导出表（与工具一致）
const nameNs = new Map();
for (const f of fs.readdirSync("web")) {
  if (!f.startsWith("editor-") || f === "editor.js" || !f.endsWith(".js")) continue;
  const text = fs.readFileSync("web/" + f, "utf8");
  const m = text.match(/global\.(\w+) = Object\.freeze\(\{([\s\S]*?)\n  \}\);/);
  if (!m) continue;
  for (const line of m[2].split("\n")) {
    let name = line.match(/^\s{4}(\w+),?\s*$/)?.[1];
    if (!name) name = line.match(/^\s{4}get (\w+)\(/)?.[1];
    if (!name) name = line.match(/^\s{4}set (\w+)\(/)?.[1];
    if (name) nameNs.set(name, m[1]);
  }
}
console.log("start 的 ns:", nameNs.get("start"), "| snapshotSegments 的 ns:", nameNs.get("snapshotSegments"));

const source = fs.readFileSync("web/editor.js", "utf8");
const ast = acorn.parse(source, { ecmaVersion: "latest" });

function patternNames(n, scope) {
  if (!n) return;
  if (n.type === "Identifier") { scope.add(n.name); return; }
  if (n.type === "AssignmentPattern") { patternNames(n.left, scope); return; }
  if (n.type === "RestElement") { patternNames(n.argument, scope); return; }
  walk.full(n, (child) => { if (child.type === "Identifier") scope.add(child.name); });
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
(function attachParent(node, parent) {
  if (!node || typeof node.type !== "string") return;
  node._parent = parent;
  for (const key of Object.keys(node)) {
    if (["loc", "range", "start", "end", "_parent"].includes(key)) continue;
    const v = node[key];
    if (Array.isArray(v)) { for (const c of v) { if (c && typeof c.type === "string") attachParent(c, node); } }
    else if (v && typeof v.type === "string") attachParent(v, node);
  }
})(ast, null);

const hits = [];
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
      if ((node.name === "start" || node.name === "snapshotSegments") && !scope.has(node.name)) {
        hits.push({ name: node.name, line: source.slice(0, node.start).split("\n").length, scopeSize: scope.size, ctx: source.slice(Math.max(0, node.start - 40), node.start + 20).replace(/\n/g, " ") });
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
console.log("工具视角的待替换位置:", hits.length);
hits.slice(0, 8).forEach((h) => console.log(`  L${h.line} [${h.ctx}] scope含=${h.scopeSize}项`));
