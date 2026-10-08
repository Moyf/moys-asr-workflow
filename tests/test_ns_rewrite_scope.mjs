// ns-rewrite-editor 作用域内核回归测试。
//
// 背景：旧版 ns-rewrite 用手工作域链改写 editor.js 中的裸引用为 NS.name，
// 只覆盖 Program/Function/Block 三种作用域，for 头部声明、catch 参数、
// 嵌套块内 var 提升等绑定形态漏收，导致局部名被误 NS 化（静默行为回归，
// 第五次 main 同步期间复发三轮）。v2 换用 eslint-scope 解析全部绑定形态，
// 本测试把「哪些形态必须保持局部、哪些形态必须限定」固化为不变量：
//
//   A. 保持局部（不得改写）：for-of/for-in 头部声明、嵌套块内 var 提升、
//      catch 参数、body 顶层 let/const（含被嵌套箭头引用）、同文件自有声明、
//      成员访问属性位、对象非 shorthand 键、声明位置；
//   B. 必须限定：未解析的跨模块裸引用、参数默认值表达式、对象 shorthand 值；
//   C. 幂等：对改写输出再跑一遍，零新增改写；
//   D. 自检：输出重解析后，未解析引用 ∩ 导出面 = ∅。

import { test } from "node:test";
import assert from "node:assert/strict";
import { rewriteSource } from "../scripts/refactor-tools/ns-rewrite-editor.mjs";

const NAME_NS = new Map([
  ["start", "MAWE_I18N"],
  ["snapshotSegments", "MAWE_I18N"],
  ["render", "MAWE_VIEW"],
  ["buildSrtPayload", "AsrEditorUtils"],
]);

function rewrite(src) {
  return rewriteSource(src, NAME_NS);
}

test("for-of 头部声明的 start 保持局部（旧版误改写形态 1）", () => {
  const { output, edits } = rewrite(`const SEG = [];
for (const start of SEG) {
  queue.push(() => push(start));
}
`);
  assert.equal(output, `const SEG = [];
for (const start of SEG) {
  queue.push(() => push(start));
}
`);
  assert.deepEqual(edits, []);
});

test("嵌套块内 var 提升后可见，保持局部（旧版误改写形态 2）", () => {
  const { edits } = rewrite(`function f(list) {
  if (list.length) {
    var snapshotSegments = build(list);
  }
  use(snapshotSegments);
}
`);
  assert.deepEqual(edits, []);
});

test("catch 参数保持局部（旧版误改写形态 3）", () => {
  const { edits } = rewrite(`try { run(); } catch (start) {
  log(start);
}
`);
  assert.deepEqual(edits, []);
});

test("body 顶层 const 被嵌套箭头引用，保持局部（台账描述形态，双向钉住）", () => {
  const { edits } = rewrite(`function bind(el) {
  const start = now();
  el.addEventListener("x", () => renderAt(start));
}
`);
  assert.deepEqual(edits, []);
});

test("未解析的跨模块裸引用必须限定", () => {
  const { output, edits } = rewrite(`function draw() {
  render(SEG);
}
`);
  assert.equal(output, `function draw() {
  MAWE_VIEW.render(SEG);
}
`);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].name, "render");
  assert.equal(edits[0].ns, "MAWE_VIEW");
});

test("参数默认值表达式必须限定（默认值在模块作用域求值）", () => {
  const { output } = rewrite(`function build(x = buildSrtPayload(SEG)) {
  return x;
}
`);
  assert.equal(output, `function build(x = AsrEditorUtils.buildSrtPayload(SEG)) {
  return x;
}
`);
});

test("对象 shorthand 值必须限定为 key: NS.name 形态", () => {
  const { output, edits } = rewrite(`const opts = { start, end: 1 };
`);
  assert.equal(output, `const opts = { start: MAWE_I18N.start, end: 1 };
`);
  assert.equal(edits[0].form, "shorthand");
});

test("对象非 shorthand 键不改写，值位裸引用改写", () => {
  const { output } = rewrite(`const opts = { render: render, prop: box.start };
`);
  assert.equal(output, `const opts = { render: MAWE_VIEW.render, prop: box.start };
`);
});

test("同文件自有声明遮蔽导出面，不改写", () => {
  const { edits } = rewrite(`const start = 0;
function f() {
  return start + 1;
}
`);
  assert.deepEqual(edits, []);
});

test("成员访问属性位与标签不改写", () => {
  const { edits } = rewrite(`function f() {
  loop: for (;;) { break loop; }
  return box.snapshotSegments;
}
`);
  assert.deepEqual(edits, []);
});

test("幂等：对输出再跑一遍零新增改写", () => {
  const once = rewrite(`function f(list) {
  for (const start of list) render(start);
  return { snapshotSegments };
}
`);
  const twice = rewrite(once.output);
  assert.deepEqual(twice.edits, []);
  assert.equal(twice.output, once.output);
});

test("自检：输出重解析后未解析引用 ∩ 导出面 = ∅", () => {
  const { selfCheck } = rewrite(`function f(list) {
  for (const start of list) render(start);
}
`);
  assert.equal(selfCheck.ok, true);
  assert.deepEqual(selfCheck.leftoverNames, []);
});
