// 提取最终 e2e 报告失败清单，与 main@5837aa61 基线（maincheck5-fails.txt）比对。
import fs from "node:fs";
const r = JSON.parse(fs.readFileSync(process.env.TEMP + "/maw-e2e-bg/run-20260916-193327/e2e-report.json", "utf8"));
const fails = [];
let total = 0;
for (const s of r.suites) {
  const walk = (x) => {
    if (!x) return;
    if (x.specs) for (const sp of x.specs) { total += 1; if (sp.ok === false) fails.push(sp.title); }
    (x.suites || []).forEach(walk);
  };
  walk(s);
}
fs.writeFileSync(process.env.TEMP + "/final6-fails.txt", fails.sort().join("\n"));
console.log(`total ${total} fails ${fails.length}`);

const main = fs.readFileSync(process.env.TEMP + "/maincheck5-fails.txt", "utf8").split("\n").filter(Boolean).sort();
const onlyOurs = fails.filter((t) => !main.includes(t));
const onlyMain = main.filter((t) => !fails.includes(t));
console.log(`基线(main@5837aa61) ${main.length} 项`);
console.log(`=== 仅我们失败 (${onlyOurs.length}) ===`);
onlyOurs.forEach((t) => console.log(" -", t));
console.log(`=== 仅 main 失败 (${onlyMain.length}) ===`);
onlyMain.forEach((t) => console.log(" -", t));
