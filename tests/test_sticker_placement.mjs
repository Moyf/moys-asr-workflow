import { loadEditorModule } from './helpers/editor-module-loader.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const context = { window: {}, Uint8Array };
loadEditorModule(context, 'shared/editor-utils.js');
const { computeStickerCuePlacements } = context.window.AsrEditorUtils;

// 假排版计划：一条非 legacy 主字幕句 [0,2000]，锚点由 piece 根 + offset 合成。
// assStackFrame 语义：anchor = pieceRoot@t + offset×scale；rect 相对锚点（含墨盒 padding）。
function makePlan({ fontSize = 60, legacy = false, manual = false, move = false } = {}) {
  const from = { x: 900, y: 900 };
  const to = move ? { x: 1100, y: 900 } : from;
  return {
    slices: [{
      start: 0, end: 2000, legacy, scale: 1, height: 1080, diagnostic: '',
      pieces: [{ start: 0, end: 2000, instant: null, from, to }],
      items: [{
        role: 'main', start: 0, end: 2000, fontSize, cueScale: 1,
        alignment: 2, manual, absolute: false,
        offset: { x: 20, y: -10 },
        rect: { left: -30, top: -80, right: 500, bottom: 10 },
      }],
    }],
  };
}

const FIXED_BOX = { x: 1400, y: 80, width: 460, height: 324 };

// 同一句跨多个布局 slice，保留整句 item 时间，用真实 assStackFrame 取几何。
function makeSlicedPlan(layouts) {
  const plan = makePlan();
  const cueEnd = layouts[layouts.length - 1].end;
  plan.slices = layouts.map(({ start, end, x = 900, toX = x }) => {
    const slice = makePlan().slices[0];
    slice.start = start;
    slice.end = end;
    slice.items[0].end = cueEnd;
    slice.pieces = [{ start, end, instant: null,
      from: { x, y: 900 }, to: { x: toX, y: 900 } }];
    return slice;
  });
  return plan;
}

test('short layout slices retain their own geometry instead of shifting the earlier midpoint', () => {
  const plan = makeSlicedPlan([
    { start: 0, end: 100, x: 900 },
    { start: 100, end: 140, x: 1100 },
    { start: 140, end: 180, x: 1200 },
    { start: 180, end: 220, x: 1300 },
  ]);
  const placements = computeStickerCuePlacements({
    plan, fixedBox: FIXED_BOX, windows: [{ rel: 'a.png', start: 0, end: 220 }],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(placements.map(({ x, align, intervals }) => ({ x, align, intervals })))), [
    { x: 643, align: 'right', intervals: [{ start: 0, end: 100 }] },
    { x: 843, align: 'right', intervals: [{ start: 100, end: 140 }] },
    { x: 943, align: 'right', intervals: [{ start: 140, end: 180 }] },
    { x: 1043, align: 'right', intervals: [{ start: 180, end: 220 }] },
  ]);
});

test('consecutive short leading slices preserve the entire sticker window', () => {
  const plan = makeSlicedPlan([
    { start: 0, end: 40 }, { start: 40, end: 80 }, { start: 80, end: 200 },
  ]);
  const placements = computeStickerCuePlacements({
    plan, fixedBox: FIXED_BOX, windows: [{ rel: 'a.png', start: 0, end: 200 }],
  });
  assert.equal(placements.length, 1);
  assert.equal(placements[0].x, 643);
  assert.deepEqual(JSON.parse(JSON.stringify(placements[0].intervals)), [
    { start: 0, end: 40 }, { start: 40, end: 80 }, { start: 80, end: 200 },
  ]);
});

test('a cue crossing static and moving slices uses the current slice for fallback', () => {
  const plan = makeSlicedPlan([
    { start: 0, end: 1000 }, { start: 1000, end: 2000, toX: 1100 },
  ]);
  const placements = computeStickerCuePlacements({
    plan, fixedBox: FIXED_BOX, windows: [{ rel: 'a.png', start: 0, end: 2000 }],
  });
  assert.equal(placements.length, 2);
  assert.equal(placements[0].x, 643);
  assert.equal(placements[0].align, 'right');
  assert.deepEqual(JSON.parse(JSON.stringify(placements[0].intervals)), [{ start: 0, end: 1000 }]);
  assert.equal(placements[1].x, FIXED_BOX.x);
  assert.equal(placements[1].align, 'center');
  assert.deepEqual(JSON.parse(JSON.stringify(placements[1].intervals)), [{ start: 1000, end: 2000 }]);
});

test('cue-left places the target box right edge before the cue ink box', () => {
  const plan = makePlan();
  const placements = computeStickerCuePlacements({
    plan, fixedBox: FIXED_BOX, windows: [{ rel: 'a.png', start: 500, end: 1500 }],
  });
  assert.equal(placements.length, 1);
  const box = placements[0];
  // fontSizePx=60 → gap=max(4, round(60×0.12))=7，目标框 240×90。
  // inkLeft = (900+20) + (-30)×1 = 890 → x = 890 − 7 − 240 = 643。
  assert.equal(box.x, 643);
  // centerY = (900−10) + (−80+10)/2 = 855 → y = 855 − 45 = 810。
  assert.equal(box.y, 810);
  assert.equal(box.width, 240);
  assert.equal(box.height, 90);
  assert.equal(JSON.stringify(box.intervals), JSON.stringify([{ start: 500, end: 1500 }]));
});

test('windows across two cues split into per-cue placements', () => {
  const plan = makePlan();
  plan.slices.push({
    start: 2000, end: 4000, legacy: false, scale: 1, height: 1080, diagnostic: '',
    pieces: [{ start: 2000, end: 4000, instant: null, from: { x: 700, y: 800 }, to: { x: 700, y: 800 } }],
    items: [{
      role: 'main', start: 2000, end: 4000, fontSize: 60, cueScale: 1,
      alignment: 2, manual: false, absolute: false,
      offset: { x: 20, y: -10 },
      rect: { left: -30, top: -80, right: 500, bottom: 10 },
    }],
  });
  const placements = computeStickerCuePlacements({
    plan, fixedBox: FIXED_BOX, windows: [{ rel: 'a.png', start: 1000, end: 3000 }],
  });
  assert.equal(placements.length, 2);
  assert.equal(JSON.stringify(placements[0].intervals), JSON.stringify([{ start: 1000, end: 2000 }]));
  assert.equal(JSON.stringify(placements[1].intervals), JSON.stringify([{ start: 2000, end: 3000 }]));
  // 第二句组根在 (700,800)：inkLeft = 720 − 30 = 690 → x = 690 − 7 − 240 = 443。
  assert.equal(placements[1].x, 443);
  assert.notEqual(placements[0].x, placements[1].x);
});

test('window in a cue gap falls back to the fixed box', () => {
  const plan = makePlan();
  plan.slices[0].items[0].start = 1000;
  const placements = computeStickerCuePlacements({
    plan, fixedBox: FIXED_BOX, windows: [{ rel: 'a.png', start: 0, end: 800 }],
  });
  assert.equal(placements.length, 1);
  assert.equal(placements[0].x, FIXED_BOX.x);
  assert.equal(placements[0].y, FIXED_BOX.y);
  assert.equal(JSON.stringify(placements[0].intervals), JSON.stringify([{ start: 0, end: 800 }]));
});

test('legacy slices fall back to the fixed box', () => {
  const plan = makePlan({ legacy: true });
  const placements = computeStickerCuePlacements({
    plan, fixedBox: FIXED_BOX, windows: [{ rel: 'a.png', start: 500, end: 1500 }],
  });
  assert.equal(placements.length, 1);
  assert.equal(placements[0].x, FIXED_BOX.x);
});

test('moving cues fall back to the fixed box instead of a midpoint snapshot', () => {
  // 线性移动段（from→to）内字幕位置连续变化，中点快照的固定贴放会在窗口
  // 内漂移甚至压字——整段回退固定位置。
  const plan = makePlan({ move: true });
  const placements = computeStickerCuePlacements({
    plan, fixedBox: FIXED_BOX, windows: [{ rel: 'a.png', start: 0, end: 2000 }],
  });
  assert.equal(placements.length, 1);
  assert.equal(placements[0].x, FIXED_BOX.x);
  assert.equal(placements[0].y, FIXED_BOX.y);
  assert.equal(placements[0].align, 'center');
  assert.deepEqual(JSON.parse(JSON.stringify(placements[0].intervals)),
    [{ start: 0, end: 2000 }]);
});

test('instant piece boundaries split the window so each side is placed statically', () => {
  // 方案瞬切（instant piece）：字幕在 t=1000 从 x=900 跳到 x=1100，瞬切点
  // 作为切段边界，前后段各自贴放（段内位置恒定，快照准确）。
  const plan = makePlan();
  plan.slices[0].pieces = [
    { start: 0, end: 1000, instant: 1000, from: { x: 900, y: 900 }, to: { x: 1100, y: 900 } },
    { start: 1000, end: 2000, instant: null, from: { x: 1100, y: 900 }, to: { x: 1100, y: 900 } },
  ];
  const placements = computeStickerCuePlacements({
    plan, fixedBox: FIXED_BOX, windows: [{ rel: 'a.png', start: 200, end: 1800 }],
  });
  const right = placements.filter(placement => placement.align === 'right');
  assert.equal(right.length, 2, JSON.stringify(placements));
  // 前段（x=900 根）：inkLeft = 920 − 30 = 890 → x = 890 − 7 − 240 = 643。
  assert.equal(right[0].x, 643);
  // 后段（x=1100 根）：inkLeft = 1120 − 30 = 1090 → x = 1090 − 7 − 240 = 843。
  assert.equal(right[1].x, 843);
  assert.deepEqual(JSON.parse(JSON.stringify(right[0].intervals)), [{ start: 200, end: 1000 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(right[1].intervals)), [{ start: 1000, end: 1800 }]);
});

test('extended sticker windows of one rel merge instead of double-burning', () => {
  // 扩展表情包：head + sticker_ref 会为同一 rel 产出重复窗口（都是 head 的
  // 区间）。合并后只贴一次，不再出现「第一张贴字幕、其余落固定位置」的双显。
  const plan = makePlan();
  const placements = computeStickerCuePlacements({
    plan, fixedBox: FIXED_BOX,
    windows: [
      { rel: 'a.png', start: 0, end: 2000 },
      { rel: 'a.png', start: 0, end: 2000 },
      { rel: 'a.png', start: 0, end: 2000 },
    ],
  });
  const right = placements.filter(placement => placement.align === 'right');
  const fallback = placements.filter(placement => placement.align === 'center');
  assert.equal(right.length, 1, JSON.stringify(placements));
  assert.equal(fallback.length, 0, JSON.stringify(placements));
  assert.deepEqual(JSON.parse(JSON.stringify(right[0].intervals)), [{ start: 0, end: 2000 }]);
});

test('overlapping windows keep only the first on the cue and fall back the rest', () => {
  const plan = makePlan();
  const placements = computeStickerCuePlacements({
    plan, fixedBox: FIXED_BOX,
    windows: [
      { rel: 'a.png', start: 500, end: 1500 },
      { rel: 'b.png', start: 1000, end: 1800 },
    ],
  });
  const cueLeft = placements.filter(placement => placement.x === 643);
  const fallback = placements.filter(placement => placement.x === FIXED_BOX.x);
  assert.equal(cueLeft.length, 1);
  assert.equal(cueLeft[0].rel, 'a.png');
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].rel, 'b.png');
});

test('same-co placements of one rel merge intervals', () => {
  const plan = makePlan();
  const placements = computeStickerCuePlacements({
    plan, fixedBox: FIXED_BOX,
    windows: [
      { rel: 'a.png', start: 100, end: 900 },
      { rel: 'a.png', start: 1100, end: 1900 },
    ],
  });
  // 两段同在一句内、同一几何 → 合并为一个 placement，两段区间。
  assert.equal(placements.length, 1);
  assert.equal(JSON.stringify(placements[0].intervals),
    JSON.stringify([{ start: 100, end: 900 }, { start: 1100, end: 1900 }]));
});

test('left placement that would exit the frame falls back', () => {
  const plan = makePlan();
  plan.slices[0].items[0].offset = { x: -1200, y: -10 };
  const placements = computeStickerCuePlacements({
    plan, fixedBox: FIXED_BOX, windows: [{ rel: 'a.png', start: 500, end: 1500 }],
  });
  assert.equal(placements.length, 1);
  assert.equal(placements[0].x, FIXED_BOX.x);
});

test('window splits at slice boundaries because layout changes there', () => {
  // 同一主句 [0,4000] 被叠加字幕出现切成两个 slice：[0,2000] legacy、
  // [2000,4000] 堆叠（同句 item 起止相同）。窗口 [1000,3000] 必须按 slice
  // 边界切段：legacy 段回退固定位置，堆叠段贴字幕。
  const legacySlice = {
    start: 0, end: 2000, legacy: true, scale: 1, height: 1080, diagnostic: '',
    pieces: [{ start: 0, end: 2000 }],
    items: [{
      role: 'main', start: 0, end: 4000, fontSize: 60, cueScale: 1,
      alignment: 2, manual: false, absolute: false,
      offset: { x: 20, y: -10 },
      rect: { left: -30, top: -80, right: 500, bottom: 10 },
    }],
  };
  const stackedSlice = {
    start: 2000, end: 4000, legacy: false, scale: 1, height: 1080, diagnostic: '',
    pieces: [{ start: 2000, end: 4000, instant: null, from: { x: 900, y: 900 }, to: { x: 900, y: 900 } }],
    items: [{
      role: 'main', start: 0, end: 4000, fontSize: 60, cueScale: 1,
      alignment: 2, manual: false, absolute: false,
      offset: { x: 20, y: -10 },
      rect: { left: -30, top: -80, right: 500, bottom: 10 },
    }],
  };
  const plan = { slices: [legacySlice, stackedSlice], width: 1920, height: 1080 };
  const placements = computeStickerCuePlacements({
    plan, fixedBox: FIXED_BOX, windows: [{ rel: 'a.png', start: 1000, end: 3000 }],
  });
  const fallback = placements.filter(placement => placement.x === FIXED_BOX.x && placement.align === 'center');
  const cueLeft = placements.filter(placement => placement.align === 'right');
  assert.equal(fallback.length, 1, JSON.stringify(placements));
  assert.deepEqual(JSON.parse(JSON.stringify(fallback[0].intervals)), [{ start: 1000, end: 2000 }]);
  assert.equal(cueLeft.length, 1, JSON.stringify(placements));
  assert.deepEqual(JSON.parse(JSON.stringify(cueLeft[0].intervals)), [{ start: 2000, end: 3000 }]);
});

test('sticker box taller than the space above a top cue falls back instead of negative y', () => {
  // 顶行字幕（anchor.y=120）+ 90 高的表情包框 → y = 120 − 45 = 75 ≥ 0 仍可贴；
  // 把框加高（fontSize 大）后 y < 0 必须回退而不是发出服务端会拒绝的负坐标。
  const plan = makePlan({ fontSize: 60 });
  plan.width = 1920;
  plan.height = 1080;
  plan.slices[0].items[0].anchorCandidates = undefined;
  plan.slices[0].items[0].offset = { x: 20, y: -60 }; // centerY ≈ 840-… 先验证常规分支
  const okPlacements = computeStickerCuePlacements({
    plan, fixedBox: FIXED_BOX, windows: [{ rel: 'a.png', start: 500, end: 1500 }],
  });
  assert.equal(okPlacements.length, 1);
  assert.ok(okPlacements[0].y >= 0);
  // 顶部字幕：anchor.y = 60，墨盒中心 ≈ 60 − 35 = 25 → y = 25 − 45 = −20 < 0 → 回退。
  const topPlan = makePlan({ fontSize: 60 });
  topPlan.width = 1920;
  topPlan.height = 1080;
  topPlan.slices[0].pieces = [{ start: 0, end: 2000, instant: null, from: { x: 900, y: 60 }, to: { x: 900, y: 60 } }];
  const topPlacements = computeStickerCuePlacements({
    plan: topPlan, fixedBox: FIXED_BOX, windows: [{ rel: 'a.png', start: 500, end: 1500 }],
  });
  assert.equal(topPlacements.length, 1);
  assert.equal(topPlacements[0].x, FIXED_BOX.x);
  assert.equal(topPlacements[0].align, 'center');
});

// === 多句绑定表情包：写入路径与预览区间契约 ===
// 真实模块源码装入最小桩环境：分配（editor-sticker-picker）→ 区间同步
// （editor-text-cleanup）→ 预览区间读取（editor-sticker-overlay）。

function stubElement() {
  return {
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: {}, dataset: {},
    appendChild() {}, addEventListener() {}, setAttribute() {},
  };
}

function loadEditorSource(context, relative) {
  const file = fileURLToPath(new URL(`../web/${relative}`, import.meta.url));
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: relative });
}

function stickerBindingContext(segments) {
  // window 自引用：模块把 facade 注册到 window，浏览器里 window 属性同时是
  // 裸全局；桩环境用同一个对象充当 context 全局与 window，两种查找都命中。
  const context = {
    window: null,
    document: {
      createElement: stubElement,
      getElementById: stubElement,
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    confirm: () => false,
    setTimeout: () => 0,
    // stickerTargetTrack 由 editor-wiring-overlay-actions.js 以顶层 let 声明（跨
    // 文件全局词法绑定）；桩环境里用上下文属性等价替代。
    stickerTargetTrack: 'main',
    activeStickerHasOverlay: false,
    getOverlayTrack: () => null,
    MaweBoot: { DATA: { segments }, STICKERS: [] },
    MaweCommands: { run: (label, mutate) => mutate({ commit() {} }) },
    MaweSelection: { stickerUrl: () => 'about:blank#sticker' },
    MaweSettings: { EDITOR_SETTINGS: { cueListShowSticker: true, cueEditorShowSticker: true } },
    MaweColorFilter: { refreshStickerAssignmentUi() {} },
    MaweHint: { flashHint() {} },
    MaweState: { markProjectDirty() {} },
    MaweDom: { stickerModal: stubElement(), stickerPreviewModal: stubElement() },
  };
  context.window = context;
  return context;
}

test('multi-sentence sticker binding covers every bound cue without a drag', () => {
  const segments = [
    { id: 'main-001', start: 0, end: 1000, text: '第一句' },
    { id: 'main-002', start: 1000, end: 2600, text: '第二句' },
  ];
  const sticker = { name: 'bind', filename: 'bind.png', rel: 'bind.png' };
  const binding = stickerBindingContext(segments);
  loadEditorSource(binding, 'editor/cues/editor-text-cleanup.js');
  loadEditorSource(binding, 'editor/cues/editor-sticker-picker.js');
  loadEditorSource(binding, 'editor/media/editor-sticker-overlay.js');

  binding.MaweBoot.STICKERS = [sticker];
  binding.window.MaweStickerPicker.openStickerPicker([0, 1], true);
  binding.window.MaweStickerPicker.assignSticker(sticker);

  // 写入契约：head.sticker 覆盖整个选区（与 syncTimelineGroupRanges、
  // 延长表情包、标记颜色一致），ref 成员指向 head。
  assert.deepEqual(
    { start: segments[0].sticker.start, end: segments[0].sticker.end, name: segments[0].sticker.name },
    { start: 0, end: 2600, name: 'bind' },
  );
  assert.equal(segments[1].sticker, null);
  assert.deepEqual({ ...segments[1].sticker_ref }, { name: 'bind', headIdx: 0 });

  // 预览读取契约：不做任何拖动，第二句时间点就命中表情包区间。
  const overlay = binding.window.MaweStickerOverlay;
  assert.equal(overlay.activeStickersAt(500).length, 1);
  assert.equal(overlay.activeStickersAt(1500).length, 1);
  assert.equal(overlay.activeStickersAt(2700).length, 0);
});

test('rebinding a single head that owns references re-syncs the group range', () => {
  const segments = [
    { id: 'main-001', start: 0, end: 1000, text: '第一句' },
    { id: 'main-002', start: 1000, end: 2600, text: '第二句',
      sticker_ref: { name: 'old', headIdx: 0 } },
  ];
  segments[0].sticker = { name: 'old', filename: 'old.png', rel: 'old.png', start: 0, end: 1000 };
  const sticker = { name: 'next', filename: 'next.png', rel: 'next.png' };
  const binding = stickerBindingContext(segments);
  loadEditorSource(binding, 'editor/cues/editor-text-cleanup.js');
  loadEditorSource(binding, 'editor/cues/editor-sticker-picker.js');

  binding.MaweBoot.STICKERS = [sticker];
  binding.window.MaweStickerPicker.openStickerPicker([0], false);
  binding.window.MaweStickerPicker.assignSticker(sticker);

  // 单选重分配 head：既有 ref 仍指向它，区间必须回到整组覆盖，而不是丢掉
  // start/end 后回落到 head 自身句范围。
  assert.deepEqual(
    { start: segments[0].sticker.start, end: segments[0].sticker.end, name: segments[0].sticker.name },
    { start: 0, end: 2600, name: 'next' },
  );
  assert.deepEqual({ ...segments[1].sticker_ref }, { name: 'next', headIdx: 0 });
});
