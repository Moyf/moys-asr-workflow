// 撤销/重做：历史栈、快照与各类型记录的入栈恢复。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweHistory 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweHistory(global) {
  'use strict';



  // === 统一撤销/重做 ===
  // 四种记录 kind 共享一个历史栈：
  //   segments   —— 字幕增删改、拆分合并、表情包/颜色、批量替换等
  //   layout     —— 布局导入/重置/拖动停靠
  //   gap_remove —— 静音空隙扫描与人工修正
  //   preview    —— 字幕预览（overlay）开关
  // 栈深上限 100；新动作清空 redo；Ctrl(Cmd)+Z 撤销、Ctrl(Cmd)+Shift+Z 重做。
  // 编辑文本输入框或 modal 打开时让原生行为优先（见 keydown 守卫）。
  const UNDO_LIMIT = 100;


  const editorHistory = window.AsrEditorUtils.createHistoryStack(UNDO_LIMIT);


  let gapRemoveDirty = false;


  function snapshotSegments() {
  // _dirty 也保留，恢复后能再次导出"工程文件"时正确标记；多字幕数据与主轨
  // 必须处于同一条记录中，绑定/成对删除/联动拆分才能原子撤销。
  return EDITOR_SETTINGS_UTILS.buildSegmentsHistorySnapshot(
    MaweBoot.DATA.segments,
    MaweMultiSubtitleCore.getMultiSubtitleState(),
    getOverlayTrack(),
  );
}


  function snapshotEditorSelection() {
  const extensionTrack = MaweMultiSubtitleCore.getActiveExtensionTrack();
  const panelTrack = MaweCuePanelState.currentCuePanelKind === 'extension'
    ? MaweMultiSubtitleCore.getExtensionTrack(MaweCuePanelState.currentCuePanelTrackId) : null;
  return {
    mainIds: [...MaweSelection.selectedIdxs]
      .map((index) => MaweBoot.DATA.segments[index]?.id)
      .filter(Boolean),
    extensionTrackId: extensionTrack?.id || null,
    extensionIds: extensionTrack
      ? [...MaweSelection.selectedExtensionIdxs].map((index) => extensionTrack.segments[index]?.id).filter(Boolean)
      : [],
    overlayIds: [...selectedOverlayIdxs]
      .map((index) => getOverlayTrack()?.segments?.[index]?.id)
      .filter(Boolean),
    panelKind: MaweCuePanelState.currentCuePanelKind,
    panelTrackId: panelTrack?.id || MaweCuePanelState.currentCuePanelTrackId || null,
    panelId: MaweCuePanelState.currentCuePanelKind === 'extension'
      ? panelTrack?.segments?.[MaweCuePanelState.currentCuePanelIdx]?.id || null
      : MaweCuePanelState.currentCuePanelKind === 'overlay'
      ? getOverlayTrack()?.segments?.[MaweCuePanelState.currentCuePanelIdx]?.id || null
      : MaweBoot.DATA.segments[MaweCuePanelState.currentCuePanelIdx]?.id || null,
    lastMainId: MaweBoot.DATA.segments[MaweSelection.lastClickedIdx]?.id || null,
    lastExtensionId: extensionTrack?.segments?.[MaweSelection.lastClickedExtensionIdx]?.id || null,
    lastOverlayId: getOverlayTrack()?.segments?.[lastClickedOverlayIdx]?.id || null,
  };
}


  function pushUndo(label, { captureView = false } = {}) {
    MaweCueListAnchor.rememberCueListMutation();
    const record = window.AsrEditorUtils.buildHistoryRecord(
      'segments', label, snapshotSegments(), captureView ? snapshotEditorSelection() : null,
    );
    editorHistory.push(record);
    updateUndoRedoButtons();
    return record;
  }


  function pushLayoutUndo(label, snapshot) {
    if (!snapshot) return;
    editorHistory.push(window.AsrEditorUtils.buildHistoryRecord('layout', label, snapshot));
    updateUndoRedoButtons();
  }


  function pushGapRemoveUndo(label) {
    editorHistory.push(window.AsrEditorUtils.buildHistoryRecord('gap_remove', label, {
      gapRemove: MaweBoot.DATA.gap_remove,
      gapRemoveDirty,
    }));
    updateUndoRedoButtons();
  }


  function pushPreviewUndo(label, preview) {
    editorHistory.push(window.AsrEditorUtils.buildHistoryRecord('preview', label, preview));
    updateUndoRedoButtons();
  }


  function snapshotPreviewState() {
    return {
      overlay: !!MaweDom.overlayToggle.checked,
      subtitle: { ...MaweAppearance.getPreviewGeometry(), ...MaweAppearance.getSubtitleAppearance() },
      speakerLabels: MaweSpeakerLabels.getSpeakerLabelSettings(),
      extensionOverlay: !!MaweDom.extensionOverlayToggle?.checked,
      extensionSubtitle: { ...MaweAppearance.getStoredExtensionSubtitleAppearance() },
      sticker: { ...MawePreviewGeometry.getStickerGeometry() },
    };
  }


  function applyPreviewState(state) {
    if (!state || typeof state.overlay !== 'boolean') return;
    MaweDom.overlayToggle.checked = state.overlay;
    MaweSettings.updateEditorSettings({ overlayEnabled: state.overlay });
    if (typeof state.extensionOverlay === 'boolean' && MaweDom.extensionOverlayToggle) {
      MaweDom.extensionOverlayToggle.checked = state.extensionOverlay && MaweMultiSubtitleCore.multiSubtitleVisible();
      MaweSettings.updateEditorSettings({ extensionOverlayEnabled: state.extensionOverlay });
    }
    if (state.subtitle) MawePreviewGeometry.setPreviewGeometry(state.subtitle, { markDirty: true, replaceAppearance: true });
    if (state.speakerLabels) MaweSpeakerLabels.setSpeakerLabelSettings(state.speakerLabels, { markDirty: true });
    if (state.extensionSubtitle) MaweAppearance.restoreExtensionSubtitleAppearance(state.extensionSubtitle, { markDirty: true });
    if (state.sticker) MawePreviewGeometry.setStickerGeometry(state.sticker, { markDirty: true });
    MawePreviewGeometry.refreshPreviewGeometryEditable();
    MawePlaybackLoop.update();
  }


  // 按记录 kind 拍下当前状态，作为对端栈的镜像（label 沿用原记录）
  function snapshotCurrentForKind(kind, label, sourceRecord = null) {
    if (kind === 'layout') {
      return window.AsrEditorUtils.buildHistoryRecord(
        'layout', label, MaweCoreState.waveformEditor?.getLayoutHistorySnapshot?.() || null,
      );
    }
    if (kind === 'gap_remove') {
      return window.AsrEditorUtils.buildHistoryRecord('gap_remove', label, {
        gapRemove: MaweBoot.DATA.gap_remove,
        gapRemoveDirty,
      });
    }
    if (kind === 'preview') {
      return window.AsrEditorUtils.buildHistoryRecord('preview', label, snapshotPreviewState());
    }
    return window.AsrEditorUtils.buildHistoryRecord(
      'segments', label, snapshotSegments(), sourceRecord?.view ? snapshotEditorSelection() : null,
    );
  }


  function restoreEditorSelection(snapshot) {
  if (!snapshot) return;
  MaweSelection.selectedIdxs.clear();
  MaweSelection.selectedExtensionIdxs.clear();
  selectedOverlayIdxs.clear();
  const mainIds = new Set(snapshot.mainIds || []);
  MaweBoot.DATA.segments.forEach((segment, index) => {
    if (mainIds.has(segment?.id)) MaweSelection.selectedIdxs.add(index);
  });
  const extensionTrack = MaweMultiSubtitleCore.getExtensionTrack(snapshot.extensionTrackId) || MaweMultiSubtitleCore.getActiveExtensionTrack();
  const extensionIds = new Set(snapshot.extensionIds || []);
  if (extensionTrack) {
    extensionTrack.segments.forEach((segment, index) => {
      if (extensionIds.has(segment?.id)) MaweSelection.selectedExtensionIdxs.add(index);
    });
  }
  const overlayIds = new Set(snapshot.overlayIds || []);
  (getOverlayTrack()?.segments || []).forEach((segment, index) => {
    if (overlayIds.has(segment?.id)) selectedOverlayIdxs.add(index);
  });
  MaweSelection.lastClickedIdx = snapshot.lastMainId
    ? MaweBoot.DATA.segments.findIndex((segment) => segment?.id === snapshot.lastMainId) : -1;
  MaweSelection.lastClickedExtensionIdx = extensionTrack && snapshot.lastExtensionId
    ? extensionTrack.segments.findIndex((segment) => segment?.id === snapshot.lastExtensionId) : -1;
  lastClickedOverlayIdx = snapshot.lastOverlayId != null
    ? (getOverlayTrack()?.segments || []).findIndex((segment) => segment?.id === snapshot.lastOverlayId) : -1;
  const panelTrack = snapshot.panelTrackId ? MaweMultiSubtitleCore.getExtensionTrack(snapshot.panelTrackId) : null;
  if (snapshot.panelKind === 'extension' && panelTrack && snapshot.panelId) {
    MaweCuePanelState.currentCuePanelKind = 'extension';
    MaweCuePanelState.currentCuePanelTrackId = panelTrack.id;
    MaweCuePanelState.currentCuePanelIdx = panelTrack.segments.findIndex((segment) => segment?.id === snapshot.panelId);
    if (MaweCuePanelState.currentCuePanelIdx < 0) {
      MaweCuePanelState.currentCuePanelKind = 'main';
      MaweCuePanelState.currentCuePanelTrackId = null;
    }
  } else if (snapshot.panelKind === 'overlay' && snapshot.panelId) {
    MaweCuePanelState.currentCuePanelKind = 'overlay';
    MaweCuePanelState.currentCuePanelTrackId = null;
    MaweCuePanelState.currentCuePanelIdx = (getOverlayTrack()?.segments || [])
      .findIndex((segment) => segment?.id === snapshot.panelId);
    if (MaweCuePanelState.currentCuePanelIdx < 0) {
      MaweCuePanelState.currentCuePanelKind = 'main';
    }
  } else if (snapshot.panelKind === 'main' && snapshot.panelId) {
    MaweCuePanelState.currentCuePanelKind = 'main';
    MaweCuePanelState.currentCuePanelTrackId = null;
    MaweCuePanelState.currentCuePanelIdx = MaweBoot.DATA.segments.findIndex((segment) => segment?.id === snapshot.panelId);
  }
  if (MaweCuePanelState.currentCuePanelIdx < 0) {
    MaweCuePanelState.currentCuePanelKind = 'main';
    MaweCuePanelState.currentCuePanelTrackId = null;
  }
  MaweDom.selCountEl.textContent = String(
    MaweSelection.selectedIdxs.size + MaweSelection.selectedExtensionIdxs.size + selectedOverlayIdxs.size,
  );
  MaweSelection.selectedIdxs.forEach((index) => {
    MaweCoreState.container.querySelector(`.cue[data-idx="${index}"]`)?.classList.add('selected');
  });
  selectedOverlayIdxs.forEach((index) => {
    MaweCoreState.container.querySelector(`.cue[data-overlay-idx="${index}"]`)?.classList.add('selected');
  });
  MaweSelection.updateMultiSelectionClasses();
  MaweCoreState.waveformEditor?.updateSelection();
  MaweCuePanel.renderCurrentCuePanel();
}


  function applyHistoryRecord(record) {
  if (record.kind === 'layout') {
    if (!MaweCoreState.waveformEditor?.restoreLayoutHistorySnapshot?.(record.layout)) {
      MaweHint.flashHint('工作区恢复失败：波形模块尚未加载', 'warning');
      return false;
    }
    MaweBoot.DATA.workspace = MaweCoreState.waveformEditor.getLayoutData();
    return true;
  }
  if (record.kind === 'gap_remove') {
    MaweBoot.DATA.gap_remove = record.gapRemove;
    gapRemoveDirty = record.gapRemoveDirty;
    MaweGapRemoveUi.updateGapRemoveUi();
    return true;
  }
  if (record.kind === 'preview') {
    applyPreviewState(record.preview);
    return true;
  }
  const snapshot = record.segs && Array.isArray(record.segs.segments)
    ? record.segs
    : {
      segments: record.segs,
      multi_subtitle: MaweBoot.DATA.multi_subtitle,
      overlay_track: MaweBoot.DATA.overlay_track,
    };
  // 视口属于本次撤销动作，不随历史快照恢复。
  const cueListAnchor = MaweCueListAnchor.captureCueListRenderAnchor();
  const previousWaveformStructure = MaweMultiSubtitleCore.multiSubtitleWaveformStructureKey();
  MaweBoot.DATA.segments.length = 0;
  (snapshot.segments || []).forEach(s => MaweBoot.DATA.segments.push(s));
  MaweBoot.DATA.multi_subtitle = snapshot.multi_subtitle || {
    schema: 'moy.asr.multi_subtitle.v1', enabled: false, display_mode: 'both', tracks: [], bindings: [],
  };
  MaweBoot.DATA.overlay_track = MULTI_SUBTITLE_UTILS.normalizeOverlayTrack(snapshot.overlay_track);
  MaweMultiSubtitleCore.normalizeMultiSubtitleState();
  // 历史恢复会改变下标身份；丢弃旧面板绑定，避免 clearSelection() 把旧面板
  // 内容提交到恢复后占据同一下标的另一条字幕，并因此生成新历史、清空 redo。
  MaweCuePanelState.currentCuePanelIdx = -1;
  MaweCuePanelState.currentCuePanelKind = 'main';
  MaweCuePanelState.currentCuePanelTrackId = null;
  MaweCuePanelState.resetCuePanelEditState();
  MaweSelection.clearSelection();
  MawePlaybackLoop.lastActive = -1;
  const structureChanged = previousWaveformStructure
    !== MaweMultiSubtitleCore.multiSubtitleWaveformStructureKey();
  MaweCuePanel.renderAll({
    waveform: structureChanged ? 'full' : 'overlay',
    cueListAnchor,
  });
  if (record.view) restoreEditorSelection(record.view);
  return true;
}


  function performUndo() {
    const top = editorHistory.peekUndo();
    if (!top) { MaweHint.flashHint('没有可撤销的操作', 'invalid'); return; }
    if (top.kind === 'layout' && typeof MaweCoreState.waveformEditor?.restoreLayoutHistorySnapshot !== 'function') {
      MaweHint.flashHint('工作区撤销失败：波形模块尚未加载', 'warning');
      return;
    }
    if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(false);  // 撤销前丢弃当前编辑（保持快照前后一致）
    const current = snapshotCurrentForKind(top.kind, top.label, top);
    const record = editorHistory.popUndo(current);
    if (!record) return;
    applyHistoryRecord(record);
    MaweHint.flashHint(`已撤销：${record.label}（剩 ${editorHistory.undoLength()} 步）`, 'success');
    updateUndoRedoButtons();
  }


  function performRedo() {
    const top = editorHistory.peekRedo();
    if (!top) { MaweHint.flashHint('没有可重做的操作', 'invalid'); return; }
    if (top.kind === 'layout' && typeof MaweCoreState.waveformEditor?.restoreLayoutHistorySnapshot !== 'function') {
      MaweHint.flashHint('工作区重做失败：波形模块尚未加载', 'warning');
      return;
    }
    if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(false);
    const current = snapshotCurrentForKind(top.kind, top.label, top);
    const record = editorHistory.popRedo(current);
    if (!record) return;
    applyHistoryRecord(record);
    MaweHint.flashHint(`已重做：${record.label}（剩 ${editorHistory.redoLength()} 步）`, 'success');
    updateUndoRedoButtons();
  }


  // modal 或文本输入聚焦时不触发全局撤销/重做（让浏览器/输入框自己处理）
  function historyGuarded() {
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) {
      return true;
    }
    return MaweDom.replaceModal.classList.contains('show')
        || MaweDom.textProcessModal.classList.contains('show')
        || MaweDom.timedTextEditModal.classList.contains('show')
        || MaweDom.stickerModal.classList.contains('show')
        || MaweDom.stickerPreviewModal.classList.contains('show')
        || MaweDom.projectMediaModal.classList.contains('show')
        || document.getElementById('sticker-root-modal').classList.contains('show');
  }


  const undoBtn = document.getElementById('undo-btn');


  const redoBtn = document.getElementById('redo-btn');


  function updateUndoRedoButtons() {
    if (undoBtn) undoBtn.disabled = !editorHistory.canUndo();
    if (redoBtn) redoBtn.disabled = !editorHistory.canRedo();
  }

  global.MaweHistory = Object.freeze({
    UNDO_LIMIT,
    editorHistory,
    get gapRemoveDirty() { return gapRemoveDirty; },
    set gapRemoveDirty(v) { gapRemoveDirty = v; },
    snapshotSegments,
    snapshotEditorSelection,
    pushUndo,
    pushLayoutUndo,
    pushGapRemoveUndo,
    pushPreviewUndo,
    snapshotPreviewState,
    applyPreviewState,
    snapshotCurrentForKind,
    restoreEditorSelection,
    applyHistoryRecord,
    performUndo,
    performRedo,
    historyGuarded,
    undoBtn,
    redoBtn,
    updateUndoRedoButtons
  });
})(typeof window !== 'undefined' ? window : globalThis);
