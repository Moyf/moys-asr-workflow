// 「字幕」标签显隐双阈值迟滞（账本 #32 评审）的纯函数单测：
// 旧实现「scrollWidth + 96 ≤ clientWidth」因 scrollWidth ≥ clientWidth 恒
// 成立而数学上不可达，标签隐藏后永不恢复；这里钉住新判定的可达性与防抖动。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const text = fs.readFileSync(new URL('../web/editor/cues/editor-cue-list-anchor.js', import.meta.url), 'utf8');
const context = {
  window: {},
  document: {
    getElementById: () => null,
    querySelector: () => null,
    addEventListener: () => {},
  },
};
vm.runInNewContext(text, context, { filename: 'editor-cue-list-anchor.js' });
const resolve = context.window.MaweCueListAnchor.resolveCueListLabelState;

test('hidden label becomes reachable again once the remaining children fit with the cached label width', () => {
  // 工具栏 800px：其余子元素 700px（自然宽），标签缓存 30px，5 个子元素
  // 回归时占 5 个 gap（6px），余量 10px → 770+30 ≤ 800 可重现。
  // 旧实现同参数下 scrollWidth(=clientWidth=800)+96 ≤ 800 恒为假，永不恢复。
  const state = resolve({
    hidden: true, scrollWidth: 800, clientWidth: 800, contentWidth: 800 - 16,
    gap: 6, othersWidth: 700, othersMinWidth: 700, childCount: 5, labelWidth: 30, reserve: 10,
  });
  assert.equal(state, 'show');
});

test('restore uses the compressed floor so flex can re-compress the children', () => {
  // 实测场景：其余子元素自然宽 329（标签隐藏后展开），但隐藏瞬间被压到
  // 129px 的最小占宽——标签回归后 flex 会重新压回去，应按最小占宽判定。
  // 内容盒 360px：最小占宽 129 + 标签 30 + 间隙 12 + 余量 10 = 181 ≤ 360。
  const state = resolve({
    hidden: true, scrollWidth: 800, clientWidth: 800, contentWidth: 360,
    gap: 6, othersWidth: 329, othersMinWidth: 129, childCount: 2, labelWidth: 30, reserve: 10,
  });
  assert.equal(state, 'show', '自然宽放不下但最小占宽放得下 → 重现');
  const tight = resolve({
    hidden: true, scrollWidth: 800, clientWidth: 800, contentWidth: 360,
    gap: 6, othersWidth: 329, othersMinWidth: 320, childCount: 2, labelWidth: 30, reserve: 10,
  });
  // 320 + 30 + 12 + 10 = 372 > 360：最小占宽也放不下 → 保持隐藏
  assert.equal(tight, 'keep-hidden', '最小占宽也放不下 → 保持隐藏');
});

test('hidden label stays hidden while the remaining children still overflow', () => {
  const state = resolve({
    hidden: true, scrollWidth: 900, clientWidth: 800, contentWidth: 800 - 16,
    gap: 6, othersWidth: 880, childCount: 5, labelWidth: 30, reserve: 10,
  });
  assert.equal(state, 'keep-hidden', '其余控件自身溢出时不重现，避免闪烁');
});

test('hidden label stays hidden when the label would not fit with gaps and reserve', () => {
  // 700 + 30 + 30(gap) + 10 = 770 > 760（内容盒）→ 差一点点也不重现
  const state = resolve({
    hidden: true, scrollWidth: 800, clientWidth: 800, contentWidth: 800 - 40,
    gap: 6, othersWidth: 700, othersMinWidth: 700, childCount: 5, labelWidth: 30, reserve: 10,
  });
  assert.equal(state, 'keep-hidden');
});

test('visible label hides only on real overflow and keeps visible otherwise', () => {
  assert.equal(resolve({
    hidden: false, scrollWidth: 900, clientWidth: 800,
  }), 'hide', 'flex 已压到最小仍溢出才隐藏');
  assert.equal(resolve({
    hidden: false, scrollWidth: 800, clientWidth: 800,
  }), 'keep-visible', 'scrollWidth == clientWidth（无溢出）不隐藏');
  assert.equal(resolve({
    hidden: false, scrollWidth: 799, clientWidth: 800,
  }), 'keep-visible');
});
