import { MaweBoot } from '../boot/editor-boot.js';
import { MaweCueListAnchor } from '../cues/editor-cue-list-anchor.js';
import { renderCurrentCuePanel, renderAll } from '../cues/editor-cue-panel.js';
import { MaweInlineEdit } from '../cues/editor-inline-edit.js';
import { MaweSelection } from '../cues/editor-selection.js';
import { MaweWordTiming } from '../cues/editor-word-timing.js';
import { MaweAudioProcessing } from '../media/editor-audio-processing.js';
import { MawePlaybackLoop } from '../media/editor-playback-loop.js';
import { MawePreviewGeometry } from '../media/editor-preview-geometry.js';
import { MaweAppearance } from '../styles/editor-appearance.js';
import { MaweSpeakerLabels } from '../styles/editor-speaker-labels.js';
import { MaweAssCuePosition } from '../styles/editor-wiring-ass-cue-position.js';
import { MaweAssFrame } from '../styles/editor-wiring-ass-frame.js';
import { MaweAssManagerWiring } from '../styles/editor-wiring-ass-manager.js';
import { MaweDom } from '../ui/editor-dom.js';
import { MaweGapRemoveUi } from '../ui/editor-gap-remove-ui.js';
import { MaweHint } from '../ui/editor-hint.js';
import { MaweCoreState } from './editor-core-state.js';
import { MaweCuePanelState } from './editor-cue-panel-state.js';
import { MaweMultiSubtitleCore } from './editor-multi-subtitle-core.js';
import { syncControls } from './editor-project-settings.js';
import { MaweSettings } from './editor-settings.js';
import { MaweState } from './editor-state.js';
import { MaweViewUpdates } from './editor-view-updates.js';
import { getMaweDomPanels } from '../ui/editor-dom-panels.js';
export let MaweHistory;
import { getOverlayTrack } from '../cues/overlay-track.js';
import { afterExternalMarkersChange } from '../markers/editor-marker-editing.js';
import { AsrEditorUtils } from '../../shared/editor-utils.js';

export function initMaweHistory() {
  // 撤销/重做：历史栈、快照与各类型记录的入栈恢复。
  // 由 split-cluster codemod 自 editor.js 拆出。
  // === 统一撤销/重做 ===
  // 四种记录 kind 共享一个历史栈：
  //   segments   —— 字幕增删改、拆分合并、表情包/颜色、批量替换等
  //   layout     —— 布局导入/重置/拖动停靠
  //   gap_remove —— 静音空隙扫描与人工修正
  //   preview    —— 字幕预览（overlay）开关
  // 栈深上限 100；新动作清空 redo；Ctrl(Cmd)+Z 撤销、Ctrl(Cmd)+Shift+Z 重做。
  // 编辑文本输入框或 modal 打开时让原生行为优先（见 keydown 守卫）。
  const UNDO_LIMIT = 100;


  const editorHistory = AsrEditorUtils.createHistoryStack(UNDO_LIMIT);





  function snapshotSegments() {
  // 会话高亮可随快照保留，但不参与保存检查点；多字幕数据与主轨
  // 必须处于同一条记录中，绑定/成对删除/联动拆分才能原子撤销。
  return AsrEditorUtils.buildSegmentsHistorySnapshot(MaweBoot.DATA);
}


  function snapshotEditorSelection() {
  const kind = MaweCuePanelState.currentCuePanelKind;
  const track = kind === 'extension'
    ? MaweMultiSubtitleCore.getExtensionTrack(MaweCuePanelState.currentCuePanelTrackId)
    : kind === 'overlay' ? getOverlayTrack() : AsrEditorUtils.getMainTrack(MaweBoot.DATA);
  const segment = track?.segments?.[MaweCuePanelState.currentCuePanelIdx];
  return {
    selection: MaweState.selection.snapshot(),
    panel: segment ? { track_id: track.id, segment_id: segment.id } : null,
  };
}


  function captureSegmentsRecord(label, { captureView = true } = {}) {
    // snapshotSegments() 已是深克隆；让 buildHistoryRecord 跳过二次克隆，
    // 长工程下省掉一遍 O(工程体积) 的 JSON 序列化。
    const record = AsrEditorUtils.buildHistoryRecord(
      'segments', label, snapshotSegments(), captureView ? snapshotEditorSelection() : null,
      { clone: false },
    );
    record.projectChanges = { projectImportDirty: MaweState.changes.projectImportDirty };
    return record;
  }

  function commitRecord(record) {
    editorHistory.push(record);
    updateUndoRedoButtons();
    return record;
  }

  function pushLayoutUndo(label, snapshot) {
    if (!snapshot) return;
    editorHistory.push(AsrEditorUtils.buildHistoryRecord('layout', label, snapshot));
    updateUndoRedoButtons();
  }


  function pushGapRemoveUndo(label) {
    editorHistory.push(AsrEditorUtils.buildHistoryRecord('gap_remove', label, {
      gapRemove: MaweBoot.DATA.gap_remove,
      gapRemoveDirty: MaweState.changes.gapRemoveDirty,
    }));
    updateUndoRedoButtons();
  }


  function pushMarkersUndo(label, markersSnapshot = null) {
    editorHistory.push(AsrEditorUtils.buildHistoryRecord(
      // 撤销栈存「变更前」快照：performUndo 会把当前状态推入 redo 栈并应用本记录。
      'markers', label, markersSnapshot ?? (MaweBoot.DATA.markers || []),
    ));
    updateUndoRedoButtons();
  }


  function pushPreviewUndo(label, preview) {
    editorHistory.push(AsrEditorUtils.buildHistoryRecord('preview', label, preview));
    updateUndoRedoButtons();
  }


  function snapshotPreviewState() {
    return {
      assMode: MaweSettings.EDITOR_SETTINGS.assMode,
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
    if (typeof state.assMode === 'boolean') MaweSettings.updateEditorSettings({ assMode: state.assMode });
    syncControls?.();
    MawePreviewGeometry.refreshPreviewGeometryEditable();
    MawePlaybackLoop.update();
  }


  // 按记录 kind 拍下当前状态，作为对端栈的镜像（label 沿用原记录）
  function snapshotCurrentForKind(kind, label, sourceRecord = null) {
    if (kind === 'audio_processing') {
      return { kind, label, audioProcessing: MaweAudioProcessing.settings() };
    }
    if (kind === 'layout') {
      return AsrEditorUtils.buildHistoryRecord(
        'layout', label, MaweCoreState.waveformEditor?.getLayoutHistorySnapshot?.() || null,
      );
    }
    if (kind === 'gap_remove') {
      return AsrEditorUtils.buildHistoryRecord('gap_remove', label, {
        gapRemove: MaweBoot.DATA.gap_remove,
        gapRemoveDirty: MaweState.changes.gapRemoveDirty,
      });
    }
    if (kind === 'markers') {
      return AsrEditorUtils.buildHistoryRecord(
        'markers', label, AsrEditorUtils.cloneMarkerValue(MaweBoot.DATA.markers || []),
      );
    }
    if (kind === 'preview') {
      return AsrEditorUtils.buildHistoryRecord('preview', label, snapshotPreviewState());
    }
    const current = captureSegmentsRecord(label, { captureView: Boolean(sourceRecord?.view) });
    if (sourceRecord?.fontPreview) current.fontPreview = snapshotPreviewState();
    return current;
  }


  function restoreEditorSelection(snapshot) {
  if (!snapshot) return;
  MaweState.selection.restore(snapshot.selection);
  const panelTrack = (MaweBoot.DATA.tracks || []).find(track => track.id === snapshot.panel?.track_id);
  const panelIndex = panelTrack?.segments?.findIndex(segment => segment.id === snapshot.panel?.segment_id) ?? -1;
  MaweCuePanelState.currentCuePanelKind = panelIndex < 0 ? 'main'
    : panelTrack.role === 'secondary' ? 'extension' : panelTrack.role;
  MaweCuePanelState.currentCuePanelTrackId = panelIndex >= 0 && panelTrack.role === 'secondary' ? panelTrack.id : null;
  MaweCuePanelState.currentCuePanelIdx = panelIndex;
  MaweDom.selCountEl.textContent = String(
    MaweSelection.selectedIdxs.size + MaweSelection.selectedExtensionIdxs.size + MaweState.selection.indices('overlay').size,
  );
  MaweSelection.selectedIdxs.forEach((index) => {
    MaweCoreState.container.querySelector(`.cue[data-idx="${index}"]`)?.classList.add('selected');
  });
  MaweState.selection.indices('overlay').forEach((index) => {
    MaweCoreState.container.querySelector(`.cue[data-overlay-idx="${index}"]`)?.classList.add('selected');
  });
  MaweSelection.updateMultiSelectionClasses();
  MaweCoreState.waveformEditor?.updateSelection();
  renderCurrentCuePanel();
}


  function applyHistoryRecord(record) {
  MaweWordTiming.clearSelection();
  if (record.kind === 'audio_processing') {
    MaweAudioProcessing.change(record.audioProcessing, { recordHistory: false });
    return true;
  }
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
    MaweState.changes.gapRemoveDirty = record.gapRemoveDirty;
    MaweGapRemoveUi.updateGapRemoveUi();
    MawePlaybackLoop.refreshSubtitlePreview();
    return true;
  }
  if (record.kind === 'markers') {
    MaweBoot.DATA.markers = AsrEditorUtils.normalizeMarkers(record.markers || []);
    afterExternalMarkersChange();
    return true;
  }
  if (record.kind === 'preview') {
    applyPreviewState(record.preview);
    return true;
  }
  const snapshot = record.segs;
  const cueListAnchor = MaweCueListAnchor.captureCueListRenderAnchor();
  const previousWaveformStructure = MaweMultiSubtitleCore.multiSubtitleWaveformStructureKey();
  MaweState.rememberSessionHighlights();
  AsrEditorUtils.restoreSegmentsHistorySnapshot(MaweBoot.DATA, snapshot);
  if (record.fontPreview) applyPreviewState(record.fontPreview);
  MaweState.restoreSessionHighlights();
  if (record.projectChanges) Object.assign(MaweState.changes, record.projectChanges);
  MaweMultiSubtitleCore.normalizeMultiSubtitleState();
  MaweState.restoreSessionHighlights();
  MaweState.reconcileSegmentsDirty();
  // 历史恢复会改变下标身份；丢弃旧面板绑定，避免 clearSelection() 把旧面板
  // 内容提交到恢复后占据同一下标的另一条字幕，并因此生成新历史、清空 redo。
  MaweCuePanelState.currentCuePanelIdx = -1;
  MaweCuePanelState.currentCuePanelKind = 'main';
  MaweCuePanelState.currentCuePanelTrackId = null;
  MaweCuePanelState.resetCuePanelEditState({ discard: true });
  MaweSelection.clearSelection();
  MawePlaybackLoop.lastActive = -1;
  const structureChanged = previousWaveformStructure
    !== MaweMultiSubtitleCore.multiSubtitleWaveformStructureKey();
  renderAll({
    waveform: structureChanged ? 'full' : 'overlay',
    cueListAnchor,
  });
  // 暂停状态下撤销/重做不会触发播放器事件：与正向命令一致地刷新播放器
  // 字幕预览（SRT overlay），并通知 ASS 实际画面重查快照。
  MaweViewUpdates.invalidate({ preview: 'refresh' });
  MaweAssManagerWiring?.syncAssStyleManager?.();
  MaweAssFrame?.notifyProjectChanged?.();
  if (record.view) restoreEditorSelection(record.view);
  return true;
}


  // 活动预览尚未入历史栈。先取消整个手势并消费这次撤销/重做，
  // 避免恢复历史后旧拖动仍持有字幕对象，或把预览状态写入 redo。
  // 放在统一入口，同时覆盖快捷键、按钮和直接调用。
  function cancelActiveTimelineGesture() {
    if (MaweAssCuePosition?.cancelDrag()) return true;
    const waveform = MaweCoreState.waveformEditor;
    if (waveform?.wordDrag) {
      waveform.cancelWordDrag();
      return true;
    }
    return waveform?.cancelCueDrag?.() === true;
  }


  function performUndo() {
    if (cancelActiveTimelineGesture()) { updateUndoRedoButtons(); return; }
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
    // 撤销可能变脏也可能变清洁，两种方向都立即刷新指示器（事件回调整体重算）。
    MaweState.markProjectDirty();
    MaweHint.flashHint(`已撤销：${record.label}（剩 ${editorHistory.undoLength()} 步）`, 'success', { passive: true });
    updateUndoRedoButtons();
  }


  function performRedo() {
    if (cancelActiveTimelineGesture()) { updateUndoRedoButtons(); return; }
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
    // 与撤销一致：重做两个方向都立即刷新指示器。
    MaweState.markProjectDirty();
    MaweHint.flashHint(`已重做：${record.label}（剩 ${editorHistory.redoLength()} 步）`, 'success', { passive: true });
    updateUndoRedoButtons();
  }


  // modal 或文本输入聚焦时不触发全局撤销/重做（让浏览器/输入框自己处理）
  function historyGuarded() {
  const a = /** @type {HTMLElement} */ (document.activeElement);
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) {
    return true;
  }
  return MaweDom.textProcessModal.classList.contains('show')
      || document.getElementById('wrap-chars-modal')?.classList.contains('show')
      || MaweDom.timedTextEditModal.classList.contains('show')
      || MaweDom.stickerModal.classList.contains('show')
      || MaweDom.stickerPreviewModal.classList.contains('show')
      || MaweDom.projectMediaModal.classList.contains('show')
      || getMaweDomPanels().assStyleWindow?.classList.contains('show');
}


  const undoBtn = /** @type {HTMLButtonElement} */ (document.getElementById('undo-btn'));


  const redoBtn = /** @type {HTMLButtonElement} */ (document.getElementById('redo-btn'));


  function updateUndoRedoButtons() {
    if (undoBtn) undoBtn.disabled = !editorHistory.canUndo();
    if (redoBtn) redoBtn.disabled = !editorHistory.canRedo();
  }

  MaweHistory = Object.freeze({
    UNDO_LIMIT,
    editorHistory,
    get gapRemoveDirty() { return MaweState.changes.gapRemoveDirty; },
    set gapRemoveDirty(v) { MaweState.changes.gapRemoveDirty = v; },
    snapshotSegments,
    snapshotEditorSelection,
    captureSegmentsRecord,
    commitRecord,
    pushLayoutUndo,
    pushGapRemoveUndo,
    pushPreviewUndo,
    snapshotPreviewState,
    applyPreviewState,
    pushMarkersUndo,
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
}

export function captureSegmentsRecord(...args) { return MaweHistory.captureSegmentsRecord(...args); }
export function commitRecord(...args) { return MaweHistory.commitRecord(...args); }
export function applyHistoryRecord(...args) { return MaweHistory.applyHistoryRecord(...args); }
export function snapshotEditorSelection(...args) { return MaweHistory.snapshotEditorSelection(...args); }
export function snapshotPreviewState(...args) { return MaweHistory.snapshotPreviewState(...args); }
export function pushPreviewUndo(...args) { return MaweHistory.pushPreviewUndo(...args); }
export function pushGapRemoveUndo(...args) { return MaweHistory.pushGapRemoveUndo(...args); }
export function pushLayoutUndo(...args) { return MaweHistory.pushLayoutUndo(...args); }
export function pushMarkersUndo(...args) { return MaweHistory.pushMarkersUndo(...args); }
export function performUndo(...args) { return MaweHistory.performUndo(...args); }
export function performRedo(...args) { return MaweHistory.performRedo(...args); }
export function updateUndoRedoButtons(...args) { return MaweHistory.updateUndoRedoButtons(...args); }
