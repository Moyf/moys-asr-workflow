// merge-flow qualifyDeclaration / qualifyEntry 作用域内核回归测试。
//
// 背景：旧实现用「全子树平面绑定名集合」做豁免（qualifyDeclaration）或
// 完全没有局部作用域处理（qualifyEntry），与 ns-rewrite 旧版同类：
// 局部名遮蔽导出名时被误限定（MAWE_I18N.start ×7 复发三轮），模块内
// 已有同名绑定时误限定，嵌套参数遮蔽时误限定。现以 eslint-scope 的
// 未解析引用为准，本测试固化下列不变量：
//
//   A. 重放体内局部绑定（for-of 头 / var 提升 / catch 参数 / body 顶层
//      const / 参数遮蔽）不得被限定；
//   B. 模块内已有同名绑定的自由引用不得跨模块限定；
//   C. 同命名空间所有者跳过；
//   D. 真自由引用必须限定（含参数默认值表达式、shorthand 值位）；
//   E. 入口自身顶层声明的引用不限定（KEEP 场景）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { qualifyDeclaration, qualifyEntry } from "../tools/merge-flow.mjs";

const OWNER_OF = new Map([
  ["start", { file: "shared/editor-i18n.js", ns: "MAWE_I18N" }],
  ["snapshotSegments", { file: "shared/editor-i18n.js", ns: "MAWE_I18N" }],
  ["render", { file: "editor/cues/editor-nav-preview.js", ns: "MaweNavPreview" }],
  ["pushUndo", { file: "editor/state/editor-history.js", ns: "MaweHistory" }],
]);

test("重放体：for-of 头部局部 start 不限定，自由 render 限定", () => {
  const raw = `function draw(list) {
  for (const start of list) {
    render(start);
  }
}`;
  const out = qualifyDeclaration(raw, OWNER_OF, "MaweOwner");
  assert.equal(out, `function draw(list) {
  for (const start of list) {
    MaweNavPreview.render(start);
  }
}`);
});

test("重放体：嵌套块内 var 提升与 catch 参数不限定", () => {
  const raw = `function f(items) {
  if (items.length) {
    var snapshotSegments = items.slice();
  }
  try { use(snapshotSegments); } catch (start) { log(start); }
}`;
  const out = qualifyDeclaration(raw, OWNER_OF, "MaweOwner");
  assert.equal(out, raw);
});

test("重放体：body 顶层 const 被嵌套箭头引用不限定", () => {
  const raw = `function bind(el) {
  const start = now();
  el.addEventListener("x", () => draw(start));
}`;
  const out = qualifyDeclaration(raw, OWNER_OF, "MaweOwner");
  assert.equal(out, raw);
});

test("模块内已有同名绑定：自由引用解析到模块自身，不跨模块限定", () => {
  const raw = `function f() {
  return start + 1;
}`;
  const out = qualifyDeclaration(raw, OWNER_OF, "MaweOwner", new Set(["start"]));
  assert.equal(out, raw);
});

test("同命名空间所有者跳过", () => {
  const raw = `function f() {
  return render(start);
}`;
  const out = qualifyDeclaration(raw, OWNER_OF, "MaweNavPreview");
  assert.equal(out, `function f() {
  return render(MAWE_I18N.start);
}`);
});

test("shorthand 值位展开为 key: NS.name", () => {
  const raw = `function f() {
  return { snapshotSegments };
}`;
  const out = qualifyDeclaration(raw, OWNER_OF, "MaweOwner");
  assert.equal(out, `function f() {
  return { snapshotSegments: MAWE_I18N.snapshotSegments };
}`);
});

test("参数默认值表达式中的自由引用必须限定", () => {
  const raw = `function build(x = snapshotSegments()) {
  return x;
}`;
  const out = qualifyDeclaration(raw, OWNER_OF, "MaweOwner");
  assert.equal(out, `function build(x = MAWE_I18N.snapshotSegments()) {
  return x;
}`);
});

test("入口：嵌套参数遮蔽导出名不误限定（ns-rewrite 旧版同类事故形态）", () => {
  const entry = `function handler(render) {
  render();
}
function other() {
  render(1);
}`;
  const out = qualifyEntry(entry, OWNER_OF);
  assert.equal(out, `function handler(render) {
  render();
}
function other() {
  MaweNavPreview.render(1);
}`);
});

test("入口：入口自身顶层声明（KEEP）的引用不限定", () => {
  const entry = `const start = performance.now();
function elapsed() {
  return performance.now() - start;
}`;
  const out = qualifyEntry(entry, OWNER_OF);
  assert.equal(out, entry);
});

test("入口：自由引用限定", () => {
  const entry = `function onSegmentsReplaced() {
  pushUndo();
}`;
  const out = qualifyEntry(entry, OWNER_OF);
  assert.equal(out, `function onSegmentsReplaced() {
  MaweHistory.pushUndo();
}`);
});
