/* Runs in head (before paint). Only presentation preferences, never business state. */
(function () {
  'use strict';
  var root = document.documentElement;
  var key = 'maw-tool:' + (root.getAttribute('data-tool-page') || 'page');
  var system = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  function read(suffix) { try { return localStorage.getItem(key + suffix); } catch (_) { return null; } }
  function write(suffix, value) { try { localStorage.setItem(key + suffix, value); } catch (_) { /* Optional preference. */ } }
  var savedTheme = read(':theme');
  var explicitTheme = savedTheme === 'light' || savedTheme === 'dark';
  root.dataset.theme = explicitTheme ? savedTheme : system && system.matches ? 'light' : 'dark';
  root.classList.toggle('tool-compact', read(':compact') === '1');
  function updateControls() {
    document.querySelectorAll('[data-tool-theme]').forEach(function (button) {
      var label = root.dataset.theme === 'dark' ? '切换为浅色主题' : '切换为深色主题';
      button.setAttribute('aria-label', label);
      button.title = label;
      button.textContent = '◐';
    });
    document.querySelectorAll('input[data-tool-compact]').forEach(function (input) {
      input.checked = root.classList.contains('tool-compact');
    });
  }
  function themeChanged() {
    updateControls();
    document.dispatchEvent(new CustomEvent('tool-theme-change'));
  }
  function initTooltips() {
    const bubble = document.createElement('div');
    bubble.className = 'tool-tooltip';
    bubble.setAttribute('role', 'tooltip');
    bubble.hidden = true;
    document.body.append(bubble);
    let target, timer;
    function hide() {
      clearTimeout(timer);
      target = null;
      bubble.hidden = true;
    }
    function show(element, delay) {
      if (target === element) return;
      hide();
      target = element;
      timer = setTimeout(() => {
        if (!element.isConnected) return;
        bubble.textContent = element.dataset.toolTip;
        bubble.hidden = false;
        const box = element.getBoundingClientRect();
        const width = document.documentElement.clientWidth;
        const height = document.documentElement.clientHeight;
        const x = Math.max(8, Math.min(width - bubble.offsetWidth - 8, box.left + (box.width - bubble.offsetWidth) / 2));
        const below = box.bottom + 8;
        const y = below + bubble.offsetHeight <= height - 8 ? below : Math.max(8, box.top - bubble.offsetHeight - 8);
        bubble.style.left = `${x}px`;
        bubble.style.top = `${y}px`;
      }, delay);
    }
    const tipFor = node => node instanceof Element ? node.closest('[data-tool-tip]') : null;
    function pointerTip(event) {
      const element = tipFor(event.target);
      if (element && event.pointerType !== 'touch') show(element, 280);
    }
    document.addEventListener('pointerover', pointerTip);
    document.addEventListener('pointerout', event => {
      if (target && tipFor(event.target) === target && tipFor(event.relatedTarget) !== target) hide();
    });
    document.addEventListener('focusin', event => {
      const element = tipFor(event.target);
      if (element?.matches(':focus-visible')) show(element, 0);
    });
    document.addEventListener('focusout', event => { if (event.target === target) hide(); });
    document.addEventListener('pointerdown', hide);
    document.addEventListener('click', hide);
    document.addEventListener('scroll', () => {
      if (target && !target.matches(':hover, :focus-visible')) hide();
    }, true);
    window.addEventListener('resize', hide);
    document.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });
  }
  if (system && system.addEventListener) system.addEventListener('change', function () {
    if (!explicitTheme) { root.dataset.theme = system.matches ? 'light' : 'dark'; themeChanged(); }
  });
  document.addEventListener('DOMContentLoaded', function () {
    // Retired pages keep their original declarations; upgrade only this shared control.
    document.querySelectorAll('button[data-tool-compact]').forEach(function (button) {
      var label = document.createElement('label');
      label.className = 'switch tool-density';
      label.title = button.title;
      var input = document.createElement('input');
      input.type = 'checkbox';
      input.setAttribute('data-tool-compact', '');
      input.setAttribute('role', 'switch');
      if (button.id) input.id = button.id;
      if (button.hasAttribute('aria-label')) input.setAttribute('aria-label', button.getAttribute('aria-label'));
      input.disabled = button.disabled;
      var track = document.createElement('span');
      track.className = 'switch-track';
      track.setAttribute('aria-hidden', 'true');
      label.append(input, track, document.createTextNode(button.textContent));
      button.replaceWith(label);
    });
    updateControls();
    if (root.classList.contains('tool-action-tooltips')) initTooltips();
    document.addEventListener('click', function (event) {
      var theme = event.target.closest('[data-tool-theme]');
      if (theme) {
        explicitTheme = true;
        root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
        write(':theme', root.dataset.theme);
        themeChanged();
      }
    });
    document.addEventListener('change', function (event) {
      var input = event.target;
      if (!input.matches('input[type="checkbox"][data-tool-compact]')) return;
      root.classList.toggle('tool-compact', input.checked);
      write(':compact', input.checked ? '1' : '0');
      updateControls();
      document.dispatchEvent(new CustomEvent('tool-density-change'));
    });
    var sticky = document.querySelector('[data-tool-sticky]');
    if (sticky) {
      var measure = function () {
        var height = getComputedStyle(sticky).position === 'sticky' ? sticky.getBoundingClientRect().height : 0;
        root.style.setProperty('--tool-header-h', height + 'px');
      };
      if (window.ResizeObserver) new ResizeObserver(measure).observe(sticky);
      window.addEventListener('resize', measure);
      measure();
    }
  });
})();
