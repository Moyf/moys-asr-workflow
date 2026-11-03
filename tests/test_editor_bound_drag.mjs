import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

test('squeezed bound drag restores only secondary tracks between frames', () => {
  const main = { id: 'main', role: 'main', segments: [{ id: 'm', start: 1000, end: 2000 }] };
  const secondary = { id: 'secondary', role: 'secondary', segments: [{ id: 's', start: 1000, end: 2000 }] };
  const overlay = { id: 'overlay', role: 'overlay', segments: [{ id: 'o', start: 3000, end: 4000 }] };
  const binding = { source: { track_id: 'main', segment_id: 'm' }, target: { track_id: 'secondary', segment_id: 's' } };
  const project = { tracks: [main, secondary, overlay], bindings: [binding] };
  const core = {
    multiSubtitleVisible: () => true,
    getMultiSubtitleState: () => project,
    getExtensionTrack: () => secondary,
    extensionSegmentById: () => secondary.segments[0],
    bindingForMainIndex: () => binding,
    extensionTrackSelectionSnapshot: () => null,
    resolveExtensionFollowerRange: (_target, start, end) => ({ start, end, squeezedCount: 0, removedCount: 0 }),
    syncBindingOffsets: () => {},
  };
  const context = { MaweBoot: { DATA: project }, MaweMultiSubtitleCore: core,
    MaweState: { markProjectDirty() {} }, MaweCuePanel: { remapPanelItems: () => undefined },
    window: { AsrEditorUtils: { getMainTrack: () => main } } };
  vm.runInNewContext(readFileSync(new URL('../web/editor/cues/editor-bound-drag.js', import.meta.url), 'utf8'), context);
  const drag = { track: 'main', kind: 'move', indices: [0], allowSqueeze: true,
    originals: new Map([[0, { start: 1000, end: 2000 }]]) };
  const move = start => {
    main.segments[0].start = start;
    main.segments[0].end = start + 1000;
    context.window.MaweBoundDrag.syncBoundCueDrag(drag);
  };
  move(1100);
  overlay.segments[0].start = 3100;
  move(1200);
  assert.equal(main.segments[0].start, 1200);
  assert.equal(secondary.segments[0].start, 1200);
  assert.equal(overlay.segments[0].start, 3100);
  move(1000);
  assert.equal(main.segments[0].start, 1000);
  assert.equal(secondary.segments[0].start, 1000);
});
