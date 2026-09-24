// 临时分析脚本：列出指定文件的顶层声明名（IIFE 内部一层也算顶层）。
// 用法: node scripts/refactor-tools/list-top-level.mjs web/editor-hint.js
import { readFileSync } from "node:fs";
import { Project } from "ts-morph";

const file = process.argv[2];
const project = new Project({ compilerOptions: { allowJs: true } });
const sf = project.createSourceFile(file, readFileSync(file, "utf8"), { overwrite: true });

const out = [];
for (const stmt of sf.getStatements()) {
  if (stmt.getKindName() === "ExpressionStatement") {
    // IIFE：进入其函数体第一层
    const expr = stmt.getExpression();
    let fn = expr?.getExpression?.();
    while (fn && fn.getKindName() === "ParenthesizedExpression") fn = fn.getExpression();
    if (fn && (fn.getKindName() === "FunctionExpression" || fn.getKindName() === "ArrowFunction")) {
      for (const s2 of fn.getBody().getStatements()) {
        emit(s2, out);
      }
      continue;
    }
  }
  emit(stmt, out);
}
function emit(stmt, out) {
  const line = sf.getLineAndColumnAtPos(stmt.getStart()).line;
  if (stmt.getKindName() === "FunctionDeclaration") {
    out.push([line, stmt.getName() || "(anon)"]);
  } else if (stmt.getKindName() === "ClassDeclaration") {
    out.push([line, stmt.getName() || "(anon)"]);
  } else if (stmt.getKindName() === "VariableStatement") {
    for (const d of stmt.getDeclarations()) {
      out.push([line, d.getName(), stmt.getDeclarationList().getDeclarationKind()]);
    }
  }
}
for (const [line, name, kind] of out.sort((a, b) => a[0] - b[0])) {
  console.log(`${String(line).padStart(6)}  ${kind ? kind.padEnd(5) + " " : "      "}${name}`);
}
console.log(`-- 共 ${out.length} 个顶层声明`);
