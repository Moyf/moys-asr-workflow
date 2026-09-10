// 编辑器脚本清单顺序断言：IIFE 模块化架构的安全网。
//
// web/ 下的脚本是「editor-scripts.txt 规定顺序 + 共享全局作用域」模型，
// 文件之间没有显式依赖声明，加载顺序错误表现为运行时静默 undefined。
// 本测试把顺序约束固化为可检查的不变量：
//
//   1. 清单内每个文件必须能被 acorn 解析；
//   2. 跨文件的顶层声明重名 → 失败（同名全局按声明顺序互相覆盖，是隐患）；
//   3. 跨文件的命名空间导出（window.X = / globalThis.X = / global.X =）重名 → 失败；
//   4. 文件在「加载期」（顶层语句、IIFE、var/let/const 初始化器）引用了
//      清单中更靠后的文件声明的名字或导出的命名空间 → 失败；
//      函数体、类方法体是延迟执行的，引用后置文件的名字不在此检查范围
//      （那由真实运行验证），这符合脚本引擎的真实语义。
//
// acorn 是 devDependency；缺失时本测试 skip，保证最小验证命令在裸环境可用。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const webDir = join(testDir, "..", "web");

function readManifest() {
  return readFileSync(join(webDir, "editor-scripts.txt"), "utf8")
    .split("\n")
    .map((line) => line.split("#", 1)[0].trim())
    .filter(Boolean);
}

function collectPatternNames(node, out = [], names = null) {
  // 解构声明 / 参数模式的绑定名收集；默认值表达式不是绑定名。
  const push = (name) => (names ? names.add(name) : out.push(name));
  if (!node) return out;
  switch (node.type) {
    case "Identifier":
      push(node.name);
      break;
    case "ObjectPattern":
    case "ArrayPattern":
      for (const el of node.elements ?? []) collectPatternNames(el, out, names);
      for (const prop of node.properties ?? []) collectPatternNames(prop, out, names);
      break;
    case "Property":
      collectPatternNames(node.value, out, names);
      break;
    case "RestElement":
      collectPatternNames(node.argument, out, names);
      break;
    case "AssignmentPattern":
      collectPatternNames(node.left, out, names);
      break;
  }
  return out;
}

// 收集一段 AST 里所有声明位置出现过的绑定名（任意嵌套层级）：var/let/const
// 声明、函数/类名、参数、catch 参数。用于上面的遮蔽豁免；只看声明位置、
// 不区分作用域是刻意的粗粒度取舍。
function collectAllBoundNames(root) {
  const names = new Set();
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }
    if (typeof node.type !== "string") continue;
    switch (node.type) {
      case "VariableDeclaration":
        for (const decl of node.declarations) collectPatternNames(decl.id, [], names);
        break;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        if (node.id) names.add(node.id.name);
        for (const param of node.params ?? []) collectPatternNames(param, [], names);
        break;
      case "ClassDeclaration":
      case "ClassExpression":
        if (node.id) names.add(node.id.name);
        break;
      case "CatchClause":
        collectPatternNames(node.param, [], names);
        break;
    }
    for (const key of Object.keys(node)) {
      if (["loc", "range", "start", "end"].includes(key)) continue;
      const value = node[key];
      if (Array.isArray(value) || (value && typeof value === "object" && typeof value.type === "string")) {
        stack.push(value);
      }
    }
  }
  return names;
}

test("editor-scripts.txt 顺序断言", async (t) => {
  let acorn;
  try {
    acorn = await import("acorn");
  } catch {
    t.skip("acorn 未安装：先在仓库根目录运行 npm install");
    return;
  }

  const manifest = readManifest();
  assert.ok(manifest.length >= 2, "清单至少应有两个脚本");

  function record(map, name, fileIdx, fileName, dups, kind) {
    if (!map.has(name)) {
      map.set(name, fileIdx);
      return;
    }
    const prev = map.get(name);
    if (prev !== fileIdx) {
      dups.push(`${kind} \`${name}\` 同时存在于 ${manifest[prev]} 和 ${fileName}`);
    }
  }

  // ---- 第一遍：解析 + 收集每个文件的顶层声明与命名空间导出 ----
  const declarations = new Map(); // 顶层声明名 -> 文件下标
  const namespaces = new Map(); // window.X / globalThis.X / global.X 导出名 -> 文件下标
  const selfBound = new Map(); // 文件下标 -> 该文件任意层级绑定过的名字集合
  const dups = [];
  const programs = [];

  manifest.forEach((name, fileIdx) => {
    const source = readFileSync(join(webDir, name), "utf8");
    let program;
    assert.doesNotThrow(() => {
      program = acorn.parse(source, { ecmaVersion: "latest" });
    }, `${name} 语法解析失败`);
    programs.push(program);
    selfBound.set(fileIdx, collectAllBoundNames(program));

    for (const stmt of program.body) {
      if (stmt.type === "FunctionDeclaration" && stmt.id) {
        record(declarations, stmt.id.name, fileIdx, name, dups, "顶层声明");
      } else if (stmt.type === "ClassDeclaration" && stmt.id) {
        record(declarations, stmt.id.name, fileIdx, name, dups, "顶层声明");
      } else if (stmt.type === "VariableDeclaration") {
        for (const decl of stmt.declarations) {
          for (const bound of collectPatternNames(decl.id)) {
            record(declarations, bound, fileIdx, name, dups, "顶层声明");
          }
        }
      }
    }

    // 命名空间导出：window.X = / globalThis.X = / global.X =（任意深度，含 IIFE 内）
    const stack = [...program.body];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== "object") continue;
      if (Array.isArray(node)) {
        stack.push(...node);
        continue;
      }
      if (typeof node.type !== "string") continue;
      if (node.type === "AssignmentExpression" && node.left.type === "MemberExpression"
        && !node.left.computed && node.left.property.type === "Identifier"
        && node.left.object.type === "Identifier"
        && ["window", "globalThis", "global"].includes(node.left.object.name)) {
        record(namespaces, node.left.property.name, fileIdx, name, dups, "命名空间导出");
      }
      for (const key of Object.keys(node)) {
        if (["loc", "range", "start", "end"].includes(key)) continue;
        const value = node[key];
        if (Array.isArray(value) || (value && typeof value === "object" && typeof value.type === "string")) {
          stack.push(value);
        }
      }
    }
  });

  assert.deepEqual(dups, [], "跨文件重名（全局互相覆盖，必须消除）");

  // ---- 第二遍：加载期引用检查（函数体延迟引用豁免） ----
  const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
  const violations = [];

  function checkRef(fileIdx, fileName, refName, deferred) {
    if (deferred) return;
    // 遮蔽豁免：运行时标识符按「就近绑定」解析，只要本文件任何层级绑定过同名
    // 名字，该引用就不会落到其他文件的顶层声明上（IIFE 私有实现、命名空间别名
    // 都属此类）。这是粗粒度豁免：文件内部自身的 TDZ 类错误不在此测试覆盖范围，
    // 由真实运行验证；本测试专管跨文件加载顺序这一盲区。
    if (selfBound.get(fileIdx)?.has(refName)) return;
    const declFile = declarations.get(refName);
    if (declFile !== undefined && declFile > fileIdx) {
      violations.push(`${fileName}（#${fileIdx}）加载期引用了后置文件 ${manifest[declFile]}（#${declFile}）的顶层声明 \`${refName}\``);
    }
    const nsFile = namespaces.get(refName);
    if (nsFile !== undefined && nsFile > fileIdx) {
      violations.push(`${fileName}（#${fileIdx}）加载期引用了后置文件 ${manifest[nsFile]}（#${nsFile}）导出的命名空间 \`${refName}\``);
    }
  }

  function visit(node, parent, deferred, fileIdx, fileName) {
    if (!node || typeof node.type !== "string") return;
    switch (node.type) {
      case "Identifier": {
        if (parent) {
          if (parent.type === "MemberExpression" && parent.property === node && !parent.computed) return;
          if ((parent.type === "Property" || parent.type === "PropertyDefinition")
            && parent.key === node && !parent.computed && !parent.shorthand) return;
          if (parent.type === "VariableDeclarator" && parent.id === node) return;
          if (FUNCTION_TYPES.has(parent.type) && parent.id === node) return;
          if (parent.type === "ClassDeclaration" || parent.type === "ClassExpression") {
            if (parent.id === node) return;
          }
          if (parent.type === "CatchClause" && parent.param === node) return;
          if (parent.type === "ObjectPattern" || parent.type === "ArrayPattern" || parent.type === "RestElement") return;
          if (parent.type === "AssignmentPattern" && parent.left === node) return;
          if (parent.type === "LabeledStatement" || parent.type === "BreakStatement" || parent.type === "ContinueStatement") return;
        }
        checkRef(fileIdx, fileName, node.name, deferred);
        return;
      }
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression": {
        const isCallee = parent?.type === "CallExpression" && parent.callee === node;
        // IIFE 在其所在上下文立即执行：加载期 IIFE 体按加载期检查；
        // 其余函数体延迟执行，豁免顺序检查。
        visitFunction(node, isCallee ? deferred : true, fileIdx, fileName);
        return;
      }
      case "ClassDeclaration":
      case "ClassExpression": {
        if (node.superClass) visit(node.superClass, node, deferred, fileIdx, fileName);
        visit(node.body, node, true, fileIdx, fileName); // 方法体延迟；类字段宽松处理
        return;
      }
      case "MethodDefinition":
      case "PropertyDefinition": {
        if (node.computed) visit(node.key, node, deferred, fileIdx, fileName);
        visit(node.value, node, true, fileIdx, fileName);
        return;
      }
      case "Property": {
        if (node.computed) visit(node.key, node, deferred, fileIdx, fileName);
        visit(node.value, node, deferred, fileIdx, fileName);
        return;
      }
      case "MemberExpression": {
        visit(node.object, node, deferred, fileIdx, fileName);
        if (node.computed) visit(node.property, node, deferred, fileIdx, fileName);
        return;
      }
      default: {
        for (const key of Object.keys(node)) {
          if (["loc", "range", "start", "end"].includes(key)) continue;
          const value = node[key];
          if (Array.isArray(value)) {
            for (const child of value) {
              if (child && typeof child.type === "string") visit(child, node, deferred, fileIdx, fileName);
            }
          } else if (value && typeof value === "object" && typeof value.type === "string") {
            visit(value, node, deferred, fileIdx, fileName);
          }
        }
      }
    }

    function visitFunction(fn, bodyDeferred, idx, file) {
      for (const param of fn.params ?? []) {
        if (param.type === "Identifier") continue; // 绑定名，非引用
        visit(param, fn, bodyDeferred, idx, file); // 解构模式：默认值表达式会作为引用检查
      }
      visit(fn.body, fn, bodyDeferred, idx, file);
    }
  }

  programs.forEach((program, fileIdx) => {
    for (const stmt of program.body) {
      visit(stmt, program, false, fileIdx, manifest[fileIdx]);
    }
  });

  const summary = manifest
    .map((name, i) => {
      const decls = [...declarations.entries()].filter(([, f]) => f === i).length;
      const ns = [...namespaces.entries()].filter(([, f]) => f === i).length;
      return `  #${i} ${name.padEnd(24)} 顶层声明 ${decls}  命名空间导出 ${ns}`;
    })
    .join("\n");
  console.log(`清单顺序审计（${manifest.length} 个文件）：\n${summary}`);

  assert.deepEqual(
    violations,
    [],
    `清单顺序违反（后置文件的全局在加载期不可用）：\n  ${violations.slice(0, 10).join("\n  ")}`,
  );
});
