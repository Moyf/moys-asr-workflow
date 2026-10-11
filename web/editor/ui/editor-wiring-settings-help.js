// 设置搜索：侧栏列出设置项，路径放在提示行，仅在用户选择后跳转。
(function initSettingsSearch() {
  'use strict';
  const ITEM_SELECTOR = [
    'label',
    '.editor-settings-item',
    '.editor-settings-field',
    '.subtitle-preview-setting-row',
    '.subtitle-preview-setting-cell',
    '.multi-subtitle-setting-row',
    '.multi-subtitle-setting-toggle',
    '.editor-settings-group-heading',
    '.settings-panel-title',
    '.editor-settings-region-card',
    'button[id]',
    'button[data-settings-export]',
  ].join(', ');
  const inputs = [
    document.getElementById('editor-settings-search'),
    document.getElementById('project-settings-search'),
  ].filter(Boolean);
  if (!inputs.length) return;
  const roots = ['#editor-settings-panel', '#project-settings-panel']
    .map((selector) => document.querySelector(selector))
    .filter(Boolean);
  const normalize = (text) => (text || '').replace(/\s+/g, ' ').trim();
  const states = inputs.map((input) => {
    const nav = input.closest('.editor-settings-nav');
    const results = document.createElement('div');
    results.className = 'settings-search-results';
    results.id = input.id + '-results';
    results.hidden = true;
    results.setAttribute('role', 'region');
    results.setAttribute('aria-label', MAWE_I18N.translateText('设置搜索结果'));
    input.setAttribute('aria-controls', results.id);
    nav.append(results);
    return { input, nav, results };
  });

  // 页面和窗口本身可以隐藏；按功能开关隐藏的项目不应成为不可到达的结果。
  function available(item, page) {
    for (let node = item; node && node !== page; node = node.parentElement) {
      if (node.hidden) return false;
    }
    return true;
  }

  function itemLabel(item) {
    const caption = item.matches('.editor-settings-field') ? item.querySelector('.editor-settings-item') : null;
    const copy = (caption || item).cloneNode(true);
    copy.querySelectorAll('input, select, textarea, button, output, .editor-settings-hint, .settings-panel-hint, .font-combobox-options')
      .forEach((node) => node.remove());
    return normalize(copy.textContent);
  }

  function settingTarget(item) {
    if (item.matches('button')) {
      return item.parentElement.closest('label, .editor-settings-item, .editor-settings-field, .subtitle-preview-setting-row, .subtitle-preview-setting-cell, .multi-subtitle-setting-row, .multi-subtitle-setting-toggle') || item;
    }
    if (item.matches('.editor-settings-item') && !item.querySelector('input, select, textarea, button')) {
      return item.closest('.editor-settings-field') || item;
    }
    return item;
  }

  function hasSettingControl(target) {
    return target.matches('input, select, textarea, button') || target.control
      || target.querySelector('input, select, textarea, button');
  }

  function findResults(needle) {
    const matches = [];
    roots.forEach((root) => {
      root.querySelectorAll('.editor-settings-nav-tab').forEach((tab) => {
        if (tab.hidden) return;
        const page = document.getElementById(tab.getAttribute('aria-controls'));
        if (!page) return;
        const tabName = normalize(tab.textContent);
        const scope = normalize(root.querySelector('.editor-settings-window-title')?.textContent);
        if (tabName.toLowerCase().includes(needle)) matches.push({ root, tab, tabName, page, target: page, label: tabName, scope });
        const items = new Map();
        page.querySelectorAll(ITEM_SELECTOR).forEach((item) => {
          if (!available(item, page) || item.querySelector(ITEM_SELECTOR)) return;
          const target = settingTarget(item);
          const label = itemLabel(target);
          if (label) items.set(target, { label, text: normalize(target.textContent + ' ' + (target.getAttribute('title') || target.getAttribute('data-title') || '')) });
        });
        page.querySelectorAll('.editor-settings-hint, .settings-panel-hint').forEach((hint) => {
          if (!available(hint, page)) return;
          const group = hint.closest('.editor-settings-group, .settings-panel-section');
          const heading = document.getElementById(group?.getAttribute('aria-labelledby') || '');
          const target = items.has(hint.previousElementSibling) ? hint.previousElementSibling : heading;
          const entry = items.get(target);
          if (entry) entry.text += ' ' + normalize(hint.textContent);
        });
        // 同页同名的分组标题与控件只列一次；合并检索词并优先定位可操作控件。
        const distinctItems = new Map();
        items.forEach((entry, target) => {
          const key = entry.label.toLowerCase();
          const existing = distinctItems.get(key);
          if (!existing) distinctItems.set(key, { ...entry, target });
          else {
            existing.text += ' ' + entry.text;
            if (!hasSettingControl(existing.target) && hasSettingControl(target)) existing.target = target;
          }
        });
        distinctItems.forEach(({ target, ...entry }) => {
          if (!entry.text.toLowerCase().includes(needle)) return;
          // 标签页同名标题无需重复列出。
          if (entry.label === tabName && !target.querySelector('input, select, textarea, button')) return;
          matches.push({ root, tab, tabName, page, target, label: entry.label, scope });
        });
      });
    });
    return matches;
  }

  function selectResult(match, button, state) {
    const { input, results } = state;
    // 搜索后切换功能开关可能隐藏原来的目标；选择时重新确认可达性。
    if (match.tab.hidden || !available(match.target, match.page)) {
      applySettingsSearch(state);
      input.focus();
      return;
    }
    MaweSettingsPanels.openEditorSettingsAtTab(match.tab.id, { focus: false });
    const target = match.target.matches('.editor-settings-group-heading, .settings-panel-title')
      && match.target.nextElementSibling?.matches('.editor-settings-group')
      ? match.target.nextElementSibling : match.target;
    target.scrollIntoView({ block: 'nearest' });
    MaweSettingsPanels.flashSettingsTarget(target);
    results.querySelectorAll('[aria-current]').forEach((item) => item.removeAttribute('aria-current'));
    button.setAttribute('aria-current', 'true');
    const control = [target.control, target, ...target.querySelectorAll('input, select, textarea, button')]
      .filter((item) => item?.matches('input, select, textarea, button'))
      .find((item) => !item.disabled && item.getClientRects().length);
    if (control) control.focus({ preventScroll: true });
    else {
      match.page.tabIndex = -1;
      match.page.focus({ preventScroll: true });
    }
  }

  function applySettingsSearch(state) {
    const { input, nav, results } = state;
    const query = input.value;
    const needle = query.trim().toLowerCase();
    nav.classList.toggle('settings-searching', Boolean(needle));
    // 搜索结果是导航按钮，不属于原来的标签页集合。
    nav.setAttribute('role', needle ? 'navigation' : 'tablist');
    results.hidden = !needle;
    results.replaceChildren();
    if (!needle) return;
    const matches = findResults(needle);
    const status = document.createElement('p');
    status.className = 'settings-search-status';
    status.setAttribute('role', 'status');
    status.textContent = MAWE_I18N.translateText(matches.length ? '选择结果以跳转' : '未找到匹配的设置');
    results.append(status);
    matches.forEach((match) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'settings-search-result';
      button.dataset.settingsSearchTab = match.tab.dataset.settingsTab;
      const label = document.createElement('span');
      label.textContent = match.label;
      button.append(label);
      const hint = [match.root === input.closest('.editor-settings-panel') ? '' : match.scope,
        match.target === match.page ? '' : match.tabName].filter(Boolean).join(' / ');
      if (hint) {
        const path = document.createElement('small');
        path.textContent = hint;
        button.append(path);
      }
      button.addEventListener('click', () => selectResult(match, button, state));
      results.append(button);
    });
  }

  states.forEach((state) => {
    const { input, results } = state;
    input.addEventListener('input', () => applySettingsSearch(state));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && input.value) {
        event.preventDefault();
        event.stopPropagation();
        input.value = '';
        applySettingsSearch(state);
      } else if (event.key === 'ArrowDown' || event.key === 'Enter') {
        const first = results.querySelector('button');
        if (!first) return;
        event.preventDefault();
        if (event.key === 'Enter') first.click();
        else first.focus();
      }
    });
    results.addEventListener('keydown', (event) => {
      const buttons = [...results.querySelectorAll('button')];
      const index = buttons.indexOf(document.activeElement);
      if (index < 0 || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : index + (event.key === 'ArrowDown' ? 1 : -1);
      if (next < 0) input.focus();
      else buttons[Math.min(next, buttons.length - 1)].focus();
    });
  });
  document.addEventListener('mawe:languagechange', () => {
    states.forEach((state) => {
      state.results.setAttribute('aria-label', MAWE_I18N.translateText('设置搜索结果'));
      applySettingsSearch(state);
    });
  });
})();

document.querySelectorAll('[data-settings-region]').forEach((button) => {
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    MaweSettingsPanels.openRegionalSettings(button.dataset.settingsRegion, button.dataset.settingsTarget);
    MaweSettingsPanels.flashSettingsTarget(document.getElementById(button.dataset.settingsTarget || ''));
  });
});
document.querySelectorAll('[data-settings-page]').forEach((button) => {
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    MaweSettingsPanels.openEditorSettingsAtTab(`editor-settings-tab-${button.dataset.settingsPage}`);
    const target = document.getElementById(button.dataset.settingsTarget || '');
    target?.scrollIntoView({ block: 'nearest' });
    // 闪烁目标所在分组；未指定具体控件时闪目标页容器，给「跳转已发生」一个视觉反馈
    //（两个设置弹窗同时打开时尤其重要）。
    MaweSettingsPanels.flashSettingsTarget(
      target || document.getElementById(`editor-settings-page-${button.dataset.settingsPage}`),
    );
    const control = target?.matches('input, select, button') ? target
      : target?.nextElementSibling?.querySelector('input, select, button');
    control?.focus({ preventScroll: true });
  });
});
document.querySelectorAll('[data-settings-export]').forEach((button) => {
  button.addEventListener('click', () => {
    const command = document.getElementById(button.dataset.settingsExport);
    if (!command || command.getAttribute('aria-disabled') === 'true') return;
    MaweSettingsPanels.setEditorSettingsPanelOpen(false);
    command.click();
  });
});
document.querySelectorAll('[data-settings-tool="gap"]').forEach((button) => {
  button.addEventListener('click', () => {
    MaweSettingsPanels.setEditorSettingsPanelOpen(false);
    MaweGapRemoveUi.openGapRemovePanel();
    MaweDom.gapRemoveManageButton?.focus();
  });
});
[...MaweSettingsPanels.editorSettingsTabs, ...MaweSettingsPanels.projectTabs].forEach((tab) => {
  tab.addEventListener('click', () => MaweSettingsPanels.setEditorSettingsActiveTab(tab));
  tab.addEventListener('keydown', (event) => {
    // 方向键只在可见分区之间循环；隐藏分区（如不可用的「保存」）不参与导航。
    const visibleTabs = [...tab.closest('.editor-settings-nav').querySelectorAll('.editor-settings-nav-tab')].filter((item) => !item.hidden);
    const index = visibleTabs.indexOf(tab);
    let next = -1;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      next = (index + 1) % visibleTabs.length;
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      next = (index - 1 + visibleTabs.length) % visibleTabs.length;
    } else if (event.key === 'Home') {
      next = 0;
    } else if (event.key === 'End') {
      next = visibleTabs.length - 1;
    }
    if (next < 0) return;
    event.preventDefault();
    MaweSettingsPanels.setEditorSettingsActiveTab(visibleTabs[next], { focus: true });
  });
});
MaweDom.editorSettingsClose?.addEventListener('click', () => MaweSettingsPanels.setEditorSettingsPanelOpen(false));
MaweDom.cueListSettingsToggle?.addEventListener('click', (event) => {
  event.stopPropagation();
  MaweSettingsPanels.setCueListSettingsPanelOpen(MaweDom.cueListSettingsPanel?.hidden);
});
MaweDom.waveformSettingsToggle?.addEventListener('click', (event) => {
  event.stopPropagation();
  MaweSettingsPanels.setWaveformSettingsPanelOpen(MaweDom.waveformSettingsPanel?.hidden);
});
MaweDom.cueEditorSettingsToggle?.addEventListener('click', (event) => {
  event.stopPropagation();
  MaweSettingsPanels.setCueEditorSettingsPanelOpen(MaweDom.cueEditorSettingsPanel?.hidden);
});
document.addEventListener('pointerdown', (event) => {
  if (MaweSelection.temporaryVisibleSplitCueKeys.size) {
    const targetCue = event.target instanceof Element ? event.target.closest('.cue') : null;
    if (!MaweCueElements.cueElementHasTemporarySplitVisibility(targetCue)) {
      MaweCueElements.clearTemporaryVisibleSplitCues();
      MaweSearch.applySearch(MaweDom.searchEl.value);
    }
  }
  if (!MaweDom.cueListSettingsPanel?.hidden && !MaweDom.cueListSettings?.contains(event.target)) {
    MaweSettingsPanels.setCueListSettingsPanelOpen(false);
  }
  if (!MaweDom.waveformSettingsPanel?.hidden && !MaweDom.waveformSettings?.contains(event.target)) {
    MaweSettingsPanels.setWaveformSettingsPanelOpen(false);
  }
  if (!MaweDom.cueEditorSettingsPanel?.hidden && !MaweDom.cueEditorSettings?.contains(event.target)) {
    MaweSettingsPanels.setCueEditorSettingsPanelOpen(false);
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!MaweDom.cueListSettingsPanel?.hidden) {
    MaweSettingsPanels.setCueListSettingsPanelOpen(false);
    MaweDom.cueListSettingsToggle?.focus();
  }
  if (!MaweDom.waveformSettingsPanel?.hidden) {
    MaweSettingsPanels.setWaveformSettingsPanelOpen(false);
    MaweDom.waveformSettingsToggle?.focus();
  }
  if (!MaweDom.cueEditorSettingsPanel?.hidden) {
    MaweSettingsPanels.setCueEditorSettingsPanelOpen(false);
    MaweDom.cueEditorSettingsToggle?.focus();
  }
});
window.addEventListener('resize', MaweSettingsPanels.positionCueListSettingsPanel);
window.addEventListener('scroll', MaweSettingsPanels.positionCueListSettingsPanel, true);
window.addEventListener('resize', MaweSettingsPanels.positionWaveformSettingsPanel);
window.addEventListener('scroll', MaweSettingsPanels.positionWaveformSettingsPanel, true);
window.addEventListener('resize', MaweSettingsPanels.positionCueEditorSettingsPanel);
window.addEventListener('scroll', MaweSettingsPanels.positionCueEditorSettingsPanel, true);
MaweDom.cueListSettings?.closest('.cue-list-toolbar')?.addEventListener(
  'scroll', MaweSettingsPanels.positionCueListSettingsPanel,
);
MaweDom.waveformSettings?.closest('.waveform-toolbar')?.addEventListener(
  'scroll', MaweSettingsPanels.positionWaveformSettingsPanel,
);
MaweDom.cueEditorSettings?.closest('.cue-editor-toolbar')?.addEventListener(
  'scroll', MaweSettingsPanels.positionCueEditorSettingsPanel,
);
// 帮助浮窗：与拼合字幕共用 createFloatingPanel（拖动、位置持久化、Esc 关闭）

// 帮助是非模态浮窗；鼠标点击后的按钮焦点由统一的快捷键焦点处理释放。
MaweDom.helpCloseButton?.addEventListener('click', () => MaweHelpPanel.helpFloatingPanel.close());
MaweDom.helpOpenWaveformSettingsButtons.forEach((button) => {
  button.addEventListener('click', (event) => {
    event.preventDefault();
    MaweSettingsPanels.setWaveformSettingsPanelOpen(true);
    MaweDom.waveformSettingsToggle?.focus();
  });
});
// 帮助中的「全局设置」入口：打开设置窗口并定位到「视频预览」分区。
MaweDom.helpOpenMediaSettingsButtons.forEach((button) => {
  button.addEventListener('click', (event) => {
    event.preventDefault();
    MaweSettingsPanels.openEditorSettingsAtTab('editor-settings-tab-subtitle-preview');
  });
});
// 帮助中的「全局设置」入口：定位到对应分区（波形操作/按键/空隙设置所在）。
helpOpenEditorSettingsButtons.forEach((button) => {
  button.addEventListener('click', (event) => {
    event.preventDefault();
    MaweSettingsPanels.openEditorSettingsAtTab(button.id === 'help-open-gap-settings' || button.id === 'help-open-keyboard-settings'
      ? 'editor-settings-tab-special-edit' : 'editor-settings-tab-general');
  });
});
MaweDom.helpOpenGapRemovePanelButton?.addEventListener('click', (event) => {
  event.preventDefault();
  MaweGapRemoveUi.openGapRemovePanel();
  MaweDom.gapRemoveManageButton?.focus();
});




MaweDom.helpTabButtons.forEach((button) => {
  button.addEventListener('click', () => MaweHelpPanel.selectHelpTab(button.dataset.helpTab));
  button.addEventListener('keydown', (event) => {
    const availableButtons = MaweHelpPanel.visibleHelpTabButtons();
    const index = availableButtons.indexOf(button);
    if (index < 0) return;
    let nextIndex = index;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (index + 1) % availableButtons.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (index - 1 + availableButtons.length) % availableButtons.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = availableButtons.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    MaweHelpPanel.selectHelpTab(availableButtons[nextIndex].dataset.helpTab, { focus: true });
  });
});
if (MaweDom.helpTabButtons.length && MaweDom.helpTabPanels.length) {
  MaweHelpPanel.selectHelpTab(MaweDom.helpTabButtons.find((button) => button.getAttribute('aria-selected') === 'true')?.dataset.helpTab || MaweDom.helpTabButtons[0].dataset.helpTab);
}

MaweDom.contextualHelpButtons.forEach((button) => {
  button.addEventListener('click', () => {
    // 帮助是非模态浮窗：从设置弹窗打开帮助时保持弹窗，两者并存。
    MaweHelpPanel.openHelpAtTab(button.dataset.helpTabTarget);
  });
});
// 浮窗尺寸：仅在用户拖过右下角缩放手柄后持久化；未缩放时保持 CSS 默认宽度/自动高度


if (MaweDom.helpPanel) {
  new ResizeObserver(() => {
    if (!MaweDom.helpPanel.classList.contains('show')) return;
    if (!MaweDom.helpPanel.style.width && !MaweDom.helpPanel.style.height) return;
    clearTimeout(MaweHelpPanel.helpPanelSizeSaveTimer);
    MaweHelpPanel.helpPanelSizeSaveTimer = setTimeout(() => {
      const rect = MaweDom.helpPanel.getBoundingClientRect();
      try {
        localStorage.setItem(MaweDom.HELP_PANEL_SIZE_KEY, JSON.stringify({
          width: Math.round(rect.width), height: Math.round(rect.height),
        }));
      } catch (_) {
        // file:// 隐私模式下 localStorage 可能被拒；缩放本身仍可用。
      }
    }, 250);
  }).observe(MaweDom.helpPanel);
}


// 明暗主题与界面强调色：令牌全部定义在 CSS，
// 这里只负责解析偏好、写 <html> 数据属性、持久化，以及通知波形重绘画布。
