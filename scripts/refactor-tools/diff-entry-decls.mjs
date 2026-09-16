// 对比：main 无所有者声明 vs 当前入口实际声明。
import fs from "node:fs";
import path from "node:path";
import * as acorn from "acorn";

const WEB = path.resolve("web");
const mainSrc = fs.readFileSync(path.join(process.env.TEMP, "main-editor3.js"), "utf8");
const entrySrc = fs.readFileSync(path.join(WEB, "editor.js"), "utf8");

function declNames(src) {
  const ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "script" });
  const names = new Set();
  function patternNames(p) {
    if (!p) return;
    if (p.type === "Identifier") names.add(p.name);
    else for (const v of Object.values(p)) {
      if (Array.isArray(v)) v.forEach(patternNames);
      else if (v && typeof v.type === "string") patternNames(v);
    }
  }
  for (const st of ast.body) {
    if ((st.type === "FunctionDeclaration" || st.type === "ClassDeclaration") && st.id) names.add(st.id.name);
    else if (st.type === "VariableDeclaration") for (const d of st.declarations) patternNames(d.id);
  }
  return names;
}
const mainNames = [...declNames(mainSrc)];
const entryNames = declNames(entrySrc);
const missing = mainNames.filter((n) => !entryNames.has(n) && !/^Mawe/.test(n));
console.log(`main 声明 ${mainNames.length}，入口声明 ${entryNames.size}，main 有而入口没有 ${missing.length}`);
// 模块门面里有但入口没有 → 正常（已迁移）；两者都没有 → 丢失
const corpus = fs.readdirSync(WEB).filter((f) => f.endsWith(".js")).map((f) => fs.readFileSync(path.join(WEB, f), "utf8")).join("\n");
const lost = missing.filter((n) => !new RegExp(`\\b${n}\\b`).test(corpus));
console.log(`其中全树彻底丢失 ${lost.length}:`);
lost.forEach((n) => console.log(" -", n));
