import { freezeFacade } from '../state/editor-facade-utils.js';
// 真 ESM：模块顶层定义与发布（原转换体 phase-2 语义 = import 求值）。
// window.<Name> 与导出的 <Name> 是同一对象；消费者逐簇改 import 后移除 window 发布。
'use strict';

/** @type {ProjectData} */
const DATA = __DATA_JSON__;

/** @type {string} */
let FILENAME_BASE = __FILENAME_BASE_JSON__;

const STICKERS = __STICKERS_JSON__;

/** @type {string} */
let STICKER_ROOT = __STICKER_ROOT_JSON__;

  // 表情包根目录的绝对路径（无尾斜杠）
/** @type {string} */
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
/** @type {string} */
let PROJECT_NAME = FILENAME_BASE;

window.MaweBoot = Object.freeze({
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

export const MaweBoot = freezeFacade({
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
  }, ["FILENAME_BASE", "PROJECT_NAME", "STICKER_ROOT", "STICKER_URL_PREFIX"]);
window.MaweBoot = MaweBoot;

// 供已迁移消费者经 import 写根目录（冻结门面在 TS 下访问器只读，
// 写入统一走具名 setter；语义与 facade set STICKER_ROOT 一致）。
export function setStickerRoot(value) { STICKER_ROOT = value; }
