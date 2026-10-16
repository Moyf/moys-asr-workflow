// 类型门 baseline 过滤器：存量类型债显式化，新增错误必须归零。
// 用法：
//   node scripts/typecheck-baseline.mjs           # 门禁（npm run typecheck）
//   node scripts/typecheck-baseline.mjs --update  # 重新生成基线（还债后收缩）
// 基线文件 tests/tsc-baseline.txt：每行一条错误标识（file(line,col): error TSxxxx: message）。
// 债务清偿方向：消费侧精确 cast、manual 接口补全；基线只收缩不增长。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = path.join(root, 'tests', 'tsc-baseline.txt');

const tsc = spawnSync(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.typecheck.json'],
  { cwd: root, encoding: 'utf8' });
const lines = (tsc.stdout + tsc.stderr).split('\n').map((l) => l.trim()).filter((l) => /error TS\d+/.test(l));

if (process.argv.includes('--update')) {
  fs.writeFileSync(baselinePath, lines.slice().sort().join('\n') + (lines.length ? '\n' : ''), 'utf8');
  console.log(`baseline updated: ${lines.length} known errors registered`);
  process.exit(0);
}

const baseline = new Set(fs.existsSync(baselinePath)
  ? fs.readFileSync(baselinePath, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
  : []);
const fresh = lines.filter((line) => !baseline.has(line));
const fixed = [...baseline].filter((line) => !lines.includes(line));

if (fixed.length) console.log(`typecheck: ${fixed.length} 条基线错误已消失（请 --update 收缩基线）：\n  ${fixed.slice(0, 5).join('\n  ')}`);
if (fresh.length) {
  console.error(`typecheck FAILED：${fresh.length} 条新增类型错误（不在基线内）：`);
  for (const line of fresh.slice(0, 30)) console.error('  ' + line);
  process.exit(1);
}
console.log(`typecheck passed：${lines.length} 条错误全部在基线内（新增 0）`);
