// 非模态浮层前置栈：层级管理、激活绑定与通用浮动面板工厂（settings-panels 加载期依赖）。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweFloatingPanel 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweFloatingPanel(global) {
  'use strict';



  // 所有非模态浮层共用一个前置栈：最后点击、打开或获得焦点的浮层排在最上面。
  // 起始值高于普通设置弹窗（420），但低于拖拽遮罩和加载层（500/510）。
  const FLOATING_SURFACE_Z_INDEX_BASE = 430;


  const floatingSurfaceStack = [];


  const floatingSurfaceRoots = new WeakSet();


  const floatingSurfaceActivationTargets = new WeakSet();



  function floatingSurfaceRoot(surface) {
    if (!surface) return null;
    const windowRoot = surface.closest('.editor-settings-window, .gap-remove-panel');
    if (windowRoot) return windowRoot;
    return surface.parentElement?.closest('.toolbar .dropdown') || surface;
  }



  function floatingSurfaceIsOpen(surface) {
    if (!surface) return false;
    if (surface.matches('.settings-panel')) return !surface.hidden;
    if (surface.matches('.dropdown')) return surface.classList.contains('open');
    return surface.classList.contains('show');
  }



  function syncFloatingSurfaceLayers() {
    floatingSurfaceStack.forEach((surface, index) => {
      const zIndex = FLOATING_SURFACE_Z_INDEX_BASE + index;
      surface.style.zIndex = String(zIndex);
    });
  }



  function bringFloatingSurfaceToFront(surface) {
    const root = floatingSurfaceRoot(surface);
    if (!root || !floatingSurfaceRoots.has(root)) return;
    const currentIndex = floatingSurfaceStack.indexOf(root);
    if (currentIndex >= 0) floatingSurfaceStack.splice(currentIndex, 1);
    floatingSurfaceStack.push(root);
    syncFloatingSurfaceLayers();
  }



  function bindFloatingSurfaceActivation(surface) {
    const root = floatingSurfaceRoot(surface);
    if (!root) return;
    if (!floatingSurfaceRoots.has(root)) {
      floatingSurfaceRoots.add(root);
      floatingSurfaceStack.push(root);
    }
    if (floatingSurfaceActivationTargets.has(surface)) return;
    const activate = () => bringFloatingSurfaceToFront(root);
    surface.addEventListener('pointerdown', activate, true);
    surface.addEventListener('focusin', activate, true);
    floatingSurfaceActivationTargets.add(surface);
  }



  // 可拖动非模态工具窗（移除静音空隙 / 拼合字幕共用模式）：
  // 负责显示/隐藏、工具栏按钮 active 态、标题栏拖动与位置持久化、窗口缩放回钳、Esc 关闭。
  function createFloatingPanel({ panel, dragHandle, manageButton, anchorButton, positionKey, onOpen }) {
    if (!panel) return { open() {}, close() {}, toggle() {}, isOpen: () => false };
    bindFloatingSurfaceActivation(panel);
    let drag = null;

    function isOpen() { return panel.classList.contains('show'); }

    function setPosition(left, top, { persist = false } = {}) {
      const rect = panel.getBoundingClientRect();
      const margin = 6;
      const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
      const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
      const nextLeft = Math.min(maxLeft, Math.max(margin, Math.round(left)));
      const nextTop = Math.min(maxTop, Math.max(margin, Math.round(top)));
      panel.style.left = `${nextLeft}px`;
      panel.style.top = `${nextTop}px`;
      panel.style.right = 'auto';
      if (persist) {
        try {
          localStorage.setItem(positionKey, JSON.stringify({ left: nextLeft, top: nextTop }));
        } catch (_) {
          // file:// 隐私模式可能拒绝 localStorage；拖动本身仍保持可用。
        }
      }
    }

    function restorePosition() {
      let saved = null;
      try {
        saved = JSON.parse(localStorage.getItem(positionKey) || 'null');
      } catch (_) {
        saved = null;
      }
      if (Number.isFinite(saved?.left) && Number.isFinite(saved?.top)) {
        setPosition(saved.left, saved.top);
        return true;
      }
      return false;
    }

    function positionNearAnchor() {
      if (!anchorButton) return false;
      const anchorRect = anchorButton.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const margin = 6;
      const gap = 6;
      let left = anchorRect.left;
      if (left + panelRect.width > window.innerWidth - margin) {
        left = anchorRect.right - panelRect.width;
      }
      let top = anchorRect.bottom + gap;
      if (top + panelRect.height > window.innerHeight - margin) {
        top = anchorRect.top - panelRect.height - gap;
      }
      setPosition(left, top);
      return true;
    }

    function open() {
      if (typeof onOpen === 'function') onOpen();
      panel.classList.add('show');
      panel.setAttribute('aria-hidden', 'false');
      bringFloatingSurfaceToFront(panel);
      manageButton?.classList.add('active');
      manageButton?.setAttribute('aria-expanded', 'true');
      requestAnimationFrame(() => {
        if (!restorePosition()) positionNearAnchor();
      });
    }

    function close() {
      panel.classList.remove('show', 'dragging');
      panel.setAttribute('aria-hidden', 'true');
      drag = null;
      manageButton?.classList.remove('active');
      manageButton?.setAttribute('aria-expanded', 'false');
      syncFloatingSurfaceLayers();
    }

    function toggle() { if (isOpen()) close(); else open(); }

    function finishDrag(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      try {
        dragHandle?.releasePointerCapture?.(event.pointerId);
      } catch (_) {
        // 指针在浏览器窗口外释放时，capture 可能已由浏览器自动清理。
      }
      drag = null;
      panel.classList.remove('dragging');
      const rect = panel.getBoundingClientRect();
      setPosition(rect.left, rect.top, { persist: true });
    }

    dragHandle?.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('button')) return;
      const rect = panel.getBoundingClientRect();
      drag = {
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
      };
      panel.classList.add('dragging');
      dragHandle.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });
    dragHandle?.addEventListener('pointermove', (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      event.preventDefault();
      setPosition(event.clientX - drag.offsetX, event.clientY - drag.offsetY);
    });
    dragHandle?.addEventListener('pointerup', finishDrag);
    dragHandle?.addEventListener('pointercancel', finishDrag);
    manageButton?.addEventListener('click', toggle);
    window.addEventListener('resize', () => {
      if (!isOpen()) return;
      const rect = panel.getBoundingClientRect();
      setPosition(rect.left, rect.top, { persist: true });
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !isOpen() || editingState) return;
      event.preventDefault();
      close();
    });
    return { open, close, toggle, isOpen };
  }

  global.MaweFloatingPanel = Object.freeze({
    FLOATING_SURFACE_Z_INDEX_BASE,
    floatingSurfaceStack,
    floatingSurfaceRoots,
    floatingSurfaceActivationTargets,
    floatingSurfaceRoot,
    floatingSurfaceIsOpen,
    syncFloatingSurfaceLayers,
    bringFloatingSurfaceToFront,
    bindFloatingSurfaceActivation,
    createFloatingPanel
  });
})(typeof window !== 'undefined' ? window : globalThis);
