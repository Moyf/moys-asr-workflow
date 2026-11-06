
// === 启动 ===
MaweState.beginProjectSession();
MaweState.setSnapshotReader(MaweJsonRepair.projectSnapshot);
const timingBeforeStartup = MaweJsonRepair.projectTimingSignature(MaweBoot.DATA);
// 兜底：工程可能带有上游写入的 0 长/倒挂段、词时间码（旧版工具或异常识别结果），
// 加载时统一拉齐到至少 100ms，避免拆分后看不见字幕块、工程无法保存。
MaweTimeline.syncProjectTimebaseAndBindingOffsets(MaweBoot.DATA, { preferFrames: MaweBoot.DATA.timebase?.unit === 'frames' });
const repairedGroupReferenceCount = window.AsrEditorUtils.repairGroupReferenceIndices(window.AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments);
const repairedTimingCount = MaweJsonRepair.normalizeProjectTimings(MaweBoot.DATA, { preserveValid: true });
// 服务器注入的工程里 markers 是 MOSP 包装对象（{schema, items}）；编辑器内部
// 统一用数组，写出文件时再经 markersToProjectField 包回。不在这里换掉的话，
// 轨道不渲染，且首次 markerList() 会把包装对象整个清掉。
MaweJsonRepair.setMarkerContainer(MaweBoot.DATA.markers);
MaweBoot.DATA.markers = window.AsrEditorUtils.normalizeMarkers(MaweBoot.DATA.markers);
// 带 markers 的工程（如 AI 整理产物）默认启用标记轨道，方便直接复核待确认项。
window.MaweMarkerEditing?.enableForProjectMarkers?.(MaweBoot.DATA.markers);
MaweTimeline.syncProjectTimebaseAndBindingOffsets(MaweBoot.DATA, { preferFrames: false });
// Server/portable startup injects DATA directly instead of applyCanonicalProject.
// Repair legacy group ranges before the first render and saved fingerprint.
MaweTextCleanup.syncTimelineGroupRanges();
MaweBoot.maweDebug('boot:begin', {
  server: Boolean(MaweBoot.SERVER_CONFIG),
  segments: Array.isArray(window.AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments) ? window.AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length : null,
  media: MaweBoot.DATA.media || '',
  recentProjects: MaweBoot.SERVER_CONFIG?.recentProjects?.length || 0,
});
MaweServerSave.configureServerSaveControls();
MaweServerSave.configureServerAutoSave();
MaweServerSave.configureRecentProjects();
MaweServerSave.configureServerProjectSettings();
MaweWaveformInit.initWaveformEditor();
MaweWorkspaces.configureServerWorkspaceLibrary();
MaweWorkspaces.configureWorkspaceTransfer();
MaweDom.totalCountEl.textContent = window.AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length;
// 新手引导通过这个窄桥接访问编辑器核心状态；引导本身在 editor-onboarding.js 中按需初始化。
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
MaweCuePanel.renderAll({ waveform: 'full' });
const importedProjectChanges = MaweBoot.SERVER_CONFIG?.projectImportChanges || [];
MaweJsonRepair.noteImportReport(importedProjectChanges);
const startupContentRepaired = repairedTimingCount > 0 || repairedGroupReferenceCount > 0
  || timingBeforeStartup !== MaweJsonRepair.projectTimingSignature(MaweBoot.DATA)
  || MaweJsonRepair.importRequiresSave(importedProjectChanges);
MaweState.establishProjectCheckpoint({ repaired: startupContentRepaired });
if (MaweJsonRepair.importRequiresSave(importedProjectChanges)) {
  MaweServerSave.projectImportDirty = true;
  MaweHint.flashHint(`导入修复了 ${importedProjectChanges.length} 处工程字段；请检查后保存`, 'warning');
}
MaweBoot.maweDebug('boot:complete', {
  renderedSegments: MaweCoreState.container?.querySelectorAll?.('.cue-row')?.length || 0,
  recentProjectsVisible: MaweDom.recentProjectsEl ? !MaweDom.recentProjectsEl.hidden : false,
  mediaName: MaweProjectSave.mediaNameEl?.textContent || '',
  placeholderVisible: MaweDom.playerEmpty ? !MaweDom.playerEmpty.hidden : null,
});
MaweGapRemoveUi.updateGapRemoveUi();
if (repairedTimingCount > 0) {
  MaweHint.flashHint(`已自动修复 ${repairedTimingCount} 处异常时间码（保底 100ms）`, 'warning');
} else if (startupContentRepaired && repairedGroupReferenceCount === 0) {
  MaweHint.flashHint('已修复工程数据，请保存修复结果', 'warning');
} else if (repairedGroupReferenceCount > 0) {
  MaweHint.flashHint(`已自动修复 ${repairedGroupReferenceCount} 处分组引用`, 'warning');
}
void MaweServerConnection.loadServerStartup();
MaweServerConnection.startServerConnectionMonitor();
if (MaweBoot.SERVER_CONFIG?.startupStatus !== 'loading') void MaweWaveformInit.loadDeferredReapeaks();

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
      if (window.AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[i]?.disabled) {
        MaweState.selection.remove('main', i);
        const el = MaweCoreState.container.querySelector(`.cue[data-idx="${i}"]`);
        if (el) el.classList.remove('selected');
      }
    });
    const extensionTrack = MaweMultiSubtitleCore.getActiveExtensionTrack();
    [...MaweSelection.selectedExtensionIdxs].forEach((index) => {
      if (extensionTrack?.segments[index]?.disabled) MaweState.selection.remove('extension', index);
    });
    MaweSelection.updateMultiSelectionClasses();
    window.MaweCuePanelWiring.updateSelectionCountText();
    if (MaweCoreState.waveformEditor) MaweCoreState.waveformEditor.updateSelection();
  }
  if (MaweCoreState.waveformEditor) MaweCoreState.waveformEditor.updateDisabledVisibility();
  MaweCueListAnchor.restoreCueListRenderAnchor(cueListAnchor);
});

// 离开提示
window.addEventListener('beforeunload', (e) => {
  if (MaweServerSave.hasUnsavedProjectChanges()) { e.preventDefault(); e.returnValue = ''; }
});
