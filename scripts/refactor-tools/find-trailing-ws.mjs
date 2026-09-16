// 找出 diff 里带 trailing whitespace 的文件与行号。
import { execSync } from "node:child_process";
const out = execSync("git diff 218ee1e0 HEAD --check", { encoding: "utf8" });
const lines = out.split("\n").filter((l) => l.includes("trailing whitespace") || l.includes("space before newline"));
const files = new Map();
for (const l of lines) {
  const m = l.match(/^([^\s]+):\d+:/);
  if (m) files.set(m[1], (files.get(m[1]) || 0) + 1);
}
for (const [f, n] of files) console.log(`${f}: ${n} 处`);
console.log(`共 ${lines.length} 处`);
