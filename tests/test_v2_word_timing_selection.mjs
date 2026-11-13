import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { invokedInitModuleSource } from './helpers/init-module-source.mjs';

test('word selection resolves the v2 main cue and uses imported panel actions', () => {
  const segment = { id: 'cue', text: 'hello', items: [{ text: 'hello', start: 0, end: 1000 }] };
  const project = { schema: 'moy.asr.project.v2', tracks: [{ role: 'main', segments: [segment] }] };
  const calls = { commit: 0, selected: [] };
  const context = {
    document: { addEventListener() {} },
    MaweBoot: { DATA: project },
    AsrEditorUtils: { getMainTrack: value => value.tracks.find(track => track.role === 'main'),
      getWordTimingEntries: value => value.items.map((_, index) => ({ index })) },
    MaweCoreState: {}, MaweSelection: { lastClickedIdx: -1 },
    commitCuePanelEdit() { calls.commit++; },
    selectOnly: index => calls.selected.push(index),
    timelineTimingAdapter: () => ({}),
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(invokedInitModuleSource('editor/cues/editor-word-timing.js', 'initMaweWordTiming'), context);
  context.MaweWordTiming.select(0, 0);
  assert.equal(calls.commit, 1);
  assert.deepEqual(calls.selected, [0]);
  assert.equal(context.MaweWordTiming.getSelection(segment).has(0), true);
  assert.equal(context.MaweSelection.lastClickedIdx, 0);
});
