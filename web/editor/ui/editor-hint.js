// 提示卡系统（flashHint / dismissHintCard）与波形缩放限位提示状态。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweHint 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
export function initMaweHint() {
  'use strict';

  // 装配器无参调用；宿主对象固定为当前页面 window。
  const global = window;



  // === Hint ===
  // 提示卡片堆栈：样式在 editor.css（#hint-stack / .hint-card），位置为本机偏好。
  // 最多同时显示 3 条，新提示追加在下方。
  const HINT_MAX_VISIBLE = 3;


  const HINT_DURATION_MS = 1800;


  const HINT_FADE_OUT_MS = 200;

    // 与 editor.css 的 hint-fade-out 时长一致

  function applyHintPosition(position) {
    const value = ['top-center', 'top-right', 'bottom-right'].includes(position) ? position : 'top-center';
    document.documentElement.dataset.toastPosition = value;
    return value;
  }

  function dismissHintCard(card) {
    if (!card || card.dataset.dismissed) return;
    card.dataset.dismissed = '1';
    card.classList.add('hide');
    setTimeout(() => card.remove(), HINT_FADE_OUT_MS);
  }


  const inlineWarningMessages = new WeakMap();
  const inlineWarningSelector = [
    '[role="alert"]', '.warning', '.ass-frame-warnings',
    '#multi-subtitle-split-error', '#timed-text-edit-single-hint:not([hidden])',
  ].join(', ');

  function revealInlineWarning(element, message = element?.textContent) {
    if (!element) return;
    const value = String(message || '').trim();
    if (!value) {
      inlineWarningMessages.delete(element);
      return;
    }
    if (!element.isConnected || element.hidden || !element.getClientRects().length) return;
    if (inlineWarningMessages.get(element) === value) return;
    const rect = element.getBoundingClientRect();
    let visibleTop = Math.max(0, rect.top);
    let visibleBottom = Math.min(global.innerHeight || 0, rect.bottom);
    for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      const style = global.getComputedStyle(parent);
      if (!/(auto|scroll|hidden|clip)/.test(style.overflowY)) continue;
      const clip = parent.getBoundingClientRect();
      visibleTop = Math.max(visibleTop, clip.top);
      visibleBottom = Math.min(visibleBottom, clip.bottom);
    }
    if (visibleTop <= rect.top + 1 && visibleBottom >= rect.bottom - 1) {
      inlineWarningMessages.set(element, value);
      return;
    }
    inlineWarningMessages.set(element, value);
    const reducedMotion = global.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    element.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center', inline: 'nearest' });
  }

  function installInlineWarningVisibility() {
    if (!document.body || typeof global.MutationObserver !== 'function') return;
    const elementFor = (node) => node?.nodeType === 1 ? node : node?.parentElement;
    const collectClosest = (root, candidates) => {
      const warning = root?.closest?.(inlineWarningSelector);
      if (warning) candidates.add(warning);
    };
    const collectSubtree = (root, candidates) => {
      collectClosest(root, candidates);
      root?.querySelectorAll?.(inlineWarningSelector).forEach((element) => candidates.add(element));
    };
    const observer = new global.MutationObserver((records) => {
      const targets = new Set();
      const subtrees = new Set();
      const candidates = new Set();
      records.forEach((record) => {
        const target = elementFor(record.target);
        if (target) targets.add(target);
        // Insertion changes the target warning's text, but does not require a
        // traversal of its completed parent list for every appended row.
        if (record.type === 'attributes' && target) subtrees.add(target);
        record.addedNodes?.forEach((node) => {
          const root = elementFor(node);
          if (root) subtrees.add(root);
        });
      });
      targets.forEach((root) => collectClosest(root, candidates));
      subtrees.forEach((root) => {
        // A newly inserted/changed ancestor already covers nested records.
        for (let parent = root.parentElement; parent; parent = parent.parentElement) {
          if (subtrees.has(parent)) return;
        }
        collectSubtree(root, candidates);
      });
      candidates.forEach((element) => revealInlineWarning(element));
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'hidden', 'role'],
    });
    const initial = new Set();
    collectSubtree(document.body, initial);
    initial.forEach((element) => revealInlineWarning(element));
  }

  installInlineWarningVisibility();



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
    // type → 语义类：default 中性 / success 成功 / info 信息 / invalid 不可用提醒 / warning 失败。
    // 仅在有效类型时追加类名，default 维持原 .hint-card 中性外观。
    const typeClass = type === 'success' ? 'hint-success'
      : type === 'info' ? 'hint-info'
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
    applyHintPosition,
    flashHint,
    revealInlineWarning,
    get lastScaleLimitMsg() { return lastScaleLimitMsg; },
    set lastScaleLimitMsg(v) { lastScaleLimitMsg = v; },
    get lastScaleLimitAt() { return lastScaleLimitAt; },
    set lastScaleLimitAt(v) { lastScaleLimitAt = v; }
  });
}
