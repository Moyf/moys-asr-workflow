import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { createUtilsModule } from '../web/shared/utils/history.js';
import { compileEditorUnitFixture, makeDocumentStub } from './helpers/editor-module-loader.mjs';
import { createWaveformModule as cueCommandFactory } from '../web/editor/media/waveform/cue-commands.js';
import { makeFacadeStub } from './helpers/editor-module-loader.mjs';
// 真 ESM 导入的工厂在 Node 下无 window：测试期补全局（生产 bundle 运行于浏览器）
globalThis.window = { addEventListener() {}, removeEventListener() {}, MAWE: { register() {}, resolve() { return {}; } } };

const clone = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const utils = createUtilsModule({ cloneJsonValue: clone });
  let data = { markers: [{ id: 'marker', start: 1000 }],
    segments: [{ id: 'main', start: 1000, end: 2000 }],
    overlay_track: { segments: [{ id: 'overlay', start: 1300, end: 2300 }] },
    multi_subtitle: { tracks: [{ segments: [{ id: 'extension', start: 1100, end: 2100 }] }] },
  };
  // editor-boot 模块经 import 图求值会以模板注入的空 DATA
  // 覆盖 MaweBoot；统一把测试数据注入真 DATA。
  const buttons = { 'undo-btn': {}, 'redo-btn': {} };
  const context = vm.createContext({ MaweHost: { runtime: { getNavigator: () => ({ platform: 'Win32' }) } }, URLSearchParams, location: { search: '' }, window: { addEventListener() {}, removeEventListener() {}, MAWE: { register() {}, resolve() { return {}; } }, AsrEditorUtils: {
    ...utils, normalizeMarkers: clone, cloneMarkerValue: clone,
  }, removeEventListener() {} }, document: makeDocumentStub((doc) => { const base = doc.getElementById.bind(doc);
    return { getElementById: (id) => buttons[id] ?? base(id) }; }),
  MaweDom: makeFacadeStub(),
  MaweBoot: { DATA: data, maweDomContractCheck: () => [], maweDebug() {} },
  MaweMultiSubtitleCore: { MULTI: 'main', getActiveExtensionTrack: () => ({ segments: [] }), getExtensionSubtitleSplitMode: () => 'word', getMainSubtitleSplitMode: () => 'word', getMultiSubtitleState: () => ({ enabled: false, tracks: [] }), normalizeMultiSubtitleState: (state) => state ?? { enabled: false, tracks: [] } },
  MaweState: { changes: {} },
  MaweCoreState: {}, MaweHint: { flashHint() {} },
  MaweInlineEdit: { editingState: null },
  MaweWordTiming: { clearSelection() {} },
  MaweMarkerEditing: { afterExternalMarkersChange() {} },
  });
  vm.runInContext(compileEditorUnitFixture('editor/state/editor-history.js'), context);
  // editor-boot 模块经 import 图求值覆盖了 MaweBoot；测试数据注入真 DATA。
  data = context.MaweBoot.DATA;
  data.markers = [{ id: 'marker', start: 1000 }];
  data.segments = [{ id: 'main', start: 1000, end: 2000 }];
  data.overlay_track = { segments: [{ id: 'overlay', start: 1300, end: 2300 }] };
  data.multi_subtitle = { tracks: [{ segments: [{ id: 'extension', start: 1100, end: 2100 }] }] };
  // Exercise the production cancellation path, including releasing the drag
  // and its transaction, rather than replacing cancelCueDrag with a spy.
  // 透传工厂改真 ESM 导入（bundle 内不再有 export 原文可替换）
  const methods = cueCommandFactory({});
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
    assert.equal(JSON.stringify(f.data), JSON.stringify(before));
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
    assert.equal(JSON.stringify(f.data), JSON.stringify(before));
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
      assert.equal(JSON.stringify(f.data), JSON.stringify(before));
      assert.equal(f.history.editorHistory.undoLength(), 0);
      assert.equal(f.history.editorHistory.redoLength(), 1);
      f.history.performRedo();
      assert.equal(f.data.markers[0].start, 2000);
    });
  }
}
