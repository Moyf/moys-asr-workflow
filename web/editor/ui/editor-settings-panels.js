// 设置面板群：各设置面板的定位/开关、编辑器设置窗口（main 新增）与面板归属管理。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweSettingsPanels 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweSettingsPanels(global) {
  'use strict';



  // 全局设置窗口：复用 createFloatingPanel 获得拖动、位置持久化、Esc 关闭与按钮 active 态；
  // 窗口内部用左侧垂直标签页切换不同分区，并记忆用户上次停留的分区。
  const editorSettingsTabs = MaweDom.editorSettingsPanel
    ? Array.from(MaweDom.editorSettingsPanel.querySelectorAll('.editor-settings-nav-tab'))
    : [];

  const projectPanel = document.getElementById('project-settings-panel');
  const projectTabs = Array.from(projectPanel?.querySelectorAll('.editor-settings-nav-tab') || []);
  const projectTabKey = 'moy.asr.project.settings.tab.v1';
  const projectFloatingPanel = MaweFloatingPanel.createFloatingPanel({
    panel: projectPanel,
    dragHandle: document.getElementById('project-settings-drag-handle'),
    manageButton: document.getElementById('project-settings-toggle'),
    anchorButton: document.getElementById('project-settings-toggle'),
    positionKey: 'moy.asr.project.settings.position.v1',
    onOpen: () => {
      let saved = '';
      try { saved = localStorage.getItem(projectTabKey) || ''; } catch (_) {}
      setEditorSettingsActiveTab(projectTabs.find(tab => tab.dataset.settingsTab === saved) || projectTabs[0]);
      // 打开时同步两个镜像开关的当前状态。
      const wordMirror = document.getElementById('project-word-timing-toggle');
      if (wordMirror) wordMirror.checked = window.MaweWordTiming?.enabled === true;
      const markerMirror = document.getElementById('project-marker-track-toggle');
      if (markerMirror) markerMirror.checked = MaweSettings.EDITOR_SETTINGS.markerEditingEnabled === true;
    },
  });
  document.getElementById('project-settings-close')?.addEventListener('click', () => projectFloatingPanel.close());


  const editorSettingsFloatingPanel = MaweFloatingPanel.createFloatingPanel({
    panel: MaweDom.editorSettingsPanel,
    dragHandle: MaweDom.editorSettingsDragHandle,
    manageButton: MaweDom.editorSettingsToggle,
    anchorButton: MaweDom.editorSettingsToggle,
    positionKey: MaweDom.EDITOR_SETTINGS_WINDOW_POSITION_KEY,
    // 所有打开路径（按钮点击 / 桥接）都先恢复尺寸与标签页，保证默认分区带上
    // active 样式，且窗口按实际内容尺寸定位。
    onOpen: () => {
      restoreEditorSettingsPanelSize();
      restoreEditorSettingsActiveTab();
    },
  });



  function setEditorSettingsActiveTab(tab, { focus = false } = {}) {
    if (!tab) return;
    updateRegionalSettingsAvailability();
    const project = tab.closest('#project-settings-panel');
    for (const item of project ? projectTabs : editorSettingsTabs) {
      const active = item === tab;
      item.classList.toggle('active', active);
      item.setAttribute('aria-selected', String(active));
      item.tabIndex = active ? 0 : -1;
      const page = document.getElementById(item.getAttribute('aria-controls') || '');
      if (page) page.hidden = !active;
    }
    // A taller settings page can push lower controls outside the viewport while
    // its floating window remains at the position saved for a shorter page.
    requestAnimationFrame(() => (project ? projectFloatingPanel : editorSettingsFloatingPanel).reclamp());
    if (focus) tab.focus();
    try {
      localStorage.setItem(project ? projectTabKey : MaweDom.EDITOR_SETTINGS_WINDOW_TAB_KEY, tab.dataset.settingsTab || '');
    } catch (_) {
      // file:// 隐私模式可能拒绝 localStorage；切换标签页本身不受影响。
    }
  }



  function restoreEditorSettingsActiveTab() {
    let saved = '';
    try {
      saved = localStorage.getItem(MaweDom.EDITOR_SETTINGS_WINDOW_TAB_KEY) || '';
    } catch (_) {
      saved = '';
    }
    // 忽略已隐藏的分区（如当前环境不可用的「保存」），回退到第一个可见分区。
    const tab = editorSettingsTabs.find((item) => item.dataset.settingsTab === saved && !item.hidden)
      || editorSettingsTabs.find((item) => !item.hidden)
      || editorSettingsTabs[0];
    setEditorSettingsActiveTab(tab);
  }



  // 浮窗尺寸：与帮助窗口一致，仅在用户拖过右下角缩放手柄后持久化；
  // 未缩放时保持 CSS 默认宽度/自动高度。
  function restoreEditorSettingsPanelSize() {
    if (!MaweDom.editorSettingsPanel) return;
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(MaweDom.EDITOR_SETTINGS_WINDOW_SIZE_KEY) || 'null');
    } catch (_) {
      saved = null;
    }
    if (!Number.isFinite(saved?.width) || !Number.isFinite(saved?.height)) return;
    MaweDom.editorSettingsPanel.style.width = `${Math.min(Math.max(460, saved.width), window.innerWidth - 12)}px`;
    MaweDom.editorSettingsPanel.style.height = `${Math.min(Math.max(280, saved.height), window.innerHeight - 24)}px`;
  }


  let editorSettingsPanelSizeSaveTimer = 0;



  function setEditorSettingsPanelOpen(open) {
    if (!MaweDom.editorSettingsPanel || !MaweDom.editorSettingsToggle) return;
    if (!open) {
      editorSettingsFloatingPanel.close();
      return;
    }
    updateRegionalSettingsAvailability();
    editorSettingsFloatingPanel.open();
  }



  function positionAnchoredSettingsPanel(panel, toggle) {
    if (!panel || panel.hidden || !toggle) return;
    const buttonRect = toggle.getBoundingClientRect();
    const panelWidth = panel.offsetWidth;
    const panelHeight = panel.offsetHeight;
    const margin = 8;
    const left = Math.min(
      Math.max(margin, buttonRect.right - panelWidth),
      Math.max(margin, window.innerWidth - panelWidth - margin),
    );
    const belowTop = buttonRect.bottom + 6;
    const aboveTop = buttonRect.top - panelHeight - 6;
    let top = belowTop;
    if (belowTop + panelHeight > window.innerHeight - margin && aboveTop >= margin) {
      top = aboveTop;
    } else if (belowTop + panelHeight > window.innerHeight - margin) {
      top = Math.max(margin, window.innerHeight - panelHeight - margin);
    }
    panel.style.left = String(left) + 'px';
    panel.style.top = String(top) + 'px';
  }



  function setSettingsPanelOwnerOpen(panel, open) {
    const owner = panel?.closest('.player-wrap, .current-cue-panel, .cues-container, .waveform-pane');
    owner?.classList.toggle('settings-panel-owner-open', open);
  }



  function positionCueListSettingsPanel() {
    positionAnchoredSettingsPanel(MaweDom.cueListSettingsPanel, MaweDom.cueListSettingsToggle);
  }



  function setCueListSettingsPanelOpen(open) {
    if (!MaweDom.cueListSettingsPanel || !MaweDom.cueListSettingsToggle) return;
    MaweDom.cueListSettingsPanel.hidden = !open;
    setSettingsPanelOwnerOpen(MaweDom.cueListSettingsPanel, open);
    MaweDom.cueListSettingsToggle.classList.toggle('active', open);
    MaweDom.cueListSettingsToggle.setAttribute('aria-expanded', String(open));
    if (open) {
      MaweFloatingPanel.bringFloatingSurfaceToFront(MaweDom.cueListSettingsPanel);
      positionCueListSettingsPanel();
    }
    MaweFloatingPanel.syncFloatingSurfaceLayers();
  }



  function positionCueEditorSettingsPanel() {
    positionAnchoredSettingsPanel(MaweDom.cueEditorSettingsPanel, MaweDom.cueEditorSettingsToggle);
  }



  function setCueEditorSettingsPanelOpen(open) {
    if (!MaweDom.cueEditorSettingsPanel || !MaweDom.cueEditorSettingsToggle) return;
    MaweDom.cueEditorSettingsPanel.hidden = !open;
    setSettingsPanelOwnerOpen(MaweDom.cueEditorSettingsPanel, open);
    MaweDom.cueEditorSettingsToggle.classList.toggle('active', open);
    MaweDom.cueEditorSettingsToggle.setAttribute('aria-expanded', String(open));
    if (open) {
      MaweFloatingPanel.bringFloatingSurfaceToFront(MaweDom.cueEditorSettingsPanel);
      positionCueEditorSettingsPanel();
    }
    MaweFloatingPanel.syncFloatingSurfaceLayers();
  }



  function positionWaveformSettingsPanel() {
    positionAnchoredSettingsPanel(MaweDom.waveformSettingsPanel, MaweDom.waveformSettingsToggle);
  }



  function setWaveformSettingsPanelOpen(open) {
    if (!MaweDom.waveformSettingsPanel || !MaweDom.waveformSettingsToggle) return;
    MaweDom.waveformSettingsPanel.hidden = !open;
    setSettingsPanelOwnerOpen(MaweDom.waveformSettingsPanel, open);
    MaweDom.waveformSettingsToggle.classList.toggle('active', open);
    MaweDom.waveformSettingsToggle.setAttribute('aria-expanded', String(open));
    if (open) {
      MaweFloatingPanel.bringFloatingSurfaceToFront(MaweDom.waveformSettingsPanel);
      positionWaveformSettingsPanel();
    }
    MaweFloatingPanel.syncFloatingSurfaceLayers();
  }


  // 帮助中的「全局设置」入口：打开设置窗口并定位到「视频预览」分区。
  function openEditorSettingsAtTab(tabId) {
    const tab = document.getElementById(tabId);
    closeRegionalSettings();
    if (tab?.closest('#project-settings-panel')) projectFloatingPanel.open();
    else setEditorSettingsPanelOpen(true);
    setEditorSettingsActiveTab(tab, { focus: true });
  }

  function closeRegionalSettings() {
    setCueListSettingsPanelOpen(false);
    setCueEditorSettingsPanelOpen(false);
    setWaveformSettingsPanelOpen(false);
    for (const id of ['workspace-transfer-dropdown']) {
      const dropdown = document.getElementById(id);
      dropdown?.classList.remove('open');
      dropdown?.querySelector('button[aria-expanded]')?.setAttribute('aria-expanded', 'false');
    }
    document.querySelectorAll('.toolbar .dropdown.open').forEach((dropdown) => {
      dropdown.classList.remove('open');
      dropdown.querySelector('button[aria-expanded]')?.setAttribute('aria-expanded', 'false');
      dropdown.querySelectorAll('.dropdown-submenu').forEach((submenu) => {
        submenu.classList.remove('open');
        submenu.querySelector('[aria-expanded]')?.setAttribute('aria-expanded', 'false');
      });
    });
    MaweFloatingPanel.syncFloatingSurfaceLayers();
  }

  function updateRegionalSettingsAvailability() {
    const workspaceButton = document.querySelector('[data-settings-region="workspace"]');
    if (workspaceButton) workspaceButton.disabled = Boolean(document.getElementById('workspace-transfer-dropdown')?.hidden);
    document.querySelectorAll('[data-settings-export]').forEach((button) => {
      const command = document.getElementById(button.dataset.settingsExport);
      button.disabled = !command || command.getAttribute('aria-disabled') === 'true';
      if (command) button.title = command.title;
    });
  }

  function openRegionalSettings(region, targetId) {
    const regions = {
      waveform: [MaweDom.waveformSettingsPanel, MaweDom.waveformSettingsToggle, setWaveformSettingsPanelOpen],
      'cue-editor': [MaweDom.cueEditorSettingsPanel, MaweDom.cueEditorSettingsToggle, setCueEditorSettingsPanelOpen],
      'cue-list': [MaweDom.cueListSettingsPanel, MaweDom.cueListSettingsToggle, setCueListSettingsPanelOpen],
      workspace: [document.getElementById('workspace-transfer-menu'), document.getElementById('workspace-transfer-btn')],
    };
    const entry = regions[region];
    if (!entry || !entry[0] || !entry[1] || entry[1].closest('[hidden]')) return;
    closeRegionalSettings();
    const [panel, toggle, open] = entry;
    toggle.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (open) open(true);
    else toggle.click();
    const target = targetId ? document.getElementById(targetId) : null;
    const control = target || [...panel.querySelectorAll('input, select, button, [tabindex="0"]')]
      .find(element => !element.disabled && element.getClientRects().length);
    (control || toggle).focus({ preventScroll: true });
  }

  // 通用「跳转已发生」提示：目标设置项所在分组（或目标元素本身）边框闪烁。
  // 各种 inline action 跳转都可复用；连续点击时先清掉上一次的闪烁再重启。
  let settingsFlashTimer = 0;
  function flashSettingsTarget(target) {
    if (!target || !target.isConnected) return;
    const scope = target.closest('.editor-settings-group, .settings-panel-section') || target;
    clearTimeout(settingsFlashTimer);
    document.querySelectorAll('.settings-flash').forEach((element) => element.classList.remove('settings-flash'));
    // 强制 reflow，让同一元素上的连续闪烁重新播放动画。
    void scope.offsetWidth;
    scope.classList.add('settings-flash');
    settingsFlashTimer = setTimeout(() => scope.classList.remove('settings-flash'), 1600);
  }

  global.MaweSettingsPanels = Object.freeze({
    openRegionalSettings,
    closeRegionalSettings,
    updateRegionalSettingsAvailability,
    openEditorSettingsAtTab,
    flashSettingsTarget,
    editorSettingsTabs,
    projectTabs,
    projectFloatingPanel,
    editorSettingsFloatingPanel,
    setEditorSettingsActiveTab,
    restoreEditorSettingsActiveTab,
    restoreEditorSettingsPanelSize,
    get editorSettingsPanelSizeSaveTimer() { return editorSettingsPanelSizeSaveTimer; },
    set editorSettingsPanelSizeSaveTimer(v) { editorSettingsPanelSizeSaveTimer = v; },
    setEditorSettingsPanelOpen,
    positionAnchoredSettingsPanel,
    setSettingsPanelOwnerOpen,
    positionCueListSettingsPanel,
    setCueListSettingsPanelOpen,
    positionCueEditorSettingsPanel,
    setCueEditorSettingsPanelOpen,
    positionWaveformSettingsPanel,
    setWaveformSettingsPanelOpen
  });
})(typeof window !== 'undefined' ? window : globalThis);
