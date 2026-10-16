// 从 deferred 摘除已转普通 ESM 的文件（保持原相对序校验）。
// 用法：node scripts/esm-migration/detach.mjs <file> [<file>...]
// 摘除条件（盘点工具验证）：该文件无 phase-2 立即消费者在读
// 旧位次——转换后 import 期求值，早于一切 phase-2，只会更安全。
// 同时强制 LF 写出（Windows 文本模式 CRLF 会破坏 configHash）。
import fs from 'node:fs';
const [,, ...targets] = process.argv;
if (!targets.length) throw new Error('Usage: detach.mjs <file>...');
const p = 'web/editor-modules.json';
const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
for (const t of targets) {
  if (!cfg.deferred.includes(t)) throw new Error(`not in deferred: ${t}`);
  cfg.deferred = cfg.deferred.filter(f => f !== t);
}
fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', { encoding: 'utf8' });
console.log(`deferred: ${cfg.deferred.length}`);
