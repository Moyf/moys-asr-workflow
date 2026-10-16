

// 真 ESM：wiring 顶层接线（原转换体 phase-1/phase-2 = import 求值）。
'use strict';

import { MaweBoot } from './editor-boot.js';
import { AsrEditorUtils } from '../../shared/editor-utils.js';


window.addEventListener('error', (event) => {
  const details = {
    message: event.message,
    source: event.filename,
    line: event.lineno,
    column: event.colno,
    stack: event.error?.stack || null,
  };
  window.MAWE_DEBUG_ERRORS = [...(window.MAWE_DEBUG_ERRORS || []), details];
  console.error('[MAWE][runtime] uncaught error', details);
});
window.addEventListener('unhandledrejection', (event) => {
  window.MAWE_DEBUG_ERRORS = [...(window.MAWE_DEBUG_ERRORS || []), {
    message: String(event.reason), stack: event.reason?.stack || null,
  }];
  console.error('[MAWE][runtime] unhandled rejection', event.reason);
});
if (!AsrEditorUtils) {
  console.error('[MAWE][boot] AsrEditorUtils is unavailable; editor scripts are incomplete or out of order');
}

export const MULTI_SUBTITLE_UTILS = AsrEditorUtils;
export const EDITOR_SETTINGS_UTILS = AsrEditorUtils;



// 拆分时「下刀时间 vs 实际切分边界」允许的最大偏差：超过说明字幕文本与
// 词时间戳已脱钩、切点落在了错误的词边界附近，此时提示而不是静默出错。
export const SPLIT_ALIGNMENT_DRIFT_WARN_MS = 500;



MaweBoot.maweDomContractCheck();
