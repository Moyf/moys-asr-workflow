// 汇总 Playwright JSON 报告（poll-e2e.ps1 调用）。
// 报告体积可能远超 PS 5.1 ConvertFrom-Json 的上限，因此由 node 读取；
// 报告路径经 argv 传入，不要把报告内容塞进 argv。
import { readFileSync } from 'node:fs';

const reportPath = process.argv[2];
if (!reportPath) {
  console.error('用法: node summarize-e2e-report.mjs <e2e-report.json>');
  process.exit(2);
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const failures = [];

const walk = (suite) => {
  for (const child of suite.suites ?? []) walk(child);
  for (const spec of suite.specs ?? []) {
    if (spec.ok !== false) continue;
    failures.push(`${spec.file ?? ''}${spec.file ? ' › ' : ''}${spec.title}`);
  }
};
for (const suite of report.suites ?? []) walk(suite);

const stats = report.stats ?? {};
const parts = [];
if (stats.expected != null) parts.push(`通过 ${stats.expected}`);
if (stats.unexpected != null) parts.push(`失败 ${stats.unexpected}`);
if (stats.flaky) parts.push(`flaky ${stats.flaky}`);
if (stats.skipped) parts.push(`跳过 ${stats.skipped}`);
console.log(parts.length ? parts.join(' / ') : `失败 ${failures.length}`);

if (failures.length) {
  console.log('失败用例:');
  for (const line of failures) console.log(`  - ${line}`);
  process.exit(1);
}
console.log('全部通过');
