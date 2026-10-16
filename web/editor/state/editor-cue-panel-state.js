import { freezeFacade } from './editor-facade-utils.js';
// 真 ESM：模块顶层定义与发布（原转换体 phase-2 语义 = import 求值）。
// window.<Name> 与导出的 <Name> 是同一对象；消费者逐簇改 import 后移除 window 发布。
'use strict';

function resetCuePanelEditState({ discard = false } = {}) {
  const command = MaweState.panel.cuePanelUndoRecord;
  MaweState.panel.cuePanelUndoPushed = false;
  MaweState.panel.cuePanelUndoRecord = null;
  MaweState.panel.cuePanelTextEditSnapshot = null;
  if (discard) command?.discard();
  else command?.commit();
}

window.MaweCuePanelState = Object.freeze({
  get gapPreviewRange() { return MaweState.panel.gapPreviewRange; },
  set gapPreviewRange(v) { MaweState.panel.gapPreviewRange = v; },
  get gapRemovePanelDrag() { return MaweState.panel.gapRemovePanelDrag; },
  set gapRemovePanelDrag(v) { MaweState.panel.gapRemovePanelDrag = v; },
  get currentCuePanelIdx() { return MaweState.panel.currentCuePanelIdx; },
  set currentCuePanelIdx(v) { MaweState.panel.currentCuePanelIdx = v; },
  get currentCuePanelKind() { return MaweState.panel.currentCuePanelKind; },
  set currentCuePanelKind(v) { MaweState.panel.currentCuePanelKind = v; },
  get currentCuePanelTrackId() { return MaweState.panel.currentCuePanelTrackId; },
  set currentCuePanelTrackId(v) { MaweState.panel.currentCuePanelTrackId = v; },
  get cuePanelUndoPushed() { return MaweState.panel.cuePanelUndoPushed; },
  set cuePanelUndoPushed(v) { MaweState.panel.cuePanelUndoPushed = v; },
  get cuePanelUndoRecord() { return MaweState.panel.cuePanelUndoRecord; },
  set cuePanelUndoRecord(v) { MaweState.panel.cuePanelUndoRecord = v; },
  get cuePanelTextEditSnapshot() { return MaweState.panel.cuePanelTextEditSnapshot; },
  set cuePanelTextEditSnapshot(v) { MaweState.panel.cuePanelTextEditSnapshot = v; },
  get cuePanelCanceling() { return MaweState.panel.cuePanelCanceling; },
  set cuePanelCanceling(v) { MaweState.panel.cuePanelCanceling = v; },
  resetCuePanelEditState
});

export const MaweCuePanelState = freezeFacade({
    get gapPreviewRange() { return MaweState.panel.gapPreviewRange; },
    set gapPreviewRange(v) { MaweState.panel.gapPreviewRange = v; },
    get gapRemovePanelDrag() { return MaweState.panel.gapRemovePanelDrag; },
    set gapRemovePanelDrag(v) { MaweState.panel.gapRemovePanelDrag = v; },
    get currentCuePanelIdx() { return MaweState.panel.currentCuePanelIdx; },
    set currentCuePanelIdx(v) { MaweState.panel.currentCuePanelIdx = v; },
    get currentCuePanelKind() { return MaweState.panel.currentCuePanelKind; },
    set currentCuePanelKind(v) { MaweState.panel.currentCuePanelKind = v; },
    get currentCuePanelTrackId() { return MaweState.panel.currentCuePanelTrackId; },
    set currentCuePanelTrackId(v) { MaweState.panel.currentCuePanelTrackId = v; },
    get cuePanelUndoPushed() { return MaweState.panel.cuePanelUndoPushed; },
    set cuePanelUndoPushed(v) { MaweState.panel.cuePanelUndoPushed = v; },
    get cuePanelUndoRecord() { return MaweState.panel.cuePanelUndoRecord; },
    set cuePanelUndoRecord(v) { MaweState.panel.cuePanelUndoRecord = v; },
    get cuePanelTextEditSnapshot() { return MaweState.panel.cuePanelTextEditSnapshot; },
    set cuePanelTextEditSnapshot(v) { MaweState.panel.cuePanelTextEditSnapshot = v; },
    get cuePanelCanceling() { return MaweState.panel.cuePanelCanceling; },
    set cuePanelCanceling(v) { MaweState.panel.cuePanelCanceling = v; },
    resetCuePanelEditState
  }, ["gapPreviewRange", "gapRemovePanelDrag", "currentCuePanelIdx", "currentCuePanelKind", "currentCuePanelTrackId", "cuePanelUndoPushed", "cuePanelUndoRecord", "cuePanelTextEditSnapshot", "cuePanelCanceling"]);
window.MaweCuePanelState = MaweCuePanelState;
