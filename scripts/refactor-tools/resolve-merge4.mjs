// 第四轮 main 合并冲突解决矩阵（24 块）。
import fs from "node:fs";
const lines = fs.readFileSync("web/editor.js", "utf8").split("\n");
// 形态判定：
// - ours 为空 & theirs 是 main 新增特性 → theirs（新功能代码留在入口）
// - 双方非空 → theirs（main 演进权威，后续 ns-rewrite 统一 NS 化）
// - 例外：块9 双方各有浮层注册内容 → 两者合并（ours + theirs 去重）
const take = {};
for (let i = 1; i <= 24; i++) take[i] = "theirs";
take[9] = "both";

let i = 0, h = 0;
const out = [];
while (i < lines.length) {
  if (lines[i].startsWith("<<<<<<<")) {
    h += 1;
    let mid = -1, end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j] === "=======") mid = j;
      if (lines[j].startsWith(">>>>>>>")) { end = j; break; }
    }
    const side = take[h] || "theirs";
    if (side === "ours") out.push(...lines.slice(i + 1, mid));
    else if (side === "theirs") out.push(...lines.slice(mid + 1, end));
    else out.push(...lines.slice(i + 1, mid), ...lines.slice(mid + 1, end));
    i = end + 1;
  } else {
    out.push(lines[i]);
    i += 1;
  }
}
fs.writeFileSync("web/editor.js", out.join("\n"), "utf8");
console.log(`解决 ${h} 块 → ${out.length} 行`);
