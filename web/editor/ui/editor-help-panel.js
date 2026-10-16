// 真 ESM：模块顶层定义与发布（原转换体 phase-2 语义 = import 求值）。
// window.<Name> 与导出的 <Name> 是同一对象；消费者逐簇改 import 后移除 window 发布。
'use strict';
import { MaweFloatingPanel } from "./editor-floating-panel.js";
import { MaweDom } from "./editor-dom.js";


// 帮助浮窗：与拼合字幕共用 createFloatingPanel（拖动、位置持久化、Esc 关闭）。
// ESM 求值序下本模块可能先于 editor-floating-panel 完成；
// 创建推迟到首次访问（消费点都在启动后的回调里）。
let helpFloatingPanel = null;
function ensureHelpFloatingPanel() {
  if (helpFloatingPanel) return;
  helpFloatingPanel = MaweFloatingPanel.createFloatingPanel({
    panel: MaweDom.helpPanel,
    dragHandle: MaweDom.helpDragHandle,
    manageButton: MaweDom.helpToggle,
    anchorButton: MaweDom.helpToggle,
    positionKey: MaweDom.HELP_PANEL_POSITION_KEY,
    onOpen: restoreHelpPanelSize,
  });
}
ensureHelpFloatingPanel();

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

window.MaweHelpPanel = Object.freeze({
  helpFloatingPanel,
  visibleHelpTabButtons,
  selectHelpTab,
  openHelpAtTab,
  restoreHelpPanelSize,
  get helpPanelSizeSaveTimer() { return helpPanelSizeSaveTimer; },
  set helpPanelSizeSaveTimer(v) { helpPanelSizeSaveTimer = v; }
});

export const MaweHelpPanel = Object.freeze({
    helpFloatingPanel,
    visibleHelpTabButtons,
    selectHelpTab,
    openHelpAtTab,
    restoreHelpPanelSize,
    get helpPanelSizeSaveTimer() { return helpPanelSizeSaveTimer; },
    set helpPanelSizeSaveTimer(v) { helpPanelSizeSaveTimer = v; }
  });
window.MaweHelpPanel = MaweHelpPanel;

// 供已迁移消费者经 import 写尺寸保存定时器（语义与 facade 访问器对一致）。
export function setHelpPanelSizeSaveTimer(value) { helpPanelSizeSaveTimer = value; }
