import { freezeFacade } from './editor-facade-utils.js';
import { EDITOR_SETTINGS_UTILS, MULTI_SUBTITLE_UTILS } from "../boot/editor.js";
import { getOverlayTrack } from "../cues/editor-wiring-overlay-transfer.js";
import { assStyleWindow } from "../ui/editor-wiring-dom-panels.js";

// 真 ESM：模块顶层定义与发布（原转换体 phase-2 语义 = import 求值）。
// window.<Name> 与导出的 <Name> 是同一对象；消费者逐簇改 import 后移除 window 发布。
'use strict';

import { AsrEditorUtils } from "../../shared/editor-utils.js";


import { MawePlaybackLoop } from "../media/editor-playback-loop.js";
import { MaweHint } from "../ui/editor-hint.js";
import { MaweCoreState } from "./editor-core-state.js";
import { MaweBoot } from "../boot/editor-boot.js";
import { MaweDom } from "../ui/editor-dom.js";
import { MaweMultiSubtitleCore } from "./editor-multi-subtitle-core.js";
import { MaweSelection } from "../cues/editor-selection.js";
import { MaweSettings } from "./editor-settings.js";
import { MaweCuePanelState } from "./editor-cue-panel-state.js";
import { MaweInlineEdit } from "../cues/editor-inline-edit.js";
import { MaweCuePanel } from "../cues/editor-cue-panel.js";
import { MaweAppearance } from "../styles/editor-appearance.js";
import { MaweSpeakerLabels } from "../styles/editor-speaker-labels.js";
import { MaweMarkerEditing } from "../markers/editor-marker-editing.js";
import { MaweCueListAnchor } from "../cues/editor-cue-list-anchor.js";
import { MaweGapRemoveUi } from "../ui/editor-gap-remove-ui.js";
import { MawePreviewGeometry } from "../media/editor-preview-geometry.js";
import { MaweWordTiming } from "../cues/editor-word-timing.js";
import { getMaweState } from './editor-state.js';
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
  overlayIds: [...getMaweState().selection.indices('overlay')]
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
  lastOverlayId: getOverlayTrack()?.segments?.[getMaweState().selection.overlayAnchor]?.id || null,
};
}

function captureSegmentsRecord(label, { captureView = false } = {}) {
  // snapshotSegments() 已是深克隆；让 buildHistoryRecord 跳过二次克隆，
  // 长工程下省掉一遍 O(工程体积) 的 JSON 序列化。
  const record = AsrEditorUtils.buildHistoryRecord(
    'segments', label, snapshotSegments(), captureView ? snapshotEditorSelection() : null,
    { clone: false },
  );
  record.projectChanges = { projectImportDirty: getMaweState().changes.projectImportDirty };
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
    gapRemoveDirty: getMaweState().changes.gapRemoveDirty,
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
  window.MaweProjectSettings?.syncControls();
  MawePreviewGeometry.refreshPreviewGeometryEditable();
  MawePlaybackLoop.update();
}

// 按记录 kind 拍下当前状态，作为对端栈的镜像（label 沿用原记录）
function snapshotCurrentForKind(kind, label, sourceRecord = null) {
  if (kind === 'layout') {
    return AsrEditorUtils.buildHistoryRecord(
      'layout', label, MaweCoreState.waveformEditor?.getLayoutHistorySnapshot?.() || null,
    );
  }
  if (kind === 'gap_remove') {
    return AsrEditorUtils.buildHistoryRecord('gap_remove', label, {
      gapRemove: MaweBoot.DATA.gap_remove,
      gapRemoveDirty: getMaweState().changes.gapRemoveDirty,
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
  return captureSegmentsRecord(label, { captureView: Boolean(sourceRecord?.view) });
}

function restoreEditorSelection(snapshot) {
if (!snapshot) return;
getMaweState().selection.clear('main');
getMaweState().selection.clear('extension');
getMaweState().selection.clear('overlay');
const mainIds = new Set(snapshot.mainIds || []);
MaweBoot.DATA.segments.forEach((segment, index) => {
  if (mainIds.has(segment?.id)) getMaweState().selection.add('main', index);
});
const extensionTrack = MaweMultiSubtitleCore.getExtensionTrack(snapshot.extensionTrackId) || MaweMultiSubtitleCore.getActiveExtensionTrack();
const extensionIds = new Set(snapshot.extensionIds || []);
if (extensionTrack) {
  extensionTrack.segments.forEach((segment, index) => {
    if (extensionIds.has(segment?.id)) getMaweState().selection.add('extension', index);
  });
}
const overlayIds = new Set(snapshot.overlayIds || []);
(getOverlayTrack()?.segments || []).forEach((segment, index) => {
  if (overlayIds.has(segment?.id)) getMaweState().selection.add('overlay', index);
});
MaweSelection.lastClickedIdx = snapshot.lastMainId
  ? MaweBoot.DATA.segments.findIndex((segment) => segment?.id === snapshot.lastMainId) : -1;
MaweSelection.lastClickedExtensionIdx = extensionTrack && snapshot.lastExtensionId
  ? extensionTrack.segments.findIndex((segment) => segment?.id === snapshot.lastExtensionId) : -1;
getMaweState().selection.overlayAnchor = snapshot.lastOverlayId != null
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
  MaweSelection.selectedIdxs.size + MaweSelection.selectedExtensionIdxs.size + getMaweState().selection.indices('overlay').size,
);
MaweSelection.selectedIdxs.forEach((index) => {
  MaweCoreState.container.querySelector(`.cue[data-idx="${index}"]`)?.classList.add('selected');
});
getMaweState().selection.indices('overlay').forEach((index) => {
  MaweCoreState.container.querySelector(`.cue[data-overlay-idx="${index}"]`)?.classList.add('selected');
});
MaweSelection.updateMultiSelectionClasses();
MaweCoreState.waveformEditor?.updateSelection();
MaweCuePanel.renderCurrentCuePanel();
}

function applyHistoryRecord(record) {
MaweWordTiming.clearSelection();
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
  getMaweState().changes.gapRemoveDirty = record.gapRemoveDirty;
  MaweGapRemoveUi.updateGapRemoveUi();
  return true;
}
if (record.kind === 'markers') {
  MaweBoot.DATA.markers = AsrEditorUtils.normalizeMarkers(record.markers || []);
  MaweMarkerEditing.afterExternalMarkersChange();
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
if (record.projectChanges) Object.assign(getMaweState().changes, record.projectChanges);
MaweMultiSubtitleCore.normalizeMultiSubtitleState();
getMaweState().reconcileSegmentsDirty();
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
MaweCuePanel.renderAll({
  waveform: structureChanged ? 'full' : 'overlay',
  cueListAnchor,
});
if (record.view) restoreEditorSelection(record.view);
return true;
}

// 活动预览尚未入历史栈。先取消整个手势并消费这次撤销/重做，
// 避免恢复历史后旧拖动仍持有字幕对象，或把预览状态写入 redo。
// 放在统一入口，同时覆盖快捷键、按钮和直接调用。
function cancelActiveTimelineGesture() {
  if (window.MaweAssCuePosition?.cancelDrag()) return true;
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
  MaweHint.flashHint(`已撤销：${record.label}（剩 ${editorHistory.undoLength()} 步）`, 'success');
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
    || document.getElementById('wrap-chars-modal')?.classList.contains('show')
    || MaweDom.timedTextEditModal.classList.contains('show')
    || MaweDom.stickerModal.classList.contains('show')
    || MaweDom.stickerPreviewModal.classList.contains('show')
    || MaweDom.projectMediaModal.classList.contains('show')
    || assStyleWindow?.classList.contains('show');
}

const undoBtn = document.getElementById('undo-btn');

const redoBtn = document.getElementById('redo-btn');

function updateUndoRedoButtons() {
  if (undoBtn) undoBtn.disabled = !editorHistory.canUndo();
  if (redoBtn) redoBtn.disabled = !editorHistory.canRedo();
}

window.MaweHistory = Object.freeze({
  UNDO_LIMIT,
  editorHistory,
  get gapRemoveDirty() { return getMaweState().changes.gapRemoveDirty; },
  set gapRemoveDirty(v) { getMaweState().changes.gapRemoveDirty = v; },
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

export const MaweHistory = freezeFacade({
    UNDO_LIMIT,
    editorHistory,
    get gapRemoveDirty() { return getMaweState().changes.gapRemoveDirty; },
    set gapRemoveDirty(v) { getMaweState().changes.gapRemoveDirty = v; },
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
  }, ["gapRemoveDirty"]);
window.MaweHistory = MaweHistory;
