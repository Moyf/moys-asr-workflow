// 导出菜单：工具栏导出下拉与批量操作菜单定位。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweExportMenus 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweExportMenus(global) {
  'use strict';



  // === 工具栏导出下拉菜单 ===
  const SUBMENU_CLOSE_DELAY_MS = 160;


  const SUBMENU_AIM_TOLERANCE_PX = 8;



  function bindToolbarExportDropdown(dropdownId, buttonId, menuId, positioner = null) {
    const dd = document.getElementById(dropdownId);
    const btn = document.getElementById(buttonId);
    const menu = document.getElementById(menuId);
    if (!dd || !btn || !menu) return;
    const submenuWrappers = [...menu.children].filter((item) => item.classList.contains('dropdown-submenu'));
    const submenuCloseTimers = new WeakMap();
    let pendingSubmenuSwitch = null;
    let lastPointerPoint = null;
    let previousPointerPoint = null;
    let lastPointInsideOpenWrapper = null;
    const directItems = (container) => [...container.children].flatMap((child) => {
      if (child.classList.contains('dropdown-item')) {
        return child.classList.contains('disabled') || child.hidden ? [] : [child];
      }
      if (!child.classList.contains('dropdown-submenu')) return [];
      const toggle = child.querySelector(':scope > .dropdown-submenu-toggle');
      return toggle && !toggle.classList.contains('disabled') && !toggle.hidden ? [toggle] : [];
    });
    const pointerPoint = (event) => {
      if (!event || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return null;
      return { x: event.clientX, y: event.clientY };
    };
    const clearPendingSubmenuSwitch = () => {
      if (!pendingSubmenuSwitch) return;
      clearTimeout(pendingSubmenuSwitch.timer);
      pendingSubmenuSwitch = null;
    };
    const openSubmenu = () => submenuWrappers.find((wrapper) => wrapper.classList.contains('open'));
    const pointInTriangle = (point, a, b, c) => {
      const sign = (p1, p2, p3) => (
        (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y)
      );
      const first = sign(point, a, b);
      const second = sign(point, b, c);
      const third = sign(point, c, a);
      const hasNegative = first < 0 || second < 0 || third < 0;
      const hasPositive = first > 0 || second > 0 || third > 0;
      return !(hasNegative && hasPositive);
    };
    const shouldDelaySubmenuSwitch = (wrapper, point, previousPoint) => {
      const active = openSubmenu();
      const apex = previousPoint || lastPointInsideOpenWrapper;
      if (!active || active === wrapper || !point || !apex) return false;
      const submenu = active.querySelector(':scope > .dropdown-submenu-menu');
      if (!submenu) return false;
      const activeRect = active.getBoundingClientRect();
      const submenuRect = submenu.getBoundingClientRect();
      const opensLeft = submenuRect.right <= activeRect.left + SUBMENU_AIM_TOLERANCE_PX;
      const opensRight = submenuRect.left >= activeRect.right - SUBMENU_AIM_TOLERANCE_PX;
      if (!opensLeft && !opensRight) return false;
      const direction = opensLeft ? -1 : 1;
      if ((direction < 0 && point.x > apex.x + SUBMENU_AIM_TOLERANCE_PX)
        || (direction > 0 && point.x < apex.x - SUBMENU_AIM_TOLERANCE_PX)) return false;
      const edgeX = direction < 0 ? submenuRect.right : submenuRect.left;
      return pointInTriangle(
        point,
        apex,
        { x: edgeX, y: submenuRect.top - SUBMENU_AIM_TOLERANCE_PX },
        { x: edgeX, y: submenuRect.bottom + SUBMENU_AIM_TOLERANCE_PX },
      );
    };
    const clearSubmenuClose = (wrapper) => {
      const timer = submenuCloseTimers.get(wrapper);
      if (timer) {
        clearTimeout(timer);
        submenuCloseTimers.delete(wrapper);
      }
    };
    const closeSubmenu = (wrapper) => {
      clearSubmenuClose(wrapper);
      if (wrapper.classList.contains('open')) lastPointInsideOpenWrapper = null;
      wrapper.classList.remove('open');
      wrapper.querySelector(':scope > .dropdown-submenu-toggle')
        ?.setAttribute('aria-expanded', 'false');
    };
    const closeSubmenus = () => {
      submenuWrappers.forEach(closeSubmenu);
    };
    const scheduleSubmenuSwitch = (wrapper) => {
      // menu-aim：鼠标进入同级菜单项时，沿当前子菜单近侧边缘的三角通道移动，先保留当前菜单。
      clearPendingSubmenuSwitch();
      const active = openSubmenu();
      if (active && active !== wrapper) clearSubmenuClose(active);
      const timer = setTimeout(() => {
        if (!pendingSubmenuSwitch || pendingSubmenuSwitch.wrapper !== wrapper) return;
        pendingSubmenuSwitch = null;
        if (wrapper.matches(':hover') || wrapper.contains(document.activeElement)) {
          setSubmenuOpen(wrapper, true);
        }
      }, SUBMENU_CLOSE_DELAY_MS);
      pendingSubmenuSwitch = { wrapper, timer };
    };
    const setSubmenuOpen = (wrapper, open, focusFirst = false) => {
      if (!wrapper) return;
      const toggle = wrapper.querySelector(':scope > .dropdown-submenu-toggle');
      const submenu = wrapper.querySelector(':scope > .dropdown-submenu-menu');
      if (!toggle || !submenu) return;
      clearSubmenuClose(wrapper);
      if (open) {
        clearPendingSubmenuSwitch();
        submenuWrappers.forEach((other) => {
          if (other !== wrapper) closeSubmenu(other);
        });
      }
      wrapper.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open && focusFirst) directItems(submenu)[0]?.focus();
    };
    const scheduleSubmenuClose = (wrapper) => {
      clearSubmenuClose(wrapper);
      const timer = setTimeout(() => {
        submenuCloseTimers.delete(wrapper);
        if (!wrapper.matches(':hover') && !wrapper.contains(document.activeElement)) {
          closeSubmenu(wrapper);
        }
      }, SUBMENU_CLOSE_DELAY_MS);
      submenuCloseTimers.set(wrapper, timer);
    };
    const setOpen = (open, { restoreFocus = false } = {}) => {
      dd.classList.toggle('open', open);
      if (btn.hasAttribute('aria-expanded')) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (!open) {
        closeSubmenus();
        lastPointerPoint = null;
        previousPointerPoint = null;
        lastPointInsideOpenWrapper = null;
      }
      if (open) MaweFloatingPanel.bringFloatingSurfaceToFront(dd);
      else MaweFloatingPanel.syncFloatingSurfaceLayers();
      if (open && positioner) requestAnimationFrame(positioner);
      if (!open && restoreFocus) btn.focus();
    };
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.toolbar .dropdown.open').forEach((other) => {
        if (other !== dd) {
          other.classList.remove('open');
          other.querySelector('button[aria-expanded]')?.setAttribute('aria-expanded', 'false');
          other.querySelectorAll('.dropdown-submenu').forEach((submenu) => {
            submenu.classList.remove('open');
            submenu.querySelector('.dropdown-submenu-toggle')?.setAttribute('aria-expanded', 'false');
          });
        }
      });
      setOpen(!dd.classList.contains('open'));
    });
    btn.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      setOpen(true);
      const items = directItems(menu);
      items[e.key === 'ArrowDown' ? 0 : items.length - 1]?.focus();
    });
    submenuWrappers.forEach((wrapper) => {
      const submenu = wrapper.querySelector(':scope > .dropdown-submenu-menu');
      const keepOpen = (event) => {
        const point = pointerPoint(event);
        const sameAsLastPoint = point && lastPointerPoint
          && point.x === lastPointerPoint.x && point.y === lastPointerPoint.y;
        const previousPoint = point
          ? (sameAsLastPoint ? previousPointerPoint : lastPointerPoint)
          : null;
        if (point && !sameAsLastPoint) previousPointerPoint = lastPointerPoint;
        if (point) lastPointerPoint = point;
        if (point && shouldDelaySubmenuSwitch(wrapper, point, previousPoint)) {
          scheduleSubmenuSwitch(wrapper);
          return;
        }
        setSubmenuOpen(wrapper, true);
        if (point) lastPointInsideOpenWrapper = point;
      };
      const deferClose = (event) => {
        if (pendingSubmenuSwitch?.wrapper === wrapper
          && (!event?.relatedTarget || !wrapper.contains(event.relatedTarget))) {
          clearPendingSubmenuSwitch();
          const active = openSubmenu();
          if (active && active !== wrapper) scheduleSubmenuClose(active);
        }
        scheduleSubmenuClose(wrapper);
      };
      wrapper.addEventListener('pointerenter', keepOpen);
      wrapper.addEventListener('pointerleave', deferClose);
      wrapper.addEventListener('focusin', keepOpen);
      wrapper.addEventListener('focusout', (e) => {
        if (!e.relatedTarget || !wrapper.contains(e.relatedTarget)) deferClose();
      });
      submenu?.addEventListener('pointerenter', keepOpen);
      submenu?.addEventListener('pointerleave', deferClose);
    });
    menu.addEventListener('pointermove', (event) => {
      const point = pointerPoint(event);
      if (!point) return;
      if (!lastPointerPoint || point.x !== lastPointerPoint.x || point.y !== lastPointerPoint.y) {
        previousPointerPoint = lastPointerPoint;
      }
      lastPointerPoint = point;
      const active = openSubmenu();
      if (active?.contains(event.target)) lastPointInsideOpenWrapper = point;
    });
    menu.addEventListener('click', (e) => {
      const item = e.target.closest('.dropdown-item');
      if (!item || !menu.contains(item)) return;
      if (item.classList.contains('dropdown-submenu-toggle')) {
        e.stopPropagation();
        const wrapper = item.closest('.dropdown-submenu');
        setSubmenuOpen(wrapper, !wrapper.classList.contains('open'));
        return;
      }
      setOpen(false);
    });
    menu.addEventListener('keydown', (e) => {
      const item = e.target.closest('.dropdown-item');
      if (!item || !menu.contains(item)) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false, { restoreFocus: true });
        return;
      }
      const submenuWrapper = item.closest('.dropdown-submenu');
      const submenu = submenuWrapper?.querySelector(':scope > .dropdown-submenu-menu');
      if (e.key === 'ArrowRight' && item.classList.contains('dropdown-submenu-toggle')) {
        e.preventDefault();
        setSubmenuOpen(submenuWrapper, true, true);
        return;
      }
      if (e.key === 'ArrowLeft' && submenuWrapper && !item.classList.contains('dropdown-submenu-toggle')) {
        e.preventDefault();
        setSubmenuOpen(submenuWrapper, false);
        submenuWrapper.querySelector(':scope > .dropdown-submenu-toggle')?.focus();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const container = submenu && submenu.contains(item) ? submenu : menu;
        const items = directItems(container);
        const index = items.indexOf(item);
        if (index < 0 || !items.length) return;
        const offset = e.key === 'ArrowDown' ? 1 : -1;
        items[(index + offset + items.length) % items.length].focus();
        return;
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        item.click();
        if (!item.classList.contains('dropdown-submenu-toggle')) btn.focus();
      }
    });
    document.addEventListener('click', (e) => {
      if (!dd.contains(e.target)) setOpen(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && dd.classList.contains('open')) {
        e.preventDefault();
        setOpen(false, { restoreFocus: true });
      }
    });
    if (positioner) {
      window.addEventListener('resize', positioner);
      window.addEventListener('scroll', positioner, true);
      dd.closest('.cue-list-toolbar, .toolbar')?.addEventListener('scroll', positioner);
    }
  }


  function positionBatchOperationsMenu() {
    const dropdown = document.getElementById('batch-operations-dropdown');
    const button = document.getElementById('batch-operations-btn');
    const menu = document.getElementById('batch-operations-menu');
    if (!dropdown?.classList.contains('open') || !button || !menu) return;
    const buttonRect = button.getBoundingClientRect();
    const menuWidth = menu.offsetWidth;
    const menuHeight = menu.offsetHeight;
    const margin = 8;
    const left = Math.min(
      Math.max(margin, buttonRect.left),
      Math.max(margin, window.innerWidth - menuWidth - margin),
    );
    const belowTop = buttonRect.bottom + 6;
    const aboveTop = buttonRect.top - menuHeight - 6;
    let top = belowTop;
    if (belowTop + menuHeight > window.innerHeight - margin && aboveTop >= margin) {
      top = aboveTop;
    } else if (belowTop + menuHeight > window.innerHeight - margin) {
      top = Math.max(margin, window.innerHeight - menuHeight - margin);
    }
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  global.MaweExportMenus = Object.freeze({
    SUBMENU_CLOSE_DELAY_MS,
    SUBMENU_AIM_TOLERANCE_PX,
    bindToolbarExportDropdown,
    positionBatchOperationsMenu
  });
})(typeof window !== 'undefined' ? window : globalThis);
