import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { createUtilsModule as createGroups } from '../web/shared/utils/subtitle-groups.js';
import { projectModel, runtimeProject } from './helpers/runtime-project.mjs';
import { invokedInitModuleSource } from './helpers/init-module-source.mjs';

function fixture() {
  const cue = (prefix, index, color) => ({ id: `${prefix}${index}`, text: `${prefix}${index}`,
    start: index * 1000, end: (index + 1) * 1000, color_group_id: color });
  const main = [cue('m', 0, 'red'), cue('m', 1, 'red'), cue('m', 2, 'red')];
  const extension = [cue('e', 0, 'blue'), cue('e', 1, 'red'), cue('e', 2, 'red')];
  const project = runtimeProject(main, {
    speakers: [], annotation_mode: 'color', palette_size: 5, speaker_shortcuts: {},
    extensions: [{ id: 'en', segments: extension }],
    subtitle_groups: { next_id: 1, sticker: [], color: [
      { id: 'red', value: { name: 'red' } }, { id: 'blue', value: { name: 'blue' } },
    ] },
    bindings: [0, 1, 2].map(index => ({ id: `b${index}`,
      source: { track_id: 'main', segment_id: `m${index}` },
      target: { track_id: 'en', segment_id: `e${index}` }, start_offset_ms: 0, end_offset_ms: 0 })),
  });
  const groups = createGroups({ cloneJsonValue: structuredClone });
  const context = {
    document: { getElementById: () => null, addEventListener() {} },
    MaweBoot: { DATA: project }, AsrEditorUtils: { ...projectModel, ...groups },
    MaweDom: {}, MaweCuePanelState: {}, MaweSelection: {}, MawePlaybackLoop: {},
    MaweMultiSubtitleCore: {
      getMultiSubtitleState: () => project,
      multiSubtitleVisible: () => true,
      getActiveExtensionTrack: () => project.tracks.find(track => track.role === 'secondary'),
      removeBindingsForSegmentIds(mainIds, extensionIds) {
        project.bindings = project.bindings.filter(binding => !mainIds.includes(binding.source.segment_id)
          && !extensionIds.includes(binding.target.segment_id));
      },
      markMultiSubtitleDirty() {},
    },
    splitGroupsAtCutPoints: (indexes, kind, _ref, segments = main) => groups.clearSubtitleGroupMembers(project, segments, indexes, kind),
    clearSelection() {},
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(invokedInitModuleSource('editor/cues/editor-timed-text-edit.js', 'initMaweTimedTextEdit'), context);
  return { context, project, main, extension };
}

function assertValid(project) {
  const saved = projectModel.snapshotProjectContent(project);
  const result = projectModel.validateTracksProject(saved);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(projectModel.importProject(saved).project, saved);
}

test('timed-text main deletion removes its bound secondary and preserves surviving groups', () => {
  const { context, project, main, extension } = fixture();
  const source = structuredClone(main);
  const count = context.MaweTimedTextEdit.applyTimedTextEditSegments('main', source, main,
    source.slice(1), { rows: [] }, []);
  assert.equal(count, 1);
  assert.deepEqual(main.map(cue => cue.id), ['m1', 'm2']);
  assert.deepEqual(extension.map(cue => cue.id), ['e1', 'e2']);
  assert.equal(extension[0].color_group_id, 'red');
  assert.equal(project.bindings.length, 2);
  assert.equal(project.subtitle_groups.color.some(group => group.id === 'blue'), false);
  assertValid(project);
});

test('timed-text secondary deletion collects only groups without remaining members', () => {
  const { context, project, main, extension } = fixture();
  const source = structuredClone(extension);
  const count = context.MaweTimedTextEdit.applyTimedTextEditSegments('extension', source, extension,
    source.slice(1), { rows: [] }, []);
  assert.equal(count, 1);
  assert.deepEqual(main.map(cue => cue.id), ['m0', 'm1', 'm2']);
  assert.deepEqual(extension.map(cue => cue.id), ['e1', 'e2']);
  assert.equal(project.bindings.length, 2);
  assert.equal(project.subtitle_groups.color.some(group => group.id === 'blue'), false);
  assert.equal(project.subtitle_groups.color.some(group => group.id === 'red'), true);
  assertValid(project);
});
