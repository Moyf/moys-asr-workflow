











MaweTheme.applyEditorAccentColor(MaweSettings.EDITOR_SETTINGS.accentColor, { rerenderWaveform: false });
MaweTheme.applyTheme(MaweSettings.EDITOR_SETTINGS.theme, { rerenderWaveform: false });
const toastPositionSelect = document.getElementById('editor-toast-position');
const toastPosition = MaweHint.applyHintPosition(MaweSettings.EDITOR_SETTINGS.toastPosition);
if (toastPositionSelect) {
  toastPositionSelect.value = toastPosition;
  toastPositionSelect.addEventListener('change', () => {
    const value = MaweHint.applyHintPosition(toastPositionSelect.value);
    MaweSettings.updateEditorSettings({ toastPosition: value });
    toastPositionSelect.value = value;
    MaweHint.flashHint('消息提示位置已更新', 'success');
  });
}
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
  const extras = window.AsrEditorUtils.parseSplitTrimSymbolInput(MaweSplitTrim.splitTrimExtraInput.value);
  MaweSplitTrim.persistSplitTrimSymbols([...MaweSplitTrim.splitTrimPrimaryCheckedSet(), ...extras]);
  MaweSplitTrim.refreshSplitTrimExtraInput();
});
MaweSplitTrim.splitTrimSymbolsReset?.addEventListener('click', () => {
  const defaults = window.AsrEditorUtils.setSplitTrimSymbols(
    [...window.AsrEditorUtils.DEFAULT_SPLIT_TRIM_SYMBOLS],
  );
  MaweSettings.updateEditorSettings({ splitTrimSymbols: defaults });
  MaweSplitTrim.renderSplitTrimSymbolGrid();
  MaweSplitTrim.refreshSplitTrimExtraInput();
});
// Keep the open form as a draft. Only the explicit save buttons persist it.
(() => {
  const panel = MaweDom.autoMergePanel;
  const status = document.getElementById('auto-merge-settings-status');
  const saveUser = document.getElementById('auto-merge-user-save');
  const saveProject = document.getElementById('auto-merge-project-save');
  const inherit = document.getElementById('auto-merge-project-reset');
  let session = 0;
  let reading = false;
  let writing = false;
  let edited = false;

  function showStatus(message = '') {
    const scope = MaweProcessing.projectOverride('join') ? '此工程使用自己的拼合默认' : '此工程继承用户默认';
    const storage = MaweProcessing.portable ? '拼合默认仅存于当前浏览器' : '';
    const translate = window.MAWE_I18N?.translateText ?? ((value) => value);
    status.textContent = [scope, storage, message].filter(Boolean).map((part) => translate(part)).join(' · ');
    inherit.disabled = reading || writing || !MaweProcessing.projectOverride('join');
    saveUser.disabled = reading || writing;
    saveProject.disabled = reading;
    if (MaweDom.autoMergeRunButton) MaweDom.autoMergeRunButton.disabled = reading;
  }

  async function open() {
    const current = ++session;
    edited = false;
    reading = true;
    MaweSegmentOps.syncAutoMergePanelInputs();
    showStatus('正在读取用户配置…');
    const ok = await MaweProcessing.refresh();
    if (current !== session) return;
    reading = false;
    if (!edited) MaweSegmentOps.syncAutoMergePanelInputs();
    showStatus(ok ? '' : '无法读取用户配置');
  }

  MaweDom.autoMergeCloseButton?.addEventListener('click', () => MaweFloatingPanel.autoMergeFloatingPanel.close());
  MaweDom.autoMergeRunButton?.addEventListener('click', MaweSegmentOps.autoMergeSegments);
  panel.addEventListener('input', () => { edited = true; });
  panel.addEventListener('change', () => {
    edited = true;
    MaweSegmentOps.syncAutoMergePanelInputs(MaweSegmentOps.readAutoMergePanelInputs());
  });
  saveUser.addEventListener('click', async () => {
    const join = MaweSegmentOps.readAutoMergePanelInputs();
    const current = session;
    writing = true;
    showStatus();
    const outcome = await MaweProcessing.update((draft) => { draft.join = join; });
    writing = false;
    if (current !== session) {
      showStatus();
      return;
    }
    showStatus(outcome === 'saved' ? '用户配置已保存'
      : outcome === 'conflict' ? '另一窗口已更新配置，草稿已保留。请核对预设后重试。' : '无法保存用户配置');
  });
  saveProject.addEventListener('click', () => {
    MaweProcessing.setProjectOverride('join', MaweSegmentOps.readAutoMergePanelInputs());
    showStatus();
  });
  inherit.addEventListener('click', () => {
    MaweProcessing.setProjectOverride('join', undefined);
    MaweSegmentOps.syncAutoMergePanelInputs();
    showStatus();
  });
  MaweState.observeProjectLoad(() => {
    session++;
    MaweFloatingPanel.autoMergeFloatingPanel.close();
  });
  document.addEventListener('mawe:languagechange', () => {
    if (MaweFloatingPanel.autoMergeFloatingPanel.isOpen()) showStatus();
  });
  window.MaweSubtitleJoinSettings = Object.freeze({ open });
})();

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
// G07：init 化的 UI 模块经 window 延迟取用本文件的
// 运行时入口；classic 调用方不受影响。
window.MaweThemeSplitWiring = window.MaweThemeSplitWiring || Object.freeze({
  toastPosition,
});
