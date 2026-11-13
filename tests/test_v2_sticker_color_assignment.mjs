import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { createUtilsModule as createGroups } from '../web/shared/utils/subtitle-groups.js';
import { projectModel, runtimeProject } from './helpers/runtime-project.mjs';
import { invokedInitModuleSource } from './helpers/init-module-source.mjs';

function fixture() {
  const main = [0, 1, 2].map(index => ({ id: `m${index}`, start: index * 1000, end: (index + 1) * 1000,
    text: `m${index}`, color_group_id: 'red', sticker_group_id: 'cat' }));
  const overlay = [{ id: 'o', start: 0, end: 1000, text: 'overlay', sticker_group_id: 'cat' }];
  const secondary = [{ id: 'e', start: 0, end: 1000, text: 'english', color_group_id: 'red' }];
  const project = runtimeProject(main, {
    speakers: [], annotation_mode: 'color', palette_size: 5, speaker_shortcuts: {},
    overlay: { segments: overlay }, extensions: [{ id: 'en', segments: secondary }],
    subtitle_groups: { next_id: 1, color: [{ id: 'red', value: { name: 'red', value: '#f00' } }],
      sticker: [{ id: 'cat', value: { name: 'cat', rel: 'cat.png' } }] },
  });
  const groups = createGroups({ cloneJsonValue: structuredClone });
  const context = {
    MaweBoot: { DATA: project },
    AsrEditorUtils: { ...projectModel, ...groups },
    MaweColors: { COLOR_BY_NAME: { blue: { name: 'blue', label: '蓝', value: '#00f' } } },
    MaweCommands: { run(_label, mutate) { return mutate(); } },
    MaweHint: { flashHint() {} },
    MaweDom: { stickerModal: { classList: { remove() {} } } },
    overlaySticker: { stickerTargetTrack: 'main' },
    getOverlayTrack: () => project.tracks.find(track => track.role === 'overlay'),
    splitGroupsAtCutPoints: (indexes, kind, _ref, segments = main) => groups.clearSubtitleGroupMembers(project, segments, indexes, kind),
    refreshColorAssignmentUi() {}, refreshStickerAssignmentUi() {},
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(invokedInitModuleSource('editor/cues/editor-sticker-picker.js', 'initMaweStickerPicker'), context);
  return { context, project, main, overlay, secondary, groups };
}

test('assigning color to part of a v2 group preserves unselected track members', () => {
  const { context, project, main, secondary, groups } = fixture();
  context.MaweStickerPicker.assignColor([0, 1], 'blue');
  assert.equal(main[0].color_group_id, main[1].color_group_id);
  assert.notEqual(main[0].color_group_id, 'red');
  assert.equal(main[2].color_group_id, 'red');
  assert.equal(secondary[0].color_group_id, 'red');
  assert.equal(groups.getSubtitleGroupValue(project, main[0], 'color').name, 'blue');
  assert.equal(groups.getSubtitleGroupValue(project, main[2], 'color').name, 'red');
  assert.equal(projectModel.validateTracksProject(projectModel.snapshotProjectContent(project)).ok, true);
});

test('clearing an overlay sticker does not clear a main track member', () => {
  const { context, project, main, overlay } = fixture();
  context.overlaySticker.stickerTargetTrack = 'overlay';
  context.MaweStickerPicker.stickerTargetIdxs = [0];
  context.MaweStickerPicker.clearStickerOnTargets();
  assert.equal(Object.hasOwn(overlay[0], 'sticker_group_id'), false);
  assert.equal(main[0].sticker_group_id, 'cat');
  assert.equal(project.subtitle_groups.sticker[0].id, 'cat');
  assert.equal(projectModel.validateTracksProject(projectModel.snapshotProjectContent(project)).ok, true);
});

test('clearing a secondary color targets that track only', () => {
  const { context, project, main, secondary } = fixture();
  context.MaweStickerPicker.assignTrackColor(project.tracks.find(track => track.role === 'secondary'), [0], null);
  assert.equal(Object.hasOwn(secondary[0], 'color_group_id'), false);
  assert.equal(main[0].color_group_id, 'red');
  assert.equal(projectModel.validateTracksProject(projectModel.snapshotProjectContent(project)).ok, true);
});
