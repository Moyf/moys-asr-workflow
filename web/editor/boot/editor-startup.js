
// === 启动 ===
// 兜底：工程可能带有上游写入的 0 长/倒挂段、词时间码（旧版工具或异常识别结果），
// 加载时统一拉齐到至少 100ms，避免拆分后看不见字幕块、工程无法保存。
MaweTimeline.syncProjectTimebaseAndBindingOffsets(MaweBoot.DATA, { preferFrames: MaweBoot.DATA.timebase?.unit === 'frames' });
const repairedGroupReferenceCount = window.AsrEditorUtils.repairGroupReferenceIndices(MaweBoot.DATA.segments);
const repairedTimingCount = MaweJsonRepair.normalizeProjectTimings(MaweBoot.DATA);
// 服务器注入的工程里 markers 是 MOSP 包装对象（{schema, items}）；编辑器内部
// 统一用数组，写出文件时再经 markersToProjectField 包回。不在这里换掉的话，
// 轨道不渲染，且首次 markerList() 会把包装对象整个清掉。
MaweBoot.DATA.markers = window.AsrEditorUtils.normalizeMarkers(MaweBoot.DATA.markers);
MaweTimeline.syncProjectTimebaseAndBindingOffsets(MaweBoot.DATA, { preferFrames: false });
MaweBoot.maweDebug('boot:begin', {
  server: Boolean(MaweBoot.SERVER_CONFIG),
  segments: Array.isArray(MaweBoot.DATA.segments) ? MaweBoot.DATA.segments.length : null,
  media: MaweBoot.DATA.media || '',
  recentProjects: MaweBoot.SERVER_CONFIG?.recentProjects?.length || 0,
});
MaweTextCleanup.cleanPunctuation();
MaweServerSave.configureServerSaveControls();
MaweServerSave.configureServerAutoSave();
MaweServerSave.configureRecentProjects();
MaweServerSave.configureServerProjectSettings();
MaweWaveformInit.initWaveformEditor();
MaweWorkspaces.configureServerWorkspaceLibrary();
MaweWorkspaces.configureWorkspaceTransfer();
MaweDom.totalCountEl.textContent = MaweBoot.DATA.segments.length;
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
MaweState.noteSavedSegments();
MaweBoot.maweDebug('boot:complete', {
  renderedSegments: MaweCoreState.container?.querySelectorAll?.('.cue-row')?.length || 0,
  recentProjectsVisible: MaweDom.recentProjectsEl ? !MaweDom.recentProjectsEl.hidden : false,
  mediaName: MaweProjectSave.mediaNameEl?.textContent || '',
  placeholderVisible: MaweDom.playerEmpty ? !MaweDom.playerEmpty.hidden : null,
});
MaweGapRemoveUi.updateGapRemoveUi();
if (repairedTimingCount > 0) {
  MaweHint.flashHint(`已自动修复 ${repairedTimingCount} 处异常时间码（保底 100ms）`, 'warning');
} else if (repairedGroupReferenceCount > 0) {
  MaweHint.flashHint(`已自动修复 ${repairedGroupReferenceCount} 处分组引用`, 'warning');
}
if (MaweHost.desktop.available() && MaweBoot.SERVER_CONFIG?.desktopMediaError) {
  MaweProjectLoad.updateUnloadedMediaLabel(MaweBoot.DATA.media);
  MaweHint.flashHint(
    `工程字幕已打开，但关联媒体不可用：${MaweBoot.SERVER_CONFIG.desktopMediaError}。请使用“加载媒体”重新定位。`,
    'warning',
  );
}
void MaweServerConnection.loadServerStartup();
MaweServerConnection.startServerConnectionMonitor();
if (MaweBoot.SERVER_CONFIG?.startupStatus !== 'loading') void MaweWaveformInit.loadDeferredReapeaks();

document.getElementById('filter-over')?.addEventListener('click', (e) => {
  e.currentTarget.classList.toggle('active');
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
    updateSelectionCountText();
    if (MaweCoreState.waveformEditor) MaweCoreState.waveformEditor.updateSelection();
  }
  if (MaweCoreState.waveformEditor) MaweCoreState.waveformEditor.updateDisabledVisibility();
  MaweCueListAnchor.restoreCueListRenderAnchor(cueListAnchor);
});

// 离开提示
let suppressBeforeUnload = false;
window.addEventListener('beforeunload', (e) => {
  if (!suppressBeforeUnload && MaweServerSave.hasUnsavedProjectChanges()) { e.preventDefault(); e.returnValue = ''; }
});
window.MOSESuppressBeforeUnload = () => { suppressBeforeUnload = true; };

async function confirmDesktopProjectSwitch() {
  if (!MaweHost.desktop.available()) return true;
  if (!await MaweProjectSave.waitForProjectSaveIdle(60 * 60 * 1000)) return false;
  MaweProjectSave.flushInlineEditsForSave();
  const choice = await MaweHost.desktop.chooseProjectSwitchAction(
    MaweServerSave.hasUnsavedProjectChanges(), window.MAWE_I18N?.language,
  );
  if (choice.status !== 'ok' || choice.action === 'cancel') return false;
  if (choice.action === 'save') return Boolean(await MaweProjectSave.saveCurrentProject({ silent: false }));
  return true;
}

window.MOSEConfirmProjectSwitch = confirmDesktopProjectSwitch;

// === MOSE 桌面壳：真实路径工程切换 ===
// All project-opening routes (native picker, drop, file association, recent
// project) converge here. File paths themselves stay in the main process;
// renderer receives only a session-scoped opaque reference.
async function openDesktopProjectFile(file, mediaFile = null, { registeredFile = null } = {}) {
  if (!MaweHost.desktop.available()) return null;
  try {
    let projectResult = registeredFile
      ? { status: 'ok', file: registeredFile }
      : await MaweHost.desktop.registerFile(file, 'project');
    if (projectResult.status === 'error' && projectResult.error?.code === 'NO_NATIVE_PATH') return null;
    if (projectResult.status !== 'ok' || !projectResult.file?.id) {
      throw new Error(projectResult.error?.message || '无法读取工程文件路径');
    }
    let mediaRefId = null;
    if (mediaFile) {
      const mediaResult = await MaweHost.desktop.registerFile(mediaFile, 'media');
      if (mediaResult.status !== 'ok' || !mediaResult.file?.id) {
        throw new Error(mediaResult.error?.message || '无法读取拖入媒体的本机路径');
      }
      mediaRefId = mediaResult.file.id;
    }
    if (!await confirmDesktopProjectSwitch()) return false;
    const result = await MaweHost.desktop.command('openProject', {
      projectRefId: projectResult.file.id,
      mediaRefId,
    });
    if (result.status !== 'ok') throw new Error(result.error?.message || '工程未能打开');
    suppressBeforeUnload = true;
    window.location.reload();
    return true;
  } catch (error) {
    MaweHint.flashHint(`打开工程失败：${error.message || error}`, 'warning');
    return false;
  }
}

window.MOSEOpenDesktopProject = openDesktopProjectFile;
MaweHost.desktop.onProjectOpen((result) => {
  if (result?.status === 'ok' && result.file) {
    void openDesktopProjectFile(null, null, { registeredFile: result.file });
  }
});
MaweHost.desktop.onCloseRequest(({ requestId } = {}) => {
  if (!Number.isInteger(requestId)) return;
  void (async () => {
    if (MaweBoot.SERVER_CONFIG) MaweBoot.SERVER_CONFIG.desktopClosePending = true;
    const idle = await MaweProjectSave.waitForProjectSaveIdle(60 * 60 * 1000);
    if (!idle) {
      MaweHint.flashHint('保存仍在进行，窗口保持打开', 'warning');
      if (MaweBoot.SERVER_CONFIG) MaweBoot.SERVER_CONFIG.desktopClosePending = false;
      await MaweHost.desktop.confirmClose(requestId, false);
      return;
    }
    MaweProjectSave.flushInlineEditsForSave();
    const choice = await MaweHost.desktop.chooseCloseAction(
      requestId,
      MaweServerSave.hasUnsavedProjectChanges(),
      window.MAWE_I18N?.language,
    );
    if (choice.status !== 'ok' || choice.action === 'cancel') {
      if (MaweBoot.SERVER_CONFIG) MaweBoot.SERVER_CONFIG.desktopClosePending = false;
      await MaweHost.desktop.confirmClose(requestId, false);
      return;
    }
    if (choice.action === 'save') {
      const saved = await MaweProjectSave.saveCurrentProject({ silent: false });
      if (!saved) {
        if (MaweBoot.SERVER_CONFIG) MaweBoot.SERVER_CONFIG.desktopClosePending = false;
        await MaweHost.desktop.confirmClose(requestId, false);
        return;
      }
    }
    suppressBeforeUnload = true;
    const result = await MaweHost.desktop.confirmClose(requestId, true);
    if (result.status !== 'ok' || result.closed !== true) {
      suppressBeforeUnload = false;
      if (MaweBoot.SERVER_CONFIG) MaweBoot.SERVER_CONFIG.desktopClosePending = false;
    }
  })().catch(async (error) => {
    suppressBeforeUnload = false;
    if (MaweBoot.SERVER_CONFIG) MaweBoot.SERVER_CONFIG.desktopClosePending = false;
    MaweHint.flashHint(`关闭确认失败：${error?.message || error}`, 'warning');
    await MaweHost.desktop.confirmClose(requestId, false);
  });
});
MaweHost.desktop.onProjectStatus((status) => {
  void MaweServerSave.handleDesktopProjectStatus(status).catch((error) => {
    MaweHint.flashHint(`读取工程状态失败：${error?.message || error}`, 'warning');
  });
});
