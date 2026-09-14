// 对比 main 与当前树中指定函数体是否逐字节一致。
// 用法: node scripts/refactor-tools/compare-fn.mjs <函数名> ...
import fs from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";

const mainSrc = execSync("git show origin/main:web/editor.js", { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const ourSrc = fs.readFileSync("web/editor.js", "utf8");

function extract(src, fnName) {
  const idx = src.indexOf(`function ${fnName}(`);
  if (idx < 0) return null;
  // 先找到签名右括号（跳过字符串/模板），再对函数体做括号配对
  let i = idx, paren = 0, bodyStart = -1, k = idx;
  for (; k < src.length; k++) {
    const ch = src[k];
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      k++;
      while (k < src.length && src[k] !== quote) { if (src[k] === "\\") k++; k++; }
      continue;
    }
    if (ch === "(") paren++;
    else if (ch === ")") { paren--; if (paren === 0) { bodyStart = k + 1; break; } }
  }
  if (bodyStart < 0) return null;
  let depth = 0, j = bodyStart;
  for (; j < src.length; j++) {
    const ch = src[j];
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      j++;
      while (j < src.length && src[j] !== quote) { if (src[j] === "\\") j++; j++; }
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { j++; break; } }
  }
  return src.slice(idx, j);
}

for (const name of process.argv.slice(2)) {
  const a0 = extract(mainSrc, name);
  const b0 = extract(ourSrc, name);
  if (a0 === null || b0 === null) { console.log(`${name}: main=${a0 ? a0.length : "缺失"} ours=${b0 ? b0.length : "缺失"}`); continue; }
  // 归一化 NS 前缀与空白，只比语义
  const norm = (s) => s.replace(/\bMawe\w+\./g, "").replace(/\s+/g, " ");
  const a = norm(a0), b = norm(b0);
  if (a === b) { console.log(`${name}: 语义一致`); continue; }
  let k = 0;
  while (k < Math.min(a.length, b.length) && a[k] === b[k]) k++;
  console.log(`${name}: 语义不一致 (main ${a0.length} vs ours ${b0.length})，首个差异 @${k}`);
  console.log(`  main: ${a.slice(Math.max(0, k - 50), k + 90)}`);
  console.log(`  ours: ${b.slice(Math.max(0, k - 50), k + 90)}`);
}
