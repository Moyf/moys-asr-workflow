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
const builtinWorkspaces = context.window.AsrWaveform.builtinWorkspaces;


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


test('uses deltaX when macOS remaps Shift+wheel', () => {
  assert.equal(helpers.wheelScrollDelta({ deltaY: 0, deltaX: -120 }), -120);
  assert.equal(helpers.wheelScrollDelta({ deltaY: 0, deltaX: 120 }), 120);
  assert.equal(helpers.wheelScrollDelta({ deltaY: -120, deltaX: 0 }), -120);
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


test('keeps remapped items inside the cue and never zero-length', () => {
  const items = [
    { text: 'A', start: -50, end: 60 },
    { text: 'B', start: 60, end: 1050 },
  ];
  // 波形 remap 按 10ms 网格取整；越界值钳回段内
  const remapped = helpers.remapItems(items, 0, 1000, 0, 100);
  assert.deepEqual(JSON.parse(JSON.stringify(remapped)), [
    { text: 'A', start: 0, end: 10 },
    { text: 'B', start: 10, end: 100 },
  ]);
  // 极端压缩到 1ms 段时，词块仍保持 end > start
  const squeezed = helpers.remapItems(
    [{ text: 'A', start: 0, end: 500 }, { text: 'B', start: 500, end: 1000 }],
    0, 1000, 0, 1,
  );
  squeezed.forEach((item) => assert.ok(item.end > item.start));
});


test('clamps straddling items into their split side', () => {
  const segment = {
    start: 0,
    end: 1000,
    text: 'AB',
    items: [
      { text: 'A', start: 0, end: 480 },
      { text: 'B', start: 480, end: 1000 },
    ],
  };
  const result = helpers.splitSegmentAtTime(segment, 500);
  assert.ok(result);
  assert.deepEqual(JSON.parse(JSON.stringify(result.left.items)), [
    { text: 'A', start: 0, end: 480 },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.right.items)), [
    { text: 'B', start: 480, end: 1000 },
  ]);
  // 单个跨切点的词：归入左段时 end 钳到切点，归入右段时 start 钳到切点
  const single = { start: 0, end: 1000, text: 'AB', items: [{ text: 'AB', start: 0, end: 1000 }] };
  const leftSide = helpers.splitSegmentAtTime(single, 499);
  assert.ok(leftSide);
  assert.deepEqual(JSON.parse(JSON.stringify(leftSide.left.items)), [
    { text: 'AB', start: 0, end: 499 },
  ]);
  assert.equal(leftSide.right.items, null);
  const rightSide = helpers.splitSegmentAtTime(single, 501);
  assert.ok(rightSide);
  assert.equal(rightSide.left.items, null);
  assert.deepEqual(JSON.parse(JSON.stringify(rightSide.right.items)), [
    { text: 'AB', start: 501, end: 1000 },
  ]);
});


test('uses browser-compatible media signatures', () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.sourceForFile({ name: 'x.wav', size: 42, lastModified: 1234 }))),
    { name: 'x.wav', size: 42, modified_ms: 1234 },
  );
});


test('uses display defaults for each built-in workspace preset', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(builtinWorkspaces.classic.editorDisplay)), {
    cueListShowIndex: true,
    cueListShowTime: true,
    cueListShowSticker: true,
    cueListShowCharcount: true,
    cueEditorShowNavigation: true,
    cueEditorShowTimeActions: true,
    cueEditorShowSticker: true,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(builtinWorkspaces.cinema.editorDisplay)), {
    cueListShowIndex: true,
    cueListShowTime: true,
    cueListShowSticker: true,
    cueListShowCharcount: true,
    cueEditorShowNavigation: false,
    cueEditorShowTimeActions: true,
    cueEditorShowSticker: false,
  });
  assert.equal(builtinWorkspaces['wave-right'].editorDisplay.cueEditorShowTimeActions, false);
});


test('registers the three-fold built-in workspace from the example layout', () => {
  const workspace = builtinWorkspaces['three-fold'];
  assert.equal(workspace.preset, 'custom');
  assert.equal(workspace.waveformMode, 'multi');
  assert.deepEqual(JSON.parse(JSON.stringify(workspace.rows)), [42, 16, 42]);
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.collectLayoutModules(workspace.tree))), [
    'panel', 'player', 'cues', 'wave',
  ]);
  assert.equal(workspace.tree.ratio, 28.32664152704568);
  assert.equal(workspace.tree.children[0].ratio, 29.702416354679702);
  assert.equal(workspace.tree.children[1].ratio, 34.57890198332854);
  assert.equal(workspace.waveformSettings.waveformScale, 4);
  assert.equal(workspace.editorDisplay.cueListShowTime, false);
  assert.equal(workspace.editorDisplay.cueEditorShowNavigation, true);
  assert.equal(workspace.editorDisplay.cueEditorShowTimeActions, true);
  assert.equal(workspace.editorDisplay.cueEditorShowSticker, true);
});


test('registers the cinema built-in workspace from the example layout', () => {
  const workspace = builtinWorkspaces.cinema;
  assert.equal(workspace.preset, 'custom');
  assert.equal(workspace.waveformMode, 'basic');
  assert.deepEqual(JSON.parse(JSON.stringify(workspace.rows)), [42, 18, 40]);
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.collectLayoutModules(workspace.tree))), [
    'player', 'panel', 'cues', 'wave',
  ]);
  assert.equal(workspace.tree.ratio, 72.711956653046);
  assert.equal(workspace.tree.children[0].ratio, 55.207499921561244);
  assert.equal(workspace.tree.children[0].children[1].ratio, 20);
  assert.equal(workspace.waveformSettings.waveformScale, 5.5);
  assert.equal(workspace.editorDisplay.cueListShowTime, true);
  assert.equal(workspace.editorDisplay.cueEditorShowNavigation, false);
  assert.equal(workspace.editorDisplay.cueEditorShowTimeActions, true);
  assert.equal(workspace.editorDisplay.cueEditorShowSticker, false);
});


test('keeps color and sticker group badges independent for overlapping groups', () => {
  const badges = helpers.computeGroupBadges([
    { color: { name: 'red' } },
    { color_ref: { headIdx: 0 }, sticker: { name: 'haha' } },
    { color_ref: { headIdx: 0 }, sticker_ref: { headIdx: 1 } },
    { sticker_ref: { headIdx: 1 } },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(badges.get(1))), [
    { type: 'color', ordinal: 2, total: 3 },
    { type: 'sticker', ordinal: 1, total: 3 },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(badges.get(2))), [
    { type: 'color', ordinal: 3, total: 3 },
    { type: 'sticker', ordinal: 2, total: 3 },
  ]);
});

test('shows a sticker badge even when the sticker has no group members', () => {
  const badges = helpers.computeGroupBadges([
    { sticker: { name: 'solo' } },
    { color: { name: 'red' } },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(badges.get(0))), [
    { type: 'sticker', ordinal: 1, total: 1 },
  ]);
  assert.equal(badges.has(1), false);
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


test('keyboard movement ripples an attached following cue but Alt leaves it fixed', () => {
  const linked = [
    { start: 500, end: 1500, items: [{ text: 'A', start: 500, end: 1500 }] },
    { start: 1500, end: 3000, items: [{ text: 'B', start: 1500, end: 3000 }] },
  ];
  const movedAway = helpers.applyMoveStep(linked, [0], -100, 4000, { sticky: true });
  assert.equal(movedAway.appliedDelta, -100);
  assert.deepEqual(JSON.parse(JSON.stringify(linked)), [
    { start: 400, end: 1400, items: [{ text: 'A', start: 400, end: 1400 }] },
    { start: 1400, end: 3000, items: [{ text: 'B', start: 1400, end: 3000 }] },
  ]);

  const independent = [
    { start: 500, end: 1500 },
    { start: 1500, end: 3000 },
  ];
  helpers.applyMoveStep(independent, [0], -100, 4000, { sticky: false });
  assert.deepEqual(JSON.parse(JSON.stringify(independent)), [
    { start: 400, end: 1400 },
    { start: 1500, end: 3000 },
  ]);
  const compressed = helpers.applyMoveStep(independent, [0], 100, 4000, { sticky: false });
  assert.equal(compressed.appliedDelta, 100);
  assert.deepEqual(JSON.parse(JSON.stringify(independent)), [
    { start: 500, end: 1500 },
    { start: 1500, end: 3000 },
  ]);
  const blocked = helpers.applyMoveStep(independent, [0], 100, 4000, { sticky: false });
  assert.equal(blocked.changed, false);
});


test('keyboard movement ripples an attached preceding cue when moving left', () => {
  const segments = [
    { start: 500, end: 1500, items: [{ text: 'A', start: 500, end: 1500 }] },
    { start: 1500, end: 3000, items: [{ text: 'B', start: 1500, end: 3000 }] },
  ];
  const moved = helpers.applyMoveStep(segments, [1], -100, 4000, { sticky: true });
  assert.equal(moved.appliedDelta, -100);
  assert.deepEqual(JSON.parse(JSON.stringify(segments)), [
    { start: 500, end: 1400, items: [{ text: 'A', start: 500, end: 1400 }] },
    { start: 1400, end: 2900, items: [{ text: 'B', start: 1400, end: 2900 }] },
  ]);
});


test('keyboard boundary adjustment follows the shared boundary and Alt isolates the target', () => {
  const linked = [
    { start: 0, end: 1000, items: [{ text: 'A', start: 0, end: 1000 }] },
    { start: 1000, end: 2200, items: [{ text: 'B', start: 1000, end: 2200 }] },
  ];
  helpers.applyBoundaryStep(linked, 0, 'end', 100, 3000, { sticky: true });
  assert.deepEqual(JSON.parse(JSON.stringify(linked)), [
    { start: 0, end: 1100, items: [{ text: 'A', start: 0, end: 1100 }] },
    { start: 1100, end: 2200, items: [{ text: 'B', start: 1100, end: 2200 }] },
  ]);

  const independent = [
    { start: 0, end: 1000 },
    { start: 1000, end: 2200 },
  ];
  const plan = helpers.applyBoundaryStep(independent, 0, 'end', 100, 3000, { sticky: false });
  assert.equal(plan.changed, false);
  assert.deepEqual(JSON.parse(JSON.stringify(independent)), [
    { start: 0, end: 1000 },
    { start: 1000, end: 2200 },
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


test('normalizes independent workspace data and preserves the right-column preset', () => {
  const normalized = JSON.parse(JSON.stringify(helpers.normalizeLayoutData({
    schema: 'moy.asr.editor.workspace.v1',
    preset: 'custom',
    splitPercent: 64,
    columnPercent: 68,
    rows: [45, 25, 30],
  })));
  assert.equal(normalized.schema, 'moy.asr.editor.workspace.v1');
  assert.equal(normalized.preset, 'custom');
  assert.equal(normalized.splitPercent, 64);
  assert.equal(normalized.columnPercent, 68);
  assert.deepEqual(normalized.rows, [45, 25, 30]);
  assert.equal(normalized.tree.type, 'split');
  // 未知或旧版渲染器值（如 free / wave-bottom）一律回退到默认 wave-right
  assert.equal(helpers.normalizeLayoutData({ preset: 'free' }).preset, 'wave-right');
  assert.equal(helpers.normalizeLayoutData({ preset: 'wave-bottom' }).preset, 'wave-right');
});


test('defaults the right-column layout to a seventy-percent waveform pane', () => {
  const normalized = helpers.normalizeLayoutData({ preset: 'wave-right' });
  assert.equal(normalized.columnPercent, 30);
});

test('normalizes waveform display settings carried by a layout', () => {
  const normalized = helpers.normalizeLayoutData({
    preset: 'custom',
    waveformMode: 'basic',
    waveformSettings: {
      visibleSeconds: 30, secondsPerRow: 20, rowHeight: 144, waveformScale: 9,
      side: 'right', disabledDisplay: 'hidden', showGroupBadges: false, dragPlayhead: false,
    },
  });
  assert.equal(normalized.waveformMode, 'basic');
  assert.deepEqual(JSON.parse(JSON.stringify(normalized.waveformSettings)), {
    visibleSeconds: 30, secondsPerRow: 20, rowHeight: 144, waveformScale: 6,
    side: 'right', disabledDisplay: 'hidden', showGroupBadges: false, dragPlayhead: false,
  });
});


test('preserves stored row ratios without legacy default migration', () => {
  const preserved = helpers.normalizeLayoutData({
    preset: 'wave-right',
    rows: [42, 27, 31],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(preserved.rows)), [42, 27, 31]);
});


test('allows the current cue row to shrink below the old eighteen-percent limit', () => {
  const compact = helpers.normalizeLayoutData({
    preset: 'wave-right',
    rows: [52, 6, 42],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(compact.rows)), [52, 6, 42]);
});


test('swaps custom docking slots without mutating the source order', () => {
  const order = ['player', 'panel', 'cues', 'wave'];
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.swapLayoutModuleOrder(order, 'wave', 'panel'))),
    ['player', 'wave', 'cues', 'panel'],
  );
  assert.deepEqual(order, ['player', 'panel', 'cues', 'wave']);
});


test('inserts a module at an edge without losing the existing layout tree', () => {
  const base = helpers.normalizeLayoutData({ preset: 'custom' });
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
  const base = helpers.normalizeLayoutData({ preset: 'custom' });
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


function encodeSpectralPayload(samples) {
  const bytes = Buffer.alloc(samples.length * 4);
  samples.forEach(([freq, density], i) => {
    bytes.writeUInt16LE(freq, i * 4);
    bytes.writeUInt16LE(density, i * 4 + 2);
  });
  return {
    schema: 'moy.asr.spectral.v1',
    encoding: 'u16-freq-density-base64',
    sample_rate: 8000,
    division: 80,
    peak_count: samples.length,
    data: bytes.toString('base64'),
  };
}


test('decodes spectral freq/density payload as u16 pairs', () => {
  const decoded = helpers.decodeSpectralPayload(encodeSpectralPayload([[300, 16383], [5000, 100]]));
  assert.ok(decoded);
  assert.deepEqual(Array.from(decoded.freq), [300, 5000]);
  assert.deepEqual(Array.from(decoded.density), [16383, 100]);
  assert.equal(decoded.sample_rate, 8000);
  assert.equal(decoded.division, 80);
  assert.equal(decoded.densityMax, 16383);
});


test('rejects unknown or malformed spectral payloads', () => {
  assert.equal(helpers.decodeSpectralPayload(null), null);
  assert.equal(helpers.decodeSpectralPayload({}), null);
  assert.equal(helpers.decodeSpectralPayload({ schema: 'moy.asr.spectral.v1' }), null);
  const mangled = encodeSpectralPayload([[1, 2]]);
  mangled.data = 'AAAA'; // 4 bytes, but peak_count=2 needs 4*2=8 bytes
  mangled.peak_count = 2; // length mismatch
  assert.equal(helpers.decodeSpectralPayload(mangled), null);
  const wrongSchema = encodeSpectralPayload([[1, 2]]);
  wrongSchema.schema = 'moy.asr.waveform.v1';
  assert.equal(helpers.decodeSpectralPayload(wrongSchema), null);
});


test('disables spectral colors when spectral data is unavailable', () => {
  const toggle = {
    disabled: false,
    checked: true,
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
  };

  helpers.syncSpectralColorToggle(toggle, false, true);
  assert.equal(toggle.disabled, true);
  assert.equal(toggle.checked, false);
  assert.equal(toggle.attributes['aria-disabled'], 'true');

  helpers.syncSpectralColorToggle(toggle, true, true);
  assert.equal(toggle.disabled, false);
  assert.equal(toggle.checked, true);
  assert.equal(toggle.attributes['aria-disabled'], 'false');
});


test('maps spectral freq/density to a valid hsl color', () => {
  const low = helpers.freqColor(50, 16383, 16383);
  assert.match(low, /^hsl\([\d.]+, [\d.]+%, [\d.]+%\)$/);
  const high = helpers.freqColor(5000, 100, 16383);
  assert.match(high, /^hsl\(/);
  // 噪声（density=0）饱和度最低
  const noisy = helpers.freqColor(1000, 0, 16383);
  const tonal = helpers.freqColor(1000, 16383, 16383);
  assert.ok(parseFloat(tonal.match(/hsl\([^,]+, ([\d.]+)%/)[1]) > parseFloat(noisy.match(/hsl\([^,]+, ([\d.]+)%/)[1]));
});
