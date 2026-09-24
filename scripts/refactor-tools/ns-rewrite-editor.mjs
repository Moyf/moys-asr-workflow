// 作用域感知的 NS 改写 v2：editor.js 中裸引用的已迁移符号 → NS.name。
//
// v2 内核：eslint-scope 作用域引擎（共享核见 scripts/refactor-tools/scope-core.mjs）
// 替代手工作域链。旧版手工遍历只覆盖 Program/Function/Block 三种作用域，
// for 头部声明、catch 参数、嵌套块内 var 提升等绑定形态漏收，导致局部名
// 被误 NS 化（第五次 main 同步台账遗留 3 项之根源，数据修复三轮后改为
// 工具级根治）。未解析引用以 globalScope.through 为权威集合；本工具自身
// 只保留「导出面匹配 + 改写」两件事。
//
// 附带：
//   - 改写决策报告（--report <path>）：每次改写的名字/位置/形态，供合并期审计；
//   - 幂等自检：输出重解析后，未解析引用 ∩ 导出面 必须为空；
//   - --diff 输出统一 diff 预览（jsdiff），便于人工复核。
//
// 用法: node scripts/refactor-tools/ns-rewrite-editor.mjs [--report <path>] [--diff]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import MagicString from "magic-string";
import { createTwoFilesPatch } from "diff";
import { selfCheck, unresolvedRefs } from "./scope-core.mjs";

// ---- 导出表: name -> ns（沿用模块文件 global.NS = Object.freeze({...}) 的格式契约） ----
export function buildExportTable(moduleTexts) {
  const nameNs = new Map();
  for (const text of moduleTexts) {
    const m = text.match(/global\.(\w+) = Object\.freeze\(\{([\s\S]*?)\n  \}\);/);
    if (!m) continue;
    const ns = m[1];
    for (const line of m[2].split("\n")) {
      let name = line.match(/^\s{4}(\w+),?\s*$/)?.[1];
      if (!name) name = line.match(/^\s{4}get (\w+)\(/)?.[1];
      if (!name) name = line.match(/^\s{4}set (\w+)\(/)?.[1];
      if (name) nameNs.set(name, ns);
    }
  }
  return nameNs;
}

function lineOf(source, pos) {
  return source.slice(0, pos).split("\n").length;
}

// ---- 核心：纯函数，可被测试直接驱动 ----
// 返回 { output, edits, selfCheck }；不改写任何文件。
export function rewriteSource(source, nameNs) {
  const ms = new MagicString(source);
  const edits = [];
  for (const ref of unresolvedRefs(source)) {
    const ns = nameNs.get(ref.name);
    if (!ns) continue; // 真全局（Date/Math/queue…）或不在导出面：跳过
    const replacement = ref.shorthand ? `${ref.name}: ${ns}.${ref.name}` : `${ns}.${ref.name}`;
    ms.overwrite(ref.start, ref.end, replacement);
    edits.push({
      name: ref.name,
      ns,
      line: lineOf(source, ref.start),
      form: ref.shorthand ? "shorthand" : "reference",
    });
  }
  const output = ms.toString();
  return { output, edits, selfCheck: selfCheck(output, nameNs) };
}

export function main(argv) {
  const reportIdx = argv.indexOf("--report");
  const reportPath = reportIdx >= 0 ? argv[reportIdx + 1] : null;
  const wantDiff = argv.includes("--diff");

  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const webDir = path.join(root, "web");

  const moduleTexts = fs.readdirSync(webDir)
    .filter((f) => f.startsWith("editor-") && f.endsWith(".js") && f !== "editor.js")
    .map((f) => fs.readFileSync(path.join(webDir, f), "utf8"));
  const nameNs = buildExportTable(moduleTexts);
  console.log(`导出符号 ${nameNs.size} 个`);

  const editorPath = path.join(webDir, "editor.js");
  const source = fs.readFileSync(editorPath, "utf8");
  const { output, edits, selfCheck: check } = rewriteSource(source, nameNs);

  fs.writeFileSync(editorPath, output, "utf8");
  console.log(`改写 ${edits.length} 处`);
  const byName = new Map();
  for (const e of edits) byName.set(e.name, (byName.get(e.name) || 0) + 1);
  console.log([...byName.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}:${c}`).join("  "));

  if (!check.ok) {
    console.error(`自检失败：输出仍存在未解析的导出面引用 ${check.leftoverNames.join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log("自检通过：输出重解析后未解析引用 ∩ 导出面 = ∅");
  }

  if (edits.length && wantDiff) {
    console.log(createTwoFilesPatch("editor.js", "editor.js (rewritten)", source, output, undefined, undefined, { context: 2 }));
  }
  if (reportPath) {
    fs.writeFileSync(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), edits, selfCheck: check }, null, 2), "utf8");
    console.log(`决策报告已写入 ${reportPath}`);
  }
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) main(process.argv.slice(2));
