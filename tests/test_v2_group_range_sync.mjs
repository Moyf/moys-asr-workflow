import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { createUtilsModule as createGroups } from '../web/shared/utils/subtitle-groups.js';
import { invokedInitModuleSource } from './helpers/init-module-source.mjs';
import { runtimeProject } from './helpers/runtime-project.mjs';

test('group range refresh derives bounds across canonical tracks without legacy heads', () => {
  const project = runtimeProject([{ id: 'main-cue', start: 0, end: 1000, text: 'main', color_group_id: 'red' }], {
    extensions: [{ id: 'en', segments: [
      { id: 'en-cue', start: 1200, end: 2000, text: 'secondary', color_group_id: 'red' },
    ] }],
    overlay: { segments: [
      { id: 'overlay-cue', start: 2200, end: 3000, text: 'overlay', color_group_id: 'red' },
    ] },
    subtitle_groups: { next_id: 2, color: [{ id: 'red', value: { name: 'red' } }], sticker: [] },
  });
  const groups = createGroups({ cloneJsonValue: structuredClone });
  let refreshes = 0;
  const context = { MaweBoot: { DATA: project }, AsrEditorUtils: {
    refreshSubtitleGroupViews(data) { refreshes++; return groups.refreshSubtitleGroupViews(data); },
  } };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(invokedInitModuleSource('editor/cues/editor-text-cleanup.js', 'initMaweTextCleanup'), context);
  project.tracks.find(track => track.role === 'secondary').segments[0].end = 2500;
  const before = structuredClone(project);
  context.MaweTextCleanup.syncTimelineGroupRanges();
  const [range] = groups.subtitleGroupRanges(project, 'color');
  assert.equal(refreshes, 1);
  assert.equal(range.start, 0);
  assert.equal(range.end, 3000);
  assert.equal(range.members.length, 3);
  assert.deepEqual(project, before);
  assert.equal(Object.hasOwn(context.MaweTextCleanup, 'cleanPunctuation'), false);
});
