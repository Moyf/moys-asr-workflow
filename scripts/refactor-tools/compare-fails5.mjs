// 同名失败逐项比对 final5 vs maincheck5。
import fs from "node:fs";
const t = process.env.TEMP;
const ours = fs.readFileSync(t + "/final5-fails.txt", "utf8").split("\n").filter(Boolean).sort();
const main = fs.readFileSync(t + "/maincheck5-fails.txt", "utf8").split("\n").filter(Boolean).sort();
const onlyOurs = ours.filter((x) => !main.includes(x));
const onlyMain = main.filter((x) => !ours.includes(x));
console.log(`ours ${ours.length} / main ${main.length} / 交集 ${ours.length - onlyOurs.length}`);
console.log(`=== 仅我们失败 (${onlyOurs.length}) ===`);
onlyOurs.forEach((x) => console.log(" -", x));
console.log(`=== 仅 main 失败 (${onlyMain.length}) ===`);
onlyMain.forEach((x) => console.log(" -", x));
