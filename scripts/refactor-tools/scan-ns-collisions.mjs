// 扫描 NS.name 误替换残留：同一函数作用域内既有 NS.name 引用又有同名局部声明/赋值。
import fs from "node:fs";
import path from "node:path";
import * as acorn from "acorn";
import * as walk from "acorn-walk";
import { editorScriptFiles } from "./editor-sources.mjs";

function patternNames(n, out) {
  if (!n) return;
  if (n.type === "Identifier") { out.add(n.name); return; }
  walk.full(n, (c) => { if (c.type === "Identifier") out.add(c.name); });
}
const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : editorScriptFiles("web");
let issues = 0;
for (const f of files) {
  const src = fs.readFileSync(path.join("web", f), "utf8");
  let ast;
  try { ast = acorn.parse(src, { ecmaVersion: "latest" }); } catch { continue; }
  // 遍历每个函数，检查 NS.name 引用中 name 是否与该函数局部绑定同名
  const check = (fnNode, label) => {
    const locals = new Set();
    walk.full(fnNode, (n) => {
      if (n.type === "VariableDeclarator") patternNames(n.id, locals);
      else if ((n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression") && n.id) locals.add(n.id.name);
      else if (n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression") for (const p of n.params ?? []) patternNames(p, locals);
    });
    walk.full(fnNode, (n) => {
      if (n.type !== "MemberExpression" || n.computed) return;
      if (n.object?.type !== "Identifier" || !/^Mawe[A-Z]/.test(n.object.name)) return;
      if (n.property?.type === "Identifier" && locals.has(n.property.name)) {
        const line = src.slice(0, n.start).split("\n").length;
        console.log(`${f}:${line} 可疑 ${n.object.name}.${n.property.name}（局部有同名绑定 ${n.property.name}）[${label}]`);
        issues += 1;
      }
    });
  };
  walk.full(ast, (n) => {
    if (n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression") check(n, "fn");
  });
}
console.log(issues ? `共 ${issues} 处可疑` : "无残留");
