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
