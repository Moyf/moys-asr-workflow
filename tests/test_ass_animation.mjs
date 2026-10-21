import assert from 'node:assert/strict';
import test from 'node:test';
import { loadEditorModule } from './helpers/editor-module-loader.mjs';
const context = { window: {} };
loadEditorModule(context, 'shared/editor-utils.js');
const h = context.window.AsrEditorUtils;
const plain = value => JSON.parse(JSON.stringify(value));
const dialogues = output => output.split('\n').filter(line => line.startsWith('Dialogue:'));
const POP = { enabled: false, fromScale: 1.4, inMs: 250, accel: 1 };
const popProfile = (pop, extra = {}) => ({ animations: { pop, ...extra } });

test('sentence pop marker parsing strips both ends only for double symbols with body', () => {
  assert.deepEqual(plain(h.parseSentencePopMarkers('{{文字}}')), { text: '文字', pop: true });
  assert.deepEqual(plain(h.parseSentencePopMarkers('普通文本')), { text: '普通文本', pop: false });
  assert.equal(h.stripSentencePopMarkers('{{文字}}'), '文字');
  assert.equal(h.stripSentencePopMarkers('普通文本'), '普通文本');
  // 四个字符时两端标记完全重叠，视为普通花括号文本而不是空正文标记。
  assert.deepEqual(plain(h.parseSentencePopMarkers('{{}}')), { text: '{{}}', pop: false });
  // 首个完整对之后的花括号按 parse-once 语义保持字面（与 !! 一致）。
  assert.deepEqual(plain(h.parseSentencePopMarkers('{{a}}}}')), { text: 'a}}', pop: true });
  assert.deepEqual(plain(h.parseSentencePopMarkers('{{a{{b}}')), { text: '{{a{{b}}', pop: false });
  // 右键预设表登记双花括号（句级效果），且仅在 ASS 模式展示。
  assert.deepEqual(plain(h.WRAP_CHAR_PRESETS.find(preset => preset.id === 'pop')),
    { id: 'pop', label: '放大出现', left: '{{', right: '}}', ass: true, sentenceLevel: true });
});

test('pop marker composes with fade and shake shells in any nesting order', () => {
  assert.equal(h.stripSentencePopMarkers('>>!!{{文字}}!!<<'), '>>!!文字!!<<');
  assert.equal(h.stripSentenceShakeMarkers('>>!!{{文字}}!!<<'), '>>{{文字}}<<');
  assert.equal(h.stripSentenceFadeMarkers('!!>>{{文字}}<<!!', 'double'), '!!{{文字}}!!');
  // 全部剥除后得到纯正文，剥除顺序无关。
  const text = '!!>>{{文字}}<<!!';
  assert.equal(h.stripSentencePopMarkers(h.stripSentenceShakeMarkers(
    h.stripSentenceFadeMarkers(text, 'double'))), '文字');
  // 右键/批量包裹：句级对恒包裹在现有符号最外层，同一对不重复。
  assert.equal(h.wrapCharsAroundText('**文字**', '{{', '}}').text, '{{**文字**}}');
  assert.equal(h.wrapCharsAroundText('{{文字}}', '{{', '}}').skipped, true);
  assert.equal(h.wrapCharsAroundText('!!文字!!', '{{', '}}').text, '{{!!文字!!}}');
});

test('sentence marker reuses pop parameters regardless of the global enabled switch', () => {
  // 与单句 fade 复用 fad 参数同一模式：enabled=false 仍取 fromScale/inMs/accel。
  const parsed = h.assSentenceAnimationTags('{{文字}}', { animations: { pop: { enabled: false, fromScale: 1.6, inMs: 300, accel: 0.5 } } }, 'double');
  assert.deepEqual(plain(parsed), {
    text: '文字', fad: null,
    pop: { enabled: false, fromScale: 1.6, inMs: 300, accel: 0.5 },
  });
  assert.deepEqual(plain(h.assSentenceAnimationTags('文字', { animations: { pop: POP } }, 'double').pop), null);
  // fad 解耦回归：全局关闭时单句 `>>` 标记仍取到 inMs/outMs。
  const fade = h.assSentenceAnimationTags('>>文字<<', { animations: { fad: { enabled: false, inMs: 400, outMs: 120 } } }, 'double');
  assert.deepEqual(plain(fade.fad), { inMs: 400, outMs: 120 });
});

test('export emits a two-stage fscx/t pop tag and never leaks the marker', () => {
  const output = h.buildAssPayload([{ start: 0, end: 1000, text: '{{放大文字}}' }],
    { assProfile: popProfile(POP) });
  const line = dialogues(output)[0];
  assert.ok(line.includes('\\fscx140\\fscy140\\t(0,250,1,\\fscx100\\fscy100)'), line);
  assert.ok(!output.includes('{{'));
  assert.ok(line.includes('放大文字'));
  // 全局开关自动应用：无标记的句子也获得同一参数的 pop 标签。
  const global = dialogues(h.buildAssPayload([{ start: 0, end: 1000, text: '普通文字' }],
    { assProfile: popProfile({ ...POP, enabled: true }) }))[0];
  assert.ok(global.includes('\\fscx140\\fscy140\\t(0,250,1,\\fscx100\\fscy100)'), global);
  // 全局关闭且无标记：不产生 \fscx 也不产生 pop 的 \t。
  const off = dialogues(h.buildAssPayload([{ start: 0, end: 1000, text: '普通文字' }],
    { assProfile: popProfile(POP) }))[0];
  assert.ok(!off.includes('\\fscx'), off);
  assert.ok(!off.includes('\\t('), off);
});

test('pop targets the style scale instead of a hard-coded 100 percent', () => {
  const tags = h.assAnimationOverrideTags({ animations: { pop: POP } },
    { pop: POP, style: { scaleX: 150, scaleY: 100 } });
  assert.ok(tags.includes('\\fscx210\\fscy140\\t(0,250,1,\\fscx150\\fscy100)'), tags);
});

test('shaken pop cue keeps a continuous entrance clock across slices', () => {
  // inMs=180、间隔 60ms：前三片（偏移 0/60/120）带负相对时钟 \t，第四片起已落定。
  const output = h.buildAssPayload([{ start: 0, end: 400, text: '!!{{震}}!!' }],
    { assProfile: popProfile({ ...POP, inMs: 180 }) });
  const lines = dialogues(output);
  assert.equal(lines.length, Math.ceil(400 / h.ASS_SHAKE_INTERVAL_MS));
  assert.ok(lines[0].includes('\\fscx140\\fscy140\\t(0,180,1,'), lines[0]);
  assert.ok(lines[1].includes('\\t(-60,120,1,'), lines[1]);
  assert.ok(lines[2].includes('\\t(-120,60,1,'), lines[2]);
  assert.ok(!lines[3].includes('\\t('), lines[3]);
  assert.ok(!output.includes('{{'));
});

test('preview pop scale uses the same interpolation as the exported t tags', () => {
  const profile = { animations: { pop: POP } };
  const state = elapsed => h.assPreviewAnimationState(profile, elapsed, 1000, { pop: POP }).popScale;
  assert.equal(state(0), 1.4);
  assert.ok(Math.abs(state(125) - 1.2) < 1e-9);
  assert.ok(Math.abs(state(250) - 1) < 1e-9);
  assert.ok(Math.abs(state(999) - 1) < 1e-9);
  // accel 与导出同为 linear^accel：accel=2 在中点是 0.25 进度。
  const eased = h.assPreviewAnimationState(profile, 125, 1000, { pop: { ...POP, accel: 2 } }).popScale;
  assert.ok(Math.abs(eased - 1.3) < 1e-9);
  // 全局开关联动：不带单句 pop 时读取全局参数；两者皆无时恒为 1。
  const global = h.assPreviewAnimationState(popProfile({ ...POP, enabled: true }), 0, 1000).popScale;
  assert.equal(global, 1.4);
  assert.equal(h.assPreviewAnimationState(popProfile(POP), 0, 1000).popScale, 1);
  // inMs=0 表示立即落定：不发射标签，预览恒为 1。
  assert.equal(h.assPreviewAnimationState(profile, 0, 1000, { pop: { ...POP, inMs: 0 } }).popScale, 1);
});

test('pop entrance reserves stack bounds at the largest entrance state', () => {
  let plan;
  h.buildAssPayload([{ start: 0, end: 500, text: '{{文字}}' }, { start: 0, end: 500, text: '参照句' }],
    { assProfile: popProfile({ ...POP, fromScale: 2 }), onAssPlan: value => { plan = value; } });
  const popped = plan.slices[0].items.find(item => item.pop);
  assert.ok(popped, 'pop 参数应进入排布计划条目');
  assert.equal(popped.pop.fromScale, 2);
});

test('split completion fills the pop pair on both sides, including nested shells', () => {
  // 整句 pop：刀在正文里 → 两侧各自补成完整外壳（拆分-合并可往返）。
  assert.deepEqual(plain(h.completeSplitMassPairs('{{aa ', 'bb}}', 'both')),
    { left: '{{aa }}', right: '{{bb}}', leftAppend: '}}', rightPrepend: '{{' });
  // 嵌套在 `!!` 内：闭符号按嵌套逆序补（内层 `}}` 先闭），开符号按原序补。
  assert.deepEqual(plain(h.completeSplitMassPairs('!!{{aa ', 'bb}}!!', 'both')),
    { left: '!!{{aa }}!!', right: '!!{{bb}}!!', leftAppend: '}}!!', rightPrepend: '!!{{' });
  // 嵌套在 fade 内同理。
  assert.deepEqual(plain(h.completeSplitMassPairs('>>{{aa ', 'bb}}<<', 'both')),
    { left: '>>{{aa }}<<', right: '>>{{bb}}<<', leftAppend: '}}<<', rightPrepend: '>>{{' });
});

test('split completion ignores literal braces and never double-wraps a whole pop shell', () => {
  // 行内花括号对不在句级壳位置，不补齐（补了会把字面括号复制成可见文本）。
  assert.deepEqual(plain(h.completeSplitMassPairs('前{{中', '间}}后', 'both')),
    { left: '前{{中', right: '间}}后', leftAppend: '', rightPrepend: '' });
  // 两侧已各自完整（分层体系）：组合文本虽判出 pop 对，但不重复补壳。
  assert.deepEqual(plain(h.completeSplitMassPairs('{{aa}}', '{{bb}}', 'both')),
    { left: '{{aa}}', right: '{{bb}}', leftAppend: '', rightPrepend: '' });
  // 刀点恰在符号端点（正文/闭括号边界）时维持字面，不补齐。
  assert.deepEqual(plain(h.completeSplitMassPairs('{{aabb', '}}', 'both')),
    { left: '{{aabb', right: '}}', leftAppend: '', rightPrepend: '' });
});

test('merge fold reunites a split pop shell across the junction', () => {
  // 拆分-合并往返：拆分补齐产物（{{aa }} ｜ {{bb}}）合并后还原原句。
  const roundtrip = h.foldMassPairJunction('{{aa }}', '{{bb}}', 'both');
  assert.deepEqual(plain(roundtrip), { left: '{{aa ', right: 'bb}}', removed: 2, leftTrimmed: 2 });
  const joined = roundtrip.left + roundtrip.right;
  assert.equal(joined, '{{aa bb}}');
  assert.equal(h.parseSentencePopMarkers(joined).pop, true);
  // 手动独立包裹：{{甲}} + {{乙}} → {{甲乙}}（一个完整壳，无孤儿括号）。
  const manual = h.foldMassPairJunction('{{甲}}', '{{乙}}', 'both');
  assert.deepEqual(plain(manual), { left: '{{甲', right: '乙}}', removed: 2, leftTrimmed: 2 });
  assert.equal(h.srtSentenceText(manual.left + manual.right, 'both'), '甲乙');
  // 后段没有完整 pop 壳时不折叠，维持原样。
  assert.equal(h.foldMassPairJunction('{{aa}}', 'bb}}', 'both'), null);
});


test('disabled special symbols retain pop literals through parsing, split, merge and exports', () => {
  assert.deepEqual(plain(h.parseSentencePopMarkers('{{text}}', 'none')), { text: '{{text}}', pop: false });
  assert.equal(h.srtSentenceText('{{text}}', 'none'), '{{text}}');
  assert.equal(h.assSentenceAnimationTags('{{text}}', popProfile(POP), 'none').pop, null);
  assert.deepEqual(plain(h.completeSplitMassPairs('{{aa ', 'bb}}', 'none')),
    { left: '{{aa ', right: 'bb}}', leftAppend: '', rightPrepend: '' });
  assert.equal(h.foldMassPairJunction('{{aa}}', '{{bb}}', 'none'), null);
  const line = dialogues(h.buildAssPayload([{ start: 0, end: 1000, text: '{{text}}' }],
    { assSpecialSymbolRule: 'none', assProfile: popProfile(POP) }))[0];
  assert.ok(!line.includes('\\fscx140'));
  assert.ok(line.includes('text'));
});

test('nested opening pop braces remain literal during split completion', () => {
  assert.deepEqual(plain(h.completeSplitMassPairs('{{aa{{b', 'b}}', 'both')),
    { left: '{{aa{{b', right: 'b}}', leftAppend: '', rightPrepend: '' });
});

test('pop export preserves zero axis scale', () => {
  const tags = h.assAnimationOverrideTags({}, { pop: POP, style: { scaleX: 0, scaleY: 0 } });
  assert.equal(tags, String.raw`\fscx0\fscy0\t(0,250,1,\fscx0\fscy0)`);
});

test('pop bounds scale complete cue geometry including cue and inline scale', () => {
  const style = h.normalizeAssStyle({ fontSize: 40, spacing: 20, outline: 12, shadow: 10 });
  const make = fromScale => h.assCreateStackPlan({ width: 1920, height: 1080,
    profile: h.normalizeAssProfile(popProfile({ ...POP, fromScale })),
    items: [{ role: 'main', index: 0, start: 0, end: 1000, text: '++Wide++',
      style, fontSize: 40, runs: [{ text: 'Wide', fontSizeScale: 1.2 }], segment: { assOverride: { scale: 2 } }, pop: { ...POP, fromScale } },
      { role: 'overlay', index: 0, start: 0, end: 1000, style, fontSize: 40, runs: [{ text: 'Reference' }] }] });
  const base = make(1).slices[0].items[0].rect;
  const popped = make(2).slices[0].items[0].rect;
  for (const key of ['left', 'top', 'right', 'bottom']) assert.equal(popped[key], base[key] * 2);
});


test('custom scale transform interpolates after the current pop scale as libass does', () => {
  const style = h.assPreviewStyleAt({ scaleX: 100, scaleY: 50 }, String.raw`\fscx200\fscy200`, 0.5, { popScale: 1.2 });
  assert.equal(style.scaleX * 1.2, 160);
  assert.equal(style.scaleY * 1.2, 130);
});


test('pop and custom transform bounds cover interior scale extrema', () => {
  const profile = h.normalizeAssProfile(popProfile({ ...POP, enabled: true, fromScale: 2, inMs: 1000, accel: 2 },
    { t: { enabled: true, startMs: 0, endMs: 1000, accel: 1, tags: String.raw`\fscx210` } }));
  const style = h.normalizeAssStyle({ fontSize: 40 });
  const cue = { role: 'main', index: 0, start: 0, end: 1000, style, fontSize: 40, runs: [{ text: 'Wide' }] };
  const plan = h.assCreateStackPlan({ profile, items: [cue,
    { ...cue, role: 'overlay', start: 0, end: 500 }] });
  const rect = plan.slices[0].items[0].rect;
  const reference = h.assCreateStackPlan({ profile: h.normalizeAssProfile({}), items: [cue,
    { ...cue, role: 'overlay', start: 0, end: 500 }] }).slices[0].items[0].rect;
  // At t=.05445 the curve is 2.00264, above both slice endpoint scales 2 and 1.975.
  assert.ok((rect.right - rect.left) / (reference.right - reference.left) >= 2.00264);
});

test('overlay cue scale and positioning retain pop animation through shared export layout', () => {
  for (const positioned of [false, true]) {
    let plan;
    const output = h.buildAssPayload([{ id: 'main', start: 0, end: 1000, text: 'MAIN' }], {
      assProfile: popProfile({ ...POP, fromScale: 2 }), assStyle: { fontSize: 72 },
      overlaySegments: [{ id: 'overlay', start: 0, end: 1000, text: '{{OVERLAY}}',
        assOverride: { scale: 1.5, ...(positioned ? { pos: { x: 480, y: 320 } } : {}) } }],
      onAssPlan: value => { plan = value; },
    });
    const item = plan.slices[0].items.find(cue => cue.role === 'overlay');
    assert.equal(item.cueScale, 1.5);
    assert.equal(Boolean(item.manual), positioned);
    assert.equal(item.pop.fromScale, 2);
    const line = dialogues(output).find(event => event.startsWith('Dialogue: 2,'));
    assert.ok(line.includes(String.raw`\fs108`), 'overlay keeps per-cue font scaling');
    assert.ok(line.includes(String.raw`\fscx200\fscy200\t(0,250,1,\fscx100\fscy100)`));
    assert.ok(!line.includes('{{'), 'sentence marker becomes animation rather than visible text');
    if (positioned) {
      const frame = h.assStackFrame(plan, 125).items.find(cue => cue.role === 'overlay');
      assert.deepEqual(plain(frame.anchor), { x: 480, y: 320 });
      assert.ok(line.includes(String.raw`\pos(480,320)`));
    }
  }
});
