import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { loadEditorModule } from './helpers/editor-module-loader.mjs';
import { initModuleSource } from './helpers/init-module-source.mjs';

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
    AsrGapRemoveCore: utilsContext.window.AsrGapRemoveCore,
    MaweBoot: { DATA: project, FILENAME_BASE: 'clip', STICKER_ROOT: 'C:/stickers' },
    MaweSelection: { stickerAbsPath: sticker => sticker.rel ? `C:/stickers/${sticker.rel}` : '' },
    MaweSpeakerLabels: { subtitleExportText: cue => cue.text },
    MaweColors: { COLOR_PALETTE: [] },
    MaweHint: { flashHint: (...args) => hints.push(args) },
  });
  context.window = context;
  for (const file of ['editor-export-srt.js', 'editor-export-timeline.js']) {
    const source = file === 'editor-export-srt.js' ? initModuleSource(`editor/io/${file}`) : readFileSync(new URL(`../web/editor/io/${file}`, import.meta.url), 'utf8');
    vm.runInContext(source, context);
  }
  return { project, api: context.MaweExportTimeline, hints };
}

test('Resolve v2 exports one continuous sticker group across gaps and disabled members without mutating DATA', () => {
  const { project, api } = fixture();
  const group = project.subtitle_groups.sticker[0];
  Object.assign(group.value, { group_id: 'untrusted', start_ms: -5, end_ms: -1 });
  const before = plain(project);
  const output = JSON.parse(api.buildResolveJson());
  assert.equal(output.schema, 'moy.asr_subtitle_editor.resolve.v2');
  assert.deepEqual(Object.keys(output).sort(), ['schema', 'source', 'filename_base', 'media', 'sticker_root', 'color_palette', 'segments', 'stickers', 'subtitle_groups'].sort());
  assert.deepEqual(output.stickers, [{ name: 'reaction', rel: 'reaction.png', custom: { opacity: 0.5 },
    group_id: group.id, start_ms: 1000, end_ms: 6000, abs_path: 'C:/stickers/reaction.png' }]);
  assert.deepEqual(output.subtitle_groups, before.subtitle_groups);
  assert.deepEqual(output.segments.map(cue => [cue.start_ms, cue.end_ms, cue.sticker, cue.sticker_group_id]), [
    [1000, 2000, null, group.id], [3000, 4000, null, group.id],
    [5000, 6000, null, group.id], [7000, 8000, null, undefined],
  ]);
  for (const cue of output.segments) {
    assert.equal(cue.sticker_ref, null);
  }
  assert.deepEqual(plain(project), before);
});

test('color-only Resolve v2 exports an empty sticker list', () => {
  const project = utils.importProject({ segments: [{ start: 10, end: 20, text: 'color', color: { name: 'red', custom: false } }] }).project;
  const { api } = fixture(project);
  const before = plain(project);
  const output = JSON.parse(api.buildResolveJson());
  assert.equal(output.schema, 'moy.asr_subtitle_editor.resolve.v2');
  assert.deepEqual(output.stickers, []);
  assert.deepEqual(output.subtitle_groups, before.subtitle_groups);
  assert.equal(output.segments[0].resolve_color, 'red');
  assert.deepEqual(output.segments[0].color, { name: 'red', custom: false });
  assert.equal(output.segments[0].sticker, null);
  assert.deepEqual(plain(project), before);
});

test('OTIO keeps the continuous group including disabled members without changing the project', () => {
  const { project, api } = fixture();
  const before = plain(project);
  const output = JSON.parse(api.buildStickerOtio());
  const children = output.tracks.children[0].children;
  assert.deepEqual(children.filter(item => item.OTIO_SCHEMA === 'Clip.2').map(item => [item.metadata.moy.start_ms, item.metadata.moy.end_ms]), [[1000, 6000]]);
  assert.deepEqual(children.filter(item => item.OTIO_SCHEMA === 'Gap.1').map(item => item.source_range.duration.value), [60]);
  assert.deepEqual(plain(project), before);
});

test('OTIO maps group bounds through removed gaps and drops a fully removed group', () => {
  const { project, api } = fixture();
  const before = plain(project);
  const removed = [{ start: 1000, end: 2000 }, { start: 2000, end: 3000 }];
  const result = api.collectStickerOtioEntries(removed);
  assert.deepEqual(plain(result.entries.map(entry => [entry.idx, entry.startMs, entry.endMs])), [[0, 1000, 4000]]);
  assert.deepEqual(plain(api.collectStickerOtioEntries([{ start: 1000, end: 6000 }]).entries), []);
  assert.deepEqual(plain(project), before);
});

test('standalone sticker OTIO includes active groups across main, overlay and secondary tracks', () => {
  const project = utils.importProject({ segments: legacyCues(), overlay_track: { enabled: true, segments: [{ start: 9000, end: 10000, text: 'overlay' }] },
    multi_subtitle: { enabled: true, tracks: [{ id: 'en', segments: [{ start: 11000, end: 12000, text: 'translation' }] }] } }).project;
  const groupId = utils.getMainTrack(project).segments[0].sticker_group_id;
  const overlay = utils.getOverlayTrack(project);
  overlay.segments[0].sticker_group_id = groupId;
  const secondary = utils.getTracksByRole(project, 'secondary')[0];
  utils.assignSubtitleGroup(project, secondary.segments, [0], 'sticker', { name: 'translated', rel: 'translated.png' });
  assert.equal(utils.validateTracksProject(project).ok, true);
  const { api } = fixture(project);
  const before = plain(project);
  const output = JSON.parse(api.buildStickerOtio());
  assert.deepEqual(output.tracks.children[0].children.filter(item => item.OTIO_SCHEMA === 'Clip.2').map(item => [item.metadata.moy.start_ms, item.metadata.moy.end_ms]), [[1000, 10000], [11000, 12000]]);
  assert.deepEqual(plain(api.collectStickerOtioEntries([], undefined, { allGroups: true }).entries.map(entry => [entry.startMs, entry.endMs])), [[1000, 10000], [11000, 12000]]);
  assert.deepEqual(plain(project), before);
  for (const track of project.tracks) track.enabled = false;
  const disabled = plain(project);
  assert.equal(api.buildResolveJson(), null);
  assert.equal(api.buildStickerOtio(), null);
  assert.deepEqual(plain(project), disabled);
});

test('unused groups and disabled sticker members cannot create an export', () => {
  const project = utils.importProject({ segments: [{ ...legacyCues()[0], disabled: true }] }).project;
  const { api, hints } = fixture(project);
  const before = plain(project);
  assert.equal(api.buildResolveJson(), null);
  assert.equal(api.buildStickerOtio(), null);
  assert.deepEqual(plain(project), before);
  utils.getMainTrack(project).segments = [];
  assert.equal(api.buildResolveJson(), null);
  assert.equal(api.buildStickerOtio(), null);
  assert.deepEqual(plain(project.subtitle_groups), before.subtitle_groups);
  assert.equal(hints.length, 4);
});
