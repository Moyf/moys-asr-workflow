import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { createUtilsModule } from '../web/shared/utils/history.js';

const clone = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const utils = createUtilsModule({ cloneJsonValue: clone });
  const data = { markers: [{ id: 'marker', start: 1000 }],
    segments: [{ id: 'main', start: 1000, end: 2000 }],
    overlay_track: { segments: [{ id: 'overlay', start: 1300, end: 2300 }] },
    multi_subtitle: { tracks: [{ segments: [{ id: 'extension', start: 1100, end: 2100 }] }] },
  };
  const buttons = { 'undo-btn': {}, 'redo-btn': {} };
  const context = vm.createContext({ window: { AsrEditorUtils: {
    ...utils, normalizeMarkers: clone, cloneMarkerValue: clone,
  }, removeEventListener() {} }, document: { getElementById: id => buttons[id] },
  MaweBoot: { DATA: data }, MaweState: { changes: {}, markProjectDirty() {} },
  MaweCoreState: {}, MaweHint: { flashHint() {} },
  MaweInlineEdit: { editingState: null },
  MaweWordTiming: { clearSelection() {} },
  MaweMarkerEditing: { afterExternalMarkersChange() {} },
  });
  vm.runInContext(readFileSync(new URL('../web/editor/state/editor-history.js', import.meta.url), 'utf8'), context);
  // Exercise the production cancellation path, including releasing the drag
  // and its transaction, rather than replacing cancelCueDrag with a spy.
  vm.runInContext(readFileSync(new URL('../web/editor/media/waveform/cue-commands.js', import.meta.url), 'utf8')
    .replace('export function createWaveformModule', 'function cueCommandFactory'), context);
  const methods = context.cueCommandFactory({});
  let cancelled = 0;
  const waveform = {
    content: { querySelectorAll: () => [] }, pane: { classList: { remove() {} } },
    options: { onCancelEdit() { cancelled += 1; } },
    restoreSelectedMoveDrag(drag) {
      for (const move of drag.moveTracks || [drag]) {
        move.segments.forEach((segment, index) => Object.assign(segment, move.originals[index]));
      }
    }, refreshCueOverlay() {}, isCueBoundaryDrag: () => false, setStatus() {},
    cancelCueDrag: methods.cancelCueDrag.value,
    endMarkerDrag() { this.markerDrag = null; this.markerCreateDrag = null; cancelled += 1; },
    cancelWordDrag() { this.wordDrag = null; cancelled += 1; },
  };
  context.MaweCoreState.waveformEditor = waveform;
  const history = context.window.MaweHistory;
  function beginCuePreview() {
    const tracks = [data.segments, data.overlay_track.segments, data.multi_subtitle.tracks[0].segments];
    waveform.drag = { pointerId: 1, moveTracks: tracks.map(segments => ({ segments, originals: clone(segments) })) };
    tracks.forEach(segments => segments.forEach(segment => { segment.start += 500; segment.end += 500; }));
  }
  return { data, waveform, history, beginCuePreview, cancelled: () => cancelled };
}

for (const action of ['performUndo', 'performRedo']) {
  test(`${action} cancels an active multi-track preview before touching history`, () => {
    const f = fixture();
    f.history.pushMarkersUndo('move marker');
    f.data.markers[0].start = 2000;
    if (action === 'performRedo') f.history.performUndo();
    const before = clone(f.data);
    const lengths = [f.history.editorHistory.undoLength(), f.history.editorHistory.redoLength()];
    const identities = [f.data.segments[0], f.data.overlay_track.segments[0], f.data.multi_subtitle.tracks[0].segments[0]];
    f.beginCuePreview();
    f.history[action]();
    assert.equal(f.waveform.drag, null);
    assert.equal(f.cancelled(), 1);
    assert.deepEqual(f.data, before);
    assert.deepEqual([f.history.editorHistory.undoLength(), f.history.editorHistory.redoLength()], lengths);
    [f.data.segments[0], f.data.overlay_track.segments[0], f.data.multi_subtitle.tracks[0].segments[0]]
      .forEach((segment, index) => assert.equal(segment, identities[index]));
    // A second request traverses the original stack normally.
    f.history[action]();
    assert.equal(f.data.markers[0].start, action === 'performUndo' ? 1000 : 2000);
  });

  test(`${action} cancels a preview even when its history stack is empty`, () => {
    const f = fixture();
    const before = clone(f.data);
    f.beginCuePreview();
    f.history[action]();
    assert.equal(f.waveform.drag, null);
    assert.deepEqual(f.data, before);
    assert.equal(f.history.editorHistory.undoLength(), 0);
    assert.equal(f.history.editorHistory.redoLength(), 0);
  });

  for (const kind of ['markerDrag', 'markerCreateDrag', 'wordDrag', 'createCueDrag']) {
    test(`${action} cancels ${kind} through the same entry point and preserves redo`, () => {
      const f = fixture();
      f.history.pushMarkersUndo('move marker');
      f.data.markers[0].start = 2000;
      f.history.performUndo();
      const before = clone(f.data);
      f.waveform[kind] = kind === 'createCueDrag'
        ? { finish(commit) { assert.equal(commit, false); f.waveform.createCueDrag = null; } }
        : { pointerId: 2, startClientX: 10, startClientY: 10 };
      f.history[action]();
      assert.equal(f.waveform[kind], null);
      assert.deepEqual(f.data, before);
      assert.equal(f.history.editorHistory.undoLength(), 0);
      assert.equal(f.history.editorHistory.redoLength(), 1);
      f.history.performRedo();
      assert.equal(f.data.markers[0].start, 2000);
    });
  }
}
