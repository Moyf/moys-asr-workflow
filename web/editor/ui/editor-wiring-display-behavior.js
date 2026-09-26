MaweDisplaySettings.bindCueListDisplayToggle(MaweDom.cueListShowIndexToggle, 'cueListShowIndex');
MaweDisplaySettings.bindCueListDisplayToggle(MaweDom.cueListShowTimeToggle, 'cueListShowTime');
MaweDisplaySettings.bindCueListDisplayToggle(MaweDom.cueListShowStickerToggle, 'cueListShowSticker');
MaweDisplaySettings.bindCueListDisplayToggle(MaweDom.cueListShowCharcountToggle, 'cueListShowCharcount');
MaweDisplaySettings.bindCueListDisplayToggle(MaweDom.cueListAutoScrollOnClickToggle, 'cueListAutoScrollOnClick');
MaweDom.cueListKeepSplitVisibleToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ cueListKeepSplitVisible: MaweDom.cueListKeepSplitVisibleToggle.checked });
  if (!MaweDom.cueListKeepSplitVisibleToggle.checked) MaweCueElements.clearTemporaryVisibleSplitCues();
  MaweSearch.applySearch(MaweDom.searchEl.value);
});
MaweDom.cueListCharcountThresholdInput?.addEventListener('input', () => {
  MaweCueElements.handleCharCountThresholdInput(MaweDom.cueListCharcountThresholdInput);
});
MaweDom.cueListCharcountThresholdInput?.addEventListener('change', () => {
  MaweCueElements.syncCharCountThresholdInputs();
  MaweCueElements.updateTimedTextEditSingleGuide();
});
MaweDom.timedTextEditCharcountThresholdInput?.addEventListener('input', () => {
  MaweCueElements.handleCharCountThresholdInput(MaweDom.timedTextEditCharcountThresholdInput);
});
MaweDom.timedTextEditCharcountThresholdInput?.addEventListener('change', () => {
  MaweCueElements.syncCharCountThresholdInputs();
  MaweCueElements.updateTimedTextEditSingleGuide();
});
MaweDisplaySettings.bindCueEditorDisplayToggle(MaweDom.cueEditorShowNavigationToggle, 'cueEditorShowNavigation');
MaweDisplaySettings.bindCueEditorDisplayToggle(MaweDom.cueEditorShowTimeActionsToggle, 'cueEditorShowTimeActions');
MaweDisplaySettings.bindCueEditorDisplayToggle(MaweDom.cueEditorShowStickerToggle, 'cueEditorShowSticker');
MaweDom.exportStartAtZeroToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ exportStartAtZero: MaweDom.exportStartAtZeroToggle.checked });
});
MaweDom.selectGroupMembersToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ selectGroupMembers: MaweDom.selectGroupMembersToggle.checked });
});
MaweDom.exportColorUnifiedToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ exportColorUnified: MaweDom.exportColorUnifiedToggle.checked });
});
MaweDom.exportSpeakerLabelsToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ exportSpeakerLabels: MaweDom.exportSpeakerLabelsToggle.checked });
});
MaweDom.exportSpeakerNamesAsSuffixToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ exportSpeakerNamesAsSuffix: MaweDom.exportSpeakerNamesAsSuffixToggle.checked });
});
MaweDom.clickBehaviorSelect?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ clickBehavior: MaweSettings.normalizeClickBehavior(MaweDom.clickBehaviorSelect.value) });
  MaweBehaviorHints.refreshClickBehaviorHint();
});
MaweDom.clickTargetSelect?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ clickTarget: MaweSettings.normalizeClickTarget(MaweDom.clickTargetSelect.value) });
});
pauseOnMouseClickToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ pauseOnMouseClick: pauseOnMouseClickToggle.checked });
});
MaweDom.keyboardOperationReferenceSelect?.addEventListener('change', () => {
  const mode = MaweSettings.normalizeKeyboardOperationReferenceMode(MaweDom.keyboardOperationReferenceSelect.value);
  MaweSettings.updateEditorSettings({ keyboardOperationReference: mode });
  MaweBehaviorHints.refreshKeyboardOperationReferenceHint();
});
MaweJklPlayback.jklPlaybackModeSelect?.addEventListener('change', () => {
  const wasReversePlaying = MaweJklPlayback.jklReversePlaying;
  MaweSettings.updateEditorSettings({ jklPlaybackMode: MaweSettings.normalizeJklPlaybackMode(MaweJklPlayback.jklPlaybackModeSelect.value) });
  MaweJklPlayback.stopJklReversePlayback({ render: false });
  MaweJklPlayback.jklPlaybackRate = 1;
  MaweCoreState.player.playbackRate = 1;
  if (wasReversePlaying) MawePlaybackLoop.update();
  MaweMediaPlayback.syncMediaControls();
  MaweJklPlayback.refreshJklPlaybackModeUi();
});
MaweDom.hoverSeekPreviewToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ hoverSeekPreview: MaweDom.hoverSeekPreviewToggle.checked });
});


























MaweDom.mediaSeekStepInput?.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  event.preventDefault();
  event.stopPropagation();
  MaweMediaStep.adjustMediaSeekStepInput(event.key === 'ArrowUp' ? 1 : -1);
});
MaweDom.mediaSeekStepInput?.addEventListener('wheel', (event) => {
  if (!event.deltaY) return;
  event.preventDefault();
  event.stopPropagation();
  MaweDom.mediaSeekStepInput.focus({ preventScroll: true });
  MaweMediaStep.adjustMediaSeekStepInput(event.deltaY < 0 ? 1 : -1);
}, { passive: false });
MaweDom.mediaSeekStepInput?.addEventListener('input', () => {
  const raw = MaweDom.mediaSeekStepInput.value.trim();
  if (!raw) return;
  if (MaweTimeline.timelineIsFrameMode()) {
    MaweMediaStep.commitMediaSeekStepInput(raw, { rewriteInput: false });
    return;
  }
  const value = MaweSettings.normalizeNativeMediaSeekStepValue(raw, MaweDom.mediaSeekInputLastValue);
  if (value === null) return;
  MaweMediaStep.commitMediaSeekStepInput(value, { rewriteInput: value !== Number(raw) });
});
MaweDom.mediaSeekStepInput?.addEventListener('change', () => {
  MaweMediaStep.commitMediaSeekStepInput(MaweDom.mediaSeekStepInput.value);
});
MaweDom.cueMoveStepInput?.addEventListener('change', () => {
  const frameMode = MaweTimeline.timelineIsFrameMode();
  const value = frameMode
    ? EDITOR_SETTINGS_UTILS.clampTimelineFrameStep(MaweDom.cueMoveStepInput.value, 1)
    : MaweSettings.clampCueMoveStepMs(MaweDom.cueMoveStepInput.value);
  MaweDom.cueMoveStepInput.value = String(value);
  MaweSettings.updateEditorSettings(frameMode ? { cueMoveStepFrames: value } : { cueMoveStepMs: value });
});
MaweDom.timelineTimebaseSelect?.addEventListener('change', () => {
  MaweTimeline.setTimelineTimebase({ unit: MaweDom.timelineTimebaseSelect.value });
});
MaweDom.timelineFpsInput?.addEventListener('change', () => {
  MaweTimeline.setTimelineTimebase({ fps: MaweDom.timelineFpsInput.value });
});
MaweDom.timelineSnapToFrameToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ timelineSnapToFrame: MaweDom.timelineSnapToFrameToggle.checked });
  MaweCoreState.waveformEditor?.refreshPointerLine?.();
});
MaweDom.timelineTimecodeSeparatorInput?.addEventListener('change', () => {
  const separator = MaweTimeline.normalizeTimelineTimecodeSeparator(MaweDom.timelineTimecodeSeparatorInput.value);
  MaweDom.timelineTimecodeSeparatorInput.value = separator;
  MaweSettings.updateEditorSettings({ timelineTimecodeSeparator: separator });
  MaweTimeline.refreshTimelineSettingsUi();
  MaweCoreState.waveformEditor?.refreshPointerLine?.();
  // 时间码分隔符会影响字幕列表里的时间范围文本；设置变更后立即重建列表，
  // 不必等到下一次字幕编辑操作才看到新格式。
  MaweCuePanel.renderAll({ waveform: 'none' });
});
MaweDom.autoSnapAdjacentCuesToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ autoSnapAdjacentCues: MaweDom.autoSnapAdjacentCuesToggle.checked });
});
// 贴合字幕边界模式：dual（中缝联动，新默认）/ classic（自动吸附开关 + Alt 反转）。
// classic 下保留“自动吸附调整相邻字幕”开关；dual 下该开关只影响键盘微调，
// 鼠标手柄始终独立，联动交给波形上的中缝拖动区，因此隐藏开关行避免误解。

MaweDom.adjacentBoundaryModeSelect?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({
    adjacentBoundaryMode: MaweDom.adjacentBoundaryModeSelect.value === 'classic' ? 'classic' : 'dual',
  });
  MaweTimeline.refreshAdjacentBoundaryModeUi();
  MaweCoreState.waveformEditor?.refreshCueOverlay?.();
});
MaweDom.cueEditorCancelOnEscapeToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ cueEditorCancelOnEscape: MaweDom.cueEditorCancelOnEscapeToggle.checked });
});
MaweDom.ninjaModeToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ ninjaMode: MaweDom.ninjaModeToggle.checked });
  MaweNinja.applyNinjaSettings();
});
MaweDom.ninjaSoundToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ ninjaSound: MaweDom.ninjaSoundToggle.checked });
});
MaweDom.ninjaSlashEffectToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ ninjaSlashEffect: MaweDom.ninjaSlashEffectToggle.checked });
  MaweNinja.applyNinjaSettings();
});
MaweDom.ninjaSlashLengthInput?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ ninjaSlashLengthPercent: MaweSettings.clampNinjaSlashLength(MaweDom.ninjaSlashLengthInput.value) });
  MaweDom.ninjaSlashLengthInput.value = String(MaweSettings.EDITOR_SETTINGS.ninjaSlashLengthPercent);
});
MaweDom.ninjaSlashRotateInput?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ ninjaSlashRotateAmplitude: MaweSettings.clampNinjaSlashRotateAmplitude(MaweDom.ninjaSlashRotateInput.value) });
  MaweDom.ninjaSlashRotateInput.value = String(MaweSettings.EDITOR_SETTINGS.ninjaSlashRotateAmplitude);
});
