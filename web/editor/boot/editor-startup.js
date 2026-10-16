import { updateSelectionCountText } from "../cues/editor-selection-count.js";
import { setSubtitlePreviewHandlers } from "../media/editor-playback-loop.js";
import { applyAssSubtitlePreview, restoreCssSubtitlePreview } from "../styles/editor-wiring-ass-preview.js";

import { MaweTimeline } from "../cues/editor-timeline.js";
import { MaweCueElements } from "../cues/editor-cue-elements.js";
import { MaweHint } from "../ui/editor-hint.js";
import { MaweCoreState } from "../state/editor-core-state.js";
import { MaweBoot } from "./editor-boot.js";
import { MaweDom } from "../ui/editor-dom.js";
import { MaweMultiSubtitleCore } from "../state/editor-multi-subtitle-core.js";
import { MaweSelection } from "../cues/editor-selection.js";
import { MaweSettings } from "../state/editor-settings.js";
import { MaweProjectSettings } from "../state/editor-project-settings.js";
import { MaweCuePanelState } from "../state/editor-cue-panel-state.js";
import { MaweCuePanel } from "../cues/editor-cue-panel.js";
import { MaweServerSave } from "../io/editor-server-save.js";
import { MaweHistory } from "../state/editor-history.js";
import { MaweProjectSave, setProjectJsonBuilder } from "../io/editor-project-save.js";
import { MaweTextCleanup } from "../cues/editor-text-cleanup.js";
import { MaweCueListAnchor } from "../cues/editor-cue-list-anchor.js";
import { MaweGapRemoveUi } from "../ui/editor-gap-remove-ui.js";
import { MaweDisplaySettings } from "../ui/editor-display-settings.js";
import { MaweSearch } from "../cues/editor-search.js";
import { MaweJsonRepair } from "../io/editor-json-repair.js";
import { MaweSettingsPanels } from "../ui/editor-settings-panels.js";
import { MaweWorkspaces } from "../ui/editor-workspaces.js";
import { MaweWaveformInit } from "../media/editor-waveform-init.js";
import { MaweServerConnection } from "../io/editor-server-connection.js";
import { MaweHelpPanel } from "../ui/editor-help-panel.js";
import { getMaweState } from '../state/editor-state.js';
// 真 ESM：wiring 顶层接线（原转换体 phase-1/phase-2 = import 求值）。
'use strict';
setSubtitlePreviewHandlers({ applyAss: applyAssSubtitlePreview, restoreCss: restoreCssSubtitlePreview });
setProjectJsonBuilder(MaweJsonRepair.buildJson);
// 启动序列：全部模块求值完成（所有门面已发布）后执行，
// 由具名步骤表达——修复工程数据、安装工程设置、发布窄桥接、渲染首帧、绑定启动控件。
queueMicrotask(function startupEditor() {
  const repaired = repairProjectData();
  MaweProjectSettings.syncControls();
  publishEditorBridge();
  renderFirstFrame();
  bindStartupControls();
  finishStartup(repaired);
});

// 时间基准投影 + 分组引用/时间码修复 + markers 规范化。
function repairProjectData() {
  MaweTimeline.syncProjectTimebaseAndBindingOffsets(MaweBoot.DATA, { preferFrames: MaweBoot.DATA.timebase?.unit === 'frames' });
  const repairedGroupReferenceCount = window.AsrEditorUtils.repairGroupReferenceIndices(MaweBoot.DATA.segments);
  const repairedTimingCount = MaweJsonRepair.normalizeProjectTimings(MaweBoot.DATA);
  // 服务器注入的工程里 markers 是 MOSP 包装对象（{schema, items}）；编辑器内部
  // 统一用数组，写出文件时再经 markersToProjectField 包回。不在这里换掉的话，
  // 轨道不渲染，且首次 markerList() 会把包装对象整个清掉。
  MaweBoot.DATA.markers = window.AsrEditorUtils.normalizeMarkers(MaweBoot.DATA.markers);
  // 带 markers 的工程（如 AI 整理产物）默认启用标记轨道，方便直接复核待确认项。
  window.MaweMarkerEditing?.enableForProjectMarkers?.(MaweBoot.DATA.markers);
  MaweTimeline.syncProjectTimebaseAndBindingOffsets(MaweBoot.DATA, { preferFrames: false });
  return { repairedGroupReferenceCount, repairedTimingCount };
}

// 新手引导通过窄桥接访问编辑器核心状态；引导本身在 editor-onboarding.js 中按需初始化。
function publishEditorBridge() {
  window.MAWE_EDITOR_BRIDGE = Object.freeze({
    get data() { return MaweBoot.DATA; },
    get selectedIdxs() { return MaweSelection.selectedIdxs; },
    get currentCuePanelIdx() { return MaweCuePanelState.currentCuePanelIdx; },
    get container() { return MaweCoreState.container; },
    get projectMediaModal() { return MaweDom.projectMediaModal; },
    selectOnly: MaweSelection.selectOnly,
    performUndo: MaweHistory.performUndo,
    flashHint: MaweHint.flashHint,
    scrollCueToCenter: MaweCueListAnchor.scrollCueToCenter,
    setEditorSettingsPanelOpen: MaweSettingsPanels.setEditorSettingsPanelOpen,
    modKeyLabel: MaweDisplaySettings.modKeyLabel,
    splitKeyLabel: MaweDisplaySettings.splitKeyLabel,
    openHelp: () => MaweHelpPanel.helpFloatingPanel.open(),
    openHelpAtTab: MaweHelpPanel.openHelpAtTab,
    closeHelp: () => MaweHelpPanel.helpFloatingPanel.close(),
  });
  window.MAWE?.register('editor-bridge', () => window.MAWE_EDITOR_BRIDGE);
}

// 首帧渲染 + 修复提示 + 服务器连接/延迟资源。
function renderFirstFrame() {
  MaweTextCleanup.cleanPunctuation();
  MaweServerSave.configureServerSaveControls();
  MaweServerSave.configureServerAutoSave();
  MaweServerSave.configureRecentProjects();
  MaweServerSave.configureServerProjectSettings();
  MaweWaveformInit.initWaveformEditor();
  MaweWorkspaces.configureServerWorkspaceLibrary();
  MaweWorkspaces.configureWorkspaceTransfer();
  MaweDom.totalCountEl.textContent = String(MaweBoot.DATA.segments.length);
  MaweCuePanel.renderAll({ waveform: 'full' });
  getMaweState().noteSavedSegments();
  MaweBoot.maweDebug('boot:complete', {
    renderedSegments: MaweCoreState.container?.querySelectorAll?.('.cue-row')?.length || 0,
    recentProjectsVisible: MaweDom.recentProjectsEl ? !MaweDom.recentProjectsEl.hidden : false,
    mediaName: MaweProjectSave.mediaNameEl?.textContent || '',
    placeholderVisible: MaweDom.playerEmpty ? !MaweDom.playerEmpty.hidden : null,
  });
  MaweGapRemoveUi.updateGapRemoveUi();
  void MaweServerConnection.loadServerStartup();
  MaweServerConnection.startServerConnectionMonitor();
  if (MaweBoot.SERVER_CONFIG?.startupStatus !== 'loading') void MaweWaveformInit.loadDeferredReapeaks();
}

// 启动工具栏与离开提示的接线。
function bindStartupControls() {
  document.getElementById('filter-over')?.addEventListener('click', (e) => {
    e.currentTarget.classList.toggle('active');
    e.currentTarget.setAttribute('aria-pressed', String(e.currentTarget.classList.contains('active')));
    if (!e.currentTarget.classList.contains('active')) {
      MaweCueElements.clearTemporaryVisibleSplitCues();
    }
    MaweSearch.applySearch(MaweDom.searchEl.value);
  });

  // 「隐藏禁用项」开关：开启后禁用项 display:none，并从选中集移除
  MaweDom.hideDisabledToggle?.addEventListener('change', () => {
    const cueListAnchor = MaweCueListAnchor.captureCueListRenderAnchor();
    MaweDom.hideDisabled = MaweDom.hideDisabledToggle.checked;
    MaweSettings.updateEditorSettings({ cueListHideDisabled: MaweDom.hideDisabled });
    MaweCoreState.container.classList.toggle('hide-disabled', MaweDom.hideDisabled);
    if (MaweDom.hideDisabled) {
      // 清理选中集中的禁用项（隐藏了但还留在选中集会造成状态不一致）
      [...MaweSelection.selectedIdxs].forEach(i => {
        if (MaweBoot.DATA.segments[i]?.disabled) {
          getMaweState().selection.remove('main', i);
          const el = MaweCoreState.container.querySelector(`.cue[data-idx="${i}"]`);
          if (el) el.classList.remove('selected');
        }
      });
      const extensionTrack = MaweMultiSubtitleCore.getActiveExtensionTrack();
      [...MaweSelection.selectedExtensionIdxs].forEach((index) => {
        if (extensionTrack?.segments[index]?.disabled) getMaweState().selection.remove('extension', index);
      });
      MaweSelection.updateMultiSelectionClasses();
      updateSelectionCountText();
      if (MaweCoreState.waveformEditor) MaweCoreState.waveformEditor.updateSelection();
    }
    if (MaweCoreState.waveformEditor) MaweCoreState.waveformEditor.updateDisabledVisibility();
    MaweCueListAnchor.restoreCueListRenderAnchor(cueListAnchor);
  });

  // 离开提示
  window.addEventListener('beforeunload', (e) => {
    if (MaweServerSave.hasUnsavedProjectChanges()) { e.preventDefault(); e.returnValue = ''; }
  });
}

// 修复提示要等首帧渲染完再弹（提示条会抢焦点）。
function finishStartup({ repairedGroupReferenceCount, repairedTimingCount }) {
  if (repairedTimingCount > 0) {
    MaweHint.flashHint(`已自动修复 ${repairedTimingCount} 处异常时间码（保底 100ms）`, 'warning');
  } else if (repairedGroupReferenceCount > 0) {
    MaweHint.flashHint(`已自动修复 ${repairedGroupReferenceCount} 处分组引用`, 'warning');
  }
}
