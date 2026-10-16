import { freezeFacade } from './editor-facade-utils.js';
import { getMaweState } from './editor-state.js';
// 真 ESM：模块顶层定义与发布（原转换体 phase-2 语义 = import 求值）。
// window.<Name> 与导出的 <Name> 是同一对象；消费者逐簇改 import 后移除 window 发布。
'use strict';

function resetCuePanelEditState({ discard = false } = {}) {
  const command = getMaweState().panel.cuePanelUndoRecord;
  getMaweState().panel.cuePanelUndoPushed = false;
  getMaweState().panel.cuePanelUndoRecord = null;
  getMaweState().panel.cuePanelTextEditSnapshot = null;
  if (discard) command?.discard();
  else command?.commit();
}

window.MaweCuePanelState = Object.freeze({
  get gapPreviewRange() { return getMaweState().panel.gapPreviewRange; },
  set gapPreviewRange(v) { getMaweState().panel.gapPreviewRange = v; },
  get gapRemovePanelDrag() { return getMaweState().panel.gapRemovePanelDrag; },
  set gapRemovePanelDrag(v) { getMaweState().panel.gapRemovePanelDrag = v; },
  get currentCuePanelIdx() { return getMaweState().panel.currentCuePanelIdx; },
  set currentCuePanelIdx(v) { getMaweState().panel.currentCuePanelIdx = v; },
  get currentCuePanelKind() { return getMaweState().panel.currentCuePanelKind; },
  set currentCuePanelKind(v) { getMaweState().panel.currentCuePanelKind = v; },
  get currentCuePanelTrackId() { return getMaweState().panel.currentCuePanelTrackId; },
  set currentCuePanelTrackId(v) { getMaweState().panel.currentCuePanelTrackId = v; },
  get cuePanelUndoPushed() { return getMaweState().panel.cuePanelUndoPushed; },
  set cuePanelUndoPushed(v) { getMaweState().panel.cuePanelUndoPushed = v; },
  get cuePanelUndoRecord() { return getMaweState().panel.cuePanelUndoRecord; },
  set cuePanelUndoRecord(v) { getMaweState().panel.cuePanelUndoRecord = v; },
  get cuePanelTextEditSnapshot() { return getMaweState().panel.cuePanelTextEditSnapshot; },
  set cuePanelTextEditSnapshot(v) { getMaweState().panel.cuePanelTextEditSnapshot = v; },
  get cuePanelCanceling() { return getMaweState().panel.cuePanelCanceling; },
  set cuePanelCanceling(v) { getMaweState().panel.cuePanelCanceling = v; },
  resetCuePanelEditState
});

export const MaweCuePanelState = freezeFacade({
    get gapPreviewRange() { return getMaweState().panel.gapPreviewRange; },
    set gapPreviewRange(v) { getMaweState().panel.gapPreviewRange = v; },
    get gapRemovePanelDrag() { return getMaweState().panel.gapRemovePanelDrag; },
    set gapRemovePanelDrag(v) { getMaweState().panel.gapRemovePanelDrag = v; },
    get currentCuePanelIdx() { return getMaweState().panel.currentCuePanelIdx; },
    set currentCuePanelIdx(v) { getMaweState().panel.currentCuePanelIdx = v; },
    get currentCuePanelKind() { return getMaweState().panel.currentCuePanelKind; },
    set currentCuePanelKind(v) { getMaweState().panel.currentCuePanelKind = v; },
    get currentCuePanelTrackId() { return getMaweState().panel.currentCuePanelTrackId; },
    set currentCuePanelTrackId(v) { getMaweState().panel.currentCuePanelTrackId = v; },
    get cuePanelUndoPushed() { return getMaweState().panel.cuePanelUndoPushed; },
    set cuePanelUndoPushed(v) { getMaweState().panel.cuePanelUndoPushed = v; },
    get cuePanelUndoRecord() { return getMaweState().panel.cuePanelUndoRecord; },
    set cuePanelUndoRecord(v) { getMaweState().panel.cuePanelUndoRecord = v; },
    get cuePanelTextEditSnapshot() { return getMaweState().panel.cuePanelTextEditSnapshot; },
    set cuePanelTextEditSnapshot(v) { getMaweState().panel.cuePanelTextEditSnapshot = v; },
    get cuePanelCanceling() { return getMaweState().panel.cuePanelCanceling; },
    set cuePanelCanceling(v) { getMaweState().panel.cuePanelCanceling = v; },
    resetCuePanelEditState
  }, ["gapPreviewRange", "gapRemovePanelDrag", "currentCuePanelIdx", "currentCuePanelKind", "currentCuePanelTrackId", "cuePanelUndoPushed", "cuePanelUndoRecord", "cuePanelTextEditSnapshot", "cuePanelCanceling"]);
window.MaweCuePanelState = MaweCuePanelState;
