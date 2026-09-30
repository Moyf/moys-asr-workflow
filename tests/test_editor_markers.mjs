// markers：通用 Marker / Region 核心逻辑（规范化 / 过滤 / 几何换算）单测。
// 覆盖 AGENTS 约定：整数毫秒、稳定 ID、Region 判定（end > start）、
// 管理窗过滤、可见范围裁剪与波形跨行挑选 / 行内时间换算。
import { loadEditorModule } from './helpers/editor-module-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';


const utilsContext = { window: {}, TextDecoder, TextEncoder, Uint8Array };
loadEditorModule(utilsContext, 'shared/editor-utils.js');
const utils = utilsContext.window.AsrEditorUtils;

const waveContext = {
  window: {
    // waveform.js 顶部只需要最小 palette fixture（同 test_waveform_js.mjs）。
    ASR_EDITOR_PALETTE: [
      { name: 'yellow', value: '#c4a019' },
      { name: 'green', value: '#66bb6a' },
      { name: 'red', value: '#f07f6f' },
      { name: 'purple', value: '#bf89e6' },
      { name: 'blue', value: '#61a7fa' },
    ],
  },
};
loadEditorModule(waveContext, 'editor/media/waveform.js');
const waveTesting = waveContext.window.AsrWaveform.testing;

// vm 沙箱与测试文件处于不同 realm，deepStrictEqual 会比较 Object.prototype；
// 统一 JSON 还原成测试 realm 的普通对象再比较。
const plain = (value) => JSON.parse(JSON.stringify(value));


test('normalizeMarkers accepts bare arrays and {items} payloads, drops invalid rows', () => {
  const bare = utils.normalizeMarkers([
    { id: 'm1', start: 1200.4, name: '  开场 ', color: '#E5484D', note: ' hi ' },
    null,
    { start: 'nope' },
    { start: -5 },
    { end: 9999 },  // 无 start：丢弃
  ]);
  assert.equal(bare.length, 1);
  assert.deepEqual(plain(bare[0]), {
    id: 'm1', start: 1200, name: '开场', color: '#e5484d', note: 'hi',
  });

  const wrapped = utils.normalizeMarkers({
    items: [
      { id: 'r1', start: 100, end: 900, name: '区段' },
      { id: 'r2', start: 50, end: 50 },  // end <= start：收敛为单点
      { id: 'r3', start: 70, end: 'x' }, // 非法 end：收敛为单点
    ],
  });
  assert.deepEqual(plain(wrapped.map((marker) => [marker.id, marker.start, marker.end ?? null])), [
    ['r2', 50, null],
    ['r3', 70, null],
    ['r1', 100, 900],
  ]);

  assert.deepEqual(plain(utils.normalizeMarkers(null)), []);
  assert.deepEqual(plain(utils.normalizeMarkers(undefined)), []);
  assert.deepEqual(plain(utils.normalizeMarkers('nope')), []);
  assert.deepEqual(plain(utils.normalizeMarkers({ items: 'nope' })), []);
});

test('normalizeMarkers fills stable deterministic ids and de-duplicates collisions', () => {
  const markers = utils.normalizeMarkers([
    { start: 500 },
    { id: 'marker-001', start: 100 },
    { id: 'marker-001', start: 200 },  // 重复 ID：第二个重排为 marker-002
    { id: '  ', start: 300 },          // 空白 ID：补号
  ]);
  assert.deepEqual(plain(markers.map((marker) => marker.id)), [
    'marker-001', 'marker-002', 'marker-003', 'marker-004',
  ]);
  assert.deepEqual(plain(markers.map((marker) => marker.start)), [100, 200, 300, 500]);
});

test('normalizeMarkers clamps text fields and normalizes colors and review', () => {
  const longName = '名'.repeat(300);
  const [marker] = utils.normalizeMarkers([{
    start: 0,
    name: `a\x00b\t${longName}`,
    color: 'not-a-color',
    note: `注\x1f${'释'.repeat(600)}`,
    review: { status: 'bogus', reason: `原\x07因${'！'.repeat(400)}` },
  }]);
  assert.equal(marker.name.length, utils.MARKER_NAME_MAX_LENGTH);
  assert.ok(marker.name.startsWith('a b '));
  assert.equal(marker.color, utils.MARKER_DEFAULT_COLOR);
  assert.equal(marker.note.length, utils.MARKER_NOTE_MAX_LENGTH);
  assert.deepEqual(plain(marker.review), {
    status: 'pending',
    reason: `原 因${'！'.repeat(utils.MARKER_REVIEW_REASON_MAX_LENGTH - 3)}`.slice(0, utils.MARKER_REVIEW_REASON_MAX_LENGTH),
  });
  // reason 截断后长度受控，且控制字符被替换。
  assert.equal(marker.review.reason.length, utils.MARKER_REVIEW_REASON_MAX_LENGTH);
  assert.ok(!/[\x00-\x1f\x7f]/.test(marker.review.reason));

  const [confirmed] = utils.normalizeMarkers([
    { start: 0, review: { status: 'confirmed', reason: 'ok' } },
  ]);
  assert.deepEqual(plain(confirmed.review), { status: 'confirmed', reason: 'ok' });
  // 无 review 字段时不补默认值，保持普通标记形态。
  const [noReview] = utils.normalizeMarkers([{ start: 0 }]);
  assert.equal(noReview.review, undefined);
});

test('markersToProjectField emits canonical MOSP field and collapses empty lists', () => {
  assert.equal(utils.markersToProjectField([]), null);
  assert.equal(utils.markersToProjectField(null), null);
  const field = utils.markersToProjectField([{ id: 'm1', start: 10 }]);
  assert.deepEqual(plain(field), {
    schema: 'moy.asr.markers.v1',
    items: [{ id: 'm1', start: 10, name: '', color: '#3e63dd', note: '' }],
  });
  // 规范化产物可以直接回读。
  assert.deepEqual(plain(utils.normalizeMarkers(field)), plain(field.items));
});

test('markerKind distinguishes regions from point markers', () => {
  assert.equal(utils.markerKind({ start: 100, end: 200 }), 'region');
  assert.equal(utils.markerKind({ start: 100, end: 100 }), 'marker');
  assert.equal(utils.markerKind({ start: 100, end: 50 }), 'marker');
  assert.equal(utils.markerKind({ start: 100 }), 'marker');
  assert.equal(utils.isRegionMarker({ start: 1, end: 2 }), true);
  assert.equal(utils.isRegionMarker({ start: 1 }), false);
});

test('markerMatchesFilter supports query, kind, color and review filters', () => {
  const markers = [
    { id: 'a', start: 0, name: '开场白', color: '#e5484d' },
    { id: 'b', start: 10, end: 20, name: '重录段', color: '#3e63dd', note: '第二遍' },
    { id: 'c', start: 30, name: '口误待复核', color: '#f5a623', review: { status: 'pending', reason: '疑似口误' } },
    { id: 'd', start: 40, name: '已确认', color: '#f5a623', review: { status: 'confirmed', reason: '' } },
  ];
  const pick = (filter) => plain(utils.filterMarkers(markers, filter).map((marker) => marker.id));

  assert.deepEqual(pick({ query: '重录' }), ['b']);
  assert.deepEqual(pick({ query: '第二遍' }), ['b']);       // 命中备注
  assert.deepEqual(pick({ query: '口误' }), ['c']);          // 命中名称（复核原因不参与搜索）
  assert.deepEqual(pick({ kind: 'region' }), ['b']);
  assert.deepEqual(pick({ kind: 'marker' }), ['a', 'c', 'd']);
  assert.deepEqual(pick({ color: '#E5484D' }), ['a']);       // 大小写不敏感
  assert.deepEqual(pick({ review: 'pending' }), ['c']);
  assert.deepEqual(pick({ review: 'confirmed' }), ['d']);
  assert.deepEqual(pick({ review: 'plain' }), ['a', 'b']);
  assert.deepEqual(pick({}), ['a', 'b', 'c', 'd']);
  assert.deepEqual(plain(utils.filterMarkers(null, {})), []);
});

test('markerSummary counts markers, regions and pending reviews', () => {
  assert.deepEqual(plain(utils.markerSummary([])), { total: 0, markers: 0, regions: 0, pending: 0 });
  const summary = utils.markerSummary([
    { id: 'a', start: 0 },
    { id: 'b', start: 1, end: 2 },
    { id: 'c', start: 3, review: { status: 'pending', reason: '' } },
    { id: 'd', start: 4, review: { status: 'confirmed', reason: '' } },
  ]);
  assert.deepEqual(plain(summary), { total: 4, markers: 3, regions: 1, pending: 1 });
  assert.equal(utils.countPendingReviewMarkers(null), 0);
});

test('markerVisibleRange clips to the row and keeps point markers visible', () => {
  // Region 完全在行外：不可见。
  assert.equal(utils.markerVisibleRange({ start: 0, end: 100 }, 500, 1000), null);
  // Region 部分可见：裁剪到行范围。
  assert.deepEqual(
    plain(utils.markerVisibleRange({ start: 400, end: 800 }, 500, 1000)),
    { start: 500, end: 800 },
  );
  // 单点 Marker 在行内：1ms 可见区间（渲染层再保证最小像素宽度）。
  assert.deepEqual(
    plain(utils.markerVisibleRange({ start: 700 }, 500, 1000)),
    { start: 700, end: 701 },
  );
  // 单点 Marker 恰好在行尾：不可见（属于下一行）。
  assert.equal(utils.markerVisibleRange({ start: 1000 }, 500, 1000), null);
});

test('pickMarkerRow selects the row under the pointer or the nearest row across gaps', () => {
  const rows = [
    { top: 0, bottom: 100, startMs: 0, endMs: 10000 },
    { top: 110, bottom: 210, startMs: 10000, endMs: 20000 },
  ];
  assert.equal(waveTesting.pickMarkerRow(rows, 50), rows[0]);
  assert.equal(waveTesting.pickMarkerRow(rows, 210), rows[1]);
  // 行间隙取最近行；等距时取先出现的行。
  assert.equal(waveTesting.pickMarkerRow(rows, 105), rows[0]);
  assert.equal(waveTesting.pickMarkerRow(rows, 107), rows[1]);
  assert.equal(waveTesting.pickMarkerRow(rows, -50), rows[0]);
  assert.equal(waveTesting.pickMarkerRow(rows, 999), rows[1]);
  assert.equal(waveTesting.pickMarkerRow([], 50), null);
});

test('markerRowTimeMs maps clientX to clamped in-row milliseconds', () => {
  const geometry = { left: 100, width: 900, startMs: 5000, endMs: 10000 };
  assert.equal(waveTesting.markerRowTimeMs(geometry, 100), 5000);
  assert.equal(waveTesting.markerRowTimeMs(geometry, 550), 7500);
  assert.equal(waveTesting.markerRowTimeMs(geometry, 1000), 10000);
  // 越界钳制到行范围。
  assert.equal(waveTesting.markerRowTimeMs(geometry, 0), 5000);
  assert.equal(waveTesting.markerRowTimeMs(geometry, 5000), 10000);
});
