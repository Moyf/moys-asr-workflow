const DATA = __DATA_JSON__;
let FILENAME_BASE = __FILENAME_BASE_JSON__;
const STICKERS = __STICKERS_JSON__;
let STICKER_ROOT = __STICKER_ROOT_JSON__;  // 表情包根目录的绝对路径（无尾斜杠）
const STICKER_URL_PREFIX = __STICKER_URL_PREFIX_JSON__;
const SERVER_CONFIG = __SERVER_CONFIG_JSON__;
const EDITOR_SETTINGS_KEY = 'moy.asr.editor.settings.v1';
const DEFAULT_EDITOR_SETTINGS = {
  splitKey: 'ctrl-enter',
  overlayEnabled: true,
  exportStartAtZero: true,
  cueListShowIndex: true,
  cueListShowTime: true,
  cueListShowSticker: false,
  cueListShowCharcount: true,
  cueEditorShowNavigation: true,
  cueEditorShowSticker: false,
  selectGroupMembers: false,
  // 字幕列表单击行为：select-only 仅选中（默认），select-and-seek 选中并跳转播放头。
  clickBehavior: 'select-only',
};

function readEditorSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(EDITOR_SETTINGS_KEY) || '{}');
    return {
      splitKey: saved.splitKey === 'enter' ? 'enter' : DEFAULT_EDITOR_SETTINGS.splitKey,
      overlayEnabled: saved.overlayEnabled !== false,
      exportStartAtZero: saved.exportStartAtZero !== false,
      cueListShowIndex: saved.cueListShowIndex !== false,
      cueListShowTime: saved.cueListShowTime !== false,
      cueListShowSticker: saved.cueListShowSticker === true,
      cueListShowCharcount: saved.cueListShowCharcount !== false,
      cueEditorShowNavigation: saved.cueEditorShowNavigation !== false,
      cueEditorShowSticker: saved.cueEditorShowSticker === true,
      selectGroupMembers: saved.selectGroupMembers === true,
      clickBehavior: saved.clickBehavior === 'select-and-seek' ? 'select-and-seek' : 'select-only',
    };
  } catch (_) {
    return { ...DEFAULT_EDITOR_SETTINGS };
  }
}

function saveEditorSettings(settings) {
  try {
    localStorage.setItem(EDITOR_SETTINGS_KEY, JSON.stringify(settings));
  } catch (_) {
    // file:// 隐私模式可能拒绝 localStorage；本次页面仍保持可用。
  }
}

const EDITOR_SETTINGS = readEditorSettings();

// 标记颜色：5 种基础色，用于给字幕分组着色。
// 数据模型与表情包同构：head 持完整 color {name, value, start, end}，后续 ref 持 color_ref {name, headIdx}
const COLOR_PALETTE = [
  { name: 'red',    label: '红', value: '#e74c3c' },
  { name: 'yellow', label: '黄', value: '#f1c40f' },
  { name: 'blue',   label: '蓝', value: '#168cff' },
  { name: 'green',  label: '绿', value: '#2ecc71' },
  { name: 'purple', label: '紫', value: '#9b59b6' },
];
const COLOR_BY_NAME = Object.fromEntries(COLOR_PALETTE.map(c => [c.name, c]));
function colorValue(name) { return COLOR_BY_NAME[name]?.value || '#777'; }

const GAP_REMOVE_SCHEMA = 'moy.asr.gap_remove.v1';
const GAP_REMOVE_OPERATION_MODES = new Set(['none', 'boundary_drag', 'middle_drag']);
const DEFAULT_GAP_REMOVE_MIN_MS = 500;
const DEFAULT_GAP_REMOVE_THRESHOLD_DB = -24;
const DEFAULT_GAP_REMOVE_HYSTERESIS_DB = 2;
const DEFAULT_GAP_REMOVE_LEAD_IN_MS = 40;
const DEFAULT_GAP_REMOVE_LEAD_OUT_MS = 80;
const DEFAULT_GAP_REMOVE_OPERATION_MODE = 'middle_drag';
const GAP_REMOVE_ADVANCED_OPEN_KEY = 'moy.asr.gap_remove.advanced_open.v1';

function clampGapRemoveMinimum(value) {
  const rounded = Math.round(Number(value));
  return Math.min(60000, Math.max(100, Number.isFinite(rounded) ? rounded : DEFAULT_GAP_REMOVE_MIN_MS));
}

function clampGapRemoveThreshold(value) {
  const numeric = Number(value);
  return Math.min(0, Math.max(-96, Number.isFinite(numeric) ? numeric : DEFAULT_GAP_REMOVE_THRESHOLD_DB));
}

function clampGapRemoveHysteresis(value) {
  const numeric = Number(value);
  return Math.min(30, Math.max(0, Number.isFinite(numeric) ? numeric : DEFAULT_GAP_REMOVE_HYSTERESIS_DB));
}

function clampGapRemoveLeadMs(value, fallback) {
  const rounded = Math.round(Number(value));
  return Math.min(2000, Math.max(0, Number.isFinite(rounded) ? rounded : fallback));
}

function normalizedGapRemoveData(value) {
  const source = value && typeof value === 'object' ? value : {};
  const gaps = window.AsrEditorUtils.normalizeGapRemoveGaps(source.gaps);
  return {
    schema: GAP_REMOVE_SCHEMA,
    detector: source.detector === 'audio_gate' || !gaps.length ? 'audio_gate' : 'legacy_subtitle_gap',
    minimum_ms: clampGapRemoveMinimum(source.minimum_ms),
    threshold_db: clampGapRemoveThreshold(source.threshold_db),
    hysteresis_db: clampGapRemoveHysteresis(source.hysteresis_db),
    lead_in_ms: clampGapRemoveLeadMs(source.lead_in_ms, DEFAULT_GAP_REMOVE_LEAD_IN_MS),
    lead_out_ms: clampGapRemoveLeadMs(source.lead_out_ms, DEFAULT_GAP_REMOVE_LEAD_OUT_MS),
    skip_playback: source.skip_playback !== false,
    manual_corrections: source.manual_corrections === true,
    operation_mode: GAP_REMOVE_OPERATION_MODES.has(source.operation_mode)
      ? source.operation_mode : DEFAULT_GAP_REMOVE_OPERATION_MODE,
    gaps,
  };
}

function getGapRemoveData(create = false) {
  if (!DATA.gap_remove && !create) return null;
  return normalizedGapRemoveData(DATA.gap_remove);
}

function getGapRemoveGaps() {
  const state = getGapRemoveData(false);
  return state?.detector === 'audio_gate' ? state.gaps : [];
}

function getRemovedGapRanges() {
  return window.AsrEditorUtils.getRemovedGapRanges(getGapRemoveGaps());
}

const container = document.getElementById('cues-container');
let player = document.getElementById('player');  // 可被「加载媒体」替换为新 <video>/<audio>
let waveformEditor = null;
const MEDIA_FILE_RE = /\.(mp4|mkv|avi|mov|wmv|flv|webm|ts|m4v|wav|mp3|m4a|aac|ogg|flac|opus)$/i;
function isMediaFile(file) {
  return Boolean(file) && (file.type.startsWith('video/') || file.type.startsWith('audio/') || MEDIA_FILE_RE.test(file.name));
}

// === 统一撤销/重做 ===
// 四种记录 kind 共享一个历史栈：
//   segments   —— 字幕增删改、拆分合并、表情包/颜色、批量替换等
//   layout     —— 布局导入/重置/拖动停靠
//   gap_remove —— 静音空隙扫描与人工修正
//   preview    —— 字幕预览（overlay）开关
// 栈深上限 100；新动作清空 redo；Ctrl/Cmd+Z 撤销、Ctrl/Cmd+Shift+Z 重做。
// 编辑文本输入框或 modal 打开时让原生行为优先（见 keydown 守卫）。
const UNDO_LIMIT = 100;
const editorHistory = window.AsrEditorUtils.createHistoryStack(UNDO_LIMIT);
let gapRemoveDirty = false;
function snapshotSegments() {
  // _dirty 也保留，恢复后能再次导出"工程文件"时正确标记
  return JSON.parse(JSON.stringify(DATA.segments));
}
function pushUndo(label) {
  editorHistory.push({ kind: 'segments', label: label || '编辑', segs: snapshotSegments() });
  updateUndoRedoButtons();
}
function pushLayoutUndo(label, snapshot) {
  if (!snapshot) return;
  editorHistory.push({ kind: 'layout', label: label || '调整布局', layout: snapshot });
  updateUndoRedoButtons();
}
function pushGapRemoveUndo(label) {
  editorHistory.push({
    kind: 'gap_remove',
    label: label || '空隙移除',
    gapRemove: DATA.gap_remove ? JSON.parse(JSON.stringify(DATA.gap_remove)) : null,
    gapRemoveDirty,
  });
  updateUndoRedoButtons();
}
function pushPreviewUndo(label, preview) {
  editorHistory.push({ kind: 'preview', label: label || '预览', preview });
  updateUndoRedoButtons();
}
function snapshotPreviewState() {
  return { overlay: !!overlayToggle.checked };
}
function applyPreviewState(state) {
  if (!state || typeof state.overlay !== 'boolean') return;
  overlayToggle.checked = state.overlay;
  updateEditorSettings({ overlayEnabled: state.overlay });
  if (!state.overlay) overlayEl.classList.add('hidden');
  else update();
}
// 按记录 kind 拍下当前状态，作为对端栈的镜像（label 沿用原记录）
function snapshotCurrentForKind(kind, label) {
  if (kind === 'layout') {
    return { kind: 'layout', label: label || '调整布局', layout: waveformEditor?.getLayoutHistorySnapshot?.() || null };
  }
  if (kind === 'gap_remove') {
    return {
      kind: 'gap_remove', label: label || '空隙移除',
      gapRemove: DATA.gap_remove ? JSON.parse(JSON.stringify(DATA.gap_remove)) : null,
      gapRemoveDirty,
    };
  }
  if (kind === 'preview') {
    return { kind: 'preview', label: label || '预览', preview: snapshotPreviewState() };
  }
  return { kind: 'segments', label: label || '编辑', segs: snapshotSegments() };
}
function applyHistoryRecord(record) {
  if (record.kind === 'layout') {
    if (!waveformEditor?.restoreLayoutHistorySnapshot?.(record.layout)) {
      flashHint('布局恢复失败：布局模块尚未加载');
      return false;
    }
    DATA.layout = waveformEditor.getLayoutData();
    return true;
  }
  if (record.kind === 'gap_remove') {
    DATA.gap_remove = record.gapRemove;
    gapRemoveDirty = record.gapRemoveDirty;
    updateGapRemoveUi();
    return true;
  }
  if (record.kind === 'preview') {
    applyPreviewState(record.preview);
    return true;
  }
  DATA.segments.length = 0;
  record.segs.forEach(s => DATA.segments.push(s));
  clearSelection();
  lastActive = -1;
  renderAll();
  return true;
}
function performUndo() {
  const top = editorHistory.peekUndo();
  if (!top) { flashHint('没有可撤销的操作'); return; }
  if (top.kind === 'layout' && typeof waveformEditor?.restoreLayoutHistorySnapshot !== 'function') {
    flashHint('布局撤销失败：布局模块尚未加载');
    return;
  }
  if (editingState) finishEdit(false);  // 撤销前丢弃当前编辑（保持快照前后一致）
  const current = snapshotCurrentForKind(top.kind, top.label);
  const record = editorHistory.popUndo(current);
  if (!record) return;
  applyHistoryRecord(record);
  flashHint(`已撤销：${record.label}（剩 ${editorHistory.undoLength()} 步）`);
  updateUndoRedoButtons();
}
function performRedo() {
  const top = editorHistory.peekRedo();
  if (!top) { flashHint('没有可重做的操作'); return; }
  if (top.kind === 'layout' && typeof waveformEditor?.restoreLayoutHistorySnapshot !== 'function') {
    flashHint('布局重做失败：布局模块尚未加载');
    return;
  }
  if (editingState) finishEdit(false);
  const current = snapshotCurrentForKind(top.kind, top.label);
  const record = editorHistory.popRedo(current);
  if (!record) return;
  applyHistoryRecord(record);
  flashHint(`已重做：${record.label}（剩 ${editorHistory.redoLength()} 步）`);
  updateUndoRedoButtons();
}
// modal 或文本输入聚焦时不触发全局撤销/重做（让浏览器/输入框自己处理）
function historyGuarded() {
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) {
    return true;
  }
  return replaceModal.classList.contains('show')
      || stickerModal.classList.contains('show')
      || stickerPreviewModal.classList.contains('show')
      || projectMediaModal.classList.contains('show')
      || document.getElementById('sticker-root-modal').classList.contains('show');
}
const undoBtn = document.getElementById('undo-btn');
const redoBtn = document.getElementById('redo-btn');
function updateUndoRedoButtons() {
  if (undoBtn) undoBtn.disabled = !editorHistory.canUndo();
  if (redoBtn) redoBtn.disabled = !editorHistory.canRedo();
}
if (undoBtn) undoBtn.addEventListener('click', () => performUndo());
if (redoBtn) redoBtn.addEventListener('click', () => performRedo());
updateUndoRedoButtons();
const nowEl = document.getElementById('now');
const searchEl = document.getElementById('search');
const visibleCountEl = document.getElementById('visible-count');
const totalCountEl = document.getElementById('total-count');
const selCountEl = document.getElementById('sel-count');
const overlayEl = document.getElementById('overlay');
const overlayTextEl = overlayEl.querySelector('span');
const overlayToggle = document.getElementById('overlay-toggle');
const playerEmpty = document.getElementById('player-empty');
const playerWrap = document.querySelector('.player-wrap');
const splitKeySel = document.getElementById('split-key');
const cueListShowIndexToggle = document.getElementById('cue-list-show-index');
const cueListShowTimeToggle = document.getElementById('cue-list-show-time');
const cueListShowStickerToggle = document.getElementById('cue-list-show-sticker');
const cueListShowCharcountToggle = document.getElementById('cue-list-show-charcount');
const cueEditorShowNavigationToggle = document.getElementById('cue-editor-show-navigation');
const cueEditorShowStickerToggle = document.getElementById('cue-editor-show-sticker');
const selectGroupMembersToggle = document.getElementById('select-group-members');
const helpToggle = document.getElementById('help-toggle');
const helpPanel = document.getElementById('help-panel');
const clickBehaviorSelect = document.getElementById('click-behavior');
const replaceModal = document.getElementById('replace-modal');
const stickerModal = document.getElementById('sticker-modal');
const stickerPreviewModal = document.getElementById('sticker-preview-modal');
const projectMediaModal = document.getElementById('project-media-modal');
const projectMediaSelectButton = document.getElementById('project-media-select');
const projectMediaLaterButton = document.getElementById('project-media-later');
const ctxmenu = document.getElementById('ctxmenu');
const cuePanel = document.getElementById('current-cue-panel');
const cuePanelPrev = document.getElementById('cue-panel-prev');
const cuePanelNext = document.getElementById('cue-panel-next');
const cuePanelStart = document.getElementById('cue-panel-start');
const cuePanelDuration = document.getElementById('cue-panel-duration');
const cuePanelText = document.getElementById('cue-panel-text');
const cuePanelTotalLength = document.getElementById('cue-panel-total-length');
const cuePanelCharsPerSecond = document.getElementById('cue-panel-chars-per-second');
const cuePanelSticker = document.getElementById('cue-panel-sticker');
const cuePanelAddSticker = document.getElementById('cue-panel-add-sticker');
const cuePanelSplit = document.getElementById('cue-panel-split');
const cuesEmpty = document.getElementById('cues-empty');
const saveProjectButton = document.getElementById('save-project');
const saveProjectAsButton = document.getElementById('save-project-as');
const gapRemovedExportDropdown = document.getElementById('gap-removed-export-dropdown');
const editorSettingsToggle = document.getElementById('editor-settings-toggle');
const editorSettingsPanel = document.getElementById('editor-settings-panel');
const exportStartAtZeroToggle = document.getElementById('export-start-at-zero');
const recentProjectsEl = document.getElementById('recent-projects');
const recentProjectsToggle = document.getElementById('recent-projects-toggle');
const recentProjectsMenu = document.getElementById('recent-projects-menu');
const serverProjectSettingsEl = document.getElementById('server-project-settings');
const autoOpenLastProjectToggle = document.getElementById('auto-open-last-project');
const GAP_REMOVE_PANEL_POSITION_KEY = 'moy.asr.gap_remove.panel.v1';
const gapRemovePanel = document.getElementById('gap-remove-panel');
const gapRemoveDragHandle = document.getElementById('gap-remove-drag-handle');
const gapRemoveCloseButton = document.getElementById('gap-remove-close');
const gapRemoveManageButton = document.getElementById('gap-remove-manage');
const gapRemoveSummary = document.getElementById('gap-remove-summary');
const gapRemoveThreshold = document.getElementById('gap-remove-threshold');
const gapRemoveVolumeThreshold = document.getElementById('gap-remove-volume-threshold');
const gapRemoveHysteresis = document.getElementById('gap-remove-hysteresis');
const gapRemoveHysteresisHint = document.getElementById('gap-remove-hysteresis-hint');
const gapRemoveLeadIn = document.getElementById('gap-remove-lead-in');
const gapRemoveLeadOut = document.getElementById('gap-remove-lead-out');
const gapRemoveAdvancedToggle = document.getElementById('gap-remove-advanced-toggle');
const gapRemoveAdvancedBody = document.getElementById('gap-remove-advanced-body');
const gapRemoveOperationMode = document.getElementById('gap-remove-operation-mode');
const gapRemoveScanButton = document.getElementById('gap-remove-scan');
const gapRemoveSkipPlayback = document.getElementById('gap-skip-playback');
const gapRemoveList = document.getElementById('gap-remove-list');
const gapRemoveRestoreAllButton = document.getElementById('gap-remove-restore-all');
let gapPreviewRange = null;
let gapRemovePanelDrag = null;
let currentCuePanelIdx = -1;
let cuePanelUndoPushed = false;

function updateEditorSettings(patch) {
  Object.assign(EDITOR_SETTINGS, patch);
  saveEditorSettings(EDITOR_SETTINGS);
}

function setEditorSettingsPanelOpen(open) {
  if (!editorSettingsPanel || !editorSettingsToggle) return;
  editorSettingsPanel.hidden = !open;
  editorSettingsToggle.classList.toggle('active', open);
  editorSettingsToggle.setAttribute('aria-expanded', String(open));
}

function applyCueListDisplaySettings() {
  cueListShowIndexToggle.checked = EDITOR_SETTINGS.cueListShowIndex;
  cueListShowTimeToggle.checked = EDITOR_SETTINGS.cueListShowTime;
  cueListShowStickerToggle.checked = EDITOR_SETTINGS.cueListShowSticker;
  cueListShowCharcountToggle.checked = EDITOR_SETTINGS.cueListShowCharcount;
  container.classList.toggle('hide-cue-index', !EDITOR_SETTINGS.cueListShowIndex);
  container.classList.toggle('hide-cue-time', !EDITOR_SETTINGS.cueListShowTime);
  container.classList.toggle('hide-cue-sticker', !EDITOR_SETTINGS.cueListShowSticker);
  container.classList.toggle('hide-cue-charcount', !EDITOR_SETTINGS.cueListShowCharcount);
}

function bindCueListDisplayToggle(toggle, key) {
  toggle.addEventListener('change', () => {
    updateEditorSettings({ [key]: toggle.checked });
    applyCueListDisplaySettings();
  });
}

function applyCueEditorDisplaySettings() {
  cueEditorShowNavigationToggle.checked = EDITOR_SETTINGS.cueEditorShowNavigation;
  cueEditorShowStickerToggle.checked = EDITOR_SETTINGS.cueEditorShowSticker;
  cuePanel.classList.toggle('hide-cue-editor-navigation', !EDITOR_SETTINGS.cueEditorShowNavigation);
  cuePanel.classList.toggle('hide-cue-editor-sticker', !EDITOR_SETTINGS.cueEditorShowSticker);
}

function bindCueEditorDisplayToggle(toggle, key) {
  toggle.addEventListener('change', () => {
    updateEditorSettings({ [key]: toggle.checked });
    applyCueEditorDisplaySettings();
  });
}

splitKeySel.value = EDITOR_SETTINGS.splitKey;
overlayToggle.checked = EDITOR_SETTINGS.overlayEnabled;
exportStartAtZeroToggle.checked = EDITOR_SETTINGS.exportStartAtZero;
if (selectGroupMembersToggle) selectGroupMembersToggle.checked = EDITOR_SETTINGS.selectGroupMembers;
if (clickBehaviorSelect) clickBehaviorSelect.value = EDITOR_SETTINGS.clickBehavior;
applyCueListDisplaySettings();
applyCueEditorDisplaySettings();
editorSettingsToggle?.addEventListener('click', () => setEditorSettingsPanelOpen(editorSettingsPanel?.hidden));
helpToggle?.addEventListener('click', () => {
  const open = helpPanel?.hidden === true;
  if (helpPanel) helpPanel.hidden = !open;
  helpToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  helpToggle.classList.toggle('active', open);
});
splitKeySel.addEventListener('change', () => updateEditorSettings({ splitKey: splitKeySel.value }));
bindCueListDisplayToggle(cueListShowIndexToggle, 'cueListShowIndex');
bindCueListDisplayToggle(cueListShowTimeToggle, 'cueListShowTime');
bindCueListDisplayToggle(cueListShowStickerToggle, 'cueListShowSticker');
bindCueListDisplayToggle(cueListShowCharcountToggle, 'cueListShowCharcount');
bindCueEditorDisplayToggle(cueEditorShowNavigationToggle, 'cueEditorShowNavigation');
bindCueEditorDisplayToggle(cueEditorShowStickerToggle, 'cueEditorShowSticker');
exportStartAtZeroToggle.addEventListener('change', () => {
  updateEditorSettings({ exportStartAtZero: exportStartAtZeroToggle.checked });
});
selectGroupMembersToggle?.addEventListener('change', () => {
  updateEditorSettings({ selectGroupMembers: selectGroupMembersToggle.checked });
});
clickBehaviorSelect?.addEventListener('change', () => {
  updateEditorSettings({ clickBehavior: clickBehaviorSelect.value === 'select-and-seek' ? 'select-and-seek' : 'select-only' });
});

function setGapRemoveData(next, { dirty = true } = {}) {
  DATA.gap_remove = normalizedGapRemoveData(next);
  gapPreviewRange = null;
  if (dirty) gapRemoveDirty = true;
  updateGapRemoveUi();
}

function gapRemoveTotalMs(gaps) {
  return getRemovedGapRangesFrom(gaps).reduce((total, gap) => total + gap.end - gap.start, 0);
}

function gapRemoveMediaDurationMs() {
  const candidates = [
    waveformEditor?.durationMs,
    DATA.waveform?.duration_ms,
    Number(player?.duration) * 1000,
  ];
  const duration = candidates.find((value) => Number.isFinite(Number(value)) && Number(value) > 0);
  return duration ? Math.round(Number(duration)) : 0;
}

function formatGapRemoveTotal(totalMs) {
  return window.AsrEditorUtils.formatGapRemoveDuration(totalMs, gapRemoveMediaDurationMs());
}

function getRemovedGapRangesFrom(gaps) {
  return window.AsrEditorUtils.getRemovedGapRanges(gaps);
}

function getGapRemoveOperationMode() {
  return getGapRemoveData(false)?.operation_mode || DEFAULT_GAP_REMOVE_OPERATION_MODE;
}

function renderGapRemoveList() {
  if (!gapRemoveList) return;
  const state = getGapRemoveData(false);
  const gaps = state?.gaps || [];
  gapRemoveList.replaceChildren();
  if (state?.detector === 'legacy_subtitle_gap') {
    gapRemoveList.textContent = '此工程含有旧版按字幕间隔识别的结果。为避免误删，旧结果已停用；请按当前波形重新扫描。';
    return;
  }
  if (!gaps.length) {
    gapRemoveList.textContent = '尚未找到符合门限的音量空隙。';
    return;
  }
  const removedCount = gaps.filter((gap) => gap.removed).length;
  const total = gapRemoveTotalMs(gaps);
  const summary = document.createElement('div');
  summary.className = 'gap-remove-total';
  summary.textContent = `已移除 ${removedCount}/${gaps.length} 段，共 ${formatGapRemoveTotal(total)}；左键空隙跳转播放头，Alt+左键切换移除。`;
  gapRemoveList.appendChild(summary);
}

function updateGapRemoveUi() {
  const state = getGapRemoveData(false);
  const gaps = getGapRemoveGaps();
  const removedCount = gaps.filter((gap) => gap.removed).length;
  const total = gapRemoveTotalMs(gaps);
  if (gapRemoveSummary) {
    const manualLabel = state?.manual_corrections ? ' · 人工修正' : '';
    gapRemoveSummary.textContent = state?.detector === 'legacy_subtitle_gap'
      ? '需重新扫描'
      : gaps.length
      ? `已移除 ${removedCount}/${gaps.length} 段 · ${formatGapRemoveTotal(total)}${manualLabel}`
      : `未扫描空隙${manualLabel}`;
  }
  if (gapRemoveThreshold && state) gapRemoveThreshold.value = String(state.minimum_ms);
  if (gapRemoveVolumeThreshold && state) gapRemoveVolumeThreshold.value = String(state.threshold_db);
  if (gapRemoveHysteresis && state) gapRemoveHysteresis.value = String(state.hysteresis_db);
  updateGapRemoveHysteresisHint();
  if (gapRemoveLeadIn && state) gapRemoveLeadIn.value = String(state.lead_in_ms);
  if (gapRemoveLeadOut && state) gapRemoveLeadOut.value = String(state.lead_out_ms);
  if (gapRemoveOperationMode) {
    gapRemoveOperationMode.value = state?.operation_mode || DEFAULT_GAP_REMOVE_OPERATION_MODE;
  }
  if (gapRemoveSkipPlayback) gapRemoveSkipPlayback.checked = state?.skip_playback !== false;
  if (gapRemoveRestoreAllButton) gapRemoveRestoreAllButton.disabled = !gaps.some((gap) => gap.removed);
  if (gapRemovedExportDropdown) {
    gapRemovedExportDropdown.hidden = !gaps.some((gap) => gap.removed);
    if (gapRemovedExportDropdown.hidden) gapRemovedExportDropdown.classList.remove('open');
  }
  renderGapRemoveList();
  waveformEditor?.renderSegments();
}

function scanAndRemoveGaps() {
  const minimumMs = clampGapRemoveMinimum(gapRemoveThreshold?.value);
  const thresholdDb = clampGapRemoveThreshold(gapRemoveVolumeThreshold?.value);
  const hysteresisDb = clampGapRemoveHysteresis(gapRemoveHysteresis?.value);
  const leadInMs = clampGapRemoveLeadMs(gapRemoveLeadIn?.value, DEFAULT_GAP_REMOVE_LEAD_IN_MS);
  const leadOutMs = clampGapRemoveLeadMs(gapRemoveLeadOut?.value, DEFAULT_GAP_REMOVE_LEAD_OUT_MS);
  const waveform = waveformEditor?.getGapRemoveDetectionData?.();
  if (!waveform) {
    flashHint('波形数据尚不可用，无法按音量判断空隙；请先加载媒体。');
    return;
  }
  const previousState = getGapRemoveData(false);
  if (previousState?.manual_corrections && !confirm(
    '当前空隙中包含人工修正。\n\n重新“扫描并移除”会丢失 Alt+点击、边界拖动或中键拖动产生的全部人工修正。仍要继续吗？'
  )) return;
  const gaps = window.AsrEditorUtils.detectAudioGapRemoveGaps(waveform, {
    minimumMs,
    thresholdDb,
    hysteresisDb,
    leadInMs,
    leadOutMs,
  });
  pushGapRemoveUndo('扫描并移除静音空隙');
  setGapRemoveData({
    detector: 'audio_gate',
    minimum_ms: minimumMs,
    threshold_db: thresholdDb,
    hysteresis_db: hysteresisDb,
    lead_in_ms: leadInMs,
    lead_out_ms: leadOutMs,
    skip_playback: previousState?.skip_playback,
    manual_corrections: false,
    operation_mode: previousState?.operation_mode,
    gaps,
  });
  flashHint(gaps.length ? `已移除 ${gaps.length} 段音量空隙，共 ${formatGapRemoveTotal(gapRemoveTotalMs(gaps))}` : '没有达到门限的音量空隙');
}

function toggleGapRemoved(index) {
  const state = getGapRemoveData(false);
  const gap = state?.gaps?.[index];
  if (!gap) return;
  pushGapRemoveUndo(gap.removed === false ? '再次移除静音空隙' : '恢复静音空隙');
  const removed = gap.removed === false;
  state.gaps = window.AsrEditorUtils.applyGapRemoveRange(state.gaps, gap.start, gap.end, removed);
  state.manual_corrections = true;
  setGapRemoveData(state);
  flashHint(removed ? '已人工移除静音空隙' : '已人工恢复静音空隙');
}

function applyManualGapRange(startMs, endMs, removed) {
  const state = getGapRemoveData(true);
  const sourceGaps = state.detector === 'audio_gate' ? state.gaps : [];
  const nextGaps = window.AsrEditorUtils.applyGapRemoveRange(sourceGaps, startMs, endMs, removed);
  if (JSON.stringify(nextGaps) === JSON.stringify(sourceGaps)) {
    flashHint(removed ? '所选范围已经处于移除状态' : '所选范围内没有已移除的静音空隙');
    return;
  }
  pushGapRemoveUndo(removed ? '人工移除范围' : '人工恢复范围');
  state.detector = 'audio_gate';
  state.gaps = nextGaps;
  state.manual_corrections = true;
  setGapRemoveData(state);
  flashHint(removed ? '已人工移除所选范围' : '已人工恢复所选范围');
}

function resizeManualGapBoundary(index, edge, valueMs) {
  const state = getGapRemoveData(false);
  if (!state || state.detector !== 'audio_gate') return;
  const nextGaps = window.AsrEditorUtils.resizeGapRemoveBoundary(state.gaps, index, edge, valueMs);
  if (JSON.stringify(nextGaps) === JSON.stringify(state.gaps)) return;
  pushGapRemoveUndo('人工调整空隙边界');
  state.gaps = nextGaps;
  state.manual_corrections = true;
  setGapRemoveData(state);
  flashHint('已人工调整空隙边界');
}

function restoreAllGaps() {
  const state = getGapRemoveData(false);
  if (!state?.gaps?.some((gap) => gap.removed)) return;
  pushGapRemoveUndo('恢复全部空隙');
  state.gaps = state.gaps.map((gap) => ({ ...gap, removed: false }));
  state.manual_corrections = true;
  setGapRemoveData(state);
  flashHint('已恢复全部空隙');
}

function gapRemovePanelIsOpen() {
  return gapRemovePanel?.classList.contains('show') === true;
}

function gapRemoveAdvancedIsOpen() {
  return gapRemoveAdvancedBody ? !gapRemoveAdvancedBody.hidden : false;
}

function setGapRemoveAdvancedOpen(open, { persist = true } = {}) {
  if (!gapRemoveAdvancedBody || !gapRemoveAdvancedToggle) return;
  gapRemoveAdvancedBody.hidden = !open;
  gapRemoveAdvancedToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (persist) {
    try {
      localStorage.setItem(GAP_REMOVE_ADVANCED_OPEN_KEY, open ? '1' : '0');
    } catch (_) {
      // file:// 隐私模式下 localStorage 可能被拒；折叠状态仅本次会话生效。
    }
  }
}

function restoreGapRemoveAdvancedOpen() {
  let saved = null;
  try {
    saved = localStorage.getItem(GAP_REMOVE_ADVANCED_OPEN_KEY);
  } catch (_) {
    saved = null;
  }
  setGapRemoveAdvancedOpen(saved === '1', { persist: false });
}

function updateGapRemoveHysteresisHint() {
  if (!gapRemoveHysteresisHint || !gapRemoveHysteresis) return;
  const value = gapRemoveHysteresis.value;
  gapRemoveHysteresisHint.textContent = `当音频判定为有声时，需要降低到比阈值更低 ${value} dB 的时候才视作恢复静音。建议 1–3 dB，过高会延迟回到静音`;
}

function setGapRemovePanelPosition(left, top, { persist = false } = {}) {
  if (!gapRemovePanel) return;
  const rect = gapRemovePanel.getBoundingClientRect();
  const margin = 6;
  const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
  const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
  const nextLeft = Math.min(maxLeft, Math.max(margin, Math.round(left)));
  const nextTop = Math.min(maxTop, Math.max(margin, Math.round(top)));
  gapRemovePanel.style.left = `${nextLeft}px`;
  gapRemovePanel.style.top = `${nextTop}px`;
  gapRemovePanel.style.right = 'auto';
  if (persist) {
    try {
      localStorage.setItem(GAP_REMOVE_PANEL_POSITION_KEY, JSON.stringify({ left: nextLeft, top: nextTop }));
    } catch (_) {
      // file:// 隐私模式可能拒绝 localStorage；拖动本身仍保持可用。
    }
  }
}

function restoreGapRemovePanelPosition() {
  if (!gapRemovePanel) return;
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(GAP_REMOVE_PANEL_POSITION_KEY) || 'null');
  } catch (_) {
    saved = null;
  }
  if (Number.isFinite(saved?.left) && Number.isFinite(saved?.top)) {
    setGapRemovePanelPosition(saved.left, saved.top);
    return;
  }
  const rect = gapRemovePanel.getBoundingClientRect();
  setGapRemovePanelPosition(rect.left, rect.top);
}

function closeGapRemovePanel() {
  if (!gapRemovePanel) return;
  gapRemovePanel.classList.remove('show', 'dragging');
  gapRemovePanel.setAttribute('aria-hidden', 'true');
  gapRemovePanelDrag = null;
  gapRemoveManageButton?.classList.remove('active');
  gapRemoveManageButton?.setAttribute('aria-expanded', 'false');
}

function openGapRemovePanel() {
  if (!gapRemovePanel) return;
  const state = getGapRemoveData(false);
  gapRemoveThreshold.value = String(state?.minimum_ms || DEFAULT_GAP_REMOVE_MIN_MS);
  gapRemoveVolumeThreshold.value = String(state?.threshold_db ?? DEFAULT_GAP_REMOVE_THRESHOLD_DB);
  gapRemoveHysteresis.value = String(state?.hysteresis_db ?? DEFAULT_GAP_REMOVE_HYSTERESIS_DB);
  updateGapRemoveHysteresisHint();
  gapRemoveLeadIn.value = String(state?.lead_in_ms ?? DEFAULT_GAP_REMOVE_LEAD_IN_MS);
  gapRemoveLeadOut.value = String(state?.lead_out_ms ?? DEFAULT_GAP_REMOVE_LEAD_OUT_MS);
  gapRemoveOperationMode.value = state?.operation_mode || DEFAULT_GAP_REMOVE_OPERATION_MODE;
  restoreGapRemoveAdvancedOpen();
  renderGapRemoveList();
  gapRemovePanel.classList.add('show');
  gapRemovePanel.setAttribute('aria-hidden', 'false');
  gapRemoveManageButton?.classList.add('active');
  gapRemoveManageButton?.setAttribute('aria-expanded', 'true');
  requestAnimationFrame(restoreGapRemovePanelPosition);
}

function toggleGapRemovePanel() {
  if (gapRemovePanelIsOpen()) closeGapRemovePanel();
  else openGapRemovePanel();
}

function finishGapRemovePanelDrag(event) {
  if (!gapRemovePanelDrag || event.pointerId !== gapRemovePanelDrag.pointerId) return;
  try {
    gapRemoveDragHandle?.releasePointerCapture?.(event.pointerId);
  } catch (_) {
    // 指针在浏览器窗口外释放时，capture 可能已由浏览器自动清理。
  }
  gapRemovePanelDrag = null;
  gapRemovePanel?.classList.remove('dragging');
  const rect = gapRemovePanel?.getBoundingClientRect();
  if (rect) setGapRemovePanelPosition(rect.left, rect.top, { persist: true });
}

gapRemoveDragHandle?.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || event.target.closest('button')) return;
  const rect = gapRemovePanel.getBoundingClientRect();
  gapRemovePanelDrag = {
    pointerId: event.pointerId,
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top,
  };
  gapRemovePanel.classList.add('dragging');
  gapRemoveDragHandle.setPointerCapture?.(event.pointerId);
  event.preventDefault();
});
gapRemoveDragHandle?.addEventListener('pointermove', (event) => {
  if (!gapRemovePanelDrag || event.pointerId !== gapRemovePanelDrag.pointerId) return;
  event.preventDefault();
  setGapRemovePanelPosition(
    event.clientX - gapRemovePanelDrag.offsetX,
    event.clientY - gapRemovePanelDrag.offsetY,
  );
});
gapRemoveDragHandle?.addEventListener('pointerup', finishGapRemovePanelDrag);
gapRemoveDragHandle?.addEventListener('pointercancel', finishGapRemovePanelDrag);

gapRemovePanel?.querySelectorAll('input[type="number"]').forEach((input) => {
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

gapRemoveManageButton?.addEventListener('click', toggleGapRemovePanel);
gapRemoveScanButton?.addEventListener('click', scanAndRemoveGaps);
gapRemoveRestoreAllButton?.addEventListener('click', restoreAllGaps);
gapRemoveCloseButton?.addEventListener('click', closeGapRemovePanel);
gapRemoveOperationMode?.addEventListener('change', () => {
  const state = getGapRemoveData(true);
  const nextMode = GAP_REMOVE_OPERATION_MODES.has(gapRemoveOperationMode.value)
    ? gapRemoveOperationMode.value : DEFAULT_GAP_REMOVE_OPERATION_MODE;
  if (state.operation_mode === nextMode) return;
  pushGapRemoveUndo('切换空隙操作方式');
  state.operation_mode = nextMode;
  setGapRemoveData(state);
});
gapRemoveAdvancedToggle?.addEventListener('click', () => {
  setGapRemoveAdvancedOpen(!gapRemoveAdvancedIsOpen());
});
gapRemoveHysteresis?.addEventListener('input', updateGapRemoveHysteresisHint);
window.addEventListener('resize', () => {
  if (!gapRemovePanelIsOpen()) return;
  const rect = gapRemovePanel.getBoundingClientRect();
  setGapRemovePanelPosition(rect.left, rect.top, { persist: true });
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !gapRemovePanelIsOpen() || editingState) return;
  event.preventDefault();
  closeGapRemovePanel();
});
gapRemoveSkipPlayback?.addEventListener('change', () => {
  const state = getGapRemoveData(true) || { gaps: [] };
  if (state.skip_playback === gapRemoveSkipPlayback.checked) return;
  pushGapRemoveUndo('切换空隙跳过播放');
  state.skip_playback = gapRemoveSkipPlayback.checked;
  setGapRemoveData(state);
  if (!state.skip_playback) gapPreviewRange = null;
});

function syncPlayerPlaceholder() {
  if (!playerEmpty) return;
  const source = player?.currentSrc
    || player?.getAttribute('src')
    || player?.querySelector('source')?.getAttribute('src')
    || '';
  const hasMedia = Boolean(String(source).trim());
  playerEmpty.classList.toggle('hidden', hasMedia);
  playerWrap?.classList.toggle('empty-state', !hasMedia);
  waveformEditor?.setMediaAvailable(hasMedia);
}

// 合成表情包文件的 URL（用于 <img src>）
// 优先级:
//   1) sticker._blobUrl  - 来自浏览器选文件夹（无法拿到绝对路径，只能用 blob URL）
//   2) sticker.rel + STICKER_ROOT  - 拼出 file:// URL
//   3) sticker.path  - 兼容老版工程
function stickerUrl(sticker) {
  if (!sticker) return '';
  if (sticker._blobUrl) return sticker._blobUrl;
  if (sticker.rel) {
    if (STICKER_URL_PREFIX) {
      return `${STICKER_URL_PREFIX.replace(/\/$/, '')}/${sticker.rel.split('/').map(encodeURIComponent).join('/')}`;
    }
    if (!STICKER_ROOT) return sticker.rel;
    let root = STICKER_ROOT;
    if (root.startsWith('file://')) return root.replace(/\/+$/, '') + '/' + sticker.rel;
    let prefix = root.startsWith('/') ? 'file://' : 'file:///';
    return prefix + root.replace(/\/+$/, '') + '/' + sticker.rel;
  }
  if (sticker.path) return sticker.path;
  return '';
}

// 合成表情包文件的操作系统绝对路径（用于导出表情包 OTIO）。
// 当表情包是通过浏览器「选文件夹」方式加载时，STICKER_ROOT 是 "[本地] xxx" 虚拟标识，
// 浏览器安全限制无法拿到真实磁盘路径，此时返回空串。
function stickerAbsPath(sticker) {
  if (!sticker) return '';
  // [本地] 前缀 = 浏览器 blob URL 模式，无法获知真实路径
  if (STICKER_ROOT && STICKER_ROOT.startsWith('[本地]')) return '';
  if (sticker.rel && STICKER_ROOT) {
    // 去掉可能的 file:// 前缀，保留纯 OS 路径
    let root = STICKER_ROOT.replace(/^file:\/+/, '');
    // POSIX: 重新加上前导 /
    if (STICKER_ROOT.startsWith('file:///') && !root.startsWith('/') && !/^[A-Za-z]:/.test(root)) {
      root = '/' + root;
    }
    return root.replace(/\/+$/, '') + '/' + sticker.rel;
  }
  return sticker.path || '';
}
const selectedIdxs = new Set();
let lastClickedIdx = -1;  // 用于 Shift+click 范围选
let hideDisabled = false;  // 「隐藏禁用项」开关状态
const hideDisabledToggle = document.getElementById('hide-disabled-toggle');
// 隐藏开关开启时，禁用项视为"不可选"（Shift 范围选 / Ctrl 切换都跳过）
function isHiddenDisabled(idx) {
  return hideDisabled && !!(DATA.segments[idx] && DATA.segments[idx].disabled);
}

function clearSelection() {
  selectedIdxs.forEach(i => {
    const el = container.querySelector(`.cue[data-idx="${i}"]`);
    if (el) el.classList.remove('selected');
  });
  selectedIdxs.clear();
  selCountEl.textContent = '0';
  if (waveformEditor) waveformEditor.updateSelection();
  setCurrentCuePanelIndex(-1);
}
function toggleSel(idx) {
  if (isHiddenDisabled(idx)) return;  // 隐藏禁用项不参与选择
  const el = container.querySelector(`.cue[data-idx="${idx}"]`);
  if (selectedIdxs.has(idx)) {
    selectedIdxs.delete(idx);
    if (el) el.classList.remove('selected');
  } else {
    selectedIdxs.add(idx);
    if (el) el.classList.add('selected');
  }
  selCountEl.textContent = String(selectedIdxs.size);
  if (waveformEditor) waveformEditor.updateSelection();
  setCurrentCuePanelIndex(selectedIdxs.has(idx) ? idx : (selectedIdxs.values().next().value ?? -1));
}
function selectRange(a, b) {
  const lo = Math.min(a, b), hi = Math.max(a, b);
  for (let i = lo; i <= hi; i++) {
    if (isHiddenDisabled(i)) continue;  // 跳过隐藏禁用项
    if (!selectedIdxs.has(i)) {
      selectedIdxs.add(i);
      const el = container.querySelector(`.cue[data-idx="${i}"]`);
      if (el) el.classList.add('selected');
    }
  }
  selCountEl.textContent = String(selectedIdxs.size);
  if (waveformEditor) waveformEditor.updateSelection();
  setCurrentCuePanelIndex(selectedIdxs.has(b) ? b : (selectedIdxs.values().next().value ?? -1));
}
function selectOnly(idx) {
  clearSelection();
  selectedIdxs.add(idx);
  const el = container.querySelector(`.cue[data-idx="${idx}"]`);
  if (el) el.classList.add('selected');
  selCountEl.textContent = '1';
  if (waveformEditor) waveformEditor.updateSelection();
  setCurrentCuePanelIndex(idx);
}
// 返回与 idx 同属一个表情包/颜色分组的全部字幕下标（含 idx 自身）。
// head 持有 sticker/color，成员持 sticker_ref/color_ref 指向 head。
function groupMemberIdxs(idx) {
  const seg = DATA.segments[idx];
  if (!seg) return [idx];
  const heads = new Set();
  if (seg.sticker) heads.add(idx);
  else if (seg.sticker_ref) heads.add(seg.sticker_ref.headIdx);
  if (seg.color) heads.add(idx);
  else if (seg.color_ref) heads.add(seg.color_ref.headIdx);
  if (!heads.size) return [idx];
  const members = [];
  DATA.segments.forEach((s, i) => {
    const sHead = s.sticker ? i : (s.sticker_ref ? s.sticker_ref.headIdx : null);
    const cHead = s.color ? i : (s.color_ref ? s.color_ref.headIdx : null);
    if ((sHead !== null && heads.has(sHead)) || (cHead !== null && heads.has(cHead))) {
      members.push(i);
    }
  });
  return members.length ? members : [idx];
}
// 普通单击字幕时的选择逻辑：开启「同时选中分组内项目」且属于分组时选整组，否则只选本行。
function selectCueByClick(idx) {
  if (EDITOR_SETTINGS.selectGroupMembers) {
    const members = groupMemberIdxs(idx);
    if (members.length > 1) {
      clearSelection();
      members.forEach((i) => {
        selectedIdxs.add(i);
        const el = container.querySelector(`.cue[data-idx="${i}"]`);
        if (el) el.classList.add('selected');
      });
      selCountEl.textContent = String(selectedIdxs.size);
      if (waveformEditor) waveformEditor.updateSelection();
      setCurrentCuePanelIndex(idx);
      return;
    }
  }
  selectOnly(idx);
}

// === 渲染 ===
function renderAll() {
  // cues-container 同时是字幕列表和停靠模块；重绘列表时不要把布局编辑模式
  // 下的顶部拖拽栏一起清掉。
  const dockHandle = container.querySelector(':scope > .dock-handle');
  const emptyState = cuesEmpty;
  container.replaceChildren();
  if (dockHandle) container.appendChild(dockHandle);
  if (emptyState) {
    emptyState.classList.toggle('hidden', DATA.segments.length > 0);
    container.appendChild(emptyState);
  }
  DATA.segments.forEach((seg, i) => container.appendChild(buildCueEl(seg, i)));
  totalCountEl.textContent = DATA.segments.length;
  applySearch(searchEl.value);
  // 重新应用选中样式（idx 不变时还有效；如果有 splice 改了顺序就先 clearSelection）
  selectedIdxs.forEach(i => {
    const el = container.querySelector(`.cue[data-idx="${i}"]`);
    if (el) el.classList.add('selected');
  });
  if (waveformEditor) waveformEditor.renderSegments();
  renderCurrentCuePanel();
  syncPlayerPlaceholder();
}

function parsePanelTime(value, fallback) {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Math.round(Number(raw) * 1000);
  const parts = raw.split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return fallback;
  if (parts.length === 2) return Math.round((parts[0] * 60 + parts[1]) * 1000);
  if (parts.length === 3) return Math.round((parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000);
  return fallback;
}

function remapPanelItems(items, oldStart, oldEnd, newStart, newEnd) {
  if (!Array.isArray(items) || !items.length) return items;
  const oldDuration = Math.max(1, oldEnd - oldStart);
  const newDuration = Math.max(1, newEnd - newStart);
  return items.map((item) => ({
    ...item,
    start: Math.round(newStart + ((item.start - oldStart) / oldDuration) * newDuration),
    end: Math.round(newStart + ((item.end - oldStart) / oldDuration) * newDuration),
  }));
}

function ensureCuePanelUndo() {
  if (!cuePanelUndoPushed) {
    pushUndo('编辑当前字幕');
    cuePanelUndoPushed = true;
  }
}

function commitCuePanelEdit() {
  const idx = currentCuePanelIdx;
  const seg = DATA.segments[idx];
  if (!seg) { cuePanelUndoPushed = false; return false; }
  const nextText = cuePanelText.value.replace(/\r\n?/g, '\n');
  const oldStart = seg.start;
  const oldEnd = seg.end;
  const requestedStart = parsePanelTime(cuePanelStart.value, oldStart);
  const requestedDuration = Math.max(100, parsePanelTime(cuePanelDuration.value, oldEnd - oldStart));
  const previousEnd = idx > 0 ? DATA.segments[idx - 1].end : 0;
  const nextStart = idx + 1 < DATA.segments.length ? DATA.segments[idx + 1].start : (waveformEditor?.durationMs || oldEnd);
  if (nextStart - previousEnd < 100) {
    flashHint('相邻字幕之间不足 100ms，无法调整当前字幕');
    renderCurrentCuePanel();
    cuePanelUndoPushed = false;
    return false;
  }
  const newStart = Math.max(previousEnd, Math.min(requestedStart, nextStart - 100));
  const newEnd = Math.min(nextStart, newStart + requestedDuration);
  if (newEnd - newStart < 100) {
    flashHint('字幕时长不能小于 100ms');
    renderCurrentCuePanel();
    cuePanelUndoPushed = false;
    return false;
  }
  const changed = nextText !== seg.text || newStart !== oldStart || newEnd !== oldEnd;
  if (!changed) {
    cuePanelUndoPushed = false;
    return false;
  }
  ensureCuePanelUndo();
  seg.text = nextText;
  seg.start = newStart;
  seg.end = Math.max(newStart + 100, newEnd);
  if (seg.end > nextStart) {
    seg.end = nextStart;
    seg.start = Math.max(previousEnd, seg.end - 100);
  }
  seg.items = remapPanelItems(seg.items, oldStart, oldEnd, seg.start, seg.end);
  seg._dirty = true;
  cuePanelUndoPushed = false;
  renderAll();
  update();
  return true;
}

function renderCurrentCuePanel() {
  if (!cuePanel) return;
  const idx = currentCuePanelIdx;
  const seg = DATA.segments[idx];
  const empty = !seg;
  cuePanel.classList.toggle('empty', empty);
  [cuePanelPrev, cuePanelNext, cuePanelStart, cuePanelDuration, cuePanelText, cuePanelAddSticker, cuePanelSplit]
    .forEach((element) => { if (element) element.disabled = empty; });
  if (empty) {
    cuePanelText.value = '';
    cuePanelStart.value = '';
    cuePanelDuration.value = '';
    cuePanelTotalLength.textContent = '0';
    cuePanelCharsPerSecond.textContent = '0.00';
    cuePanelSticker.replaceChildren();
    cuePanelSticker.textContent = '未选择';
    return;
  }
  if (document.activeElement !== cuePanelText || !cuePanelUndoPushed) cuePanelText.value = seg.text || '';
  cuePanelStart.value = fmtShort(seg.start);
  cuePanelDuration.value = ((seg.end - seg.start) / 1000).toFixed(3);
  const metrics = window.AsrEditorUtils.cueMetrics(seg.text || '', seg.start, seg.end);
  cuePanelTotalLength.textContent = String(metrics.totalLength);
  cuePanelCharsPerSecond.textContent = metrics.charsPerSecond.toFixed(2);
  cuePanelSticker.replaceChildren();
  if (seg.sticker) {
    const image = document.createElement('img');
    image.src = stickerUrl(seg.sticker);
    image.alt = seg.sticker.name || '表情包';
    cuePanelSticker.title = '点击替换；右键删除';
    cuePanelSticker.appendChild(image);
  } else if (seg.sticker_ref) {
    const ref = document.createElement('span');
    ref.className = 'ref';
    ref.textContent = `↑ ${seg.sticker_ref.name || '表情包'}`;
    cuePanelSticker.title = '点击选择表情包；右键删除引用';
    cuePanelSticker.appendChild(ref);
  } else {
    cuePanelSticker.textContent = '暂无表情包';
    cuePanelSticker.title = '点击添加表情包';
  }
  const previous = window.AsrEditorUtils.findAdjacentCueIndex(DATA.segments, idx, -1, hideDisabled);
  const next = window.AsrEditorUtils.findAdjacentCueIndex(DATA.segments, idx, 1, hideDisabled);
  cuePanelPrev.disabled = previous < 0;
  cuePanelNext.disabled = next < 0;
}

function setCurrentCuePanelIndex(idx) {
  if (idx === currentCuePanelIdx) {
    renderCurrentCuePanel();
    return;
  }
  commitCuePanelEdit();
  currentCuePanelIdx = DATA.segments[idx] ? idx : -1;
  cuePanelUndoPushed = false;
  renderCurrentCuePanel();
}

function navigateCuePanel(direction) {
  if (currentCuePanelIdx < 0) return;
  commitCuePanelEdit();
  const next = window.AsrEditorUtils.findAdjacentCueIndex(DATA.segments, currentCuePanelIdx, direction, hideDisabled);
  if (next < 0) return;
  selectOnly(next);
  lastClickedIdx = next;
  const cue = container.querySelector(`.cue[data-idx="${next}"]`);
  if (cue) scrollCueToCenter(cue);
  waveformEditor?.revealTime(DATA.segments[next].start, true);
}

function splitCuePanelAtCursor() {
  const idx = currentCuePanelIdx;
  if (!DATA.segments[idx]) return;
  const cursorOffset = cuePanelText.selectionStart;
  commitCuePanelEdit();
  selectOnly(idx);
  const cue = container.querySelector(`.cue[data-idx="${idx}"]`);
  if (!cue) return;
  startEdit(cue, idx);
  const textEl = editingState?.textEl;
  if (!textEl || !textEl.firstChild) return;
  const range = document.createRange();
  const offset = Math.max(0, Math.min(cursorOffset, textEl.firstChild.textContent.length));
  range.setStart(textEl.firstChild, offset);
  range.setEnd(textEl.firstChild, offset);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  splitAtCursor();
}

cuePanelPrev?.addEventListener('click', () => navigateCuePanel(-1));
cuePanelNext?.addEventListener('click', () => navigateCuePanel(1));
cuePanelText?.addEventListener('keydown', (event) => {
  const action = getConfiguredEnterAction(event);
  if (!action || action === 'newline') return;
  event.preventDefault();
  event.stopPropagation();
  if (action === 'split') splitCuePanelAtCursor();
  else commitCuePanelEdit();
});
cuePanelText?.addEventListener('input', () => {
  if (currentCuePanelIdx < 0) return;
  ensureCuePanelUndo();
  const seg = DATA.segments[currentCuePanelIdx];
  seg.text = cuePanelText.value.replace(/\r\n?/g, '\n');
  seg._dirty = true;
  const metrics = window.AsrEditorUtils.cueMetrics(seg.text, seg.start, seg.end);
  cuePanelTotalLength.textContent = String(metrics.totalLength);
  cuePanelCharsPerSecond.textContent = metrics.charsPerSecond.toFixed(2);
  const cue = container.querySelector(`.cue[data-idx="${currentCuePanelIdx}"]`);
  if (cue) {
    setTextHtml(cue.querySelector('.text'), seg.text, searchEl.value);
    applyCharCount(cue.querySelector('.charcount'), seg.text);
  }
});
cuePanelText?.addEventListener('blur', () => commitCuePanelEdit());
cuePanelStart?.addEventListener('change', () => commitCuePanelEdit());
cuePanelDuration?.addEventListener('change', () => commitCuePanelEdit());
cuePanelAddSticker?.addEventListener('click', () => {
  if (currentCuePanelIdx >= 0) openStickerPicker([currentCuePanelIdx], false);
});
cuePanelSticker?.addEventListener('click', () => {
  if (currentCuePanelIdx >= 0) openStickerPicker([currentCuePanelIdx], false);
});
cuePanelSticker?.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  if (currentCuePanelIdx < 0) return;
  removeStickerCascade(currentCuePanelIdx);
  renderAll();
  flashHint('已删除当前表情包');
});
cuePanelSplit?.addEventListener('click', splitCuePanelAtCursor);

function buildCueEl(seg, idx) {
  const el = document.createElement('div');
  el.className = 'cue';
  el.dataset.idx = idx;
  if (seg._dirty) el.classList.add('dirty');
  if (seg.disabled) el.classList.add('disabled');

  // 颜色条（最左）
  const colorBar = document.createElement('span');
  colorBar.className = 'color-bar';
  if (seg.color) {
    const cv = seg.color.value || colorValue(seg.color.name);
    colorBar.classList.add('has-color');
    colorBar.style.setProperty('--color-bar', cv);
    el.classList.add('has-color');
    el.style.setProperty('--color-bar', cv);
    colorBar.title = `颜色：${seg.color.name}`;
  } else if (seg.color_ref) {
    const v = colorValue(seg.color_ref.name);
    colorBar.classList.add('is-ref');
    colorBar.style.setProperty('--color-bar', v);
    el.classList.add('has-color');
    el.style.setProperty('--color-bar', v);
    colorBar.title = `↑ 属于第 ${seg.color_ref.headIdx + 1} 条的颜色（${seg.color_ref.name}）`;
    colorBar.style.cursor = 'pointer';
    colorBar.addEventListener('click', (e) => {
      e.stopPropagation();
      const head = container.querySelector(`.cue[data-idx="${seg.color_ref.headIdx}"]`);
      if (head) { scrollCueToCenter(head); selectOnly(seg.color_ref.headIdx); }
    });
  }

  const indexEl = document.createElement('span');
  indexEl.className = 'index';
  indexEl.textContent = String(idx + 1);

  const timeEl = document.createElement('span');
  timeEl.className = 'time';
  timeEl.textContent = `${fmtShort(seg.start)} → ${fmtShort(seg.end)}`;

  // 表情包槽位
  const slotEl = document.createElement('span');
  slotEl.className = 'sticker-slot';
  if (seg.sticker) {
    const img = document.createElement('img');
    img.src = stickerUrl(seg.sticker);
    img.alt = seg.sticker.name;
    img.title = seg.sticker.name;
    img.addEventListener('click', (e) => {
      e.stopPropagation();
      openStickerPreview(idx);
    });
    const nameEl = document.createElement('div');
    nameEl.className = 'sname';
    nameEl.textContent = seg.sticker.name;
    slotEl.appendChild(img);
    slotEl.appendChild(nameEl);
  } else if (seg.sticker_ref) {
    // 跨多句的引用，只显示名称（带↑标识属于上方）
    slotEl.classList.add('ref');
    const refEl = document.createElement('div');
    refEl.className = 'sref';
    refEl.textContent = '↑ ' + seg.sticker_ref.name;
    refEl.title = `属于上方第 ${(seg.sticker_ref.headIdx || 0) + 1} 条的表情包`;
    refEl.addEventListener('click', (e) => {
      e.stopPropagation();
      // 点击 ref 跳转到 head 行
      const head = container.querySelector(`.cue[data-idx="${seg.sticker_ref.headIdx}"]`);
      if (head) { scrollCueToCenter(head); selectOnly(seg.sticker_ref.headIdx); }
    });
    slotEl.appendChild(refEl);
  }

  const textEl = document.createElement('span');
  textEl.className = 'text';
  setTextHtml(textEl, seg.text, searchEl.value);

  const cntEl = document.createElement('span');
  cntEl.className = 'charcount';
  applyCharCount(cntEl, seg.text);

  el.appendChild(colorBar);
  el.appendChild(indexEl);
  el.appendChild(timeEl);
  el.appendChild(slotEl);
  el.appendChild(textEl);
  el.appendChild(cntEl);

  bindCueEvents(el, idx);
  return el;
}

function fmtShort(ms) {
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2,'0')}:${(s - m * 60).toFixed(3).padStart(6,'0')}`;
}

function fmtSrtTime(ms) {
  ms = Math.max(0, Math.round(ms));
  const h = Math.floor(ms / 3600000); ms -= h * 3600000;
  const m = Math.floor(ms / 60000); ms -= m * 60000;
  const s = Math.floor(ms / 1000); ms -= s * 1000;
  const pad = (n, w) => String(n).padStart(w, '0');
  return `${pad(h,2)}:${pad(m,2)}:${pad(s,2)},${pad(ms,3)}`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}

function setTextHtml(el, text, query) {
  if (!query) {
    el.innerHTML = '';
    text.split('\n').forEach((line, i) => {
      if (i > 0) el.appendChild(document.createElement('br'));
      el.appendChild(document.createTextNode(line));
    });
    return;
  }
  const re = buildSearchRegex(query, false);
  let html = '';
  for (const line of text.split('\n').map(escapeHtml)) {
    if (html) html += '<br>';
    if (!re) { html += line; continue; }
    html += line.replace(re, m => `<mark>${m}</mark>`);
  }
  el.innerHTML = html;
}

function buildSearchRegex(query, caseSensitive) {
  if (!query) return null;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped, caseSensitive ? 'g' : 'gi');
}

// === 字数 ===
function calcCharWidth(text) {
  let total = 0;
  for (const ch of text) total += ch.codePointAt(0) < 256 ? 0.5 : 1;
  return total;
}
function getCharCountThreshold() {
  const v = parseInt(document.getElementById('charcount-threshold').value, 10);
  return Number.isFinite(v) && v > 0 ? v : 16;
}
function applyCharCount(cntEl, text) {
  const w = calcCharWidth(text);
  cntEl.textContent = Number.isInteger(w) ? String(w) : w.toFixed(1);
  cntEl.classList.toggle('over', w > getCharCountThreshold());
}
function refreshAllCharCounts() {
  container.querySelectorAll(':scope > .cue').forEach(el => {
    const idx = parseInt(el.dataset.idx);
    const cntEl = el.querySelector('.charcount');
    if (cntEl) applyCharCount(cntEl, DATA.segments[idx].text);
  });
}

// === 搜索 ===
function applySearch(query) {
  const trimmed = query.trim();
  let visible = 0;
  const re = buildSearchRegex(trimmed, false);
  const filterOver = document.getElementById('filter-over').classList.contains('active');
  const threshold = getCharCountThreshold();
  // 容器内还有布局拖拽栏和“加载工程后显示字幕列表”占位层；过滤只作用于真实字幕行。
  const cueElements = container.querySelectorAll(':scope > .cue');
  cueElements.forEach(el => {
    const idx = parseInt(el.dataset.idx);
    const seg = DATA.segments[idx];
    let matched = !re || re.test(seg.text);
    if (re) re.lastIndex = 0;
    if (matched && filterOver) {
      matched = calcCharWidth(seg.text) > threshold;
    }
    el.classList.toggle('hidden', !matched);
    if (matched) visible++;
    if (!el.classList.contains('editing')) {
      const textEl = el.querySelector('.text');
      if (textEl) setTextHtml(textEl, seg.text, trimmed);
    }
  });
  visibleCountEl.textContent = visible;
}
let searchDebounce = null;
const searchWrap = document.getElementById('search-wrap');
function refreshSearchClearVisibility() {
  searchWrap.classList.toggle('has-value', searchEl.value.length > 0);
}
searchEl.addEventListener('input', () => {
  refreshSearchClearVisibility();
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => applySearch(searchEl.value), 100);
});
document.getElementById('search-clear').addEventListener('click', () => {
  searchEl.value = '';
  refreshSearchClearVisibility();
  applySearch('');
  searchEl.focus();
});

// === 编辑 ===
let editingState = null;

function startEdit(el, idx, clickX, clickY) {
  if (editingState) finishEdit(true);
  const textEl = el.querySelector('.text');
  if (!textEl) return;
  const seg = DATA.segments[idx];
  let caretCharOffset = null;
  if (typeof clickX === 'number' && typeof clickY === 'number') {
    caretCharOffset = caretCharFromPoint(textEl, clickX, clickY);
  }
  editingState = { el, idx, textEl, original: seg.text };
  el.classList.add('editing');
  textEl.setAttribute('contenteditable', 'plaintext-only');
  textEl.innerText = seg.text;
  textEl.focus();
  const sel = window.getSelection();
  sel.removeAllRanges();
  if (caretCharOffset !== null && textEl.firstChild) {
    const range = document.createRange();
    const node = textEl.firstChild;
    const pos = Math.max(0, Math.min(caretCharOffset, node.textContent.length));
    range.setStart(node, pos);
    range.setEnd(node, pos);
    sel.addRange(range);
  } else {
    const range = document.createRange();
    range.selectNodeContents(textEl);
    sel.addRange(range);
  }
}

function setEditingCaretOffset(offset) {
  const textEl = editingState?.textEl;
  const node = textEl?.firstChild;
  if (!node || !Number.isFinite(offset)) return false;
  const pos = Math.max(0, Math.min(Math.round(offset), node.textContent.length));
  const range = document.createRange();
  range.setStart(node, pos);
  range.setEnd(node, pos);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

function caretCharFromPoint(root, x, y) {
  let range = null;
  if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(x, y);
  else if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (pos) { range = document.createRange(); range.setStart(pos.offsetNode, pos.offset); }
  }
  if (!range || (!root.contains(range.startContainer) && range.startContainer !== root)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(root);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length;
}

function finishEdit(save) {
  if (!editingState) return;
  const { el, idx, textEl, original } = editingState;
  textEl.removeAttribute('contenteditable');
  el.classList.remove('editing');
  if (save) {
    const newText = textEl.innerText.replace(/\r\n?/g, '\n').trimEnd();
    if (newText !== original) {
      pushUndo('编辑文本');
      DATA.segments[idx].text = newText;
      DATA.segments[idx]._dirty = true;
      el.classList.add('dirty');
    }
  }
  setTextHtml(textEl, DATA.segments[idx].text, searchEl.value);
  const cntEl = el.querySelector('.charcount');
  if (cntEl) applyCharCount(cntEl, DATA.segments[idx].text);
  editingState = null;
}

// === 拆分 ===
function splitAtCursor() {
  if (!editingState) return;
  const { el, idx, textEl } = editingState;
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const preRange = range.cloneRange();
  preRange.selectNodeContents(textEl);
  preRange.setEnd(range.startContainer, range.startOffset);
  const cursorOffset = preRange.toString().length;
  const fullText = textEl.innerText.replace(/\r\n?/g, '\n');
  const seg = DATA.segments[idx];

  if (cursorOffset <= 0 || cursorOffset >= fullText.length) {
    flashHint('光标必须在词与词之间才能拆分');
    return;
  }

  let leftText = fullText.slice(0, cursorOffset)
    .replace(/[，。,. \t]+$/, '').replace(/^[ \t]+/, '');
  let rightText = fullText.slice(cursorOffset)
    .replace(/^[，。,. \t]+/, '').replace(/[ \t]+$/, '');
  if (!leftText || !rightText) {
    flashHint('拆分后任一段为空，已取消');
    return;
  }

  const rightStartChar = fullText.length - rightText.length;
  const items = seg.items || [];
  const { leftItems, rightItems } = splitItemsAtChar(items, rightStartChar, fullText);
  if (leftItems.length) {
    const last = leftItems[leftItems.length - 1];
    last.text = last.text.replace(/[，。,. \t]+$/, '');
  }
  if (rightItems.length) {
    const first = rightItems[0];
    first.text = first.text.replace(/^[，。,. \t]+/, '');
  }
  const leftItemsClean = leftItems.filter(it => it.text.length > 0);
  const rightItemsClean = rightItems.filter(it => it.text.length > 0);

  let leftEnd, rightStart;
  if (leftItemsClean.length && rightItemsClean.length) {
    leftEnd = leftItemsClean[leftItemsClean.length - 1].end;
    rightStart = rightItemsClean[0].start;
  } else {
    const ratio = cursorOffset / fullText.length;
    const t = seg.start + (seg.end - seg.start) * ratio;
    leftEnd = Math.round(t); rightStart = Math.round(t);
  }

  const leftSeg = {
    start: seg.start, end: leftEnd, text: leftText,
    items: leftItemsClean.length ? leftItemsClean : null,
    sticker: seg.sticker || null,
    sticker_ref: seg.sticker_ref || null,
    color: seg.color || null,
    color_ref: seg.color_ref || null,
    disabled: !!seg.disabled,  // 拆分后两段都继承原禁用状态
    _dirty: true,
  };
  const rightSeg = {
    start: rightStart, end: seg.end, text: rightText,
    items: rightItemsClean.length ? rightItemsClean : null,
    sticker: null,
    // 如果原 seg 是被引用的 head，右段也成为同一表情包的延续 → 给 ref
    // 如果原 seg 自己是 ref，右段也保持 ref
    sticker_ref: seg.sticker
      ? { name: seg.sticker.name, headIdx: idx }  /* 暂用 idx，下面会修正 */
      : (seg.sticker_ref ? { ...seg.sticker_ref } : null),
    // color 同理：原 seg 是 head → 右段降级为 ref；原 seg 是 ref → 复制 ref
    color: null,
    color_ref: seg.color
      ? { name: seg.color.name, headIdx: idx }
      : (seg.color_ref ? { ...seg.color_ref } : null),
    disabled: !!seg.disabled,  // 拆分后两段都继承原禁用状态
    _dirty: true,
  };

  textEl.removeAttribute('contenteditable');
  el.classList.remove('editing');
  editingState = null;

  // 拆分会改变 idx，先清选中
  clearSelection();
  pushUndo('拆分字幕');
  DATA.segments.splice(idx, 1, leftSeg, rightSeg);

  // 修正所有 *_ref.headIdx：在 idx 之后的引用都右移 1
  // 但 leftSeg 在 idx 位置仍是 head（如果它有 sticker/color），rightSeg 的 ref.headIdx=idx 正好对应 leftSeg
  for (let i = idx + 2; i < DATA.segments.length; i++) {
    const sref = DATA.segments[i].sticker_ref;
    if (sref && sref.headIdx > idx) sref.headIdx += 1;
    const cref = DATA.segments[i].color_ref;
    if (cref && cref.headIdx > idx) cref.headIdx += 1;
  }

  renderAll();
  const rightEl = container.querySelector(`.cue[data-idx="${idx + 1}"]`);
  if (rightEl) scrollCueToCenter(rightEl);
  selectOnly(idx + 1);
}

function splitItemsAtChar(items, cursorChar) {
  let acc = 0;
  for (let i = 0; i < items.length; i++) {
    const len = items[i].text.length;
    if (acc + len >= cursorChar) {
      if (acc === cursorChar) return { leftItems: items.slice(0, i), rightItems: items.slice(i) };
      if (acc + len === cursorChar) return { leftItems: items.slice(0, i + 1), rightItems: items.slice(i + 1) };
      const distLeft = cursorChar - acc, distRight = (acc + len) - cursorChar;
      if (distLeft <= distRight) return { leftItems: items.slice(0, i), rightItems: items.slice(i) };
      else return { leftItems: items.slice(0, i + 1), rightItems: items.slice(i + 1) };
    }
    acc += len;
  }
  return { leftItems: items.slice(), rightItems: [] };
}

function splitFromContextMenu(idx, x, y, waveformTimeMs = null) {
  const el = container.querySelector(`.cue[data-idx="${idx}"]`);
  if (!el) return;
  if (Number.isFinite(waveformTimeMs)) {
    const cursorOffset = window.AsrEditorUtils.splitCharOffsetAtTime(
      DATA.segments[idx],
      waveformTimeMs,
    );
    if (cursorOffset === null) {
      flashHint('这条字幕没有可拆分的文字边界');
      return;
    }
    startEdit(el, idx);
    if (!setEditingCaretOffset(cursorOffset)) {
      finishEdit(false);
      flashHint('无法定位波形中的拆分位置');
      return;
    }
    splitAtCursor();
    return;
  }
  // 字幕列表：在指定位置进入编辑，光标定位到 (x,y) 后立即拆分
  startEdit(el, idx, x, y);
  splitAtCursor();
}

// === 合并 ===
function mergeSegments(idxs) {
  if (idxs.length < 2) { flashHint('请选中至少两条字幕再合并'); return; }
  const sorted = [...idxs].sort((a, b) => a - b);
  // 确保连续
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] !== sorted[i - 1] + 1) {
      flashHint('选中的字幕必须连续');
      return;
    }
  }
  const segs = sorted.map(i => DATA.segments[i]);
  const merged = {
    start: segs[0].start,
    end: segs[segs.length - 1].end,
    text: segs.map(s => s.text).join('  '),
    items: segs.flatMap(s => s.items || []),
    sticker: segs.find(s => s.sticker)?.sticker || null,
    sticker_ref: null,  // 合并后引用关系无意义
    color: (() => {
      // 合并后的 color：取范围内第一个 head 的 color；如无则 null
      // 同时 color.start/end 重写为合并后的范围
      const head = segs.find(s => s.color);
      if (!head) return null;
      return { ...head.color, start: segs[0].start, end: segs[segs.length - 1].end };
    })(),
    color_ref: null,
    disabled: !!segs[0].disabled,  // 合并后取 index=0 的禁用状态
    _dirty: true,
  };
  // 注意：如果合并范围里有 *_ref（指向被合并范围外的 head），合并后丢失这个引用
  // 这是预期行为——用户合并时应当知道
  if (merged.items.length === 0) merged.items = null;
  clearSelection();
  pushUndo('合并字幕');
  DATA.segments.splice(sorted[0], sorted.length, merged);
  // 因为 splice 改变了后续 idx，需要更新所有 *_ref.headIdx 来反映新偏移
  const removedCount = sorted.length - 1;  // 合并把 sorted.length 条变成 1 条
  if (removedCount > 0) {
    for (let i = sorted[0] + 1; i < DATA.segments.length; i++) {
      const sref = DATA.segments[i].sticker_ref;
      if (sref && sref.headIdx > sorted[sorted.length - 1]) sref.headIdx -= removedCount;
      const cref = DATA.segments[i].color_ref;
      if (cref && cref.headIdx > sorted[sorted.length - 1]) cref.headIdx -= removedCount;
    }
  }
  renderAll();
  const el = container.querySelector(`.cue[data-idx="${sorted[0]}"]`);
  if (el) scrollCueToCenter(el);
  flashHint(`已合并 ${sorted.length} 条`);
}

// === 组拆分 helper（删除 / 清除颜色 / 清除表情包 通用）===
// cutSet: Set<number> 包含被"切开"的 idx；这些 idx 的 head/ref 字段都会被清空，
//         同时把它们所在 group 的成员从切点处拆开，切点之后的部分重新组队，
//         首条升级为新 head，后续 ref 指向它。
//   - 删除场景：cutSet = 被物理删除的 idx；切完后由调用方负责 splice
//   - 清除场景：cutSet = 被清除 group 字段的 idx；调用方不删除字幕本身
function splitGroupsAtCutPoints(cutSet, headField, refField) {
  function groupHeadOf(seg, idx) {
    if (seg[headField]) return idx;
    if (seg[refField]) return seg[refField].headIdx;
    return -1;
  }
  // 1) 收集所有原始 group：headIdx → [members 升序]
  const groups = new Map();
  DATA.segments.forEach((s, i) => {
    const g = groupHeadOf(s, i);
    if (g < 0) return;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(i);
  });

  for (const [oldHeadIdx, members] of groups.entries()) {
    // 把成员按"切点"切成多个连续段
    const sub = [];
    let cur = [];
    for (const m of members) {
      if (cutSet.has(m)) {
        if (cur.length) { sub.push(cur); cur = []; }
      } else {
        cur.push(m);
      }
    }
    if (cur.length) sub.push(cur);

    // 拿原 head 数据作为新 head 的模板（深拷贝）
    const oldHead = DATA.segments[oldHeadIdx];
    const template = oldHead ? oldHead[headField] : null;
    if (!template) continue;

    sub.forEach((segIdxs, segNo) => {
      if (!segIdxs.length) return;
      const segHeadIdx = segIdxs[0];
      const segLastIdx = segIdxs[segIdxs.length - 1];
      const newStart = DATA.segments[segHeadIdx].start;
      const newEnd = DATA.segments[segLastIdx].end;

      if (segNo === 0 && segHeadIdx === oldHeadIdx) {
        // 原 head 还活着且未被切除 → 仅修正其时间范围
        if (oldHead[headField].end !== newEnd || oldHead[headField].start !== newStart) {
          oldHead[headField].end = newEnd;
          oldHead[headField].start = newStart;
        }
      } else {
        // 新段段首升级为 head
        const promoted = JSON.parse(JSON.stringify(template));
        promoted.start = newStart;
        promoted.end = newEnd;
        DATA.segments[segHeadIdx][headField] = promoted;
        DATA.segments[segHeadIdx][refField] = null;
        // 段内其余 ref 改指向新 head
        for (let k = 1; k < segIdxs.length; k++) {
          const refSeg = DATA.segments[segIdxs[k]];
          if (refSeg[refField]) {
            refSeg[refField].headIdx = segHeadIdx;
          }
        }
      }
    });
  }

  // 把切点位置的 head/ref 字段全部清空（调用方期望的副作用）
  cutSet.forEach(i => {
    const s = DATA.segments[i];
    if (!s) return;
    if (s[headField]) s[headField] = null;
    if (s[refField])  s[refField]  = null;
  });
}

// === 删除 ===
// 删除一组 idx，并智能维持 head/ref 链（"组拆分"语义）：
//   核心规则：被删的任一 idx 都会把它所属的 group 拆成"前段"和"后段"
//     - 前段（idx < 被删 idx 且原本同组）：保留原 head；head 的 .end 收缩到
//       前段最后一个存活的 ref/head 的 .end
//     - 后段（idx > 被删 idx 且原本同组）：第一个存活 ref 晋升为新 head，
//       后续同组 ref 改指向它
//   当被删的是 head：前段为空，整段后段重组（与之前的"head 晋升"语义吻合）
//   当被删的是 ref：head 仍是 head，但 group 被切成两块——这是用户原话
//     "删除中间的 3 → 4 变 head，5 改 ref→4"
function deleteSegments(idxs) {
  if (!idxs.length) return;
  const sorted = [...new Set(idxs)].sort((a, b) => a - b);
  if (sorted.length === DATA.segments.length) {
    flashHint('不能删除全部字幕');
    return;
  }
  // Commit any pending cue-panel edit and reset panel state BEFORE splicing.
  // Without this, clearSelection() → setCurrentCuePanelIndex(-1) → commitCuePanelEdit()
  // would write the stale panel text to whatever segment now occupies the old index
  // after splice shifts the array — causing wrong-adjacent text overwrites.
  commitCuePanelEdit();
  currentCuePanelIdx = -1;
  cuePanelUndoPushed = false;
  pushUndo(`删除 ${sorted.length} 条字幕`);
  const removeSet = new Set(sorted);

  // ---- 用通用 helper 做组拆分（同时清掉被删 idx 的 head/ref 字段）----
  splitGroupsAtCutPoints(removeSet, 'sticker', 'sticker_ref');
  splitGroupsAtCutPoints(removeSet, 'color',   'color_ref');

  // ---- 兜底：清"指向被删 idx 但没被规划"的残余 ref（理论上 splitGroups 已处理）----
  DATA.segments.forEach((s, i) => {
    if (removeSet.has(i)) return;
    if (s.sticker_ref && removeSet.has(s.sticker_ref.headIdx)) {
      s.sticker_ref = null;
    }
    if (s.color_ref && removeSet.has(s.color_ref.headIdx)) {
      s.color_ref = null;
    }
  });

  // ---- 倒序 splice 实际删除 ----
  for (let i = sorted.length - 1; i >= 0; i--) {
    DATA.segments.splice(sorted[i], 1);
  }

  // ---- 修正剩余 *_ref.headIdx：减去"前面被删的数量"----
  function shiftHeadIdx(ref) {
    let shift = 0;
    for (const r of sorted) { if (r < ref.headIdx) shift++; else break; }
    if (shift) ref.headIdx -= shift;
  }
  DATA.segments.forEach(s => {
    if (s.sticker_ref) shiftHeadIdx(s.sticker_ref);
    if (s.color_ref)   shiftHeadIdx(s.color_ref);
  });
  // 同样修正"刚被晋升为新 head 的段中"指向它的 ref：
  // splitGroups 写入的 refField.headIdx 是删除前的 idx，需要同样位移
  // 上面 shiftHeadIdx 已经覆盖（它扫所有 segments 的所有 ref）
  clearSelection();
  lastActive = -1;
  renderAll();
  flashHint(`已删除 ${sorted.length} 条`);
}

// === 滚动 ===
function scrollCueToCenter(cueEl) {
  if (!cueEl || cueEl.classList.contains('hidden')) return;
  const cRect = container.getBoundingClientRect();
  const eRect = cueEl.getBoundingClientRect();
  const offsetTop = (eRect.top - cRect.top) + container.scrollTop;
  const target = offsetTop + eRect.height / 2 - container.clientHeight / 2;
  container.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
}
function scrollCueIntoViewIfNeeded(cueEl) {
  if (!cueEl || cueEl.classList.contains('hidden')) return;
  const cRect = container.getBoundingClientRect();
  const eRect = cueEl.getBoundingClientRect();
  if (eRect.top < cRect.top || eRect.bottom > cRect.bottom) scrollCueToCenter(cueEl);
}

// === seek ===
let seekWarned = false;
function seekTo(timeSec) {
  const seekableEnd = player.seekable.length ? player.seekable.end(player.seekable.length - 1) : 0;
  if (seekableEnd <= 0 && !seekWarned) {
    seekWarned = true;
    flashHint('媒体不可 seek！请用 file:// 直接打开 HTML，或使用支持 Range 的服务器');
  }
  player.currentTime = timeSec;
  const p = player.play();
  if (p && p.catch) p.catch(() => {});
}

// === 单击/双击/Shift/Ctrl ===
function bindCueEvents(el, idx) {
  let clickTimer = null;
  el.addEventListener('click', (e) => {
    if (editingState && editingState.el === el) return;
    if (clickTimer) return;

    // Alt+点击 = 快速切换禁用状态（不延迟，立即处理；编辑模式下已被上方 return 拦截）
    if (e.altKey) {
      e.preventDefault();
      toggleDisabled([idx]);
      return;
    }

    // Shift / Ctrl 多选 — 不延迟，立即处理
    if (e.shiftKey) {
      e.preventDefault();
      if (lastClickedIdx >= 0) selectRange(lastClickedIdx, idx);
      else selectOnly(idx);
      lastClickedIdx = idx;
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      toggleSel(idx);
      lastClickedIdx = idx;
      return;
    }

    // 普通单击：等 dblclick 判定
    clickTimer = setTimeout(() => {
      clickTimer = null;
      if (editingState) return;
      // 选中本行（或整组，取决于设置）；select-and-seek 时同时跳转播放头
      selectCueByClick(idx);
      lastClickedIdx = idx;
      scrollCueToCenter(el);
      waveformEditor?.revealTime(DATA.segments[idx].start, true);
      if (EDITOR_SETTINGS.clickBehavior === 'select-and-seek') {
        seekTo(DATA.segments[idx].start / 1000);
      }
    }, 220);
  });
  el.addEventListener('dblclick', (e) => {
    e.preventDefault();
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
    selectOnly(idx);
    startEdit(el, idx, e.clientX, e.clientY);
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, idx);
  });
}

// === 全局键盘 ===
function getSplitKey() { return splitKeySel.value; }  // 'enter' or 'ctrl-enter'

function getConfiguredEnterAction(event) {
  return window.AsrEditorUtils.configuredEnterAction(event, getSplitKey());
}

document.addEventListener('keydown', (e) => {
  if (e.target === cuePanelText) return;
  if (!editingState) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finishEdit(false); return; }
  const action = getConfiguredEnterAction(e);
  if (!action || action === 'newline') return;
  e.preventDefault();
  e.stopPropagation();
  if (action === 'split') splitAtCursor();
  else finishEdit(true);
}, true);

function togglePlayback() {
  if (!hasLoadedMedia()) {
    flashHint('请先加载媒体，然后才能预览');
    return;
  }
  if (player.paused) {
    const promise = player.play();
    if (promise && promise.catch) promise.catch(() => {});
  } else {
    player.pause();
  }
}

function hasLoadedMedia() {
  return Boolean(
    player.currentSrc
    || player.getAttribute('src')
    || player.querySelector('source')?.getAttribute('src'),
  );
}

function isSpaceKey(e) {
  return e.key === ' ' || e.code === 'Space';
}

function isPlayerKeyboardTarget(event) {
  return event.target === player
    || document.activeElement === player
    || event.composedPath?.().includes(player);
}

// 空格播放/暂停。捕获阶段先于原生媒体控件处理，避免播放器焦点内发生双重切换。
let interceptedPlayerSpace = false;
document.addEventListener('keydown', (e) => {
  if (!isSpaceKey(e)) return;
  if (editingState) return;
  if (replaceModal.classList.contains('show')) return;
  if (stickerModal.classList.contains('show')) return;
  if (stickerPreviewModal.classList.contains('show')) return;
  if (projectMediaModal.classList.contains('show')) return;
  const a = document.activeElement;
  const playerFocused = isPlayerKeyboardTarget(e);
  if (!playerFocused && a && (
    a.tagName === 'INPUT'
    || a.tagName === 'TEXTAREA'
    || a.tagName === 'SELECT'
    || a.tagName === 'BUTTON'
    || a.tagName === 'A'
    || a.isContentEditable
  )) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  e.preventDefault();
  if (playerFocused) {
    interceptedPlayerSpace = true;
    e.stopImmediatePropagation();
  }
  if (e.repeat) return;
  togglePlayback();
}, true);

document.addEventListener('keyup', (e) => {
  if (!isSpaceKey(e) || (!interceptedPlayerSpace && !isPlayerKeyboardTarget(e))) return;
  e.preventDefault();
  interceptedPlayerSpace = false;
  e.stopImmediatePropagation();
}, true);

// J/K/L 倍速控制：K=重置 1×；J=×0.5（叠加）；L=×2（叠加）
// HTML5 playbackRate 多数浏览器钳在 [0.0625, 16]
const PLAYBACK_RATE_MIN = 0.0625;
const PLAYBACK_RATE_MAX = 16;
function fmtRate(r) {
  // 保留必要小数位：0.5/2/4 不带小数；0.25/0.0625 带
  if (Number.isInteger(r)) return r + '×';
  // 去掉尾部 0
  return r.toFixed(4).replace(/0+$/, '').replace(/\.$/, '') + '×';
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'j' && e.key !== 'J' && e.key !== 'k' && e.key !== 'K' && e.key !== 'l' && e.key !== 'L') return;
  if (editingState) return;
  if (replaceModal.classList.contains('show')) return;
  if (stickerModal.classList.contains('show')) return;
  if (stickerPreviewModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return;
  // Ctrl/Alt/Meta 别误触发（让浏览器自己处理 Ctrl+L 等）
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  e.preventDefault();
  let r = player.playbackRate;
  const k = e.key.toLowerCase();
  if (k === 'k') r = 1;
  else if (k === 'j') r = Math.max(PLAYBACK_RATE_MIN, r * 0.5);
  else if (k === 'l') r = Math.min(PLAYBACK_RATE_MAX, r * 2);
  player.playbackRate = r;
  flashHint(`倍速: ${fmtRate(r)}`);
});

// Ctrl/Cmd+Z 撤销；Ctrl/Cmd+Shift+Z 或 Ctrl/Cmd+Y 重做
document.addEventListener('keydown', (e) => {
  const isZ = e.key === 'z' || e.key === 'Z';
  const isY = e.key === 'y' || e.key === 'Y';
  if (!isZ && !isY) return;
  if (!(e.ctrlKey || e.metaKey)) return;
  const isRedo = isY || e.shiftKey;
  // 编辑文本时让浏览器自己处理 input 内的撤销/重做
  if (historyGuarded()) return;
  e.preventDefault();
  if (isRedo) performRedo();
  else performUndo();
});

// Delete 键删除选中的字幕（最小命令面，供回归测试与键盘操作）
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  // 编辑文本时让浏览器自己处理
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return;
  // modal 打开时不触发
  if (replaceModal.classList.contains('show')) return;
  if (stickerModal.classList.contains('show')) return;
  if (stickerPreviewModal.classList.contains('show')) return;
  if (projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (ctxmenu.classList.contains('show')) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  if (selectedIdxs.size === 0) return;
  e.preventDefault();
  e.stopPropagation();
  deleteSegments([...selectedIdxs]);
});

// 波形工具切换：V=选择（默认），C=剃刀，Esc=切回选择。与 J/K/L 一样只在
// 非输入/非模态/非编辑态下触发，避免抢占文本编辑与弹窗按键。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'v' && e.key !== 'V' && e.key !== 'c' && e.key !== 'C' && e.key !== 'Escape') return;
  if (!waveformEditor) return;
  // Escape：上下文菜单/弹窗/编辑态各自先处理；只有波形工具在 razor 时才切回。
  if (e.key === 'Escape') {
    if (editingState) return;
    if (ctxmenu.classList.contains('show')) return;
    if (replaceModal.classList.contains('show')) return;
    if (stickerModal.classList.contains('show')) return;
    if (stickerPreviewModal.classList.contains('show')) return;
    if (projectMediaModal.classList.contains('show')) return;
    if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
    if (waveformEditor.getTool() !== 'razor') return;
    e.preventDefault();
    waveformEditor.setTool('select');
    return;
  }
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return;
  if (editingState) return;
  if (replaceModal.classList.contains('show')) return;
  if (stickerModal.classList.contains('show')) return;
  if (stickerPreviewModal.classList.contains('show')) return;
  if (projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (ctxmenu.classList.contains('show')) return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  const tool = (e.key === 'v' || e.key === 'V') ? 'select' : 'razor';
  if (waveformEditor.getTool() === tool) return;
  e.preventDefault();
  waveformEditor.setTool(tool);
});

// 点击外部 -> 完成编辑
document.addEventListener('mousedown', (e) => {
  if (!editingState) return;
  if (!editingState.el.contains(e.target)) finishEdit(true);
});

// === 当前行高亮 + overlay ===
let lastActive = -1;
function findActive(tMs) {
  let lo = 0, hi = DATA.segments.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = DATA.segments[mid];
    if (s.start <= tMs) {
      if (s.end >= tMs || mid === DATA.segments.length - 1 ||
          DATA.segments[mid + 1].start > tMs) {
        ans = mid;
        if (s.end >= tMs) return mid;
      }
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

function removedGapAt(timeMs) {
  return getRemovedGapRanges().find((gap) => timeMs >= gap.start && timeMs < gap.end) || null;
}

function previewGapAt(index, timeMs) {
  const state = getGapRemoveData(false);
  const gap = getGapRemoveGaps()[index];
  if (!state?.skip_playback || !gap || gap.removed === false
      || timeMs < gap.start || timeMs >= gap.end) {
    gapPreviewRange = null;
    return;
  }
  gapPreviewRange = { start: gap.start, end: gap.end };
  flashHint('正在预览此空隙；播放头离开后恢复跳过');
}

function isPreviewingGap(gap, timeMs) {
  if (!gapPreviewRange) return false;
  if (timeMs < gapPreviewRange.start || timeMs >= gapPreviewRange.end) {
    gapPreviewRange = null;
    return false;
  }
  return gap.start === gapPreviewRange.start && gap.end === gapPreviewRange.end;
}

function update() {
  const tMs = player.currentTime * 1000;
  if (gapPreviewRange && (tMs < gapPreviewRange.start || tMs >= gapPreviewRange.end)) {
    gapPreviewRange = null;
  }
  const gapState = getGapRemoveData(false);
  const skippedGap = gapState?.skip_playback && !player.paused ? removedGapAt(tMs) : null;
  if (skippedGap && !isPreviewingGap(skippedGap, tMs)) {
    player.currentTime = skippedGap.end / 1000;
    return;
  }
  nowEl.textContent = fmtShort(tMs);
  const idx = findActive(tMs);
  if (idx !== lastActive) {
    if (lastActive >= 0) {
      const prev = container.querySelector(`.cue[data-idx="${lastActive}"]`);
      if (prev) prev.classList.remove('active');
    }
    if (idx >= 0) {
      const cur = container.querySelector(`.cue[data-idx="${idx}"]`);
      if (cur) {
        cur.classList.add('active');
        if (!editingState) scrollCueIntoViewIfNeeded(cur);
      }
    }
    lastActive = idx;
  }
  // overlay（禁用项不在画面上显示字幕文本）
  if (overlayToggle.checked) {
    const seg = idx >= 0 ? DATA.segments[idx] : null;
    if (seg && !seg.disabled && tMs >= seg.start && tMs <= seg.end) {
      overlayEl.classList.remove('hidden');
      overlayTextEl.textContent = seg.text;
    } else {
      overlayEl.classList.add('hidden');
    }
  }
}
player.addEventListener('timeupdate', update);
player.addEventListener('seeked', update);
overlayToggle.addEventListener('change', () => {
  // change 触发时 checked 已是新值；压入改变前的状态作为撤销点
  pushPreviewUndo('切换字幕预览', { overlay: !overlayToggle.checked });
  updateEditorSettings({ overlayEnabled: overlayToggle.checked });
  if (!overlayToggle.checked) overlayEl.classList.add('hidden');
  else update();
});

// === 下载 ===
// 程序内开关（不暴露 GUI）：导出 SRT 时保留禁用项的时间轴序号但内容替换为空白
let EXPORT_KEEP_DISABLED_PLACEHOLDER = false;

function buildSrt() {
  const parts = [];
  const timeOffset = window.AsrEditorUtils.getSrtExportOffset(
    DATA.segments,
    EDITOR_SETTINGS.exportStartAtZero,
  );
  const exportTime = (timeMs) => fmtSrtTime(Math.max(0, timeMs - timeOffset));
  let n = 0;  // 导出序号：跳过禁用项后重新连续编号
  DATA.segments.forEach((seg) => {
    if (seg.disabled) {
      if (!EXPORT_KEEP_DISABLED_PLACEHOLDER) return;  // 默认：完全跳过
      // 占位模式：保留时间轴，内容留空（序号不变）
      n++;
      parts.push(String(n));
      parts.push(`${exportTime(seg.start)} --> ${exportTime(seg.end)}`);
      parts.push('');
      parts.push('');
      return;
    }
    n++;
    parts.push(String(n));
    parts.push(`${exportTime(seg.start)} --> ${exportTime(seg.end)}`);
    parts.push(seg.text);
    parts.push('');
  });
  return parts.join('\n');
}

function buildGapRemovedSrt() {
  const removed = getRemovedGapRanges();
  if (!removed.length) {
    flashHint('没有已移除的静音空隙；请先使用「移除静音空隙」扫描并移除');
    return null;
  }
  const parts = [];
  let number = 0;
  DATA.segments.forEach((segment) => {
    if (segment.disabled) return;
    number++;
    const start = window.AsrEditorUtils.mapGapRemovedTime(segment.start, removed);
    const end = window.AsrEditorUtils.mapGapRemovedTime(segment.end, removed);
    parts.push(String(number));
    parts.push(`${fmtSrtTime(start)} --> ${fmtSrtTime(Math.max(start + 1, end))}`);
    parts.push(segment.text);
    parts.push('');
  });
  return parts.join('\n');
}

function gapRemovedExportContext() {
  const removed = getRemovedGapRanges();
  if (!removed.length) {
    flashHint('没有已移除的静音空隙；请先使用「移除静音空隙」扫描并移除');
    return null;
  }
  const durationMs = waveformEditor?.durationMs || Math.round(Number(player?.duration) * 1000) || 0;
  if (!durationMs) {
    flashHint('媒体时长尚不可用；请先加载媒体后再导出');
    return null;
  }
  const intervals = window.AsrEditorUtils.buildGapRemovedIntervals(durationMs, removed);
  if (!intervals.length) {
    flashHint('移除静音空隙后没有剩余媒体，无法导出');
    return null;
  }
  return { durationMs, intervals, removed };
}

function gapRemovedMediaReference() {
  return String(DATA.media || '').trim();
}

function buildGapRemovedFfconcat() {
  const context = gapRemovedExportContext();
  if (!context) return null;
  const media = gapRemovedMediaReference();
  if (!media) {
    flashHint('无法获得媒体文件名；请先加载媒体后再导出 FFconcat');
    return null;
  }
  return window.AsrEditorUtils.buildFfconcat(media, context.intervals);
}

function buildGapRemovedRegionsJson() {
  const context = gapRemovedExportContext();
  if (!context) return null;
  const keptRegions = context.intervals.map((interval, index) => ({
    index,
    start_ms: interval.start,
    end_ms: interval.end,
    duration_ms: interval.end - interval.start,
  }));
  const keptDurationMs = keptRegions.reduce((sum, region) => sum + region.duration_ms, 0);
  return JSON.stringify({
    schema: 'moy.asr.gap_removed_keep_regions.v1',
    source: 'moys-asr-workflow',
    media: gapRemovedMediaReference(),
    time_unit: 'milliseconds',
    source_duration_ms: context.durationMs,
    kept_duration_ms: keptDurationMs,
    removed_duration_ms: context.durationMs - keptDurationMs,
    kept_regions: keptRegions,
  }, null, 2);
}

function buildJson() {
  const out = {
    media: DATA.media || '',
    language: DATA.language || '',
    model: DATA.model || '',
    sticker_root: STICKER_ROOT || '',
    segments: DATA.segments.map(s => {
      const o = {
        start: s.start, end: s.end, text: s.text,
        items: s.items || [],
        sticker: s.sticker || null,
        sticker_ref: s.sticker_ref || null,
        color: s.color || null,
        color_ref: s.color_ref || null,
      };
      // 持久化"已改动"标记，便于二次打开时仍能识别脏行 / 离开提醒等
      if (s._dirty) o._dirty = true;
      // 持久化"禁用"标记（未禁用的不写字段，加载时默认 undefined=falsy 兼容旧工程）
      if (s.disabled) o.disabled = true;
      return o;
    }),
  };
  if (DATA.waveform) out.waveform = DATA.waveform;
  if (DATA.gap_remove) out.gap_remove = normalizedGapRemoveData(DATA.gap_remove);
  const layout = waveformEditor?.getLayoutData?.() || DATA.layout;
  if (layout) out.layout = layout;
  return JSON.stringify(out, null, 2);
}

function buildLayoutJson() {
  const layout = waveformEditor?.getLayoutData?.() || DATA.layout;
  return JSON.stringify(layout || {}, null, 2);
}

function buildResolveJson() {
  const segments = DATA.segments.map((seg, idx) => {
    const sticker = seg.sticker ? { ...seg.sticker } : null;
    if (sticker) {
      const absPath = stickerAbsPath(sticker);
      if (absPath) sticker.abs_path = absPath;
    }
    const colorName = seg.color?.name || seg.color_ref?.name || null;
    return {
      idx,
      start_ms: seg.start,
      end_ms: seg.end,
      text: seg.text || '',
      color: seg.color || null,
      color_ref: seg.color_ref || null,
      resolve_color: colorName,
      sticker,
      sticker_ref: seg.sticker_ref || null,
    };
  });
  const colorCount = segments.filter(s => s.resolve_color).length;
  const stickerCount = segments.filter(s => s.sticker).length;
  if (!colorCount && !stickerCount) {
    flashHint('没有颜色或表情包配置，无法导出 Resolve JSON');
    return null;
  }
  return JSON.stringify({
    schema: 'moy.asr_subtitle_editor.resolve.v1',
    source: 'moys-asr-workflow',
    filename_base: FILENAME_BASE,
    media: DATA.media || '',
    sticker_root: STICKER_ROOT || '',
    color_palette: COLOR_PALETTE,
    segments,
  }, null, 2);
}
const OTIO_STICKER_FPS = 60;

function otioTime(frames, fps = OTIO_STICKER_FPS) {
  return {
    OTIO_SCHEMA: 'RationalTime.1',
    rate: fps,
    value: Number(frames),
  };
}

function otioTimeRange(startFrames, durationFrames, fps = OTIO_STICKER_FPS) {
  return {
    OTIO_SCHEMA: 'TimeRange.1',
    duration: otioTime(durationFrames, fps),
    start_time: otioTime(startFrames, fps),
  };
}

function msToOtioFrames(ms, fps = OTIO_STICKER_FPS) {
  return Math.round(ms / 1000 * fps);
}

function stickerTargetUrl(absPath) {
  let value = String(absPath || '').trim();
  if (!value) return '';
  if (value.startsWith('file://')) {
    value = value.replace(/^file:\/+/, '');
    if (/^[A-Za-z]:/.test(value)) return `file:///${value.replace(/\\/g, '/')}`;
    return `file:///${value.replace(/^\/+/, '').replace(/\\/g, '/')}`;
  }
  value = value.replace(/\\/g, '/');
  if (/^[A-Za-z]:/.test(value)) return `file:///${value}`;
  return `file:///${value.replace(/^\/+/, '')}`;
}

function mediaTargetUrl() {
  const media = String(DATA.media || '').trim();
  if (/^file:\/\//i.test(media) || /^[A-Za-z]:[\\/]/.test(media) || media.startsWith('/')) {
    return stickerTargetUrl(media);
  }
  const current = String(player?.currentSrc || '').trim();
  if (/^file:\/\//i.test(current)) return current;
  return '';
}

function buildGapRemovedMediaClip(interval, index, kind, targetUrl) {
  const startFrame = msToOtioFrames(interval.start);
  const endFrame = msToOtioFrames(interval.end);
  const durationFrames = Math.max(1, endFrame - startFrame);
  return {
    OTIO_SCHEMA: 'Clip.2',
    metadata: {
      moy: {
        gap_remove_source_start_ms: interval.start,
        gap_remove_source_end_ms: interval.end,
        gap_remove_sequence_index: index,
      },
    },
    name: `${kind} ${index + 1}`,
    source_range: otioTimeRange(startFrame, durationFrames),
    effects: [],
    markers: [],
    enabled: true,
    color: null,
    media_references: {
      DEFAULT_MEDIA: {
        OTIO_SCHEMA: 'ExternalReference.1',
        metadata: {},
        name: '',
        available_range: null,
        available_image_bounds: null,
        target_url: targetUrl,
      },
    },
    active_media_reference_key: 'DEFAULT_MEDIA',
  };
}

function buildGapRemovedOtio() {
  const removed = getRemovedGapRanges();
  if (!removed.length) {
    flashHint('没有已移除的静音空隙；请先使用「移除静音空隙」扫描并移除');
    return null;
  }
  const durationMs = waveformEditor?.durationMs || Math.round(Number(player?.duration) * 1000) || 0;
  if (!durationMs) {
    flashHint('媒体时长尚不可用；请先加载媒体后再导出 OTIO');
    return null;
  }
  const targetUrl = mediaTargetUrl();
  if (!targetUrl) {
    flashHint('无法获得媒体绝对路径；请用 edit.py / server-editor 打开工程后再导出 OTIO');
    return null;
  }
  const intervals = window.AsrEditorUtils.buildGapRemovedIntervals(durationMs, removed);
  if (!intervals.length) {
    flashHint('移除静音空隙后没有剩余媒体，无法导出 OTIO');
    return null;
  }
  const trackSpecs = player?.tagName === 'AUDIO'
    ? [{ name: '音频', kind: 'Audio' }]
    : [{ name: '视频', kind: 'Video' }, { name: '音频', kind: 'Audio' }];
  const tracks = trackSpecs.map((track) => ({
    OTIO_SCHEMA: 'Track.1',
    metadata: {},
    name: track.name,
    source_range: null,
    effects: [],
    markers: [],
    enabled: true,
    color: null,
    children: intervals.map((interval, index) => buildGapRemovedMediaClip(interval, index, track.name, targetUrl)),
    kind: track.kind,
  }));
  return JSON.stringify({
    OTIO_SCHEMA: 'Timeline.1',
    metadata: {
      moy: {
        gap_remove_schema: GAP_REMOVE_SCHEMA,
        source_media: targetUrl,
        removed_gaps_ms: removed,
      },
    },
    name: `${FILENAME_BASE}_去空隙`,
    global_start_time: otioTime(0),
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      metadata: {},
      name: 'tracks',
      source_range: null,
      effects: [],
      markers: [],
      enabled: true,
      color: null,
      children: tracks,
    },
  }, null, 4);
}

function stickerOtioName(sticker, absPath) {
  if (sticker?.name) return sticker.name;
  if (sticker?.filename) return sticker.filename.replace(/\.[^.]+$/, '');
  return String(absPath || 'sticker').split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
}

function buildStickerOtio() {
  const collected = collectStickerOtioEntries(null);
  if (collected.error) {
    flashHint(collected.error);
    return null;
  }
  if (!collected.entries.length) {
    flashHint('没有任何表情包，无法导出 OTIO');
    return null;
  }
  const result = buildStickerOtioTimeline(collected.entries, `${FILENAME_BASE}_表情包`);
  if (result.error) {
    flashHint(result.error);
    return null;
  }
  return result.json;
}

// 收集表情包条目；当传入 removed gaps 时，把每条表情包的时间映射到去空隙后的时间线，
// 并跳过完全落在空隙内、映射后时长归零的条目。removed 为空数组时退化为原始时间线。
function collectStickerOtioEntries(removed) {
  const entries = [];
  for (let idx = 0; idx < DATA.segments.length; idx++) {
    const seg = DATA.segments[idx];
    if (!seg.sticker) continue;
    const absPath = stickerAbsPath(seg.sticker);
    if (!absPath) return { error: '表情包缺少真实磁盘路径；请先设置实际表情包根目录后再导出 OTIO' };
    const origStart = seg.sticker.start != null ? seg.sticker.start : seg.start;
    const origEnd = seg.sticker.end != null ? seg.sticker.end : seg.end;
    if (origEnd <= origStart) continue;
    const startMs = removed.length
      ? window.AsrEditorUtils.mapGapRemovedTime(origStart, removed)
      : origStart;
    const endMs = removed.length
      ? window.AsrEditorUtils.mapGapRemovedTime(origEnd, removed)
      : origEnd;
    // 映射后归零说明整张表情包都在被移除的空隙内，丢弃
    if (endMs <= startMs) continue;
    entries.push({
      idx,
      startMs,
      endMs,
      absPath,
      name: stickerOtioName(seg.sticker, absPath),
    });
  }
  return { entries };
}

function buildStickerOtioTimeline(stickers, timelineName) {
  stickers.sort((a, b) => (a.startMs - b.startMs) || (a.endMs - b.endMs) || (a.idx - b.idx));
  const children = [];
  let cursor = 0;
  for (const sticker of stickers) {
    const startFrame = msToOtioFrames(sticker.startMs);
    const endFrame = msToOtioFrames(sticker.endMs);
    const durationFrames = Math.max(1, endFrame - startFrame);
    if (startFrame < cursor) {
      return { error: `表情包时间重叠，无法导出单轨 OTIO：${sticker.name}` };
    }
    if (startFrame > cursor) {
      children.push({
        OTIO_SCHEMA: 'Gap.1',
        metadata: {},
        name: '',
        source_range: otioTimeRange(0, startFrame - cursor),
        effects: [],
        markers: [],
        enabled: true,
        color: null,
      });
    }
    children.push({
      OTIO_SCHEMA: 'Clip.2',
      metadata: {
        moy: {
          asr_segment_index: sticker.idx,
          start_ms: Math.round(sticker.startMs),
          end_ms: Math.round(sticker.endMs),
        },
      },
      name: sticker.name,
      source_range: otioTimeRange(0, durationFrames),
      effects: [],
      markers: [],
      enabled: true,
      color: null,
      media_references: {
        DEFAULT_MEDIA: {
          OTIO_SCHEMA: 'ExternalReference.1',
          metadata: {},
          name: '',
          available_range: null,
          available_image_bounds: null,
          target_url: stickerTargetUrl(sticker.absPath),
        },
      },
      active_media_reference_key: 'DEFAULT_MEDIA',
    });
    cursor = startFrame + durationFrames;
  }
  return {
    json: JSON.stringify({
      OTIO_SCHEMA: 'Timeline.1',
      metadata: {},
      name: timelineName,
      global_start_time: otioTime(0),
      tracks: {
        OTIO_SCHEMA: 'Stack.1',
        metadata: {},
        name: 'tracks',
        source_range: null,
        effects: [],
        markers: [],
        enabled: true,
        color: null,
        children: [{
          OTIO_SCHEMA: 'Track.1',
          metadata: {},
          name: '表情包',
          source_range: null,
          effects: [],
          markers: [],
          enabled: true,
          color: null,
          children,
          kind: 'Video',
        }],
      },
    }, null, 4),
  };
}

function buildGapRemovedStickerOtio() {
  const removed = getRemovedGapRanges();
  if (!removed.length) {
    flashHint('没有已移除的静音空隙；请先使用「移除静音空隙」扫描并移除');
    return null;
  }
  const collected = collectStickerOtioEntries(removed);
  if (collected.error) {
    flashHint(collected.error);
    return null;
  }
  if (!collected.entries.length) {
    flashHint('没有落在保留区间内的表情包，无法导出去空隙表情包 OTIO');
    return null;
  }
  const result = buildStickerOtioTimeline(collected.entries, `${FILENAME_BASE}_去空隙表情包`);
  if (result.error) {
    flashHint(result.error);
    return null;
  }
  return result.json;
}

async function downloadFile(content, filename, mime, accept) {
  // 优先尝试 File System Access API（弹出保存路径选择对话框）
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: accept ? [{ description: accept.desc, accept: accept.types }] : undefined,
      });
      const w = await handle.createWritable();
      await w.write(new Blob([content], { type: mime + ';charset=utf-8' }));
      await w.close();
      return true;
    } catch (e) {
      // 用户取消保存对话框 — 静默退出，不回退
      if (e && e.name === 'AbortError') return false;
      // 其他错误（如安全限制、unsupported 文件类型）：回退到 anchor 下载
    }
  }
  // 兜底：传统 anchor 下载（不弹路径选择）
  const blob = new Blob([content], { type: mime + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

// === 标题区：媒体名点击复制 / JSON 文件名点击复制 ===
function copyText(text, hint) {
  navigator.clipboard.writeText(text).then(
    () => flashHint(hint || `已复制：${text}`),
    () => { /* 降级：exec */ document.execCommand('copy'); flashHint(hint || `已复制：${text}`); }
  );
}

function serverProjectSavingEnabled() {
  return !!(SERVER_CONFIG && SERVER_CONFIG.saveUrl && SERVER_CONFIG.canSave);
}

function configureServerSaveControls() {
  const hasServer = !!(SERVER_CONFIG && SERVER_CONFIG.saveUrl);
  [saveProjectButton, saveProjectAsButton].forEach((button) => {
    if (!button) return;
    button.hidden = !hasServer;
    button.disabled = !serverProjectSavingEnabled();
    if (!serverProjectSavingEnabled()) {
      button.title = '请用带 JSON 工程路径的服务器命令启动，才能直接保存';
    }
  });
}

function hasUnsavedProjectChanges() {
  return gapRemoveDirty || DATA.segments.some((segment) => segment._dirty);
}

async function openRecentProject(project) {
  if (!SERVER_CONFIG?.recentProjectsUrl) return;
  if (hasUnsavedProjectChanges()
      && !confirm('当前有未保存的改动，是否确定打开最近工程？将丢失未保存内容。')) {
    return;
  }
  try {
    const response = await fetch(SERVER_CONFIG.recentProjectsUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: project.path }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) {
      throw new Error(result.error || `服务器返回 ${response.status}`);
    }
    window.location.reload();
  } catch (error) {
    flashHint(`打开工程失败：${error.message || error}`);
  }
}

function configureRecentProjects() {
  if (!SERVER_CONFIG?.recentProjectsUrl || !recentProjectsEl || !recentProjectsToggle || !recentProjectsMenu) {
    return;
  }
  const projects = Array.isArray(SERVER_CONFIG.recentProjects) ? SERVER_CONFIG.recentProjects : [];
  if (!projects.length) return;
  recentProjectsEl.hidden = false;
  recentProjectsMenu.replaceChildren();
  projects.forEach((project, index) => {
    if (!project || typeof project.path !== 'string' || typeof project.name !== 'string') return;
    const item = document.createElement('div');
    item.className = 'dropdown-item';
    item.textContent = index === 0 ? `上次打开：${project.name}` : project.name;
    item.title = project.path;
    item.addEventListener('click', () => {
      recentProjectsEl.classList.remove('open');
      openRecentProject(project);
    });
    recentProjectsMenu.appendChild(item);
  });
  recentProjectsToggle.addEventListener('click', (event) => {
    event.stopPropagation();
    recentProjectsEl.classList.toggle('open');
  });
  document.addEventListener('click', (event) => {
    if (!recentProjectsEl.contains(event.target)) recentProjectsEl.classList.remove('open');
  });
}

function configureServerProjectSettings() {
  if (!SERVER_CONFIG?.settingsUrl || !serverProjectSettingsEl || !autoOpenLastProjectToggle) return;
  serverProjectSettingsEl.hidden = false;
  autoOpenLastProjectToggle.checked = SERVER_CONFIG.autoOpenLastProject !== false;
  autoOpenLastProjectToggle.addEventListener('change', async () => {
    const enabled = autoOpenLastProjectToggle.checked;
    autoOpenLastProjectToggle.disabled = true;
    try {
      const response = await fetch(SERVER_CONFIG.settingsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoOpenLastProject: enabled }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) {
        throw new Error(result.error || `服务器返回 ${response.status}`);
      }
      SERVER_CONFIG.autoOpenLastProject = result.autoOpenLastProject;
    } catch (error) {
      autoOpenLastProjectToggle.checked = SERVER_CONFIG.autoOpenLastProject !== false;
      flashHint(`保存设置失败：${error.message || error}`);
    } finally {
      autoOpenLastProjectToggle.disabled = false;
    }
  });
}

function markProjectSaved(filename, backupName) {
  DATA.segments.forEach((segment) => { delete segment._dirty; });
  gapRemoveDirty = false;
  FILENAME_BASE = filename.replace(/\.json$/i, '');
  const jsonEl = document.getElementById('json-name');
  if (jsonEl) {
    jsonEl.textContent = filename;
    jsonEl.title = `点击复制 JSON 文件名：${filename}`;
    jsonEl.classList.remove('empty');
  }
  renderAll();
  flashHint(backupName ? `已保存工程：${filename}（已备份为 ${backupName}）` : `已保存工程：${filename}`);
}

async function saveProjectToServer(saveAs = false) {
  if (!serverProjectSavingEnabled()) {
    flashHint('此服务器没有绑定可保存的工程；请使用“导出工程”或带 JSON 路径重新启动服务器');
    return;
  }
  if (editingState) finishEdit(true);
  let filename = null;
  if (saveAs) {
    const suggested = `${FILENAME_BASE}.json`;
    const entered = window.prompt('另存为到当前工程目录（仅文件名）：', suggested);
    if (entered === null) return;
    filename = entered.trim();
    if (!filename) {
      flashHint('文件名不能为空');
      return;
    }
  }
  try {
    const response = await fetch(SERVER_CONFIG.saveUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: JSON.parse(buildJson()), filename }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) {
      throw new Error(result.error || `服务器返回 ${response.status}`);
    }
    markProjectSaved(result.filename, result.backup);
  } catch (error) {
    flashHint(`保存失败：${error.message || error}`);
  }
}

const mediaNameEl = document.getElementById('media-name');
if (mediaNameEl && !mediaNameEl.classList.contains('empty')) {
  mediaNameEl.addEventListener('click', () => {
    const name = mediaNameEl.textContent.trim();
    if (name) copyText(name, `已复制媒体名：${name}`);
  });
}

const jsonNameEl = document.getElementById('json-name');
if (jsonNameEl && !jsonNameEl.classList.contains('empty')) {
  jsonNameEl.addEventListener('click', () => {
    const name = jsonNameEl.textContent.trim();
    if (name) copyText(name, `已复制：${name}`);
  });
}

document.getElementById('download-srt').addEventListener('click', async () => {
  if (editingState) finishEdit(true);
  await downloadFile(buildSrt(), `${FILENAME_BASE}.srt`, 'text/plain', {
    desc: 'SRT 字幕文件', types: { 'text/plain': ['.srt'] }
  });
});
document.getElementById('download-json').addEventListener('click', async () => {
  if (editingState) finishEdit(true);
  await downloadFile(buildJson(), `${FILENAME_BASE}.json`, 'application/json', {
    desc: '编辑器工程文件', types: { 'application/json': ['.json'] }
  });
});
saveProjectButton?.addEventListener('click', () => saveProjectToServer(false));
saveProjectAsButton?.addEventListener('click', () => saveProjectToServer(true));
document.getElementById('layout-export')?.addEventListener('click', async () => {
  await downloadFile(buildLayoutJson(), `${FILENAME_BASE}.layout.json`, 'application/json', {
    desc: '编辑器布局文件', types: { 'application/json': ['.layout.json', '.json'] }
  });
});
const layoutImportFile = document.getElementById('layout-import-file');
document.getElementById('layout-import')?.addEventListener('click', () => {
  if (!layoutImportFile) return;
  layoutImportFile.value = '';
  layoutImportFile.click();
});
layoutImportFile?.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file || !waveformEditor) return;
  try {
    const data = JSON.parse(await file.text());
    pushLayoutUndo('导入布局', waveformEditor.getLayoutHistorySnapshot?.());
    waveformEditor.setLayoutData(data.layout || data);
    DATA.layout = waveformEditor.getLayoutData();
    flashHint(`已导入布局：${file.name}`);
  } catch (error) {
    flashHint(`布局导入失败：${error.message}`);
  }
});
document.getElementById('download-resolve-json').addEventListener('click', async () => {
  if (editingState) finishEdit(true);
  const payload = buildResolveJson();
  if (payload) {
    await downloadFile(payload, `${FILENAME_BASE}_resolve.json`, 'application/json', {
      desc: 'Resolve JSON', types: { 'application/json': ['.json'] }
    });
  }
});document.getElementById('download-sticker-otio').addEventListener('click', async () => {
  if (editingState) finishEdit(true);
  const payload = buildStickerOtio();
  if (payload) {
    await downloadFile(payload, `${FILENAME_BASE}_stickers.otio`, 'application/vnd.opentimelineio+json', {
      desc: 'OTIO 工程文件', types: { 'application/vnd.opentimelineio+json': ['.otio'] }
    });
  }
});
document.getElementById('download-gap-removed-srt').addEventListener('click', async () => {
  if (editingState) finishEdit(true);
  const payload = buildGapRemovedSrt();
  if (payload) {
    await downloadFile(payload, `${FILENAME_BASE}_gap-removed.srt`, 'text/plain', {
      desc: '去空隙字幕 SRT', types: { 'text/plain': ['.srt'] }
    });
  }
});
document.getElementById('download-gap-removed-otio').addEventListener('click', async () => {
  if (editingState) finishEdit(true);
  const payload = buildGapRemovedOtio();
  if (payload) {
    await downloadFile(payload, `${FILENAME_BASE}_gap-removed.otio`, 'application/vnd.opentimelineio+json', {
      desc: '去空隙 OTIO 工程', types: { 'application/vnd.opentimelineio+json': ['.otio'] }
    });
  }
});
document.getElementById('download-gap-removed-ffconcat').addEventListener('click', async () => {
  if (editingState) finishEdit(true);
  const payload = buildGapRemovedFfconcat();
  if (payload) {
    await downloadFile(payload, `${FILENAME_BASE}_gap-removed.ffconcat`, 'text/plain', {
      desc: 'FFconcat 剪辑计划', types: { 'text/plain': ['.ffconcat'] }
    });
  }
});
document.getElementById('download-gap-removed-regions-json').addEventListener('click', async () => {
  if (editingState) finishEdit(true);
  const payload = buildGapRemovedRegionsJson();
  if (payload) {
    await downloadFile(payload, `${FILENAME_BASE}_gap-removed.keep-regions.json`, 'application/json', {
      desc: '去空隙保留区域 JSON', types: { 'application/json': ['.json'] }
    });
  }
});
document.getElementById('download-gap-removed-sticker-otio').addEventListener('click', async () => {
  if (editingState) finishEdit(true);
  const payload = buildGapRemovedStickerOtio();
  if (payload) {
    await downloadFile(payload, `${FILENAME_BASE}_gap-removed-stickers.otio`, 'application/vnd.opentimelineio+json', {
      desc: '去空隙表情包 OTIO 工程', types: { 'application/vnd.opentimelineio+json': ['.otio'] }
    });
  }
});

// === 工具栏导出下拉菜单 ===
function bindToolbarExportDropdown(dropdownId, buttonId, menuId) {
  const dd = document.getElementById(dropdownId);
  const btn = document.getElementById(buttonId);
  const menu = document.getElementById(menuId);
  if (!dd || !btn || !menu) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.toolbar .dropdown.open').forEach((other) => {
      if (other !== dd) other.classList.remove('open');
    });
    dd.classList.toggle('open');
  });
  menu.addEventListener('click', (e) => {
    if (e.target.classList.contains('dropdown-item')) {
      dd.classList.remove('open');
    }
  });
  document.addEventListener('click', (e) => {
    if (!dd.contains(e.target)) dd.classList.remove('open');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') dd.classList.remove('open');
  });
}
bindToolbarExportDropdown('gap-removed-export-dropdown', 'gap-removed-export-btn', 'gap-removed-export-menu');
bindToolbarExportDropdown('extra-export-dropdown', 'extra-export-btn', 'extra-export-menu');

// === 打开工程 ===
const openProjectFileInput = document.getElementById('open-project-file');
const loadMediaFileInput = document.getElementById('load-media-file');
let currentMediaBlobUrl = null;  // 跟踪 blob URL，便于切换时 revoke 防泄漏
let pendingProjectMediaSelection = null;

function closeProjectMediaModal(clearPending = false) {
  projectMediaModal.classList.remove('show');
  if (clearPending) pendingProjectMediaSelection = null;
}

function showProjectMediaModal() {
  projectMediaModal.classList.add('show');
  projectMediaSelectButton.focus();
}

projectMediaSelectButton.addEventListener('click', () => {
  closeProjectMediaModal(false);
  loadMediaFileInput.value = '';
  loadMediaFileInput.click();
});

projectMediaLaterButton.addEventListener('click', () => {
  closeProjectMediaModal(true);
  flashHint('可稍后点击“加载媒体”选择关联媒体');
});

projectMediaModal.addEventListener('click', (event) => {
  if (event.target === projectMediaModal) projectMediaLaterButton.click();
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !projectMediaModal.classList.contains('show')) return;
  event.preventDefault();
  event.stopPropagation();
  projectMediaLaterButton.click();
}, true);

function updateUnloadedMediaLabel(mediaPath) {
  const mediaName = window.AsrEditorUtils.fileBasename(mediaPath);
  const mediaNameEl = document.getElementById('media-name');
  if (!mediaNameEl) return;
  if (!mediaName) {
    mediaNameEl.textContent = '未加载媒体';
    mediaNameEl.title = '';
    mediaNameEl.classList.add('empty');
    mediaNameEl.onclick = null;
    return;
  }
  mediaNameEl.textContent = `未加载：${mediaName}`;
  mediaNameEl.title = `工程关联媒体：${mediaPath}`;
  mediaNameEl.classList.add('empty');
  mediaNameEl.onclick = () => copyText(mediaPath, `已复制媒体路径：${mediaPath}`);
}

function resetLoadedMedia() {
  if (currentMediaBlobUrl) URL.revokeObjectURL(currentMediaBlobUrl);
  currentMediaBlobUrl = null;
  const oldPlayer = player;
  try { oldPlayer?.pause(); } catch (_) {}
  const emptyPlayer = document.createElement('audio');
  emptyPlayer.id = 'player';
  emptyPlayer.controls = true;
  emptyPlayer.preload = 'metadata';
  emptyPlayer.style.cssText = 'width:100%;display:block;';
  oldPlayer?.parentNode?.replaceChild(emptyPlayer, oldPlayer);
  player = emptyPlayer;
  player.addEventListener('timeupdate', update);
  player.addEventListener('seeked', update);
  seekWarned = false;
  waveformEditor?.attachPlayer(player);
  syncPlayerPlaceholder();
}

async function openProjectFile(file, mediaFiles = [], pendingMediaRequest = null) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data.segments || !Array.isArray(data.segments)) {
      flashHint('文件格式不对，缺少 segments 字段');
      if (pendingProjectMediaSelection === pendingMediaRequest) pendingProjectMediaSelection = null;
      return false;
    }
    // 单独选 JSON 时，浏览器没有授权访问它所在目录；先清理旧媒体，避免旧音轨配上新字幕。
    resetLoadedMedia();
    DATA.media = typeof data.media === 'string' ? data.media : '';
    DATA.language = data.language || '';
    DATA.model = data.model || '';
    DATA.waveform = data.waveform || null;
    DATA.layout = data.layout || null;
    DATA.gap_remove = data.gap_remove || null;
    gapRemoveDirty = false;
    if (data.sticker_root) STICKER_ROOT = data.sticker_root;
    DATA.segments.length = 0;
    data.segments.forEach((segment) => DATA.segments.push(segment));
    editorHistory.clear();
    updateUndoRedoButtons();
    clearSelection();
    lastActive = -1;
    if (waveformEditor) {
      waveformEditor.setLayoutData(DATA.layout);
      waveformEditor.setPayload(DATA.waveform);
    }
    updateGapRemoveUi();
    renderAll();
    updateUnloadedMediaLabel(DATA.media);

    FILENAME_BASE = file.name.replace(/\.json$/i, '');
    const jsonEl = document.getElementById('json-name');
    if (jsonEl) {
      jsonEl.textContent = file.name;
      jsonEl.title = `点击复制 JSON 文件名：${file.name}`;
      jsonEl.classList.remove('empty');
      jsonEl.onclick = () => copyText(file.name, `已复制：${file.name}`);
    }
    const timeEl = document.getElementById('gen-time');
    if (timeEl) {
      const now = new Date();
      const pad = (value) => String(value).padStart(2, '0');
      timeEl.textContent = `打开时间 ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    }

    const chosenMedia = window.AsrEditorUtils.findProjectMediaFile(mediaFiles, DATA.media, file.name)
      || (mediaFiles.length === 1 ? mediaFiles[0] : null);
    if (chosenMedia) {
      await loadMediaFile(chosenMedia);
      flashHint(`已加载工程和媒体：${file.name} · ${chosenMedia.name}`);
      return true;
    }
    if (pendingMediaRequest && pendingProjectMediaSelection === pendingMediaRequest) {
      pendingMediaRequest.projectReady = true;
      if (pendingMediaRequest.file) {
        pendingProjectMediaSelection = null;
        await loadMediaFile(pendingMediaRequest.file);
        flashHint(`已加载工程和媒体：${file.name} · ${pendingMediaRequest.file.name}`);
        return true;
      }
    }
    const expectedName = window.AsrEditorUtils.fileBasename(DATA.media);
    flashHint(expectedName
      ? `已加载工程：${file.name}（等待选择关联媒体：${expectedName}）`
      : `已加载工程：${file.name}（${DATA.segments.length} 条字幕）`);
    return true;
  } catch (error) {
    if (pendingProjectMediaSelection === pendingMediaRequest) pendingProjectMediaSelection = null;
    flashHint(`加载失败：${error.message}`);
    console.error(error);
    return false;
  }
}

document.getElementById('open-project').addEventListener('click', () => {
  if (hasUnsavedProjectChanges()) {
    if (!confirm('当前有未保存的改动，是否确定打开新工程？将丢失未保存内容。')) return;
  }
  openProjectFileInput.value = '';
  openProjectFileInput.click();
});

openProjectFileInput.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  const file = files.find(isJsonFile);
  if (!file) {
    flashHint('请选择一个 JSON 工程文件；可同时按 Ctrl/Shift 选择对应媒体。');
    return;
  }
  const mediaFiles = files.filter(isMediaFile);
  let pendingMediaRequest = null;
  if (!mediaFiles.length) {
    pendingMediaRequest = { file: null, projectReady: false };
    pendingProjectMediaSelection = pendingMediaRequest;
    showProjectMediaModal();
  }
  const opened = await openProjectFile(file, mediaFiles, pendingMediaRequest);
  if (!opened && pendingMediaRequest) closeProjectMediaModal(true);
});

// === 加载媒体 ===
// 通过浏览器文件选择器选本地媒体（视频/音频），用 blob URL 替换播放器源。
// 如果媒体类型与当前播放器标签不一致（video<->audio），会原地替换整个 <video>/<audio> 元素。
document.getElementById('load-media').addEventListener('click', () => {
  pendingProjectMediaSelection = null;
  loadMediaFileInput.value = '';
  loadMediaFileInput.click();
});

async function loadMediaFile(file) {
  if (!file) return;
  const url = URL.createObjectURL(file);
  const isVideo = file.type.startsWith('video/') ||
    /\.(mp4|mkv|avi|mov|wmv|flv|webm|ts|m4v)$/i.test(file.name);
  const oldPlayer = document.getElementById('player');
  const wantTag = isVideo ? 'VIDEO' : 'AUDIO';

  if (oldPlayer.tagName === wantTag) {
    // 同类型：直接换 src，最简最安全
    const src = oldPlayer.querySelector('source');
    if (src) src.src = url; else oldPlayer.src = url;
    oldPlayer.load();
  } else {
    // 不同类型：替换整个元素
    const newPlayer = document.createElement(isVideo ? 'video' : 'audio');
    newPlayer.id = 'player';
    newPlayer.controls = true;
    newPlayer.preload = 'metadata';
    if (isVideo) {
      newPlayer.style.cssText = 'width:100%;max-height:40vh;background:#000;display:block;';
    } else {
      newPlayer.style.cssText = 'width:100%;display:block;';
    }
    const source = document.createElement('source');
    source.src = url;
    newPlayer.appendChild(source);
    oldPlayer.parentNode.replaceChild(newPlayer, oldPlayer);
    // 重新绑定全局引用与事件
    player = newPlayer;
    player.addEventListener('timeupdate', update);
    player.addEventListener('seeked', update);
    seekWarned = false;  // 新媒体重新探测 seek 能力
  }
  if (waveformEditor) waveformEditor.attachPlayer(player);
  syncPlayerPlaceholder();
  // 部分浏览器会在 load() 完成前暂时不给 currentSrc；文件既已由用户选定，立即恢复彩色波形。
  waveformEditor?.setMediaAvailable(true);

  // 释放旧 blob URL（不会影响 file:// 加载的原始媒体——那不是 blob URL）
  if (currentMediaBlobUrl) URL.revokeObjectURL(currentMediaBlobUrl);
  currentMediaBlobUrl = url;

  // 更新标题区媒体名 + FILENAME_BASE（用文件名去扩展名作为导出基名）
  const stem = file.name.replace(/\.[^.]+$/, '');
  FILENAME_BASE = stem;
  DATA.media = file.name;
  const mnEl = document.getElementById('media-name');
  if (mnEl) {
    mnEl.textContent = file.name;
    mnEl.title = `点击复制媒体名：${file.name}`;
    mnEl.classList.remove('empty');
    mnEl.onclick = () => copyText(file.name, `已复制媒体名：${file.name}`);
  }

  lastActive = -1;
  flashHint(`已加载媒体：${file.name}`);
  if (waveformEditor) {
    try {
      await waveformEditor.processFile(file);
    } catch (error) {
      flashHint(error.message || String(error));
    }
  }
  updateGapRemoveUi();
}

loadMediaFileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const pendingMediaRequest = pendingProjectMediaSelection;
  if (pendingMediaRequest) {
    pendingMediaRequest.file = file;
    if (!pendingMediaRequest.projectReady) return;
    pendingProjectMediaSelection = null;
  }
  await loadMediaFile(file);
});

loadMediaFileInput.addEventListener('cancel', () => {
  pendingProjectMediaSelection = null;
});

// === 表情包根目录配置 ===
const stickerRootModal = document.getElementById('sticker-root-modal');
const stickerRootInput = document.getElementById('sticker-root-input');
const stickerRootFolderInput = document.getElementById('sticker-root-folder-input');

document.getElementById('sticker-root-btn').addEventListener('click', () => {
  stickerRootInput.value = STICKER_ROOT || '';
  stickerRootModal.classList.add('show');
  setTimeout(() => stickerRootInput.focus(), 50);
});
document.getElementById('sticker-root-cancel').addEventListener('click', () => stickerRootModal.classList.remove('show'));
stickerRootModal.addEventListener('click', (e) => { if (e.target === stickerRootModal) stickerRootModal.classList.remove('show'); });

// 「📁 浏览…」按钮：调用 webkitdirectory 选本地文件夹
// 浏览器拿不到绝对路径，所以用 blob URL 替换 STICKERS 数组
document.getElementById('sticker-root-pick').addEventListener('click', () => {
  stickerRootFolderInput.value = '';
  stickerRootFolderInput.click();
});
stickerRootFolderInput.addEventListener('change', (e) => {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  // 只保留图片文件
  const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
  const imgs = files.filter(f => IMG_EXT.test(f.name));
  if (!imgs.length) {
    flashHint('选中的文件夹里没有图片文件');
    return;
  }
  // 释放旧 STICKERS 的 blob URL（如果有）
  STICKERS.forEach(s => {
    if (s._blobUrl) { try { URL.revokeObjectURL(s._blobUrl); } catch (e) {} }
  });
  STICKERS.length = 0;
  // 取顶层目录名作为提示性 STICKER_ROOT；浏览器本地加载拿不到真实磁盘路径。
  const firstRel = imgs[0].webkitRelativePath || imgs[0].name;
  const topDir = firstRel.includes('/') ? firstRel.split('/')[0] : '';
  for (const f of imgs) {
    const rel = (f.webkitRelativePath || f.name).split('/').slice(1).join('/') || f.name;
    STICKERS.push({
      name: f.name.replace(/\.[^.]+$/, ''),
      filename: f.name,
      rel: rel,
      _blobUrl: URL.createObjectURL(f),
    });
  }
  // 显示一个虚拟根，仅作 UI 提示；导出 OTIO 仍需要用户填写实际表情包根目录。
  STICKER_ROOT = topDir ? `[本地] ${topDir}` : '[本地]';
  stickerRootInput.value = STICKER_ROOT;
  renderAll();
  flashHint(`已加载 ${STICKERS.length} 张表情包（${topDir || '本地'}）`);
});

document.getElementById('sticker-root-confirm').addEventListener('click', () => {
  const newRoot = stickerRootInput.value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  STICKER_ROOT = newRoot;
  stickerRootModal.classList.remove('show');
  // 重新渲染所有 cue 让 sticker URL 用新根目录拼接
  renderAll();
  flashHint(newRoot ? `根目录已更新` : '已清空根目录');
});

// === 批量替换 ===
const findInput = document.getElementById('find-input');
const replaceInput = document.getElementById('replace-input');
const caseSensitiveCb = document.getElementById('case-sensitive');
const useRegexCb = document.getElementById('use-regex');
const replacePreview = document.getElementById('replace-preview');
const replaceScopeInfo = document.getElementById('replace-scope-info');
const replaceModalTitle = document.getElementById('replace-modal-title');

// null = 全部；[idxs] = 仅这些行
let replaceScope = null;

function getReplaceTargets() {
  if (replaceScope && replaceScope.length) {
    return replaceScope.map(i => DATA.segments[i]).filter(Boolean);
  }
  return DATA.segments;
}

function buildReplaceRegex() {
  const find = findInput.value;
  if (!find) return null;
  const flags = (caseSensitiveCb.checked ? '' : 'i') + 'g';
  if (useRegexCb.checked) {
    try { return new RegExp(find, flags); } catch (e) { return { error: e.message }; }
  } else {
    return new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  }
}

function updatePreview() {
  const find = findInput.value;
  replacePreview.replaceChildren();
  if (!find) {
    replacePreview.textContent = '输入查找内容查看预览';
    replacePreview.style.color = '#888';
    return;
  }
  const targetIndexes = replaceScope && replaceScope.length
    ? replaceScope : DATA.segments.map((_, index) => index);
  const result = window.AsrEditorUtils.buildReplacementPreview(
    DATA.segments,
    targetIndexes,
    find,
    replaceInput.value,
    { caseSensitive: caseSensitiveCb.checked, useRegex: useRegexCb.checked },
  );
  if (result.error) {
    replacePreview.textContent = `正则错误: ${result.error}`;
    replacePreview.style.color = '#ffaaaa';
    return;
  }
  replacePreview.style.color = result.matchCount ? '#9ed4a4' : '#888';
  const summary = document.createElement('div');
  summary.className = 'replace-preview-summary';
  summary.textContent = result.matchCount
    ? `将在 ${result.lineCount} 行中替换 ${result.matchCount} 处匹配（展开查看前后文本）`
    : '没有匹配';
  replacePreview.appendChild(summary);
  result.rows.forEach((row) => {
    const details = document.createElement('details');
    details.className = 'replace-preview-row';
    const title = document.createElement('summary');
    title.textContent = `第 ${row.index + 1} 条 · ${row.matchCount} 处`;
    details.appendChild(title);
    const before = document.createElement('div');
    before.className = 'replace-preview-before';
    before.textContent = `替换前：${row.before}`;
    const after = document.createElement('div');
    after.className = 'replace-preview-after';
    after.textContent = `替换后：${row.after}`;
    details.append(before, after);
    replacePreview.appendChild(details);
  });
}

function refreshScopeInfo() {
  if (replaceScope && replaceScope.length) {
    replaceModalTitle.textContent = `批量替换（仅 ${replaceScope.length} 条选中）`;
    replaceScopeInfo.textContent = `范围限定为已选中的 ${replaceScope.length} 条字幕`;
    replaceScopeInfo.style.color = '#d4a04a';
  } else {
    replaceModalTitle.textContent = '批量替换';
    replaceScopeInfo.textContent = `范围：全部 ${DATA.segments.length} 条字幕`;
    replaceScopeInfo.style.color = '#888';
  }
}

[findInput, replaceInput].forEach(el => el.addEventListener('input', updatePreview));
[caseSensitiveCb, useRegexCb].forEach(el => el.addEventListener('change', updatePreview));

function openReplaceModal(scope) {
  if (editingState) finishEdit(true);
  replaceScope = scope || null;
  refreshScopeInfo();
  replaceModal.classList.add('show');
  setTimeout(() => findInput.focus(), 50);
  updatePreview();
}

document.getElementById('replace-btn').addEventListener('click', () => openReplaceModal(null));
document.getElementById('replace-cancel').addEventListener('click', () => replaceModal.classList.remove('show'));
replaceModal.addEventListener('click', (e) => { if (e.target === replaceModal) replaceModal.classList.remove('show'); });
document.getElementById('replace-confirm').addEventListener('click', () => {
  const re = buildReplaceRegex();
  if (!re || re.error) return;
  const repl = replaceInput.value;
  // 先 dry-run 确认是否真的会改动，避免空操作压栈
  let willChange = 0;
  getReplaceTargets().forEach(s => {
    re.lastIndex = 0;
    if (s.text.replace(re, repl) !== s.text) willChange++;
  });
  if (willChange === 0) {
    replaceModal.classList.remove('show');
    flashHint('没有匹配的内容');
    return;
  }
  pushUndo('批量替换');
  let changedRows = 0;
  getReplaceTargets().forEach(s => {
    re.lastIndex = 0;
    const newText = s.text.replace(re, repl);
    if (newText !== s.text) { s.text = newText; s._dirty = true; changedRows++; }
  });
  replaceModal.classList.remove('show');
  renderAll();
  flashHint(`已修改 ${changedRows} 行`);
});

// === 表情包 ===
let stickerTargetMode = null;  // 'single' | 'multi'
let stickerTargetIdxs = [];     // 要分配的 segment indexes

function openStickerPicker(idxs, isMulti) {
  if (!STICKERS.length) {
    flashHint('没有可用的表情包，请用 --stickers 参数指定文件夹');
    return;
  }
  stickerTargetMode = isMulti ? 'multi' : 'single';
  stickerTargetIdxs = idxs;
  document.getElementById('sticker-modal-title').textContent =
    isMulti ? `分配表情包到 ${idxs.length} 条字幕（跨时间）` : `分配表情包到第 ${idxs[0] + 1} 条`;
  renderStickerGrid('');
  document.getElementById('sticker-filter').value = '';
  stickerModal.classList.add('show');
  setTimeout(() => document.getElementById('sticker-filter').focus(), 50);
}

function renderStickerGrid(filter) {
  const grid = document.getElementById('sticker-grid');
  grid.innerHTML = '';
  const f = filter.trim().toLowerCase();
  STICKERS.forEach((s, i) => {
    const it = document.createElement('div');
    it.className = 'sticker-item';
    if (f && !s.name.toLowerCase().includes(f) && !s.filename.toLowerCase().includes(f)) {
      it.classList.add('hidden');
    }
    const img = document.createElement('img');
    img.src = stickerUrl(s); img.alt = s.name;
    const nameEl = document.createElement('div');
    nameEl.className = 'sname'; nameEl.textContent = s.name;
    it.appendChild(img); it.appendChild(nameEl);
    it.addEventListener('click', () => assignSticker(s));
    grid.appendChild(it);
  });
}

function assignSticker(sticker) {
  pushUndo('分配表情包');
  if (stickerTargetMode === 'multi' && stickerTargetIdxs.length > 1) {
    const sorted = [...stickerTargetIdxs].sort((a, b) => a - b);
    const start = DATA.segments[sorted[0]].start;
    const end = DATA.segments[sorted[sorted.length - 1]].end;
    const headIdx = sorted[0];
    // 头条：完整 sticker，时间跨整个范围
    DATA.segments[headIdx].sticker = { ...sticker, start, end };
    DATA.segments[headIdx].sticker_ref = null;
    // 后续条：sticker_ref 标记，便于显示和导航
    for (let i = 1; i < sorted.length; i++) {
      DATA.segments[sorted[i]].sticker = null;
      DATA.segments[sorted[i]].sticker_ref = { name: sticker.name, headIdx };
    }
  } else {
    const idx = stickerTargetIdxs[0];
    // 如果当前条已经是 head（被其他 ref 引用），同步更新所有引用 idx 的 ref.name
    DATA.segments.forEach(s => {
      if (s.sticker_ref && s.sticker_ref.headIdx === idx) {
        s.sticker_ref.name = sticker.name;
      }
    });
    DATA.segments[idx].sticker = { ...sticker };
    DATA.segments[idx].sticker_ref = null;
  }
  stickerModal.classList.remove('show');
  renderAll();
  flashHint(`已分配「${sticker.name}」`);
}

function clearStickerOnTargets() {
  pushUndo('清除表情包');
  // 一次性切除所有目标 idx，触发组拆分
  splitGroupsAtCutPoints(new Set(stickerTargetIdxs), 'sticker', 'sticker_ref');
  stickerModal.classList.remove('show');
  renderAll();
  flashHint('已清除');
}

document.getElementById('sticker-filter').addEventListener('input', (e) => {
  renderStickerGrid(e.target.value);
});
document.getElementById('sticker-cancel').addEventListener('click', () => stickerModal.classList.remove('show'));
document.getElementById('sticker-clear').addEventListener('click', clearStickerOnTargets);
stickerModal.addEventListener('click', (e) => { if (e.target === stickerModal) stickerModal.classList.remove('show'); });

// 表情包预览 modal
let previewIdx = -1;
function openStickerPreview(idx) {
  const seg = DATA.segments[idx];
  if (!seg.sticker) return;
  previewIdx = idx;
  document.getElementById('sticker-preview-img').src = stickerUrl(seg.sticker);
  document.getElementById('sticker-preview-name').textContent = seg.sticker.name;
  stickerPreviewModal.classList.add('show');
}
document.getElementById('sticker-preview-close').addEventListener('click', () => stickerPreviewModal.classList.remove('show'));
stickerPreviewModal.addEventListener('click', (e) => { if (e.target === stickerPreviewModal) stickerPreviewModal.classList.remove('show'); });
document.getElementById('sticker-preview-delete').addEventListener('click', () => {
  if (previewIdx < 0) return;
  // 如果删除的是 head，要把所有引用它的 sticker_ref 也清掉
  removeStickerCascade(previewIdx);
  stickerPreviewModal.classList.remove('show');
  renderAll();
  flashHint('已删除');
});

// 删除表情包时级联清理引用：
// - 如果 idx 是 head，清掉所有 headIdx===idx 的 sticker_ref
// - 如果 idx 是 ref，仅清自己（不影响 head）
function removeStickerCascade(idx) {
  pushUndo('删除表情包');
  // 走组拆分：被切除的 idx 后面的同 group ref 自动晋升新 head
  splitGroupsAtCutPoints(new Set([idx]), 'sticker', 'sticker_ref');
}
document.getElementById('sticker-preview-replace').addEventListener('click', () => {
  if (previewIdx < 0) return;
  stickerPreviewModal.classList.remove('show');
  openStickerPicker([previewIdx], false);
});

// 拓展表情包时间到多选范围
// 选中范围内可以包含 sticker（head）或 sticker_ref（引用），都视作"已有表情包"
function expandStickerTime(idxs) {
  const sorted = [...idxs].sort((a, b) => a - b);
  // 找选中范围内的 sticker：优先取 head；如果只有 ref，从 ref 回溯到原 head
  let sourceSticker = null;
  for (const i of sorted) {
    if (DATA.segments[i].sticker) {
      sourceSticker = DATA.segments[i].sticker;
      break;
    }
  }
  if (!sourceSticker) {
    for (const i of sorted) {
      const ref = DATA.segments[i].sticker_ref;
      if (ref && DATA.segments[ref.headIdx]?.sticker) {
        sourceSticker = DATA.segments[ref.headIdx].sticker;
        break;
      }
    }
  }
  if (!sourceSticker) {
    flashHint('选中范围内没有表情包');
    return;
  }
  pushUndo('拓展表情包时长');
  const sticker = { ...sourceSticker };
  sticker.start = DATA.segments[sorted[0]].start;
  sticker.end = DATA.segments[sorted[sorted.length - 1]].end;
  // 清除范围内所有 sticker / sticker_ref
  sorted.forEach(i => {
    DATA.segments[i].sticker = null;
    DATA.segments[i].sticker_ref = null;
  });
  // head：放完整 sticker；后续：放 sticker_ref
  const headIdx = sorted[0];
  DATA.segments[headIdx].sticker = sticker;
  for (let k = 1; k < sorted.length; k++) {
    DATA.segments[sorted[k]].sticker_ref = { name: sticker.name, headIdx };
  }
  renderAll();
  flashHint(`已拓展到 ${sorted.length} 条`);
}

// === 标记颜色 ===
// 数据结构与表情包同构：head 持完整 color，后续条持 color_ref（仅 name + headIdx）
// 单选 → 设为 head；多选 → 第一条为 head，时间跨整个范围，后续为 ref
function assignColor(idxs, colorName) {
  if (!idxs.length) return;
  const def = COLOR_BY_NAME[colorName];
  if (!def) return;
  pushUndo('标记颜色');
  const sorted = [...idxs].sort((a, b) => a - b);
  if (sorted.length === 1) {
    const idx = sorted[0];
    // 如果当前条已经是 head，同步更新所有引用 idx 的 ref.name
    DATA.segments.forEach(s => {
      if (s.color_ref && s.color_ref.headIdx === idx) {
        s.color_ref.name = colorName;
      }
    });
    DATA.segments[idx].color = {
      name: colorName, value: def.value,
      start: DATA.segments[idx].start, end: DATA.segments[idx].end,
    };
    DATA.segments[idx].color_ref = null;
  } else {
    const headIdx = sorted[0];
    const start = DATA.segments[headIdx].start;
    const end = DATA.segments[sorted[sorted.length - 1]].end;
    DATA.segments[headIdx].color = { name: colorName, value: def.value, start, end };
    DATA.segments[headIdx].color_ref = null;
    for (let k = 1; k < sorted.length; k++) {
      DATA.segments[sorted[k]].color = null;
      DATA.segments[sorted[k]].color_ref = { name: colorName, headIdx };
    }
  }
  renderAll();
  flashHint(`已标记「${def.label}」`);
}

// 删除颜色（级联清理）：
//   - idx 是 head: 清自己 + 所有 headIdx===idx 的 ref
//   - idx 是 ref: 仅清自己
function removeColorCascade(idx) {
  // 走组拆分：被切除的 idx 后面的同 group ref 自动晋升新 head
  splitGroupsAtCutPoints(new Set([idx]), 'color', 'color_ref');
}

function clearColorOnTargets(idxs) {
  pushUndo('清除颜色');
  // 一次性切除所有目标 idx，触发组拆分
  splitGroupsAtCutPoints(new Set(idxs), 'color', 'color_ref');
  renderAll();
  flashHint('已清除颜色');
}

// === 禁用/启用 ===
// 统一切换语义：目标全部禁用 → 全部启用；否则全部禁用
// 单条时即"切换这一条的状态"（Alt+点击 / 右键菜单均走这里）
function toggleDisabled(idxs) {
  if (!idxs.length) return;
  pushUndo('切换禁用');
  const allDisabled = idxs.every(i => DATA.segments[i]?.disabled);
  idxs.forEach(i => { if (DATA.segments[i]) DATA.segments[i].disabled = !allDisabled; });
  renderAll();
  // 隐藏开关开启时，刚禁用的项需从选中集移除（保持状态一致）
  if (hideDisabled && !allDisabled) {
    [...selectedIdxs].forEach(i => {
      if (DATA.segments[i]?.disabled) {
        selectedIdxs.delete(i);
        const el = container.querySelector(`.cue[data-idx="${i}"]`);
        if (el) el.classList.remove('selected');
      }
    });
    selCountEl.textContent = String(selectedIdxs.size);
  }
  flashHint(allDisabled ? `已启用 ${idxs.length} 条` : `已禁用 ${idxs.length} 条`);
}

// === 从波形空白处新增字幕 ===
function addCueRangeFromWaveform(requestedStart, requestedEnd, clickX, clickY) {
  const duration = waveformEditor?.durationMs || (Number.isFinite(player.duration) ? player.duration * 1000 : 0);
  if (!duration) { flashHint('媒体时长尚未加载'); return; }
  const start = Math.min(requestedStart, requestedEnd);
  const end = Math.max(requestedStart, requestedEnd);
  const insertAt = DATA.segments.findIndex((segment) => segment.start > start);
  const index = insertAt < 0 ? DATA.segments.length : insertAt;
  const previousEnd = index > 0 ? DATA.segments[index - 1].end : 0;
  const nextStart = index < DATA.segments.length ? DATA.segments[index].start : duration;
  const safeStart = Math.max(previousEnd, Math.min(duration, Math.round(start / 10) * 10));
  const safeEnd = Math.min(nextStart, Math.max(safeStart, Math.round(end / 10) * 10));
  if (safeEnd - safeStart < 100) {
    flashHint('该空白区域不足 100ms，无法新增字幕');
    return;
  }
  pushUndo('新增字幕');
  DATA.segments.splice(index, 0, {
    start: safeStart,
    end: safeEnd,
    text: '',
    items: [],
    _dirty: true,
  });
  clearSelection();
  renderAll();
  selectOnly(index);
  const cue = container.querySelector(`.cue[data-idx="${index}"]`);
  if (cue) {
    scrollCueToCenter(cue);
    setTimeout(() => startEdit(cue, index, clickX, clickY), 0);
  }
  waveformEditor?.revealTime(safeStart, true);
  flashHint(`已新增第 ${index + 1} 条字幕`);
}

function addCueAtWaveformTime(timeMs, clickX, clickY) {
  const duration = waveformEditor?.durationMs || (Number.isFinite(player.duration) ? player.duration * 1000 : 0);
  if (!duration) { flashHint('媒体时长尚未加载'); return; }
  const insertAt = DATA.segments.findIndex((segment) => segment.start > timeMs);
  const index = insertAt < 0 ? DATA.segments.length : insertAt;
  const previousEnd = index > 0 ? DATA.segments[index - 1].end : 0;
  const nextStart = index < DATA.segments.length ? DATA.segments[index].start : duration;
  if (timeMs < previousEnd) {
    flashHint('当前位置已有字幕，请使用“按音频位置拆分当前字幕”');
    return;
  }
  const gap = nextStart - previousEnd;
  if (gap < 100) {
    flashHint('这里没有足够的空白区域');
    return;
  }
  const start = Math.max(previousEnd, Math.min(Math.round(timeMs / 10) * 10, nextStart - 100));
  const end = Math.min(nextStart, start + 1000);
  const adjustedStart = end - start >= 100 ? start : Math.max(previousEnd, nextStart - 1000);
  addCueRangeFromWaveform(adjustedStart, end, clickX, clickY);
}

// 右键波形背景：创建字幕，或按右键对应的音频位置拆分命中的字幕。
function showWaveformBlankMenu(timeMs, clickX, clickY) {
  ctxmenu.innerHTML = '';
  function addItem(label, fn, disabled = false) {
    const it = document.createElement('div');
    it.className = `item${disabled ? ' disabled' : ''}`;
    const lbl = document.createElement('span'); lbl.textContent = label;
    it.appendChild(lbl);
    const kb = document.createElement('kbd'); kb.style.visibility = 'hidden';
    it.appendChild(kb);
    if (!disabled) {
      it.addEventListener('click', () => { ctxmenu.classList.remove('show'); fn(); });
    }
    ctxmenu.appendChild(it);
  }
  const splitIdx = DATA.segments.findIndex((segment) => (
    timeMs > segment.start && timeMs < segment.end
  ));
  addItem('创建字幕', () => addCueAtWaveformTime(timeMs, clickX, clickY));
  addItem(
    '按音频位置拆分当前字幕',
    () => splitFromContextMenu(splitIdx, clickX, clickY, timeMs),
    splitIdx < 0,
  );

  ctxmenu.classList.add('show');
  const rect = ctxmenu.getBoundingClientRect();
  let nx = clickX, ny = clickY;
  if (clickX + rect.width > window.innerWidth) nx = window.innerWidth - rect.width - 4;
  if (clickY + rect.height > window.innerHeight) ny = window.innerHeight - rect.height - 4;
  ctxmenu.style.left = nx + 'px';
  ctxmenu.style.top = ny + 'px';
}

// === 右键菜单 ===
let ctxLastClickX = 0, ctxLastClickY = 0;
function showContextMenu(x, y, idx, waveformTimeMs = null) {
  ctxLastClickX = x; ctxLastClickY = y;
  ctxmenu.innerHTML = '';
  // 当前条不在选中里 → 立刻选中（但不改变多选）
  const isMulti = selectedIdxs.size > 1 && selectedIdxs.has(idx);
  if (!isMulti && (!selectedIdxs.has(idx) || selectedIdxs.size !== 1)) {
    selectOnly(idx);
    lastClickedIdx = idx;
  }
  const targetIdxs = isMulti ? [...selectedIdxs] : [idx];

  function addItem(label, kbd, fn, opts = {}) {
    const it = document.createElement('div');
    it.className = 'item' + (opts.danger ? ' danger' : '') + (opts.disabled ? ' disabled' : '');
    const lbl = document.createElement('span'); lbl.textContent = label;
    const kb = document.createElement('kbd'); kb.textContent = kbd || '';
    if (!kbd) kb.style.visibility = 'hidden';
    it.appendChild(lbl); it.appendChild(kb);
    if (!opts.disabled) it.addEventListener('click', () => { ctxmenu.classList.remove('show'); fn(); });
    ctxmenu.appendChild(it);
  }
  function addSep() {
    const s = document.createElement('div'); s.className = 'sep'; ctxmenu.appendChild(s);
  }

  // 颜色子菜单：一行 5 色块 + "清除颜色"项
  // targets 来自外层闭包；但参数化以保持函数纯粹
  function addColorSubmenu(targets) {
    const row = document.createElement('div');
    row.className = 'item';
    row.style.cursor = 'default';
    row.addEventListener('click', e => e.stopPropagation());
    const lbl = document.createElement('span');
    lbl.textContent = '标记颜色';
    lbl.style.flex = '0 0 auto';
    row.appendChild(lbl);
    const swatches = document.createElement('span');
    swatches.style.cssText = 'display:flex;gap:4px;align-items:center;margin-left:auto;';
    COLOR_PALETTE.forEach(c => {
      const sw = document.createElement('span');
      sw.title = c.label;
      sw.style.cssText = `width:14px;height:14px;border-radius:50%;background:${c.value};border:1px solid #555;cursor:pointer;display:inline-block;`;
      sw.addEventListener('mouseenter', () => sw.style.transform = 'scale(1.2)');
      sw.addEventListener('mouseleave', () => sw.style.transform = '');
      sw.addEventListener('click', (e) => {
        e.stopPropagation();
        ctxmenu.classList.remove('show');
        assignColor(targets, c.name);
      });
      swatches.appendChild(sw);
    });
    row.appendChild(swatches);
    ctxmenu.appendChild(row);
    // 「清除颜色」项：仅当选中范围内有颜色时显示
    const hasColorInRange = targets.some(i =>
      DATA.segments[i].color || DATA.segments[i].color_ref);
    if (hasColorInRange) {
      addItem('清除颜色', '', () => clearColorOnTargets(targets), { danger: true });
    }
  }

  if (!isMulti) {
    const splitLabel = Number.isFinite(waveformTimeMs)
      ? '按音频位置拆分'
      : '按文字位置拆分';
    addItem(splitLabel, 'Ctrl+Enter', () => splitFromContextMenu(idx, x, y, waveformTimeMs));
    addSep();
    addItem('分配表情包…', '', () => openStickerPicker([idx], false));
    if (DATA.segments[idx].sticker || DATA.segments[idx].sticker_ref) {
      addItem('删除表情包', '', () => {
        removeStickerCascade(idx);
        renderAll();
        flashHint('已删除');
      }, { danger: true });
    }
    addSep();
    addColorSubmenu(targetIdxs);
    addSep();
    addItem(
      DATA.segments[idx].disabled ? '启用此条' : '禁用此条',
      'Alt+点击',
      () => toggleDisabled([idx])
    );
    addSep();
    addItem('删除字幕', '', () => {
      if (!confirm(`确定删除第 ${idx + 1} 条字幕？`)) return;
      deleteSegments([idx]);
    }, { danger: true });
  } else {
    addItem(`合并 ${targetIdxs.length} 条字幕`, '', () => mergeSegments(targetIdxs));
    addSep();
    // 只在选中范围内存在表情包时才显示「拓展表情包时长」，且放在「统一分配」前面
    const hasStickerInRange = targetIdxs.some(i =>
      DATA.segments[i].sticker || DATA.segments[i].sticker_ref);
    if (hasStickerInRange) {
      addItem('拓展表情包时长', '', () => expandStickerTime(targetIdxs));
    }
    addItem('统一分配表情包…', '', () => openStickerPicker(targetIdxs, true));
    addSep();
    addColorSubmenu(targetIdxs);
    addSep();
    addItem('批量替换选中字幕…', '', () => openReplaceModal(targetIdxs));
    addSep();
    const _disabledInSel = targetIdxs.filter(i => DATA.segments[i].disabled).length;
    addItem(
      _disabledInSel === targetIdxs.length ? '启用选中' : '禁用选中',
      '',
      () => toggleDisabled(targetIdxs)
    );
    addSep();
    addItem(`删除 ${targetIdxs.length} 条字幕`, '', () => {
      if (!confirm(`确定删除选中的 ${targetIdxs.length} 条字幕？`)) return;
      deleteSegments(targetIdxs);
    }, { danger: true });
    addItem('清除所有选中', '', () => clearSelection());
  }

  // 调整 ctxmenu 位置（避免溢出）
  ctxmenu.classList.add('show');
  const rect = ctxmenu.getBoundingClientRect();
  let nx = x, ny = y;
  if (x + rect.width > window.innerWidth) nx = window.innerWidth - rect.width - 4;
  if (y + rect.height > window.innerHeight) ny = window.innerHeight - rect.height - 4;
  ctxmenu.style.left = nx + 'px';
  ctxmenu.style.top = ny + 'px';
}

document.addEventListener('click', (e) => {
  if (!ctxmenu.contains(e.target)) ctxmenu.classList.remove('show');
});
document.addEventListener('contextmenu', (e) => {
  // 非 cue 上的右键关闭菜单
  if (!e.target.closest('.cue') && !e.target.closest('.waveform-cue-block')) {
    ctxmenu.classList.remove('show');
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && ctxmenu.classList.contains('show')) {
    ctxmenu.classList.remove('show');
  }
});

// === Hint ===
let hintTimer = null;
function flashHint(msg) {
  let el = document.getElementById('hint');
  if (!el) {
    el = document.createElement('div'); el.id = 'hint';
    el.style.cssText = 'position:fixed;top:20px;right:20px;background:#3a4a5a;color:#cce0ff;padding:8px 12px;border-radius:4px;border:1px solid #4a6080;z-index:300;font-size:13px;';
    document.body.appendChild(el);
  }
  el.textContent = msg; el.style.display = 'block';
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { el.style.display = 'none'; }, 1800);
}

// 振幅到达上下限时由波形模块派发的事件：rAF 节流后仍可能每帧触发，冷却避免提示闪烁
let lastScaleLimitMsg = '';
let lastScaleLimitAt = 0;
document.addEventListener('asr:waveform-scale-limit', (event) => {
  const { atMin, atMax } = event.detail || {};
  const msg = atMin ? '已经到达最小振幅' : atMax ? '已经达到最大振幅' : '';
  if (!msg) return;
  const now = Date.now();
  if (msg === lastScaleLimitMsg && now - lastScaleLimitAt < 1200) return;
  lastScaleLimitMsg = msg;
  lastScaleLimitAt = now;
  flashHint(msg);
});

// === cleanPunctuation ===
function cleanPunctuation() {
  const PUNCT_REPL = '  ';
  const REPLACE_INSIDE = /[，。]/g;
  for (const seg of DATA.segments) {
    if (!seg.text) continue;
    let t = seg.text;
    while (t.length && (t.endsWith('，') || t.endsWith('。'))) t = t.slice(0, -1);
    seg.text = t.replace(REPLACE_INSIDE, PUNCT_REPL).replace(/[ \t]+$/, '');
    if (seg.items) {
      const total = seg.items.length;
      for (let i = 0; i < total; i++) {
        let it = seg.items[i].text;
        if (i === total - 1) {
          while (it.length && (it.endsWith('，') || it.endsWith('。'))) it = it.slice(0, -1);
        }
        it = it.replace(REPLACE_INSIDE, PUNCT_REPL);
        seg.items[i].text = it;
      }
    }
  }
}

function syncTimelineGroupRanges() {
  function sync(headField, refField) {
    DATA.segments.forEach((segment, headIdx) => {
      const head = segment[headField];
      if (!head) return;
      let end = segment.end;
      DATA.segments.forEach((candidate) => {
        if (candidate[refField]?.headIdx === headIdx) end = Math.max(end, candidate.end);
      });
      head.start = segment.start;
      head.end = end;
    });
  }
  sync('sticker', 'sticker_ref');
  sync('color', 'color_ref');
}

function seekFromWaveform(timeSec) {
  const seekableEnd = player.seekable.length ? player.seekable.end(player.seekable.length - 1) : 0;
  if (seekableEnd <= 0 && !seekWarned) {
    seekWarned = true;
    flashHint('媒体尚不可 seek；请等待加载完成或用 file:// 直接打开 HTML');
  }
  try {
    player.currentTime = Math.max(0, timeSec);
    update();
  } catch (error) {
    flashHint(`跳转失败：${error.message}`);
  }
}

function initWaveformEditor() {
  if (!window.AsrWaveform) {
    flashHint('波形模块加载失败，字幕编辑仍可使用');
    return;
  }
  waveformEditor = window.AsrWaveform.create({
    getSegments: () => DATA.segments,
    getSelection: () => selectedIdxs,
    selectCue: (idx) => {
      selectCueByClick(idx);
      lastClickedIdx = idx;
      const cue = container.querySelector(`.cue[data-idx="${idx}"]`);
      if (cue) scrollCueIntoViewIfNeeded(cue);
    },
    clearSelection: () => clearSelection(),
    toggleCueSelection: (idx) => {
      toggleSel(idx);
      lastClickedIdx = idx;
    },
    selectCueRange: (idx) => {
      if (lastClickedIdx >= 0) selectRange(lastClickedIdx, idx);
      else selectOnly(idx);
      lastClickedIdx = idx;
    },
    seek: seekFromWaveform,
    togglePlayback,
    toggleDisabled: (idxs) => toggleDisabled(idxs),
    getHideDisabled: () => hideDisabled,
    getGapRemoveGaps,
    getGapOperationMode: getGapRemoveOperationMode,
    toggleGapRemoved,
    applyGapRange: applyManualGapRange,
    resizeGapBoundary: resizeManualGapBoundary,
    previewGapAt,
    showContextMenu: (x, y, idx, timeMs) => showContextMenu(x, y, idx, timeMs),
    showBlankWaveformMenu: (timeMs, x, y) => showWaveformBlankMenu(timeMs, x, y),
    addCueRange: (startMs, endMs, x, y) => addCueRangeFromWaveform(startMs, endMs, x, y),
    // 剃刀工具：在波形指针位置安全拆分字幕。复用右键菜单的波形时间拆分路径，
    // 它会先用 splitCharOffsetAtTime 把指针时间映射到最近的字/词级边界，再
    // 走 splitAtCursor；这样剃刀与右键拆分行为一致，且保留 items 时间码精度。
    splitCueAtTime: (idx, timeMs) => splitFromContextMenu(idx, 0, 0, timeMs),
    getClickBehavior: () => EDITOR_SETTINGS.clickBehavior,
    onBeginEdit: (label) => pushUndo(label),
    onLayoutUndo: (label, snapshot) => pushLayoutUndo(label, snapshot),
    onCommitEdit: (idxs, kind) => {
      syncTimelineGroupRanges();
      renderAll();
      update();
      flashHint(kind === 'move'
        ? `已移动 ${idxs.length} 条字幕`
        : kind === 'resize-boundary'
          ? `已联动调整第 ${idxs[0] + 1} / ${idxs[1] + 1} 条边界`
          : kind === 'resize-boundary-independent'
            ? `已独立调整第 ${idxs[0] + 1} 条字幕边界`
            : `已调整第 ${idxs[0] + 1} 条字幕时间`);
    },
    onPayload: (payload) => { DATA.waveform = payload; },
  });
  waveformEditor.attachPlayer(player);
  waveformEditor.setLayoutData(DATA.layout || null);
  waveformEditor.setPayload(DATA.waveform || null);
}

// === Drag & Drop：拖入视频/音频/JSON 自动加载 ===
const dragOverlay = document.getElementById('drag-overlay');
function isJsonFile(f) {
  return f.type === 'application/json' || f.name.toLowerCase().endsWith('.json');
}
async function handleDroppedFiles(files) {
  if (!files.length) return;
  const mediaFile = files.find(isMediaFile);
  const jsonFile = files.find(isJsonFile);
  if (!mediaFile && !jsonFile) {
    flashHint('不支持的文件类型（仅支持视频 / 音频 / JSON）');
    return;
  }
  // JSON 工程会重置 DATA，先检查未保存改动（与「打开工程」按钮一致）
  if (jsonFile && hasUnsavedProjectChanges()) {
    if (!confirm('当前有未保存的改动，是否确定加载新工程？将丢失未保存内容。')) return;
  }
  if (jsonFile) {
    await openProjectFile(jsonFile, mediaFile ? [mediaFile] : []);
    return;
  }
  await loadMediaFile(mediaFile);
}
let dragCounter = 0;  // dragenter/leave 计数，避免子元素进出导致遮罩闪烁
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer || !e.dataTransfer.types.includes('Files')) return;
  e.preventDefault();
  dragCounter++;
  if (dragCounter === 1) dragOverlay.classList.add('show');
});
window.addEventListener('dragover', (e) => {
  if (e.dataTransfer && e.dataTransfer.types.includes('Files')) e.preventDefault();
});
window.addEventListener('dragleave', (e) => {
  if (!e.dataTransfer) return;
  dragCounter--;
  if (dragCounter <= 0) { dragCounter = 0; dragOverlay.classList.remove('show'); }
});
window.addEventListener('drop', (e) => {
  if (!e.dataTransfer || !e.dataTransfer.types.includes('Files')) return;
  e.preventDefault();
  dragCounter = 0;
  dragOverlay.classList.remove('show');
  void handleDroppedFiles(Array.from(e.dataTransfer.files));
});

// === 启动 ===
cleanPunctuation();
configureServerSaveControls();
configureRecentProjects();
configureServerProjectSettings();
initWaveformEditor();
totalCountEl.textContent = DATA.segments.length;
renderAll();
updateGapRemoveUi();
if (SERVER_CONFIG?.autoLoadedMediaName) {
  flashHint(`已自动加载媒体：${SERVER_CONFIG.autoLoadedMediaName}`);
}

document.getElementById('charcount-threshold').addEventListener('input', () => {
  refreshAllCharCounts();
  // 如果"仅看超长"开着，阈值变化要重新过滤
  if (document.getElementById('filter-over').classList.contains('active')) {
    applySearch(searchEl.value);
  }
});

document.getElementById('filter-over').addEventListener('click', (e) => {
  e.currentTarget.classList.toggle('active');
  applySearch(searchEl.value);
});

// 「隐藏禁用项」开关：开启后禁用项 display:none，并从选中集移除
hideDisabledToggle.addEventListener('change', () => {
  hideDisabled = hideDisabledToggle.checked;
  container.classList.toggle('hide-disabled', hideDisabled);
  if (hideDisabled) {
    // 清理选中集中的禁用项（隐藏了但还留在 selectedIdxs 会造成状态不一致）
    [...selectedIdxs].forEach(i => {
      if (DATA.segments[i]?.disabled) {
        selectedIdxs.delete(i);
        const el = container.querySelector(`.cue[data-idx="${i}"]`);
        if (el) el.classList.remove('selected');
      }
    });
    selCountEl.textContent = String(selectedIdxs.size);
    if (waveformEditor) waveformEditor.updateSelection();
  }
  if (waveformEditor) waveformEditor.updateDisabledVisibility();
});

// 离开提示
window.addEventListener('beforeunload', (e) => {
  if (hasUnsavedProjectChanges()) { e.preventDefault(); e.returnValue = ''; }
});
