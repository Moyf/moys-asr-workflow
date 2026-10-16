import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { loadEditorModule } from './helpers/editor-module-loader.mjs';
const fixture = { window: {} };
loadEditorModule(fixture, 'shared/editor-utils.js');
const utils = fixture.window.AsrEditorUtils;
const settings = { assMode: true, assEmphasisSyntax: 'both', assSpecialSymbolRule: 'both' };
const context = { window: { AsrEditorUtils: utils }, MULTI_SUBTITLE_UTILS: utils,
  MaweSettings: { EDITOR_SETTINGS: { ...settings } }, MaweMultiSubtitleCore: { SUBTITLE_MIN_DURATION_MS: 100 } };
vm.runInNewContext(fs.readFileSync(new URL('../web/editor/cues/editor-split-core.js', import.meta.url), 'utf8'), context);
const core = context.window.MaweSplitCore;
const plain = value => JSON.parse(JSON.stringify(value));
const parts = (text, offset, opts = settings) => plain(core.splitStyledTextParts(text,
  { left: text.slice(0, offset), right: text.slice(offset), offset }, opts));

test('paired markers follow their body when cutting beside or inside the delimiters', () => {
  for (const [left, right] of [['**', '**'], ['++', '++'], ['--', '--'], ['__', '__'], ['~~', '~~'], ['//', '//']]) {
    const text = `甲${left}乙丙${right}丁`;
    for (const offset of [1, 2, 3]) {
      assert.deepEqual(parts(text, offset), { left: '甲', right: `${left}乙丙${right}丁`, offset: 1 });
    }
    for (const offset of [5, 6, 7]) {
      assert.deepEqual(parts(text, offset), { left: `甲${left}乙丙${right}`, right: '丁', offset: 7 });
    }
    assert.deepEqual(parts(text, 4), { left: `甲${left}乙${right}`, right: `${left}丙${right}丁`, offset: 4 });
  }
});

test('nested styles close in reverse order and reopen in source order', () => {
  assert.deepEqual(parts('甲**++乙丙++**丁', 6),
    { left: '甲**++乙++**', right: '**++丙++**丁', offset: 6 });
  assert.deepEqual(parts('甲**++乙丙++**丁', 5),
    { left: '甲', right: '**++乙丙++**丁', offset: 1 });
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
});

test('fade gives both output sentences a complete pair including nested styles', () => {
  assert.deepEqual(parts('>>甲乙<<', 3), { left: '>>甲<<', right: '>>乙<<', offset: 3 });
  assert.deepEqual(parts('++>>甲乙<<++', 5), { left: '>>++甲++<<', right: '>>++乙++<<', offset: 5 });
  assert.deepEqual(parts('>甲乙<', 2), { left: '>>甲<<', right: '>>乙<<', offset: 2 });
  assert.deepEqual(parts('>>>>甲乙<<<<', 5), { left: '>>>>甲<<', right: '>>乙<<<<', offset: 5 });
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
    assert.equal(split.left.items[0].text + split.right.items[0].text, items[0].text);
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
    assert.equal(pair.left.text, splitTextMode === 'duplicate' ? segment.text : '甲++');
  }
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
      assert.equal(pair.left.items.concat(pair.right.items).map(item => item.text).join(''), itemText, source);
      assert.equal(JSON.stringify(segment), snapshot);
    }
  }
});

test('long repeated speech recovery stays linear for complete coverage and budgets optional ambiguous DP', () => {
  const original = context.MULTI_SUBTITLE_UTILS;
  let calls;
  context.MULTI_SUBTITLE_UTILS = { ...original, alignItemsToText(text, items) {
    calls += 1;
    return original.alignItemsToText(text, items);
  } };
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
  } finally { context.MULTI_SUBTITLE_UTILS = original; }
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
