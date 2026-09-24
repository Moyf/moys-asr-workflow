// 空隙移除数据层：默认参数、规范化缓存与空隙/移除区间派生。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweGapRemoveData 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweGapRemoveData(global) {
  'use strict';



  const DEFAULT_GAP_REMOVE_MIN_MS = 400;


  const DEFAULT_GAP_REMOVE_THRESHOLD_DB = -28;


  const DEFAULT_GAP_REMOVE_HYSTERESIS_DB = 2;


  const DEFAULT_GAP_REMOVE_LEAD_IN_MS = 120;


  const DEFAULT_GAP_REMOVE_LEAD_OUT_MS = 80;


  const DEFAULT_GAP_REMOVE_OPERATION_MODE = window.AsrGapRemoveCore.DEFAULT_GAP_REMOVE_OPERATION_MODE;


  const DEFAULT_GAP_REMOVE_DISABLE_COVERAGE_PERCENT = window.AsrEditorUtils.GAP_REMOVE_DISABLE_COVERAGE_DEFAULT ?? 80;


  const DEFAULT_GAP_REMOVE_DISABLE_REMAINING_MS = window.AsrEditorUtils.GAP_REMOVE_DISABLE_REMAINING_DEFAULT_MS ?? 300;


  const GAP_REMOVE_ADVANCED_OPEN_KEY = 'moy.asr.gap_remove.advanced_open.v1';


  const GAP_REMOVE_DISABLE_OPEN_KEY = 'moy.asr.gap_remove.disable_open.v1';



  const normalizedGapRemoveData = window.AsrEditorUtils.normalizeGapRemoveData;


  const clampGapRemoveDisableCoverage = window.AsrEditorUtils.clampGapRemoveDisableCoverage;


  const clampGapRemoveDisableRemaining = window.AsrEditorUtils.clampGapRemoveDisableRemaining;



  let normalizedGapRemoveReference = null;


  let normalizedGapRemoveCache = null;


  let gapRemoveDisplayCacheState = null;


  let gapRemoveDisplayCacheSource = null;


  let gapRemoveDisplayCache = [];


  let removedGapRangesCacheState = null;


  let removedGapRangesCache = [];



  function getGapRemoveData(create = false) {
    const source = MaweBoot.DATA.gap_remove;
    if (!source && !create) {
      normalizedGapRemoveReference = null;
      normalizedGapRemoveCache = null;
      gapRemoveDisplayCacheState = null;
      gapRemoveDisplayCacheSource = null;
      gapRemoveDisplayCache = [];
      removedGapRangesCacheState = null;
      removedGapRangesCache = [];
      return null;
    }
    if (!source && create) return normalizedGapRemoveData(null);
    if (source !== normalizedGapRemoveReference) {
      normalizedGapRemoveReference = source;
      normalizedGapRemoveCache = normalizedGapRemoveData(source);
      gapRemoveDisplayCacheState = null;
      gapRemoveDisplayCacheSource = null;
      gapRemoveDisplayCache = [];
      removedGapRangesCacheState = null;
      removedGapRangesCache = [];
    }
    return normalizedGapRemoveCache;
  }



  function getGapRemoveGaps() {
    const state = getGapRemoveData(false);
    if (state?.detector !== 'audio_gate') return [];
    if (state === gapRemoveDisplayCacheState
        && state.gaps === gapRemoveDisplayCacheSource) return gapRemoveDisplayCache;
    gapRemoveDisplayCacheState = state;
    gapRemoveDisplayCacheSource = state.gaps;
    gapRemoveDisplayCache = window.AsrGapRemoveCore.getGapRemoveDisplayGaps(state.gaps);
    return gapRemoveDisplayCache;
  }



  function getRemovedGapRanges() {
    const state = getGapRemoveData(false);
    if (!state) return [];
    if (removedGapRangesCacheState !== state) {
      removedGapRangesCacheState = state;
      removedGapRangesCache = window.AsrEditorUtils.getRemovedGapRanges(state.gaps);
    }
    return removedGapRangesCache;
  }

  global.MaweGapRemoveData = Object.freeze({
    DEFAULT_GAP_REMOVE_MIN_MS,
    DEFAULT_GAP_REMOVE_THRESHOLD_DB,
    DEFAULT_GAP_REMOVE_HYSTERESIS_DB,
    DEFAULT_GAP_REMOVE_LEAD_IN_MS,
    DEFAULT_GAP_REMOVE_LEAD_OUT_MS,
    DEFAULT_GAP_REMOVE_OPERATION_MODE,
    DEFAULT_GAP_REMOVE_DISABLE_COVERAGE_PERCENT,
    DEFAULT_GAP_REMOVE_DISABLE_REMAINING_MS,
    GAP_REMOVE_ADVANCED_OPEN_KEY,
    GAP_REMOVE_DISABLE_OPEN_KEY,
    normalizedGapRemoveData,
    clampGapRemoveDisableCoverage,
    clampGapRemoveDisableRemaining,
    get normalizedGapRemoveReference() { return normalizedGapRemoveReference; },
    set normalizedGapRemoveReference(v) { normalizedGapRemoveReference = v; },
    get normalizedGapRemoveCache() { return normalizedGapRemoveCache; },
    set normalizedGapRemoveCache(v) { normalizedGapRemoveCache = v; },
    get gapRemoveDisplayCacheState() { return gapRemoveDisplayCacheState; },
    set gapRemoveDisplayCacheState(v) { gapRemoveDisplayCacheState = v; },
    get gapRemoveDisplayCacheSource() { return gapRemoveDisplayCacheSource; },
    set gapRemoveDisplayCacheSource(v) { gapRemoveDisplayCacheSource = v; },
    get gapRemoveDisplayCache() { return gapRemoveDisplayCache; },
    set gapRemoveDisplayCache(v) { gapRemoveDisplayCache = v; },
    get removedGapRangesCacheState() { return removedGapRangesCacheState; },
    set removedGapRangesCacheState(v) { removedGapRangesCacheState = v; },
    get removedGapRangesCache() { return removedGapRangesCache; },
    set removedGapRangesCache(v) { removedGapRangesCache = v; },
    getGapRemoveData,
    getGapRemoveGaps,
    getRemovedGapRanges
  });
})(typeof window !== 'undefined' ? window : globalThis);
