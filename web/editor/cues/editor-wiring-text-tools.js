
// === 批量替换 ===










// null = 全部；[idxs] = 仅这些行















[MaweFindReplace.findInput, MaweFindReplace.replaceInput].forEach(el => el.addEventListener('input', MaweFindReplace.updatePreview));
[MaweFindReplace.caseSensitiveCb, MaweFindReplace.useRegexCb].forEach(el => el.addEventListener('change', MaweFindReplace.updatePreview));
MaweFindReplace.replaceSelectedOnlyCb?.addEventListener('change', () => {
  MaweFindReplace.replaceScope = MaweFindReplace.replaceSelectedOnlyCb.checked ? [...MaweFindReplace.replaceSelectionSnapshot] : null;
  MaweFindReplace.refreshScopeInfo();
  MaweFindReplace.updatePreview();
});



document.getElementById('replace-btn')?.addEventListener('click', () => MaweFindReplace.openReplaceModal(null));
document.getElementById('replace-cancel')?.addEventListener('click', () => MaweDom.replaceModal.classList.remove('show'));
MaweDom.replaceModal.addEventListener('click', (e) => { if (e.target === MaweDom.replaceModal) MaweDom.replaceModal.classList.remove('show'); });
document.getElementById('replace-confirm')?.addEventListener('click', () => {
  const re = MaweFindReplace.buildReplaceRegex();
  if (!re || re.error) return;
  const repl = MaweFindReplace.replaceInput.value;
  // 先 dry-run 确认是否真的会改动，避免空操作压栈
  let willChange = 0;
  MaweFindReplace.getReplaceTargets().forEach(s => {
    re.lastIndex = 0;
    if (s.text.replace(re, repl) !== s.text) willChange++;
  });
  if (willChange === 0) {
    MaweDom.replaceModal.classList.remove('show');
    MaweHint.flashHint('没有匹配的内容', 'invalid');
    return;
  }
  MaweHistory.pushUndo('批量替换');
  let changedRows = 0;
  MaweFindReplace.getReplaceTargets().forEach(s => {
    re.lastIndex = 0;
    const newText = s.text.replace(re, repl);
    if (newText !== s.text) { s.text = newText; s._dirty = true; changedRows++; }
  });
  MaweDom.replaceModal.classList.remove('show');
  MaweCuePanel.renderAll();
  MaweHint.flashHint(`已修改 ${changedRows} 行`, 'success');
});

// === 文本处理 ===










































MaweTextProcess.textProcessButton?.addEventListener('click', MaweTextProcess.openTextProcessModal);
MaweTextProcess.textProcessSelectedOnlyCb?.addEventListener('change', () => {
  MaweTextProcess.textProcessScope = MaweTextProcess.textProcessSelectedOnlyCb.checked
    ? [...MaweTextProcess.textProcessSelectionSnapshot] : null;
  MaweTextProcess.refreshTextProcessScopeInfo();
  MaweTextProcess.renderTextProcessPreview();
});
[MaweTextProcess.textProcessTrim, MaweTextProcess.textProcessCapitalize, MaweTextProcess.textProcessPrefix,
  MaweTextProcess.textProcessSuffix, MaweTextProcess.textProcessStripMarkdown].forEach((input) => {
  input?.addEventListener('change', () => {
    MaweTextProcess.refreshTextProcessInputState();
    MaweTextProcess.renderTextProcessPreview();
  });
});
[MaweTextProcess.textProcessPrefixInput, MaweTextProcess.textProcessSuffixInput].forEach((input) => {
  input?.addEventListener('input', MaweTextProcess.renderTextProcessPreview);
});
document.getElementById('text-process-cancel')?.addEventListener('click', MaweTextProcess.closeTextProcessModal);
MaweDom.textProcessModal?.addEventListener('click', (event) => {
  if (event.target === MaweDom.textProcessModal) MaweTextProcess.closeTextProcessModal();
});
MaweTextProcess.textProcessConfirm?.addEventListener('click', () => {
  const options = MaweTextProcess.getTextProcessOptions();
  const result = {
    rows: MaweTextProcess.buildTextProcessPreview(MaweTextProcess.textProcessTargets(), options),
  };
  result.changedCount = result.rows.filter((row) => row.changed).length;
  if (!result.changedCount) {
    MaweHint.flashHint('当前文本处理对于选中的字幕没有任何影响，未作改动', 'invalid');
    return;
  }
  let mainDraftTexts = null;
  const extensionDrafts = new Map();
  result.rows.filter((row) => row.changed).forEach((row) => {
    if (row.kind === 'extension') {
      const track = MaweMultiSubtitleCore.getExtensionTrack(row.trackId);
      if (!track) return;
      const draft = extensionDrafts.get(track.id) || {
        track,
        texts: track.segments.map((segment) => String(segment?.text || '')),
      };
      draft.texts[row.index] = row.after;
      extensionDrafts.set(track.id, draft);
      return;
    }
    if (!mainDraftTexts) {
      mainDraftTexts = MaweBoot.DATA.segments.map((segment) => String(segment?.text || ''));
    }
    mainDraftTexts[row.index] = row.after;
  });
  const nextMainSegments = mainDraftTexts
    ? window.AsrEditorUtils.applyTimedTextEdit(MaweBoot.DATA.segments, mainDraftTexts)
    : null;
  const nextExtensionSegments = [];
  for (const draft of extensionDrafts.values()) {
    const nextSegments = window.AsrEditorUtils.applyTimedTextEdit(draft.track.segments, draft.texts);
    if (!nextSegments) {
      MaweHint.flashHint('无法应用文本处理：字幕行结构发生了变化', 'warning');
      return;
    }
    nextExtensionSegments.push({ track: draft.track, segments: nextSegments });
  }
  if (mainDraftTexts && !nextMainSegments) {
    MaweHint.flashHint('无法应用文本处理：字幕行结构发生了变化', 'warning');
    return;
  }
  MaweHistory.pushUndo('文本处理');
  if (nextMainSegments) {
    MaweBoot.DATA.segments.splice(0, MaweBoot.DATA.segments.length, ...nextMainSegments);
    MaweMultiSubtitleCore.markMainSegmentsDirty(MaweBoot.DATA.segments);
  }
  nextExtensionSegments.forEach(({ track, segments }) => {
    track.segments.splice(0, track.segments.length, ...segments);
    track.segments.forEach((segment) => { segment._dirty = true; });
  });
  if (nextExtensionSegments.length) MaweMultiSubtitleCore.markMultiSubtitleDirty();
  MaweMultiSubtitleCore.syncBindingOffsets();
  MaweServerSave.scheduleAutoSaveFlush();
  MaweTextProcess.closeTextProcessModal();
  MaweCuePanel.renderAll({ waveform: 'overlay' });
  MawePlaybackLoop.updateWithoutCueListAutoScroll();
  MaweHistory.updateUndoRedoButtons();
  MaweHint.flashHint(`已应用文本处理：${result.changedCount} 条字幕`, 'success');
});

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
MaweDom.timedTextEditCancel?.addEventListener('click', MaweTimedTextEdit.requestCloseTimedTextEdit);
MaweDom.timedTextEditModal?.addEventListener('click', (event) => {
  if (event.target === MaweDom.timedTextEditModal) MaweTimedTextEdit.requestCloseTimedTextEdit();
});
MaweDom.timedTextEditApply?.addEventListener('click', () => {
  const draft = MaweDom.timedTextEditDraft;
  if (!draft) return;
  MaweTimedTextEdit.syncTimedTextEditDraftFromDom();
  MaweTimedTextEdit.flushTimedTextEditReport();
  if (!draft.report?.valid) return;
  if (!draft.report.stats.changedSegments) {
    MaweHint.flashHint('当前没有文本修改，未作改动', 'invalid');
    return;
  }
  const targetSegments = MaweTimedTextEdit.timedTextEditSegments(draft.kind);
  const snapshotSegments = Array.isArray(draft.allSourceSegments)
    ? draft.allSourceSegments : draft.sourceSegments;
  const currentMatchesSnapshot = targetSegments.length === snapshotSegments.length
    && targetSegments.every((segment, index) => {
      const source = snapshotSegments[index];
      return segment?.id === source?.id
        && Number(segment?.start) === Number(source?.start)
        && Number(segment?.end) === Number(source?.end)
        && String(segment?.text || '') === String(source?.text || '')
        && Boolean(segment?.disabled) === Boolean(source?.disabled);
    });
  if (!currentMatchesSnapshot) {
    MaweHint.flashHint('字幕在编辑窗口打开后发生了变化，请关闭窗口并重新打开', 'warning');
    MaweTimedTextEdit.closeTimedTextEdit();
    return;
  }
  const nextSegments = window.AsrEditorUtils.applyTimedTextEdit(
    draft.sourceSegments,
    draft.texts,
  );
  if (!nextSegments) {
    MaweHint.flashHint('无法应用文本修改：字幕行结构发生了变化', 'warning');
    return;
  }
  MaweHistory.pushUndo('纯文本编辑');
  const dirtyFlags = window.AsrEditorUtils.timedTextEditDirtyFlags(
    draft.sourceSegments,
    nextSegments,
    draft.report,
  );
  nextSegments.forEach((segment, index) => {
    if (dirtyFlags[index]) segment._dirty = true;
    else delete segment._dirty;
  });
  const removedCount = MaweTimedTextEdit.applyTimedTextEditSegments(
    draft.kind,
    draft.sourceSegments,
    targetSegments,
    nextSegments,
    draft.report,
    draft.texts,
    draft.sourceSegmentIndexes,
  );
  if (draft.kind === 'extension') MaweMultiSubtitleCore.markMultiSubtitleStateDirty();
  MaweMultiSubtitleCore.syncBindingOffsets();
  // 纯文本编辑应用后暂不主动触发自动保存，让 dirty 标记短暂保留，
  // 便于用户确认哪些字幕确实发生了变化；已有的自动保存计时器仍照常执行。
  const changedCount = draft.report.stats.changedSegments;
  const lostCount = draft.report.stats.lostMappedCues;
  const estimatedCount = draft.report.stats.estimatedTimingCues || 0;
  MaweTimedTextEdit.closeTimedTextEdit();
  MaweCuePanel.renderAll({ waveform: 'overlay' });
  MawePlaybackLoop.updateWithoutCueListAutoScroll();
  MaweHistory.updateUndoRedoButtons();
  MaweHint.flashHint(
    `已应用纯文本编辑：${changedCount} 条字幕${removedCount ? `，移除 ${removedCount} 条空字幕行` : ''}${lostCount ? `，${lostCount} 条字词时间码已清除` : ''}${estimatedCount ? `，${estimatedCount} 条时间范围为自动估算` : ''}`,
    'success',
  );
});
