// 相邻字幕合并。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweMergeAdjacent 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweMergeAdjacent(global) {
  'use strict';



  function mergeAdjacentSubtitle(direction) {
    const target = getCurrentCuePanelTarget();
    const extension = target?.kind === 'extension';
    const track = extension ? target.track : null;
    const segments = extension ? track?.segments || [] : MaweBoot.DATA.segments;
    let index = Number.isInteger(target?.index) ? target.index : -1;
    if (index < 0) {
      const selected = extension ? selectedExtensionIdxs : selectedIdxs;
      if (selected.size === 1) index = [...selected][0];
      else index = extension ? lastClickedExtensionIdx : lastClickedIdx;
    }
    const neighbor = index + direction;
    if (!segments[index] || !segments[neighbor]) {
      MaweHint.flashHint(direction < 0 ? '前面没有可粘合的字幕' : '后面没有可粘合的字幕', 'warning');
      return false;
    }
    const indices = direction < 0 ? [neighbor, index] : [index, neighbor];
    if (extension) return mergeExtensionSegments(indices, track);
    mergeSegments(indices);
    return true;
  }

  global.MaweMergeAdjacent = Object.freeze({
    mergeAdjacentSubtitle
  });
})(typeof window !== 'undefined' ? window : globalThis);
