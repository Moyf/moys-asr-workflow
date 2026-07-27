import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';


const source = fs.readFileSync(new URL('../web/editor-utils.js', import.meta.url), 'utf8');
const context = { window: {} };
vm.runInNewContext(source, context);
const helpers = context.window.AsrEditorUtils;


test('builds expandable replacement rows with before and after text', () => {
  const result = helpers.buildReplacementPreview(
    [
      { text: '猫喜欢鱼' },
      { text: '狗喜欢骨头' },
    ],
    [0, 1],
    '喜欢',
    '不讨厌',
    { caseSensitive: true, useRegex: false },
  );
  assert.equal(result.matchCount, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(result.rows)), [
    { index: 0, before: '猫喜欢鱼', after: '猫不讨厌鱼', matchCount: 1 },
    { index: 1, before: '狗喜欢骨头', after: '狗不讨厌骨头', matchCount: 1 },
  ]);
});


test('reports invalid regex without changing any rows', () => {
  const result = helpers.buildReplacementPreview(
    [{ text: 'abc' }],
    [0],
    '(',
    'x',
    { caseSensitive: false, useRegex: true },
  );
  assert.match(result.error, /Invalid|Unterminated|括号/i);
  assert.equal(result.rows.length, 0);
});


test('calculates current cue length and characters per second', () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.cueMetrics('Hiya fellas.', 34690, 35550))),
    { totalLength: 12, charsPerSecond: 13.95 },
  );
});

test('formats removed silence duration and media share for the summary', () => {
  assert.equal(helpers.formatHumanDuration(45_890), '45秒');
  assert.equal(helpers.formatHumanDuration(1_455_890), '24分15秒');
  assert.equal(helpers.formatHumanDuration(3_661_999), '1小时1分1秒');
  assert.equal(
    helpers.formatGapRemoveDuration(1_455_890, 5_823_560),
    '24分15秒（占比 25%）',
  );
  assert.equal(
    helpers.formatGapRemoveDuration(45_890, 100_000),
    '45秒（占比 45.9%）',
  );
  assert.equal(helpers.formatGapRemoveDuration(45_890, 0), '45秒');
});


test('finds previous and next visible cue for the current cue panel', () => {
  const segments = [
    { disabled: false },
    { disabled: true },
    { disabled: false },
    { disabled: false },
  ];
  assert.equal(helpers.findAdjacentCueIndex(segments, 2, -1, true), 0);
  assert.equal(helpers.findAdjacentCueIndex(segments, 0, 1, true), 2);
  assert.equal(helpers.findAdjacentCueIndex(segments, 2, 1, false), 3);
});


test('aligns SRT export to the first enabled subtitle when requested', () => {
  const segments = [
    { start: 1200, disabled: true },
    { start: 2450, disabled: false },
    { start: 4000 },
  ];
  assert.equal(helpers.getSrtExportOffset(segments, true), 2450);
  assert.equal(helpers.getSrtExportOffset(segments, false), 0);
  assert.equal(helpers.getSrtExportOffset([{ start: 500, disabled: true }], true), 0);
});


test('resolves referenced subtitle colors from their head when available', () => {
  const segments = [
    { color: { name: 'red' } },
    { color_ref: { name: 'stale', headIdx: 0 } },
    { color_ref: { name: 'blue', headIdx: 99 } },
    {},
  ];
  assert.equal(helpers.effectiveColorName(segments[0], segments), 'red');
  assert.equal(helpers.effectiveColorName(segments[1], segments), 'red');
  assert.equal(helpers.effectiveColorName(segments[2], segments), 'blue');
  assert.equal(helpers.effectiveColorName(segments[3], segments), null);
});


test('builds a color SRT on the shared full-export timeline and excludes disabled cues', () => {
  const segments = [
    { start: 500, end: 900, text: 'plain' },
    { start: 1000, end: 1800, text: 'lead', color: { name: 'red' } },
    { start: 2000, end: 2800, text: 'member', color_ref: { name: 'red', headIdx: 1 } },
    { start: 3000, end: 3800, text: 'disabled', color_ref: { name: 'red', headIdx: 1 }, disabled: true },
  ];
  assert.equal(helpers.buildSrtPayload(segments, {
    colorName: 'red',
    timeOffset: 500,
    formatTime: (timeMs) => `${timeMs}ms`,
  }), [
    '1',
    '500ms --> 1300ms',
    'lead',
    '',
    '2',
    '1500ms --> 2300ms',
    'member',
    '',
  ].join('\n'));
});


test('builds a gap-mapped color SRT with positive cue durations', () => {
  const segments = [
    { start: 1000, end: 1400, text: 'red', color: { name: 'red' } },
    { start: 1500, end: 1600, text: 'blue', color: { name: 'blue' } },
  ];
  assert.equal(helpers.buildSrtPayload(segments, {
    colorName: 'red',
    mapTime: () => 500,
    ensurePositiveDuration: true,
    formatTime: (timeMs) => `${timeMs}ms`,
  }), [
    '1',
    '500ms --> 501ms',
    'red',
    '',
  ].join('\n'));
});


test('prefers the media named by a project when JSON and media are selected together', () => {
  const files = [
    { name: 'other.mp3' },
    { name: 'take.mov' },
  ];
  assert.equal(
    helpers.findProjectMediaFile(files, 'D:/footage/take.mov', 'take.qwen3-asr.2.1x.json'),
    files[1],
  );
});


test('falls back to a matching project stem or one unambiguous selected media file', () => {
  const matchingStem = { name: 'take.wav' };
  assert.equal(
    helpers.findProjectMediaFile([matchingStem, { name: 'other.mp3' }], '', 'take.qwen3-asr.2.1x.json'),
    matchingStem,
  );
  const onlyFile = { name: 'anything.mp3' };
  assert.equal(helpers.findProjectMediaFile([onlyFile], '', 'project.json'), onlyFile);
});


test('finds only internal audio gaps that pass the gate threshold and minimum duration', () => {
  const gaps = helpers.detectAudioGapRemoveGaps({
    peaks: new Int8Array([
      -100, 100, 0, 0, 0, 0, 0, 0, 0, 0, -100, 100, 0, 0,
    ]),
    peaks_per_second: 10,
    duration_ms: 700,
  }, {
    minimumMs: 300,
    thresholdDb: -20,
    hysteresisDb: 6,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(gaps)), [
    { start: 100, end: 500, removed: true },
  ]);
});


test('uses hysteresis so a quieter but still audible section does not make a false gap', () => {
  const waveform = {
    peaks: new Int8Array([-30, 30, -10, 10, -10, 10, -30, 30]),
    peaks_per_second: 10,
    duration_ms: 400,
  };
  const withoutHysteresis = helpers.detectAudioGapRemoveGaps(waveform, {
    minimumMs: 100,
    thresholdDb: -20,
    hysteresisDb: 0,
  });
  const withHysteresis = helpers.detectAudioGapRemoveGaps(waveform, {
    minimumMs: 100,
    thresholdDb: -20,
    hysteresisDb: 6,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(withoutHysteresis)), [
    { start: 100, end: 300, removed: true },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(withHysteresis)), []);
});


test('applies lead-in and lead-out padding so gaps keep surrounding silence', () => {
  const waveform = {
    peaks: new Int8Array([
      -100, 100, 0, 0, 0, 0, 0, 0, 0, 0, -100, 100, 0, 0,
    ]),
    peaks_per_second: 10,
    duration_ms: 700,
  };
  const withoutPadding = helpers.detectAudioGapRemoveGaps(waveform, {
    minimumMs: 100,
    thresholdDb: -20,
    hysteresisDb: 6,
  });
  const withPadding = helpers.detectAudioGapRemoveGaps(waveform, {
    minimumMs: 100,
    thresholdDb: -20,
    hysteresisDb: 6,
    leadInMs: 30,
    leadOutMs: 100,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(withoutPadding)), [
    { start: 100, end: 500, removed: true },
  ]);
  // 原始静音 100–500；前端预留 30 抬到 130，后端预留 100 压到 400
  assert.deepEqual(JSON.parse(JSON.stringify(withPadding)), [
    { start: 130, end: 400, removed: true },
  ]);
});


test('drops a gap entirely when lead padding consumes its duration', () => {
  const gaps = helpers.detectAudioGapRemoveGaps({
    peaks: new Int8Array([
      -100, 100, 0, 0, 0, 0, 0, 0, 0, 0, -100, 100, 0, 0,
    ]),
    peaks_per_second: 10,
    duration_ms: 700,
  }, {
    minimumMs: 100,
    thresholdDb: -20,
    hysteresisDb: 6,
    leadInMs: 250,
    leadOutMs: 250,
  });
  // 预留总量 500ms 把原始 400ms 静音完全吃掉，整段不再算移除
  assert.deepEqual(JSON.parse(JSON.stringify(gaps)), []);
});


test('Alt-middle restoration only affects removed parts overlapped by the range', () => {
  const gaps = helpers.applyGapRemoveRange([
    { start: 100, end: 500, removed: true },
    { start: 700, end: 1000, removed: true },
  ], 300, 800, false);
  assert.deepEqual(JSON.parse(JSON.stringify(gaps)), [
    { start: 100, end: 300, removed: true },
    { start: 300, end: 500, removed: false },
    { start: 700, end: 800, removed: false },
    { start: 800, end: 1000, removed: true },
  ]);
});


test('middle-button range adds arbitrary silence and overrides restored ranges', () => {
  const gaps = helpers.applyGapRemoveRange([
    { start: 100, end: 400, removed: false },
    { start: 700, end: 900, removed: true },
  ], 250, 800, true);
  assert.deepEqual(JSON.parse(JSON.stringify(gaps)), [
    { start: 100, end: 250, removed: false },
    { start: 250, end: 900, removed: true },
  ]);
});


test('dragging a shared gap boundary adjusts both neighboring states', () => {
  const gaps = helpers.resizeGapRemoveBoundary([
    { start: 100, end: 400, removed: true },
    { start: 400, end: 700, removed: false },
  ], 0, 'end', 520);
  assert.deepEqual(JSON.parse(JSON.stringify(gaps)), [
    { start: 100, end: 520, removed: true },
    { start: 520, end: 700, removed: false },
  ]);
});


test('dragging a gap boundary into the next gap merges both ranges', () => {
  const gaps = helpers.resizeGapRemoveBoundary([
    { start: 100, end: 400, removed: true },
    { start: 700, end: 900, removed: false },
    { start: 1100, end: 1300, removed: true },
  ], 0, 'end', 750);
  assert.deepEqual(JSON.parse(JSON.stringify(gaps)), [
    { start: 100, end: 900, removed: true },
    { start: 1100, end: 1300, removed: true },
  ]);
});


test('maps source time and media intervals after restored gaps are excluded', () => {
  const gaps = [
    { start: 1000, end: 1600, removed: true },
    { start: 2400, end: 3000, removed: false },
    { start: 4000, end: 4500, removed: true },
  ];
  assert.equal(helpers.mapGapRemovedTime(900, gaps), 900);
  assert.equal(helpers.mapGapRemovedTime(1400, gaps), 1000);
  assert.equal(helpers.mapGapRemovedTime(5000, gaps), 3900);
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.buildGapRemovedIntervals(6000, gaps))), [
    { start: 0, end: 1000 },
    { start: 1600, end: 4000 },
    { start: 4500, end: 6000 },
  ]);
});

test('builds an ffconcat plan from kept media intervals', () => {
  assert.equal(helpers.buildFfconcat("D:\\Media\\Alice's take.mp4", [
    { start: 0, end: 1000 },
    { start: 1600, end: 4500 },
  ]), [
    'ffconcat version 1.0',
    "file 'D:/Media/Alice'\\''s take.mp4'",
    'inpoint 0.000',
    'outpoint 1.000',
    "file 'D:/Media/Alice'\\''s take.mp4'",
    'inpoint 1.600',
    'outpoint 4.500',
    '',
  ].join('\n'));
});


test('maps a waveform click to the nearest timestamped word boundary', () => {
  const segment = {
    start: 0,
    end: 1200,
    text: '你好，世界！',
    items: [
      { text: '你好', start: 0, end: 400 },
      { text: '世界', start: 600, end: 1000 },
      { text: '！', start: 1000, end: 1200 },
    ],
  };
  assert.equal(helpers.splitCharOffsetAtTime(segment, 520), 3);
  assert.equal(helpers.splitCharOffsetAtTime(segment, 1080), 3);
  assert.equal(helpers.splitCharOffsetAtTime({
    start: 0,
    end: 100,
    text: '好！',
    items: [
      { text: '好', start: 0, end: 80 },
      { text: '！', start: 80, end: 100 },
    ],
  }, 90), null);
});


test('waveform split fallback keeps the caret on a Unicode character boundary', () => {
  const segment = { start: 0, end: 300, text: 'A😀B' };
  assert.equal(helpers.splitCharOffsetAtTime(segment, 200), 3);
  assert.equal(helpers.splitCharOffsetAtTime({ start: 0, end: 100, text: '猫' }, 50), null);
});


test('shares configured Enter semantics between list editing and current cue editing', () => {
  assert.equal(helpers.configuredEnterAction({ key: 'Enter', ctrlKey: true }, 'ctrl-enter'), 'split');
  assert.equal(helpers.configuredEnterAction({ key: 'Enter' }, 'ctrl-enter'), 'save');
  assert.equal(helpers.configuredEnterAction({ key: 'Enter' }, 'enter'), 'split');
  assert.equal(helpers.configuredEnterAction({ key: 'Enter', ctrlKey: true }, 'enter'), 'save');
  assert.equal(helpers.configuredEnterAction({ key: 'Enter', shiftKey: true }, 'ctrl-enter'), 'newline');
  assert.equal(
    helpers.configuredEnterAction({ key: 'Enter', shiftKey: true, ctrlKey: true }, 'enter'),
    'split',
  );
});


test('history stack: push clears redo and peek reports top without popping', () => {
  const h = helpers.createHistoryStack(100);
  assert.equal(h.canUndo(), false);
  assert.equal(h.canRedo(), false);
  assert.equal(h.peekUndo(), null);
  h.push({ kind: 'segments', label: 'A', segs: [1] });
  h.push({ kind: 'segments', label: 'B', segs: [2] });
  assert.equal(h.undoLength(), 2);
  assert.equal(h.canUndo(), true);
  assert.deepEqual(h.peekUndo(), { kind: 'segments', label: 'B', segs: [2] });
  assert.equal(h.undoLength(), 2); // peek 不消费
});


test('history stack: popUndo/popRedo round-trip restores records and mirrors current snapshots', () => {
  const h = helpers.createHistoryStack(100);
  h.push({ kind: 'segments', label: 'edit1', segs: ['after1'] });
  h.push({ kind: 'segments', label: 'edit2', segs: ['after2'] });

  // undo edit2: 当前状态 'after2' 进入 redo，返回 'edit2'（其 segs 是 edit2 之前的快照）
  const undoRecord = h.popUndo({ kind: 'segments', label: 'edit2', segs: ['after2'] });
  assert.deepEqual(undoRecord, { kind: 'segments', label: 'edit2', segs: ['after2'] });
  assert.equal(h.undoLength(), 1);
  assert.equal(h.redoLength(), 1);
  assert.equal(h.canRedo(), true);

  // redo edit2: 当前状态（刚还原的 'edit2' 之前状态）回到 undo，返回 redo 顶部 'after2'
  const redoRecord = h.popRedo({ kind: 'segments', label: 'edit2', segs: ['before2'] });
  assert.deepEqual(redoRecord, { kind: 'segments', label: 'edit2', segs: ['after2'] });
  assert.equal(h.undoLength(), 2);
  assert.equal(h.redoLength(), 0);
});


test('history stack: a new push after undo clears the redo stack', () => {
  const h = helpers.createHistoryStack(100);
  h.push({ kind: 'segments', label: 'A', segs: [1] });
  h.popUndo({ kind: 'segments', label: 'A', segs: [1] });
  assert.equal(h.redoLength(), 1);
  h.push({ kind: 'segments', label: 'B', segs: [2] });
  assert.equal(h.redoLength(), 0);
  assert.equal(h.canRedo(), false);
  assert.equal(h.undoLength(), 1);
});


test('history stack: limit trims oldest undo entries and clamps to at least 1', () => {
  const h = helpers.createHistoryStack(3);
  h.push({ label: 'a' });
  h.push({ label: 'b' });
  h.push({ label: 'c' });
  h.push({ label: 'd' });
  assert.equal(h.undoLength(), 3);
  assert.equal(h.peekUndo().label, 'd');
  // 最旧的 'a' 被裁掉
  const first = h.popUndo({ label: 'cur' });
  assert.equal(first.label, 'd');
  const second = h.popUndo({ label: 'cur' });
  assert.equal(second.label, 'c');
  const third = h.popUndo({ label: 'cur' });
  assert.equal(third.label, 'b');
  assert.equal(h.canUndo(), false);
  // undo 已空：popUndo 返回 null，不抛错；redo 仍持有 3 条镜像
  assert.equal(h.popUndo({ label: 'x' }), null);
  assert.equal(h.redoLength(), 3);
  // 清空 redo 后 popRedo 才返回 null
  h.clearRedo();
  assert.equal(h.popRedo({ label: 'x' }), null);
});


test('history stack: clear and clearRedo reset the right stacks', () => {
  const h = helpers.createHistoryStack(100);
  h.push({ label: 'a' });
  h.popUndo({ label: 'cur' });
  h.push({ label: 'b' });
  // undo=[b], redo=[] 已被 push 清空
  assert.equal(h.redoLength(), 0);
  h.popUndo({ label: 'cur' });
  // undo=[], redo=[cur]
  assert.equal(h.undoLength(), 0);
  assert.equal(h.redoLength(), 1);
  h.clearRedo();
  assert.equal(h.redoLength(), 0);
  h.push({ label: 'c' });
  h.push({ label: 'd' });
  h.clear();
  assert.equal(h.undoLength(), 0);
  assert.equal(h.redoLength(), 0);
});
