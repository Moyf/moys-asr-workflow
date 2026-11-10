import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import {initModuleSource} from './helpers/init-module-source.mjs';
import { loadEditorModule } from './helpers/editor-module-loader.mjs';

const context = { window: {} };
loadEditorModule(context, 'shared/editor-utils.js');
const h = context.window.AsrEditorUtils;
const utils = h;
const plain = value => JSON.parse(JSON.stringify(value));

// 拆分核心与合并路径是 classic 作用域脚本：按 test_ass_cue_position 的方式
// 注入最小全局桩后在独立 context 里加载真实源码。
const splitContext = () => ({
  window: { AsrEditorUtils: h },
  MULTI_SUBTITLE_UTILS: h,
  MaweMultiSubtitleCore: { SUBTITLE_MIN_DURATION_MS: 100 },
  MaweSettings: { EDITOR_SETTINGS: { assMode: true, assSpecialSymbolRule: 'both', assEmphasisSyntax: 'both' } },
});
const mergeContext = (segments) => ({
  window: { AsrEditorUtils: h },
  MaweBoot: { DATA: { segments } },
  MaweMultiSubtitleCore: {
    getMultiSubtitleState: () => ({ tracks: [] }), multiSubtitleVisible: () => false,
    getMainSubtitleSplitMode: () => 'continuous', mergeJoinSeparatorForMode: () => '',
    removeBindingsForSegmentIds() {},
  },
  MaweTextCleanup: { syncTimelineGroupRanges() {} },
  MaweSettings: { EDITOR_SETTINGS: { assSpecialSymbolRule: 'both' } },
});

// === 任务 4：stripMassMarkers（成对剥、孤儿留） ===

test('stripMassMarkers removes recognized pairs and keeps orphan markers literal', () => {
  assert.equal(h.stripMassMarkers('**强调**文本*', 'both'), '强调文本*');
  assert.equal(h.stripMassMarkers('*强调', 'both'), '*强调');
  assert.equal(h.stripMassMarkers('**强调**', 'both'), '强调');
  // 九对中的其余同符号对：放大 / 缩小 / 下划线 / 删除线 / 斜体 / 弱化 / 原地震动
  assert.equal(h.stripMassMarkers('++大++文本', 'both'), '大文本');
  assert.equal(h.stripMassMarkers('--小--文本', 'both'), '小文本');
  assert.equal(h.stripMassMarkers('__线__文本', 'both'), '线文本');
  assert.equal(h.stripMassMarkers('~~删~~文本', 'both'), '删文本');
  assert.equal(h.stripMassMarkers('//斜体//正文', 'both'), '斜体正文');
  assert.equal(h.stripMassMarkers('%%弱化%%正文', 'both'), '弱化正文');
  assert.equal(h.stripMassMarkers('!!震动!!文本', 'both'), '震动文本');
  // 句级 fade >>…<< 是非对称标记，由 stripSentenceFadeMarkers 负责，这里不动
  assert.equal(h.stripMassMarkers('>>淡入<<', 'both'), '>>淡入<<');
  // 与句级 fade/shake 剥离协调：同一条链不重复剥、不互相破坏
  assert.equal(h.srtSentenceText('>>淡入**强调**淡出<<', 'both'), '淡入强调淡出');
  assert.equal(h.srtSentenceText('!!震动**重点**!!', 'both'), '震动重点');
  // fade parse-once 语义不被 MASS 剥离破坏（第二个 fade 对保持字面）
  assert.equal(h.srtSentenceText('>>>>原文<<<<', 'double'), '>>原文<<');
});

test('stripMassMarkers follows the special symbol rule like recognition does', () => {
  assert.equal(h.stripMassMarkers('*单*双**', 'double'), '*单*双**');
  assert.equal(h.stripMassMarkers('**双**', 'double'), '双');
  assert.equal(h.stripMassMarkers('*单*双**', 'none'), '*单*双**');
  assert.equal(h.stripMassMarkers('**双**', 'none'), '**双**');
  assert.deepEqual(plain(h.massMarkedRanges('*a* **b**', 'both').map(range => [range.start, range.end, range.width])),
    [[0, 2, 1], [4, 7, 2]]);
});

test('SRT and TXT exports strip MASS pairs while ASS export keeps them', () => {
  const cues = [{ start: 0, end: 1000, text: '我是今天的*解说*' }];
  assert.ok(h.buildSrtPayload(cues).includes('\n我是今天的解说\n'));
  assert.ok(h.buildSrtPayload(cues, { assSpecialSymbolRule: 'double' }).includes('\n我是今天的*解说*\n'));
  assert.equal(h.buildPlainTextPayload([{ text: '**强调**和!!震动!!' }, { text: '孤*儿' }]),
    '强调和震动\n孤*儿');
  // ASS 导出（非 assMode）保留字面符号，MASS 在 ASS 是合法语法
  const ass = h.buildAssPayload([{ start: 0, end: 1000, text: '**强调**' }]);
  assert.ok(ass.includes('**强调**'));
});

// === 任务 2：completeSplitMassPairs（拆分补齐） ===

test('split completion completes a pair straddling the cut on both sides', () => {
  // 维护者拍板示例：今天*的 ｜ 解说* → 今天*的* ｜ *解说*
  assert.deepEqual(plain(h.completeSplitMassPairs('今天*的', '解说*', 'both')),
    { left: '今天*的*', right: '*解说*', leftAppend: '*', rightPrepend: '*' });
  assert.deepEqual(plain(h.completeSplitMassPairs('今天**的', '解说**', 'both')),
    { left: '今天**的**', right: '**解说**', leftAppend: '**', rightPrepend: '**' });
  assert.deepEqual(plain(h.completeSplitMassPairs('!!今天的', '解说!!', 'both')),
    { left: '!!今天的!!', right: '!!解说!!', leftAppend: '!!', rightPrepend: '!!' });
});

test('split completion fills the sentence-level fade pair on both sides', () => {
  assert.deepEqual(plain(h.completeSplitMassPairs('>>今天的', '解说<<', 'both')),
    { left: '>>今天的<<', right: '>>解说<<', leftAppend: '<<', rightPrepend: '>>' });
  assert.deepEqual(plain(h.completeSplitMassPairs('>今天的', '解说<', 'single')),
    { left: '>今天的<', right: '>解说<', leftAppend: '<', rightPrepend: '>' });
});

test('split completion keeps orphan markers and skips sides without body', () => {
  // 找不到成对的孤儿符号维持字面
  assert.deepEqual(plain(h.completeSplitMassPairs('今天*的', '解说', 'both')),
    { left: '今天*的', right: '解说', leftAppend: '', rightPrepend: '' });
  // 刀点恰在开符号之后：左无正文不补闭（避免拼出 ++++），右补齐成对
  assert.deepEqual(plain(h.completeSplitMassPairs('强调**', '文本**完', 'both')),
    { left: '强调**', right: '**文本**完', leftAppend: '', rightPrepend: '**' });
  // 双符号规则下单符号对不识别，维持字面
  assert.deepEqual(plain(h.completeSplitMassPairs('今天*的', '解说*', 'double')),
    { left: '今天*的', right: '解说*', leftAppend: '', rightPrepend: '' });
});

test('split pair wiring completes texts and items in buildSplitPair with conservation', () => {
  // items 取「同步归位后」的真实形态：符号按任务 1 的规则落在相邻 item 文本里
  const segment = { id: 'a', start: 0, end: 2000, text: '今天*的解说*完', items: [
    { text: '今天*', start: 0, end: 600 }, { text: '的', start: 600, end: 900 },
    { text: '解说*', start: 900, end: 1500 }, { text: '完', start: 1500, end: 1900 },
  ] };
  const built = buildViaFreshContext(segment, 5);
  assert.equal(built.left.text, '今天*的解*');
  assert.equal(built.right.text, '*说*完');
  // items 层同步补符号：每侧 items 拼接 == 其文本
  assert.equal(built.left.items.map(item => item.text).join(''), built.left.text);
  assert.equal(built.right.items.map(item => item.text).join(''), built.right.text);
  assert.deepEqual(plain(built.left.items.map(item => [item.start, item.end])),
    [[0, 600], [600, 900], [900, 1200]]);
  assert.deepEqual(plain(built.right.items.map(item => [item.start, item.end])),
    [[1200, 1500], [1500, 1900]]);
  // 切点时间按 item 内可见字符占比插值（`*` 为中性不占时）：解说* 可见 1/2
  assert.equal(built.splitMs, 1200);
  // 补齐后的两侧各自按同规则重新成对
  assert.deepEqual(plain(h.massMarkedRanges(built.left.text, 'both').map(range => [range.start, range.end])),
    [[2, 5]]);
  assert.deepEqual(plain(h.massMarkedRanges(built.right.text, 'both').map(range => [range.start, range.end])),
    [[0, 2]]);
});

function buildViaFreshContext(segment, offset) {
  const context = splitContext();
  vm.runInNewContext(initModuleSource('editor/cues/editor-split-core.js'), context);
  return context.window.MaweSplitCore.buildSplitPair(segment, offset, 1000, 'a', true, 'continuous', { headIndex: 0 });
}

test('split pair wiring fills the fade shell on both halves', () => {
  // items 含行首/行尾中性字符（fade 标记与「的」归前一 item）
  const segment = { id: 'f', start: 0, end: 2000, text: '>>今天的解说<<', items: [
    { text: '>>今天的', start: 0, end: 800 }, { text: '解说<<', start: 800, end: 1900 },
  ] };
  const built = buildViaFreshContext(segment, 5);
  assert.equal(built.left.text, '>>今天的<<');
  assert.equal(built.right.text, '>>解说<<');
  assert.equal(built.left.items.map(item => item.text).join(''), built.left.text);
  assert.equal(built.right.items.map(item => item.text).join(''), built.right.text);
});

// === 任务 3：合并折叠 ===

test('merge join folds adjacent close+open pairs of the same marker', () => {
  const segments = [
    { text: '今天*的*', items: [{ text: '今天*的*', start: 0, end: 500 }] },
    { text: '*解说*', items: [{ text: '*解说*', start: 500, end: 1000 }] },
  ];
  const joined = h.joinSegmentTextsMassFold(segments, '', 'both');
  // 今天*的* + *解说* → 今天*的解说*：junction 处两侧符号整体折叠（前段尾闭
  // + 后段首开一并移除），两段的样式意图合成一个跨边界完整对（并集、无孤儿）
  assert.equal(joined.text, '今天*的解说*');
  // items 层同步折叠：前段末 item 裁掉尾闭、后段首 item 裁掉首开
  assert.deepEqual(plain(joined.items.map(item => item.text)), ['今天*的', '解说*']);
  assert.equal(joined.items.map(item => item.text).join(''), joined.text);
  // 空格分隔（单词型合并）同样在 junction 折叠：移除两侧符号后把空格插回，
  // items 层空格归位到后段首 item，items 拼接仍 == 合并文本
  const spaced = h.joinSegmentTextsMassFold(segments, ' ', 'both');
  assert.equal(spaced.text, '今天*的 解说*');
  assert.deepEqual(plain(spaced.items.map(item => item.text)), ['今天*的', ' 解说*']);
  assert.equal(spaced.items.map(item => item.text).join(''), spaced.text);
});

test('merge join folds sentence-level shells across the word-mode space (maintainer case)', () => {
  // 维护者实测：单词型两句整句壳合并应还原成一个完整外壳，而不是
  // !!This is a!! !!short test video!! 这样成对重复
  const segments = [
    { text: '!!This is a!!', items: [
      { text: '!!This', start: 0, end: 400 }, { text: ' is', start: 400, end: 600 }, { text: ' a!!', start: 600, end: 1000 },
    ] },
    { text: '!!short test video!!', items: [
      { text: '!!short', start: 1000, end: 1400 }, { text: ' test', start: 1400, end: 1700 }, { text: ' video!!', start: 1700, end: 2000 },
    ] },
  ];
  const joined = h.joinSegmentTextsMassFold(segments, ' ', 'both');
  assert.equal(joined.text, '!!This is a short test video!!');
  // items 层同步：前段尾 item 裁掉尾壳、后段首 item 裁掉首壳并把空格归位开头，
  // 与拆分补齐互为逆操作（往返还原原句原 items）
  assert.deepEqual(plain(joined.items.map(item => item.text)),
    ['!!This', ' is', ' a', ' short', ' test', ' video!!']);
  assert.equal(joined.items.map(item => item.text).join(''), joined.text);
  // fade 整句壳走同一句级折叠（不对称符号同样支持空格 junction）
  const fade = h.joinSegmentTextsMassFold([{ text: '>>A B<<' }, { text: '>>C D<<' }], ' ', 'both');
  assert.equal(fade.text, '>>A B C D<<');
  // `!!` 是整句壳：两侧不是完整外壳时不跨 junction 折叠（折出来也是句中死标记）
  assert.equal(h.foldMassPairJunction('A!!B!!', '!!C!!', 'both'), null);
});

test('merge join folds double markers and rejoins sentence-level fade shells', () => {
  const doubled = h.joinSegmentTextsMassFold([
    { text: '今天**的**', items: [{ text: '今天**的**', start: 0, end: 500 }] },
    { text: '**解说**', items: [{ text: '**解说**', start: 500, end: 1000 }] },
  ], '', 'both');
  assert.equal(doubled.text, '今天**的解说**');
  assert.deepEqual(plain(doubled.items.map(item => item.text)), ['今天**的', '解说**']);
  assert.equal(doubled.items.map(item => item.text).join(''), doubled.text);

  const fade = h.joinSegmentTextsMassFold([
    { text: '>>A<<', items: [{ text: '>>A<<', start: 0, end: 500 }] },
    { text: '>>B<<', items: [{ text: '>>B<<', start: 500, end: 1000 }] },
  ], '', 'both');
  // fade 折叠是拆分补齐的逆操作：合并回一个完整句级外壳
  assert.equal(fade.text, '>>AB<<');
  assert.deepEqual(plain(fade.items.map(item => item.text)), ['>>A', 'B<<']);
  assert.equal(fade.items.map(item => item.text).join(''), fade.text);
});

test('merge join only folds recognized close/open pairs and respects the rule', () => {
  // 前段末尾不是已识别对的闭符号（孤儿）→ 不折叠
  assert.equal(h.joinSegmentTextsMassFold([
    { text: 'abc*' }, { text: '*def*' },
  ], '', 'both').text, 'abc**def*');
  // 双符号规则下单符号相邻不构成折叠
  assert.equal(h.joinSegmentTextsMassFold([
    { text: '今天*的*' }, { text: '*解说*' },
  ], '', 'double').text, '今天*的**解说*');
  // none 规则全量不识别
  assert.equal(h.joinSegmentTextsMassFold([
    { text: '今天*的*' }, { text: '*解说*' },
  ], '', 'none').text, '今天*的**解说*');
  // 纯 joinSegmentTexts 保持原语义不变
  assert.equal(h.joinSegmentTexts([{ text: 'a*b*' }, { text: '*c' }], ''), 'a*b**c');
});

test('mergeContiguousIndices folds the junction and keeps items conserved', () => {
  const segments = [
    { id: 'a', start: 0, end: 1000, text: '今天*的*', items: [{ text: '今天*的*', start: 0, end: 1000 }] },
    { id: 'b', start: 1000, end: 2000, text: '*解说*', items: [{ text: '*解说*', start: 1000, end: 2000 }] },
  ];
  const context = mergeContext(segments);
  vm.runInNewContext(initModuleSource('editor/cues/editor-segment-ops.js'), context);
  const merged = context.window.MaweSegmentOps.mergeContiguousIndices([0, 1]);
  assert.equal(merged.text, '今天*的解说*');
  assert.deepEqual(plain(merged.items.map(item => item.text)), ['今天*的', '解说*']);
  assert.equal(merged.items.map(item => item.text).join(''), merged.text);
  assert.deepEqual([merged.start, merged.end], [0, 2000]);
});

test('merge keeps spoken-only and partially marked items with their exact timing', () => {
  for (const texts of [['甲', '乙'], ['**甲', '乙**'], ['**甲**', '乙']]) {
    const segments = texts.map((text, index) => ({
      id: String(index), start: index * 1000, end: (index + 1) * 1000,
      text: index === 0 ? '**甲**' : '**乙**',
      items: [{ text, start: index * 1000 + 100, end: index * 1000 + 800, speaker: 'A' }],
    }));
    const snapshot = JSON.stringify(segments);
    const joined = h.joinSegmentTextsMassFold(segments, '', 'both');
    assert.equal(joined.text, '**甲乙**');
    assert.equal(joined.items.length, 2);
    assert.deepEqual(plain(joined.items.map(item => [h.stripMassMarkers(item.text, 'both').replaceAll('*', ''), item.start, item.end, item.speaker])),
      [['甲', 100, 800, 'A'], ['乙', 1100, 1800, 'A']]);
    assert.equal(JSON.stringify(segments), snapshot);
    const context = mergeContext(plain(segments));
    vm.runInNewContext(initModuleSource('editor/cues/editor-segment-ops.js'), context);
    assert.equal(context.window.MaweSegmentOps.mergeContiguousIndices([0, 1]).items.length, 2);
  }
});

test('word conversion completes styles spanning three or more outputs without changing timing', () => {
  for (const [text, words] of [
    ['__one two three__', ['one', ' two', ' three']],
    ['>>甲乙丙<<', ['甲', '乙', '丙']],
  ]) {
    const source = [{ id: 'source', start: 0, end: 1500, text,
      items: words.map((word, index) => ({ text: word, start: index * 500, end: (index + 1) * 500 })) },
    { id: 'untouched', start: 2000, end: 2500, text: '*字面' }];
    const snapshot = JSON.stringify(source);
    const plan = h.planWordTimingConversion(source, [0], undefined, { rule: 'both' });
    const expected = text.startsWith('__') ? ['__one __', '__two __', '__three__'] : ['>>甲<<', '>>乙<<', '>>丙<<'];
    assert.deepEqual(plain(plan.segments.slice(0, 3).map(row => row.text)), expected);
    assert.deepEqual(plain(plan.segments.slice(0, 3).map(row => row.items[0].text)), expected);
    assert.deepEqual(plain(plan.segments.slice(0, 3).map(row => [row.start, row.end])), [[0, 500], [500, 1000], [1000, 1500]]);
    assert.equal(plan.segments[3].text, '*字面');
    assert.equal(JSON.stringify(source), snapshot);
  }
});

// === Greptile P1（PR #251）：折叠残留与转换波及 ===

test('merge fold removes both junction markers and reunites the pair across styles', () => {
  // 双符号：**甲** + **乙** → **甲乙**（一个完整对，无孤儿符号）
  const double = h.foldMassPairJunction('**甲**', '**乙**', 'both');
  assert.deepEqual(plain(double), { left: '**甲', right: '乙**', removed: 2, leftTrimmed: 2 });
  const joinedDouble = double.left + double.right;
  assert.deepEqual(plain(h.massMarkedRanges(joinedDouble, 'both').filter(range => range.marker === '**').map(range => [range.start, range.end])), [[0, 4]]);
  assert.equal(h.srtSentenceText(joinedDouble, 'both'), '甲乙');
  // 单符号：今天*的* + *解说* → 今天*的解说*（两段样式意图的并集）
  const single = h.foldMassPairJunction('今天*的*', '*解说*', 'both');
  const joinedSingle = single.left + single.right;
  assert.equal(joinedSingle, '今天*的解说*');
  assert.deepEqual(plain(h.massMarkedRanges(joinedSingle, 'both').filter(range => range.marker === '*').map(range => [range.start, range.end])), [[2, 6]]);
  assert.equal(h.srtSentenceText(joinedSingle, 'both'), '今天的解说');
  // 拆分-合并往返：拆分补齐产物合并后还原原句（含空格归位）
  const roundtrip = h.foldMassPairJunction('__really__', '__ fun__', 'both');
  assert.equal(roundtrip.left + roundtrip.right, '__really fun__');
  // joinSegmentTextsMassFold 端到端：items 双端裁剪守恒
  const rows = [
    { text: '**甲**', items: [{ text: '**甲**', start: 0, end: 500 }] },
    { text: '**乙**', items: [{ text: '**乙**', start: 500, end: 1000 }] },
  ];
  const joinedFold = h.joinSegmentTextsMassFold(rows, '', 'both');
  assert.equal(joinedFold.text, '**甲乙**');
  assert.deepEqual(plain(joinedFold.items.map(item => item.text)), ['**甲', '乙**']);
  assert.equal(joinedFold.items.map(item => item.text).join(''), joinedFold.text);
  // 弱化 %% 与斜体 // 作为固定双符号行内对，走同一套拆分补齐与合并折叠。
  assert.deepEqual(plain(h.completeSplitMassPairs('今天%%的', '弱化%%', 'both')),
    { left: '今天%%的%%', right: '%%弱化%%', leftAppend: '%%', rightPrepend: '%%' });
  const subduedFold = h.foldMassPairJunction('%%甲%%', '%%乙%%', 'both');
  assert.equal(subduedFold.left + subduedFold.right, '%%甲乙%%');
  const italicFold = h.foldMassPairJunction('//甲//', '//乙//', 'both');
  assert.equal(italicFold.left + italicFold.right, '//甲乙//');
});

test('conversion completion only touches rows of the converted sentence', () => {
  const clock = { unit: 'milliseconds', getStart: s => s.start, getEnd: s => s.end,
    getItemStart: s => s.start, getItemEnd: s => s.end, setItemStart: () => {}, setItemEnd: () => {} };
  const segments = [
    { id: 'a', start: 0, end: 1000, text: '__really fun__', items: [
      { text: '__really', start: 0, end: 500 }, { text: ' fun__', start: 500, end: 1000 },
    ] },
    // 未选中的相邻字幕：字面星号恰好能与相邻行拼出语法对（Greptile P1 用例）
    { id: 'b', start: 1000, end: 2000, text: '*甲', items: [{ text: '*甲', start: 1000, end: 2000 }] },
    { id: 'c', start: 2000, end: 3000, text: '乙*', items: [{ text: '乙*', start: 2000, end: 3000 }] },
  ];
  const plan = utils.planWordTimingConversion(segments, [0], clock, { rule: 'both' });
  const texts = plain(plan.segments.map(segment => segment.text));
  // 被转换字幕的两行之间补齐（空格按中性归属留在前行）
  assert.deepEqual(texts.slice(0, 2), ['__really __', '__fun__']);
  assert.deepEqual(plain(plan.segments[0].items.map(item => item.text)), ['__really __']);
  assert.deepEqual(plain(plan.segments[1].items.map(item => item.text)), ['__fun__']);
  // 未选中的两条字幕保持字面不动
  assert.deepEqual(texts.slice(2), ['*甲', '乙*']);
  // 转换行与未选中行的 junction 不补：row1(.fun__ 尾) 与 *甲 之间无变化
  assert.equal(plan.segments[1].text, '__fun__');
});

test('assMarkedRanges nests three MASS pairs in one sentence (ledger #30)', () => {
  const text = '>>** %%The *editing* %%process**<<';
  const ranges = plain(h.massMarkedRanges(text, 'both'));
  const byMarker = (marker) => ranges.filter(range => range.marker === marker).map(range => [range.start, range.end]);
  // **[2,30) ⊃ %%[5,21) ⊃ *[11,19)：同符号对互不重叠、跨符号允许嵌套
  assert.deepEqual(byMarker('**'), [[2, 30]]);
  assert.deepEqual(byMarker('%%'), [[5, 21]]);
  assert.deepEqual(byMarker('*'), [[11, 19]]);
  // 句级 fade 外壳同样成立
  const fade = h.parseSentenceFadeMarkers(text, 'both');
  assert.equal(fade.fadeIn, true);
  assert.equal(fade.fadeOut, true);
});

// === Greptile 第二轮（PR #251）===

test('merge fold keeps spoken-only boundary items (Greptile P1: items trimming)', () => {
  // 边界 item 只含 spoken（visible 形态）：折叠不裁 item，字词时间码不丢
  const rows = [
    { text: '**甲**', items: [{ text: '甲', start: 0, end: 500 }] },
    { text: '**乙**', items: [{ text: '乙', start: 500, end: 1000 }] },
  ];
  const joined = h.joinSegmentTextsMassFold(rows, '', 'both');
  assert.equal(joined.text, '**甲乙**');
  assert.deepEqual(plain(joined.items.map(item => ({ text: item.text, start: item.start, end: item.end }))),
    [{ text: '甲', start: 0, end: 500 }, { text: '乙', start: 500, end: 1000 }]);
  // 守恒形态（item 含符号）回归：closure 裁剪仍正确落边界 item
  const conserved = h.joinSegmentTextsMassFold([
    { text: '今天*的*', items: [{ text: '今天*的*', start: 0, end: 500 }] },
    { text: '*解说*', items: [{ text: '*解说*', start: 500, end: 1000 }] },
  ], '', 'both');
  assert.equal(conserved.text, '今天*的解说*');
  assert.deepEqual(plain(conserved.items.map(item => item.text)), ['今天*的', '解说*']);
  assert.equal(conserved.items.map(item => item.text).join(''), conserved.text);
});

test('merge folding retains every spoken-only item and later literal symbols', () => {
  const cases = [
    [
      { text: '**甲乙**', items: [{ text: '甲', start: 0, end: 250 }, { text: '乙', start: 250, end: 500 }] },
      { text: '**丙**', items: [{ text: '丙', start: 500, end: 1000 }] },
    ],
    [
      { text: '**甲**', items: [{ text: '甲', start: 0, end: 500 }] },
      { text: '**乙-丙**', items: [{ text: '乙', start: 500, end: 600 },
        { text: '-', start: 600, end: 700 }, { text: '丙', start: 700, end: 1000 }] },
    ],
    [
      { text: '**甲**', items: [{ text: '甲', start: 0, end: 500 }] },
      { text: '**+乙**', items: [{ text: '+乙', start: 500, end: 1000 }] },
    ],
  ];
  for (const rows of cases) {
    const before = JSON.stringify(rows);
    const joined = h.joinSegmentTextsMassFold(rows, '', 'both');
    assert.deepEqual(plain(joined.items), plain(rows.flatMap(row => row.items)));
    assert.equal(JSON.stringify(rows), before, 'merge must not mutate the source word timings');
  }
});

test('conversion completion spans a style across 3+ output rows (Greptile P1)', () => {
  const clock = { unit: 'milliseconds', getStart: s => s.start, getEnd: s => s.end,
    getItemStart: s => s.start, getItemEnd: s => s.end, setItemStart: () => {}, setItemEnd: () => {} };
  const segments = [
    { id: 'a', start: 0, end: 1500, text: '__one two three__', items: [
      { text: 'one', start: 100, end: 500 }, { text: 'two', start: 600, end: 900 },
      { text: 'three', start: 1000, end: 1400 },
    ] },
    { id: 'b', start: 1500, end: 2500, text: '*甲', items: [{ text: '*甲', start: 1500, end: 2500 }] },
    { id: 'c', start: 2500, end: 3500, text: '乙*', items: [{ text: '乙*', start: 2500, end: 3500 }] },
  ];
  const plan = utils.planWordTimingConversion(segments, [0], clock, { rule: 'both' });
  const texts = plain(plan.segments.map(segment => segment.text));
  // 跨 3 行的 __ 对：每个输出行都补齐为自包含的完整对（中间行不丢样式）
  assert.deepEqual(texts.slice(0, 3), ['__one __', '__two __', '__three__']);
  // 跨源不波及回归：未选中的 b/c 保持字面
  assert.deepEqual(texts.slice(3), ['*甲', '乙*']);
  // items 同步守恒（每行 items 拼接 == 其文本）
  assert.deepEqual(plain(plan.segments[0].items.map(item => item.text)), ['__one __']);
  assert.deepEqual(plain(plan.segments[2].items.map(item => item.text)), ['__three__']);
});

test('structural split completion wires through report/apply with the rule option (Greptile P1)', () => {
  const segments = [{ id: 'a', start: 0, end: 2000, text: '**甲乙**',
    items: [{ text: '**甲乙**', start: 0, end: 2000 }] }];
  // 编辑器层调用形态：options.rule 携带「特殊文本规则」设置
  const report = utils.buildTimedTextEditReport(segments, ['**甲', '乙**'],
    { rule: 'both' });
  assert.equal(report.structure?.valid, true);
  assert.deepEqual(plain(report.previewSegments.map(segment => segment.text)), ['**甲**', '**乙**']);
  const applied = utils.applyTimedTextEdit(segments, ['**甲', '乙**'], { rule: 'both' });
  assert.deepEqual(plain((applied || []).map(segment => segment.text)), ['**甲**', '**乙**']);
  // 未传 rule 的调用保持既有行为（补齐为 options 驱动，不隐式启用）
  const legacy = utils.buildTimedTextEditReport(segments, ['**甲', '乙**']);
  assert.deepEqual(plain(legacy.previewSegments.map(segment => segment.text)), ['**甲', '乙**']);
});
