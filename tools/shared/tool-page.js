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
