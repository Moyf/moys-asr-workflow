// 当前字幕面板运行态：面板索引/轨道、撤销暂存与编辑状态复位。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweCuePanelState 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweCuePanelState(global) {
  'use strict';



  let gapPreviewRange = null;


  let gapRemovePanelDrag = null;


  let currentCuePanelIdx = -1;


  let currentCuePanelKind = 'main';


  let currentCuePanelTrackId = null;


  let cuePanelUndoPushed = false;


  let cuePanelUndoRecord = null;


  let cuePanelTextEditSnapshot = null;


  let cuePanelCanceling = false;



  function resetCuePanelEditState() {
    cuePanelUndoPushed = false;
    cuePanelUndoRecord = null;
    cuePanelTextEditSnapshot = null;
  }

  global.MaweCuePanelState = Object.freeze({
    get gapPreviewRange() { return gapPreviewRange; },
    set gapPreviewRange(v) { gapPreviewRange = v; },
    get gapRemovePanelDrag() { return gapRemovePanelDrag; },
    set gapRemovePanelDrag(v) { gapRemovePanelDrag = v; },
    get currentCuePanelIdx() { return currentCuePanelIdx; },
    set currentCuePanelIdx(v) { currentCuePanelIdx = v; },
    get currentCuePanelKind() { return currentCuePanelKind; },
    set currentCuePanelKind(v) { currentCuePanelKind = v; },
    get currentCuePanelTrackId() { return currentCuePanelTrackId; },
    set currentCuePanelTrackId(v) { currentCuePanelTrackId = v; },
    get cuePanelUndoPushed() { return cuePanelUndoPushed; },
    set cuePanelUndoPushed(v) { cuePanelUndoPushed = v; },
    get cuePanelUndoRecord() { return cuePanelUndoRecord; },
    set cuePanelUndoRecord(v) { cuePanelUndoRecord = v; },
    get cuePanelTextEditSnapshot() { return cuePanelTextEditSnapshot; },
    set cuePanelTextEditSnapshot(v) { cuePanelTextEditSnapshot = v; },
    get cuePanelCanceling() { return cuePanelCanceling; },
    set cuePanelCanceling(v) { cuePanelCanceling = v; },
    resetCuePanelEditState
  });
})(typeof window !== 'undefined' ? window : globalThis);
