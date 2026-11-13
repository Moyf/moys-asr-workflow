import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { invokedInitModuleSource } from './helpers/init-module-source.mjs';

function fixture(role = 'main') {
  const track = { role, id: role === 'secondary' ? 'en' : role, segments: [{ id: `${role}-cue`, start: 0, end: 1000 }] };
  let refs = [], current = null;
  const binding = { source: { track_id: 'main', segment_id: 'main-cue' }, target: { track_id: 'en', segment_id: 'secondary-cue' } };
  const context = {
    MaweState: { selection: { getSelectedCueRefs: () => refs, getCurrentTrack: () => track, getCurrentCueRef: () => current } },
    MaweMultiSubtitleCore: { bindingForMainIndex: () => binding, bindingForExtensionIndex: () => binding },
    MaweContextMenus: { findWaveformCueAtTime: () => 0 },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(invokedInitModuleSource('editor/cues/editor-nav-preview.js', 'initMaweNavPreview'), context);
  return { context, track, setSelection(nextRefs, nextCurrent) { refs = nextRefs; current = nextCurrent; } };
}

test('main and bound secondary form one logical selected cue', () => {
  const f = fixture();
  const selected = { track_id: 'main', segment_id: 'main-cue' };
  f.setSelection([selected, { track_id: 'en', segment_id: 'secondary-cue' }], selected);
  const result = f.context.MaweNavPreview.getPointerBoundaryEditTarget({ timeMs: 500 });
  assert.equal(result.kind, 'main');
  assert.equal(result.segment.id, 'main-cue');
});

test('unrelated cross-track selection cannot accidentally edit the current cue', () => {
  const f = fixture();
  const selected = { track_id: 'main', segment_id: 'main-cue' };
  f.setSelection([selected, { track_id: 'en', segment_id: 'other' }], selected);
  assert.equal(f.context.MaweNavPreview.getPointerBoundaryEditTarget({ timeMs: 500 }), null);
});

test('current secondary and overlay tracks remain valid pointer targets', () => {
  for (const role of ['secondary', 'overlay']) {
    const f = fixture(role);
    const selected = { track_id: f.track.id, segment_id: f.track.segments[0].id };
    f.setSelection([selected], selected);
    const result = f.context.MaweNavPreview.getPointerBoundaryEditTarget({ timeMs: 500 });
    assert.equal(result.kind, role === 'secondary' ? 'extension' : 'overlay');
    assert.equal(result.segment.id, selected.segment_id);
  }
});

test('empty selection uses the current track hit result', () => {
  const f = fixture('overlay');
  const result = f.context.MaweNavPreview.getPointerBoundaryEditTarget({ timeMs: 500 });
  assert.equal(result.kind, 'overlay');
  assert.equal(result.index, 0);
});
