// 打印 main 对 editor.js 的 diff 概要（按函数分组）。
import fs from "node:fs";
import path from "node:path";
const d = fs.readFileSync(path.join(process.env.TEMP, "main-editor.diff"), "utf8").split("\n");
let fn = "";
for (let i = 0; i < d.length; i++) {
  if (d[i].startsWith("@@")) {
    fn = d[i].replace(/^@@ [^ ]+ \+[^ ]+ @@\s*/, "").slice(0, 58);
    console.log("== " + fn);
    continue;
  }
  if (d[i].startsWith("+") && !d[i].startsWith("+++")) console.log("  + " + d[i].slice(1, 96).trim());
  if (d[i].startsWith("-") && !d[i].startsWith("---")) console.log("  - " + d[i].slice(1, 96).trim());
}
