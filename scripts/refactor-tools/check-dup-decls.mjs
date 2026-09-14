// 找出 editor.js 与各模块 facade 重复导出的同名顶层声明。
import fs from "node:fs";
import path from "node:path";
import * as acorn from "acorn";

const webDir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..", "web");
const editorSrc = fs.readFileSync(path.join(webDir, "editor.js"), "utf8");
const ast = acorn.parse(editorSrc, { ecmaVersion: "latest" });
const editorNames = new Set();
for (const st of ast.body) {
  if (st.type === "FunctionDeclaration" && st.id) editorNames.add(st.id.name);
  else if (st.type === "VariableDeclaration") {
    for (const d of st.declarations) if (d.id.type === "Identifier") editorNames.add(d.id.name);
  }
}

const dups = [];
for (const f of fs.readdirSync(webDir)) {
  if (!f.startsWith("editor-") || f === "editor.js" || !f.endsWith(".js")) continue;
  const text = fs.readFileSync(path.join(webDir, f), "utf8");
  const m = text.match(/global\.(\w+) = Object\.freeze\(\{([\s\S]*?)\n  \}\);/);
  if (!m) continue;
  for (const line of m[2].split("\n")) {
    const name = line.match(/^\s{4}(\w+),?\s*$/)?.[1] ?? line.match(/^\s{4}get (\w+)\(/)?.[1] ?? line.match(/^\s{4}set (\w+)\(/)?.[1];
    if (name && editorNames.has(name)) dups.push(`${name}  (editor.js + ${f})`);
  }
}
console.log(`重复声明 ${dups.length} 个`);
dups.forEach((d) => console.log(" -", d));
