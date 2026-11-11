import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import {initModuleSource} from './helpers/init-module-source.mjs';
import { loadEditorModule } from './helpers/editor-module-loader.mjs';
const fixture = { window: {} };
loadEditorModule(fixture, 'shared/editor-utils.js');
const utils = fixture.window.AsrEditorUtils;
const settings = { assMode: true, assEmphasisSyntax: 'both', assSpecialSymbolRule: 'both' };
const context = { window: { AsrEditorUtils: utils }, MULTI_SUBTITLE_UTILS: utils,
  MaweSettings: { EDITOR_SETTINGS: { ...settings } }, MaweMultiSubtitleCore: { SUBTITLE_MIN_DURATION_MS: 100 } };
vm.runInNewContext(initModuleSource('editor/cues/editor-split-core.js'), context);
const core = context.window.MaweSplitCore;
const plain = value => JSON.parse(JSON.stringify(value));
const parts = (text, offset, opts = settings) => plain(core.splitStyledTextParts(text,
  { left: text.slice(0, offset), right: text.slice(offset), offset }, opts));

test('paired markers follow their body when cutting beside or inside the delimiters', () => {
  for (const [left, right] of [['**', '**'], ['++', '++'], ['--', '--'], ['__', '__'], ['~~', '~~'], ['//', '//'], ['%%', '%%']]) {
    const text = `甲${left}乙丙${right}丁`;
    for (const offset of [1, 2, 3]) {
      // 刀点吸附到对之前：无跨刀对，端点闭符号串为空
      assert.deepEqual(parts(text, offset), { left: '甲', right: `${left}乙丙${right}丁`, offset: 1,
        leftClosures: '', rightClosures: '', displayEdits: false });
    }
    for (const offset of [5, 6, 7]) {
      // 刀点吸附到对之后：同样无跨刀对
      assert.deepEqual(parts(text, offset), { left: `甲${left}乙丙${right}`, right: '丁', offset: 7,
        leftClosures: '', rightClosures: '', displayEdits: false });
    }
    // 刀点在对内部：两侧各补齐完整对，端点闭符号串 = 被跨对的符号
    assert.deepEqual(parts(text, 4), { left: `甲${left}乙${right}`, right: `${left}丙${right}丁`, offset: 4,
      leftClosures: right, rightClosures: left, displayEdits: false });
  }
});

test('nested styles close in reverse order and reopen in source order', () => {
  // 刀点同时跨 ** 与 ++ 两对：左端点闭符号按嵌套逆序（内层 ++ 先闭、外层 ** 后闭），
  // 右端点开符号按源序（外层 ** 先开、内层 ++ 后开）
  assert.deepEqual(parts('甲**++乙丙++**丁', 6),
    { left: '甲**++乙++**', right: '**++丙++**丁', offset: 6, leftClosures: '++**', rightClosures: '**++',
      displayEdits: false });
  // 刀点吸附到 ** 开符号之前：两对都完整留在右侧，端点闭符号串为空
  assert.deepEqual(parts('甲**++乙丙++**丁', 5),
    { left: '甲', right: '**++乙丙++**丁', offset: 1, leftClosures: '', rightClosures: '', displayEdits: false });
  assert.equal(parts('**甲乙**', 2), null);
});

test('literal, disabled and unpaired symbols remain unchanged', () => {
  for (const text of ['甲+++乙丙+++丁', '甲++乙丙丁', 'A++word++B']) {
    assert.equal(parts(text, 2).left, text.slice(0, 2));
  }
  assert.deepEqual(parts('甲++乙丙++丁', 2, { ...settings, assMode: false }),
    { left: '甲+', right: '+乙丙++丁', offset: 2 });
  for (const opts of [{ assSpecialSymbolRule: 'none' }, { assLargeTextEnabled: false }]) {
    assert.deepEqual(parts('甲++乙丙++丁', 2, { ...settings, ...opts }),
      { left: '甲+', right: '+乙丙++丁', offset: 2 });
  }
  assert.deepEqual(parts('甲+乙丙+丁', 2, { ...settings, assSpecialSymbolRule: 'double' }),
    { left: '甲+', right: '乙丙+丁', offset: 2 });
  for (const [marker, toggle] of [['//', 'assItalicEnabled'], ['%%', 'assCommentEnabled']]) {
    const text = `甲${marker}乙丙${marker}丁`;
    for (const opts of [{ assSpecialSymbolRule: 'none' }, { [toggle]: false }]) {
      assert.deepEqual(parts(text, 2, { ...settings, ...opts }),
        { left: text.slice(0, 2), right: text.slice(2), offset: 2 });
    }
  }
});

test('fade gives both output sentences a complete pair including nested styles', () => {
  // 句级 fade 外壳被剥出原文再重包：端点闭符号串 = wrap 的两半（<< / >>）
  assert.deepEqual(parts('>>甲乙<<', 3), { left: '>>甲<<', right: '>>乙<<', offset: 3,
    leftClosures: '<<', rightClosures: '>>', displayEdits: false });
  // 嵌套：跨刀的 ++ 对闭合随端点闭符号串输出，fade wrap 的两半缀在两端
  assert.deepEqual(parts('++>>甲乙<<++', 5), { left: '>>++甲++<<', right: '>>++乙++<<', offset: 5,
    leftClosures: '++<<', rightClosures: '>>++', displayEdits: false });
  // 单符号 fade（规则 both 识别 > <）同样重包为双符号完整对
  assert.deepEqual(parts('>甲乙<', 2), { left: '>>甲<<', right: '>>乙<<', offset: 2,
    leftClosures: '<<', rightClosures: '>>', displayEdits: false });
  // 重复 fade 按 parse-once 语义只识别外层：内层 >> 保留可见、闭符号串仍 = wrap 两半
  assert.deepEqual(parts('>>>>甲乙<<<<', 5), { left: '>>>>甲<<', right: '>>乙<<<<', offset: 5,
    leftClosures: '<<', rightClosures: '>>', displayEdits: false });
  // 规则 none 不识别任何符号：走无 token 早退，返回原切片且无闭符号串键
  assert.deepEqual(parts('>>甲乙<<', 3, { ...settings, assSpecialSymbolRule: 'none' }),
    { left: '>>甲', right: '乙<<', offset: 3 });
});

test('edge punctuation is trimmed before inserting the missing pair', () => {
  const split = core.buildSplitPair({ id: 'a', text: '**甲，乙**', start: 0, end: 2000 },
    4, 1000, 'a', false, 'continuous');
  assert.equal(split.left.text, '**甲**');
  assert.equal(split.right.text, '**乙**');
});

test('source markers consume no speech duration whether items include or omit them', () => {
  for (const items of [
    [{ text: '甲乙', start: 0, end: 2000 }],
    [{ text: '**甲乙**', start: 0, end: 2000 }],
  ]) {
    const segment = { id: 'a', text: '**甲乙**', start: 0, end: 2000, items };
    const snapshot = JSON.stringify(segment);
    const split = core.buildSplitPair(segment, 3, null, 'a', true, 'continuous');
    assert.equal(split.left.text, '**甲**');
    assert.equal(split.right.text, '**乙**');
    assert.equal(split.left.end, 1000);
    assert.equal(split.right.start, 1000);
    assert.equal(split.left.items[0].end, 1000);
    assert.equal(split.right.items[0].start, 1000);
    // items 守恒形态（item 文本含符号）closure 落到边界 item，各侧 items
    // 拼接 == 各自文本；visible 形态（item 只有文字）closure 留在句文本层，
    // items 保持纯文字切片拼接回原文。
    if (items[0].text === '**甲乙**') {
      assert.equal(split.left.items[0].text, split.left.text);
      assert.equal(split.right.items[0].text, split.right.text);
    } else {
      assert.equal(split.left.items[0].text + split.right.items[0].text, items[0].text);
    }
    assert.equal(JSON.stringify(segment), snapshot);
  }
  const recovered = core.buildSplitPair({ id: 'speech', text: '甲++乙丙++', start: 0, end: 3000,
    items: [{ text: '甲乙丙', start: 0, end: 3000 }] }, 2, null, 'speech', true, 'continuous');
  assert.equal(recovered.left.end, 1000);
  assert.equal(recovered.right.items[0].text, '乙丙');
  const split = core.buildSplitPair({ id: 'a', text: '甲++乙++', start: 0, end: 2000,
    items: [{ text: '甲++乙++', start: 0, end: 2000 }] }, 2, null, 'a', true, 'continuous');
  assert.equal(split.parts.offset, 1);
  assert.equal(split.left.end, 1000);
  assert.equal(split.right.items[0].text, '++乙++');
});

test('untimed fallback uses audible source length and duplicate/progressive bypass migration', () => {
  const segment = { id: 'a', text: '甲++乙丙++', start: 0, end: 3000 };
  const split = core.buildSplitPair(segment, 3, null, 'a', false, 'continuous');
  assert.equal(split.left.text, '甲');
  assert.equal(split.left.end, 1000);
  for (const splitTextMode of ['duplicate', 'progressive']) {
    const pair = core.buildSplitPair(segment, 3, 1000, 'a', false, 'continuous', { splitTextMode });
    assert.equal(pair.right.text, segment.text);
    // 渐进拆分与普通拆分同样做刀点吸附：切点贴着 ++ 开符号时吸到符号之前，
    // 左半句不留孤儿符号
    assert.equal(pair.left.text, splitTextMode === 'duplicate' ? segment.text : '甲');
  }
});

test('progressive split completes the left half into a standalone marked sentence', () => {
  // 维护者实测：渐进拆分 **重新开始** 应两侧补全成 **重** + **重新开始**，
  // 左半句不能留 **重 这样的孤儿开符号
  const pair = core.buildSplitPair(
    { id: 'a', text: '**重新开始**', start: 0, end: 2000 },
    3, 1000, 'a', false, 'continuous', { splitTextMode: 'progressive' },
  );
  assert.equal(pair.left.text, '**重**');
  assert.equal(pair.right.text, '**重新开始**');
  // 守恒形态下左段 items 同步落符号（items 拼接 == 左段文本）；右段保留
  // 原文切片、不补右段符号（整句原文自带开符号，右段前缀属于左段时间区）
  const timed = core.buildSplitPair(
    { id: 'b', text: '**重新开始**', start: 0, end: 2000,
      items: [{ text: '**重新开始**', start: 0, end: 2000 }] },
    3, 1000, 'b', true, 'continuous', { splitTextMode: 'progressive' },
  );
  assert.equal(timed.left.text, '**重**');
  assert.equal(timed.right.text, '**重新开始**');
  assert.equal(timed.left.items[0].text, '**重**');
  assert.equal(timed.right.items[0].text, '新开始**');
  // 整句壳同样成立：!!重新开始!! → !!重!! + !!重新开始!!
  const shake = core.buildSplitPair(
    { id: 'c', text: '!!重新开始!!', start: 0, end: 2000 },
    3, 1000, 'c', false, 'continuous', { splitTextMode: 'progressive' },
  );
  assert.equal(shake.left.text, '!!重!!');
  assert.equal(shake.right.text, '!!重新开始!!');
});

test('ordered multiple wrappers include custom pairs and reuse existing individual styles', () => {
  const apply = (source, wrapPairs) => utils.applyTextProcessing(source,
    { addWrapChars: true, skipWrapped: true, wrapPairs });
  const pairs = [{ left: '**', right: '**' }, { left: '++', right: '++' }, { left: '【', right: '】' }];
  assert.equal(apply('甲', pairs), '**++【甲】++**');
  assert.equal(apply('**甲**', pairs), '**++【甲】++**');
  assert.equal(apply('**++【甲】++**', pairs), '**++【甲】++**');
  assert.equal(apply('**甲**', [...pairs].reverse()), '【++**甲**++】');
  assert.equal(apply('>>甲<<', pairs), '>>**++【甲】++**<<');
  assert.equal(apply('【**甲**】', pairs), '**++【甲】++**');
  assert.equal(apply('****甲****', [pairs[0]]), '****甲****');
});


test('same-style single/double nesting and overlap preserve actual ASS rendering and timed items', () => {
  const render = (text) => utils.assInlineStyleRuns(text, 'both', settings).flatMap((run) =>
    Array.from(run.text, (character) => [character, run.emphasized, run.underlined, run.struck, run.size, run.comment]));
  for (const source of ['**a*bc*d**', '*a**bc**d*', '*a**bc*d**', '**a*bc**d*',
    '~~甲~乙丙~丁~~', '~甲~~乙丙~~丁~', '__甲_乙丙_丁__', '_甲__乙丙__丁_',
    '++甲+乙丙+丁++', '+甲++乙丙++丁+', '--甲-乙丙-丁--', '-甲--乙丙--丁-']) {
    const spoken = render(source).map(([character]) => character).join('');
    const offset = source.indexOf(source.includes('c') ? 'c' : '丙');
    for (const itemText of [spoken, source]) {
      const segment = { id: 'nested', text: source, start: 0, end: 4000,
        items: [{ text: itemText, start: 0, end: 4000 }] };
      const snapshot = JSON.stringify(segment);
      const pair = core.buildSplitPair(segment, offset, null, 'nested', true, 'continuous');
      assert.ok(pair, source);
      assert.deepEqual(render(pair.left.text).concat(render(pair.right.text)), render(source), source);
      assert.equal(pair.left.end, 2000, source);
      assert.equal(pair.right.start, 2000, source);
      assert.equal(pair.left.items[0].end, 2000, source);
      assert.equal(pair.right.items[0].start, 2000, source);
      // items 断言三分支：① 守恒形态且无符号合并渲染（displayEdits）——
      // closure 落到 items，各侧 items 拼接 == 各自文本；② 守恒形态但有
      // 合并渲染——合并渲染与逐字切片天然不一致，items 保持原切片，拼接
      // 回原 item 文本；③ visible 形态——closure 留在句文本层，纯文字
      // 切片拼接回 spoken。
      const concat = pair.left.items.concat(pair.right.items).map(item => item.text).join('');
      if (itemText === source && !pair.parts.displayEdits) {
        assert.equal(pair.left.items.map(item => item.text).join(''), pair.left.text, source);
        assert.equal(pair.right.items.map(item => item.text).join(''), pair.right.text, source);
      } else {
        assert.equal(concat, itemText, source);
      }
      assert.equal(JSON.stringify(segment), snapshot);
      assert.equal(JSON.stringify(segment), snapshot);
    }
  }
});

test('long repeated speech recovery stays linear for complete coverage and budgets optional ambiguous DP', () => {
  const original = context.MULTI_SUBTITLE_UTILS;
  let calls;
  // init 化后的 split-core 读 window.AsrEditorUtils；与 classic 别名同步换装。
  const patched = { ...original, alignItemsToText(text, items) {
    calls += 1;
    return original.alignItemsToText(text, items);
  } };
  context.MULTI_SUBTITLE_UTILS = patched;
  context.window.AsrEditorUtils = patched;
  try {
    for (const suffix of ['', '新增']) {
      const count = 950;
      const source = { id: 'long', text: 'a**b**'.repeat(count) + suffix, start: 0, end: count * 10,
        items: Array.from({ length: count }, (_, index) => ({ text: 'ab', start: index * 10, end: (index + 1) * 10 })) };
      calls = 0;
      const result = core.splitItemsAtChar(source, Math.floor(source.text.length / 2));
      assert.equal(calls, 1, 'complete coverage uses linear matching; over-budget ambiguity retains raw fallback');
      assert.equal(result.leftItems.length + result.rightItems.length, count);
      assert.equal(result.leftItems.concat(result.rightItems).map(item => item.text).join(''), 'ab'.repeat(count));
      for (const item of result.leftItems.concat(result.rightItems)) {
        assert.ok(item.end > item.start);
        assert.ok(item.start >= source.start && item.end <= source.end);
      }
    }
  } finally { context.MULTI_SUBTITLE_UTILS = original; context.window.AsrEditorUtils = original; }
});


test('normalizing redundant styles preserves the caller word-connector trimming contract', () => {
  const segment = { id: 'comma', start: 0, end: 4000, text: '**a*b,c*d**' };
  for (const mode of ['word', 'continuous']) {
    const split = core.buildSplitPair(segment, 6, 2000, 'comma', false, mode);
    const visible = [split.left, split.right].flatMap(segment => utils.assInlineStyleRuns(segment.text, 'both', settings))
      .map(run => run.text).join('');
    assert.equal(visible, mode === 'word' ? 'ab,cd' : 'abcd');
  }
});
