// 从 fork 模块生成 symbols 版 spec：node gen-symbols-spec.mjs <fork模块文件> <目标文件名> <头注释>
import { readFileSync, writeFileSync } from "node:fs";
import { Project } from "ts-morph";

const forkFile = process.argv[2];
const targetFile = process.argv[3];
const header = process.argv[4];
const src = readFileSync(forkFile, "utf8");
const project = new Project({ compilerOptions: { allowJs: true } });
const sf = project.createSourceFile("fork.js", src, { overwrite: true });

const names = [];
let ns = null;
for (const stmt of sf.getStatements()) {
  let body = null;
  if (stmt.getKindName() === "ExpressionStatement") {
    let fn = stmt.getExpression()?.getExpression?.();
    while (fn && fn.getKindName() === "ParenthesizedExpression") fn = fn.getExpression();
    if (fn && (fn.getKindName() === "FunctionExpression" || fn.getKindName() === "ArrowFunction")) {
      body = fn.getBody();
      const m = stmt.getText().match(/global\.(\w+) = Object\.freeze/);
      if (m) ns = m[1];
    }
  }
  for (const s of body ? body.getStatements() : [stmt]) {
    if (s.getKindName() === "FunctionDeclaration" || s.getKindName() === "ClassDeclaration") {
      if (s.getName()) names.push(s.getName());
    } else if (s.getKindName() === "VariableStatement") {
      for (const d of s.getDeclarations()) names.push(d.getName());
    }
  }
}
if (!ns) throw new Error("未找到命名空间导出");
const spec = { file: targetFile, ns, header, symbols: names };
writeFileSync(process.argv[5], JSON.stringify(spec, null, 2) + "\n", "utf8");
console.log(`${targetFile} [${ns}]: ${names.length} 符号`);
