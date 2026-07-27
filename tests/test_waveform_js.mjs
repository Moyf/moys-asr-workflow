import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';


const source = fs.readFileSync(new URL('../web/waveform.js', import.meta.url), 'utf8');
const context = {
  window: {},
  atob: (value) => Buffer.from(value, 'base64').toString('binary'),
  btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
};
vm.runInNewContext(source, context);
const helpers = context.window.AsrWaveform.testing;


test('decodes compact signed min/max peaks', () => {
  const bytes = Buffer.from([0x81, 0x7f, 0xf6, 0x0a]);
  const decoded = helpers.decodePayload({
    schema: 'moy.asr.waveform.v1',
    encoding: 'i8-minmax-base64',
    peaks_per_second: 100,
    peak_count: 2,
    duration_ms: 20,
    data: bytes.toString('base64'),
  });
  assert.deepEqual(Array.from(decoded), [-127, 127, -10, 10]);
});


test('remaps word timestamps when a cue edge changes', () => {
  const items = [
    { text: 'A', start: 100, end: 300 },
    { text: 'B', start: 300, end: 500 },
  ];
  const remapped = helpers.remapItems(items, 100, 500, 200, 1000);
  assert.deepEqual(JSON.parse(JSON.stringify(remapped)), [
    { text: 'A', start: 200, end: 600 },
    { text: 'B', start: 600, end: 1000 },
  ]);
});


test('uses browser-compatible media signatures', () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.sourceForFile({ name: 'x.wav', size: 42, lastModified: 1234 }))),
    { name: 'x.wav', size: 42, modified_ms: 1234 },
  );
});


test('moves one shared boundary while preserving both cue durations', () => {
  const segments = [
    { start: 0, end: 1000 },
    { start: 1000, end: 2200 },
  ];
  const changed = helpers.applySharedBoundary(segments, 0, 1300, 100);
  assert.deepEqual(JSON.parse(JSON.stringify(changed)), [
    { start: 0, end: 1300 },
    { start: 1300, end: 2200 },
  ]);
});


test('Alt-drag moves only the hit side of a shared boundary, leaving the neighbor untouched', () => {
  // 共享边界在 1000：默认拖动会同时改左侧 end 和右侧 start；Alt 独立拖动只改被命中一侧。
  const segments = [
    { start: 0, end: 1000, items: [{ text: 'A', start: 0, end: 1000 }] },
    { start: 1000, end: 2200, items: [{ text: 'B', start: 1000, end: 2200 }] },
  ];
  // 拖动右侧段的 start（左半段 end 不变）
  helpers.applyIndependentEdge(segments, 0, 'start', 1500, 100);
  assert.deepEqual(JSON.parse(JSON.stringify(segments)), [
    { start: 0, end: 1000, items: [{ text: 'A', start: 0, end: 1000 }] },
    { start: 1500, end: 2200, items: [{ text: 'B', start: 1500, end: 2200 }] },
  ]);
  // 拖动左侧段的 end（右侧段 start 不变）
  helpers.applyIndependentEdge(segments, 0, 'end', 800, 100);
  assert.deepEqual(JSON.parse(JSON.stringify(segments)), [
    { start: 0, end: 800, items: [{ text: 'A', start: 0, end: 800 }] },
    { start: 1500, end: 2200, items: [{ text: 'B', start: 1500, end: 2200 }] },
  ]);
});


test('razor split snaps to the nearest item boundary and refuses 100ms edges', () => {
  const segment = {
    start: 1000, end: 5000, text: 'ABCD',
    items: [
      { text: 'A', start: 1000, end: 2000 },
      { text: 'B', start: 2000, end: 3000 },
      { text: 'C', start: 3000, end: 4000 },
      { text: 'D', start: 4000, end: 5000 },
    ],
  };
  // 指针在两个 item 边界正中时，选择后一个边界。
  const splitMid = helpers.splitSegmentAtTime(segment, 2500);
  assert.equal(splitMid.splitMs, 3000);
  assert.deepEqual(JSON.parse(JSON.stringify(splitMid.left.items)), [
    { text: 'A', start: 1000, end: 2000 },
    { text: 'B', start: 2000, end: 3000 },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(splitMid.right.items)), [
    { text: 'C', start: 3000, end: 4000 },
    { text: 'D', start: 4000, end: 5000 },
  ]);
  assert.equal(splitMid.left.end, 3000);
  assert.equal(splitMid.right.start, 3000);
  assert.equal(splitMid.left._dirty, true);
  assert.equal(splitMid.right._dirty, true);

  // 有 item 时间码时，边缘点击会吸附到最近的合法 item 边界。
  const splitEdge = helpers.splitSegmentAtTime(segment, 1050);
  assert.equal(splitEdge.splitMs, 2000);

  // 过短段（< 200ms）直接拒绝
  const tooShort = { start: 0, end: 150, text: 'X', items: [] };
  assert.equal(helpers.splitSegmentAtTime(tooShort, 75), null);
});


test('razor split without items falls back to the integer millisecond nearest the pointer', () => {
  const segment = { start: 1000, end: 4000, text: 'hello', items: [] };
  const split = helpers.splitSegmentAtTime(segment, 2300);
  assert.equal(split.splitMs, 2300);
  assert.equal(split.left.end, 2300);
  assert.equal(split.right.start, 2300);
  assert.equal(split.left.items, null);
  assert.equal(split.right.items, null);
});


test('clamps a new cue to the available gap and minimum duration', () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.normalizeNewCueRange(4500, 6200, 10000, 4000, 7000, 100))),
    { start: 4500, end: 6200 },
  );
  assert.deepEqual(
    helpers.normalizeNewCueRange(3900, 4050, 10000, 4000, 4100, 100),
    null,
  );
});


test('keeps waveform amplitude scale in a usable range', () => {
  assert.equal(helpers.clampWaveformScale(0.1), 0.25);
  assert.equal(helpers.clampWaveformScale(1.25), 1.25);
  assert.equal(helpers.clampWaveformScale(7), 6);
  // 振幅 >= 1 时步进 0.5
  assert.equal(helpers.waveformScaleAfterStep(1, 1), 1.5);
  assert.equal(helpers.waveformScaleAfterStep(1.5, -1), 1);
  assert.equal(helpers.waveformScaleAfterStep(5.8, 1), 6);
  // 振幅 < 1 时步进 0.25，可停在 0.25 / 0.5 / 0.75
  assert.equal(helpers.waveformScaleAfterStep(1, -1), 0.5);
  assert.equal(helpers.waveformScaleAfterStep(0.75, -1), 0.5);
  assert.equal(helpers.waveformScaleAfterStep(0.5, -1), 0.25);
  assert.equal(helpers.waveformScaleAfterStep(0.25, -1), 0.25); // 已到最小，不再下降
  assert.equal(helpers.waveformScaleAfterStep(0.25, 1), 0.5);
  assert.ok(helpers.waveformAmplitude(100, 2) > helpers.waveformAmplitude(100, 1.1));
  assert.ok(helpers.waveformAmplitude(100, 6) > helpers.waveformAmplitude(100, 3));
});


test('normalizes independent layout data and preserves the right-column preset', () => {
  const normalized = JSON.parse(JSON.stringify(helpers.normalizeLayoutData({
    schema: 'moy.asr.editor.layout.v1',
    preset: 'free',
    splitPercent: 64,
    columnPercent: 68,
    rows: [45, 25, 30],
    freeOrder: ['player', 'panel', 'cues', 'wave'],
  })));
  assert.equal(normalized.schema, 'moy.asr.editor.layout.v1');
  assert.equal(normalized.preset, 'free');
  assert.equal(normalized.splitPercent, 64);
  assert.equal(normalized.columnPercent, 68);
  assert.deepEqual(normalized.rows, [45, 25, 30]);
  assert.deepEqual(normalized.freeOrder, ['player', 'panel', 'cues', 'wave']);
  assert.equal(normalized.tree.type, 'split');
});


test('defaults the right-column layout to a wider waveform pane', () => {
  const normalized = helpers.normalizeLayoutData({ preset: 'wave-right' });
  assert.equal(normalized.columnPercent, 44);
});


test('migrates only the previous wave-right default to the more compact default', () => {
  const migrated = helpers.normalizeLayoutData({
    preset: 'wave-right',
    rows: [42, 27, 31],
  });
  const preserved = helpers.normalizeLayoutData({
    preset: 'wave-right',
    rows: [43, 27, 30],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(migrated.rows)), [42, 18, 40]);
  assert.deepEqual(JSON.parse(JSON.stringify(preserved.rows)), [43, 27, 30]);
});


test('allows the current cue row to shrink below the old eighteen-percent limit', () => {
  const compact = helpers.normalizeLayoutData({
    preset: 'wave-right',
    rows: [52, 6, 42],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(compact.rows)), [52, 6, 42]);
});


test('swaps free docking slots without mutating the source order', () => {
  const order = ['player', 'panel', 'cues', 'wave'];
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.swapFreeLayoutOrder(order, 'wave', 'panel'))),
    ['player', 'wave', 'cues', 'panel'],
  );
  assert.deepEqual(order, ['player', 'panel', 'cues', 'wave']);
});


test('inserts a module at an edge without losing the existing layout tree', () => {
  const base = helpers.normalizeLayoutData({ preset: 'free' });
  const insertedRight = helpers.insertLayoutModuleAtEdge(base.tree, 'wave', 'player', 'right');
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.collectLayoutModules(insertedRight))),
    ['player', 'wave', 'panel', 'cues'],
  );
  const insertedBottom = helpers.insertLayoutModuleAtEdge(base.tree, 'panel', 'wave', 'bottom');
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.collectLayoutModules(insertedBottom))),
    ['player', 'cues', 'wave', 'panel'],
  );
});


test('docks a module outside the whole layout tree at a window edge', () => {
  const base = helpers.normalizeLayoutData({ preset: 'free' });
  const dockedLeft = helpers.insertLayoutModuleAtRootEdge(base.tree, 'wave', 'left');
  assert.equal(dockedLeft.direction, 'row');
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.collectLayoutModules(dockedLeft.children[0]))),
    ['wave'],
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.collectLayoutModules(dockedLeft.children[1]))),
    ['player', 'panel', 'cues'],
  );

  const dockedBottom = helpers.insertLayoutModuleAtRootEdge(base.tree, 'panel', 'bottom');
  assert.equal(dockedBottom.direction, 'column');
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.collectLayoutModules(dockedBottom.children[0]))),
    ['player', 'cues', 'wave'],
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.collectLayoutModules(dockedBottom.children[1]))),
    ['panel'],
  );
});


test('uses center drops for swaps and edge drops for insertion', () => {
  const rect = { left: 10, top: 20, width: 200, height: 100 };
  const intent = (x, y) => JSON.parse(JSON.stringify(helpers.layoutDropIntent(rect, x, y)));
  assert.deepEqual(intent(110, 70), { mode: 'swap' });
  assert.deepEqual(intent(20, 70), { mode: 'insert', direction: 'left' });
  assert.deepEqual(intent(110, 115), { mode: 'insert', direction: 'bottom' });
});


test('reserves only the outermost workspace strip for whole-window docking', () => {
  const rect = { left: 10, top: 20, width: 1000, height: 600 };
  const intent = (x, y) => {
    const result = helpers.layoutRootDropIntent(rect, x, y);
    return result && JSON.parse(JSON.stringify(result));
  };
  assert.deepEqual(intent(30, 320), { mode: 'root-insert', direction: 'left' });
  assert.deepEqual(intent(990, 320), { mode: 'root-insert', direction: 'right' });
  assert.deepEqual(intent(510, 40), { mode: 'root-insert', direction: 'top' });
  assert.deepEqual(intent(510, 600), { mode: 'root-insert', direction: 'bottom' });
  assert.equal(intent(70, 320), null);
});


test('matches insertion previews to the narrow drop hit areas', () => {
  const moduleRect = { left: 100, top: 50, width: 400, height: 200 };
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.layoutDropPreviewRect(
      moduleRect,
      { mode: 'insert', direction: 'right' },
    ))),
    { left: 404, top: 50, width: 96, height: 200 },
  );

  const workspaceRect = { left: 10, top: 20, width: 1000, height: 600 };
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.layoutDropPreviewRect(
      workspaceRect,
      { mode: 'root-insert', direction: 'left' },
    ))),
    { left: 10, top: 20, width: 48, height: 600 },
  );
});


test('interpolates neighboring waveform peaks for maximum zoom rendering', () => {
  const peaks = new Int8Array([-100, 80, -40, 20]);
  assert.deepEqual(
    Array.from(helpers.sampleInterpolatedPeak(peaks, 0.5, 2)),
    [-70, 50],
  );
  assert.deepEqual(
    Array.from(helpers.sampleInterpolatedPeak(peaks, 99, 2)),
    [-40, 20],
  );
});
