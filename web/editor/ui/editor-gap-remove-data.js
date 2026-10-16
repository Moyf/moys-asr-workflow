// 真 ESM：模块顶层定义与发布（原转换体 phase-2 语义 = import 求值）。
// window.<Name> 与导出的 <Name> 是同一对象；消费者逐簇改 import 后移除 window 发布。
'use strict';

// 安装时机：模块顶层立即读 window.AsrGapRemoveCore / window.AsrEditorUtils
// （两者由 deferred 转换体在 phase-2 发布），import 期不存在——接线收进
// installGapRemoveData()，首次访问 window.MaweGapRemoveData 时执行。
let current = null;

import { MaweBoot } from "../boot/editor-boot.js";function installGapRemoveData() {
  if (current) return current;
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

return current = Object.freeze({
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

}

export const MaweGapRemoveData = Object.freeze({
  get DEFAULT_GAP_REMOVE_MIN_MS() { return installGapRemoveData().DEFAULT_GAP_REMOVE_MIN_MS; },
  get DEFAULT_GAP_REMOVE_THRESHOLD_DB() { return installGapRemoveData().DEFAULT_GAP_REMOVE_THRESHOLD_DB; },
  get DEFAULT_GAP_REMOVE_HYSTERESIS_DB() { return installGapRemoveData().DEFAULT_GAP_REMOVE_HYSTERESIS_DB; },
  get DEFAULT_GAP_REMOVE_LEAD_IN_MS() { return installGapRemoveData().DEFAULT_GAP_REMOVE_LEAD_IN_MS; },
  get DEFAULT_GAP_REMOVE_LEAD_OUT_MS() { return installGapRemoveData().DEFAULT_GAP_REMOVE_LEAD_OUT_MS; },
  get DEFAULT_GAP_REMOVE_OPERATION_MODE() { return installGapRemoveData().DEFAULT_GAP_REMOVE_OPERATION_MODE; },
  get DEFAULT_GAP_REMOVE_DISABLE_COVERAGE_PERCENT() { return installGapRemoveData().DEFAULT_GAP_REMOVE_DISABLE_COVERAGE_PERCENT; },
  get DEFAULT_GAP_REMOVE_DISABLE_REMAINING_MS() { return installGapRemoveData().DEFAULT_GAP_REMOVE_DISABLE_REMAINING_MS; },
  get GAP_REMOVE_ADVANCED_OPEN_KEY() { return installGapRemoveData().GAP_REMOVE_ADVANCED_OPEN_KEY; },
  get GAP_REMOVE_DISABLE_OPEN_KEY() { return installGapRemoveData().GAP_REMOVE_DISABLE_OPEN_KEY; },
  get normalizedGapRemoveData() { return installGapRemoveData().normalizedGapRemoveData; },
  get clampGapRemoveDisableCoverage() { return installGapRemoveData().clampGapRemoveDisableCoverage; },
  get clampGapRemoveDisableRemaining() { return installGapRemoveData().clampGapRemoveDisableRemaining; },
  getGapRemoveData(...args) { return installGapRemoveData().getGapRemoveData(...args); },
  getGapRemoveGaps(...args) { return installGapRemoveData().getGapRemoveGaps(...args); },
  getRemovedGapRanges(...args) { return installGapRemoveData().getRemovedGapRanges(...args); },
});
Object.defineProperty(window, 'MaweGapRemoveData', { configurable: true, get: () => installGapRemoveData() });
