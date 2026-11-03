import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const load = (context, file) => vm.runInNewContext(fs.readFileSync(new URL(`../web/editor/${file}`, import.meta.url), 'utf8'), context);

test('Z/X dispatches to current cue track and empty selection uses main', () => {
  const main = { id: 'm', role: 'main', segments: [{ id: 'same', start: 1000, end: 3000 }] };
  const secondary = { id: 's', role: 'secondary', segments: [{ id: 'same', start: 1100, end: 2900 }] };
  const overlay = { id: 'o', role: 'overlay', segments: [{ id: 'same', start: 1500, end: 2500 }] };
  let refs = [], current = null;
  const calls = [];
  const modal = { classList: { contains: () => false } };
  const context = {
    window: {}, document: { activeElement: null },
    MaweState: { selection: {
      getSelectedCueRefs: () => refs,
      getCurrentCueRef: () => current,
      getCurrentTrack: () => [main, secondary, overlay].find(t => t.id === current?.track_id) || main,
    } },
    MaweCoreState: { player: { currentTime: 1.8 }, waveformEditor: {
      setCueBoundaryToTime: (...args) => { calls.push(args); return true; },
    } },
    MaweCuePanel: { getCurrentCuePanelTarget: () => null },
    MaweContextMenus: { findWaveformCueAtTime: (time, segments) => segments.findIndex(s => s.start <= time && s.end >= time) },
    MaweAppearance: { GEO_UTILS: { resolveKeyboardOperationReference: (_mode, { playheadTarget }) => playheadTarget } },
    MaweSettings: { EDITOR_SETTINGS: {} },
    MaweMultiSubtitleCore: {
      bindingForMainIndex: () => ({ target: { track_id: 's', segment_id: 'same' } }),
      bindingForExtensionIndex: () => ({ source: { track_id: 'm', segment_id: 'same' } }),
    },
    MaweInlineEdit: {}, MaweKeyboardTargets: { isTextEditingTarget: () => false },
    MaweDom: { replaceModal: modal, stickerModal: modal, stickerPreviewModal: modal, projectMediaModal: modal, ctxmenu: modal },
    MaweHint: { flashHint() {} },
  };
  load(context, 'cues/editor-nav-preview.js');
  const api = context.window.MaweNavPreview;
  const press = (key, edge) => { const event = { key, preventDefault() {}, stopPropagation() {} }; api.handlePointerBoundaryShortcut(event, edge); };
  press('z', 'start');
  assert.deepEqual(calls.pop(), [1800, 'start', 'main', 0]);
  refs = [{ track_id: 'm', segment_id: 'same' }, { track_id: 's', segment_id: 'same' }];
  current = refs[1]; press('x', 'end');
  assert.deepEqual(calls.pop(), [1800, 'end', 'extension', 0]);
  current = refs[0]; press('z', 'start');
  assert.deepEqual(calls.pop(), [1800, 'start', 'main', 0]);
  refs = [{ track_id: 'o', segment_id: 'same' }]; current = refs[0]; press('x', 'end');
  assert.deepEqual(calls.pop(), [1800, 'end', 'overlay', 0]);
  assert.equal(calls.length, 0);
});

test('drag warning counts only other subtitles still changed when released', () => {
  const follower = { id: 'f', start: 100, end: 400 };
  const neighbor = { id: 'n', start: 450, end: 800 };
  const track = { role: 'secondary', segments: [follower, neighbor] };
  const context = { window: {}, MaweMultiSubtitleCore: { getMultiSubtitleState: () => ({ bindings: [] }) } };
  load(context, 'cues/editor-bound-drag.js');
  const drag = { boundOriginals: new Map([[0, { target: follower }]]), boundDragTimelineOriginals: {
    tracks: [{ track, segments: [{ segment: follower, start: 0, end: 300 }, { segment: neighbor, start: 400, end: 800 }] }], bindings: [],
  } };
  const impact = () => context.window.MaweBoundDrag.boundDragImpact(drag);
  assert.equal(impact().squeezedCount, 1);
  neighbor.start = 400;
  assert.equal(impact().squeezedCount, 0, 'returning to the initial range clears the warning');
  track.segments = [follower];
  assert.equal(impact().removedCount, 1);
});
