// 只读分析 demo：用 ts-morph 对 web/*.js 构建「顶层符号依赖图」。
// 这就是「分析层粒子化」：把 editor.js 在内存里拆成符号粒子，统计依赖关系，
// 不移动、不修改任何源文件。产出用于决定最终模块怎么划分、按什么顺序拆。
//
// 用法（在仓库根目录执行）：
//   node docs/temp/analyze-editor-deps-demo.mjs                     # 总览 + Top 榜
//   node docs/temp/analyze-editor-deps-demo.mjs splitModeLabel      # 查看某符号的依赖闭包
//   node docs/temp/analyze-editor-deps-demo.mjs --search split      # 按子串查符号名
//
// 已知精度边界（demo 级）：
// - 用「同名标识符 + 局部遮蔽过滤」匹配引用，不是类型检查器级别的精确解析；
//   正式工具应换 checker（rename 级精度），demo 先证明这件事值得做。
// - 字符串 / window["name"] 之类的动态引用看不到，死代码候选必须人工确认。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Node, Project, SyntaxKind } from "ts-morph";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const webDir = join(scriptDir, "..", "..", "web");

// ---------- 1. 载入 web/ 下的 7 个编辑器脚本（与 editor-scripts.txt 同一范围） ----------
const manifest = readFileSync(join(webDir, "editor-scripts.txt"), "utf8")
  .split("\n")
  .map((line) => line.split("#", 1)[0].trim())
  .filter(Boolean);

const project = new Project({
  compilerOptions: { allowJs: true, checkJs: false },
});
// 不按清单顺序载入：在这个分析里 7 个文件共享同一个全局作用域，顺序无关。
project.addSourceFilesAtPaths(manifest.map((name) => join(webDir, name)));

// ---------- 2. 建符号表：所有顶层 function / class / var·let·const ----------
// 同名声明会全部保留——在「顺序拼接 + 共享全局」模型里这是真实的重名冲突隐患。
const symbols = new Map(); // name -> { name, kind, file, declNode, ownNameNodes:Set, fanIn:Set, fanOut:Set, writes:number }

function addSymbol(name, kind, file, declNode, nameNodes) {
  if (!symbols.has(name)) {
    symbols.set(name, {
      name, kind, file, declNode,
      ownNameNodes: new Set(nameNodes.map((n) => n.compilerNode)),
      fanIn: new Set(), fanOut: new Set(), writes: 0,
    });
  } else {
    const prev = symbols.get(name);
    console.warn(`[重名] ${name} 同时声明于 ${prev.file} 和 ${file}（运行时后声明者胜出）`);
    for (const n of nameNodes) prev.ownNameNodes.add(n.compilerNode);
  }
}

for (const sf of project.getSourceFiles()) {
  const file = sf.getBaseName();
  for (const fn of sf.getFunctions()) {
    if (fn.getName()) addSymbol(fn.getName(), "function", file, fn, [fn.getNameNode()]);
  }
  for (const cls of sf.getClasses()) {
    if (cls.getName()) addSymbol(cls.getName(), "class", file, cls, [cls.getNameNode()]);
  }
  for (const vs of sf.getVariableStatements()) {
    const kindWord = vs.getDeclarationList().getDeclarationKind(); // "let" / "const" / "var"
    for (const decl of vs.getDeclarationList().getDeclarations()) {
      const nn = decl.getNameNode();
      if (Node.isIdentifier(nn)) {
        addSymbol(nn.getText(), kindWord, file, vs, [nn]);
      } else {
        // 解构声明：const { a, b } = ... —— 把每个绑定名都算作一个顶层符号
        const bound = nn.getDescendantsOfKind(SyntaxKind.Identifier).filter((id) => {
          const p = id.getParent();
          return Node.isBindingElement(p) && p.getNameNode() === id;
        });
        for (const id of bound) addSymbol(id.getText(), kindWord, file, vs, [id]);
      }
    }
  }
}

// ---------- 3. 引用扫描：每个符号体内出现的其他顶层符号 = 一条出边 ----------
// isReferenceIdentifier：排除 a.b 的 b、对象字面量的键、解构模式的键、嵌套函数声明名等
function isReferenceIdentifier(id) {
  const p = id.getParent();
  if (!p) return false;
  if (typeof p.getNameNode === "function" && p.getNameNode?.() === id) {
    // PropertyAccessExpression(.b)、PropertyAssignment/MethodDeclaration/嵌套 Function·Class 声明名等
    if (Node.isPropertyAccessExpression(p)) return false;
    if (Node.isPropertyAssignment(p)) return false;
    if (Node.isShorthandPropertyAssignment(p)) return true; // {foo} 简写是真实引用
    if (Node.isMethodDeclaration(p) || Node.isGetAccessorDeclaration(p) || Node.isSetAccessorDeclaration(p)) return false;
    if (Node.isFunctionDeclaration(p) || Node.isClassDeclaration(p)) return false;
    if (Node.isQualifiedName(p)) return false;
  }
  if (Node.isBindingElement(p)) {
    // 解构模式里的绑定名和键名都不是引用；只有默认值初始化器（{a = someGlobal}）是
    if (p.getNameNode?.() === id) return false;
    if (p.compilerNode.propertyName && id.compilerNode === p.compilerNode.propertyName) return false;
    return true;
  }
  return true;
}

// 收集一个符号体内「局部绑定」的名字（参数、let/const、嵌套函数/类、catch），
// 这些名字遮蔽同名全局符号，不能算引用。
function collectLocalBoundNames(node) {
  const names = new Set();
  const addPattern = (nn) => {
    if (!nn) return;
    if (Node.isIdentifier(nn)) { names.add(nn.getText()); return; }
    for (const id of nn.getDescendantsOfKind(SyntaxKind.Identifier)) {
      const p = id.getParent();
      if (Node.isBindingElement(p) && p.getNameNode() === id) names.add(id.getText());
    }
  };
  for (const p of node.getDescendantsOfKind(SyntaxKind.Parameter)) addPattern(p.getNameNode());
  for (const d of node.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) addPattern(d.getNameNode());
  for (const f of node.getDescendantsOfKind(SyntaxKind.FunctionDeclaration)) if (f.getName()) names.add(f.getName());
  for (const c of node.getDescendantsOfKind(SyntaxKind.ClassDeclaration)) if (c.getName()) names.add(c.getName());
  for (const c of node.getDescendantsOfKind(SyntaxKind.CatchClause)) names.add(c.getVariableDeclaration()?.getName?.());
  return names;
}

let edgeCount = 0;
for (const sym of symbols.values()) {
  const locals = collectLocalBoundNames(sym.declNode);
  for (const id of sym.declNode.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (sym.ownNameNodes.has(id.compilerNode)) continue; // 自己的名字（含递归）
    if (!isReferenceIdentifier(id)) continue;
    const name = id.getText();
    if (name === sym.name || locals.has(name) || !symbols.has(name)) continue;
    sym.fanOut.add(name);
    symbols.get(name).fanIn.add(sym.name);
    edgeCount += 1;
  }
}

// ---------- 4. 顶层可变状态检测：let/var 被赋值（=、+=、++…）的次数 ----------
// 这是拆分时真正的危险名单：可变全局状态必须收拢进状态模块，不能随符号散落。
const WRITE_OPS = new Set([
  SyntaxKind.EqualsToken, SyntaxKind.PlusEqualsToken, SyntaxKind.MinusEqualsToken,
  SyntaxKind.AsteriskEqualsToken, SyntaxKind.SlashEqualsToken, SyntaxKind.AmpersandEqualsToken,
  SyntaxKind.BarEqualsToken, SyntaxKind.CaretEqualsToken, SyntaxKind.PercentEqualsToken,
]);
for (const sf of project.getSourceFiles()) {
  for (const id of sf.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (!symbols.has(id.getText())) continue;
    const sym = symbols.get(id.getText());
    if (sym.kind !== "let" && sym.kind !== "var") continue;
    const p = id.getParent();
    let isWrite = false;
    if (Node.isBinaryExpression(p) && WRITE_OPS.has(p.getOperatorToken().getKind())
      && p.getLeft().compilerNode === id.compilerNode) isWrite = true;
    if ((Node.isPrefixUnaryExpression(p) || Node.isPostfixUnaryExpression(p))
      && (p.getOperatorToken() === SyntaxKind.PlusPlusToken || p.getOperatorToken() === SyntaxKind.MinusMinusToken)
      && p.getOperand().compilerNode === id.compilerNode) isWrite = true;
    if (isWrite) sym.writes += 1;
  }
}

// ---------- 5. 输出报告 ----------
const fmt = (n) => String(n).padStart(6);
const byFile = new Map(manifest.map((name) => [name, { count: 0, mutable: 0 }]));
for (const sym of symbols.values()) {
  if (!byFile.has(sym.file)) byFile.set(sym.file, { count: 0, mutable: 0 });
  byFile.get(sym.file).count += 1;
  if ((sym.kind === "let" || sym.kind === "var")) byFile.get(sym.file).mutable += 1;
}
console.log("\n=== 1. 顶层符号分布（共享同一全局作用域） ===");
for (const [file, s] of byFile) {
  console.log(`  ${file.padEnd(24)} 符号 ${fmt(s.count)}   其中可变 let/var ${fmt(s.mutable)}`);
}
console.log(`  ${"—".repeat(40)}\n  合计符号 ${symbols.size}，符号间依赖边 ${edgeCount} 条`);

console.log("\n=== 2. 顶层可变状态 Top 15（被外部赋值次数，拆分危险名单） ===");
const mutableTop = [...symbols.values()].filter((s) => s.writes > 0).sort((a, b) => b.writes - a.writes).slice(0, 15);
for (const s of mutableTop) console.log(`  ${fmt(s.writes)} 次写入  ${s.kind.padEnd(5)} ${s.name}  (${s.file})`);

console.log("\n=== 3. 扇入 Top 15（被最多符号依赖 → 候选「工具模块」成员） ===");
const fanInTop = [...symbols.values()].sort((a, b) => b.fanIn.size - a.fanIn.size).slice(0, 15);
for (const s of fanInTop) console.log(`  被引 ${fmt(s.fanIn.size)} 处  ${s.name}  (${s.file})`);

console.log("\n=== 4. 扇出 Top 10（依赖最多符号 → 拆解优先级最高的「上帝函数」） ===");
const fanOutTop = [...symbols.values()].sort((a, b) => b.fanOut.size - a.fanOut.size).slice(0, 10);
for (const s of fanOutTop) console.log(`  依赖 ${fmt(s.fanOut.size)} 个符号  ${s.name}  (${s.file})`);

const isolated = [...symbols.values()].filter((s) => s.fanIn.size === 0 && s.fanOut.size === 0);
console.log(`\n=== 5. 孤立符号（本项目内无入边也无出边 → 死代码候选，需人工确认） ===`);
console.log(`  共 ${isolated.length} 个，例如：${isolated.slice(0, 12).map((s) => s.name).join(", ")}${isolated.length > 12 ? " …" : ""}`);

// ---------- 6. 依赖闭包：模拟「把某个功能整体搬出去，需要带上谁」 ----------
function closureOf(seedName) {
  const seen = new Set([seedName]);
  const queue = [seedName];
  while (queue.length) {
    const cur = symbols.get(queue.pop());
    if (!cur) continue;
    for (const dep of cur.fanOut) if (!seen.has(dep)) { seen.add(dep); queue.push(dep); }
  }
  return [...seen].map((n) => symbols.get(n));
}

function printClosure(seedName) {
  const nodes = closureOf(seedName);
  console.log(`\n=== 6. 依赖闭包：${seedName}（整体迁移需要搬动的全部符号） ===`);
  if (!symbols.has(seedName)) {
    console.log(`  符号不存在，用 --search 先查名字。`);
    return;
  }
  const files = new Map();
  for (const n of nodes) {
    if (!files.has(n.file)) files.set(n.file, []);
    files.get(n.file).push(n);
  }
  for (const [file, list] of files) console.log(`  ${file}: ${list.length} 个`);
  const stateMembers = nodes.filter((n) => n.writes > 0).map((n) => n.name);
  if (stateMembers.length) console.log(`  ⚠ 闭包内包含可变状态: ${stateMembers.join(", ")}`);
  console.log(`  成员: ${nodes.slice(0, 40).map((n) => n.name).join(", ")}${nodes.length > 40 ? " …" : ""}`);
}

// ---------- CLI ----------
const args = process.argv.slice(2);
if (args[0] === "--search") {
  const q = (args[1] || "").toLowerCase();
  const hits = [...symbols.keys()].filter((n) => n.toLowerCase().includes(q));
  console.log(`\n匹配 "${q}" 的符号 ${hits.length} 个：\n  ${hits.slice(0, 40).join(", ")}${hits.length > 40 ? " …" : ""}`);
} else if (args[0]) {
  printClosure(args[0]);
}
