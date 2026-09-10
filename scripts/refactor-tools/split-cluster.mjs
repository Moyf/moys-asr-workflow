// 按行区间从 web/editor.js 拆出顶层声明，生成 IIFE 模块并更新 editor-scripts.txt。
// 用法: node docs/temp/split-cluster.mjs docs/temp/cluster-xxx.json
// spec: {
//   file, ns, header,                 // 模块文件名 / 命名空间 / 头注释
//   ranges: [[a,b], ...],             // editor.js 行区间（含），仅顶层声明被搬出
//   exclude: ["name", ...],           // 区间内保留在 editor.js 的符号名
//   includeStatements: false          // 是否连同区间内顶层语句一起搬出（默认否）
// }
// 语义：
// - 引用改写用 ts-morph 语言服务（rename 级精度，作用域感知），外部引用改为 NS.name；
// - 可变 let/var 经命名空间上的访问器属性导出（Object.freeze 后 set 陷阱仍生效），
//   因此外部 `name = v` 机械改写为 `NS.name = v` 后语义不变；
// - 生成的模块插到清单中 editor.js 之前（模块不得在加载期引用 editor.js 声明，
//   否则运行 order test / 浏览器时会暴露）。

import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Node, Project, SyntaxKind } from "ts-morph";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const webDir = join(scriptDir, "..", "..", "web");
const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));
const { file, ns, header, exclude = [] } = spec;

const project = new Project({ compilerOptions: { allowJs: true } });
const manifest = readFileSync(join(webDir, "editor-scripts.txt"), "utf8")
  .split("\n").map((l) => l.split("#", 1)[0].trim()).filter(Boolean);
project.addSourceFilesAtPaths(manifest.map((n) => join(webDir, n)));

const editor = project.getSourceFileOrThrow(join(webDir, "editor.js"));

// ---- 0. 计算目标行区间（支持 from/to 符号名定位，规避行号漂移） ----
function lineOf(name) {
  const fn = editor.getFunction(name) || editor.getClass(name);
  if (fn) return editor.getLineAndColumnAtPos(fn.getStart()).line;
  const vd = editor.getVariableDeclaration(name);
  if (vd) return editor.getLineAndColumnAtPos(vd.getParent().getParent().getStart()).line;
  throw new Error(`定位失败: ${name}`);
}
const resolvedRanges = (spec.ranges || []).map(([a, b]) => [a, b]);
if (spec.from) {
  resolvedRanges.push([lineOf(spec.from), lineOf(spec.to || spec.from)]);
}
const inRanges = (line) => resolvedRanges.some(([a, b]) => line >= a && line <= b);

// ---- 1. 选出要搬走的顶层声明 ----
const moved = []; // { stmt, name, kind, isMutable, names[] }
const seen = new Set();
for (const stmt of editor.getStatements()) {
  const line = editor.getLineAndColumnAtPos(stmt.getStart()).line;
  if (!inRanges(line)) continue;
  if (Node.isFunctionDeclaration(stmt) || Node.isClassDeclaration(stmt)) {
    const name = stmt.getName();
    if (!name || exclude.includes(name)) continue;
    if (seen.has(name)) throw new Error(`重复声明: ${name}`);
    seen.add(name);
    moved.push({ stmt, names: [name], kind: Node.isClassDeclaration(stmt) ? "class" : "fn", isMutable: false });
  } else if (Node.isVariableStatement(stmt)) {
    const kw = stmt.getDeclarationList().getDeclarationKind();
    const names = stmt.getDeclarationList().getDeclarations()
      .flatMap((d) => {
        const nn = d.getNameNode();
        if (Node.isIdentifier(nn)) return [nn.getText()];
        return nn.getDescendantsOfKind("Identifier")
          .filter((id) => Node.isBindingElement(id.getParent()) && id.getParent().getNameNode() === id)
          .map((id) => id.getText());
      });
    if (names.some((n) => exclude.includes(n))) throw new Error(`声明语句含保留符号: ${names.join(",")}`);
    for (const n of names) if (seen.has(n)) throw new Error(`重复声明: ${n}`);
    names.forEach((n) => seen.add(n));
    moved.push({ stmt, names, kind: kw, isMutable: kw !== "const" });
  }
}
if (!moved.length) throw new Error("区间内没有可搬的顶层声明");
const movedNames = new Set(moved.flatMap((m) => m.names));
const movedRanges = moved.map((m) => [m.stmt.getFullStart(), m.stmt.getEnd()]);
const inMoved = (file2, pos) => file2 === editor && movedRanges.some(([a, b]) => pos >= a && pos < b);

// ---- 2. 语言服务收集外部引用并改写 ----
const edits = new Map(); // sourceFile -> [{start, length, text}]
let rewritten = 0;
const byFileReport = new Map();
for (const m of moved) {
  for (const name of m.names) {
    const decl = editor.getFunction(name) || editor.getClass(name) || editor.getVariableDeclaration(name);
    const nameNode = decl?.getNameNode?.();
    if (!nameNode) throw new Error(`找不到声明名节点: ${name}`);
    for (const ref of nameNode.findReferences()) {
      for (const entry of ref.getReferences()) {
        const sf = entry.getSourceFile();
        const span = entry.getTextSpan();
        const start = span.getStart();
        const length = span.getLength();
        // 对象/解构简写 {flashHint} 不能机械替换成 {NS.flashHint}，
        // 必须展开为键值对；绑定模式简写无法安全改写，报错人工处理。
        const idNode = sf.getDescendantAtPos(start);
        const parent = idNode?.getParent();
        let replacement = `${ns}.${name}`;
        if (Node.isShorthandPropertyAssignment(parent)) {
          replacement = `${name}: ${ns}.${name}`;
        } else if (idNode && parent) {
          const kind = parent.getKind();
          if (kind === SyntaxKind.ObjectPattern || kind === SyntaxKind.ArrayPattern
            || (Node.isBindingElement(parent) && parent.getNameNode() === idNode)) {
            throw new Error(`简写绑定不可自动改写: ${name} @ ${sf.getBaseName()}:${sf.getLineAndColumnAtPos(start).line}`);
          }
        }
        if (inMoved(sf, start)) continue; // 搬走代码内部的相互引用保持裸名
        const list = edits.get(sf) || [];
        list.push({ start, length, text: replacement });
        edits.set(sf, list);
        rewritten += 1;
        byFileReport.set(sf.getBaseName(), (byFileReport.get(sf.getBaseName()) || 0) + 1);
      }
    }
  }
}
const rewrittenOutputs = new Map(); // sourceFile -> 改写后的完整文本（原始文本上做偏移替换）
for (const [sf, list] of edits) {
  if (sf === editor) continue; // editor.js 在摘出声明后重建时应用改写
  list.sort((a, b) => b.start - a.start);
  const text = sf.getFullText();
  let out = text;
  for (const e of list) out = out.slice(0, e.start) + e.text + out.slice(e.start + e.length);
  rewrittenOutputs.set(sf, out);
}

// ---- 3. 从 editor.js 摘出声明文本（改写保留段落中的外部引用），生成模块 ----
const editorText = editor.getFullText();
const editorEdits = (edits.get(editor) || []).sort((a, b) => b.start - a.start);
let kept = "";
let last = 0;
const chunks = [];
const ordered = [...moved].sort((a, b) => a.stmt.getFullStart() - b.stmt.getFullStart());
const applyEditsIn = (segment, segStart) => {
  const inside = editorEdits.filter((e) => e.start >= segStart && e.start + e.length <= segStart + segment.length);
  let out = segment;
  for (const e of inside) {
    const at = e.start - segStart;
    out = out.slice(0, at) + e.text + out.slice(at + e.length);
  }
  return out;
};
for (const m of ordered) {
  const [s, e] = [m.stmt.getFullStart(), m.stmt.getEnd()];
  kept += applyEditsIn(editorText.slice(last, s), last);
  chunks.push(editorText.slice(s, e));
  last = e;
}
kept += applyEditsIn(editorText.slice(last), last);
kept = kept.replace(/\n{3,}/g, "\n\n");
editor.replaceWithText(kept.trimEnd() + "\n");

const indent = (text) => text.split("\n").map((l) => (l.trim() ? "  " + l : l)).join("\n");
// append 模式：把符号追加进已存在的模块文件（在其 freeze 导出前插入）。
const appendTarget = spec.append ? join(webDir, spec.file.replace(/^web\//, "")) : null;
// 模块加载期不得引用 editor.js 的 boot 别名；两者都是 window.AsrEditorUtils 的缩写，
// 统一改写为 window 命名空间直访（editor-utils.js 在清单中先于所有拆分模块加载）。
const fixBootAliases = (text) => text
  .replace(/\bEDITOR_SETTINGS_UTILS\./g, "window.AsrEditorUtils.")
  .replace(/\bMULTI_SUBTITLE_UTILS\./g, "window.AsrEditorUtils.");
const exportLines = moved.map((m) => {
  if (m.isMutable) {
    return m.names.map((n) => `    get ${n}() { return ${n}; },\n    set ${n}(v) { ${n} = v; }`).join(",\n");
  }
  return `    ${m.names[0]}`;
});
const baseName = (p) => p.replace(/^web\//, "");
// 外部进程（查看器/杀软）可能以拒写共享方式短暂占用文件；
// Windows 上删除共享通常放行，失败即删旧 inode 再写。
const safeWrite = (path, data) => {
  try {
    writeFileSync(path, data, "utf8");
  } catch {
    rmSync(path, { force: true });
    writeFileSync(path, data, "utf8");
  }
};
const moduleSource = `// ${header}
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.${ns} 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function init${ns}(global) {
  'use strict';

${fixBootAliases(chunks.map(indent).join("\n\n"))}

  global.${ns} = Object.freeze({
${exportLines.join(",\n")}
  });
})(typeof window !== 'undefined' ? window : globalThis);
`;
safeWrite(join(webDir, "editor.js"), kept.trimEnd() + "\n");
if (appendTarget) {
  const targetText = readFileSync(appendTarget, "utf8");
  const anchorToken = "  global." + ns + " = Object.freeze({";
  const anchor = targetText.indexOf(anchorToken);
  if (anchor < 0) throw new Error(`追加目标缺少导出锚点: ${file}`);
  const extraExports = moved.map((m) => {
    if (m.isMutable) {
      return m.names.map((n) => `\n    get ${n}() { return ${n}; },\n    set ${n}(v) { ${n} = v; },`).join("");
    }
    return `\n    ${m.names[0]},`;
  }).join("");
  const insertedAt = anchor + anchorToken.length;
  const out = targetText.slice(0, anchor) + fixBootAliases(chunks.map(indent).join("\n\n")) + "\n\n"
    + targetText.slice(anchor).replace(anchorToken, anchorToken + extraExports);
  safeWrite(appendTarget, out);
} else {
  safeWrite(join(webDir, baseName(file)), moduleSource);
}
for (const sf of project.getSourceFiles()) {
  const rel = sf.getFilePath().slice(webDir.length + 1).replace(/\\/g, "/");
  if (rel === baseName(file) || rel === "editor.js" || rel === baseName(spec.file)) continue;
  if (rewrittenOutputs.has(sf)) safeWrite(join(webDir, rel), rewrittenOutputs.get(sf));
}

// ---- 4. 清单插入 editor.js 之前 ----
const manifestPath = join(webDir, "editor-scripts.txt");
const manifestText = readFileSync(manifestPath, "utf8");
if (!spec.append && !manifestText.split("\n").map((l) => l.trim()).includes(baseName(file))) {
  safeWrite(manifestPath, manifestText.replace(/^editor\.js$/m, `${baseName(file)}\neditor.js`));
}

console.log(`[${ns}] 搬出声明 ${moved.length} 组 / ${movedNames.size} 个符号；外部引用改写 ${rewritten} 处`);
console.log("  改写分布:", [...byFileReport.entries()].map(([f, c]) => `${f}:${c}`).join("  "));
console.log(`  editor.js 现为 ${kept.split("\n").length} 行；模块 ${file} ${moduleSource.split("\n").length} 行`);
