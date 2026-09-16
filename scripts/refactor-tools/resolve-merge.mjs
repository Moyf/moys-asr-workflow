// 解决合并冲突：按块序号取侧（ours/theirs）。
import fs from "node:fs";
const lines = fs.readFileSync("web/editor.js", "utf8").split("\n");
// 矩阵：1 ours, 2 ours, 3 ours, 4 ours, 5 theirs, 6 theirs, 7 ours, 8 ours,
// 9 ours, 10 theirs, 11 theirs, 12 theirs, 13 theirs, 14 theirs, 15 theirs,
// 16 ours, 17 ours, 18 ours, 19 ours, 20 ours, 21 ours, 22 theirs, 23 ours,
// 24 theirs, 25 ours, 26 ours, 27 ours, 28 theirs
const take = {
  1: "ours", 2: "ours", 3: "ours", 4: "ours", 5: "theirs", 6: "theirs",
  7: "ours", 8: "ours", 9: "ours", 10: "theirs", 11: "theirs", 12: "theirs",
  13: "theirs", 14: "theirs", 15: "theirs", 16: "ours", 17: "ours",
  18: "ours", 19: "ours", 20: "ours", 21: "ours", 22: "theirs", 23: "ours",
  24: "theirs", 25: "ours", 26: "ours", 27: "ours", 28: "theirs",
};
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
    const side = take[h] || "ours";
    if (side === "ours") out.push(...lines.slice(i + 1, mid));
    else out.push(...lines.slice(mid + 1, end));
    i = end + 1;
  } else {
    out.push(lines[i]);
    i += 1;
  }
}
fs.writeFileSync("web/editor.js", out.join("\n"), "utf8");
console.log(`解决 ${h} 块 → ${out.length} 行`);
