import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { invokedInitModuleSource } from './helpers/init-module-source.mjs';

function fixture({ timed = true } = {}) {
  const segment = { id: 'cue', start: 0, end: 1000, text: 'hello' };
  const project = { schema: 'moy.asr.project.v2', tracks: [{ role: 'main', segments: [segment] }] };
  const calls = { notices: [], modal: [], splits: [] };
  const context = {
    document: { addEventListener() {} },
    MaweBoot: { DATA: project },
    AsrEditorUtils: { getMainTrack: value => value.tracks.find(track => track.role === 'main') },
    MaweCoreState: { container: { querySelector: () => ({}) }, waveformEditor: null },
    MaweMultiSubtitleCore: { multiSubtitleVisible: () => false, getMainSubtitleSplitMode: () => 'continuous' },
    MaweHint: { flashHint() {} },
    timelineFrameAlignedMilliseconds: value => value,
    shouldUseMainSplitTimestamps: value => { assert.equal(value, segment); return timed; },
    notifyMainSplitTimestampFallback: value => calls.notices.push(value),
    openMainWaveformSplitModal: (...args) => calls.modal.push(args),
    splitOffsetNearTime: value => { assert.equal(value, segment); return 2; },
    splitAtCursor: (_point, options) => {
      calls.splits.push(options.explicit.force);
      if (!options.explicit.force) options.explicit.onForcedSplitArmed(50);
      return options.explicit.force;
    },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(invokedInitModuleSource('editor/cues/editor-split-context.js', 'initMaweSplitContext'), context);
  return { context, segment, calls };
}

test('untimed waveform split opens the fallback for the v2 main cue', () => {
  const { context, segment, calls } = fixture({ timed: false });
  assert.equal(context.MaweSplitContext.splitFromContextMenu(0, 0, 0, 250), false);
  assert.equal(calls.notices[0], segment);
  assert.equal(calls.modal[0][0], 0);
  assert.equal(calls.modal[0][1], 250);
});

test('waveform force-split is armed for the same v2 segment only', () => {
  const { context, calls } = fixture();
  assert.equal(context.MaweSplitContext.splitFromContextMenu(0, 0, 0, 50), false);
  assert.equal(context.MaweSplitContext.splitFromContextMenu(0, 0, 0, 50), true);
  assert.deepEqual(calls.splits, [false, true]);
});
