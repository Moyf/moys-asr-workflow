




// 浮窗尺寸：与帮助窗口一致，仅在用户拖过右下角缩放手柄后持久化；
// 未缩放时保持 CSS 默认宽度/自动高度。


if (MaweDom.editorSettingsPanel) {
  new ResizeObserver(() => {
    if (!MaweDom.editorSettingsPanel.classList.contains('show')) return;
    if (!MaweDom.editorSettingsPanel.style.width && !MaweDom.editorSettingsPanel.style.height) return;
    clearTimeout(MaweSettingsPanels.editorSettingsPanelSizeSaveTimer);
    MaweSettingsPanels.editorSettingsPanelSizeSaveTimer = setTimeout(() => {
      const rect = MaweDom.editorSettingsPanel.getBoundingClientRect();
      try {
        localStorage.setItem(MaweDom.EDITOR_SETTINGS_WINDOW_SIZE_KEY, JSON.stringify({
          width: Math.round(rect.width), height: Math.round(rect.height),
        }));
      } catch (_) {
        // file:// 隐私模式下 localStorage 可能被拒；缩放本身仍可用。
      }
    }, 250);
  }).observe(MaweDom.editorSettingsPanel);
}




































overlayTrackToggle?.addEventListener('change', () => {
  const overlay = getOverlayTrack();
  if (!overlay) return;
  overlay.enabled = overlayTrackToggle.checked;
  overlay._dirty = true;
  MaweViewUpdates.invalidate({ save: true });
  MaweCuePanel.renderAll({ waveform: 'full' });
  if (overlayTrackToggle.checked) {
    MaweHint.flashHint('已允许字幕重叠；Ctrl+拖拽波形空白或用右键菜单可创建叠加字幕', 'success');
  }
});













// macOS 用 ⌘（Cmd）替代 Ctrl；Win/Linux 仍显示 Ctrl。






// 把帮助面板等静态 <kbd data-mod-key> 与「拆分按键」下拉选项文本按平台替换。




// 切换语言时 i18n 会重置动态文本节点，需重新套用当前拆分按键提示和目标轨道标签。
document.addEventListener('mawe:languagechange', () => {
  MaweSplitMode.refreshSplitKeyHelp();
  MaweCuePanel.renderCurrentCuePanel();
  MaweTimeline.refreshTimelineSettingsUi();
  MaweMediaPlayback.refreshMediaSeekStepHelp();
  MaweMediaPlayback.refreshMediaSeekControlLabels();
  updateAssStyleLibrarySummary();
  updateAssStyleLibraryStatus();
  updateAssStylePreviewModeHints();
});

MaweDom.splitKeySel.value = MaweSettings.EDITOR_SETTINGS.splitKey;
if (MaweDom.splitUseWordTimestampsToggle) MaweDom.splitUseWordTimestampsToggle.checked = MaweSettings.EDITOR_SETTINGS.splitUseWordTimestamps;
if (MaweDom.multiSubtitleSplitAutoSubmit) MaweDom.multiSubtitleSplitAutoSubmit.checked = MaweSettings.EDITOR_SETTINGS.splitAutoSubmit;
MaweDisplaySettings.applyPlatformKeyLabels();
MaweSplitMode.refreshSplitKeyHelp();
if (MaweDom.mergeJoinTextContinuousInput) MaweDom.mergeJoinTextContinuousInput.value = MaweSettings.EDITOR_SETTINGS.mergeJoinTextContinuous;
if (MaweDom.mergeJoinTextWordInput) MaweDom.mergeJoinTextWordInput.value = MaweSettings.EDITOR_SETTINGS.mergeJoinTextWord;
// 「合并字幕时插入字符」旁的提示：显示当前主字幕拆分类型（自动检测或已指定），
// 并提供一键切换。手动指定的类型存入 EDITOR_SETTINGS.mainSplitModeOverride
// （本地偏好，多重字幕开关无关），同时同步 multi_subtitle.main_split_mode，
// 与多重字幕菜单的「主字幕语言类型」互为镜像。






MaweSplitMode.mergeJoinModeSwitch?.addEventListener('click', () => {
  MaweSplitMode.setMainSubtitleSplitModeBinding(MaweSplitMode.mergeJoinModeSwitch.dataset.targetMode);
});
MaweSegmentOps.syncAutoMergePanelInputs();
MaweDom.overlayToggle.checked = MaweSettings.EDITOR_SETTINGS.overlayEnabled;
if (MaweDom.extensionOverlayToggle) MaweDom.extensionOverlayToggle.checked = false;
MaweDom.exportStartAtZeroToggle.checked = MaweSettings.EDITOR_SETTINGS.exportStartAtZero;
if (MaweDom.selectGroupMembersToggle) MaweDom.selectGroupMembersToggle.checked = MaweSettings.EDITOR_SETTINGS.selectGroupMembers;
if (MaweDom.exportColorUnifiedToggle) MaweDom.exportColorUnifiedToggle.checked = MaweSettings.EDITOR_SETTINGS.exportColorUnified;
if (MaweDom.exportSpeakerLabelsToggle) MaweDom.exportSpeakerLabelsToggle.checked = MaweSettings.EDITOR_SETTINGS.exportSpeakerLabels;
if (MaweDom.exportSpeakerNamesAsSuffixToggle) {
  MaweDom.exportSpeakerNamesAsSuffixToggle.checked = MaweSettings.EDITOR_SETTINGS.exportSpeakerNamesAsSuffix;
}
if (MaweDom.autoSaveProjectToggle) MaweDom.autoSaveProjectToggle.checked = MaweSettings.EDITOR_SETTINGS.autoSaveProject;
if (MaweDom.autoSaveIntervalInput) MaweDom.autoSaveIntervalInput.value = String(MaweSettings.EDITOR_SETTINGS.autoSaveIntervalSeconds);
if (MaweDom.stickerOverlayToggle) MaweDom.stickerOverlayToggle.checked = MaweSettings.EDITOR_SETTINGS.stickerOverlayEnabled;
if (MaweDom.clickBehaviorSelect) MaweDom.clickBehaviorSelect.value = MaweSettings.EDITOR_SETTINGS.clickBehavior;
if (MaweDom.clickTargetSelect) MaweDom.clickTargetSelect.value = MaweSettings.EDITOR_SETTINGS.clickTarget;
if (pauseOnMouseClickToggle) pauseOnMouseClickToggle.checked = MaweSettings.EDITOR_SETTINGS.pauseOnMouseClick;
if (MaweDom.keyboardOperationReferenceSelect) {
  MaweDom.keyboardOperationReferenceSelect.value = MaweSettings.EDITOR_SETTINGS.keyboardOperationReference;
}
if (MaweJklPlayback.jklPlaybackModeSelect) MaweJklPlayback.jklPlaybackModeSelect.value = MaweSettings.EDITOR_SETTINGS.jklPlaybackMode;
if (MaweDom.hoverSeekPreviewToggle) MaweDom.hoverSeekPreviewToggle.checked = MaweSettings.EDITOR_SETTINGS.hoverSeekPreview;
if (MaweDom.mediaSeekStepInput) MaweDom.mediaSeekStepInput.value = String(MaweSettings.EDITOR_SETTINGS.mediaSeekStepMs);
if (MaweDom.cueMoveStepInput) MaweDom.cueMoveStepInput.value = String(MaweSettings.EDITOR_SETTINGS.cueMoveStepMs);
if (MaweDom.timelineTimebaseSelect) MaweDom.timelineTimebaseSelect.value = MaweTimeline.projectTimebase().unit;
if (MaweDom.timelineFpsInput) MaweDom.timelineFpsInput.value = String(MaweTimeline.projectTimebase().fps);
if (MaweDom.timelineSnapToFrameToggle) MaweDom.timelineSnapToFrameToggle.checked = MaweSettings.EDITOR_SETTINGS.timelineSnapToFrame;
if (MaweDom.timelineTimecodeSeparatorInput) {
  MaweDom.timelineTimecodeSeparatorInput.value = MaweTimeline.normalizeTimelineTimecodeSeparator(
    MaweSettings.EDITOR_SETTINGS.timelineTimecodeSeparator,
  );
}
if (MaweDom.autoSnapAdjacentCuesToggle) {
  MaweDom.autoSnapAdjacentCuesToggle.checked = MaweSettings.EDITOR_SETTINGS.autoSnapAdjacentCues;
}
if (MaweDom.adjacentBoundaryModeSelect) MaweDom.adjacentBoundaryModeSelect.value = MaweSettings.EDITOR_SETTINGS.adjacentBoundaryMode;
MaweTimeline.refreshAdjacentBoundaryModeUi();
if (MaweDom.cueEditorCancelOnEscapeToggle) {
  MaweDom.cueEditorCancelOnEscapeToggle.checked = MaweSettings.EDITOR_SETTINGS.cueEditorCancelOnEscape;
}
MaweTimeline.refreshTimelineSettingsUi();
MaweMediaPlayback.refreshMediaSeekStepHelp();
MaweMediaStep.refreshMediaSeekInputStep();
MaweMediaPlayback.refreshMediaSeekControlLabels();
MaweNinja.applyNinjaSettings();

if (MaweDom.waveformShapeSourceSelect) {
  MaweDom.waveformShapeSourceSelect.value = MaweSettings.EDITOR_SETTINGS.waveShapeSource;
  MaweDom.waveformShapeSourceSelect.addEventListener('change', () => {
    MaweSettings.EDITOR_SETTINGS.waveShapeSource = MaweDom.waveformShapeSourceSelect.value === 'reapeaks' ? 'reapeaks' : 'self';
    MaweSettings.saveEditorSettings(MaweSettings.EDITOR_SETTINGS);
    if (MaweCoreState.waveformEditor) MaweCoreState.waveformEditor.render();
  });
}
MaweDisplaySettings.applyCueListDisplaySettings({ preserveCueListScroll: false });
MaweDisplaySettings.applyCueEditorDisplaySettings();
MaweDom.multiSubtitleToggle?.addEventListener('change', () => {
  const multi = MaweMultiSubtitleCore.getMultiSubtitleState();
  const next = MaweDom.multiSubtitleToggle.checked;
  const promptImportSecondSrt = next && !MaweMultiSubtitleCore.getActiveExtensionTrack();
  multi.enabled = !next;
  return MaweCommands.run(next ? '开启双语字幕' : '关闭双语字幕', (command) => {
    multi.enabled = next;
    multi._dirty = true;
    // 开关会改变波形是否需要副字幕 lane，因此这里才执行完整波形重建。
    command.commit({ cueList: true, waveform: 'full' });
    if (!promptImportSecondSrt) return;
    // 多重字幕模式已开启；提示只决定是否现在导入第二条字幕，
    // 用户取消导入也保持开启，之后仍可拖入 SRT 或重新走导入流程。
    if (!confirm(MaweMultiSubtitleCore.MULTI_SUBTITLE_IMPORT_PROMPT)) return;
    MaweMultiSubtitleCore.pendingSrtImportAsExtension = true;
    MaweProjectMediaInputs.loadSrtFileInput.value = '';
    MaweProjectMediaInputs.loadSrtFileInput.click();
  });
});
MaweDom.multiSubtitleDisplayMode?.addEventListener('change', () => {
  const multi = MaweMultiSubtitleCore.getMultiSubtitleState();
  const next = MaweDom.multiSubtitleDisplayMode.value;
  const previous = multi.display_mode;
  multi.display_mode = previous;
  return MaweCommands.run('切换双语字幕列表', (command) => {
    multi.display_mode = MULTI_SUBTITLE_UTILS.MULTI_SUBTITLE_DISPLAY_MODES.has(next) ? next : 'both';
    multi._dirty = true;
    command.commit({ cueList: true, waveform: 'none' });
  });
});
MaweDom.multiSubtitleMainLanguageMode?.addEventListener('change', () => {
  const multi = MaweMultiSubtitleCore.getMultiSubtitleState();
  const next = MaweMultiSubtitleCore.isConfiguredSubtitleSplitMode(MaweDom.multiSubtitleMainLanguageMode.value)
    ? MaweDom.multiSubtitleMainLanguageMode.value : 'word';
  if (multi.main_split_mode === next
      && MaweSettings.EDITOR_SETTINGS.mainSplitModeOverride === next) return;
  return MaweCommands.run('切换主字幕语言类型', (command) => {
    multi.main_split_mode = next;
    // 与设置面板的类型提示共用同一个手动指定偏好，两个入口互为镜像。
    MaweSettings.updateEditorSettings({ mainSplitModeOverride: next });
    MaweMultiSubtitleCore.markMultiSubtitleDirty();
    command.commit({ cueList: true, waveform: 'none' });
  });
});
MaweDom.multiSubtitleExtensionLanguageMode?.addEventListener('change', () => {
  const track = MaweMultiSubtitleCore.getActiveExtensionTrack();
  if (!track) return;
  const next = MaweMultiSubtitleCore.isConfiguredSubtitleSplitMode(MaweDom.multiSubtitleExtensionLanguageMode.value)
    ? MaweDom.multiSubtitleExtensionLanguageMode.value : 'word';
  if (track.split_mode === next) return;
  return MaweCommands.run('切换副字幕语言类型', (command) => {
    track.split_mode = next;
    MaweMultiSubtitleCore.markMultiSubtitleDirty();
    command.commit({ cueList: true, waveform: 'none' });
  });
});
MaweDom.multiSubtitleExtensionRowHeight?.addEventListener('change', () => {
  const next = MaweSettings.normalizeMultiSubtitleRowHeight(MaweDom.multiSubtitleExtensionRowHeight.value);
  MaweSettings.updateEditorSettings({ multiSubtitleRowHeight: next });
  if (MaweMultiSubtitleCore.multiSubtitleVisible()) MaweCoreState.waveformEditor?.setRowHeight(next);
});
MaweDom.multiSubtitleCrossTrackSnapToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ crossTrackSnap: MaweDom.multiSubtitleCrossTrackSnapToggle.checked });
});
MaweDom.multiSubtitleSelectBoundPairToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ selectBoundSubtitlePair: MaweDom.multiSubtitleSelectBoundPairToggle.checked });
});
MaweDom.multiSubtitleAutoSyncDurationToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ multiSubtitleAutoSyncDuration: MaweDom.multiSubtitleAutoSyncDurationToggle.checked });
});
MaweDom.multiSubtitleShowTrackBadgesToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ multiSubtitleShowTrackBadges: MaweDom.multiSubtitleShowTrackBadgesToggle.checked });
  MaweCoreState.waveformEditor?.render?.();
});
MaweDom.multiSubtitleSwapButton?.addEventListener('click', () => {
  MaweMultiImport.swapMainAndExtensionSubtitles();
});
MaweDom.multiSubtitleAlignButton?.addEventListener('click', () => {
  MaweBindingAlign.alignSelectedExtensionSubtitleRanges();
});
MaweAppearance.applySubtitleAppearance();
MaweAppearance.applyExtensionSubtitleAppearance();
syncAssModeControl();
syncAssStyleManager();
void loadAssStyleLibrary();
// 开/关由 createFloatingPanel 的 manageButton 点击切换接管，这里只负责标签页与关闭按钮。
