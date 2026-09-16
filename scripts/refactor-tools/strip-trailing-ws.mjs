// 批量去除 web/ 下 JS 文件的行尾空白（保持 LF/编码不变）。
import fs from "node:fs";
import path from "node:path";
const webDir = "web";
let fixed = 0;
for (const f of fs.readdirSync(webDir)) {
  if (!f.endsWith(".js")) continue;
  const p = path.join(webDir, f);
  const src = fs.readFileSync(p, "utf8");
  if (!/[ \t]\n/.test(src)) continue;
  fs.writeFileSync(p, src.replace(/[ \t]+(?=\n)/g, ""), "utf8");
  fixed += 1;
}
console.log(`清理 ${fixed} 个文件的行尾空白`);
