import assert from 'node:assert/strict';
import test from 'node:test';
import { loadEditorModule } from './helpers/editor-module-loader.mjs';

const context = { window: {} };
loadEditorModule(context, 'shared/editor-utils.js');
const helpers = context.window.AsrEditorUtils;

test('structural preview and apply complete the active MASS rule across three rows', () => {
  const source = [{ id: 'styled', start: 0, end: 1500, text: '**甲乙丙**', items: [
    { text: '**甲', start: 0, end: 500 }, { text: '乙', start: 500, end: 1000 }, { text: '丙**', start: 1000, end: 1500 },
  ] }];
  const drafts = ['**甲', '乙', '丙**'];
  const options = { rule: 'both' };
  const report = helpers.buildTimedTextEditReport(source, drafts, options);
  const applied = helpers.applyTimedTextEdit(source, drafts, options);
  assert.equal(report.valid, true);
  assert.deepEqual(JSON.parse(JSON.stringify(report.previewSegments.map(row => row.text))), ['**甲**', '**乙**', '**丙**']);
  assert.deepEqual(JSON.parse(JSON.stringify(applied)), JSON.parse(JSON.stringify(report.previewSegments)));
  assert.deepEqual(JSON.parse(JSON.stringify(applied.flatMap(row => row.items).map(item => [item.start, item.end]))), [[0, 500], [500, 1000], [1000, 1500]]);
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.applyTimedTextEdit(source, drafts, { rule: 'none' }).map(row => row.text))), drafts);
});

test('structural output reports compare whole source timing while preserving mapped items', () => {
  const source = [{start: 30000, end: 40000, text: '甲乙', items: [
    {start: 30500, end: 36250, text: '甲'}, {start: 36250, end: 39500, text: '乙'},
  ]}];
  const snapshot = JSON.stringify(source);
  const report = helpers.buildTimedTextEditReport(source, ['甲', '乙']);
  assert.equal(report.valid, true);
  assert.deepEqual(JSON.parse(JSON.stringify(report.outputRows.map(row => [
    row.beforeStart, row.beforeEnd, row.afterStart, row.afterEnd, row.timingChanged,
  ]))), [[30000, 40000, 30000, 36250, true], [30000, 40000, 36250, 40000, true]]);
  assert.deepEqual(JSON.parse(JSON.stringify(report.previewSegments.flatMap(row => row.items))), source[0].items);
  assert.equal(JSON.stringify(source), snapshot);
});

test('unchanged output timings are not reported as timing changes after structural edits elsewhere', () => {
  const source = [
    {start: 0, end: 1000, text: '甲乙', items: [{start: 0, end: 500, text: '甲'}, {start: 500, end: 1000, text: '乙'}]},
    {start: 1200, end: 2200, text: '丙丁', items: [{start: 1200, end: 1600, text: '丙'}, {start: 1600, end: 2200, text: '丁'}]},
  ];
  const report = helpers.buildTimedTextEditReport(source, ['甲', '乙', '丙丁']);
  assert.equal(report.valid, true);
  assert.equal(report.outputRows.at(-1).timingChanged, false);
  assert.equal(report.rows[0].timingChanged, false);
});
