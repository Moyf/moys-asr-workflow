import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { loadEditorModule } from './helpers/editor-module-loader.mjs';

const utilsContext = { window: {}, TextDecoder };
loadEditorModule(utilsContext, 'shared/editor-utils.js');
const utils = utilsContext.window.AsrEditorUtils;
const plain = value => JSON.parse(JSON.stringify(value));
const legacyCues = () => [
  { start: 1000, end: 2000, text: 'one', sticker: { name: 'reaction', rel: 'reaction.png', custom: { opacity: 0.5 } } },
  { start: 3000, end: 4000, text: 'two', sticker_ref: { name: 'reaction', headIdx: 0 } },
  { start: 5000, end: 6000, text: 'disabled', disabled: true, sticker_ref: { name: 'reaction', headIdx: 0 } },
  { start: 7000, end: 8000, text: 'no sticker' },
];

function fixture(project = utils.importProject({ segments: legacyCues() }).project) {
  const hints = [];
  const context = vm.createContext({
    document: { querySelectorAll: () => [] },
    AsrEditorUtils: utils,
    MaweBoot: { DATA: project, FILENAME_BASE: 'clip', STICKER_ROOT: 'C:/stickers' },
    MaweSelection: { stickerAbsPath: sticker => sticker.rel ? `C:/stickers/${sticker.rel}` : '' },
    MaweSpeakerLabels: { subtitleExportText: cue => cue.text },
    MaweColors: { COLOR_PALETTE: [] },
    MaweHint: { flashHint: (...args) => hints.push(args) },
  });
  context.window = context;
  for (const file of ['editor-export-srt.js', 'editor-export-timeline.js']) {
    vm.runInContext(readFileSync(new URL(`../web/editor/io/${file}`, import.meta.url), 'utf8'), context);
  }
  return { project, api: context.MaweExportTimeline, hints };
}

test('Resolve retains v1 per-cue stickers across gaps and disabled group members without mutating DATA', () => {
  const { project, api } = fixture();
  const before = plain(project);
  const output = JSON.parse(api.buildResolveJson());
  assert.equal(output.schema, 'moy.asr_subtitle_editor.resolve.v1');
  assert.deepEqual(Object.keys(output).sort(), ['schema', 'source', 'filename_base', 'media', 'sticker_root', 'color_palette', 'segments'].sort());
  assert.deepEqual(output.segments.map(cue => [cue.start_ms, cue.end_ms, cue.sticker]), [
    [1000, 2000, { name: 'reaction', rel: 'reaction.png', custom: { opacity: 0.5 }, start: 1000, end: 2000, abs_path: 'C:/stickers/reaction.png' }],
    [3000, 4000, { name: 'reaction', rel: 'reaction.png', custom: { opacity: 0.5 }, start: 3000, end: 4000, abs_path: 'C:/stickers/reaction.png' }],
    [5000, 6000, null], [7000, 8000, null],
  ]);
  for (const cue of output.segments) {
    assert.equal(cue.sticker_ref, null);
    assert.equal(Object.hasOwn(cue, 'sticker_group_id'), false);
  }
  assert.deepEqual(plain(project), before);
});

test('empty sticker groups do not upgrade the Resolve wire format for color-only exports', () => {
  const project = utils.importProject({ segments: [{ start: 10, end: 20, text: 'color', color: { name: 'red', custom: false } }] }).project;
  const { api } = fixture(project);
  const before = plain(project);
  const output = JSON.parse(api.buildResolveJson());
  assert.equal(output.schema, 'moy.asr_subtitle_editor.resolve.v1');
  assert.equal(Object.hasOwn(output, 'stickers'), false);
  assert.equal(Object.hasOwn(output, 'subtitle_groups'), false);
  assert.equal(output.segments[0].resolve_color, 'red');
  assert.deepEqual(output.segments[0].color, { name: 'red', custom: false });
  assert.equal(output.segments[0].sticker, null);
  assert.deepEqual(plain(project), before);
});

test('OTIO keeps two enabled cue clips and their intervening gap, without changing the project', () => {
  const { project, api } = fixture();
  const before = plain(project);
  const output = JSON.parse(api.buildStickerOtio());
  const children = output.tracks.children[0].children;
  assert.deepEqual(children.filter(item => item.OTIO_SCHEMA === 'Clip.2').map(item => [item.metadata.moy.start_ms, item.metadata.moy.end_ms]), [[1000, 2000], [3000, 4000]]);
  assert.deepEqual(children.filter(item => item.OTIO_SCHEMA === 'Gap.1').map(item => item.source_range.duration.value), [60, 60]);
  assert.deepEqual(plain(project), before);
});

test('OTIO maps each cue independently when gaps are removed, dropping a fully removed cue', () => {
  const { project, api } = fixture();
  const before = plain(project);
  const removed = [{ start: 1000, end: 2000 }, { start: 2000, end: 3000 }];
  const result = api.collectStickerOtioEntries(removed);
  assert.deepEqual(plain(result.entries.map(entry => [entry.idx, entry.startMs, entry.endMs])), [[1, 1000, 2000]]);
  assert.deepEqual(plain(project), before);
});

test('standalone sticker OTIO keeps main-track scope even when a group has other track members', () => {
  const project = utils.importProject({ segments: legacyCues(), overlay_track: { enabled: true, segments: [{ start: 9000, end: 10000, text: 'overlay' }] },
    multi_subtitle: { enabled: true, tracks: [{ id: 'en', segments: [{ start: 11000, end: 12000, text: 'translation' }] }] } }).project;
  const groupId = utils.getMainTrack(project).segments[0].sticker_group_id;
  const overlay = utils.getOverlayTrack(project);
  overlay.segments[0].sticker_group_id = groupId;
  utils.getTracksByRole(project, 'extension')[0].segments[0].sticker_group_id = groupId;
  assert.equal(utils.validateTracksProject(project).ok, true);
  const { api } = fixture(project);
  const before = plain(project);
  const output = JSON.parse(api.buildStickerOtio());
  assert.deepEqual(output.tracks.children[0].children.filter(item => item.OTIO_SCHEMA === 'Clip.2').map(item => [item.metadata.moy.start_ms, item.metadata.moy.end_ms]), [[1000, 2000], [3000, 4000]]);
  assert.deepEqual(plain(api.collectStickerOtioEntries([], overlay.segments).entries.map(entry => [entry.startMs, entry.endMs])), [[9000, 10000]]);
  assert.deepEqual(plain(project), before);
});

test('unused groups and disabled sticker members cannot create an export', () => {
  const project = utils.importProject({ segments: [{ ...legacyCues()[0], disabled: true }] }).project;
  const { api, hints } = fixture(project);
  assert.equal(api.buildResolveJson(), null);
  assert.equal(api.buildStickerOtio(), null);
  utils.getMainTrack(project).segments = [];
  assert.equal(api.buildResolveJson(), null);
  assert.equal(api.buildStickerOtio(), null);
  assert.equal(hints.length, 4);
});
