import { loadEditorModule } from './helpers/editor-module-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

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

test('moving cues freeze the position at the segment midpoint', () => {
  const plan = makePlan({ move: true });
  const placements = computeStickerCuePlacements({
    plan, fixedBox: FIXED_BOX, windows: [{ rel: 'a.png', start: 0, end: 2000 }],
  });
  // 中点 t=1000 → 移动进度 0.5 → root.x = 900 + (1100−900)×0.5 = 1000。
  // inkLeft = 1020 − 30 = 990 → x = 990 − 7 − 240 = 743。
  assert.equal(placements[0].x, 743);
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
