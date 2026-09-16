// 同名失败逐项比对：两组失败清单文件路径参数化。
// 用法: node compare-fails.mjs <ours.txt> <main.txt>
import fs from "node:fs";
const ours = fs.readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean).sort();
const main = fs.readFileSync(process.argv[3], "utf8").split("\n").filter(Boolean).sort();
const onlyOurs = ours.filter((t) => !main.includes(t));
const onlyMain = main.filter((t) => !ours.includes(t));
console.log(`我们 ${ours.length} / main ${main.length} / 交集 ${ours.length - onlyOurs.length}`);
console.log(`=== 仅我们失败 (${onlyOurs.length}) ===`);
onlyOurs.forEach((t) => console.log(" -", t));
console.log(`=== 仅 main 失败 (${onlyMain.length}) ===`);
onlyMain.forEach((t) => console.log(" -", t));

