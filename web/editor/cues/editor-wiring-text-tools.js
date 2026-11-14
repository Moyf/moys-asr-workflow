// 「左右添加字符」自定义弹窗：左右两个输入框原样插入到选中字幕两端。
document.getElementById('wrap-chars-cancel')?.addEventListener('click', MaweTextProcess.closeWrapCharsModal);
MaweTextProcess.wrapCharsModal?.addEventListener('click', (event) => {
  if (event.target === MaweTextProcess.wrapCharsModal) MaweTextProcess.closeWrapCharsModal();
});
document.getElementById('wrap-chars-confirm')?.addEventListener('click', () => {
  const left = MaweTextProcess.wrapCharsLeftInput?.value || '';
  const right = MaweTextProcess.wrapCharsRightInput?.value || '';
  if (!left && !right) {
    MaweHint.flashHint('请至少输入一侧字符', 'invalid');
    return;
  }
  MaweTextProcess.applyWrapChars([...MaweTextProcess.wrapCharsScope], left, right, '左右添加字符');
  MaweTextProcess.closeWrapCharsModal();
});
// 输入框回车插入，输入法确认时不提交；Esc 关闭且不清空字幕选择。
document.addEventListener('keydown', (event) => {
  if (MaweShortcuts.isNativeDialogOpen()) return;
  if (!MaweTextProcess.wrapCharsModal?.classList.contains('show')) return;
  if (event.isComposing || event.keyCode === 229) return;
  const input = event.target === MaweTextProcess.wrapCharsLeftInput || event.target === MaweTextProcess.wrapCharsRightInput;
  if (event.key !== 'Escape' && !(event.key === 'Enter' && input)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (event.key === 'Escape') MaweTextProcess.closeWrapCharsModal();
  else if (!event.repeat) document.getElementById('wrap-chars-confirm')?.click();
}, true);

// === 纯文本编辑（支持调整字幕行结构的 MVP） ===
































































MaweDom.timedTextEditButton?.addEventListener('click', MaweTimedTextEdit.openTimedTextEdit);
MaweDom.timedTextEditRows?.addEventListener('input', (event) => {
  const textarea = event.target.closest?.('textarea[data-index]');
  if (!textarea || !MaweDom.timedTextEditDraft) return;
  const index = Number(textarea.dataset.index);
  if (!Number.isInteger(index) || index < 0 || index >= MaweDom.timedTextEditDraft.texts.length) return;
  const replacementLines = textarea.value.replace(/\r\n?/g, '\n').split('\n');
  MaweDom.timedTextEditDraft.texts.splice(index, 1, ...replacementLines);
  MaweDom.timedTextEditDraft.texts = MaweTimedTextEdit.normalizeTimedTextEditDraftLines(MaweDom.timedTextEditDraft.texts);
  MaweDom.timedTextEditDraft.singleText = MaweDom.timedTextEditDraft.texts.join('\n');
  MaweDom.timedTextEditDraft.singleLineError = '';
  MaweTimedTextEdit.renderTimedTextEditView();
  MaweTimedTextEdit.scheduleTimedTextEditReport();
});
MaweDom.timedTextEditSingleTextarea?.addEventListener('input', () => {
  if (!MaweDom.timedTextEditDraft) return;
  MaweDom.timedTextEditDraft.singleText = MaweDom.timedTextEditSingleTextarea.value.replace(/\r\n?/g, '\n');
  MaweDom.timedTextEditDraft.texts = MaweTimedTextEdit.normalizeTimedTextEditDraftLines(
    MaweDom.timedTextEditDraft.singleText.split('\n'),
  );
  MaweDom.timedTextEditDraft.singleText = MaweDom.timedTextEditDraft.texts.join('\n');
  MaweDom.timedTextEditDraft.singleLineError = '';
  MaweTimedTextEdit.refreshTimedTextEditSearch({ preserveIndex: true });
  MaweTimedTextEdit.scheduleTimedTextEditReport();
});
MaweDom.timedTextEditView?.addEventListener('click', (event) => {
  const button = event.target.closest?.('button[data-view]');
  if (!button || button.disabled || !MaweDom.timedTextEditDraft) return;
  // 视图切换可能紧跟在浏览器原生输入事件之前；以 textarea 当前值为准，
  // 避免“整体编辑”切到“逐行编辑”时回填旧草稿，导致修改前/修改后相同。
  MaweTimedTextEdit.syncTimedTextEditDraftFromDom();
  const nextView = button.dataset.view === 'single' ? 'single' : 'rows';
  if (nextView === 'single' && !MaweTimedTextEdit.timedTextEditCanUseSingleView()) {
    MaweHint.flashHint('当前字幕包含换行，暂不能切换到整体编辑视图', 'invalid');
    return;
  }
  MaweDom.timedTextEditDraft.view = nextView;
  if ((MaweBoot.DATA.timed_text_edit_view === 'single' ? 'single' : 'rows') !== nextView) {
    MaweBoot.DATA.timed_text_edit_view = nextView;
    MaweViewUpdates.invalidate({ save: true });
  }
  if (nextView === 'single') MaweDom.timedTextEditDraft.singleText = MaweDom.timedTextEditDraft.texts.join('\n');
  else MaweTimedTextEdit.renderTimedTextEditRows();
  MaweTimedTextEdit.renderTimedTextEditView();
  MaweTimedTextEdit.flushTimedTextEditReport();
  setTimeout(() => (nextView === 'single'
    ? MaweDom.timedTextEditSingleTextarea : MaweDom.timedTextEditRows.querySelector('textarea'))?.focus(), 0);
});
MaweDom.timedTextEditShowAll?.addEventListener('click', () => {
  if (!MaweDom.timedTextEditDraft) return;
  MaweDom.timedTextEditDraft.filter = null;
  MaweTimedTextEdit.flushTimedTextEditReport();
});
MaweDom.timedTextEditShowDisabledToggle?.addEventListener('change', () => {
  if (!MaweDom.timedTextEditDraft) return;
  const nextShowDisabled = MaweDom.timedTextEditShowDisabledToggle.checked;
  if (nextShowDisabled === MaweDom.timedTextEditDraft.showDisabled) return;
  if (MaweTimedTextEdit.timedTextEditHasUnappliedChanges()
      && !window.confirm('切换显示范围会丢弃当前未应用的文本修改，是否继续？')) {
    MaweDom.timedTextEditShowDisabledToggle.checked = MaweDom.timedTextEditDraft.showDisabled;
    return;
  }
  MaweTimedTextEdit.loadTimedTextEditTrack(MaweDom.timedTextEditDraft.kind, { showDisabled: nextShowDisabled });
});
MaweDom.timedTextEditTrack?.addEventListener('change', () => {
  if (!MaweDom.timedTextEditDraft) return;
  if (MaweTimedTextEdit.timedTextEditHasUnappliedChanges()) {
    const confirmed = window.confirm('切换轨道会丢弃当前未应用的文本修改，是否继续？');
    if (!confirmed) {
      MaweDom.timedTextEditTrack.value = MaweDom.timedTextEditDraft.kind;
      return;
    }
  }
  MaweTimedTextEdit.loadTimedTextEditTrack(MaweDom.timedTextEditTrack.value, {
    showDisabled: MaweDom.timedTextEditDraft.showDisabled === true,
  });
});
MaweDom.timedTextEditClose?.addEventListener('click', MaweTimedTextEdit.requestCloseTimedTextEdit);
MaweDom.timedTextEditTrimToggle?.addEventListener('change', () => {
  const draft = MaweDom.timedTextEditDraft;
  if (!draft) {
    MaweDom.timedTextEditTrimToggle.checked = false;
    return;
  }
  draft.trimWhitespace = MaweDom.timedTextEditTrimToggle.checked;
  MaweTimedTextEdit.flushTimedTextEditReport();
});
MaweDom.timedTextEditCancel?.addEventListener('click', MaweTimedTextEdit.requestCloseTimedTextEdit);
MaweDom.timedTextEditModal?.addEventListener('click', (event) => {
  if (event.target === MaweDom.timedTextEditModal) MaweTimedTextEdit.requestCloseTimedTextEdit();
});
MaweDom.timedTextEditApply?.addEventListener('click', () => MaweTimedTextEdit.applyTimedTextEdit());
