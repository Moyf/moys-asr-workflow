import { editorDialogs } from '../../shared/editor-dialogs.js';
import { MaweBoot } from '../boot/editor-boot.js';
import { MaweCommands } from '../state/editor-commands.js';
import { MaweHistory } from '../state/editor-history.js';
import { MaweMultiSubtitleCore } from '../state/editor-multi-subtitle-core.js';
import { MaweSettings } from '../state/editor-settings.js';
import { MaweViewUpdates } from '../state/editor-view-updates.js';
import { MaweDom } from '../ui/editor-dom.js';
import { MaweHint } from '../ui/editor-hint.js';
import { MaweTextProcess } from './editor-text-process.js';
import { openTimedTextEdit, normalizeTimedTextEditDraftLines, renderTimedTextEditView, scheduleTimedTextEditReport, refreshTimedTextEditSearch, syncTimedTextEditDraftFromDom, timedTextEditCanUseSingleView, renderTimedTextEditRows, flushTimedTextEditReport, timedTextEditHasUnappliedChanges, loadTimedTextEditTrack, requestCloseTimedTextEdit, timedTextEditSegments, closeTimedTextEdit, timedTextEditEffectiveTexts, applyTimedTextEditSegments } from './editor-timed-text-edit.js';
import { AsrEditorUtils } from '../../shared/editor-utils.js';
export function initMaweTextToolsWiring() {
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
































































MaweDom.timedTextEditButton?.addEventListener('click', openTimedTextEdit);
MaweDom.timedTextEditRows?.addEventListener('input', (event) => {
  const textarea = event.target.closest?.('textarea[data-index]');
  if (!textarea || !MaweDom.timedTextEditDraft) return;
  const index = Number(textarea.dataset.index);
  if (!Number.isInteger(index) || index < 0 || index >= MaweDom.timedTextEditDraft.texts.length) return;
  const replacementLines = textarea.value.replace(/\r\n?/g, '\n').split('\n');
  MaweDom.timedTextEditDraft.texts.splice(index, 1, ...replacementLines);
  MaweDom.timedTextEditDraft.texts = normalizeTimedTextEditDraftLines(MaweDom.timedTextEditDraft.texts);
  MaweDom.timedTextEditDraft.singleText = MaweDom.timedTextEditDraft.texts.join('\n');
  MaweDom.timedTextEditDraft.singleLineError = '';
  renderTimedTextEditView();
  scheduleTimedTextEditReport();
});
MaweDom.timedTextEditSingleTextarea?.addEventListener('input', () => {
  if (!MaweDom.timedTextEditDraft) return;
  MaweDom.timedTextEditDraft.singleText = MaweDom.timedTextEditSingleTextarea.value.replace(/\r\n?/g, '\n');
  MaweDom.timedTextEditDraft.texts = normalizeTimedTextEditDraftLines(
    MaweDom.timedTextEditDraft.singleText.split('\n'),
  );
  MaweDom.timedTextEditDraft.singleText = MaweDom.timedTextEditDraft.texts.join('\n');
  MaweDom.timedTextEditDraft.singleLineError = '';
  refreshTimedTextEditSearch({ preserveIndex: true });
  scheduleTimedTextEditReport();
});
let timedTextEditViewFocusSequence = 0;
MaweDom.timedTextEditView?.addEventListener('click', (event) => {
  const button = event.target.closest?.('button[data-view]');
  if (!button || button.disabled || !MaweDom.timedTextEditDraft) return;
  // 视图切换可能紧跟在浏览器原生输入事件之前；以 textarea 当前值为准，
  // 避免“整体编辑”切到“逐行编辑”时回填旧草稿，导致修改前/修改后相同。
  syncTimedTextEditDraftFromDom();
  const nextView = button.dataset.view === 'single' ? 'single' : 'rows';
  if (nextView === 'single' && !timedTextEditCanUseSingleView()) {
    MaweHint.flashHint('当前字幕包含换行，暂不能切换到整体编辑视图', 'invalid');
    return;
  }
  MaweDom.timedTextEditDraft.view = nextView;
  if ((MaweBoot.DATA.timed_text_edit_view === 'single' ? 'single' : 'rows') !== nextView) {
    MaweBoot.DATA.timed_text_edit_view = nextView;
    MaweViewUpdates.invalidate({ save: true });
  }
  if (nextView === 'single') MaweDom.timedTextEditDraft.singleText = MaweDom.timedTextEditDraft.texts.join('\n');
  else renderTimedTextEditRows();
  renderTimedTextEditView();
  flushTimedTextEditReport();
  const draft = MaweDom.timedTextEditDraft;
  const focusSequence = ++timedTextEditViewFocusSequence;
  const pointerActivation = event.detail > 0;
  setTimeout(() => {
    if (!MaweDom.timedTextEditModal.classList.contains('show')
      || MaweDom.timedTextEditDraft !== draft || draft.view !== nextView
      || focusSequence !== timedTextEditViewFocusSequence) return;
    const active = document.activeElement;
    if (MaweDom.timedTextEditModal.contains(active)
      && (active !== button || !pointerActivation)) return;
    (nextView === 'single'
      ? MaweDom.timedTextEditSingleTextarea : MaweDom.timedTextEditRows.querySelector('textarea'))?.focus();
  }, 0);
});
MaweDom.timedTextEditShowAll?.addEventListener('click', () => {
  if (!MaweDom.timedTextEditDraft) return;
  MaweDom.timedTextEditDraft.filter = null;
  flushTimedTextEditReport();
});
MaweDom.timedTextEditShowDisabledToggle?.addEventListener('change', () => {
  if (!MaweDom.timedTextEditDraft) return;
  const nextShowDisabled = MaweDom.timedTextEditShowDisabledToggle.checked;
  if (nextShowDisabled === MaweDom.timedTextEditDraft.showDisabled) return;
  if (timedTextEditHasUnappliedChanges()
      && !editorDialogs.confirm('切换显示范围会丢弃当前未应用的文本修改，是否继续？')) {
    MaweDom.timedTextEditShowDisabledToggle.checked = MaweDom.timedTextEditDraft.showDisabled;
    return;
  }
  loadTimedTextEditTrack(MaweDom.timedTextEditDraft.kind, { showDisabled: nextShowDisabled });
});
MaweDom.timedTextEditTrack?.addEventListener('change', () => {
  if (!MaweDom.timedTextEditDraft) return;
  if (timedTextEditHasUnappliedChanges()) {
    const confirmed = editorDialogs.confirm('切换轨道会丢弃当前未应用的文本修改，是否继续？');
    if (!confirmed) {
      MaweDom.timedTextEditTrack.value = MaweDom.timedTextEditDraft.kind;
      return;
    }
  }
  loadTimedTextEditTrack(MaweDom.timedTextEditTrack.value, {
    showDisabled: MaweDom.timedTextEditDraft.showDisabled === true,
  });
});
MaweDom.timedTextEditClose?.addEventListener('click', requestCloseTimedTextEdit);
MaweDom.timedTextEditTrimToggle?.addEventListener('change', () => {
  const draft = MaweDom.timedTextEditDraft;
  if (!draft) {
    MaweDom.timedTextEditTrimToggle.checked = false;
    return;
  }
  draft.trimWhitespace = MaweDom.timedTextEditTrimToggle.checked;
  flushTimedTextEditReport();
});
MaweDom.timedTextEditCancel?.addEventListener('click', requestCloseTimedTextEdit);
MaweDom.timedTextEditModal?.addEventListener('click', (event) => {
  if (event.target === MaweDom.timedTextEditModal) requestCloseTimedTextEdit();
});
MaweDom.timedTextEditApply?.addEventListener('click', () => {
  const draft = MaweDom.timedTextEditDraft;
  if (!draft) return;
  syncTimedTextEditDraftFromDom();
  flushTimedTextEditReport();
  if (!draft.report?.valid) return;
  if (!draft.report.stats.changedSegments) {
    MaweHint.flashHint('当前没有文本修改，未作改动', 'invalid');
    return;
  }
  const targetSegments = timedTextEditSegments(draft.kind);
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
    closeTimedTextEdit();
    return;
  }
  const effectiveTexts = timedTextEditEffectiveTexts();
  const nextSegments = AsrEditorUtils.applyTimedTextEdit(
    draft.sourceSegments,
    effectiveTexts,
    { reservedSegments: [...AsrEditorUtils.iterSegments(MaweBoot.DATA)], rule: MaweSettings.EDITOR_SETTINGS.assSpecialSymbolRule },
  );
  if (!nextSegments) {
    MaweHint.flashHint('无法应用文本修改：字幕行结构发生了变化', 'warning');
    return;
  }
  return MaweCommands.run('纯文本编辑', (command) => {
    const dirtyFlags = AsrEditorUtils.timedTextEditDirtyFlags(
      draft.sourceSegments,
      nextSegments,
      draft.report,
    );
    nextSegments.forEach((segment, index) => {
      if (dirtyFlags[index]) segment._dirty = true;
      else delete segment._dirty;
    });
    const removedCount = applyTimedTextEditSegments(
      draft.kind,
      draft.sourceSegments,
      targetSegments,
      nextSegments,
      draft.report,
      effectiveTexts,
      draft.sourceSegmentIndexes,
    );
    if (draft.kind === 'extension') MaweMultiSubtitleCore.markMultiSubtitleStateDirty();
    MaweMultiSubtitleCore.syncBindingOffsets();
    // 纯文本编辑应用后暂不主动触发自动保存，让 dirty 标记短暂保留，
    // 便于用户确认哪些字幕确实发生了变化；已有的自动保存计时器仍照常执行。
    const changedCount = draft.report.stats.changedSegments;
    const lostCount = draft.report.stats.lostMappedCues;
    const estimatedCount = draft.report.stats.estimatedTimingCues || 0;
    closeTimedTextEdit();
    command.commit({ cueList: true, waveform: 'overlay', preview: 'update' });

    MaweHistory.updateUndoRedoButtons();
    MaweHint.flashHint(
      `已应用纯文本编辑：${changedCount} 条字幕${removedCount ? `，移除 ${removedCount} 条空字幕行` : ''}${lostCount ? `，${lostCount} 条字词时间码已清除` : ''}${estimatedCount ? `，${estimatedCount} 条时间范围为自动估算` : ''}`,
      'success',
    );
  });
});
}
