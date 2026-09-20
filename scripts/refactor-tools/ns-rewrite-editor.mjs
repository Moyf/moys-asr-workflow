// 作用域感知的 NS 改写 v2：editor.js 中裸引用的已迁移符号 → NS.name。
//
// v2 内核：eslint-scope 作用域引擎替代手工作域链。
// 旧版手工遍历只覆盖 Program/Function/Block 三种作用域，for 头部声明、
// catch 参数、嵌套块内 var 提升等绑定形态漏收，导致局部名被误 NS 化
// （第五次 main 同步台账遗留 3 项之根源，数据修复三轮后改为工具级根治）。
// eslint-scope 按规范解析全部绑定形态，未解析引用以 globalScope.through
// 为权威集合；本工具自身只保留「导出面匹配 + 改写」两件事。
//
// 注意：ecmaVersion 必须传数字（如 16）。字符串 "latest" 与内部数字比较
// 恒为 false，会让 eslint-scope 退回 ES5 语义，let/const/for-of 头绑定
// 全部不登记，产生与旧版同类的误改写。
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
import * as acorn from "acorn";
import * as eslintScope from "eslint-scope";
import MagicString from "magic-string";
import { createTwoFilesPatch } from "diff";

const ECMA_VERSION = 16;

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

// 构建 node -> parent 映射，仅用于 shorthand 判定
function buildParentMap(ast) {
  const parents = new Map();
  (function attach(node, parent) {
    if (!node || typeof node.type !== "string") return;
    parents.set(node, parent);
    for (const key of Object.keys(node)) {
      if (["loc", "range", "start", "end"].includes(key)) continue;
      const v = node[key];
      if (Array.isArray(v)) {
        for (const c of v) { if (c && typeof c.type === "string") attach(c, node); }
      } else if (v && typeof v.type === "string") {
        attach(v, node);
      }
    }
  })(ast, null);
  return parents;
}

function isShorthandIdentifier(parents, ident) {
  // acorn 的 shorthand 属性 key/value 是两个不同节点对象（同名同位置），
  // 引用发生在 value 位，只能按 value 判定；key===value 恒为 false。
  const p = parents.get(ident);
  return Boolean(p && p.type === "Property" && p.shorthand && p.value === ident);
}

// ---- 核心：纯函数，可被测试直接驱动 ----
// 返回 { output, edits, selfCheck }；不改写任何文件。
export function rewriteSource(source, nameNs) {
  const ast = acorn.parse(source, { ecmaVersion: ECMA_VERSION, sourceType: "script", ranges: true });
  const scopeManager = eslintScope.analyze(ast, {
    ecmaVersion: ECMA_VERSION,
    sourceType: "script",
    ignoreEval: true,
  });
  const parents = buildParentMap(ast);

  const ms = new MagicString(source);
  const edits = [];
  const seen = new Set();
  for (const ref of scopeManager.globalScope.through) {
    const ident = ref.identifier;
    if (seen.has(ident.start)) continue;
    seen.add(ident.start);
    const name = ident.name;
    const ns = nameNs.get(name);
    if (!ns) continue; // 真全局（Date/Math/queue…）或不在导出面：跳过
    const shorthand = isShorthandIdentifier(parents, ident);
    const replacement = shorthand ? `${name}: ${ns}.${name}` : `${ns}.${name}`;
    ms.overwrite(ident.start, ident.end, replacement);
    edits.push({
      name,
      ns,
      line: lineOf(source, ident.start),
      form: shorthand ? "shorthand" : "reference",
    });
  }
  const output = ms.toString();

  // 幂等自检：输出重解析后，未解析引用 ∩ 导出面 必须为空
  const checkAst = acorn.parse(output, { ecmaVersion: ECMA_VERSION, sourceType: "script", ranges: true });
  const checkSm = eslintScope.analyze(checkAst, {
    ecmaVersion: ECMA_VERSION,
    sourceType: "script",
    ignoreEval: true,
  });
  const leftover = [];
  for (const ref of checkSm.globalScope.through) {
    if (nameNs.has(ref.identifier.name)) leftover.push(ref.identifier.name);
  }

  return { output, edits, selfCheck: { leftoverNames: [...new Set(leftover)], ok: leftover.length === 0 } };
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
  const { output, edits, selfCheck } = rewriteSource(source, nameNs);

  fs.writeFileSync(editorPath, output, "utf8");
  console.log(`改写 ${edits.length} 处`);
  const byName = new Map();
  for (const e of edits) byName.set(e.name, (byName.get(e.name) || 0) + 1);
  console.log([...byName.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}:${c}`).join("  "));

  if (!selfCheck.ok) {
    console.error(`自检失败：输出仍存在未解析的导出面引用 ${selfCheck.leftoverNames.join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log("自检通过：输出重解析后未解析引用 ∩ 导出面 = ∅");
  }

  if (edits.length && wantDiff) {
    console.log(createTwoFilesPatch("editor.js", "editor.js (rewritten)", source, output, undefined, undefined, { context: 2 }));
  }
  if (reportPath) {
    fs.writeFileSync(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), edits, selfCheck }, null, 2), "utf8");
    console.log(`决策报告已写入 ${reportPath}`);
  }
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) main(process.argv.slice(2));
