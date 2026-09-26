document.addEventListener('click', (event) => {
  if (event.detail === 0) return;
  const target = event.target instanceof Element ? event.target : null;
  target?.closest('button')?.blur();
}, true);



// 空格播放/暂停。捕获阶段先于原生媒体控件处理，避免控件获得焦点后执行默认行为。

document.addEventListener('keydown', (e) => {
  if (!MaweKeyboardTargets.isSpaceKey(e)) return;
  if (MaweInlineEdit.editingState || MaweKeyboardTargets.isTextEditingTarget(e)) return;
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (MaweDom.projectMediaModal.classList.contains('show')) return;
  // 拆分弹窗内空格用于确认/取消断点，交给弹窗自己的键盘处理。
  if (MaweDom.multiSubtitleSplitModal?.classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (!MaweKeyboardTargets.isPlaybackKeyboardTarget(e) && MaweKeyboardTargets.isNativeKeyboardControl(e)) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  MaweShortcuts.interceptedSpace = true;
  if (e.repeat) return;
  MaweMediaPlayback.togglePlayback();
}, true);

document.addEventListener('keyup', (e) => {
  if (!MaweKeyboardTargets.isSpaceKey(e) || !MaweShortcuts.interceptedSpace) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  MaweShortcuts.interceptedSpace = false;
}, true);
window.addEventListener('blur', () => { MaweShortcuts.interceptedSpace = false; });

// J/K/L 播放控制的两种模式：旧模式是慢速/重置/倍速；新模式是倒放/停止/1×播放。
// HTML5 playbackRate 多数浏览器钳在 [0.0625, 16]，反向播放由时间轴驱动。





document.addEventListener('keydown', (e) => {
  if (e.key !== 'j' && e.key !== 'J' && e.key !== 'k' && e.key !== 'K' && e.key !== 'l' && e.key !== 'L') return;
  if (MaweInlineEdit.editingState) return;
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return;
  // Ctrl/Alt/Meta 别误触发（让浏览器自己处理 Ctrl+L 等）
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  e.preventDefault();
  const k = e.key.toLowerCase();
  if (MaweJklPlayback.isJklDirectionMode()) {
    if (k === 'k') {
      const wasPlaying = MaweJklPlayback.jklReversePlaying || !MaweCoreState.player.paused;
      if (!wasPlaying) {
        MaweJklPlayback.jklPlaybackRate = 1;
        MaweCoreState.player.playbackRate = 1;
        if (MaweJklPlayback.playJklForward()) MaweHint.flashHint('正放: 1×');
        return;
      }
      MaweJklPlayback.stopJklReversePlayback({ render: false });
      MaweJklPlayback.jklPlaybackRate = 1;
      MaweCoreState.player.playbackRate = 1;
      MaweCoreState.player.pause();
      MawePlaybackLoop.update();
      MaweCoreState.waveformEditor?.updatePlayback();
      MaweMediaPlayback.syncMediaControls();
      MaweHint.flashHint('已停止');
      return;
    }
    if (!MaweMediaPlayback.hasLoadedMedia()) {
      MaweHint.flashHint('请先加载媒体，然后才能预览', 'invalid');
      return;
    }
    MaweJklPlayback.jklPlaybackRate = MaweJklPlayback.nextJklDirectionRate(MaweJklPlayback.jklPlaybackRate, k === 'j' ? -1 : 1);
    if (MaweJklPlayback.jklPlaybackRate < 0) MaweJklPlayback.startJklReversePlayback();
    else MaweJklPlayback.playJklForward();
    MaweHint.flashHint(`${MaweJklPlayback.jklPlaybackRate < 0 ? '倒放' : '正放'}: ${MaweShortcuts.fmtRate(MaweJklPlayback.jklPlaybackRate)}`);
    return;
  }
  let r = MaweCoreState.player.playbackRate;
  if (k === 'k') r = 1;
  else if (k === 'j') r = Math.max(MaweShortcuts.PLAYBACK_RATE_MIN, r * 0.5);
  else if (k === 'l') r = Math.min(MaweShortcuts.PLAYBACK_RATE_MAX, r * 2);
  MaweCoreState.player.playbackRate = r;
  MaweMediaPlayback.syncMediaControls();
  MaweHint.flashHint(`倍速: ${MaweShortcuts.fmtRate(r)}`);
});

// A/D（或 W/S）：跳转到上一条/下一条字幕的句首并单选。W/S 与 A/D 等价，对应上下方向。
// Shift+A/D（或 Shift+W/S）：保留当前选择，并向前/后追加选择一条字幕。
// 播放中以播放头所在字幕为基准；播放头处于空隙时，按方向选择其前方/后方字幕。
// 暂停时仍以当前选中字幕为基准。跳转本身不改变播放状态。
document.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase();
  if (key !== 'a' && key !== 'd' && key !== 'w' && key !== 's') return;
  if (MaweInlineEdit.editingState) return;
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
  if (MaweDom.multiSubtitleSplitModal?.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (e.ctrlKey || e.metaKey) return;
  const direction = (key === 'a' || key === 'w') ? -1 : 1;
  const panelTarget = MaweCuePanel.getCurrentCuePanelTarget();
  const extensionTarget = panelTarget?.kind === 'extension';
  const extensionTrack = extensionTarget ? panelTarget.track : null;
  const segments = extensionTarget ? extensionTrack.segments : MaweBoot.DATA.segments;
  const wasPlaying = !MaweCoreState.player.paused;
  const heldCueKey = (!e.shiftKey || key === 'a' || key === 'd')
    && MaweCoreState.waveformEditor?.handleHeldCueKey?.(
      direction,
      direction * MaweTimeline.timelineCueMoveStepValue(),
      { shiftKey: e.shiftKey, altKey: e.altKey, snap: key === 'a' || key === 'd' },
    );
  if (heldCueKey) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (e.altKey) return;
  const navigationIndex = wasPlaying
    ? -1
    : (extensionTarget ? panelTarget?.index ?? -1 : MaweCuePanelState.currentCuePanelIdx);
  let next = e.shiftKey
    ? window.AsrEditorUtils.findCueSelectionExtensionTarget(
      segments,
      extensionTarget ? MaweSelection.selectedExtensionIdxs : MaweSelection.selectedIdxs,
      navigationIndex,
      Math.round(MaweCoreState.player.currentTime * 1000),
      direction,
      MaweDom.hideDisabled,
    )
    : window.AsrEditorUtils.findCueNavigationTarget(
      segments,
      navigationIndex,
      Math.round(MaweCoreState.player.currentTime * 1000),
      direction,
      MaweDom.hideDisabled,
    );
  if (next < 0) {
    const eligible = segments
      .map((segment, index) => ({ segment, index }))
      .filter(({ segment }) => segment && (!MaweDom.hideDisabled || !segment.disabled));
    next = direction < 0
      ? (eligible[0]?.index ?? -1)
      : (eligible[eligible.length - 1]?.index ?? -1);
  }
  if (next < 0) return;

  e.preventDefault();
  e.stopPropagation();
  if (extensionTarget) {
    if (e.shiftKey) MaweSelection.addExtensionToSelection(next, extensionTrack);
    else MaweSelection.selectOnlyExtension(next);
    MaweSelection.lastClickedExtensionIdx = next;
  } else {
    if (e.shiftKey) MaweSelection.addToSelection(next);
    else MaweSelection.selectOnly(next);
    MaweSelection.lastClickedIdx = next;
  }
  const cue = MaweCoreState.container.querySelector(
    extensionTarget
      ? `.multi-dual-cue[data-ext-idx="${next}"], .multi-extension-cue[data-ext-idx="${next}"]`
      : `.cue[data-idx="${next}"], .multi-dual-cue[data-main-idx="${next}"]`,
  );
  if (cue) MaweCueListAnchor.scrollCueToCenter(cue);
  MaweCoreState.waveformEditor?.revealTime(segments[next].start, true);
  MaweTextCleanup.seekFromWaveform(segments[next].start / 1000);
  if (wasPlaying && MaweCoreState.player.paused) {
    const promise = MaweCoreState.player.play();
    if (promise && promise.catch) promise.catch(() => {});
  }
});



// Ctrl(Cmd)+Shift+A/D：把当前主/副字幕与前一条/后一条直接粘合。
// 不改变 Ctrl(Cmd)+A/D 的全选与清除选择语义。
document.addEventListener('keydown', (e) => {
  if (!['a', 'A', 'd', 'D'].includes(e.key)) return;
  if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || e.repeat) return;
  if (MaweInlineEdit.editingState || e.target === MaweDom.cuePanelText) return;
  const active = document.activeElement;
  if (active && (
    active.tagName === 'INPUT' || active.tagName === 'TEXTAREA'
      || active.tagName === 'SELECT' || active.isContentEditable
  )) return;
  if (MaweDom.replaceModal.classList.contains('show') || MaweDom.stickerModal.classList.contains('show')
      || MaweDom.stickerPreviewModal.classList.contains('show') || MaweDom.projectMediaModal.classList.contains('show')
      || document.getElementById('sticker-root-modal').classList.contains('show')
      || MaweDom.ctxmenu.classList.contains('show')) return;
  e.preventDefault();
  e.stopPropagation();
  MaweMergeAdjacent.mergeAdjacentSubtitle(e.key.toLowerCase() === 'a' ? -1 : 1);
});

// Ctrl(Cmd)+A：选中所有字幕。仅在「非编辑字幕」状态下生效；
// 焦点在输入框/文本域/可编辑元素或内联编辑态时，保留浏览器原生的「全选文本」行为。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'a' && e.key !== 'A') return;
  if (!e.ctrlKey && !e.metaKey) return;
  if (e.altKey || e.shiftKey) return;
  if (MaweInlineEdit.editingState) return;
  if (e.target === MaweDom.cuePanelText) return;
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
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  e.preventDefault();
  MaweSelection.selectAll();
});

// Ctrl(Cmd)+D：取消选中（清空当前字幕选择）。浏览器默认是「添加书签」，这里接管；
// 与 Ctrl(Cmd)+A 同样仅在非编辑字幕状态下生效。ESC 清除选中的行为保持不变。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'd' && e.key !== 'D') return;
  if (!e.ctrlKey && !e.metaKey) return;
  if (e.altKey || e.shiftKey) return;
  if (MaweInlineEdit.editingState) return;
  if (e.target === MaweDom.cuePanelText) return;
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
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (MaweSelection.selectedIdxs.size === 0 && MaweSelection.selectedExtensionIdxs.size === 0) return;
  e.preventDefault();
  MaweSelection.clearSelection();
});

// T：给选中字幕分配表情包。单选直接分配本条，多选统一分配（与右键菜单一致）。
document.addEventListener('keydown', (e) => {
  if (e.key !== 't' && e.key !== 'T') return;
  if (MaweInlineEdit.editingState || e.repeat) return;
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
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  if (MaweSelection.selectedIdxs.size === 0 && MaweState.selection.indices('overlay').size === 0) return;
  e.preventDefault();
  if (MaweState.selection.indices('overlay').size > 0) {
    const overlayIdxs = [...MaweState.selection.indices('overlay')].sort((x, y) => x - y);
    MaweStickerPicker.openStickerPicker(overlayIdxs, overlayIdxs.length > 1, { overlay: true });
    return;
  }
  const idxs = [...MaweSelection.selectedIdxs].sort((x, y) => x - y);
  MaweStickerPicker.openStickerPicker(idxs, idxs.length > 1);
});

// 数字键 1~5：给选中字幕标记对应颜色（红黄蓝绿紫）；0：清除颜色。
document.addEventListener('keydown', (e) => {
  if (!/^[0-5]$/.test(e.key)) return;
  if (MaweInlineEdit.editingState || e.repeat) return;
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
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  if (MaweSelection.selectedIdxs.size === 0 && MaweState.selection.indices('overlay').size === 0) return;
  e.preventDefault();
  if (MaweState.selection.indices('overlay').size > 0) {
    const overlayIdxs = [...MaweState.selection.indices('overlay')].sort((x, y) => x - y);
    if (e.key === '0') {
      clearOverlayColorOnTargets(overlayIdxs);
      return;
    }
    const overlayColor = MaweColors.COLOR_PALETTE[Number(e.key) - 1];
    if (overlayColor) assignOverlayColor(overlayIdxs, overlayColor.name);
    return;
  }
  const idxs = [...MaweSelection.selectedIdxs].sort((x, y) => x - y);
  if (e.key === '0') {
    MaweStickerPicker.clearColorOnTargets(idxs);
    return;
  }
  const color = MaweColors.COLOR_PALETTE[Number(e.key) - 1];
  if (color) MaweStickerPicker.assignColor(idxs, color.name);
});

// Enter：聚焦最后点击的主/副字幕对应的字幕编辑区，并把光标置于末尾。
// 绑定字幕同时选中时仍以最后点击的一侧为准；内联编辑态、已聚焦编辑区或模态打开时不触发。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (MaweInlineEdit.editingState || MaweInlineEdit.extensionEditingState) return;  // 内联编辑态的 Enter 交给 split/commit 处理
  if (e.target === MaweDom.cuePanelText) return;  // 已在字幕编辑区
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;  // 仅响应裸 Enter
  const a = document.activeElement;
  if (a && (
    a.tagName === 'INPUT'
    || a.tagName === 'TEXTAREA'
    || a.tagName === 'SELECT'
    || a.tagName === 'BUTTON'
    || a.isContentEditable
  )) return;
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (MaweDom.projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (!MaweCuePanel.getCurrentCuePanelTarget()) {
    e.preventDefault();
    e.stopPropagation();
    MaweShortcuts.showShortcutBlocked('请先选中字幕');
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  MaweCuePanel.focusCuePanelText();
});

// C：合并连续选中的字幕块。少于两条时只提示，不改动工程。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'c' && e.key !== 'C') return;
  if (MaweInlineEdit.editingState || e.repeat) return;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return;
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (MaweDom.projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  e.preventDefault();
  e.stopPropagation();
  const currentTarget = MaweCuePanel.getCurrentCuePanelTarget();
  if (
    MaweState.selection.indices('overlay').size > 1
    && (currentTarget?.kind === 'overlay' || (MaweSelection.selectedIdxs.size === 0 && MaweSelection.selectedExtensionIdxs.size === 0))
  ) {
    mergeOverlayCues([...MaweState.selection.indices('overlay')]);
    return;
  }
  if (
    MaweSelection.selectedExtensionIdxs.size > 0
    && (currentTarget?.kind === 'extension' || MaweSelection.selectedIdxs.size === 0)
  ) {
    MaweSegmentOps.mergeExtensionSegments(
      [...MaweSelection.selectedExtensionIdxs],
      currentTarget?.kind === 'extension' ? currentTarget.track : MaweMultiSubtitleCore.getActiveExtensionTrack(),
    );
    return;
  }
  MaweSegmentOps.mergeSegments([...MaweSelection.selectedIdxs]);
});


// Ctrl(Cmd)+Z 撤销；Ctrl(Cmd)+Shift+Z 或 Ctrl(Cmd)+Y 重做
document.addEventListener('keydown', (e) => {
  const isZ = e.key === 'z' || e.key === 'Z';
  const isY = e.key === 'y' || e.key === 'Y';
  if (!isZ && !isY) return;
  if (!(e.ctrlKey || e.metaKey)) return;
  const isRedo = isY || e.shiftKey;
  // 编辑文本时让浏览器自己处理 input 内的撤销/重做
  if (MaweHistory.historyGuarded()) return;
  e.preventDefault();
  if (isRedo) MaweHistory.performRedo();
  else MaweHistory.performUndo();
});

// Delete 键删除选中的字幕（最小命令面，供回归测试与键盘操作）
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  // 编辑文本时让浏览器自己处理
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return;
  // modal 打开时不触发
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (MaweDom.projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  if (MaweSelection.selectedIdxs.size === 0 && MaweSelection.selectedExtensionIdxs.size > 0) {
    e.preventDefault();
    e.stopPropagation();
    MaweSegmentOps.deleteExtensionSegments([...MaweSelection.selectedExtensionIdxs]);
    return;
  }
  if (MaweSelection.selectedIdxs.size === 0 && MaweSelection.selectedExtensionIdxs.size === 0 && MaweState.selection.indices('overlay').size > 0) {
    e.preventDefault();
    e.stopPropagation();
    deleteOverlayCues([...MaweState.selection.indices('overlay')]);
    return;
  }
  if (MaweSelection.selectedIdxs.size === 0) return;
  e.preventDefault();
  e.stopPropagation();
  MaweSegmentOps.deleteSegments([...MaweSelection.selectedIdxs]);
});

// 波形工具切换：V=选择（默认），R=剃刀，Esc=切回选择。与 J/K/L 一样只在
// 非输入/非模态/非编辑态下触发，避免抢占文本编辑与弹窗按键。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'v' && e.key !== 'V' && e.key !== 'r' && e.key !== 'R' && e.key !== 'Escape') return;
  if (!MaweCoreState.waveformEditor) return;
  // Escape：上下文菜单/弹窗/编辑态各自先处理；只有波形工具在 razor 时才切回。
  if (e.key === 'Escape') {
    if (MaweInlineEdit.editingState) return;
    if (MaweDom.ctxmenu.classList.contains('show')) return;
    if (MaweDom.replaceModal.classList.contains('show')) return;
    if (MaweDom.stickerModal.classList.contains('show')) return;
    if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
    if (MaweDom.projectMediaModal.classList.contains('show')) return;
    if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
    if (MaweCoreState.waveformEditor.cancelCueDrag()) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (MaweCoreState.waveformEditor.getTool() !== 'razor') return;
    e.preventDefault();
    MaweCoreState.waveformEditor.setTool('select');
    return;
  }
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return;
  if (MaweInlineEdit.editingState) return;
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (MaweDom.projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  const tool = (e.key === 'v' || e.key === 'V') ? 'select' : 'razor';
  if (MaweCoreState.waveformEditor.getTool() === tool) return;
  e.preventDefault();
  MaweCoreState.waveformEditor.setTool(tool);
});

// F：跳转并播放选中字幕（多选跳到第一条）。任意单击行为下都生效；
// 文本编辑、弹窗和修饰键状态下不抢占输入。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'f' && e.key !== 'F') return;
  if (MaweInlineEdit.editingState || e.repeat) return;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return;
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (MaweDom.projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  const target = MaweCuePanel.getCurrentCuePanelTarget();
  const extensionTarget = target?.kind === 'extension';
  const selected = extensionTarget ? MaweSelection.selectedExtensionIdxs : MaweSelection.selectedIdxs;
  const segments = extensionTarget ? target.track.segments : MaweBoot.DATA.segments;
  if (!selected.size) return;
  const first = Math.min(...selected);
  const segment = segments[first];
  if (!segment) return;
  MaweTextCleanup.seekFromWaveform(segment.start / 1000);
  if (MaweCoreState.player.paused) MaweMediaPlayback.togglePlayback();
});



// I/O：跳到当前字幕的开头/结尾并保持暂停。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'i' && e.key !== 'I' && e.key !== 'o' && e.key !== 'O') return;
  if (MaweInlineEdit.editingState || MaweInlineEdit.extensionEditingState || e.repeat || MaweKeyboardTargets.isTextEditingTarget(e)) return;
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (MaweDom.projectMediaModal.classList.contains('show')) return;
  if (MaweDom.multiSubtitleSplitModal?.classList.contains('show')) return;
  if (MaweDom.multiSubtitleImportModal?.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  const boundary = e.key.toLowerCase() === 'i' ? 'start' : 'end';
  if (!MaweNavPreview.seekCurrentCueBoundary(boundary)) return;
  e.preventDefault();
  e.stopPropagation();
});

// N：仅在鼠标位于波形行时，从指针音频位置创建字幕；创建后单选新字幕，
// 切换当前字幕面板并聚焦面板文本框。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'n' && e.key !== 'N') return;
  if (MaweInlineEdit.editingState || e.repeat || MaweKeyboardTargets.isTextEditingTarget(e)) return;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return;
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (MaweDom.projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  const reference = MaweNavPreview.keyboardOperationReference();
  if (!reference) {
    MaweHint.flashHint('无有效的快捷键时间基准', 'invalid');
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  MaweNavPreview.lastEditRegion = 'waveform';
  if (reference.track === 'extension' && MaweMultiSubtitleCore.multiSubtitleVisible()) {
    MaweAddCue.addExtensionAtWaveformTime(reference.timeMs, MaweNavPreview.lastPointerPos?.x || 0, MaweNavPreview.lastPointerPos?.y || 0, MaweMultiSubtitleCore.getExtensionTrack(reference.trackId));
  } else {
    MaweAddCue.addCueAtWaveformTime(reference.timeMs, MaweNavPreview.lastPointerPos?.x || 0, MaweNavPreview.lastPointerPos?.y || 0);
  }
});

// G：绑定当前单选的副字幕。若同时选中一条主字幕则直接绑定，否则沿用
// 右键「绑定到主字幕」的自动匹配/等待选择流程。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'g' && e.key !== 'G') return;
  if (MaweInlineEdit.editingState || MaweInlineEdit.extensionEditingState || e.repeat) return;
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
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (!MaweMultiSubtitleCore.multiSubtitleVisible()) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  if (MaweSelection.selectedExtensionIdxs.size !== 1) {
    e.preventDefault();
    e.stopPropagation();
    MaweShortcuts.showShortcutBlocked('请先选中一条副字幕');
    return;
  }
  if (MaweSelection.selectedIdxs.size > 1) {
    e.preventDefault();
    e.stopPropagation();
    MaweShortcuts.showShortcutBlocked('绑定最多需要一条主字幕');
    return;
  }
  const extensionIndex = [...MaweSelection.selectedExtensionIdxs][0];
  const track = MaweMultiSubtitleCore.getActiveExtensionTrack();
  const extension = track?.segments?.[extensionIndex];
  const binding = MaweMultiSubtitleCore.bindingForExtensionIndex(extensionIndex, track);
  if (!extension) {
    e.preventDefault();
    e.stopPropagation();
    MaweShortcuts.showShortcutBlocked('当前副字幕不存在');
    return;
  }
  if (e.shiftKey) {
    e.preventDefault();
    e.stopPropagation();
    if (!binding) {
      MaweHint.flashHint('当前副字幕没有绑定关系', 'invalid');
      return;
    }
    MaweBindingAlign.unbindSelectedSubtitlePair();
    return;
  }
  if (e.shiftKey) return;
  if (binding) {
    e.preventDefault();
    e.stopPropagation();
    MaweShortcuts.showShortcutBlocked('当前副字幕已绑定，请先解绑后再绑定');
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  if (MaweSelection.selectedIdxs.size === 1) {
    MaweBindingAlign.bindSelectedSubtitlePair();
  } else {
    MaweBindingAlign.beginPendingExtensionBinding(extensionIndex, track);
  }
});

// H：把当前选中的副字幕批量对齐到各自绑定的主字幕时间轴。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'h' && e.key !== 'H') return;
  if (MaweInlineEdit.editingState || MaweInlineEdit.extensionEditingState || e.repeat) return;
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
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  if (!MaweMultiSubtitleCore.multiSubtitleVisible()) return;
  if (!MaweSelection.selectedExtensionIdxs.size) {
    e.preventDefault();
    e.stopPropagation();
    MaweShortcuts.showShortcutBlocked('请先选中至少一条副字幕');
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  MaweBindingAlign.alignSelectedExtensionSubtitleRanges();
});

// B：按当前键盘时间基准与指针所在区域分发——
// 1) 鼠标悬停在已单选的字幕列表行上：按指针对应的文字位置拆分；
// 2) 鼠标位于波形上：按指针的音频位置拆分（与波形右键「按音频位置拆分」一致）；
// 3) 其它位置：按当前键盘时间基准拆分。
// 文本编辑、弹窗和修饰键状态下不抢占输入。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'b' && e.key !== 'B') return;
  if (e.repeat) return;
  const forceMainEdit = MaweInlineEdit.editingState?.forceSplitArmed === true;
  if (MaweInlineEdit.extensionEditingState && !forceMainEdit) {
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    const state = MaweInlineEdit.extensionEditingState;
    const offset = MaweInlineEdit.caretOffsetInText(state.textEl);
    const track = MaweMultiSubtitleCore.getExtensionTrack(state.trackId);
    if (!Number.isFinite(offset) || !track?.segments?.[state.index]) {
      MaweHint.flashHint('无法定位副字幕的文字光标', 'warning');
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    // 先在编辑 DOM 消失前记录列表内光标位置，弹窗提交后的刀光留在原位。
    const editFeedbackPoint = MaweNinja.ninjaSplitPointFromRange(
      null, state.textEl, offset, String(state.textEl.innerText || '').length,
    );
    MaweInlineEdit.finishExtensionEdit(true);
    MaweSplitCore.openExtensionSplitModal(state.index, null, track, {
      extensionOffset: offset,
      feedbackPoint: editFeedbackPoint,
      ninjaFromList: true,
    });
    return;
  }
  if (MaweInlineEdit.editingState && !forceMainEdit) return;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT'
    || (a.isContentEditable && !forceMainEdit))) return;
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (MaweDom.projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  if (forceMainEdit) {
    e.preventDefault();
    e.stopImmediatePropagation();
    MaweSplitCore.splitAtCursor();
    return;
  }
  const splitAt = (idx, x, y, timeMs) => {
    e.preventDefault();
    // B 打开弹窗后，事件仍会继续传播到后面注册的弹窗快捷键监听器；
    // 立即停止同一事件，避免“按 B 打开”被误当成“按 B 确认”。
    e.stopImmediatePropagation();
    MaweSplitContext.splitFromContextMenu(idx, x, y, timeMs);
  };
  // 多重字幕下，只有副字幕是当前编辑焦点时，B 才直接打开副字幕拆分流程。
  // 绑定关系会让点击主字幕时同时选中副字幕；不能仅凭 selectedExtensionIdxs
  // 判断当前轨道，否则主字幕 active 时会被误判成副字幕单独拆分。
  const activeCuePanel = MaweCuePanel.getCurrentCuePanelTarget();
  const operationReference = MaweNavPreview.keyboardOperationReference();
  const pointerMainIndex = operationReference
    ? MaweContextMenus.findWaveformCueAtTime(operationReference.timeMs, MaweBoot.DATA.segments) : -1;
  const activeExtensionTrack = MaweMultiSubtitleCore.getActiveExtensionTrack();
  const pointerExtensionIndex = operationReference?.track === 'extension'
    ? MaweContextMenus.findWaveformCueAtTime(operationReference.timeMs, MaweMultiSubtitleCore.getExtensionTrack(operationReference.trackId)?.segments) : -1;
  if (MaweSelection.selectedExtensionIdxs.size === 1) {
    const context = MaweNavPreview.hoveredSelectedCueContext();
    if (context?.kind === 'extension' && context.track?.segments?.[context.idx]) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const initial = Number.isFinite(context.offset)
        ? {
          extensionOffset: context.offset,
          feedbackPoint: context.caretRect ? MaweNinja.ninjaSplitPointFromRect(context.caretRect) : null,
          ninjaFromList: true,
        } : {};
      MaweSplitCore.openExtensionSplitModal(context.idx, null, context.track, initial);
      return;
    }
  }
  // 波形区点击副字幕后，绑定关系可能同时选中主字幕；但只要当前面板和
  // 波形指针都明确落在这条单选副字幕上，B 就应拆分副字幕，而不是被重叠
  // 的主字幕时间范围抢走目标。主字幕面板仍不会进入这个例外分支。
  const waveformExtensionIsActive = MaweMultiSubtitleCore.multiSubtitleVisible()
    && activeCuePanel?.kind === 'extension'
    && MaweSelection.selectedExtensionIdxs.size === 1
    && MaweSelection.selectedExtensionIdxs.has(activeCuePanel.index)
    && operationReference?.track === 'extension'
    && pointerExtensionIndex === activeCuePanel.index;
  const extensionIsActive = MaweMultiSubtitleCore.multiSubtitleVisible()
    && activeCuePanel?.kind === 'extension'
    && MaweSelection.selectedExtensionIdxs.size === 1
    && MaweSelection.selectedExtensionIdxs.has(activeCuePanel.index)
    && (!operationReference || pointerMainIndex < 0 || waveformExtensionIsActive);
  if (extensionIsActive) {
    const extensionIndex = [...MaweSelection.selectedExtensionIdxs][0];
    const track = activeExtensionTrack;
    const extension = track?.segments?.[extensionIndex];
    if (!extension) return;
    let timeMs = null;
    const pointerElement = MaweNavPreview.lastPointerPos
      ? document.elementFromPoint(MaweNavPreview.lastPointerPos.x, MaweNavPreview.lastPointerPos.y)
      : null;
    if (MaweSettings.EDITOR_SETTINGS.keyboardOperationReference === 'pointer'
        && MaweNavPreview.lastPointerPos && (pointerElement?.closest('#waveform-pane') || MaweNavPreview.lastEditRegion === 'waveform')) {
      const pointerTimeMs = MaweCoreState.waveformEditor?.timeMsAtPoint?.(MaweNavPreview.lastPointerPos.x, MaweNavPreview.lastPointerPos.y);
      if (Number.isFinite(pointerTimeMs) && pointerTimeMs > extension.start && pointerTimeMs < extension.end) {
        timeMs = pointerTimeMs;
      }
    }
    e.preventDefault();
    // 同上：首次 B 只负责打开副字幕拆分弹窗。
    e.stopImmediatePropagation();
    MaweSplitCore.openExtensionSplitModal(
      extensionIndex,
      MaweSettings.EDITOR_SETTINGS.keyboardOperationReference === 'playhead'
        ? operationReference?.timeMs ?? null : timeMs,
      track,
    );
    return;
  }
  // 1) 字幕列表：需要单选 + 悬停提供文字位置
  if (MaweSelection.selectedIdxs.size === 1) {
    const context = MaweNavPreview.hoveredSelectedCueContext();
    if (context && MaweBoot.DATA.segments[context.idx]) {
      splitAt(context.idx, context.x, context.y, null);
      return;
    }
  }
  // 2) 波形：指针音频位置
  if (operationReference?.source === 'pointer' || operationReference?.track === 'extension') {
    const idx = MaweContextMenus.findWaveformCueAtTime(operationReference.timeMs, MaweBoot.DATA.segments);
    if (idx >= 0) {
      splitAt(idx, 0, 0, operationReference.timeMs);
      return;
    }
    const extensionTrack = MaweMultiSubtitleCore.getActiveExtensionTrack();
    const extensionIndex = MaweMultiSubtitleCore.multiSubtitleVisible() && operationReference.track === 'extension'
      ? MaweContextMenus.findWaveformCueAtTime(operationReference.timeMs, MaweMultiSubtitleCore.getExtensionTrack(operationReference.trackId)?.segments) : -1;
    if (extensionIndex >= 0) {
      e.preventDefault();
      e.stopImmediatePropagation();
      MaweSplitCore.openExtensionSplitModal(extensionIndex, operationReference.timeMs, MaweMultiSubtitleCore.getExtensionTrack(operationReference.trackId));
      return;
    }
    MaweHint.flashHint('指针位置没有可拆分字幕', 'invalid');
    return;
  }
  // 3) 播放头位置
  const timeMs = operationReference?.timeMs ?? Math.round(MaweCoreState.player.currentTime * 1000);
  const idx = MaweBoot.DATA.segments.findIndex((segment) => timeMs > segment.start && timeMs < segment.end);
  if (idx >= 0) {
    splitAt(idx, 0, 0, timeMs);
    return;
  }
  const extensionTrack = MaweMultiSubtitleCore.getActiveExtensionTrack();
  const extensionIndex = MaweMultiSubtitleCore.multiSubtitleVisible()
    ? MaweContextMenus.findWaveformCueAtTime(timeMs, extensionTrack?.segments) : -1;
  if (extensionIndex >= 0) {
    e.preventDefault();
    e.stopImmediatePropagation();
    MaweSplitCore.openExtensionSplitModal(extensionIndex, timeMs, extensionTrack);
    return;
  }
  MaweHint.flashHint('播放头位置没有可拆分字幕', 'invalid');
});

// 点击输入框外 -> 完成内联编辑。使用 pointerdown 捕获阶段，确保字幕行、
// 波形或其它控件的 pointerdown 处理/重绘发生前，当前文字已经写回 DATA。
// 双列时编辑行的容器同时包含主/副两列，因此只判断当前 contenteditable。
document.addEventListener('pointerdown', (e) => {
  const target = e.target instanceof Node ? e.target : null;
  if (MaweInlineEdit.editingState && (!target || !MaweInlineEdit.editingState.textEl.contains(target))) MaweInlineEdit.finishEdit(true);
  if (MaweInlineEdit.extensionEditingState && (
    !target || !MaweInlineEdit.extensionEditingState.textEl.contains(target)
  )) MaweInlineEdit.finishExtensionEdit(true);
}, true);
