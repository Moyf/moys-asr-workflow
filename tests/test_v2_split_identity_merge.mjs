import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { invokedInitModuleSource } from './helpers/init-module-source.mjs';

test('v2 split preserves left identity and avoids IDs reserved on another track', () => {
  const segment = { id: 'main-1', start: 0, end: 2000, text: 'hello',
    speaker: 'speaker-1', color_group_id: 'red', vendor: { nested: { keep: true } } };
  const project = { tracks: [
    { id: 'main', role: 'main', segments: [segment] },
    { id: 'en', role: 'secondary', segments: [{ id: 'main-1-b' }] },
  ] };
  const context = {
    MaweBoot: { DATA: project },
    MaweSettings: { EDITOR_SETTINGS: { assMode: false } },
    MaweMultiSubtitleCore: { SUBTITLE_MIN_DURATION_MS: 100 },
    AsrEditorUtils: {
      MULTI_SUBTITLE_SPLIT_MODES: new Set(['continuous', 'word']),
      alignItemsToText: () => [],
      subtitleGroupTracks: value => value.tracks,
      cloneJsonValue: structuredClone,
      uniqueStableSegmentId(segments, base) {
        const used = new Set(segments.map(value => value.id));
        let candidate = base, index = 2;
        while (used.has(candidate)) candidate = `${base}-${index++}`;
        return candidate;
      },
      splitAlignmentDriftMs: () => 0,
    },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(invokedInitModuleSource('editor/cues/editor-split-core.js', 'initMaweSplitCore'), context);
  const pair = context.MaweSplitCore.buildSplitPair(segment, 2, 1000, 'main-1', false, 'continuous', { duplicateText: true });
  assert.equal(pair.left.id, 'main-1');
  assert.equal(pair.right.id, 'main-1-b-2');
  assert.equal(pair.left.speaker, 'speaker-1');
  assert.equal(pair.right.color_group_id, 'red');
  pair.right.vendor.nested.keep = false;
  assert.equal(pair.left.vendor.nested.keep, true);
  assert.equal(segment.vendor.nested.keep, true);
});
