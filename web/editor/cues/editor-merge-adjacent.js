import { MaweBoot } from '../boot/editor-boot.js';
import { MaweState } from '../state/editor-state.js';
import { MaweHint } from '../ui/editor-hint.js';
import { MaweSelection } from './editor-selection.js';
import { mergeExtensionSegments, mergeSegments } from './editor-segment-ops.js';
export let MaweMergeAdjacent;
import { getCurrentCuePanelTarget } from './editor-cue-panel.js';
import { getOverlayTrack, mergeOverlaySegments } from './overlay-track.js';
import { AsrEditorUtils } from '../../shared/editor-utils.js';

export function initMaweMergeAdjacent() {
'use strict';

// 相邻字幕合并。
// 由 split-cluster codemod 自 editor.js 拆出。
(function initMaweMergeAdjacent(global) {
  'use strict';



  function mergeAdjacentSubtitle(direction) {
  const target = getCurrentCuePanelTarget();
  const extension = target?.kind === 'extension';
  const overlay = target?.kind === 'overlay';
  const track = extension ? target.track : null;
  const segments = extension
    ? track?.segments || []
    : overlay ? (getOverlayTrack()?.segments || []) : AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments;
  let index = Number.isInteger(target?.index) ? target.index : -1;
  if (index < 0) {
    const selected = extension ? MaweSelection.selectedExtensionIdxs
      : overlay ? MaweState.selection.indices('overlay') : MaweSelection.selectedIdxs;
    if (selected.size === 1) index = [...selected][0];
    else index = extension ? MaweSelection.lastClickedExtensionIdx
      : overlay ? MaweState.selection.overlayAnchor : MaweSelection.lastClickedIdx;
  }
  const neighbor = index + direction;
  if (!segments[index] || !segments[neighbor]) {
    MaweHint.flashHint(direction < 0 ? '前面没有可粘合的字幕' : '后面没有可粘合的字幕', 'warning');
    return false;
  }
  const indices = direction < 0 ? [neighbor, index] : [index, neighbor];
  if (extension) return mergeExtensionSegments(indices, track);
  if (overlay) return mergeOverlaySegments(indices);
  mergeSegments(indices);
  return true;
}

  MaweMergeAdjacent = Object.freeze({
    mergeAdjacentSubtitle
  });

})(typeof window !== 'undefined' ? window : globalThis);
}

export function mergeAdjacentSubtitle(...args) { return MaweMergeAdjacent.mergeAdjacentSubtitle(...args); }
