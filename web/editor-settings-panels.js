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
    for (const item of editorSettingsTabs) {
      const active = item === tab;
      item.classList.toggle('active', active);
      item.setAttribute('aria-selected', String(active));
      item.tabIndex = active ? 0 : -1;
      const page = document.getElementById(item.getAttribute('aria-controls') || '');
      if (page) page.hidden = !active;
    }
    if (focus) tab.focus();
    try {
      localStorage.setItem(MaweDom.EDITOR_SETTINGS_WINDOW_TAB_KEY, tab.dataset.settingsTab || '');
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
      setMergeJoinSettingsPanelOpen(false);
      setSplitTrimSettingsPanelOpen(false);
      editorSettingsFloatingPanel.close();
      return;
    }
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



  function positionMergeJoinSettingsPanel() {
    positionAnchoredSettingsPanel(MaweDom.mergeJoinSettingsPanel, MaweDom.mergeJoinSettingsToggle);
  }



  function setMergeJoinSettingsPanelOpen(open) {
    if (!MaweDom.mergeJoinSettingsPanel || !MaweDom.mergeJoinSettingsToggle) return;
    MaweDom.mergeJoinSettingsPanel.hidden = !open;
    MaweDom.mergeJoinSettingsToggle.classList.toggle('active', open);
    MaweDom.mergeJoinSettingsToggle.setAttribute('aria-expanded', String(open));
    if (open) {
      MaweFloatingPanel.bringFloatingSurfaceToFront(MaweDom.mergeJoinSettingsPanel);
      positionMergeJoinSettingsPanel();
    }
    MaweFloatingPanel.syncFloatingSurfaceLayers();
  }



  function positionSplitTrimSettingsPanel() {
    positionAnchoredSettingsPanel(MaweDom.splitTrimSettingsPanel, MaweDom.splitTrimSettingsToggle);
  }



  function setSplitTrimSettingsPanelOpen(open) {
    if (!MaweDom.splitTrimSettingsPanel || !MaweDom.splitTrimSettingsToggle) return;
    MaweDom.splitTrimSettingsPanel.hidden = !open;
    MaweDom.splitTrimSettingsToggle.classList.toggle('active', open);
    MaweDom.splitTrimSettingsToggle.setAttribute('aria-expanded', String(open));
    if (open) {
      MaweFloatingPanel.bringFloatingSurfaceToFront(MaweDom.splitTrimSettingsPanel);
      positionSplitTrimSettingsPanel();
    }
    MaweFloatingPanel.syncFloatingSurfaceLayers();
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

  global.MaweSettingsPanels = Object.freeze({
    editorSettingsTabs,
    editorSettingsFloatingPanel,
    setEditorSettingsActiveTab,
    restoreEditorSettingsActiveTab,
    restoreEditorSettingsPanelSize,
    get editorSettingsPanelSizeSaveTimer() { return editorSettingsPanelSizeSaveTimer; },
    set editorSettingsPanelSizeSaveTimer(v) { editorSettingsPanelSizeSaveTimer = v; },
    setEditorSettingsPanelOpen,
    positionAnchoredSettingsPanel,
    positionMergeJoinSettingsPanel,
    setMergeJoinSettingsPanelOpen,
    positionSplitTrimSettingsPanel,
    setSplitTrimSettingsPanelOpen,
    setSettingsPanelOwnerOpen,
    positionCueListSettingsPanel,
    setCueListSettingsPanelOpen,
    positionCueEditorSettingsPanel,
    setCueEditorSettingsPanelOpen,
    positionWaveformSettingsPanel,
    setWaveformSettingsPanelOpen
  });
})(typeof window !== 'undefined' ? window : globalThis);
