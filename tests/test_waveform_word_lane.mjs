// 单行双语行叠加轨回归修复：分层判定真源 visibility.wordTimingFullLane。
// 覆盖三件事：
// 1. 单行（basic）波形 × 双语开/关的字词分层判定一致（回归核心：旧内联条件
//    在双语行强制走紧凑布局，叠加块被拽离 50% 线、气泡消失）；
// 2. 多行（multi）旧语义不回退（双语行 / 行高不足仍走紧凑）；
// 3. drawWordChips 门对单行双语行放行（气泡照画，条带几何从 computed style
//    读取），以及 waveform.css 的单行双语行条带 / 叠加块定位契约。
import { loadEditorModule } from './helpers/editor-module-loader.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';


const root = fileURLToPath(new URL('../', import.meta.url));
const css = fs.readFileSync(path.join(root, 'web', 'waveform.css'), 'utf8');

const waveContext = {
  window: {
    // waveform.js 顶部只需要最小 palette fixture（同 test_editor_markers.mjs）。
    ASR_EDITOR_PALETTE: [
      { name: 'yellow', value: '#c4a019' },
      { name: 'green', value: '#66bb6a' },
      { name: 'red', value: '#f07f6f' },
      { name: 'purple', value: '#bf89e6' },
      { name: 'blue', value: '#61a7fa' },
    ],
  },
  // drawWordChips 读条带/标签的 computed style（bottom/height 是解析后的 px）。
  getComputedStyle: (element) => element.__style,
};
loadEditorModule(waveContext, 'editor/media/waveform.js');
const testing = waveContext.window.AsrWaveform.testing;


test('wordTimingFullLane：单行波形双语开/关都走 full 分层（回归核心）', () => {
  const fullLane = testing.wordTimingFullLane;
  // 单行模式恒 full：双语只增补底部译文格，不改变叠加轨与条带布局。
  assert.equal(fullLane(true, 'basic', 699, true), true);
  assert.equal(fullLane(true, 'basic', 699, false), true);
  // 单行短窗格同样 full（行高兜底交给 CSS max()，不由判定承担）。
  assert.equal(fullLane(true, 'basic', 180, true), true);
  // 字词码关闭恒 false。
  assert.equal(fullLane(false, 'basic', 699, true), false);
  assert.equal(fullLane(false, 'multi', 192, false), false);
});

test('wordTimingFullLane：多行波形旧语义不回退', () => {
  const fullLane = testing.wordTimingFullLane;
  assert.equal(fullLane(true, 'multi', 192, true), false);   // 双语行 → 紧凑
  assert.equal(fullLane(true, 'multi', 192, false), true);   // 非双语 ≥96 → full
  assert.equal(fullLane(true, 'multi', 96, false), true);
  assert.equal(fullLane(true, 'multi', 95, true), false);    // 行高不足 → 紧凑
  assert.equal(fullLane(true, 'multi', 95, false), false);
});

// drawWordChips 的门测试：querySelectorAll 记录调用即证明门放行
// （旧代码在 multi-subtitle-row 上提前 return，查询不会发生）。
// mock 提供真实 classList：旧提前 return 走「查询未发生」断言路径失败，
// 而不是缺 classList 的 TypeError——保证断言本身有判别力。
function makeChipRow() {
  const calls = [];
  return {
    calls,
    row: {
      dataset: { basic: 'true' },
      classList: { contains: () => true },
      querySelectorAll: (selector) => { calls.push(selector); return []; },
    },
  };
}

test('drawWordChips：单行双语行门放行，能走到字词块查询', () => {
  const { calls, row } = makeChipRow();
  testing.drawWordChips.call(
    { options: { wordTiming: { enabled: true } }, settings: { mode: 'basic' } },
    row, null, 800, 300, 0, 10000);
  assert.deepEqual(calls, ['.waveform-word-block.word-timing-full']);
});

test('drawWordChips：多行模式与字词码关不到查询（门照旧拦住）', () => {
  const multi = makeChipRow();
  testing.drawWordChips.call(
    { options: { wordTiming: { enabled: true } }, settings: { mode: 'multi' } },
    multi.row, null, 800, 300, 0, 10000);
  assert.deepEqual(multi.calls, []);

  const disabled = makeChipRow();
  testing.drawWordChips.call(
    { options: { wordTiming: { enabled: false } }, settings: { mode: 'basic' } },
    disabled.row, null, 800, 300, 0, 10000);
  assert.deepEqual(disabled.calls, []);
});

test('drawWordChips：单行双语行气泡照画，条带几何来自 computed style', () => {
  // 模拟双语单行行的 full 条带（waveform.css 契约值）：699px 行、
  // lane 54px → 条带 bottom = 7 + 54*2 + 0 + 2 = 117，高 35。
  const label = { textContent: '你好 世界', __style: {
    fontStyle: 'normal', fontWeight: '400', fontSize: '11px', fontFamily: 'sans-serif' } };
  const block = {
    hidden: false,
    __style: { bottom: '117px', height: '35px' },
    style: { left: '10%', width: '20%' },
    querySelector: (selector) => (selector === '.waveform-word-label' ? label : null),
  };
  const row = {
    dataset: { basic: 'true' },
    classList: { contains: () => true },
    querySelectorAll: () => [block],
  };
  let layoutCall = null;
  const self = {
    options: { wordTiming: { enabled: true } },
    settings: { mode: 'basic' },
    currentTimeMs: () => 5000,
    computeWordChipLayout: (items, options) => { layoutCall = { items, options }; return { placed: [], dropped: 0 }; },
    _getWaveColors: () => ({ chipBg: '#fff', chipFg: '#000' }),
  };
  const ctx = { font: '', measureText: (text) => ({ width: text.length * 10 }) };
  testing.drawWordChips.call(self, row, ctx, 800, 300, 0, 10000);
  assert.ok(layoutCall, '单行双语行应走到气泡布局（旧代码提前 return）');
  assert.equal(layoutCall.options.stripTopPx, 117 + 35);
  assert.equal(layoutCall.items.length, 1);
  assert.equal(layoutCall.items[0].text, '你好 世界');
  assert.equal(ctx.font, 'normal 400 11px sans-serif');
});

test('waveform.css：单行双语行条带契约（贴双语主块上方、35px、flex、徽章上移）', () => {
  // 只取该规则自身的选择器块（到下一个 "\n}"）再断言，保证每条 needle
  // 都落在对应规则里（切到文件尾会让 height/flex 断言失去判别力）。
  const rule = (selector) => {
    const start = css.indexOf(selector);
    assert.ok(start >= 0, `缺少规则: ${selector}`);
    const end = css.indexOf('\n}', start);
    return css.slice(start, end);
  };
  const band = rule('.waveform-basic .waveform-pane.word-timing-mode .waveform-row.multi-subtitle-row '
    + ':is(.waveform-word-block, .waveform-word-boundary).word-timing-full');
  assert.ok(band.includes(
    'bottom: calc(var(--multi-subtitle-bottom-inset) + var(--multi-subtitle-lane-height) * 2 + var(--multi-subtitle-lane-gap) + 2px);'),
    '条带 bottom 应贴双语主块（top = inset + 两格 lane）上方 2px');
  assert.ok(band.includes('height: 35px;'), 'full 条带应与通用条带同为 35px');

  const flexRule = rule('.waveform-basic .waveform-pane.word-timing-mode .waveform-row.multi-subtitle-row .waveform-word-block.word-timing-full');
  assert.ok(flexRule.includes('display: flex;'), 'full 字词块应恢复 flex 布局');
  const labelRule = rule('.waveform-basic .waveform-pane.word-timing-mode .waveform-row.multi-subtitle-row .waveform-word-block.word-timing-full .waveform-word-label');
  assert.ok(labelRule.includes('line-height: normal;'), 'full 字词标签应恢复 line-height normal');

  const badge = rule('.waveform-basic .waveform-pane.word-timing-mode .waveform-row.multi-subtitle-row .waveform-cue-badge.word-timing-full');
  assert.ok(badge.includes('+ 39px + var(--badge-stack-index, 0)'), '组序号徽章应随条带上移（条带顶 + 2px）');
});

test('waveform.css：单行双语行叠加块保持 50% 线（max 兜底），多行规则不变', () => {
  const rule = (selector) => {
    const start = css.indexOf(selector);
    assert.ok(start >= 0, `缺少规则: ${selector}`);
    const end = css.indexOf('\n}', start);
    return css.slice(start, end);
  };
  const overlay = rule('.waveform-basic .waveform-row.multi-subtitle-row .waveform-cue-block.waveform-overlay-block:not(.overlay-cover-mode)');
  assert.ok(overlay.includes(
    'bottom: max(50%, calc(var(--multi-subtitle-bottom-inset) + var(--multi-subtitle-lane-height) * 2 + var(--multi-subtitle-lane-gap) + 1px));'),
    '单行双语行叠加块应恢复 50% 线，行高过矮时以贴格位置兜底');

  const overlayBadge = rule('.waveform-basic .waveform-row.multi-subtitle-row .waveform-cue-badge.waveform-overlay-cue-badge');
  assert.ok(overlayBadge.includes(
    'calc(max(50%, var(--multi-subtitle-bottom-inset) + var(--multi-subtitle-lane-height) * 2 + var(--multi-subtitle-lane-gap) + 1px) + 37px'),
    '叠加徽章应随叠加块同步 max 形式');

  // 多行双语行贴格规则原样保留（回归修复不得波及多行模式）。
  assert.ok(css.includes(
    '.waveform-row.multi-subtitle-row .waveform-cue-block.waveform-overlay-block {\n  bottom: calc(var(--multi-subtitle-bottom-inset) + var(--multi-subtitle-lane-height) * 2 + 1px);'),
    '多行双语行叠加块贴格规则应原样保留');
});

test('分层判定真源收敛：cue-blocks / word-blocks 不再内联旧条件', () => {
  for (const file of [
    'web/editor/media/waveform/cue-blocks.js',
    'web/editor/media/waveform/word-blocks.js',
  ]) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.ok(!source.includes('multiSubtitleVisible?.() !== true'),
      `${file} 应改用 visibility.wordTimingFullLane，不得内联旧分层条件`);
  }
});
