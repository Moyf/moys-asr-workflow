// 快捷键共用件：拦截提示、空格拦截与播放速率档位格式化。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweShortcuts 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweShortcuts(global) {
  'use strict';



  function showShortcutBlocked(message) {
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

  global.MaweShortcuts = Object.freeze({
    showShortcutBlocked,
    get interceptedSpace() { return interceptedSpace; },
    set interceptedSpace(v) { interceptedSpace = v; },
    PLAYBACK_RATE_MIN,
    PLAYBACK_RATE_MAX,
    fmtRate
  });
})(typeof window !== 'undefined' ? window : globalThis);
