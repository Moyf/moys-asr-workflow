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
  // 右键预设表登记双感叹号（句级效果），且仅在 ASS 模式展示。
  assert.deepEqual(plain(h.WRAP_CHAR_PRESETS.find(preset => preset.id === 'shake')),
    { id: 'shake', label: '原地震动', left: '!!', right: '!!', ass: true, sentenceLevel: true });
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

test('scale-only shake keeps the global anchor and scales every exported slice', () => {
  const build = scale => h.buildAssPayload([{ start: 0, end: 200, text: '!!震动!!',
    ...(scale === 1 ? {} : { assOverride: { scale } }) }], { assStyle: { fontSize: 80 }, assProfile: {} });
  const plainLines = dialogues(build(1));
  const scaledLines = dialogues(build(1.22));
  assert.equal(scaledLines.length, plainLines.length);
  assert.ok(scaledLines.every(line => line.includes('\\fs97.6')));
  assert.ok(scaledLines.every(line => line.includes('\\an2')));
  assert.ok(scaledLines.every(line => !line.includes('\\move(')));
  const plainFirst = positions(plainLines[0])[0];
  const scaledFirst = positions(scaledLines[0])[0];
  assert.ok(Math.abs(scaledFirst[0] - plainFirst[0] - AMPLITUDE_1080 * 0.22) < 0.001);
  assert.ok(Math.abs(scaledFirst[1] - plainFirst[1] - AMPLITUDE_1080 * 0.22) < 0.001);
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

test('SRT sentence effects follow the symbol rule in either nesting order and parse fade once', () => {
  for (const [text, rule, expected] of [
    ['>!!text!!<', 'both', 'text'], ['!!>text<!!', 'both', 'text'],
    ['>>!!text!!<<', 'double', 'text'], ['!!>>text<<!!', 'double', 'text'],
    // MASS 成对符号（含 ++ 与行内 !! 对）随任务 4 一并剥离，孤儿保留字面
    ['++>!!text!!<++', 'both', 'text'],
    ['>>>>!!text!!<<<<', 'double', '>>text<<'], ['>>>>text<<<<', 'double', '>>text<<'],
    ['>!!text!!<', 'double', '>text<'], ['!!>text<!!', 'double', '>text<'],
    ['>!!text!!<', 'none', '>!!text!!<'], ['!!>text<!!', 'none', '>text<'],
    ['>>!!text!!<<', 'none', '>>text<<'], ['!!text!!', 'none', 'text'],
    ['>!!text<', 'both', '!!text'], ['plain !!inline!! text', 'both', 'plain inline text'],
  ]) {
    const cue = { start: 0, end: 1000, text };
    const options = { assSpecialSymbolRule: rule };
    const srt = h.buildSrtPayload([cue], options);
    assert.equal(srt, `1\n0 --> 1000\n${expected}\n`, `${rule}: ${text}`);
    assert.equal(h.buildBilingualSrtPayload([cue], [], options), srt, `bilingual ${rule}: ${text}`);
    assert.equal(cue.text, text);
  }
});

test('bilingual SRT cleans each cue before labels and merging without reparsing combined literal text', () => {
  const main = [{ start: 0, end: 1000, text: '>!!main!!<', color: { name: 'red' } }];
  const secondary = [{ start: 0, end: 1000, text: '!!>translation<!!', color: { name: 'red' } }];
  const options = { assSpecialSymbolRule: 'both', speakerLabelsEnabled: true,
    speakerLabels: { red: 'Speaker' }, speakerLabelSeparator: ': ' };
  const single = h.buildSrtPayload(main, options);
  assert.equal(single, '1\n0 --> 1000\nSpeaker: main\n');
  assert.equal(h.buildBilingualSrtPayload(main, secondary, options),
    single.replace('main\n', 'main\nSpeaker: translation\n'));
  assert.equal(h.buildBilingualSrtPayload([{ ...main[0], text: '!!literal' }],
    [{ ...secondary[0], text: 'literal!!' }], {}), '1\n0 --> 1000\n!!literal\nliteral!!\n');
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

const shakeEventTime = value => {
  const [hours, minutes, seconds] = value.split(':').map(Number);
  return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
};

function shakeEvents(output, text) {
  return dialogues(output).filter(line => line.includes(text)).map(line => {
    const fields = line.split(',');
    assert.equal(positions(line).length, 1);
    assert.ok(!line.includes('\\move('));
    return { start: shakeEventTime(fields[1]), end: shakeEventTime(fields[2]), pos: positions(line)[0] };
  }).sort((a, b) => a.start - b.start);
}

function assertShakeCoverageAndPhase(plan, events, id, { moving = false } = {}) {
  const cue = plan.slices.flatMap(slice => slice.items).find(item => item.segment.id === id);
  assert.ok(cue);
  assert.equal(events[0].start, cue.start);
  assert.equal(events.at(-1).end, cue.end);
  for (const [index, event] of events.entries()) {
    assert.ok(event.end > event.start);
    assert.equal(event.start % 10, 0);
    assert.equal(event.end % 10, 0);
    if (index) assert.equal(events[index - 1].end, event.start);
  }
  // Check every integer millisecond, including both sides of each boundary.
  // Moving bases are sampled at event start; only shake phase is compared at
  // later frames, without claiming continuous move equals sampled ASS pos.
  for (let time = cue.start; time < cue.end; time += 1) {
    const active = events.filter(event => event.start <= time && time < event.end);
    assert.equal(active.length, 1, `unique event at ${time}ms`);
    const frame = h.assStackFrame(plan, time).items.find(item => item.segment.id === id);
    const base = moving
      ? h.assStackFrame(plan, active[0].start).items.find(item => item.segment.id === id).anchor
      : frame.anchor;
    for (const [axis, index] of [['x', 0], ['y', 1]]) {
      assert.ok(Math.abs(active[0].pos[index] - base[axis] - frame.shakeOffset[axis]) < 0.0002,
        `${axis} shake phase at ${time}ms in [${active[0].start},${active[0].end})`);
    }
  }
}

test('shake phase survives overlapping cue start and end between original phase boundaries', () => {
  let plan;
  const output = h.buildAssPayload([
    { id: 'shake-phase', start: 100, end: 400, text: '!!phase-static!!', assOverride: { pos: { x: 300, y: 200 } } },
    { id: 'overlap', start: 200, end: 300, text: 'other' },
  ], { assProfile: {}, onAssPlan: value => { plan = value; } });
  const events = shakeEvents(output, 'phase-static');
  assertShakeCoverageAndPhase(plan, events, 'shake-phase');
  assert.deepEqual(events.map(event => [event.start, event.end]),
    [[100, 160], [160, 200], [200, 220], [220, 280], [280, 300], [300, 340], [340, 400]]);
});

test('scaled automatic shake uses group scale for its offset and combined scale for amplitude', () => {
  let plan;
  const output = h.buildAssPayload([
    { id: 'base', start: 0, end: 180, text: Array(8).fill('base').join('\n') },
    { id: 'scaled-shake', start: 0, end: 180,
      text: `!!${Array(8).fill('shake').join('\n')}!!`, assOverride: { scale: 0.62 } },
  ], { assProfile: {}, assStyle: { fontSize: 150 }, playResX: 640, playResY: 360,
    onAssPlan: value => { plan = value; } });
  const slice = plan.slices[0];
  const item = slice.items.find(entry => entry.segment.id === 'scaled-shake');
  const frame = h.assStackFrame(plan, 0).items.find(entry => entry.segment.id === 'scaled-shake');
  const combinedAmplitude = h.assShakeAmplitude(slice.height) * slice.scale * item.cueScale;
  assert.equal(slice.legacy, false);
  assert.ok(slice.scale < 1, `expected group fitting but got scale ${slice.scale} in ${JSON.stringify(slice.box)}`);
  assert.ok(Math.abs(item.offset.y) > 1);
  assert.equal(item.cueScale, 0.62);
  assert.deepEqual(plain(frame.shakeOffset), plain(h.assShakeOffsetFor(0, combinedAmplitude)));
  assertShakeCoverageAndPhase(plan, shakeEvents(output, 'shake'), 'scaled-shake');
});

test('shake phase uses the ASS-quantized cue origin for non-centisecond input', () => {
  let plan;
  const output = h.buildAssPayload([
    { id: 'quantized-phase', start: 107, end: 407, text: '!!phase-quantized!!', assOverride: { pos: { x: 300, y: 200 } } },
    { id: 'overlap', start: 205, end: 305, text: 'other' },
  ], { assProfile: {}, onAssPlan: value => { plan = value; } });
  const events = shakeEvents(output, 'phase-quantized');
  assert.equal(plan.slices[0].items.find(item => item.shake).start, 110);
  assertShakeCoverageAndPhase(plan, events, 'quantized-phase');
  assert.deepEqual(events.map(event => [event.start, event.end]),
    [[110, 170], [170, 210], [210, 230], [230, 290], [290, 310], [310, 350], [350, 410]]);
});

test('shake phase survives non-periodic move layout piece boundaries', () => {
  let plan;
  const output = h.buildAssPayload([
    { id: 'moving-phase', start: 100, end: 500, text: '!!phase-moving!!' },
    { id: 'stacked', start: 100, end: 500, text: 'other' },
  ], { assProfile: { animations: { move: {
    enabled: true, x1: 800, y1: 600, x2: 900, y2: 650, t1: 100, t2: 250,
  } } }, onAssPlan: value => { plan = value; } });
  const events = shakeEvents(output, 'phase-moving');
  const boundaries = plan.slices.flatMap(slice => slice.pieces.slice(1).map(piece => piece.start));
  assert.ok(boundaries.includes(200));
  assert.ok(boundaries.includes(350));
  assertShakeCoverageAndPhase(plan, events, 'moving-phase', { moving: true });
  for (const time of [200, 220, 350, 400]) assert.ok(events.some(event => event.start === time));
});
