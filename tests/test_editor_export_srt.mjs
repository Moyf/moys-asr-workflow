import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { loadEditorModule } from './helpers/editor-module-loader.mjs';

function fixture(segments, overlaySegments = [], alignFirstStart = false) {
  const saves = [];
  const context = { window: {},
    MaweBoot: { DATA: { segments }, FILENAME_BASE: 'project' },
    MaweSettings: { EDITOR_SETTINGS: { exportStartAtZero: alignFirstStart,
      exportColorUnified: false, assSpecialSymbolRule: 'both' } },
    MaweGapRemoveData: { getRemovedGapRanges: () => [{ start: 2000, end: 3000, removed: true }] },
    MaweInlineEdit: { editingState: null },
    MaweColors: { COLOR_PALETTE: [{ name: 'red', label: '红' }, { name: 'blue', label: '蓝' }],
      COLOR_BY_NAME: { red: {}, blue: {} } },
    MaweSpeakerLabels: { getSpeakerLabelSettings: () => ({}), speakerLabelExportOptions: () => ({}) },
    MaweCueElements: { fmtSrtTime: time => `${time}ms` },
    MaweHint: { flashHint() {} },
    MaweHost: { files: { hasSavePicker: () => false } },
    MaweExportTimeline: { async downloadFile(content, filename) { saves.push({ content, filename }); return true; } },
    overlayTrackVisible: () => true, getOverlayTrack: () => ({ segments: overlaySegments }),
  };
  loadEditorModule(context, 'shared/editor-utils.js');
  context.MULTI_SUBTITLE_UTILS = context.window.AsrEditorUtils;
  const wiring = fs.readFileSync(new URL('../web/editor/io/editor-wiring-export-context.js', import.meta.url), 'utf8');
  vm.runInNewContext(wiring.split('const CANONICAL_PROJECT_FIELDS')[0], context);
  vm.runInNewContext(fs.readFileSync(new URL('../web/editor/io/editor-export-srt.js', import.meta.url), 'utf8'), context);
  return { saves, api: context.window.MaweExportSrt };
}

test('color gap-removed SRT filters the first removed cue before choosing the shared zero-start index', async () => {
  const { saves, api } = fixture([
    { start: 2200, end: 2800, text: 'removed first', color: { name: 'red' } },
    { start: 3500, end: 4000, text: 'kept first', color: { name: 'blue' } },
  ], [], true);
  await api.downloadColorSrts(true);
  assert.equal(saves.find(save => save.filename.endsWith('_red.srt')).content, '');
  assert.equal(saves.find(save => save.filename.endsWith('_blue.srt')).content,
    '1\n0ms --> 3000ms\nkept first\n');
  assert.equal(saves.some(save => save.content.includes('removed first')), false);
  // The ordinary color export still includes the cue and retains its original end.
  saves.length = 0;
  await api.downloadColorSrts(false);
  assert.equal(saves.find(save => save.filename.endsWith('_red.srt')).content,
    '1\n0ms --> 2800ms\nremoved first\n');
});

test('color gap-removed SRT keeps cut-crossing cues and resolves filtered color heads in each original track', async () => {
  const segments = [
    { start: 1800, end: 2200, text: 'cross entry', color: { name: 'red' } },
    { start: 2200, end: 2800, text: 'removed main head', color: { name: 'red' } },
    { start: 2800, end: 3200, text: 'cross exit', color: { name: 'blue' } },
    { start: 3100, end: 3500, text: 'main member', color_ref: { name: 'red', headIdx: 1 } },
  ];
  const overlay = [
    { start: 2400, end: 2600, text: 'removed overlay head', color: { name: 'blue' } },
    { start: 3400, end: 3600, text: 'overlay member', color_ref: { name: 'blue', headIdx: 0 } },
  ];
  const snapshot = JSON.stringify({ segments, overlay });
  const { saves, api } = fixture(segments, overlay);
  await api.downloadColorSrts(true);
  assert.equal(saves.find(save => save.filename.endsWith('_red.srt')).content,
    '1\n1800ms --> 2000ms\ncross entry\n\n2\n2100ms --> 2500ms\nmain member\n');
  assert.equal(saves.find(save => save.filename.endsWith('_blue.srt')).content,
    '1\n2000ms --> 2200ms\ncross exit\n\n2\n2400ms --> 2600ms\noverlay member\n');
  assert.equal(saves.some(save => save.content.includes('removed')), false);
  assert.equal(JSON.stringify({ segments, overlay }), snapshot);
});
