











MaweTheme.applyEditorAccentColor(MaweSettings.EDITOR_SETTINGS.accentColor, { rerenderWaveform: false });
MaweTheme.applyTheme(MaweSettings.EDITOR_SETTINGS.theme, { rerenderWaveform: false });
MaweDom.editorThemeOptions.forEach((option) => {
  option.addEventListener('click', () => {
    const next = MaweTheme.normalizeEditorTheme(option.dataset.editorTheme);
    MaweSettings.updateEditorSettings({ theme: next });
    MaweTheme.applyTheme(next);
  });
});
MaweDom.editorAccentOptions.forEach((option) => {
  option.addEventListener('click', () => {
    if (MaweTheme.pendingEditorAccentCustomColor !== null) MaweTheme.flushEditorAccentCustomColor();
    const next = MaweSettings.normalizeEditorAccentColor(option.dataset.editorAccent);
    MaweSettings.updateEditorSettings({ accentColor: next });
    MaweTheme.applyEditorAccentColor(next);
  });
});
MaweDom.editorAccentCustomInput?.addEventListener('input', () => {
  const customColor = MaweSettings.normalizeEditorAccentCustomColor(MaweDom.editorAccentCustomInput.value);
  if (MaweDom.editorAccentCustomValue) MaweDom.editorAccentCustomValue.textContent = customColor;
  MaweTheme.scheduleEditorAccentCustomColor(customColor);
});
MaweDom.editorAccentCustomInput?.addEventListener('change', () => {
  MaweTheme.flushEditorAccentCustomColor(MaweDom.editorAccentCustomInput.value);
});


if (MaweTheme.editorSystemThemeMedia?.addEventListener) {
  MaweTheme.editorSystemThemeMedia.addEventListener('change', MaweTheme.refreshEditorSystemTheme);
} else {
  MaweTheme.editorSystemThemeMedia?.addListener?.(MaweTheme.refreshEditorSystemTheme);
}
MaweDom.splitKeySel.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ splitKey: MaweDom.splitKeySel.value });
  MaweSplitMode.refreshSplitKeyHelp();
});
MaweDom.splitUseWordTimestampsToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ splitUseWordTimestamps: MaweDom.splitUseWordTimestampsToggle.checked });
});
MaweDom.multiSubtitleSplitAutoSubmit?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ splitAutoSubmit: MaweDom.multiSubtitleSplitAutoSubmit.checked });
});
if (MaweDom.mergeJoinTextContinuousInput) MaweDom.mergeJoinTextContinuousInput.addEventListener('input', () => {
  MaweSettings.updateEditorSettings({ mergeJoinTextContinuous: MaweDom.mergeJoinTextContinuousInput.value });
});
if (MaweDom.mergeJoinTextWordInput) MaweDom.mergeJoinTextWordInput.addEventListener('input', () => {
  MaweSettings.updateEditorSettings({ mergeJoinTextWord: MaweDom.mergeJoinTextWordInput.value });
});
// 拆分移除符号：前 5 个高频符号用勾选 chip，其余走「其他符号」自由文本框
// （空格分隔）；两者合并后即时持久化并同步给共享工具层。










MaweSplitTrim.renderSplitTrimSymbolGrid();
MaweSplitTrim.refreshSplitTrimExtraInput();
MaweSplitTrim.splitTrimExtraInput?.addEventListener('change', () => {
  const extras = MULTI_SUBTITLE_UTILS.parseSplitTrimSymbolInput(MaweSplitTrim.splitTrimExtraInput.value);
  MaweSplitTrim.persistSplitTrimSymbols([...MaweSplitTrim.splitTrimPrimaryCheckedSet(), ...extras]);
  MaweSplitTrim.refreshSplitTrimExtraInput();
});
MaweSplitTrim.splitTrimSymbolsReset?.addEventListener('click', () => {
  const defaults = MULTI_SUBTITLE_UTILS.setSplitTrimSymbols(
    [...MULTI_SUBTITLE_UTILS.DEFAULT_SPLIT_TRIM_SYMBOLS],
  );
  MaweSettings.updateEditorSettings({ splitTrimSymbols: defaults });
  MaweSplitTrim.renderSplitTrimSymbolGrid();
  MaweSplitTrim.refreshSplitTrimExtraInput();
});
// 拼合字幕工具窗：参数即时持久化；number 输入 change 时把显示值回钳到合法区间。

MaweDom.autoMergeCloseButton?.addEventListener('click', () => MaweFloatingPanel.autoMergeFloatingPanel.close());
MaweDom.autoMergeRunButton?.addEventListener('click', MaweSegmentOps.autoMergeSegments);
MaweDom.autoMergeGapMsInput?.addEventListener('input', () => {
  MaweSettings.updateEditorSettings({ autoMergeGapMs: MaweSettings.clampAutoMergeGapMs(MaweDom.autoMergeGapMsInput.value) });
});
MaweDom.autoMergeGapMsInput?.addEventListener('change', () => {
  MaweDom.autoMergeGapMsInput.value = String(MaweSettings.EDITOR_SETTINGS.autoMergeGapMs);
});
MaweDom.autoMergeSnapDirectionSelect?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({
    autoMergeSnapDirection: MaweDom.autoMergeSnapDirectionSelect.value === 'forward' ? 'forward' : 'backward',
  });
});
MaweDom.autoMergeAbsorbShortToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ autoMergeAbsorbShort: MaweDom.autoMergeAbsorbShortToggle.checked });
  MaweSegmentOps.syncAutoMergeAbsorbFields();
});
MaweDom.autoMergeShortCountInput?.addEventListener('input', () => {
  MaweSettings.updateEditorSettings({ autoMergeShortCount: MaweSettings.clampAutoMergeShortCount(MaweDom.autoMergeShortCountInput.value) });
});
MaweDom.autoMergeShortCountInput?.addEventListener('change', () => {
  MaweDom.autoMergeShortCountInput.value = String(MaweSettings.EDITOR_SETTINGS.autoMergeShortCount);
});
MaweDom.autoMergeAbsorbDirectionSelect?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({
    autoMergeAbsorbDirection: MaweDom.autoMergeAbsorbDirectionSelect.value === 'next' ? 'next' : 'previous',
  });
});
MaweDom.autoMergePanel?.querySelectorAll('input[type="number"]').forEach((input) => {
  input.addEventListener('wheel', (event) => {
    if (!event.deltaY) return;
    event.preventDefault();
    input.focus({ preventScroll: true });
    try {
      if (event.deltaY < 0) input.stepUp();
      else input.stepDown();
    } catch (_) {
      return;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, { passive: false });
});

MaweDom.subtitleExtendCloseButton?.addEventListener('click', () => MaweFloatingPanel.subtitleExtendFloatingPanel.close());
MaweDom.subtitleExtendRunButton?.addEventListener('click', MaweSegmentOps.extendSubtitleRanges);
MaweDom.subtitleExtendPanel?.querySelectorAll('input[type="number"]').forEach((input) => {
  input.addEventListener('wheel', (event) => {
    if (!event.deltaY) return;
    event.preventDefault();
    input.focus({ preventScroll: true });
    try {
      if (event.deltaY < 0) input.stepUp();
      else input.stepDown();
    } catch (_) {
      return;
    }
  }, { passive: false });
});
