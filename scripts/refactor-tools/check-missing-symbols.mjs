// 枚举 origin/main editor.js 的顶层函数/声明，检查本仓 web/ 树中是否都有承载。
import fs from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import * as acorn from "acorn";

const mainSrc = execSync("git show origin/main:web/editor.js", { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const mainAst = acorn.parse(mainSrc, { ecmaVersion: "latest" });
const names = [];
for (const st of mainAst.body) {
  if (st.type === "FunctionDeclaration" && st.id) names.push(st.id.name);
  else if (st.type === "VariableDeclaration") {
    for (const d of st.declarations) {
      if (d.id.type === "Identifier") names.push(d.id.name);
      else d.id.names?.length; // 解构忽略
    }
  }
}

// 本仓 web/ 全文语料
const webDir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..", "web");
const corpus = fs.readdirSync(webDir).filter((f) => f.endsWith(".js"))
  .map((f) => fs.readFileSync(path.join(webDir, f), "utf8")).join("\n");

const missing = names.filter((n) => !new RegExp(`\\b${n}\\b`).test(corpus));
console.log(`main 顶层声明 ${names.length} 个，本仓缺失 ${missing.length} 个`);
missing.forEach((n) => console.log(" -", n));
