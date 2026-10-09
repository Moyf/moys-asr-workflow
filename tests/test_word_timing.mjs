import assert from 'node:assert/strict';
import test from 'node:test';
import { loadEditorModule } from './helpers/editor-module-loader.mjs';

const context = { window: {} };
loadEditorModule(context, 'shared/editor-utils.js');
const utils = context.window.AsrEditorUtils;
const plain = value => JSON.parse(JSON.stringify(value));
const sentence = () => ({ id: 'sentence', start: 100, end: 900, text: '我很喜欢！', speaker: 'A', items: [
  { text: '我', start: 120, end: 200 },
  { text: '很喜欢', start: 300, end: 550 },
] });

test('renders shared inserted text as one range and attaches untimed punctuation', () => {
  const source = sentence();
  const entries = utils.getWordTimingEntries(source);
  assert.deepEqual(plain(entries.map(e => e.text)), ['我', '很喜欢！']);
  assert.deepEqual(plain(entries.map(e => [e.start, e.end])), [[120, 200], [300, 550]]);
  assert.equal(source.items[1].text, '很喜欢');
});
test('displays valid partial timings but refuses conversion with missing audible text', () => {
  const source = { ...sentence(), text: '我真的很喜欢！' };
  assert.equal(utils.getWordTimingEntries(source).length, 2);
  assert.equal(utils.planWordTimingConversion([source], [0]).skipped[0].reason, 'text');
  assert.equal(utils.getWordTimingEntries({ ...source, items: null }).length, 0);
});

test('partial unique text keeps untimed insertions missing while attaching sentence punctuation', () => {
  const source = { ...sentence(), text: '（新增）我，真的很喜欢！ ' };
  const entries = utils.getWordTimingEntries(source);
  assert.deepEqual(plain(entries.map(entry => entry.text)), ['（）我，', '很喜欢！ ']);
  assert.deepEqual(plain(entries.map(entry => [entry.start, entry.end])), [[120, 200], [300, 550]]);
  assert.equal(utils.planWordTimingConversion([source], [0]).skipped[0].reason, 'text');
  assert.equal(source.items[0].text, '我');
});

test('ambiguous repeated text does not guess punctuation ownership in partial display', () => {
  const source = { ...sentence(), text: '我，真的我很喜欢！' };
  assert.deepEqual(plain(utils.getWordTimingEntries(source).map(entry => entry.text)), ['我', '很喜欢']);
  assert.equal(utils.planWordTimingConversion([source], [0]).skipped[0].reason, 'text');
});
test('does not show or invent timing for neutral or invalid items', () => {
  const source = { start: 0, end: 500, text: '甲，乙。', items: [
    { text: '甲', start: 0, end: 50 }, { text: '，', start: 50, end: 50 },
    { text: '乙', start: 30, end: 100 }, { text: '。', start: 100, end: 100 },
  ] };
  assert.equal(utils.getWordTimingEntries(source).length, 1);
  assert.equal(utils.planWordTimingConversion([source], [0]).skipped[0].reason, 'timing');
});
test('moving a word clamps to its sentence and unselected neighbors', () => {
  const source = sentence();
  const moved = utils.editWordTiming(source, [0], { kind: 'move', delta: 1000 });
  assert.deepEqual(plain(moved[0]), { text: '我', start: 220, end: 300 });
  assert.equal(source.items[0].start, 120);
  const both = utils.editWordTiming(source, [0, 1], { kind: 'move', delta: -1000 });
  assert.equal(both[0].start, 100);
  assert.equal(both[1].start, 280);
  assert.equal(source.start, 100);
});
test('independent edge keeps a gap and never crosses its neighbor', () => {
  const source = sentence();
  const items = utils.editWordTiming(source, [0], { kind: 'resize', edge: 'end', target: 400 });
  assert.equal(items[0].end, 300);
  assert.equal(items[1].start, 300);
});
test('linked shared edges move both sides and keep at least 1ms', () => {
  const source = sentence();
  source.items[0].end = 300;
  const items = utils.editWordTiming(source, [0], { kind: 'resize', edge: 'end', target: 1000, linked: true });
  assert.equal(items[0].end, 549);
  assert.equal(items[1].start, 549);
  assert.equal(items[1].end, 550);
  const independent = utils.editWordTiming(source, [1], { kind: 'resize', edge: 'start', target: 400, linked: false });
  assert.equal(independent[0].end, 300);
  assert.equal(independent[1].start, 400);
});
test('short items retain exact milliseconds even with a sentence adapter that rounds to 10ms', () => {
  const source = { start: 0, end: 100, text: 'a', items: [{ text: 'a', start: 11, end: 13, start_frame: 1, end_frame: 2 }] };
  const timing = { unit: 'milliseconds', setItemStart: (s, v) => { s.start = Math.round(v / 10) * 10; } };
  const items = utils.editWordTiming(source, [0], { kind: 'move', delta: 1 }, timing);
  assert.deepEqual(plain(items), [{ text: 'a', start: 12, end: 14 }]);
});

test('unchanged timing preserves optional frame metadata for no-op history comparisons', () => {
  const source = { start: 0, end: 100, text: 'a', items: [{ text: 'a', start: 11, end: 13, start_frame: 1, end_frame: 2 }] };
  for (const edit of [{ kind: 'move', delta: 0 }, { kind: 'resize', edge: 'end', target: 13 }]) {
    assert.deepEqual(plain(utils.editWordTiming(source, [0], edit)), source.items);
  }
});
test('merge preserves raw text, accepts neutral items between blocks and refuses speaker changes', () => {
  const source = sentence();
  source.items.splice(1, 0, { text: '，', start: 200, end: 200 });
  const items = utils.mergeWordTimingItems(source, [0, 2]);
  assert.deepEqual(plain(items), [{ text: '我，很喜欢', start: 120, end: 550 }]);
  source.items[2].speaker = 'B';
  assert.equal(utils.mergeWordTimingItems(source, [0, 2]), null);
});
test('merge rejects skipped audible items and non-selected invalid items', () => {
  const source = { start: 0, end: 500, text: 'abc', items: [
    { text: 'a', start: 0, end: 100 }, { text: 'b', start: 100, end: 200 }, { text: 'c', start: 200, end: 300 },
  ] };
  assert.equal(utils.mergeWordTimingItems(source, [0, 2]), null);
  source.items[1].end = 100;
  assert.equal(utils.mergeWordTimingItems(source, [0, 2]), null);
});
test('conversion preserves all original text and one item per output without stretching ranges', () => {
  const source = { ...sentence(), text: '（我） 很喜欢！', disabled: true };
  const plan = utils.planWordTimingConversion([source], [0]);
  assert.equal(plan.generatedCount, 2);
  assert.equal(plan.segments.map(s => s.text).join(''), source.text);
  assert.deepEqual(plain(plan.segments.map(s => [s.start, s.end])), [[120, 200], [300, 550]]);
  for (const output of plan.segments) {
    assert.equal(output.items.length, 1);
    assert.equal(output.items[0].text, output.text);
    assert.equal(output.speaker, 'A');
    assert.equal(output.disabled, true);
  }
  assert.equal(utils.planWordTimingConversion(plan.segments, [0, 1]).conversions.length, 0);
});
test('conversion repairs head/ref indices outside selected sentences and assigns collision-free IDs', () => {
  const source = { ...sentence(), color: { name: 'red', start: 100, end: 1800 } };
  const later = { id: 'sentence-item-1', start: 1000, end: 1800, text: '后', color_ref: { name: 'red', headIdx: 0 } };
  const plan = utils.planWordTimingConversion([source, later], [0, 1]);
  assert.equal(plan.segments[1].color, null);
  assert.equal(plan.segments[1].color_ref.headIdx, 0);
  assert.equal(plan.segments[2].color_ref.headIdx, 0);
  assert.equal(new Set(plan.segments.map(s => s.id)).size, 3);
  assert.equal(plan.skipped[0].reason, 'missing');
  assert.deepEqual(plain(later.color_ref), { name: 'red', headIdx: 0 });
});
test('frame edits and conversion use frames as source and update compatible integer milliseconds', () => {
  const timing = { unit: 'frames', getStart: s => s.start_frame, getEnd: s => s.end_frame,
    getItemStart: s => s.start_frame, getItemEnd: s => s.end_frame,
    setItemStart: (s, v) => { s.start_frame = v; s.start = Math.round(v * 1000 / 30); },
    setItemEnd: (s, v) => { s.end_frame = v; s.end = Math.round(v * 1000 / 30); },
  };
  const source = { id: 'frame', text: 'ab', start: 0, end: 1000, start_frame: 0, end_frame: 30,
    items: [{ text: 'a', start: 0, end: 333, start_frame: 0, end_frame: 10 },
      { text: 'b', start: 333, end: 667, start_frame: 10, end_frame: 20 }] };
  source.items = utils.editWordTiming(source, [0], { kind: 'resize', edge: 'end', target: 15, linked: true }, timing);
  assert.equal(source.items[0].end, 500);
  assert.equal(source.items[1].start, 500);
  const plan = utils.planWordTimingConversion([source], [0], timing);
  assert.equal(plan.segments[0].end_frame, 15);
  assert.equal(plan.segments[0].end, 500);
});

test('conversion prioritizes item speaker even for a single complete item', () => {
  const source = { id: 'speaker', text: '你好', start: 0, end: 500, speaker: 'A',
    items: [{ text: '你好', start: 0, end: 500, speaker: 'B' }] };
  const plan = utils.planWordTimingConversion([source], [0]);
  assert.equal(plan.conversions.length, 1);
  assert.equal(plan.segments[0].speaker, 'B');
});

test('multi-sentence conversion remaps later group heads, member references and dirty flags', () => {
  const first = sentence();
  const head = { id: 'head', start: 1000, end: 2000, text: '乙丙', sticker: { name: 'fox' },
    items: [{ text: '乙', start: 1100, end: 1300 }, { text: '丙', start: 1400, end: 1900 }] };
  const member = { id: 'member', start: 2100, end: 2400, text: '丁', sticker_ref: { name: 'fox', headIdx: 1 } };
  const plan = utils.planWordTimingConversion([first, head, member], [0, 1]);
  assert.equal(plan.segments[3].sticker_ref.headIdx, 2);
  assert.equal(plan.segments[4].sticker_ref.headIdx, 2);
  assert.equal(plan.segments[4]._dirty, true);
});

test('equal-length replacement remaps item texts by their sentence spans', () => {
  const source = sentence();
  source.text = '我很喜欢！';
  const plan = utils.planWordTimingTextSync({ ...source, text: '我最喜欢！' }, source.text);
  assert.deepEqual(plain(plan.items.map(item => item.text)), ['我', '最喜欢！']);
  assert.equal(plan.changed, 1);
  // 标点替换同样按所属 span 同步
  const punctuation = utils.planWordTimingTextSync({ ...source, text: '我很喜欢？' }, source.text);
  assert.equal(punctuation.items[1].text, '很喜欢？');
});

test('leading punctuation attaches to the first item span like display mapping', () => {
  const source = { text: '，你好', items: [{ text: '你', start: 0, end: 100 }, { text: '好', start: 100, end: 200 }] };
  const plan = utils.planWordTimingTextSync({ ...source, text: '，你号' }, source.text);
  assert.deepEqual(plain(plan.items.map(item => item.text)), ['，你', '号']);
});

test('unequal edits only warn when the changed region crosses timed spans', () => {
  const source = sentence();
  // 句中插入文字 → 提示未同步
  assert.deepEqual(plain(utils.planWordTimingTextSync({ ...source, text: '我很真喜欢！' }, source.text)), { warn: true });
  // 结尾追加不跨入任何 item span → 静默忽略
  assert.equal(utils.planWordTimingTextSync({ ...source, text: `${source.text}啊` }, source.text), null);
  // 开头追加同样不跨入（首 item span 从 0 开始，但 region 为空）
  assert.equal(utils.planWordTimingTextSync({ ...source, text: `嗯${source.text}` }, source.text), null);
});

test('text sync skips segments without mappable items', () => {
  assert.equal(utils.planWordTimingTextSync({ text: '没有items', start: 0, end: 100 }, '没有items'), null);
  assert.equal(utils.planWordTimingTextSync({ text: '我很喜欢！', items: [{ text: '我', start: 0, end: 10 }], start: 0, end: 100 }, '我很喜欢！'), null);
  assert.equal(utils.planWordTimingTextSync({ text: '我很喜欢！', items: sentence().items, start: 0, end: 100 }, '我很喜欢！'), null);
});

test('text sync preserves non-BMP characters and uses character counts for replacements', () => {
  const previous = '𠮷野家';
  const items = [...previous].map((text, index) => ({ text, start: index * 100, end: (index + 1) * 100 }));
  for (const text of ['𠮷野佳', '吉野家']) {
    const result = utils.planWordTimingTextSync({ text, items }, previous);
    assert.deepEqual(plain(result.items.map(item => item.text)), [...text]);
    assert.deepEqual(plain(result.items.map(item => [item.start, item.end])), [[0, 100], [100, 200], [200, 300]]);
  }
  assert.deepEqual(items.map(item => item.text), [...previous]);
  // Same UTF-16 length is not the same number of characters.
  assert.deepEqual(plain(utils.planWordTimingTextSync({ text: '吉祥野家', items }, previous)), { warn: true });
});

test('text sync keeps emoji punctuation attached without shifting later item spans', () => {
  const result = utils.planWordTimingTextSync({ text: '🙂你好呀', items: [
    { text: '你', start: 0, end: 100 }, { text: '好啊', start: 100, end: 200 },
  ] }, '🙂你好啊');
  assert.deepEqual(plain(result.items.map(item => item.text)), ['🙂你', '好呀']);
});
