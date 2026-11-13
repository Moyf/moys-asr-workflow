import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { invokedInitModuleSource } from './helpers/init-module-source.mjs';

function fixture({ mainSelected = [], extensionSelected = [] } = {}) {
  const main = { id: 'main', role: 'main', segments: [{ id: 'main-cue' }] };
  const secondary = { id: 'en', role: 'secondary', segments: [{ id: 'en-cue' }] };
  const binding = {
    id: 'binding',
    source: { track_id: 'main', segment_id: 'main-cue' },
    target: { track_id: 'en', segment_id: 'en-cue' },
  };
  const project = { tracks: [main, secondary], bindings: [binding] };
  const calls = { before: [], hints: [], commits: [], dirty: 0, offsets: 0 };
  const context = {
    AsrEditorUtils: {
      getMainTrack: data => data.tracks.find(track => track.role === 'main'),
      removeSubtitleBindings(data, predicate) {
        const removed = data.bindings.filter(predicate);
        data.bindings = data.bindings.filter(binding => !predicate(binding));
        return removed;
      },
    },
    MaweBoot: { DATA: project },
    MaweSelection: { selectedIdxs: new Set(mainSelected), selectedExtensionIdxs: new Set(extensionSelected) },
    MaweMultiSubtitleCore: {
      getMultiSubtitleState: () => project,
      getActiveExtensionTrack: () => secondary,
      markMultiSubtitleDirty() { calls.dirty++; },
      syncBindingOffsets() { calls.offsets++; },
    },
    MaweCommands: {
      run(label, mutate) {
        calls.before.push({ label, bindings: [...project.bindings] });
        return mutate({ commit: value => calls.commits.push(value) });
      },
    },
    MaweCoreState: {},
    MaweHint: { flashHint: (...args) => calls.hints.push(args) },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(invokedInitModuleSource('editor/cues/editor-binding-align.js', 'initMaweBindingAlign'), context);
  return { context, project, binding, calls };
}

for (const selection of [{ mainSelected: [0] }, { extensionSelected: [0] }]) {
  test(`v2 binding is removed and snapshotted for ${Object.keys(selection)[0]}`, () => {
    const { context, project, binding, calls } = fixture(selection);
    context.MaweBindingAlign.unbindSelectedSubtitlePair();
    assert.deepEqual(project.bindings, []);
    assert.equal(calls.before.length, 1);
    assert.deepEqual(calls.before[0].bindings, [binding]);
    assert.equal(calls.dirty, 1);
    assert.equal(calls.offsets, 1);
    assert.equal(calls.commits.length, 1);
    assert.equal(calls.commits[0].cueList, true);
    assert.equal(calls.commits[0].waveform, 'overlay');
  });
}

test('v2 unbind reports a missing selection without starting a command', () => {
  const { context, project, calls } = fixture({ mainSelected: [0] });
  project.bindings = [];
  context.MaweBindingAlign.unbindSelectedSubtitlePair();
  assert.equal(calls.before.length, 0);
  assert.equal(calls.hints.length, 1);
  assert.equal(calls.hints[0][1], 'invalid');
});
