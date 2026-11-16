import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { invokedInitModuleSource } from './helpers/init-module-source.mjs';

test('keyboard split offsets resolve the overlay track instead of the secondary track', () => {
  const overlay = { id: 'overlay', role: 'overlay', segments: [{ id: 'cue', text: 'abcd' }] };
  const state = { kind: 'overlay', trackId: 'overlay', extensionId: 'cue', extensionMode: 'continuous', offset: 2 };
  const c = {
    MaweOverlaySplitMerge: { splitStateTrack: value => value.kind === 'overlay' ? overlay : null },
    MaweMultiSubtitleCore: {
      getExtensionTrack: () => null,
      extensionSegmentById: (id, track) => track?.segments.find(segment => segment.id === id),
    },
    AsrEditorUtils: { subtitleSplitOffsets: text => Array.from({ length: text.length - 1 }, (_, i) => i + 1) },
  };
  c.window = c;
  vm.createContext(c);
  vm.runInContext(invokedInitModuleSource('editor/cues/editor-split-core.js', 'initMaweSplitCore'), c);
  assert.equal(c.MaweSplitCore.stepSplitLaneOffset(state, 'extension', 1), 3);
  assert.equal(c.MaweSplitCore.stepSplitLaneOffset(state, 'extension', -1), 1);
});
