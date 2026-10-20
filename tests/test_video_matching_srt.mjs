import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { loadEditorModule } from './helpers/editor-module-loader.mjs';

function runtime() {
  const context = { window: {} };
  loadEditorModule(context, 'shared/editor-utils.js');
  const segments = [
    { start: 1100, end: 1500, text: 'first' },
    { start: 3800, end: 8500, text: 'crosses deleted gap' },
    { start: 6000, end: 6500, text: 'removed' },
    { start: 8100, end: 9000, text: 'last' },
    { start: 0, end: 100, text: 'disabled', disabled: true },
  ];
  Object.assign(context, {
    MaweBoot: { DATA: { segments, gap_remove: {} } },
    MaweSettings: { EDITOR_SETTINGS: { exportStartAtZero: true } },
    MaweSpeakerLabels: { speakerLabelExportOptions: () => ({}) },
    MaweCueElements: { fmtSrtTime: ms => new Date(ms).toISOString().slice(11, 23).replace('.', ',') },
    mergedExportSegments: () => ({ segments, overlaySet: new Set(), overlaySegments: [] }),
    exportColorContextResolver: () => () => segments,
  });
  vm.runInNewContext(fs.readFileSync(new URL('../web/editor/io/editor-export-srt.js', import.meta.url), 'utf8'), context);
  return { segments, capture: () => context.window.MaweExportSrt.captureVideoSrt() };
}

const timeline = { intervals: [
  { sourceStartMs: 0, sourceEndMs: 4000, outputStartMs: 0, outputEndMs: 4000 },
  { sourceStartMs: 8000, sourceEndMs: 12000, outputStartMs: 4000, outputEndMs: 8000 },
] };

test('matching video subtitles clip across actual intervals, preserve leading silence and capture source edits', () => {
  const { segments, capture } = runtime();
  const build = capture();
  segments[0].text = 'new project';
  segments[0].start = 0;
  const srt = build(timeline);
  assert.match(srt, /00:00:01,100 --> 00:00:01,500\nfirst/);
  assert.match(srt, /00:00:03,800 --> 00:00:04,000\ncrosses deleted gap/);
  assert.match(srt, /00:00:04,000 --> 00:00:04,500\ncrosses deleted gap/);
  assert.match(srt, /00:00:04,100 --> 00:00:05,000\nlast/);
  assert.doesNotMatch(srt, /new project|removed|disabled/);
});

test('missing or overlapping timeline is never used to offer a falsely matching subtitle', () => {
  const { capture } = runtime();
  const build = capture();
  assert.equal(build(null), null);
  assert.equal(build({ intervals: [{ ...timeline.intervals[0], outputEndMs: 5000 }] }), null);
  assert.equal(build({ intervals: [...timeline.intervals, timeline.intervals[0]] }), null);
});
