import { getOverlayTrack } from "./editor-wiring-overlay-transfer.js";
import { mergeOverlaySegments } from "./editor-wiring-overlay-split-merge.js";

import { MaweHint } from "../ui/editor-hint.js";
import { MaweBoot } from "../boot/editor-boot.js";
import { MaweSelection } from "./editor-selection.js";
import { MaweCuePanel } from "./editor-cue-panel.js";
import { MaweSegmentOps } from "./editor-segment-ops.js";
// 真 ESM：模块顶层定义与发布（原转换体 phase-2 语义 = import 求值）。
// window.<Name> 与导出的 <Name> 是同一对象；消费者逐簇改 import 后移除 window 发布。
'use strict';


function mergeAdjacentSubtitle(direction) {
const target = MaweCuePanel.getCurrentCuePanelTarget();
const extension = target?.kind === 'extension';
const overlay = target?.kind === 'overlay';
const track = extension ? target.track : null;
const segments = extension
  ? track?.segments || []
  : overlay ? (getOverlayTrack()?.segments || []) : MaweBoot.DATA.segments;
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
if (extension) return MaweSegmentOps.mergeExtensionSegments(indices, track);
if (overlay) return mergeOverlaySegments(indices);
MaweSegmentOps.mergeSegments(indices);
return true;
}

window.MaweMergeAdjacent = Object.freeze({
  mergeAdjacentSubtitle
});

export const MaweMergeAdjacent = Object.freeze({
    mergeAdjacentSubtitle
  });
window.MaweMergeAdjacent = MaweMergeAdjacent;
