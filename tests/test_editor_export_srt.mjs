import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { loadEditorModule } from './helpers/editor-module-loader.mjs';
import { runtimeProject, projectModel } from './helpers/runtime-project.mjs';
import { initModuleSource } from './helpers/init-module-source.mjs';

function fixture(segments, overlaySegments = [], alignFirstStart = false, colorGroups = []) {
  const saves = [];
  const project = runtimeProject(segments, { overlay: { segments: overlaySegments },
    subtitle_groups: { next_id: 1, color: colorGroups, sticker: [] } });
  const context = { window: {},
    MaweBoot: { DATA: project, FILENAME_BASE: 'project' },
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
    overlayTrackVisible: () => projectModel.getOverlayTrack(project).enabled,
    getOverlayTrack: () => projectModel.getOverlayTrack(project),
  };
  context.window.MaweBoot = context.MaweBoot;
  loadEditorModule(context, 'shared/editor-utils.js');
  context.MULTI_SUBTITLE_UTILS = context.window.AsrEditorUtils;
  context.document = { getElementById: () => null };
  vm.runInNewContext(initModuleSource('editor/io/editor-wiring-export-context.js'), context);
  vm.runInNewContext(initModuleSource('editor/io/editor-export-srt.js'), context);
  return { saves, api: context.window.MaweExportSrt, context };
}

test('color gap-removed SRT filters the first removed cue before choosing the shared zero-start index', async () => {
  const { saves, api } = fixture([
    { start: 2200, end: 2800, text: 'removed first', color_group_id: 'red-main' },
    { start: 3500, end: 4000, text: 'kept first', color_group_id: 'blue-main' },
  ], [], true, [{ id: 'red-main', value: { name: 'red' } }, { id: 'blue-main', value: { name: 'blue' } }]);
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
    { id: 'cross-entry', start: 1800, end: 2200, text: 'cross entry', color_group_id: 'red-entry' },
    { id: 'main-head', start: 2200, end: 2800, text: 'removed main head', color_group_id: 'red-main' },
    { id: 'cross-exit', start: 2800, end: 3200, text: 'cross exit', color_group_id: 'blue-exit' },
    { id: 'main-member', start: 3100, end: 3500, text: 'main member', color_group_id: 'red-main' },
  ];
  const overlay = [
    { id: 'overlay-head', start: 2400, end: 2600, text: 'removed overlay head', color_group_id: 'blue-overlay' },
    { id: 'overlay-member', start: 3400, end: 3600, text: 'overlay member', color_group_id: 'blue-overlay' },
  ];
  const snapshot = JSON.stringify({ segments, overlay });
  const { saves, api } = fixture(segments, overlay, false, [
    { id: 'red-entry', value: { name: 'red' } }, { id: 'red-main', value: { name: 'red' } },
    { id: 'blue-exit', value: { name: 'blue' } }, { id: 'blue-overlay', value: { name: 'blue' } },
  ]);
  await api.downloadColorSrts(true);
  assert.equal(saves.find(save => save.filename.endsWith('_red.srt')).content,
    '1\n1800ms --> 2000ms\ncross entry\n\n2\n2100ms --> 2500ms\nmain member\n');
  assert.equal(saves.find(save => save.filename.endsWith('_blue.srt')).content,
    '1\n2000ms --> 2200ms\ncross exit\n\n2\n2400ms --> 2600ms\noverlay member\n');
  assert.equal(saves.some(save => save.content.includes('removed')), false);
  assert.equal(JSON.stringify({ segments, overlay }), snapshot);
});

test('gap-removed ASS keeps the burn clock and layout callback together despite zero-start file preference', () => {
  const { api, context } = fixture([
    { start: 2200, end: 2800, text: 'removed first' },
    { start: 3500, end: 4000, text: 'kept first' },
  ], [], true);
  context.MaweBoot.DATA.media_metadata = { video_width: 1920, video_height: 1080 };
  context.MaweAppearance = { getSubtitleAppearance: () => ({}) };
  context.MaweTimeline = { normalizeMediaMetadata: value => value };
  context.ASS_STYLE_LIBRARY = context.window.AsrEditorUtils.defaultAssStyleLibrary();
  context.activeExtensionSegments = () => [];

  let plan;
  const ass = api.buildGapRemovedAss({ alignFirstStart: false, onAssPlan: value => { plan = value; } });
  const events = ass.split('\n').filter(line => line.startsWith('Dialogue:'));
  assert.ok(events.length > 0);
  assert.ok(events.every(line => line.includes(',0:00:02.50,0:00:03.00,')), events.join('\n'));
  assert.equal(ass.includes('removed first'), false);
  assert.ok(plan?.slices.length > 0, 'the real ASS exporter must return its mapped layout plan');
  assert.equal(Math.min(...plan.slices.map(slice => slice.start)), 2500);
  assert.equal(Math.max(...plan.slices.map(slice => slice.end)), 3000);
});
