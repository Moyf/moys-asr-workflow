// 启动数据块：模板注入的工程/表情包/服务器配置 token 与调试工具。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweBoot 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweBoot(global) {
  'use strict';

  const DATA = __DATA_JSON__;


  let FILENAME_BASE = __FILENAME_BASE_JSON__;


  const STICKERS = __STICKERS_JSON__;


  let STICKER_ROOT = __STICKER_ROOT_JSON__;

    // 表情包根目录的绝对路径（无尾斜杠）
  let STICKER_URL_PREFIX = __STICKER_URL_PREFIX_JSON__;


  const SERVER_CONFIG = __SERVER_CONFIG_JSON__;


  const NINJA_SFX_BASE_URL = __NINJA_SFX_BASE_URL_JSON__;



  const MAWE_DEBUG_ENABLED = Boolean(
    SERVER_CONFIG?.debug || new URLSearchParams(window.location.search).has('mawe-debug'),
  );


  function maweDebug(stage, details = {}) {
    if (MAWE_DEBUG_ENABLED) console.debug(`[MAWE][${stage}]`, details);
  }


  function maweDomContractCheck() {
    const requiredIds = [
      'player', 'player-empty', 'cues-container', 'cues-empty', 'filter-over',
      'hide-disabled-toggle', 'waveform-scroll', 'waveform-content',
    ];
    const missing = requiredIds.filter((id) => !document.getElementById(id));
    if (missing.length) {
      console.error('[MAWE][boot] editor DOM contract is incomplete', { missing });
    }
    maweDebug('boot:dom-contract', { checked: requiredIds.length, missing });
    return missing;
  }

  // 导出标题用的工程名：初始取工程名，保存/切工程时随文件名更新（PR #136 评审：
  // 归到 boot 单一所有者，避免 editor.js 全局可变绑定被多模块读写）。
  let PROJECT_NAME = FILENAME_BASE;

  global.MaweBoot = Object.freeze({
    DATA,
    get FILENAME_BASE() { return FILENAME_BASE; },
    set FILENAME_BASE(v) { FILENAME_BASE = v; },
    get PROJECT_NAME() { return PROJECT_NAME; },
    set PROJECT_NAME(v) { PROJECT_NAME = v; },
    STICKERS,
    get STICKER_ROOT() { return STICKER_ROOT; },
    set STICKER_ROOT(v) { STICKER_ROOT = v; },
    get STICKER_URL_PREFIX() { return STICKER_URL_PREFIX; },
    set STICKER_URL_PREFIX(v) { STICKER_URL_PREFIX = v; },
    SERVER_CONFIG,
    NINJA_SFX_BASE_URL,
    MAWE_DEBUG_ENABLED,
    maweDebug,
    maweDomContractCheck
  });
})(typeof window !== 'undefined' ? window : globalThis);
