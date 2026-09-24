// 帮助面板：浮窗、标签页切换与尺寸持久化。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweHelpPanel 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweHelpPanel(global) {
  'use strict';


  // 帮助浮窗：与拼合字幕共用 createFloatingPanel（拖动、位置持久化、Esc 关闭）
  const helpFloatingPanel = MaweFloatingPanel.createFloatingPanel({
    panel: MaweDom.helpPanel,
    dragHandle: MaweDom.helpDragHandle,
    manageButton: MaweDom.helpToggle,
    anchorButton: MaweDom.helpToggle,
    positionKey: MaweDom.HELP_PANEL_POSITION_KEY,
    onOpen: restoreHelpPanelSize,
  });


  function visibleHelpTabButtons() {
    return MaweDom.helpTabButtons.filter((button) => !button.closest('[hidden]'));
  }



  function selectHelpTab(tabName, { focus = false } = {}) {
    const activeButton = MaweDom.helpTabButtons.find((button) => button.dataset.helpTab === tabName);
    if (!activeButton) return;
    MaweDom.helpTabButtons.forEach((button) => {
      const active = button === activeButton;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
    });
    MaweDom.helpTabPanels.forEach((panel) => {
      const active = panel.dataset.helpTabPanel === tabName;
      panel.hidden = !active;
      panel.setAttribute('aria-hidden', String(!active));
    });
    if (focus) activeButton.focus();
  }


  function openHelpAtTab(tabName) {
    if (!MaweDom.helpTabButtons.some((button) => button.dataset.helpTab === tabName)) return;
    selectHelpTab(tabName);
    helpFloatingPanel.open();
  }


  // 浮窗尺寸：仅在用户拖过右下角缩放手柄后持久化；未缩放时保持 CSS 默认宽度/自动高度
  function restoreHelpPanelSize() {
    if (!MaweDom.helpPanel) return;
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(MaweDom.HELP_PANEL_SIZE_KEY) || 'null');
    } catch (_) {
      saved = null;
    }
    if (!Number.isFinite(saved?.width) || !Number.isFinite(saved?.height)) return;
    MaweDom.helpPanel.style.width = `${Math.min(Math.max(400, saved.width), window.innerWidth - 12)}px`;
    MaweDom.helpPanel.style.height = `${Math.min(Math.max(240, saved.height), window.innerHeight - 12)}px`;
  }


  let helpPanelSizeSaveTimer = 0;

  global.MaweHelpPanel = Object.freeze({
    helpFloatingPanel,
    visibleHelpTabButtons,
    selectHelpTab,
    openHelpAtTab,
    restoreHelpPanelSize,
    get helpPanelSizeSaveTimer() { return helpPanelSizeSaveTimer; },
    set helpPanelSizeSaveTimer(v) { helpPanelSizeSaveTimer = v; }
  });
})(typeof window !== 'undefined' ? window : globalThis);
