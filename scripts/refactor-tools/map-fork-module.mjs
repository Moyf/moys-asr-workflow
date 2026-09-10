// 把 fork 模块的顶层符号映射到本仓 editor.js 的行号，输出连续区间建议。
// 用法: node scripts/refactor-tools/map-fork-module.mjs <fork模块文件>
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { Project } from "ts-morph";

const forkFile = process.argv[2];
const src = readFileSync(forkFile, "utf8");
const project = new Project({ compilerOptions: { allowJs: true } });

// fork 模块符号集
const sf = project.createSourceFile("fork.js", src, { overwrite: true });
const names = [];
for (const stmt of sf.getStatements()) {
  let body = null;
  if (stmt.getKindName() === "ExpressionStatement") {
    let fn = stmt.getExpression()?.getExpression?.();
    while (fn && fn.getKindName() === "ParenthesizedExpression") fn = fn.getExpression();
    if (fn && (fn.getKindName() === "FunctionExpression" || fn.getKindName() === "ArrowFunction")) {
      body = fn.getBody();
    }
  }
  const targets = body ? body.getStatements() : [stmt];
  for (const s of targets) {
    if (s.getKindName() === "FunctionDeclaration" || s.getKindName() === "ClassDeclaration") {
      if (s.getName()) names.push(s.getName());
    } else if (s.getKindName() === "VariableStatement") {
      for (const d of s.getDeclarations()) names.push(d.getName());
    }
  }
}

// 本仓 editor.js 符号表（读工作区当前内容，含未提交改动）
import { dirname, join } from "node:path";
const editorPath = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..", "web", "editor.js");
const editorText = readFileSync(editorPath, "utf8");
const esf = project.createSourceFile("editor.js", editorText, { overwrite: true });
const hits = []; // {line, name}
for (const stmt of esf.getStatements()) {
  const line = esf.getLineAndColumnAtPos(stmt.getStart()).line;
  if (stmt.getKindName() === "FunctionDeclaration" || stmt.getKindName() === "ClassDeclaration") {
    const n = stmt.getName();
    if (n && names.includes(n)) hits.push({ line, name: n });
  } else if (stmt.getKindName() === "VariableStatement") {
    for (const d of stmt.getDeclarations()) {
      const n = d.getName();
      if (names.includes(n)) hits.push({ line, name: n });
    }
  }
}
hits.sort((a, b) => a.line - b.line);
const found = new Set(hits.map((h) => h.name));
const missing = names.filter((n) => !found.has(n));
console.log(`fork 模块 ${names.length} 符号，命中 ${hits.length}，缺失 ${missing.length}`);
if (missing.length) console.log("缺失:", missing.join(", "));
let start = null, prev = null, group = [];
for (const h of hits) {
  if (start === null) { start = h.line; group = [h.name]; }
  else if (h.line - prev <= 6) { group.push(h.name); }
  else { console.log(`range [${start}, ${prev}]  ${group.length} 符号: ${group.slice(0, 6).join(", ")}${group.length > 6 ? " …" : ""}`); start = h.line; group = [h.name]; }
  prev = h.line;
}
if (start !== null) console.log(`range [${start}, ${prev}]  ${group.length} 符号: ${group.slice(0, 6).join(", ")}${group.length > 6 ? " …" : ""}`);
