// 提示卡系统（flashHint / dismissHintCard）与波形缩放限位提示状态。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweHint 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweHint(global) {
  'use strict';



  // === Hint ===
  // 右上角提示卡片堆栈：样式在 editor.css（#hint-stack / .hint-card）。
  // 最多同时显示 3 条，新提示追加在下方。
  const HINT_MAX_VISIBLE = 3;


  const HINT_DURATION_MS = 1800;


  const HINT_FADE_OUT_MS = 200;

    // 与 editor.css 的 hint-fade-out 时长一致

  function dismissHintCard(card) {
    if (!card || card.dataset.dismissed) return;
    card.dataset.dismissed = '1';
    card.classList.add('hide');
    setTimeout(() => card.remove(), HINT_FADE_OUT_MS);
  }



  function flashHint(msg, type = 'default', options = {}) {
    let stack = document.getElementById('hint-stack');
    if (!stack) {
      stack = document.createElement('div'); stack.id = 'hint-stack';
      document.body.appendChild(stack);
    }
    // 先挤掉最早的再插入新卡片：溢出项立即移除（不走退场动画），
    // 保证视觉上始终最多 3 条，不会出现第 4 条先闪现再挤出的跳动。
    while (stack.children.length >= HINT_MAX_VISIBLE) {
      const oldest = stack.firstElementChild;
      oldest.dataset.dismissed = '1';  // 让其到期定时器空转
      oldest.remove();
    }
    const card = document.createElement('div');
    // type → 语义类：default 中性 / success 成功 / invalid 不可用提醒 / warning 失败。
    // 仅在有效类型时追加类名，default 维持原 .hint-card 中性外观。
    const typeClass = type === 'success' ? 'hint-success'
      : type === 'invalid' ? 'hint-invalid'
      : type === 'warning' ? 'hint-warning' : '';
    card.className = typeClass ? `hint-card ${typeClass}` : 'hint-card';
    if (typeof options.contentBuilder === 'function') options.contentBuilder(card);
    else card.textContent = msg;
    stack.appendChild(card);
    const durationMs = Number.isFinite(options.durationMs) ? options.durationMs : HINT_DURATION_MS;
    if (durationMs > 0) setTimeout(() => dismissHintCard(card), durationMs);
    return card;
  }



  // 振幅到达上下限时由波形模块派发的事件：rAF 节流后仍可能每帧触发，冷却避免提示闪烁
  let lastScaleLimitMsg = '';


  let lastScaleLimitAt = 0;

  global.MaweHint = Object.freeze({
    HINT_MAX_VISIBLE,
    HINT_DURATION_MS,
    HINT_FADE_OUT_MS,
    dismissHintCard,
    flashHint,
    get lastScaleLimitMsg() { return lastScaleLimitMsg; },
    set lastScaleLimitMsg(v) { lastScaleLimitMsg = v; },
    get lastScaleLimitAt() { return lastScaleLimitAt; },
    set lastScaleLimitAt(v) { lastScaleLimitAt = v; }
  });
})(typeof window !== 'undefined' ? window : globalThis);
