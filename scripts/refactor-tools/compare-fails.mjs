// 同名失败逐项比对：our-fails vs main-fails（含仅一方失败清单）。
import fs from "node:fs";
const ours = fs.readFileSync(process.env.TEMP + "/final3-fails.txt", "utf8").split("\n").filter(Boolean).sort();
const main = fs.readFileSync(process.env.TEMP + "/maincheck3-fails.txt", "utf8").split("\n").filter(Boolean).sort();
const onlyOurs = ours.filter((t) => !main.includes(t));
const onlyMain = main.filter((t) => !ours.includes(t));
console.log(`我们 ${ours.length} / 纯main ${main.length} / 交集 ${ours.length - onlyOurs.length}`);
console.log(`=== 仅我们失败 (${onlyOurs.length}) ===`);
onlyOurs.forEach((t) => console.log(" -", t));
console.log(`=== 仅 main 失败 (${onlyMain.length}) ===`);
onlyMain.forEach((t) => console.log(" -", t));
