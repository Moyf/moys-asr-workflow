// 当前字幕面板运行态：面板索引/轨道、撤销暂存与编辑状态复位。
// 状态由 MaweState 持有；保留旧接口供尚未迁移的消费者使用，外部仅经
// window.MaweCuePanelState 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweCuePanelState(global) {
  'use strict';

  function resetCuePanelEditState({ discard = false } = {}) {
    const command = MaweState.panel.cuePanelUndoRecord;
    MaweState.panel.cuePanelUndoPushed = false;
    MaweState.panel.cuePanelUndoRecord = null;
    MaweState.panel.cuePanelTextEditSnapshot = null;
    if (discard) command?.discard();
    else command?.commit();
  }

  global.MaweCuePanelState = Object.freeze({
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
})(typeof window !== 'undefined' ? window : globalThis);
