import assert from 'node:assert/strict';
import test from 'node:test';
import { loadEditorModule } from './helpers/editor-module-loader.mjs';
const context = { window: {} };
loadEditorModule(context, 'shared/editor-utils.js');
const h = context.window.AsrEditorUtils;
const plain = value => JSON.parse(JSON.stringify(value));
const INTERVAL = h.ASS_SHAKE_INTERVAL_MS;
const AMPLITUDE_1080 = Math.max(2, Math.round(1080 / 216));
const dialogues = output => output.split('\n').filter(line => line.startsWith('Dialogue:'));
const positions = line => [...line.matchAll(/\\(?:pos|move)\(([-\d.]+),([-\d.]+)/gu)]
  .map(match => match.slice(1).map(Number));

test('sentence shake marker parsing strips both ends only for double symbols with body', () => {
  assert.deepEqual(plain(h.parseSentenceShakeMarkers('!!震动!!')), { text: '震动', shake: true });
  assert.deepEqual(plain(h.parseSentenceShakeMarkers('普通文本')), { text: '普通文本', shake: false });
  assert.equal(h.stripSentenceShakeMarkers('!!震动!!'), '震动');
  assert.equal(h.stripSentenceShakeMarkers('普通文本'), '普通文本');
  // 四个字符时两端标记完全重叠，视为普通感叹号文本而不是空正文标记。
  assert.deepEqual(plain(h.parseSentenceShakeMarkers('!!!!')), { text: '!!!!', shake: false });
  assert.deepEqual(plain(h.parseSentenceShakeMarkers('!!a!!b!!')), { text: 'a!!b', shake: true });
  // 右键预设表登记双感叹号，且仅在 ASS 模式展示。
  assert.deepEqual(plain(h.WRAP_CHAR_PRESETS.find(preset => preset.id === 'shake')),
    { id: 'shake', label: '原地震动', left: '!!', right: '!!', ass: true });
});

test('export splits a shaken cue into interval events with exactly one pos and no move', () => {
  const output = h.buildAssPayload([{ start: 0, end: 1000, text: '!!震动文字!!' }], {
    assStyle: { fontSize: 64 }, assProfile: { animations: {
      fad: { enabled: true, inMs: 250, outMs: 250 } } },
  });
  const lines = dialogues(output);
  assert.equal(lines.length, Math.ceil(1000 / INTERVAL));
  for (const line of lines) {
    assert.equal(positions(line).length, 1);
    assert.ok(line.includes('\\pos('));
    assert.ok(!line.includes('\\move('));
    assert.ok(!line.includes('!!'));
    assert.ok(line.includes('震动文字'));
  }
  // 基准位置静止时，相位在四个对角之间循环，相邻两片的位移差等于两倍振幅。
  const [first, second] = lines.map(line => positions(line)[0]);
  assert.equal(first[0] - second[0], 2 * AMPLITUDE_1080);
  assert.equal(first[1] - second[1], 2 * AMPLITUDE_1080);
  // 淡入淡出使用负相对时钟跨片连续：第一片从 0 开始，后续片为负。
  assert.ok(lines[0].includes('\\fade(255,0,255,0,250,'));
  assert.ok(lines[1].includes('\\fade(255,0,255,-60,'));
});

test('profile move animation is sampled per slice instead of exported as one move tag', () => {
  const output = h.buildAssPayload([{ start: 0, end: 1000, text: '!!震动!!' }], {
    assStyle: { fontSize: 64 }, assProfile: { animations: {
      move: { enabled: true, x1: 10, y1: 20, x2: 510, y2: 720, t1: 0, t2: 1000 } } },
  });
  const lines = dialogues(output);
  const xs = lines.map(line => positions(line)[0][0]);
  // 基准沿 move 线性推进、抖动在对角间往复：奇数片基准比前一偶数片前进
  // 6ms*0.5 = 3px，两片间隔的采样点严格递增。
  assert.ok(xs[2] > xs[0]);
  assert.ok(xs[4] > xs[2]);
  assert.ok(lines.every(line => !line.includes('\\move(')));
});

test('shaken cue keeps emphasis runs and pre-wrapped legacy runs for q2 rendering', () => {
  let plan;
  const emphasized = h.buildAssPayload([{ start: 0, end: 200, text: '!!**震动**!!' }],
    { assProfile: {}, onAssPlan: value => { plan = value; } });
  assert.ok(plan.slices[0].items[0].runs.some(run => run.emphasized && run.text.includes('震动')));
  assert.ok(dialogues(emphasized)[0].includes('震动'));
  let longPlan;
  h.buildAssPayload([{ start: 0, end: 200, text: `!!${'长'.repeat(80)}!!` }],
    { assProfile: {}, onAssPlan: value => { longPlan = value; } });
  assert.ok(longPlan.slices[0].items[0].runs.some(run => run.text.includes('\n')));
  const longLine = dialogues(h.buildAssPayload([{ start: 0, end: 200, text: `!!${'长'.repeat(80)}!!` }], { assProfile: {} }))[0];
  assert.ok(longLine.includes('\\q2'));
});

test('manual anchor plus shake offsets every slice around the saved position without inline resets', () => {
  const output = h.buildAssPayload([{ start: 0, end: 200, text: '!!震动!!', assOverride: { pos: { x: 300, y: 200 } } }], { assProfile: {} });
  const lines = dialogues(output);
  assert.equal(lines.length, Math.ceil(200 / INTERVAL));
  const points = lines.map(line => positions(line)[0]);
  assert.deepEqual(points[0], [300 + AMPLITUDE_1080, 200 + AMPLITUDE_1080]);
  assert.deepEqual(points[1], [300 - AMPLITUDE_1080, 200 - AMPLITUDE_1080]);
  assert.deepEqual(points[2], [300 + AMPLITUDE_1080, 200 - AMPLITUDE_1080]);
  assert.deepEqual(points[3], [300 - AMPLITUDE_1080, 200 + AMPLITUDE_1080]);
  for (const line of lines) {
    assert.ok(line.includes('\\an2'));
    assert.ok(!line.includes('\\fs'));
    assert.ok(!line.includes('\\move('));
  }
});

test('stack frame preview offsets follow the same deterministic pattern and canvas resolution', () => {
  let plan;
  h.buildAssPayload([{ start: 100, end: 400, text: '!!震动!!' }, { start: 100, end: 400, text: '普通' }],
    { assProfile: {}, onAssPlan: value => { plan = value; } });
  // 同屏两句：普通句从 plan item 上读不到 shakeOffset，震动句按时间步进。
  const frameAt = timeMs => h.assStackFrame(plan, timeMs).items;
  const shaken = frameAt(100).find(item => item.shake);
  const still = frameAt(100).find(item => !item.shake);
  assert.equal(still.shakeOffset, undefined);
  assert.ok(!Object.hasOwn(still, 'shakeOffset'));
  assert.deepEqual(plain(shaken.shakeOffset), { x: AMPLITUDE_1080, y: AMPLITUDE_1080 });
  assert.deepEqual(plain(frameAt(159).find(item => item.shake).shakeOffset), { x: AMPLITUDE_1080, y: AMPLITUDE_1080 });
  assert.deepEqual(plain(frameAt(160).find(item => item.shake).shakeOffset), { x: -AMPLITUDE_1080, y: -AMPLITUDE_1080 });
  // 振幅随 PlayRes 高度缩放：360p 下回到最小振幅 2。
  let smallPlan;
  h.buildAssPayload([{ start: 0, end: 200, text: '!!震动!!' }],
    { assProfile: {}, playResX: 640, playResY: 360, onAssPlan: value => { smallPlan = value; } });
  assert.deepEqual(plain(h.assStackFrame(smallPlan, 0).items[0].shakeOffset), { x: 2, y: 2 });
});

test('grouped layout shakes only the marked cue and keeps scaled inline resets on its events', () => {
  const output = h.buildAssPayload([
    { id: 'a', start: 0, end: 2000, text: '!!底部震动!!' },
    { id: 'b', start: 0, end: 2000, text: '顶部普通' },
  ], { assProfile: {}, assStyle: { fontSize: 96 }, assExtensionStyle: { fontSize: 36 },
    extensionSegments: [{ start: 0, end: 2000, text: '副字幕' }] });
  const shakenLines = dialogues(output).filter(line => line.includes('底部震动'));
  const stillLines = dialogues(output).filter(line => line.includes('顶部普通'));
  assert.equal(stillLines.length, 1);
  assert.equal(positions(stillLines[0]).length, 1);
  assert.ok(!stillLines[0].includes('!!'));
  assert.equal(shakenLines.length, Math.ceil(2000 / INTERVAL));
  for (const line of shakenLines) {
    assert.equal(positions(line).length, 1);
    assert.ok(!line.includes('\\move('));
    assert.ok(line.includes('\\fs'));
  }
});

test('SRT export strips shake markers even though shake itself is ASS-only', () => {
  const srt = h.buildSrtPayload([
    { start: 0, end: 1000, text: '!!震动!!' },
    { start: 1000, end: 2000, text: '普通' },
  ], {});
  assert.ok(srt.includes('震动'));
  assert.ok(srt.includes('普通'));
  assert.ok(!srt.includes('!!'));
});

test('whole-sentence shells preserve size, shake and fade in either order without mutating segments', () => {
  for (const text of ['++!!喂喂喂嗯!!++', '>>++!!喂喂喂嗯!!++<<', '!!>>++喂喂喂嗯++<<!!']) {
    const segments = [{ start: 0, end: 1000, text }];
    const before = JSON.stringify(segments);
    let plan;
    const output = h.buildAssPayload(segments, { assStyle: { fontSize: 64, largeTextScale: 1.5 },
      assProfile: {}, onAssPlan: value => { plan = value; } });
    const lines = dialogues(output);
    assert.equal(lines.length, Math.ceil(1000 / INTERVAL));
    assert.ok(lines.every(line => line.includes('喂喂喂嗯') && !line.includes('!!') && !line.includes('++') && !line.includes('>>')));
    assert.ok(lines.some(line => line.includes(String.raw`\fs96`)));
    if (text.includes('>>')) assert.ok(lines[0].includes(String.raw`\fade(`));
    const cue = h.assStackFrame(plan, 500).items[0];
    assert.equal(cue.shake, true);
    assert.equal(cue.runs[0].size, 'large');
    assert.equal(JSON.stringify(segments), before);
    const srt = h.buildSrtPayload(segments, {});
    assert.ok(!srt.includes('!!') && !srt.includes('>>') && !srt.includes('<<'));
  }
});

test('right-click and batch wrapping preserve existing outer shells and skip nested duplicates', () => {
  const original = '>>++!!喂喂喂嗯!!++<<';
  const expected = '>>++!!**喂喂喂嗯**!!++<<';
  assert.equal(h.wrapCharsAroundText(original, '**', '**').text, expected);
  assert.equal(h.applyTextProcessing(original, { addWrapChars: true, wrapLeft: '**', wrapRight: '**', skipWrapped: true }), expected);
  assert.equal(h.wrapCharsAroundText(expected, '**', '**').skipped, true);
  assert.equal(h.applyTextProcessing(expected, { addWrapChars: true, wrapLeft: '!!', wrapRight: '!!', skipWrapped: true }), expected);
  assert.equal(h.parseSentenceShakeMarkers('++a++ !!b!!').shake, false);
});
