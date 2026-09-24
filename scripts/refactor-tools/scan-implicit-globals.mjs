// 扫描各 editor-*.js 模块中「赋值给本文件未声明的裸标识符」的隐式全局写。
// 严格模式 IIFE 下这些会抛 ReferenceError（重构前 sloppy 模式静默创建 window 属性）。
import fs from "node:fs";
import path from "node:path";
import * as acorn from "acorn";

const WEB = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..", "web");
const files = fs.readdirSync(WEB).filter((f) => f.startsWith("editor") && f.endsWith(".js"));

// 全局已知名集合：所有模块的导出名（跨模块裸写也算嫌疑，单独标注）
const exported = new Map(); // name -> ns
for (const f of files) {
  const text = fs.readFileSync(path.join(WEB, f), "utf8");
  const m = text.match(/global\.(\w+) = Object\.freeze\(\{([\s\S]*?)\n  \}\);/);
  if (!m) continue;
  for (const line of m[2].split("\n")) {
    const name = line.match(/^\s{4}(\w+),?\s*$/)?.[1] ?? line.match(/^\s{4}get (\w+)\(/)?.[1];
    if (name) exported.set(name, m[1]);
  }
}

for (const f of files) {
  const text = fs.readFileSync(path.join(WEB, f), "utf8");
  let ast;
  try {
    ast = acorn.parse(text, { ecmaVersion: "latest" });
  } catch (e) {
    console.log(`${f}: 解析失败 ${e.message}`);
    continue;
  }
  // 声明名集合（含参数）——粗粒度：任何层级
  const declared = new Set();
  const stack = [ast];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (Array.isArray(node)) { stack.push(...node); continue; }
    if (typeof node.type !== "string") continue;
    if (node.type === "VariableDeclaration") {
      for (const d of node.declarations) collectPattern(d.id, declared);
    } else if ((node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") && node.id) {
      declared.add(node.id.name);
    }
    for (const key of Object.keys(node)) {
      if (["loc", "range", "start", "end"].includes(key)) continue;
      const v = node[key];
      if (Array.isArray(v) || (v && typeof v === "object" && typeof v.type === "string")) stack.push(v);
    }
  }
  // 裸赋值左侧
  const suspects = new Map();
  const walk2 = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk2); return; }
    if (typeof node.type !== "string") return;
    if (node.type === "AssignmentExpression" && node.left.type === "Identifier"
      && ["=", "+=", "-=", "*=", "/="].includes(node.operator)) {
      const name = node.left.name;
      if (!declared.has(name) && !suspects.has(name)) {
        suspects.set(name, node.start);
      }
    }
    for (const key of Object.keys(node)) {
      if (["loc", "range", "start", "end"].includes(key)) continue;
      const v = node[key];
      if (Array.isArray(v) || (v && typeof v === "object" && typeof v.type === "string")) walk2(v);
    }
  };
  walk2(ast);
  if (suspects.size) {
    for (const [name, pos] of suspects) {
      const line = text.slice(0, pos).split("\n").length;
      const note = exported.has(name) ? `  ⚠ 与导出名 ${exported.get(name)}.${name} 同名` : "";
      console.log(`${f}:${line}  裸赋值 -> ${name}${note}`);
    }
  }
}
function collectPattern(n, out) {
  if (!n) return;
  if (n.type === "Identifier") { out.add(n.name); return; }
  const stack = [n];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (Array.isArray(cur)) { stack.push(...cur); continue; }
    if (typeof cur.type !== "string") continue;
    if (cur.type === "Identifier") { out.add(cur.name); continue; }
    for (const key of Object.keys(cur)) {
      if (["loc", "range", "start", "end"].includes(key)) continue;
      const v = cur[key];
      if (Array.isArray(v) || (v && typeof v === "object" && typeof v.type === "string")) stack.push(v);
    }
  }
}
