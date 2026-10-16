import { freezeFacade } from '../state/editor-facade-utils.js';
// 真 ESM：模块顶层定义与发布（原转换体 phase-2 语义 = import 求值）。
// window.<Name> 与导出的 <Name> 是同一对象；消费者逐簇改 import 后移除 window 发布。
'use strict';



import { MaweHint } from "../ui/editor-hint.js";function showShortcutBlocked(message) {
  MaweHint.flashHint(message, 'invalid');
}

// 空格播放/暂停。捕获阶段先于原生媒体控件处理，避免控件获得焦点后执行默认行为。
let interceptedSpace = false;

// J/K/L 播放控制的两种模式：旧模式是慢速/重置/倍速；新模式是倒放/停止/1×播放。
// HTML5 playbackRate 多数浏览器钳在 [0.0625, 16]，反向播放由时间轴驱动。
const PLAYBACK_RATE_MIN = 0.0625;

const PLAYBACK_RATE_MAX = 16;

function fmtRate(r) {
  // 保留必要小数位：0.5/2/4 不带小数；0.25/0.0625 带
  if (Number.isInteger(r)) return r + '×';
  // 去掉尾部 0
  return r.toFixed(4).replace(/0+$/, '').replace(/\.$/, '') + '×';
}

window.MaweShortcuts = Object.freeze({
  showShortcutBlocked,
  get interceptedSpace() { return interceptedSpace; },
  set interceptedSpace(v) { interceptedSpace = v; },
  PLAYBACK_RATE_MIN,
  PLAYBACK_RATE_MAX,
  fmtRate
});

export const MaweShortcuts = freezeFacade({
    showShortcutBlocked,
    get interceptedSpace() { return interceptedSpace; },
    set interceptedSpace(v) { interceptedSpace = v; },
    PLAYBACK_RATE_MIN,
    PLAYBACK_RATE_MAX,
    fmtRate
  }, ["interceptedSpace"]);
window.MaweShortcuts = MaweShortcuts;
