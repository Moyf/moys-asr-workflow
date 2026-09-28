



  // 用于 Shift+click 范围选



// 已选计数涵盖主轨/副轨/叠加轨三个选区集。
function updateSelectionCountText() {
  MaweDom.selCountEl.textContent = String(
    MaweSelection.selectedIdxs.size + MaweSelection.selectedExtensionIdxs.size + MaweState.selection.indices('overlay').size,
  );
}
// “仅看超长”开启时，刚拆出的字幕临时绕过字数过滤；使用稳定 ID，避免 splice 后下标错位。

// 右键选择「绑定到主字幕」后的等待状态。使用稳定 ID 而不是数组下标，
// 这样等待期间即使列表重绘，也不会把另一条副字幕误绑定过去。

// 隐藏开关开启时，禁用项视为"不可选"（Shift 范围选 / Ctrl 切换都跳过）












// 联动选中只补充另一轨的选中集合，不切换当前字幕编辑区；编辑区焦点仍由用户最后点击的字幕决定。












// 选中全部字幕（跳过「隐藏禁用项」开启时的禁用条目，与其它选择逻辑一致）。

// 返回与 idx 同属一个表情包/颜色分组的全部字幕下标（含 idx 自身）。
// head 持有 sticker/color，成员持 sticker_ref/color_ref 指向 head。

// 普通单击字幕时的选择逻辑：开启「同时选中分组内项目」且属于分组时选整组，否则只选本行。
















// === 渲染 ===
















function setCurrentCuePanelOverlayIndex(index) {
  MaweCuePanel.setCuePanelTarget('overlay', index);
}


























MaweDom.cuePanelPrev?.addEventListener('click', () => MaweCuePanel.navigateCuePanel(-1));
MaweDom.cuePanelNext?.addEventListener('click', () => MaweCuePanel.navigateCuePanel(1));
MaweDom.cuePanelText?.addEventListener('focus', MaweCuePanel.captureCuePanelTextEditSnapshot);
MaweDom.cuePanelText?.addEventListener('keydown', (event) => {
  // Esc：按当前字幕编辑区设置决定取消还是提交文本编辑。
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    if (MaweSettings.EDITOR_SETTINGS.cueEditorCancelOnEscape) MaweCuePanel.cancelCuePanelTextEdit();
    else MaweCuePanel.exitCuePanelEdit();
    return;
  }
  const action = MaweCueEvents.getConfiguredEnterAction(event);
  if (!action || action === 'newline') return;
  event.preventDefault();
  event.stopPropagation();
  if (action === 'split') MaweCuePanel.splitCuePanelAtCursor();
  else MaweCuePanel.exitCuePanelEdit();
});
MaweDom.cuePanelText?.addEventListener('input', () => {
  const target = MaweCuePanel.getCurrentCuePanelTarget();
  if (!target) return;
  const cueListAnchor = MaweCueListAnchor.captureCueListRenderAnchor();
  MaweCuePanel.ensureCuePanelUndo(target.kind === 'extension' ? '编辑副字幕' : '编辑当前字幕');
  const seg = target.segment;
  seg.text = MaweDom.cuePanelText.value.replace(/\r\n?/g, '\n');
  seg._dirty = true;
  if (target.kind === 'extension') MaweMultiSubtitleCore.markMultiSubtitleDirty();
  MaweViewUpdates.invalidate({ save: true });
  const splitMode = target.kind === 'extension'
    ? MaweMultiSubtitleCore.getExtensionSubtitleSplitMode(target.track, seg)
    : MaweMultiSubtitleCore.getMainSubtitleSplitMode(seg);
  const metrics = window.AsrEditorUtils.cueMetrics(
    seg.text, seg.start, seg.end, splitMode,
  );
  MaweDom.cuePanelTotalLength.textContent = String(metrics.totalLength);
  MaweDom.cuePanelCharsPerSecond.textContent = metrics.charsPerSecond.toFixed(2);
  const textEl = MaweCuePanel.getCuePanelTextElement(target);
  if (textEl) {
    MaweCueElements.setTextHtml(textEl, seg.text, MaweDom.searchEl.value);
    MaweCueElements.applyCharCount(textEl.closest('.cue')?.querySelector('.charcount'), seg.text, splitMode);
  }
  if (target.kind === 'extension') MaweCoreState.waveformEditor?.refreshExtensionCueLabel(target.index, target.trackId);
  else if (target.kind === 'overlay') MaweCoreState.waveformEditor?.refreshCueOverlay();
  else MaweCoreState.waveformEditor?.refreshCueLabel(target.index);
  MaweViewUpdates.invalidate({ preview: 'refresh' });
  MaweCueListAnchor.restoreCueListRenderAnchor(cueListAnchor);
});
MaweDom.cuePanelText?.addEventListener('blur', () => {
  if (MaweCuePanelState.cuePanelCanceling) return;
  MaweCuePanel.commitCuePanelEdit();
});
MaweDom.cuePanelStart?.addEventListener('change', () => MaweCuePanel.commitCuePanelEdit());
MaweDom.cuePanelDuration?.addEventListener('change', () => MaweCuePanel.commitCuePanelEdit());
MaweDom.cuePanelAddSticker?.addEventListener('click', () => {
  const target = MaweCuePanel.getCurrentCuePanelTarget();
  if (target?.kind === 'main') MaweStickerPicker.openStickerPicker([target.index], false);
  else if (target?.kind === 'overlay') MaweStickerPicker.openStickerPicker([target.index], false, { overlay: true });
});
MaweDom.cuePanelSticker?.addEventListener('click', () => {
  const target = MaweCuePanel.getCurrentCuePanelTarget();
  if (target?.kind === 'main') MaweStickerPicker.openStickerPicker([target.index], false);
  else if (target?.kind === 'overlay') MaweStickerPicker.openStickerPicker([target.index], false, { overlay: true });
});
MaweDom.cuePanelSticker?.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  const target = MaweCuePanel.getCurrentCuePanelTarget();
  if (target?.kind !== 'main') return;
  MaweStickerPicker.removeStickerCascade(target.index);
  MaweCuePanel.renderAll();
  MaweHint.flashHint('已删除当前表情包', 'success');
});
MaweDom.cuePanelSplit?.addEventListener('click', MaweCuePanel.splitCuePanelAtCursor);













// 叠加字幕行选中高亮与选中计数统一同步：叠加轨没有 multi-cue 类，
// 不能走 updateMultiSelectionClasses，这里按 data-overlay-idx 直接同步。
function syncOverlaySelectionClasses() {
  MaweCoreState.container.querySelectorAll('.cue[data-overlay-idx].selected').forEach((el) => {
    if (!MaweState.selection.indices('overlay').has(Number(el.dataset.overlayIdx))) el.classList.remove('selected');
  });
  MaweState.selection.indices('overlay').forEach((index) => {
    MaweCoreState.container.querySelector(`.cue[data-overlay-idx="${index}"]`)?.classList.add('selected');
  });
  updateSelectionCountText();
}

function selectOverlayCueRow(index, { focusEditor = false } = {}) {
  // 与副字幕 selectOnlyExtension 同一逻辑：点击叠加字幕先清空主轨/副轨
  // 已有选区（clearSelection 同时取消待绑定状态），再单独选中本轨字幕。
  MaweCuePanel.commitCuePanelEdit();
  MaweSelection.clearSelection({ silent: true });
  MaweState.selection.add('overlay', index);
  MaweState.selection.overlayAnchor = index;
  MaweCuePanel.setCuePanelTarget('overlay', index);
  if (focusEditor) MaweCuePanel.focusCuePanelText(index, 'overlay');
  syncOverlaySelectionClasses();
  MaweCoreState.waveformEditor?.updateSelection();
  const row = MaweCoreState.container.querySelector(`.cue[data-overlay-idx="${index}"]`);
  if (row) MaweCueListAnchor.scrollCueIntoViewIfNeeded(row);
}

function selectOverlayRange(fromIndex, toIndex) {
  const segments = getOverlayTrack()?.segments || [];
  const from = Math.max(0, Math.min(fromIndex, toIndex));
  const to = Math.min(segments.length - 1, Math.max(fromIndex, toIndex));
  MaweState.selection.clear('overlay');
  for (let index = from; index <= to; index += 1) {
    if (MaweSelection.isHiddenDisabled(index, getOverlayTrack())) continue;
    MaweState.selection.add('overlay', index);
  }
  MaweCuePanel.setCuePanelTarget('overlay', toIndex);
  syncOverlaySelectionClasses();
  MaweCoreState.waveformEditor?.updateSelection();
  const row = MaweCoreState.container.querySelector(`.cue[data-overlay-idx="${toIndex}"]`);
  if (row) MaweCueListAnchor.scrollCueIntoViewIfNeeded(row);
}

function toggleOverlaySelection(index) {
  if (MaweSelection.isHiddenDisabled(index, getOverlayTrack())) return;  // 隐藏禁用项不参与选择
  const row = MaweCoreState.container.querySelector(`.cue[data-overlay-idx="${index}"]`);
  if (MaweState.selection.indices('overlay').has(index)) {
    MaweState.selection.remove('overlay', index);
    row?.classList.remove('selected');
  } else {
    MaweState.selection.add('overlay', index);
    row?.classList.add('selected');
  }
  MaweState.selection.overlayAnchor = index;
  // 与副字幕 Ctrl 多选一致：面板跟随被切换的字幕，便于继续编辑。
  MaweCuePanel.setCuePanelTarget('overlay', index);
  updateSelectionCountText();
  MaweCoreState.waveformEditor?.updateSelection();
}

function buildOverlayCueEl(seg, index) {
  const el = MaweCueElements.buildCueEl(seg, index, { overlayTrack: true });
  el.classList.add('overlay-track-cue');
  el.dataset.overlayIdx = String(index);
  el.removeAttribute('data-idx');
  el.classList.toggle('selected', MaweState.selection.indices('overlay').has(index));
  el.addEventListener('click', (event) => {
    event.stopPropagation();
    if (event.shiftKey && MaweState.selection.overlayAnchor >= 0) {
      selectOverlayRange(MaweState.selection.overlayAnchor, index);
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      toggleOverlaySelection(index);
      return;
    }
    selectOverlayCueRow(index);
    const segment = getOverlayTrack()?.segments?.[index];
    if (!segment) return;
    const previousSuppress = MawePlaybackLoop.suppressCueListAutoScroll;
    // 与副字幕一致：点击后的 seek 会同步刷新主字幕 active 状态；这次刷新不能把
    // 列表从刚点击的叠加字幕行再次滚到对应的主字幕行。
    const wasPlaying = isPlaybackActive();
    MawePlaybackLoop.suppressCueListAutoScroll = true;
    try {
      MaweCoreState.waveformEditor?.revealTime(segment.start, true);
      if (MaweSettings.EDITOR_SETTINGS.clickBehavior !== 'select-only') {
        MaweTextCleanup.seekFromWaveform(segment.start / 1000, { mouseClick: true });
      }
    } finally {
      MawePlaybackLoop.suppressCueListAutoScroll = previousSuppress;
    }
    if (MaweSettings.EDITOR_SETTINGS.clickBehavior === 'select-and-play' && MaweCoreState.player.paused && !wasPlaying) MaweMediaPlayback.togglePlayback();
    if (MaweSettings.EDITOR_SETTINGS.cueListAutoScrollOnClick) {
      const row = MaweCoreState.container.querySelector(`.cue[data-overlay-idx="${index}"]`);
      if (row) MaweCueListAnchor.scrollCueToCenter(row);
    }
  });
  el.addEventListener('dblclick', (event) => {
    event.preventDefault();
    event.stopPropagation();
    selectOverlayCueRow(index, { focusEditor: true });
  });
  el.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    showOverlayContextMenu(event.clientX, event.clientY, index);
  });
  return el;
}













// === 字数 ===
