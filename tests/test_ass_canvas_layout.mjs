// ass-canvas-layout 纯布局计算的单测：Alignment 网格、锚点、行切分与块偏移。
// 绘制层（editor-wiring-ass-canvas.js）依赖这些纯函数定位所有 ASS 文本，
// 布局错了画布整体就错，因此在 Node 里离线锁定行为。
import { loadEditorModule } from './helpers/editor-module-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

const context = { window: {} };
loadEditorModule(context, 'shared/editor-utils.js');
const h = context.window.AsrEditorUtils;

// 模块在 vm 上下文里创建对象，原型与测试 realm 不同；浅拷贝到测试 realm
// 后再做严格比较。
const same = (actual, expected) => assert.deepEqual({ ...actual }, expected);

const fakeMeasurer = (run, text) => ({
  width: [...text].length * 10,
  ascent: 8,
  descent: 2,
});

test('alignment 网格映射到列/行（屏幕语义：1-3 底行，7-9 顶行）', () => {
  same(h.assCanvasAlignmentGrid(2), { column: 1, row: 2 });
  same(h.assCanvasAlignmentGrid(1), { column: 0, row: 2 });
  same(h.assCanvasAlignmentGrid(3), { column: 2, row: 2 });
  same(h.assCanvasAlignmentGrid(5), { column: 1, row: 1 });
  same(h.assCanvasAlignmentGrid(7), { column: 0, row: 0 });
  same(h.assCanvasAlignmentGrid(9), { column: 2, row: 0 });
  same(h.assCanvasAlignmentGrid(0), { column: 1, row: 2 });
  same(h.assCanvasAlignmentGrid(99), { column: 2, row: 0 });
  same(h.assCanvasAlignmentGrid('abc'), { column: 1, row: 2 });
});

test('锚点按 Alignment 贴边距，\\pos 的 move 坐标直接接管', () => {
  const margins = { left: 10, right: 20, vertical: 88 };
  same(h.assCanvasAnchorPoint({ alignment: 2, margins, playResX: 1920, playResY: 1080 }),
    { x: 960, y: 992 });
  same(h.assCanvasAnchorPoint({ alignment: 1, margins, playResX: 1920, playResY: 1080 }),
    { x: 10, y: 992 });
  same(h.assCanvasAnchorPoint({ alignment: 9, margins, playResX: 1920, playResY: 1080 }),
    { x: 1900, y: 88 });
  same(h.assCanvasAnchorPoint({ alignment: 5, margins, playResX: 1920, playResY: 1080 }),
    { x: 960, y: 540 });
  // \move：锚点就是移动坐标，边距不再参与。
  same(
    h.assCanvasAnchorPoint({ alignment: 2, margins, playResX: 1920, playResY: 1080, move: { x: 500, y: 300 } }),
    { x: 500, y: 300 },
  );
});

test('行切分：跨 run 的 \\N 拆行、行内 x 累计、行高取最大 ascent/descent', () => {
  const layout = h.assCanvasLayoutLines(
    [{ text: 'Hello' }, { text: '\nWorld!' }],
    fakeMeasurer,
  );
  assert.equal(layout.lines.length, 2);
  assert.equal(layout.lines[0].items.length, 1);
  assert.equal(layout.lines[0].items[0].x, 0);
  assert.equal(layout.lines[0].width, 50);
  assert.equal(layout.lines[1].items[0].x, 0);
  assert.equal(layout.lines[1].width, 60);
  assert.equal(layout.blockWidth, 60);
  assert.equal(layout.blockHeight, 20);

  const inline = h.assCanvasLayoutLines(
    [{ text: 'AB' }, { text: 'C' }],
    fakeMeasurer,
  );
  assert.equal(inline.lines.length, 1);
  assert.deepEqual([...inline.lines[0].items.map((item) => item.x)], [0, 20]);
  assert.equal(inline.lines[0].width, 30);

  const midRunBreak = h.assCanvasLayoutLines([{ text: 'A\nB' }], fakeMeasurer);
  assert.equal(midRunBreak.lines.length, 2);
  assert.deepEqual([...midRunBreak.lines.map((line) => line.width)], [10, 10]);
});

test('显式空行按基准 run 行高占位，整条空文本仍为 0 高', () => {
  const interior = h.assCanvasLayoutLines([{ text: 'A\n\nB' }], fakeMeasurer);
  assert.equal(interior.lines.length, 3);
  assert.equal(interior.lines[1].items.length, 0);
  assert.equal(interior.lines[1].ascent, 8);
  assert.equal(interior.lines[1].descent, 2);
  assert.equal(interior.blockHeight, 30);

  const trailing = h.assCanvasLayoutLines([{ text: 'A\n' }], fakeMeasurer);
  assert.equal(trailing.lines.length, 2);
  assert.equal(trailing.blockHeight, 20);

  const empty = h.assCanvasLayoutLines([{ text: '' }], fakeMeasurer);
  assert.equal(empty.lines.length, 1);
  assert.equal(empty.blockWidth, 0);
  assert.equal(empty.blockHeight, 0);
});

test('行偏移与块顶偏移：中列逐行居中、底行块底贴锚点', () => {
  assert.equal(h.assCanvasLineOffsetX(0, 100), 0);
  assert.equal(h.assCanvasLineOffsetX(1, 100), -50);
  assert.equal(h.assCanvasLineOffsetX(2, 100), -100);
  assert.equal(h.assCanvasBlockTopY(2, 30), -30);
  assert.equal(h.assCanvasBlockTopY(1, 30), -15);
  assert.equal(h.assCanvasBlockTopY(0, 30), 0);
});
