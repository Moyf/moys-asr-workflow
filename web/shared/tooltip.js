// 共享悬停 tooltip：接管原生 title 属性，替换为跟随明暗主题的自定义气泡。
// 编辑器（esbuild bundle）与 Launcher（classic script 引用）共用同一份实现；
// 样式位于 editor.css / launcher.css 末尾的 .mawe-tooltip 规则，只使用设计令牌。
//
// 设计要点：
// - 事件委托监听 pointerover/pointerout，现有 250+ 处 title 零改动自动升级；
// - 悬停达阈值时摘下 title（抑制原生气泡），离开时原样放回；
// - 摘下期间外部代码改写 title（i18n 翻译、波形模块动态提示）会被吸收，
//   离开时放回最新值；
// - 空间不足时按 下 → 上 → 右 → 左 顺序换位，箭头随位置翻转。
(function initMaweTooltip(global) {
  'use strict';

  const ATTACH_SELECTOR = '[title]:not(iframe):not(object):not(embed)';
  const FORCE_NATIVE_SELECTOR = '[data-tooltip-force-native]';
  const SHOW_DELAY_MS = 350;
  const HIDE_DELAY_MS = 80;
  const EDGE_GAP = 8;
  const ARROW_OFFSET = 9;
  const ARROW_BOX = 14;  // 箭头包围盒（内含 10px 旋转方块）
  const ARROW_LEN = 7;   // 三角凸出气泡边缘的长度

  let root = null;
  let bubble = null;
  let arrow = null;
  let target = null;
  let showTimer = 0;
  let hideTimer = 0;
  let detached = null; // { element, title } 悬停期间摘下的 title
  let titleWatcher = null;

  function ensureDom() {
    if (root) return;
    root = document.createElement('div');
    root.className = 'mawe-tooltip';
    root.setAttribute('role', 'tooltip');
    root.setAttribute('aria-hidden', 'true');
    bubble = document.createElement('div');
    bubble.className = 'mawe-tooltip-text';
    arrow = document.createElement('div');
    arrow.className = 'mawe-tooltip-arrow';
    root.appendChild(bubble);
    root.appendChild(arrow);
    document.body.appendChild(root);
    titleWatcher = new MutationObserver((records) => {
      if (!detached) return;
      records.forEach((record) => {
        if (record.target !== detached.element) return;
        if (!record.target.hasAttribute('title')) return; // 自己的摘除动作
        // 摘下期间被外部改写：吸收新值，继续保持抑制。
        detached.title = record.target.getAttribute('title') || '';
        record.target.removeAttribute('title');
      });
    });
  }

  const px = (value) => `${Math.round(value)}px`;

  function clampAxis(value, viewport, size) {
    return Math.max(EDGE_GAP, Math.min(value, viewport - size - EDGE_GAP));
  }

  // 箭头贴着气泡边缘滑动时，保证始终压在气泡上（各留 8px 边距）。
  function clampArrowAlong(value, bubbleStart, bubbleSize) {
    const min = bubbleStart + 8 + ARROW_BOX / 2;
    const max = bubbleStart + bubbleSize - 8 - ARROW_BOX / 2;
    if (min > max) return bubbleStart + bubbleSize / 2;
    return Math.max(min, Math.min(value, max));
  }

  // 箭头包围盒居中钉在气泡边缘线上，::before 里的旋转方块负责画出三角。
  function placeArrow(placementKey, edgeCenterX, edgeCenterY) {
    arrow.className = 'mawe-tooltip-arrow';
    arrow.classList.add(placementKey);
    arrow.style.left = px(edgeCenterX - ARROW_BOX / 2);
    arrow.style.top = px(edgeCenterY - ARROW_BOX / 2);
  }

  // 依次尝试 下、上、右、左；都放不下就选剩余空间最大的方向。
  function placement() {
    const rect = target.getBoundingClientRect();
    const viewportW = document.documentElement.clientWidth;
    const viewportH = document.documentElement.clientHeight;
    // 先归零再测量：fixed 元素的 shrink-to-fit 依赖当前 left/top，
    // 若沿用上一次的贴边位置，长文本会被压成竖条（实测 34px 宽 × 1371px 高）。
    bubble.style.left = '0px';
    bubble.style.top = '0px';
    bubble.style.maxWidth = `${Math.min(320, viewportW - EDGE_GAP * 2)}px`;
    const size = { w: bubble.offsetWidth, h: bubble.offsetHeight };
    const room = {
      below: viewportH - rect.bottom,
      above: rect.top,
      right: viewportW - rect.right,
      left: rect.left,
    };
    const mainNeed = size.h + ARROW_OFFSET + EDGE_GAP;
    const sideNeed = size.w + ARROW_OFFSET + EDGE_GAP;
    let chosen = [
      { key: 'below', ok: room.below >= mainNeed },
      { key: 'above', ok: room.above >= mainNeed },
      { key: 'right', ok: room.right >= sideNeed },
      { key: 'left', ok: room.left >= sideNeed },
    ].find((item) => item.ok);
    if (!chosen) {
      chosen = ['below', 'above', 'right', 'left']
        .map((key) => ({ key, room: room[key] }))
        .sort((a, b) => b.room - a.room)[0];
    }
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    let bubbleX = 0;
    let bubbleY = 0;
    if (chosen.key === 'below') {
      bubbleX = clampAxis(centerX - size.w / 2, viewportW, size.w);
      bubbleY = rect.bottom + ARROW_OFFSET;
      // 箭头中心向气泡内侧偏 1px：让三角填充盖住接缝处的气泡边框线。
      placeArrow('below', clampArrowAlong(centerX, bubbleX, size.w), bubbleY + 1);
    } else if (chosen.key === 'above') {
      bubbleX = clampAxis(centerX - size.w / 2, viewportW, size.w);
      bubbleY = rect.top - ARROW_OFFSET - size.h;
      placeArrow('above', clampArrowAlong(centerX, bubbleX, size.w), bubbleY + size.h - 1);
    } else if (chosen.key === 'right') {
      bubbleX = Math.min(rect.right + ARROW_OFFSET, viewportW - size.w - EDGE_GAP);
      bubbleY = clampAxis(centerY - size.h / 2, viewportH, size.h);
      placeArrow('right', bubbleX + 1, clampArrowAlong(centerY, bubbleY, size.h));
    } else {
      bubbleX = Math.max(EDGE_GAP, rect.left - ARROW_OFFSET - size.w);
      bubbleY = clampAxis(centerY - size.h / 2, viewportH, size.h);
      placeArrow('left', bubbleX + size.w - 1, clampArrowAlong(centerY, bubbleY, size.h));
    }
    bubble.style.left = px(bubbleX);
    bubble.style.top = px(bubbleY);
  }

  function currentTitleText(element) {
    if (detached && detached.element === element) return detached.title;
    return element.getAttribute('title') || '';
  }

  function detachTitle(element) {
    detached = { element, title: element.getAttribute('title') || '' };
    element.removeAttribute('title');
    titleWatcher.observe(element, { attributes: true, attributeFilter: ['title'] });
  }

  function restoreTitle() {
    if (!detached) return;
    const { element, title } = detached;
    detached = null;
    if (element.isConnected && title) element.setAttribute('title', title);
  }

  function hideNow() {
    global.clearTimeout(showTimer);
    showTimer = 0;
    global.clearTimeout(hideTimer);
    hideTimer = 0;
    if (detached) {
      if (titleWatcher) titleWatcher.disconnect();
      restoreTitle();
    }
    target = null;
    if (root) root.classList.remove('show');
  }

  function show(element) {
    const text = currentTitleText(element);
    target = null;
    if (!text) return;
    // ensureDom 必须先于 detachTitle：它负责创建 titleWatcher，
    // 否则首次显示时 detachTitle 里的 observe 会抛 null。
    ensureDom();
    target = element;
    detachTitle(element);
    bubble.textContent = text;
    placement();
    root.classList.add('show');
  }

  function hoverElement(event) {
    if (event.pointerType === 'touch') return null;
    const element = event.target.closest ? event.target.closest(ATTACH_SELECTOR) : null;
    if (!element || element.matches(FORCE_NATIVE_SELECTOR)) return null;
    // SVG 内部的 title 走浏览器原生提示，不抢。
    if (element.namespaceURI && element.namespaceURI.includes('svg')) return null;
    return element;
  }

  function onPointerOver(event) {
    const element = hoverElement(event);
    if (!element) return;
    if (hideTimer) {
      global.clearTimeout(hideTimer);
      hideTimer = 0;
    }
    if (element === target) return; // 在同一目标的子元素间移动
    hideNow();
    if (showTimer) return;
    showTimer = global.setTimeout(() => {
      showTimer = 0;
      show(element);
    }, SHOW_DELAY_MS);
  }

  function onPointerOut(event) {
    if (event.pointerType === 'touch') return;
    if (!target || hideTimer) return;
    hideTimer = global.setTimeout(() => {
      hideTimer = 0;
      hideNow();
    }, HIDE_DELAY_MS);
  }

  function start() {
    if (document.documentElement.dataset.maweTooltipReady === 'true') return;
    document.documentElement.dataset.maweTooltipReady = 'true';
    document.addEventListener('pointerover', onPointerOver, true);
    document.addEventListener('pointerout', onPointerOut, true);
    // scroll 不冒泡：capture 才能覆盖内部滚动容器；位置失效立即收起。
    document.addEventListener('scroll', hideNow, true);
    global.addEventListener('resize', hideNow);
    global.addEventListener('blur', hideNow);
  }

  global.MaweTooltip = Object.freeze({ start, hide: hideNow });
})(window);

window.MaweTooltip.start();
