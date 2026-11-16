import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { invokedInitModuleSource } from './helpers/init-module-source.mjs';

test('single-track render uses the canonical main track and imported cue builder', () => {
  const cues = [{ id: 'cue', start: 100, end: 400, text: 'hello' }];
  const project = { schema: 'moy.asr.project.v2', tracks: [{ role: 'main', segments: cues }], bilingual: { display_mode: 'main' } };
  const rendered = [], built = [];
  const noop = () => {};
  const context = {
    document: { addEventListener: noop, getElementById: () => null,
      createDocumentFragment: () => ({ children: [], appendChild(el) { this.children.push(el); } }) },
    MaweBoot: { DATA: project },
    AsrEditorUtils: { getMainTrack: value => value.tracks.find(track => track.role === 'main') },
    MaweCoreState: { container: { querySelector: () => null, replaceChildren: noop, appendChild: el => rendered.push(el) } },
    MaweMultiSubtitleCore: { multiSubtitleVisible: () => false },
    MaweCueListAnchor: { cueListScroll: { mutationAnchor: null } },
    MaweStickerOverlay: { stickerOverlayDataVersion: 0 },
    MaweDom: { searchEl: { value: '' }, totalCountEl: { textContent: '' } },
    MaweDisplaySettings: { applyCueListDisplaySettings: noop, updateMultiSubtitleUi: noop },
    MaweSelection: { selectedIdxs: new Set() },
    MaweMediaPlayback: { syncPlayerPlaceholder: noop },
    MaweExportSrt: { updateSubtitleExportUi: noop },
    MaweGapRemoveUi: { updateGapRemoveDisableHint: noop },
    syncProjectTimebaseAndBindingOffsets: noop,
    captureCueListRenderAnchor: () => null,
    invalidateCueListVisualAnchorRestore: noop,
    overlayTrackVisible: () => false,
    buildCueEl: (cue, index) => { built.push({ cue, index }); return { id: cue.id }; },
    refreshColorFilterUi: noop, applySearch: noop, updateMultiSelectionClasses: noop,
    refreshTimedTextEditButton: noop, restoreCueListRenderAnchor: noop,
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(invokedInitModuleSource('editor/cues/editor-cue-panel.js', 'initMaweCuePanel'), context);
  context.MaweCuePanel.renderAll();
  assert.equal(built.length, 1);
  assert.equal(built[0].cue, cues[0]);
  assert.equal(built[0].index, 0);
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].children[0].id, 'cue');
  assert.equal(context.MaweDom.totalCountEl.textContent, 1);
});
