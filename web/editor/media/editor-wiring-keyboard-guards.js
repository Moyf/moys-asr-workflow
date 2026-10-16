

// === 全局键盘 ===
  // 'enter' or 'ctrl-enter'



document.addEventListener('keydown', (e) => {
  if (e.target === MaweDom.cuePanelText) return;
  if (!MaweInlineEdit.editingState) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); MaweInlineEdit.finishEdit(false); return; }
  const action = MaweCueEvents.getConfiguredEnterAction(e);
  if (!action || action === 'newline') return;
  e.preventDefault();
  // 拆分会在当前 keydown 事件内打开弹窗；阻止同一 document 上后注册的
  // 弹窗快捷键监听器继续处理这次 Enter，否则它会立刻把新弹窗再次提交。
  e.stopImmediatePropagation();
  if (action === 'split') MaweSplitCore.splitAtCursor();
  else MaweInlineEdit.finishEdit(true);
}, true);

document.addEventListener('keydown', (event) => {
  if (!MaweInlineEdit.extensionEditingState) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    MaweInlineEdit.finishExtensionEdit(false);
    return;
  }
  const action = MaweCueEvents.getConfiguredEnterAction(event);
  if (!action || action === 'newline') return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (action === 'save') {
    MaweInlineEdit.finishExtensionEdit(true);
    return;
  }
  const state = MaweInlineEdit.extensionEditingState;
  const offset = MaweInlineEdit.caretOffsetInText(state.textEl);
  const track = MaweMultiSubtitleCore.getExtensionTrack(state.trackId);
  if (!Number.isFinite(offset) || !track?.segments?.[state.index]) {
    MaweHint.flashHint('无法定位副字幕的文字光标', 'warning');
    return;
  }
  MaweInlineEdit.finishExtensionEdit(true);
  MaweSplitCore.openExtensionSplitModal(state.index, null, track, { extensionOffset: offset });
}, true);

// Esc：非字幕文本编辑状态下清除当前字幕选择；输入框和内联编辑继续保留原生/编辑行为。
document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.key !== 'Escape') return;
  if (MaweDom.timedTextEditModal.classList.contains('show')) {
    e.preventDefault();
    e.stopPropagation();
    MaweTimedTextEdit.requestCloseTimedTextEdit();
    return;
  }
  // 浮窗自己的 Esc 处理器稍后执行；不要先清空其背后的字幕选区。
  if (MaweFloatingPanel.floatingSurfaceStack.some(MaweFloatingPanel.floatingSurfaceIsOpen)) return;
  if (MaweSelection.pendingExtensionBinding) {
    e.preventDefault();
    e.stopPropagation();
    MaweSelection.cancelPendingExtensionBinding();
    return;
  }
  if (MaweInlineEdit.editingState || (MaweSelection.selectedIdxs.size === 0 && MaweSelection.selectedExtensionIdxs.size === 0)) return;
  const a = document.activeElement;
  if (a && (
    a.tagName === 'INPUT'
    || a.tagName === 'TEXTAREA'
    || a.tagName === 'SELECT'
    || a.isContentEditable
  )) return;
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (MaweDom.projectMediaModal.classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  const waveform = MaweCoreState.waveformEditor;
  if (waveform?.hasCueDrag?.() || waveform?.markerDrag || waveform?.markerCreateDrag) {
    // 选区保持不变；交给后面的波形快捷键处理器取消字幕/标记拖动并消费 Esc。
    return;
  }
  MaweSelection.clearSelection();
  // 无浮窗时保留旧行为：同一次 Esc 清选区并由后面的处理器退出剃刀。
  if (MaweCoreState.waveformEditor?.getTool?.() === 'razor') return;
  e.preventDefault();
  e.stopPropagation();
});











function isPlaybackActive() {
  return MaweJklPlayback.jklReversePlaying || !MaweCoreState.player.paused;
}

function pausePlaybackAfterMouseClick() {
  if (!MaweSettings.EDITOR_SETTINGS.pauseOnMouseClick || !isPlaybackActive()) return;
  if (MaweJklPlayback.jklReversePlaying) MaweJklPlayback.stopJklReversePlayback({ render: false });
  MaweCoreState.player.pause();
  MaweMediaPlayback.syncMediaControls();
}















let assPreviewRefreshFrame = 0;
let assPreviewRefreshTimer = 0;
function queueAssSubtitlePreviewRefresh() {
  if (assPreviewRefreshFrame) return;
  const refresh = () => {
    assPreviewRefreshFrame = 0;
    if (MaweSettings.EDITOR_SETTINGS.assMode === true) MawePlaybackLoop.refreshSubtitlePreview();
  };
  if (typeof requestAnimationFrame === 'function') assPreviewRefreshFrame = requestAnimationFrame(refresh);
  else refresh();
}
function scheduleAssSubtitlePreviewRefresh() {
  if (MaweSettings.EDITOR_SETTINGS.assMode !== true) return;
  // ResizeObserver runs after layout. Draw the overlay and Canvas together on
  // the next frame, even while fullscreen/resize events keep arriving. A trailing
  // debounce used to starve paused previews until the entire transition ended.
  queueAssSubtitlePreviewRefresh();
  // One bounded follow-up also covers fullscreenchange arriving before layout.
  // Repeated events never postpone it and no polling continues after it fires.
  if (!assPreviewRefreshTimer) {
    assPreviewRefreshTimer = window.setTimeout(() => {
      assPreviewRefreshTimer = 0;
      if (MaweSettings.EDITOR_SETTINGS.assMode === true) queueAssSubtitlePreviewRefresh();
    }, 100);
  }
}

let assPreviewObservedPlayer = null;
const assPreviewStageObserver = typeof ResizeObserver === 'function'
  ? new ResizeObserver(scheduleAssSubtitlePreviewRefresh) : null;
function observeAssSubtitlePreviewPlayer(player) {
  if (!assPreviewStageObserver || assPreviewObservedPlayer === player) return;
  if (assPreviewObservedPlayer) assPreviewStageObserver.unobserve(assPreviewObservedPlayer);
  assPreviewObservedPlayer = player?.tagName === 'VIDEO' ? player : null;
  if (assPreviewObservedPlayer) assPreviewStageObserver.observe(assPreviewObservedPlayer);
}
if (MaweDom.playerStage) assPreviewStageObserver?.observe(MaweDom.playerStage);
observeAssSubtitlePreviewPlayer(MaweCoreState.player);
window.addEventListener('resize', scheduleAssSubtitlePreviewRefresh);
