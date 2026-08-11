const DATA = __DATA_JSON__;
let FILENAME_BASE = __FILENAME_BASE_JSON__;
const STICKERS = __STICKERS_JSON__;
let STICKER_ROOT = __STICKER_ROOT_JSON__;  // 表情包根目录的绝对路径（无尾斜杠）
let STICKER_URL_PREFIX = __STICKER_URL_PREFIX_JSON__;
const SERVER_CONFIG = __SERVER_CONFIG_JSON__;
const EDITOR_SETTINGS_KEY = 'moy.asr.editor.settings.v1';
const CLICK_BEHAVIOR_VALUES = new Set(['select-only', 'select-and-seek', 'select-and-play']);
const CLICK_TARGET_VALUES = new Set(['cue-start', 'pointer']);
function normalizeClickBehavior(value) {
  return CLICK_BEHAVIOR_VALUES.has(value) ? value : 'select-and-seek';
}
function normalizeClickTarget(value) {
  return CLICK_TARGET_VALUES.has(value) ? value : 'cue-start';
}
const DEFAULT_EDITOR_SETTINGS = {
  splitKey: 'ctrl-enter',
  overlayEnabled: true,
  exportStartAtZero: false,
  cueListShowIndex: true,
  cueListShowTime: true,
  cueListShowSticker: true,
  cueListShowCharcount: true,
  // 字幕列表普通点击是否把目标字幕滚动到列表中央。
  cueListAutoScrollOnClick: true,
  cueEditorShowNavigation: false,
  cueEditorShowTimeActions: false,
  cueEditorShowSticker: false,
  selectGroupMembers: false,
  // 合并字幕时各段文本之间插入的连接符（默认两个空格；留空则直接拼接）。
  mergeJoinText: '',
  // 拼合字幕：相邻间隔不超过该毫秒值时拓展字幕长度拼合（0 表示不处理间隔）。
  autoMergeGapMs: 200,
  // 拼合字幕：backward 向前拓展（默认，后方字幕起点前拓）/ forward 向后拓展（前方字幕终点后延）。
  autoMergeSnapDirection: 'backward',
  // 拼合字幕：中文少于 N 个字 / 英文少于 N 个词的字幕并入相邻字幕。
  autoMergeShortCount: 3,
  // 拼合字幕：是否吸收过短字幕（默认开启；关闭后只拼合间隔）。
  autoMergeAbsorbShort: true,
  // 拼合字幕：previous 向前吸收（默认，并入上一条）/ next 向后吸收（并入下一条）。
  autoMergeAbsorbDirection: 'previous',
  // 按颜色导出 SRT：统一导出先选择一个 SRT 文件名作为前缀。
  exportColorUnified: true,
  // 自动保存仅对绑定工程的 localhost 服务器版生效。
  autoSaveProject: true,
  autoSaveIntervalSeconds: 30,
  // 表情包预览：在视频画面内渲染当前时间的表情包（默认关闭）。
  stickerOverlayEnabled: false,
  // 字幕单击行为：默认选中并跳转；select-and-play 额外在暂停时开始播放。
  clickBehavior: 'select-and-seek',
  // 波形字幕块的跳转目标；字幕列表点击始终跳转到字幕开头。
  clickTarget: 'cue-start',
  // 界面主题：dark（默认）/ light。写入 <html data-theme>，模板 <head> 内联脚本负责首帧预应用。
  theme: 'dark',
};
const SUBTITLE_FONT_SIZE_MIN = 12;
const SUBTITLE_FONT_SIZE_MAX = 96;
const SUBTITLE_FONT_FAMILY_CSS = Object.freeze({
  default: '',
  yahei: '"Microsoft YaHei", "PingFang SC", sans-serif',
  hei: '"SimHei", "Microsoft YaHei", sans-serif',
  song: '"SimSun", "Songti SC", serif',
  sans: 'Arial, "Segoe UI", sans-serif',
});

function readEditorSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(EDITOR_SETTINGS_KEY) || '{}');
    return {
      splitKey: saved.splitKey === 'enter' ? 'enter' : DEFAULT_EDITOR_SETTINGS.splitKey,
      overlayEnabled: saved.overlayEnabled !== false,
      exportStartAtZero: saved.exportStartAtZero === true,
      cueListShowIndex: saved.cueListShowIndex !== false,
      cueListShowTime: saved.cueListShowTime !== false,
      cueListShowSticker: saved.cueListShowSticker !== false,
      cueListShowCharcount: saved.cueListShowCharcount !== false,
      cueListAutoScrollOnClick: saved.cueListAutoScrollOnClick !== false,
      cueEditorShowNavigation: saved.cueEditorShowNavigation === true,
      cueEditorShowTimeActions: saved.cueEditorShowTimeActions === true,
      cueEditorShowSticker: saved.cueEditorShowSticker === true,
      selectGroupMembers: saved.selectGroupMembers === true,
      mergeJoinText: typeof saved.mergeJoinText === 'string' ? saved.mergeJoinText : DEFAULT_EDITOR_SETTINGS.mergeJoinText,
      autoMergeGapMs: clampAutoMergeGapMs(saved.autoMergeGapMs),
      autoMergeSnapDirection: saved.autoMergeSnapDirection === 'forward' ? 'forward' : 'backward',
      autoMergeShortCount: clampAutoMergeShortCount(saved.autoMergeShortCount),
      autoMergeAbsorbShort: saved.autoMergeAbsorbShort !== false,
      autoMergeAbsorbDirection: saved.autoMergeAbsorbDirection === 'next' ? 'next' : 'previous',
      exportColorUnified: saved.exportColorUnified !== false,
      autoSaveProject: saved.autoSaveProject !== false,
      autoSaveIntervalSeconds: clampAutoSaveInterval(saved.autoSaveIntervalSeconds),
      stickerOverlayEnabled: saved.stickerOverlayEnabled === true,
      clickBehavior: normalizeClickBehavior(saved.clickBehavior),
      clickTarget: normalizeClickTarget(saved.clickTarget),
      theme: saved.theme === 'light' ? 'light' : 'dark',
    };
  } catch (_) {
    return { ...DEFAULT_EDITOR_SETTINGS };
  }
}

function clampAutoSaveInterval(value) {
  const seconds = Math.round(Number(value));
  return Math.min(3600, Math.max(5, Number.isFinite(seconds) ? seconds : 30));
}

function clampAutoMergeGapMs(value) {
  const ms = Math.round(Number(value));
  return Math.min(10000, Math.max(0, Number.isFinite(ms) ? ms : DEFAULT_EDITOR_SETTINGS.autoMergeGapMs));
}

function clampAutoMergeShortCount(value) {
  const count = Math.round(Number(value));
  return Math.min(20, Math.max(1, Number.isFinite(count) ? count : DEFAULT_EDITOR_SETTINGS.autoMergeShortCount));
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
  { name: 'yellow', label: '黄', value: '#f1c40f' },
  { name: 'green',  label: '绿', value: '#2ecc71' },
  { name: 'red',    label: '红', value: '#e74c3c' },
  { name: 'purple', label: '紫', value: '#9b59b6' },
  { name: 'blue',   label: '蓝', value: '#168cff' },
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
const DEFAULT_GAP_REMOVE_OPERATION_MODE = 'boundary_drag';
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
let playbackFrameId = 0;
let playbackFramePlayer = null;
// 工程内波形是可直接使用的缓存；加载关联媒体时不要因为媒体签名不同而覆盖它。
// 媒体生成的波形则不属于工程缓存，切换媒体时仍应重新分析。
let waveformLoadedFromProject = false;
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
// 栈深上限 100；新动作清空 redo；Ctrl(Cmd)+Z 撤销、Ctrl(Cmd)+Shift+Z 重做。
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
  editorHistory.push({ kind: 'layout', label: label || '调整工作区', layout: snapshot });
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
  return {
    overlay: !!overlayToggle.checked,
    subtitle: { ...getPreviewGeometry(), ...getSubtitleAppearance() },
    sticker: { ...getStickerGeometry() },
  };
}
function applyPreviewState(state) {
  if (!state || typeof state.overlay !== 'boolean') return;
  overlayToggle.checked = state.overlay;
  updateEditorSettings({ overlayEnabled: state.overlay });
  if (state.subtitle) setPreviewGeometry(state.subtitle, { markDirty: true });
  if (state.sticker) setStickerGeometry(state.sticker, { markDirty: true });
  if (!state.overlay) overlayEl.classList.add('hidden');
  else update();
}
// 按记录 kind 拍下当前状态，作为对端栈的镜像（label 沿用原记录）
function snapshotCurrentForKind(kind, label) {
  if (kind === 'layout') {
    return { kind: 'layout', label: label || '调整工作区', layout: waveformEditor?.getLayoutHistorySnapshot?.() || null };
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
      flashHint('工作区恢复失败：波形模块尚未加载');
      return false;
    }
    DATA.workspace = waveformEditor.getLayoutData();
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
  // 历史恢复会改变下标身份；丢弃旧面板绑定，避免 clearSelection() 把旧面板
  // 内容提交到恢复后占据同一下标的另一条字幕，并因此生成新历史、清空 redo。
  currentCuePanelIdx = -1;
  cuePanelUndoPushed = false;
  clearSelection();
  lastActive = -1;
  renderAll();
  return true;
}
function performUndo() {
  const top = editorHistory.peekUndo();
  if (!top) { flashHint('没有可撤销的操作'); return; }
  if (top.kind === 'layout' && typeof waveformEditor?.restoreLayoutHistorySnapshot !== 'function') {
    flashHint('工作区撤销失败：波形模块尚未加载');
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
    flashHint('工作区重做失败：波形模块尚未加载');
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
const overlayTextEl = overlayEl.querySelector('span:not(.overlay-handle)');
const overlayToggle = document.getElementById('overlay-toggle');
const stickerOverlayToggle = document.getElementById('sticker-overlay-toggle');
const subtitleFontSizeSelect = document.getElementById('subtitle-font-size');
const subtitleFontFamilySelect = document.getElementById('subtitle-font-family');
const playerEmpty = document.getElementById('player-empty');
const playerWrap = document.querySelector('.player-wrap');
const mediaPlayToggle = document.getElementById('media-play-toggle');
const mediaStepBack = document.getElementById('media-step-back');
const mediaStepForward = document.getElementById('media-step-forward');
const mediaCurrentTime = document.getElementById('media-current-time');
const mediaDuration = document.getElementById('media-duration');
const mediaSeek = document.getElementById('media-seek');
const mediaVolume = document.getElementById('media-volume');
const mediaPlaybackRate = document.getElementById('media-playback-rate');
const mediaFullscreen = document.getElementById('media-fullscreen');
// 预览层（字幕/表情包）的定位与几何测量都以 stage 为基准，不含顶部媒体工具栏。
const playerStage = playerWrap?.querySelector('.player-stage') || playerWrap;
const splitKeySel = document.getElementById('split-key');
const mergeJoinTextInput = document.getElementById('merge-join-text');
const cueListShowIndexToggle = document.getElementById('cue-list-show-index');
const cueListShowTimeToggle = document.getElementById('cue-list-show-time');
const cueListShowStickerToggle = document.getElementById('cue-list-show-sticker');
const cueListShowCharcountToggle = document.getElementById('cue-list-show-charcount');
const cueListAutoScrollOnClickToggle = document.getElementById('cue-list-auto-scroll-on-click');
const cueEditorShowNavigationToggle = document.getElementById('cue-editor-show-navigation');
const cueEditorShowTimeActionsToggle = document.getElementById('cue-editor-show-time-actions');
const cueEditorShowStickerToggle = document.getElementById('cue-editor-show-sticker');
const selectGroupMembersToggle = document.getElementById('select-group-members');
const exportColorUnifiedToggle = document.getElementById('export-color-unified');
const helpToggle = document.getElementById('help-toggle');
const themeToggle = document.getElementById('theme-toggle');
const helpPanel = document.getElementById('help-panel');
const helpDragHandle = document.getElementById('help-drag-handle');
const helpCloseButton = document.getElementById('help-close');
const helpSplitKey = document.getElementById('help-split-key');

const clickBehaviorSelect = document.getElementById('click-behavior');
const clickTargetField = document.getElementById('click-target-field');
const clickTargetSelect = document.getElementById('click-target');
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
const cuePanelSplitKey = document.getElementById('cue-panel-split-key');
const cuesEmpty = document.getElementById('cues-empty');
const saveProjectButton = document.getElementById('save-project');
const saveProjectAsButton = document.getElementById('save-project-as');
const saveProjectDropdown = document.getElementById('save-project-dropdown');
const gapRemovedExportDropdown = document.getElementById('gap-removed-export-dropdown');
const downloadSrtButton = document.getElementById('download-srt');
const subtitleExportDropdown = document.getElementById('subtitle-export-dropdown');
const editorSettingsToggle = document.getElementById('editor-settings-toggle');
const editorSettingsPanel = document.getElementById('editor-settings-panel');
const subtitlePreviewSettings = document.getElementById('subtitle-preview-settings');
const subtitlePreviewSettingsToggle = document.getElementById('subtitle-preview-settings-toggle');
const subtitlePreviewSettingsPanel = document.getElementById('subtitle-preview-settings-panel');
const exportStartAtZeroToggle = document.getElementById('export-start-at-zero');
const serverAutoSaveSettings = document.getElementById('server-auto-save-settings');
const autoSaveProjectToggle = document.getElementById('auto-save-project');
const autoSaveIntervalField = document.getElementById('auto-save-interval-field');
const autoSaveIntervalInput = document.getElementById('auto-save-interval');
const recentProjectsEl = document.getElementById('recent-projects');
const recentProjectsToggle = document.getElementById('recent-projects-toggle');
const recentProjectsMenu = document.getElementById('recent-projects-menu');
const recentProjectsList = document.getElementById('recent-projects-list');
const recentProjectsSeparator = document.getElementById('recent-projects-separator');
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
const gapRemoveClearAllButton = document.getElementById('gap-remove-clear-all');
const HELP_PANEL_POSITION_KEY = 'moy.asr.help.panel.v1';
const HELP_PANEL_SIZE_KEY = 'moy.asr.help.panel.size.v1';

const AUTO_MERGE_PANEL_POSITION_KEY = 'moy.asr.auto_merge.panel.v2';
const autoMergePanel = document.getElementById('auto-merge-panel');
const autoMergeDragHandle = document.getElementById('auto-merge-drag-handle');
const autoMergeCloseButton = document.getElementById('auto-merge-close');
const autoMergeManageButton = document.getElementById('auto-merge-manage');
const autoMergeRunButton = document.getElementById('auto-merge-run');
const autoMergeGapMsInput = document.getElementById('auto-merge-gap-ms');
const autoMergeSnapDirectionSelect = document.getElementById('auto-merge-snap-direction');
const autoMergeAbsorbShortToggle = document.getElementById('auto-merge-absorb-short');
const autoMergeShortCountInput = document.getElementById('auto-merge-short-count');
const autoMergeAbsorbDirectionSelect = document.getElementById('auto-merge-absorb-direction');
let gapPreviewRange = null;
let gapRemovePanelDrag = null;
let currentCuePanelIdx = -1;
let cuePanelUndoPushed = false;
let editorSettingsPanelFrame = 0;

function updateEditorSettings(patch) {
  Object.assign(EDITOR_SETTINGS, patch);
  saveEditorSettings(EDITOR_SETTINGS);
}

function setEditorSettingsPanelOpen(open) {
  if (!editorSettingsPanel || !editorSettingsToggle) return;
  editorSettingsToggle.classList.toggle('active', open);
  editorSettingsToggle.setAttribute('aria-expanded', String(open));
  // 先让按钮状态绘制出来，再展开/收起文档流中的大面板，避免布局重排把高亮拖后。
  cancelAnimationFrame(editorSettingsPanelFrame);
  editorSettingsPanelFrame = requestAnimationFrame(() => {
    editorSettingsPanelFrame = requestAnimationFrame(() => {
      editorSettingsPanelFrame = 0;
      if (editorSettingsToggle.getAttribute('aria-expanded') !== String(open)) return;
      editorSettingsPanel.hidden = !open;
    });
  });
}

function positionSubtitlePreviewSettingsPanel() {
  if (!subtitlePreviewSettingsPanel || subtitlePreviewSettingsPanel.hidden || !subtitlePreviewSettingsToggle) return;
  const buttonRect = subtitlePreviewSettingsToggle.getBoundingClientRect();
  const panelWidth = subtitlePreviewSettingsPanel.offsetWidth;
  const panelHeight = subtitlePreviewSettingsPanel.offsetHeight;
  const margin = 8;
  const left = Math.min(
    Math.max(margin, buttonRect.right - panelWidth),
    Math.max(margin, window.innerWidth - panelWidth - margin),
  );
  const top = Math.min(
    buttonRect.bottom + 6,
    Math.max(margin, window.innerHeight - panelHeight - margin),
  );
  subtitlePreviewSettingsPanel.style.left = `${left}px`;
  subtitlePreviewSettingsPanel.style.top = `${top}px`;
}

function setSubtitlePreviewSettingsPanelOpen(open) {
  if (!subtitlePreviewSettingsPanel || !subtitlePreviewSettingsToggle) return;
  subtitlePreviewSettingsPanel.hidden = !open;
  subtitlePreviewSettingsToggle.classList.toggle('active', open);
  subtitlePreviewSettingsToggle.setAttribute('aria-expanded', String(open));
  if (open) positionSubtitlePreviewSettingsPanel();
}

function applyCueListDisplaySettings() {
  cueListShowIndexToggle.checked = EDITOR_SETTINGS.cueListShowIndex;
  cueListShowTimeToggle.checked = EDITOR_SETTINGS.cueListShowTime;
  cueListShowStickerToggle.checked = EDITOR_SETTINGS.cueListShowSticker;
  cueListShowCharcountToggle.checked = EDITOR_SETTINGS.cueListShowCharcount;
  cueListAutoScrollOnClickToggle.checked = EDITOR_SETTINGS.cueListAutoScrollOnClick;
  container.classList.toggle('hide-cue-index', !EDITOR_SETTINGS.cueListShowIndex);
  container.classList.toggle('hide-cue-time', !EDITOR_SETTINGS.cueListShowTime);
  // 设置保留用户的显示偏好；当前工程完全没有表情包时，整列仍自动收起，
  // 以后分配首个表情包会在下一次 renderAll() 中自动恢复。
  const projectHasStickers = DATA.segments.some(segment => segment.sticker || segment.sticker_ref);
  container.classList.toggle('hide-cue-sticker',
    !EDITOR_SETTINGS.cueListShowSticker || !projectHasStickers,
  );
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
  cueEditorShowTimeActionsToggle.checked = EDITOR_SETTINGS.cueEditorShowTimeActions;
  cueEditorShowStickerToggle.checked = EDITOR_SETTINGS.cueEditorShowSticker;
  cuePanel.classList.toggle('hide-cue-editor-navigation', !EDITOR_SETTINGS.cueEditorShowNavigation);
  cuePanel.classList.toggle('hide-cue-editor-time-actions', !EDITOR_SETTINGS.cueEditorShowTimeActions);
  cuePanel.classList.toggle('hide-cue-editor-sticker', !EDITOR_SETTINGS.cueEditorShowSticker);
}

const EDITOR_DISPLAY_KEYS = [
  'cueListShowIndex', 'cueListShowTime', 'cueListShowSticker', 'cueListShowCharcount',
  'cueEditorShowNavigation', 'cueEditorShowTimeActions', 'cueEditorShowSticker',
];

function getEditorDisplaySettings() {
  return Object.fromEntries(EDITOR_DISPLAY_KEYS.map((key) => [key, EDITOR_SETTINGS[key]]));
}

function applyEditorDisplaySettings(value) {
  if (!value || typeof value !== 'object') return;
  const patch = {};
  EDITOR_DISPLAY_KEYS.forEach((key) => {
    if (typeof value[key] === 'boolean') patch[key] = value[key];
  });
  if (!Object.keys(patch).length) return;
  updateEditorSettings(patch);
  applyCueListDisplaySettings();
  applyCueEditorDisplaySettings();
}

function bindCueEditorDisplayToggle(toggle, key) {
  toggle.addEventListener('change', () => {
    updateEditorSettings({ [key]: toggle.checked });
    applyCueEditorDisplaySettings();
  });
}

// macOS 用 ⌘（Cmd）替代 Ctrl；Win/Linux 仍显示 Ctrl。
function modKeyLabel() {
  return window.AsrEditorUtils?.isMacPlatform() ? 'Cmd' : 'Ctrl';
}

function splitKeyLabel() {
  return splitKeySel.value === 'enter' ? 'Enter' : `${modKeyLabel()}+Enter`;
}

// 把帮助面板等静态 <kbd data-mod-key> 与「拆分按键」下拉选项文本按平台替换。
function applyPlatformKeyLabels() {
  if (modKeyLabel() === 'Ctrl') return;
  document.querySelectorAll('[data-mod-key]').forEach((el) => {
    el.textContent = el.textContent.replace(/^Ctrl/, 'Cmd');
  });
  if (splitKeySel) {
    const opt = splitKeySel.querySelector('option[value="ctrl-enter"]');
    if (opt) opt.textContent = 'Cmd+Enter';
  }
}

function refreshSplitKeyHelp() {
  const label = splitKeyLabel();
  if (helpSplitKey) helpSplitKey.textContent = label;
  if (cuePanelSplitKey) cuePanelSplitKey.textContent = label;
}

// 切换语言时 i18n 会重置动态文本节点，需重新套用当前拆分按键提示。
document.addEventListener('mawe:languagechange', () => refreshSplitKeyHelp());

splitKeySel.value = EDITOR_SETTINGS.splitKey;
applyPlatformKeyLabels();
refreshSplitKeyHelp();
if (mergeJoinTextInput) mergeJoinTextInput.value = EDITOR_SETTINGS.mergeJoinText;
syncAutoMergePanelInputs();
overlayToggle.checked = EDITOR_SETTINGS.overlayEnabled;
exportStartAtZeroToggle.checked = EDITOR_SETTINGS.exportStartAtZero;
if (selectGroupMembersToggle) selectGroupMembersToggle.checked = EDITOR_SETTINGS.selectGroupMembers;
if (exportColorUnifiedToggle) exportColorUnifiedToggle.checked = EDITOR_SETTINGS.exportColorUnified;
if (autoSaveProjectToggle) autoSaveProjectToggle.checked = EDITOR_SETTINGS.autoSaveProject;
if (autoSaveIntervalInput) autoSaveIntervalInput.value = String(EDITOR_SETTINGS.autoSaveIntervalSeconds);
if (stickerOverlayToggle) stickerOverlayToggle.checked = EDITOR_SETTINGS.stickerOverlayEnabled;
if (clickBehaviorSelect) clickBehaviorSelect.value = EDITOR_SETTINGS.clickBehavior;
if (clickTargetSelect) clickTargetSelect.value = EDITOR_SETTINGS.clickTarget;
applyCueListDisplaySettings();
applyCueEditorDisplaySettings();
applySubtitleAppearance();
editorSettingsToggle?.addEventListener('click', () => setEditorSettingsPanelOpen(editorSettingsPanel?.hidden));
subtitlePreviewSettingsToggle?.addEventListener('click', (event) => {
  event.stopPropagation();
  setSubtitlePreviewSettingsPanelOpen(subtitlePreviewSettingsPanel?.hidden);
});
document.addEventListener('pointerdown', (event) => {
  if (subtitlePreviewSettingsPanel?.hidden) return;
  if (subtitlePreviewSettings?.contains(event.target)) return;
  setSubtitlePreviewSettingsPanelOpen(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || subtitlePreviewSettingsPanel?.hidden) return;
  setSubtitlePreviewSettingsPanelOpen(false);
  subtitlePreviewSettingsToggle?.focus();
});
window.addEventListener('resize', positionSubtitlePreviewSettingsPanel);
window.addEventListener('scroll', positionSubtitlePreviewSettingsPanel, true);
subtitlePreviewSettings?.closest('.player-toolbar')?.addEventListener(
  'scroll', positionSubtitlePreviewSettingsPanel,
);
// 帮助浮窗：与拼合字幕共用 createFloatingPanel（拖动、位置持久化、Esc 关闭）
const helpFloatingPanel = createFloatingPanel({
  panel: helpPanel,
  dragHandle: helpDragHandle,
  manageButton: helpToggle,
  anchorButton: helpToggle,
  positionKey: HELP_PANEL_POSITION_KEY,
  onOpen: restoreHelpPanelSize,
});
// 帮助是非模态浮窗；打开后立即释放入口按钮焦点，让 Enter / Esc 等快捷键回到编辑器。
helpToggle?.addEventListener('click', () => helpToggle.blur());
helpCloseButton?.addEventListener('click', () => helpFloatingPanel.close());
// 浮窗尺寸：仅在用户拖过右下角缩放手柄后持久化；未缩放时保持 CSS 默认宽度/自动高度
function restoreHelpPanelSize() {
  if (!helpPanel) return;
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(HELP_PANEL_SIZE_KEY) || 'null');
  } catch (_) {
    saved = null;
  }
  if (!Number.isFinite(saved?.width) || !Number.isFinite(saved?.height)) return;
  helpPanel.style.width = `${Math.min(Math.max(320, saved.width), window.innerWidth - 12)}px`;
  helpPanel.style.height = `${Math.min(Math.max(240, saved.height), window.innerHeight - 12)}px`;
}
let helpPanelSizeSaveTimer = 0;
if (helpPanel) {
  new ResizeObserver(() => {
    if (!helpPanel.classList.contains('show')) return;
    if (!helpPanel.style.width && !helpPanel.style.height) return;
    clearTimeout(helpPanelSizeSaveTimer);
    helpPanelSizeSaveTimer = setTimeout(() => {
      const rect = helpPanel.getBoundingClientRect();
      try {
        localStorage.setItem(HELP_PANEL_SIZE_KEY, JSON.stringify({
          width: Math.round(rect.width), height: Math.round(rect.height),
        }));
      } catch (_) {
        // file:// 隐私模式下 localStorage 可能被拒；缩放本身仍可用。
      }
    }, 250);
  }).observe(helpPanel);
}


// 明暗主题：令牌全部定义在 CSS（:root 暗色 / [data-theme="light"] 亮色），
// 这里只负责写 <html data-theme>、持久化、同步按钮，以及通知波形重绘画布。
// 按钮显示的是「目标主题」（与相邻 🌐 语言按钮同一约定）：暗色时显示 🌖（点击转亮）。
// title 用中文源串，英文界面由 i18n 的属性 MutationObserver 自动翻译。
function refreshThemeToggle(theme) {
  if (!themeToggle) return;
  const toLight = theme !== 'light';
  themeToggle.textContent = toLight ? '🌖' : '🌘';
  const title = toLight ? '切换到亮色主题' : '切换到暗色主题';
  themeToggle.title = title;
  themeToggle.setAttribute('aria-label', title);
}
function applyTheme(theme, { rerenderWaveform = true } = {}) {
  const next = theme === 'light' ? 'light' : 'dark';
  if (next === 'light') document.documentElement.dataset.theme = 'light';
  else delete document.documentElement.dataset.theme;
  refreshThemeToggle(next);
  // 画布颜色是 JS 读取的令牌快照，必须全量重绘才能跟随主题
  if (rerenderWaveform && waveformEditor) waveformEditor.render();
}
applyTheme(EDITOR_SETTINGS.theme, { rerenderWaveform: false });
themeToggle?.addEventListener('click', () => {
  const next = EDITOR_SETTINGS.theme === 'light' ? 'dark' : 'light';
  updateEditorSettings({ theme: next });
  applyTheme(next);
});
splitKeySel.addEventListener('change', () => {
  updateEditorSettings({ splitKey: splitKeySel.value });
  refreshSplitKeyHelp();
});
if (mergeJoinTextInput) mergeJoinTextInput.addEventListener('input', () => {
  updateEditorSettings({ mergeJoinText: mergeJoinTextInput.value });
});
// 拼合字幕工具窗：参数即时持久化；number 输入 change 时把显示值回钳到合法区间。
const autoMergeFloatingPanel = createFloatingPanel({
  panel: autoMergePanel,
  dragHandle: autoMergeDragHandle,
  manageButton: autoMergeManageButton,
  anchorButton: autoMergeManageButton,
  positionKey: AUTO_MERGE_PANEL_POSITION_KEY,
  onOpen: syncAutoMergePanelInputs,
});
autoMergeCloseButton?.addEventListener('click', () => autoMergeFloatingPanel.close());
autoMergeRunButton?.addEventListener('click', autoMergeSegments);
autoMergeGapMsInput?.addEventListener('input', () => {
  updateEditorSettings({ autoMergeGapMs: clampAutoMergeGapMs(autoMergeGapMsInput.value) });
});
autoMergeGapMsInput?.addEventListener('change', () => {
  autoMergeGapMsInput.value = String(EDITOR_SETTINGS.autoMergeGapMs);
});
autoMergeSnapDirectionSelect?.addEventListener('change', () => {
  updateEditorSettings({
    autoMergeSnapDirection: autoMergeSnapDirectionSelect.value === 'forward' ? 'forward' : 'backward',
  });
});
autoMergeAbsorbShortToggle?.addEventListener('change', () => {
  updateEditorSettings({ autoMergeAbsorbShort: autoMergeAbsorbShortToggle.checked });
  syncAutoMergeAbsorbFields();
});
autoMergeShortCountInput?.addEventListener('input', () => {
  updateEditorSettings({ autoMergeShortCount: clampAutoMergeShortCount(autoMergeShortCountInput.value) });
});
autoMergeShortCountInput?.addEventListener('change', () => {
  autoMergeShortCountInput.value = String(EDITOR_SETTINGS.autoMergeShortCount);
});
autoMergeAbsorbDirectionSelect?.addEventListener('change', () => {
  updateEditorSettings({
    autoMergeAbsorbDirection: autoMergeAbsorbDirectionSelect.value === 'next' ? 'next' : 'previous',
  });
});
autoMergePanel?.querySelectorAll('input[type="number"]').forEach((input) => {
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
bindCueListDisplayToggle(cueListShowIndexToggle, 'cueListShowIndex');
bindCueListDisplayToggle(cueListShowTimeToggle, 'cueListShowTime');
bindCueListDisplayToggle(cueListShowStickerToggle, 'cueListShowSticker');
bindCueListDisplayToggle(cueListShowCharcountToggle, 'cueListShowCharcount');
bindCueListDisplayToggle(cueListAutoScrollOnClickToggle, 'cueListAutoScrollOnClick');
bindCueEditorDisplayToggle(cueEditorShowNavigationToggle, 'cueEditorShowNavigation');
bindCueEditorDisplayToggle(cueEditorShowTimeActionsToggle, 'cueEditorShowTimeActions');
bindCueEditorDisplayToggle(cueEditorShowStickerToggle, 'cueEditorShowSticker');
exportStartAtZeroToggle.addEventListener('change', () => {
  updateEditorSettings({ exportStartAtZero: exportStartAtZeroToggle.checked });
});
selectGroupMembersToggle?.addEventListener('change', () => {
  updateEditorSettings({ selectGroupMembers: selectGroupMembersToggle.checked });
});
exportColorUnifiedToggle?.addEventListener('change', () => {
  updateEditorSettings({ exportColorUnified: exportColorUnifiedToggle.checked });
});
clickBehaviorSelect?.addEventListener('change', () => {
  updateEditorSettings({ clickBehavior: normalizeClickBehavior(clickBehaviorSelect.value) });
  refreshClickBehaviorHint();
});
clickTargetSelect?.addEventListener('change', () => {
  updateEditorSettings({ clickTarget: normalizeClickTarget(clickTargetSelect.value) });
});
subtitleFontSizeSelect?.addEventListener('change', () => {
  const value = subtitleFontSizeSelect.value;
  pushPreviewUndo('调整字幕字号', snapshotPreviewState());
  setSubtitleAppearance({ font_size: value === 'auto' ? null : Number(value) });
});
subtitleFontFamilySelect?.addEventListener('change', () => {
  pushPreviewUndo('调整字幕字体', snapshotPreviewState());
  setSubtitleAppearance({ font_family: subtitleFontFamilySelect.value });
});
const CLICK_BEHAVIOR_HINTS = {
  zh: {
    'select-and-seek': '暂停时只跳转，不自动播放；播放中跳转后继续播放。',
    'select-only': '只选中，不改变播放位置；可用 F 或右键菜单跳转并播放。',
    'select-and-play': '跳转到字幕起点，并在暂停时自动开始播放。',
  },
  en: {
    'select-and-seek': 'When paused, seek without starting playback; while playing, keep playing after seeking.',
    'select-only': 'Select only without changing the playhead; use F or the context menu to seek and play.',
    'select-and-play': 'Seek to the subtitle start and start playback when paused.',
  },
};
function refreshClickBehaviorHint() {
  const hint = document.getElementById('click-behavior-hint');
  const language = window.MAWE_I18N?.language === 'en' ? 'en' : 'zh';
  if (hint) {
    hint.textContent = CLICK_BEHAVIOR_HINTS[language][EDITOR_SETTINGS.clickBehavior];
    hint.hidden = false;
  }
  if (clickTargetField) {
    clickTargetField.hidden = EDITOR_SETTINGS.clickBehavior === 'select-only';
  }
}
refreshClickBehaviorHint();
document.addEventListener('mawe:languagechange', refreshClickBehaviorHint);

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
    const message = document.createElement('div');
    message.className = 'gap-remove-total';
    message.textContent = '尚未找到符合门限的音量空隙。';
    gapRemoveList.appendChild(message);
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
  if (gapRemoveClearAllButton) gapRemoveClearAllButton.disabled = !gaps.length;
  if (gapRemovedExportDropdown) {
    gapRemovedExportDropdown.hidden = !gaps.some((gap) => gap.removed);
    if (gapRemovedExportDropdown.hidden) gapRemovedExportDropdown.classList.remove('open');
  }
  renderGapRemoveList();
  waveformEditor?.refreshGapOverlay();
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

function clearGap(index) {
  const state = getGapRemoveData(false);
  const gap = state?.gaps?.[index];
  if (!gap) return;
  pushGapRemoveUndo('清理空隙区段');
  state.gaps = state.gaps.filter((_, gapIndex) => gapIndex !== index);
  state.manual_corrections = state.gaps.length > 0;
  setGapRemoveData(state);
  flashHint('已清理空隙区段');
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

function clearAllGaps() {
  const state = getGapRemoveData(false);
  if (!state?.gaps?.length) return;
  if (!confirm(
    `确定要清理全部 ${state.gaps.length} 个空隙区段吗？\n\n这会删除当前所有已移除和已恢复的区段记录。`
  )) return;
  pushGapRemoveUndo('清理全部空隙区段');
  state.gaps = [];
  state.manual_corrections = false;
  setGapRemoveData(state);
  flashHint('已清理全部空隙区段');
}

// 可拖动非模态工具窗（移除静音空隙 / 拼合字幕共用模式）：
// 负责显示/隐藏、工具栏按钮 active 态、标题栏拖动与位置持久化、窗口缩放回钳、Esc 关闭。
function createFloatingPanel({ panel, dragHandle, manageButton, anchorButton, positionKey, onOpen }) {
  if (!panel) return { open() {}, close() {}, toggle() {}, isOpen: () => false };
  let drag = null;

  function isOpen() { return panel.classList.contains('show'); }

  function setPosition(left, top, { persist = false } = {}) {
    const rect = panel.getBoundingClientRect();
    const margin = 6;
    const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
    const nextLeft = Math.min(maxLeft, Math.max(margin, Math.round(left)));
    const nextTop = Math.min(maxTop, Math.max(margin, Math.round(top)));
    panel.style.left = `${nextLeft}px`;
    panel.style.top = `${nextTop}px`;
    panel.style.right = 'auto';
    if (persist) {
      try {
        localStorage.setItem(positionKey, JSON.stringify({ left: nextLeft, top: nextTop }));
      } catch (_) {
        // file:// 隐私模式可能拒绝 localStorage；拖动本身仍保持可用。
      }
    }
  }

  function restorePosition() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(positionKey) || 'null');
    } catch (_) {
      saved = null;
    }
    if (Number.isFinite(saved?.left) && Number.isFinite(saved?.top)) {
      setPosition(saved.left, saved.top);
      return true;
    }
    return false;
  }

  function positionNearAnchor() {
    if (!anchorButton) return false;
    const anchorRect = anchorButton.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const margin = 6;
    const gap = 6;
    let left = anchorRect.left;
    if (left + panelRect.width > window.innerWidth - margin) {
      left = anchorRect.right - panelRect.width;
    }
    let top = anchorRect.bottom + gap;
    if (top + panelRect.height > window.innerHeight - margin) {
      top = anchorRect.top - panelRect.height - gap;
    }
    setPosition(left, top);
    return true;
  }

  function open() {
    if (typeof onOpen === 'function') onOpen();
    panel.classList.add('show');
    panel.setAttribute('aria-hidden', 'false');
    manageButton?.classList.add('active');
    manageButton?.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => {
      if (!restorePosition()) positionNearAnchor();
    });
  }

  function close() {
    panel.classList.remove('show', 'dragging');
    panel.setAttribute('aria-hidden', 'true');
    drag = null;
    manageButton?.classList.remove('active');
    manageButton?.setAttribute('aria-expanded', 'false');
  }

  function toggle() { if (isOpen()) close(); else open(); }

  function finishDrag(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    try {
      dragHandle?.releasePointerCapture?.(event.pointerId);
    } catch (_) {
      // 指针在浏览器窗口外释放时，capture 可能已由浏览器自动清理。
    }
    drag = null;
    panel.classList.remove('dragging');
    const rect = panel.getBoundingClientRect();
    setPosition(rect.left, rect.top, { persist: true });
  }

  dragHandle?.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('button')) return;
    const rect = panel.getBoundingClientRect();
    drag = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    panel.classList.add('dragging');
    dragHandle.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });
  dragHandle?.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    setPosition(event.clientX - drag.offsetX, event.clientY - drag.offsetY);
  });
  dragHandle?.addEventListener('pointerup', finishDrag);
  dragHandle?.addEventListener('pointercancel', finishDrag);
  manageButton?.addEventListener('click', toggle);
  window.addEventListener('resize', () => {
    if (!isOpen()) return;
    const rect = panel.getBoundingClientRect();
    setPosition(rect.left, rect.top, { persist: true });
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !isOpen() || editingState) return;
    event.preventDefault();
    close();
  });
  return { open, close, toggle, isOpen };
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
gapRemoveClearAllButton?.addEventListener('click', clearAllGaps);
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

function clearSelection({ silent = false } = {}) {
  selectedIdxs.forEach(i => {
    const el = container.querySelector(`.cue[data-idx="${i}"]`);
    if (el) el.classList.remove('selected');
  });
  selectedIdxs.clear();
  selCountEl.textContent = '0';
  if (silent) {
    // 结构编辑会马上 renderAll() 并重新选中目标；此时不必先刷新旧波形
    // 覆盖层和空面板，避免同一次操作产生两轮视觉更新。
    currentCuePanelIdx = -1;
    cuePanelUndoPushed = false;
    return;
  }
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
  // 这是键盘导航的热路径：clearSelection() 会先把面板切到空状态，
  // 再由下面的 setCurrentCuePanelIndex() 切回目标，导致一次按键触发
  // 两次面板刷新和两次波形选区刷新。先提交一次待编辑内容，再批量
  // 更新选区与面板，保持行为不变但只做一次视觉刷新。
  commitCuePanelEdit();
  selectedIdxs.forEach((i) => {
    const previous = container.querySelector(`.cue[data-idx="${i}"]`);
    if (previous) previous.classList.remove('selected');
  });
  selectedIdxs.clear();
  selectedIdxs.add(idx);
  const el = container.querySelector(`.cue[data-idx="${idx}"]`);
  if (el) el.classList.add('selected');
  selCountEl.textContent = '1';
  if (waveformEditor) waveformEditor.updateSelection();
  currentCuePanelIdx = DATA.segments[idx] ? idx : -1;
  cuePanelUndoPushed = false;
  renderCurrentCuePanel();
}
function addToSelection(idx) {
  if (isHiddenDisabled(idx) || selectedIdxs.has(idx)) return;
  selectedIdxs.add(idx);
  const el = container.querySelector(`.cue[data-idx="${idx}"]`);
  if (el) el.classList.add('selected');
  selCountEl.textContent = String(selectedIdxs.size);
  if (waveformEditor) waveformEditor.updateSelection();
  setCurrentCuePanelIndex(idx);
}
// 选中全部字幕（跳过「隐藏禁用项」开启时的禁用条目，与其它选择逻辑一致）。
function selectAll() {
  commitCuePanelEdit();
  clearSelection({ silent: true });
  DATA.segments.forEach((_, idx) => {
    if (isHiddenDisabled(idx)) return;
    selectedIdxs.add(idx);
    const el = container.querySelector(`.cue[data-idx="${idx}"]`);
    if (el) el.classList.add('selected');
  });
  selCountEl.textContent = String(selectedIdxs.size);
  if (waveformEditor) waveformEditor.updateSelection();
  const last = DATA.segments.length - 1;
  setCurrentCuePanelIndex(last >= 0 && selectedIdxs.has(last) ? last : (selectedIdxs.values().next().value ?? -1));
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
      commitCuePanelEdit();
      clearSelection({ silent: true });
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
  const cueListToolbar = container.querySelector(':scope > .cue-list-toolbar');
  const emptyState = cuesEmpty;
  container.replaceChildren();
  if (dockHandle) container.appendChild(dockHandle);
  if (cueListToolbar) container.appendChild(cueListToolbar);
  if (emptyState) {
    emptyState.classList.toggle('hidden', DATA.segments.length > 0);
    container.appendChild(emptyState);
  }
  DATA.segments.forEach((seg, i) => container.appendChild(buildCueEl(seg, i)));
  applyCueListDisplaySettings();
  totalCountEl.textContent = DATA.segments.length;
  applySearch(searchEl.value);
  // 重新应用选中样式（idx 不变时还有效；如果有 splice 改了顺序就先 clearSelection）
  selectedIdxs.forEach(i => {
    const el = container.querySelector(`.cue[data-idx="${i}"]`);
    if (el) el.classList.add('selected');
  });
  // 字幕结构变化只需更新波形上的字幕块覆盖层；媒体峰值和行 Canvas
  // 没有变化，避免 B/C/删除等操作重新绘制整组波形。
  if (waveformEditor) waveformEditor.refreshCueOverlay();
  renderCurrentCuePanel();
  syncPlayerPlaceholder();
  updateSubtitleExportUi();
  window.MAWE_ONBOARDING?.afterRender();
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
  return items.map((item) => {
    // 等比缩放后钳回段内，并保证 end > start（防止取整后出现 0 长词块）。
    const mappedStart = Math.round(newStart + ((item.start - oldStart) / oldDuration) * newDuration);
    const mappedEnd = Math.round(newStart + ((item.end - oldStart) / oldDuration) * newDuration);
    let start = Math.min(Math.max(mappedStart, newStart), newEnd);
    const end = Math.min(Math.max(mappedEnd, start + 1), newEnd);
    if (end <= start) start = Math.max(newStart, end - 1);
    return { ...item, start, end };
  });
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
  // Esc：退出字幕编辑区（失焦并提交），之后即可用 A/D 等快捷键跳转字幕。
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    cuePanelText.blur();
    return;
  }
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
  waveformEditor?.refreshCueLabel(currentCuePanelIdx);
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
  const timeStartEl = document.createElement('span');
  timeStartEl.className = 'time-start';
  timeStartEl.textContent = fmtShort(seg.start);
  const timeArrowEl = document.createElement('span');
  timeArrowEl.className = 'time-arrow';
  timeArrowEl.textContent = '→';
  const timeEndEl = document.createElement('span');
  timeEndEl.className = 'time-end';
  timeEndEl.textContent = fmtShort(seg.end);
  timeEl.append(timeStartEl, timeArrowEl, timeEndEl);

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
  return window.AsrEditorUtils.countTextUnits(text);
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

function startEdit(el, idx, clickX, clickY, { deferCaret = false } = {}) {
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
  const applyCaret = () => {
    if (!editingState || editingState.el !== el) return;
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
  };
  // 浏览器可能在 dblclick 处理器返回后执行原生的“双击选词”，覆盖刚设置的光标。
  // 延后一轮事件循环，确保双击编辑最终落在鼠标对应的字符位置。
  // 先同步放置一次光标，让编辑状态立即可见；双击原生选词可能在事件返回后
  // 覆盖它，再用下一轮事件循环恢复到鼠标位置。
  applyCaret();
  if (deferCaret) setTimeout(applyCaret, 0);
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
  waveformEditor?.refreshCueLabel(idx);
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

  // 拆分后任一侧都不能短于 100ms（与波形分割工具同规则），否则拒绝拆分。
  if (seg.end - seg.start < 200) {
    flashHint('字幕时长不足 200ms，无法拆分');
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
    // 无词级时间码时按光标位置拆分；钳制边界保证两侧都至少 100ms。
    const clamped = Math.min(Math.max(Math.round(t), seg.start + 100), seg.end - 100);
    leftEnd = clamped; rightStart = clamped;
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

  // 拆分会改变 idx；先提交面板编辑，再静默清选中，等列表和波形块
  // 覆盖层一次性更新后再选中后半段。
  commitCuePanelEdit();
  clearSelection({ silent: true });
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
  // 拆分后后半段是新的视觉选中项，也必须成为 Shift+点击的范围锚点。
  lastClickedIdx = idx + 1;
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
// 把 DATA.segments 中连续下标 sorted 合并为一条，并维护 group 引用与组时间范围。
// 不做参数校验、撤销与渲染，由调用方负责（mergeSegments / autoMergeSegments 共用）。
function mergeContiguousIndices(sorted) {
  const segs = sorted.map(i => DATA.segments[i]);
  const stickerGroup = window.AsrEditorUtils.resolveMergedGroupInheritance(
    DATA.segments, sorted, 'sticker', 'sticker_ref',
  );
  const colorGroup = window.AsrEditorUtils.resolveMergedGroupInheritance(
    DATA.segments, sorted, 'color', 'color_ref',
  );
  const commonSpeaker = segs[0].speaker != null
    && segs.every((segment) => segment.speaker === segs[0].speaker)
    ? segs[0].speaker
    : null;
  const merged = {
    start: segs[0].start,
    end: segs[segs.length - 1].end,
    text: window.AsrEditorUtils.joinSegmentTexts(segs, EDITOR_SETTINGS.mergeJoinText),
    items: segs.flatMap(s => s.items || []),
    sticker: stickerGroup.head,
    sticker_ref: stickerGroup.ref,
    color: colorGroup.head,
    color_ref: colorGroup.ref,
    ...(commonSpeaker !== null ? { speaker: commonSpeaker } : {}),
    disabled: !!segs[0].disabled,  // 合并后取 index=0 的禁用状态
    _dirty: true,
  };
  if (merged.items.length === 0) merged.items = null;

  // 选区并非全部同组时，不继承该组；先按删除切点规则重组外部存活成员，
  // 避免合并掉某个 head 后留下悬空引用。
  const mergeSet = new Set(sorted);
  if (stickerGroup.headIdx === null) {
    splitGroupsAtCutPoints(mergeSet, 'sticker', 'sticker_ref');
  }
  if (colorGroup.headIdx === null) {
    splitGroupsAtCutPoints(mergeSet, 'color', 'color_ref');
  }

  DATA.segments.splice(sorted[0], sorted.length, merged);
  // splice 后统一重映射 group head：选区内继承的 head 移到首项，
  // 选区之后的 head 则按减少的字幕数量左移。
  const removedCount = sorted.length - 1;  // 合并把 sorted.length 条变成 1 条
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  function remapRef(ref) {
    if (!ref || !Number.isInteger(ref.headIdx)) return;
    if (ref.headIdx >= first && ref.headIdx <= last) {
      ref.headIdx = first;
    } else if (ref.headIdx > last) {
      ref.headIdx -= removedCount;
    }
  }
  DATA.segments.forEach((segment) => {
    remapRef(segment.sticker_ref);
    remapRef(segment.color_ref);
  });
  syncTimelineGroupRanges();
  return merged;
}

function mergeSegments(idxs) {
  if (idxs.length < 2) { flashHint('请选择至少两个字幕块！'); return; }
  const sorted = [...new Set(idxs)].sort((a, b) => a - b);
  if (sorted.length < 2) { flashHint('请选择至少两个字幕块！'); return; }
  // 确保连续
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] !== sorted[i - 1] + 1) {
      flashHint('选中的字幕必须连续');
      return;
    }
  }
  commitCuePanelEdit();
  clearSelection({ silent: true });
  pushUndo('合并字幕');
  mergeContiguousIndices(sorted);
  renderAll();
  // 合并完成后选中合并结果，方便继续对这句新字幕操作
  selectOnly(sorted[0]);
  const el = container.querySelector(`.cue[data-idx="${sorted[0]}"]`);
  if (el) scrollCueToCenter(el);
  flashHint(`已合并 ${sorted.length} 条`);
}

// === 拼合字幕 ===
// 把工具窗参数同步到控件；「吸收过短字幕」关闭时禁用短句相关参数。
function syncAutoMergePanelInputs() {
  if (autoMergeGapMsInput) autoMergeGapMsInput.value = String(EDITOR_SETTINGS.autoMergeGapMs);
  if (autoMergeSnapDirectionSelect) autoMergeSnapDirectionSelect.value = EDITOR_SETTINGS.autoMergeSnapDirection;
  if (autoMergeAbsorbShortToggle) autoMergeAbsorbShortToggle.checked = EDITOR_SETTINGS.autoMergeAbsorbShort;
  if (autoMergeShortCountInput) autoMergeShortCountInput.value = String(EDITOR_SETTINGS.autoMergeShortCount);
  if (autoMergeAbsorbDirectionSelect) autoMergeAbsorbDirectionSelect.value = EDITOR_SETTINGS.autoMergeAbsorbDirection;
  syncAutoMergeAbsorbFields();
}

function syncAutoMergeAbsorbFields() {
  const enabled = EDITOR_SETTINGS.autoMergeAbsorbShort;
  if (autoMergeShortCountInput) autoMergeShortCountInput.disabled = !enabled;
  if (autoMergeAbsorbDirectionSelect) autoMergeAbsorbDirectionSelect.disabled = !enabled;
  autoMergePanel?.classList.toggle('absorb-disabled', !enabled);
}

// 一键处理整段工程：相邻间隔不超过 autoMergeGapMs 时按拓展方向拼合；
// 过短的字幕（中文 < N 字 / 英文 < N 词）按吸收方向并入相邻字幕。
function autoMergeSegments() {
  const plan = window.AsrEditorUtils.planAutoMerge(DATA.segments, {
    gapMs: EDITOR_SETTINGS.autoMergeGapMs,
    snapDirection: EDITOR_SETTINGS.autoMergeSnapDirection,
    absorbShort: EDITOR_SETTINGS.autoMergeAbsorbShort,
    shortCount: EDITOR_SETTINGS.autoMergeShortCount,
    absorbDirection: EDITOR_SETTINGS.autoMergeAbsorbDirection,
  });
  if (!plan.snaps.length && !plan.groups.length) {
    flashHint('没有需要拼合的间隔或过短字幕');
    return;
  }
  if (editingState) finishEdit(false);
  commitCuePanelEdit();
  clearSelection({ silent: true });
  pushUndo('拼合字幕');
  const snappedCount = window.AsrEditorUtils.applyAutoMergeSnaps(DATA.segments, plan.snaps);
  // 合并从后往前进行，保持靠前组的下标仍然有效
  for (let i = plan.groups.length - 1; i >= 0; i--) {
    mergeContiguousIndices(plan.groups[i]);
  }
  renderAll();
  update();
  const mergedCount = plan.groups.reduce((sum, group) => sum + group.length - 1, 0);
  const parts = [];
  if (snappedCount) parts.push(`拼合 ${snappedCount} 处间隔`);
  if (mergedCount) parts.push(`吸收 ${mergedCount} 条短字幕`);
  flashHint(`已拼合字幕：${parts.join('，')}`);
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
  clearSelection({ silent: true });
  lastActive = -1;
  renderAll();
  flashHint(`已删除 ${sorted.length} 条`);
}

// === 滚动 ===
function scrollCueToCenter(cueEl) {
  if (!cueEl || cueEl.classList.contains('hidden')) return;
  const cRect = container.getBoundingClientRect();
  const eRect = cueEl.getBoundingClientRect();
  // 目标已经处于列表中间的舒适区域时，不再制造一次多余的滚动动画。
  // 留出上下约 20% 的缓冲；只有接近顶部/底部时才把字幕移到中央。
  const comfortInset = Math.min(120, Math.max(48, cRect.height * 0.2));
  if (
    eRect.top >= cRect.top + comfortInset
    && eRect.bottom <= cRect.bottom - comfortInset
  ) return;
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
let cueListPointer = null;
// 最后一次指针按下所在的编辑区域：cue-list / waveform。
// Enter（原地编辑 vs 聚焦字幕编辑区）据此分发；指针坐标由 cueListPointer /
// lastPointerPos 提供，两者独立更新、互不替代。
let lastEditRegion = null;
let lastPointerPos = null;

document.addEventListener('pointerdown', (e) => {
  if (e.target instanceof Element && e.target.closest('.cue')) lastEditRegion = 'cue-list';
  else if (e.target instanceof Element && e.target.closest('#waveform-pane')) lastEditRegion = 'waveform';
}, true);
document.addEventListener('pointermove', (e) => {
  lastPointerPos = { x: e.clientX, y: e.clientY };
}, true);

function hoveredSelectedCueContext() {
  if (!cueListPointer || !selectedIdxs.has(cueListPointer.idx)) return null;
  const el = container.querySelector(`.cue[data-idx="${cueListPointer.idx}"]`);
  if (!el || !el.matches(':hover')) return null;
  return { ...cueListPointer, el };
}

// === 单击/双击/Shift/Ctrl ===
function bindCueEvents(el, idx) {
  let pointerDownState = null;
  let lastPrimaryPointerDownAt = 0;

  function selectFromCuePointer(event) {
    // Alt+点击 = 快速切换禁用状态
    if (event.altKey) {
      event.preventDefault();
      toggleDisabled([idx]);
      return 'alt';
    }

    // Shift / Ctrl 多选
    if (event.shiftKey) {
      event.preventDefault();
      if (lastClickedIdx >= 0) selectRange(lastClickedIdx, idx);
      else selectOnly(idx);
      lastClickedIdx = idx;
      return 'shift';
    }
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      toggleSel(idx);
      lastClickedIdx = idx;
      return 'toggle';
    }

    // 普通单击的选中阶段放在 pointerdown，点击时只做跳转。
    selectCueByClick(idx);
    lastClickedIdx = idx;
    return 'select';
  }

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || (editingState && editingState.el === el)) return;
    cueListPointer = { idx, x: e.clientX, y: e.clientY };

    // 这些子控件有自己的 click 行为；不要在父 cue 的 pointerdown 阶段抢先选中。
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest('.color-bar.is-ref, .sticker-slot img, .sticker-slot .sref')) {
      // 避免这次不会冒泡到父 cue 的 click 参与下一次普通双击判定。
      lastPrimaryPointerDownAt = 0;
      pointerDownState = { handled: false, time: performance.now() };
      return;
    }

    const now = performance.now();
    const isSecondDoubleClick = e.detail > 1
      || (lastPrimaryPointerDownAt > 0 && now - lastPrimaryPointerDownAt < 500);
    lastPrimaryPointerDownAt = now;
    if (isSecondDoubleClick) {
      // 第一次 pointerdown 已经完成选中；双击的第二次按下不要再次刷新面板/波形布局。
      pointerDownState = { handled: true, suppressClick: true, time: now };
      return;
    }

    const action = selectFromCuePointer(e);
    pointerDownState = {
      handled: true,
      suppressClick: action !== 'select',
      time: now,
    };
  });
  el.addEventListener('pointermove', (e) => {
    cueListPointer = { idx, x: e.clientX, y: e.clientY };
  });
  el.addEventListener('pointerleave', () => {
    if (cueListPointer?.idx === idx) cueListPointer = null;
  });

  el.addEventListener('click', (e) => {
    if (editingState && editingState.el === el) return;
    const state = pointerDownState;
    pointerDownState = null;
    // 第一次 pointerdown 已经立即完成选择；双击产生的第二次 click
    // 不重复执行同一套操作，随后仍由 dblclick 进入编辑。
    if (e.detail > 1 || state?.suppressClick) return;

    // 键盘触发 click，或特殊子控件的 click 冒泡到父 cue 时，保留 click 作为后备选择路径。
    if (!state?.handled) selectFromCuePointer(e);

    // 选择已经在 pointerdown 完成；这里仅处理列表滚动、波形定位和媒体 Seek。
    if (EDITOR_SETTINGS.cueListAutoScrollOnClick) scrollCueToCenter(el);
    waveformEditor?.revealTime(DATA.segments[idx].start, true);
    if (EDITOR_SETTINGS.clickBehavior !== 'select-only') {
      // 默认只跳转不改动播放状态；“选中并跳转（自动播放）”会在暂停时启动播放。
      const previousSuppress = suppressCueListAutoScroll;
      suppressCueListAutoScroll = !EDITOR_SETTINGS.cueListAutoScrollOnClick;
      try {
        seekFromWaveform(DATA.segments[idx].start / 1000);
      } finally {
        suppressCueListAutoScroll = previousSuppress;
      }
      if (EDITOR_SETTINGS.clickBehavior === 'select-and-play' && player.paused) togglePlayback();
    }
  });
  el.addEventListener('dblclick', (e) => {
    e.preventDefault();
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
    // 普通双击的第一次 pointerdown 已选中该 cue；只有从特殊子控件触发、且尚未选中时
    // 才补一次选择，避免双击再次提交当前面板并重绘波形布局。
    if (!selectedIdxs.has(idx)) selectOnly(idx);
    window.MAWE_ONBOARDING?.beginRealSplit(idx);
    startEdit(el, idx, e.clientX, e.clientY, { deferCaret: true });
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

// Esc：非字幕文本编辑状态下清除当前字幕选择；输入框和内联编辑继续保留原生/编辑行为。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || editingState || selectedIdxs.size === 0) return;
  const a = document.activeElement;
  if (a && (
    a.tagName === 'INPUT'
    || a.tagName === 'TEXTAREA'
    || a.tagName === 'SELECT'
    || a.isContentEditable
  )) return;
  if (replaceModal.classList.contains('show')) return;
  if (stickerModal.classList.contains('show')) return;
  if (stickerPreviewModal.classList.contains('show')) return;
  if (projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (ctxmenu.classList.contains('show')) return;
  e.preventDefault();
  e.stopPropagation();
  clearSelection();
});

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
  syncMediaControls();
}

function hasLoadedMedia() {
  return Boolean(
    player.currentSrc
    || player.getAttribute('src')
    || player.querySelector('source')?.getAttribute('src'),
  );
}

function formatMediaTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;
  const pad = (value) => String(value).padStart(2, '0');
  return hours ? `${hours}:${pad(minutes)}:${pad(remaining)}` : `${pad(minutes)}:${pad(remaining)}`;
}

function syncPlaybackRateOption(rate) {
  if (!mediaPlaybackRate || !Number.isFinite(rate)) return;
  mediaPlaybackRate.querySelectorAll('option[data-generated="true"]').forEach((option) => option.remove());
  const value = String(rate);
  let option = Array.from(mediaPlaybackRate.options).find((item) => item.value === value);
  if (!option) {
    option = document.createElement('option');
    option.value = value;
    option.textContent = fmtRate(rate);
    option.dataset.generated = 'true';
    mediaPlaybackRate.append(option);
  }
  mediaPlaybackRate.value = value;
}

function syncMediaControls() {
  if (!mediaPlayToggle || !player) return;
  const hasMedia = hasLoadedMedia();
  const duration = Number.isFinite(player.duration) && player.duration > 0 ? player.duration : 0;
  const current = Number.isFinite(player.currentTime) ? Math.max(0, player.currentTime) : 0;
  const active = hasMedia && !player.paused;
  mediaPlayToggle.disabled = !hasMedia;
  mediaStepBack.disabled = !hasMedia;
  mediaStepForward.disabled = !hasMedia;
  mediaSeek.disabled = !hasMedia || !duration;
  mediaVolume.disabled = !hasMedia;
  mediaPlaybackRate.disabled = !hasMedia;
  mediaFullscreen.disabled = !hasMedia || typeof playerWrap?.requestFullscreen !== 'function';
  mediaPlayToggle.textContent = active ? '⏸' : '▶';
  const playbackLabel = active ? '暂停' : '播放';
  mediaPlayToggle.setAttribute('aria-label', playbackLabel);
  mediaPlayToggle.title = playbackLabel;
  mediaCurrentTime.textContent = formatMediaTime(current);
  mediaDuration.textContent = formatMediaTime(duration);
  mediaSeek.max = String(duration);
  mediaSeek.value = String(duration ? Math.min(duration, current) : 0);
  if (Number.isFinite(player.volume)) mediaVolume.value = String(player.volume);
  if (Number.isFinite(player.playbackRate)) {
    syncPlaybackRateOption(player.playbackRate);
  }
  const fullscreenLabel = document.fullscreenElement ? '退出全屏' : '全屏';
  mediaFullscreen.setAttribute('aria-label', fullscreenLabel);
  mediaFullscreen.title = fullscreenLabel;
}

function stopPlaybackRefresh(mediaElement = null) {
  if (mediaElement && playbackFramePlayer && playbackFramePlayer !== mediaElement) return;
  if (playbackFrameId) cancelAnimationFrame(playbackFrameId);
  playbackFrameId = 0;
  playbackFramePlayer = null;
}

function startPlaybackRefresh(mediaElement) {
  if (!mediaElement || mediaElement !== player || mediaElement.paused || mediaElement.ended) return;
  if (playbackFramePlayer !== mediaElement) {
    stopPlaybackRefresh();
    playbackFramePlayer = mediaElement;
  }
  if (playbackFrameId) return;
  const refresh = () => {
    playbackFrameId = 0;
    if (playbackFramePlayer !== mediaElement || player !== mediaElement
        || mediaElement.paused || mediaElement.ended) {
      if (playbackFramePlayer === mediaElement) playbackFramePlayer = null;
      if (player === mediaElement) {
        update();
        waveformEditor?.updatePlayback();
      }
      return;
    }
    // 播放中只更新当前字幕/预览和波形播放头；不重绘波形画布、不重建字幕列表。
    updatePlaybackFrame();
    playbackFrameId = requestAnimationFrame(refresh);
  };
  playbackFrameId = requestAnimationFrame(refresh);
}

function bindPlayerEvents(mediaElement) {
  if (!mediaElement) return;
  mediaElement.addEventListener('timeupdate', update);
  mediaElement.addEventListener('seeked', update);
  mediaElement.addEventListener('play', () => startPlaybackRefresh(mediaElement));
  mediaElement.addEventListener('playing', () => startPlaybackRefresh(mediaElement));
  mediaElement.addEventListener('pause', () => {
    stopPlaybackRefresh(mediaElement);
    if (player !== mediaElement) return;
    update();
    waveformEditor?.updatePlayback();
  });
  mediaElement.addEventListener('ended', () => {
    stopPlaybackRefresh(mediaElement);
    if (player !== mediaElement) return;
    update();
    waveformEditor?.updatePlayback();
  });
  mediaElement.addEventListener('emptied', () => stopPlaybackRefresh(mediaElement));
  if (mediaElement.tagName === 'VIDEO') {
    mediaElement.addEventListener('click', (event) => {
      if (event.defaultPrevented) return;
      togglePlayback();
    });
  }
  ['timeupdate', 'loadedmetadata', 'durationchange', 'play', 'playing', 'pause', 'ended', 'volumechange', 'ratechange', 'emptied']
    .forEach((eventName) => mediaElement.addEventListener(eventName, syncMediaControls));
  syncMediaControls();
}

function seekMediaBy(deltaSeconds) {
  if (!hasLoadedMedia()) return;
  const duration = Number.isFinite(player.duration) ? player.duration : Infinity;
  player.currentTime = Math.max(0, Math.min(duration, player.currentTime + deltaSeconds));
  update();
  syncMediaControls();
}

mediaPlayToggle?.addEventListener('click', togglePlayback);
mediaStepBack?.addEventListener('click', () => seekMediaBy(-5));
mediaStepForward?.addEventListener('click', () => seekMediaBy(5));
mediaSeek?.addEventListener('input', () => {
  if (!hasLoadedMedia()) return;
  player.currentTime = Number(mediaSeek.value) || 0;
  update();
  syncMediaControls();
});
mediaVolume?.addEventListener('input', () => {
  player.volume = Math.min(1, Math.max(0, Number(mediaVolume.value) || 0));
  syncMediaControls();
});
mediaPlaybackRate?.addEventListener('change', () => {
  player.playbackRate = Number(mediaPlaybackRate.value) || 1;
  syncMediaControls();
});
mediaFullscreen?.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await playerWrap?.requestFullscreen?.();
  } catch (error) {
    flashHint(`无法切换全屏：${error.message || error}`);
  }
  syncMediaControls();
});
document.addEventListener('fullscreenchange', syncMediaControls);

// ←/→：复用媒体控制条的 ±5 秒跳转；文本输入、表单控件和预览框保留原生方向键行为。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  if (editingState || isTextEditingTarget(e)) return;
  const target = e.target instanceof Element ? e.target : document.activeElement;
  if (target?.closest?.('.geo-box, input, select, textarea')) return;
  if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
  if (!hasLoadedMedia()) return;
  if (!isPlaybackKeyboardTarget(e) && isNativeKeyboardControl(e)) return;
  e.preventDefault();
  e.stopPropagation();
  seekMediaBy(e.key === 'ArrowLeft' ? -5 : 5);
}, true);

function isSpaceKey(e) {
  return e.key === ' ' || e.code === 'Space';
}

const TEXT_INPUT_TYPES = new Set([
  'text', 'search', 'email', 'url', 'tel', 'password', 'number',
]);

function isPlayerKeyboardTarget(event) {
  return event.target === player
    || document.activeElement === player
    || event.composedPath?.().includes(player);
}

function isTextEditingTarget(event) {
  const target = event.target;
  const active = document.activeElement;
  if (target?.isContentEditable || active?.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || active instanceof HTMLTextAreaElement) return true;

  const input = target instanceof HTMLInputElement
    ? target
    : active instanceof HTMLInputElement ? active : null;
  if (!input) return false;
  return TEXT_INPUT_TYPES.has(input.type);
}

function isPlaybackKeyboardTarget(event) {
  const target = event.target;
  return isPlayerKeyboardTarget(event)
    || (target instanceof Element && Boolean(target.closest('#media-controls, .player-stage')));
}

function isNativeKeyboardControl(event) {
  const target = event.target instanceof Element ? event.target : document.activeElement;
  return Boolean(target?.closest?.('button, input, select, textarea, a'));
}

// 空格播放/暂停。捕获阶段先于原生媒体控件处理，避免控件获得焦点后执行默认行为。
let interceptedSpace = false;
document.addEventListener('keydown', (e) => {
  if (!isSpaceKey(e)) return;
  if (editingState || isTextEditingTarget(e)) return;
  if (replaceModal.classList.contains('show')) return;
  if (stickerModal.classList.contains('show')) return;
  if (stickerPreviewModal.classList.contains('show')) return;
  if (projectMediaModal.classList.contains('show')) return;
  if (ctxmenu.classList.contains('show')) return;
  if (!isPlaybackKeyboardTarget(e) && isNativeKeyboardControl(e)) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  interceptedSpace = true;
  if (e.repeat) return;
  togglePlayback();
}, true);

document.addEventListener('keyup', (e) => {
  if (!isSpaceKey(e) || !interceptedSpace) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  interceptedSpace = false;
}, true);
window.addEventListener('blur', () => { interceptedSpace = false; });

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
  syncMediaControls();
  flashHint(`倍速: ${fmtRate(r)}`);
});

// A/D（或 W/S）：跳转到上一条/下一条字幕的句首并单选。W/S 与 A/D 等价，对应上下方向。
// Shift+A/D（或 Shift+W/S）：保留当前选择，并向前/后追加选择一条字幕。
// 跳转本身不改变播放状态：播放中会从新位置继续播放，暂停中只移动播放指针。
document.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase();
  if (key !== 'a' && key !== 'd' && key !== 'w' && key !== 's') return;
  if (editingState) return;
  const a = document.activeElement;
  if (a && (
    a.tagName === 'INPUT'
    || a.tagName === 'TEXTAREA'
    || a.tagName === 'SELECT'
    || a.isContentEditable
  )) return;
  if (replaceModal.classList.contains('show')) return;
  if (stickerModal.classList.contains('show')) return;
  if (stickerPreviewModal.classList.contains('show')) return;
  if (projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (ctxmenu.classList.contains('show')) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;

  const direction = (key === 'a' || key === 'w') ? -1 : 1;
  const next = e.shiftKey
    ? window.AsrEditorUtils.findCueSelectionExtensionTarget(
      DATA.segments,
      selectedIdxs,
      currentCuePanelIdx,
      Math.round(player.currentTime * 1000),
      direction,
      hideDisabled,
    )
    : window.AsrEditorUtils.findCueNavigationTarget(
      DATA.segments,
      currentCuePanelIdx,
      Math.round(player.currentTime * 1000),
      direction,
      hideDisabled,
    );
  if (next < 0) return;

  e.preventDefault();
  e.stopPropagation();
  const wasPlaying = !player.paused;
  if (e.shiftKey) addToSelection(next);
  else selectOnly(next);
  lastClickedIdx = next;
  const cue = container.querySelector(`.cue[data-idx="${next}"]`);
  if (cue) scrollCueToCenter(cue);
  waveformEditor?.revealTime(DATA.segments[next].start, true);
  seekFromWaveform(DATA.segments[next].start / 1000);
  if (wasPlaying && player.paused) {
    const promise = player.play();
    if (promise && promise.catch) promise.catch(() => {});
  }
});

// Ctrl(Cmd)+A：选中所有字幕。仅在「非编辑字幕」状态下生效；
// 焦点在输入框/文本域/可编辑元素或内联编辑态时，保留浏览器原生的「全选文本」行为。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'a' && e.key !== 'A') return;
  if (!e.ctrlKey && !e.metaKey) return;
  if (e.altKey || e.shiftKey) return;
  if (editingState) return;
  if (e.target === cuePanelText) return;
  const a = document.activeElement;
  if (a && (
    a.tagName === 'INPUT'
    || a.tagName === 'TEXTAREA'
    || a.tagName === 'SELECT'
    || a.isContentEditable
  )) return;
  if (replaceModal.classList.contains('show')) return;
  if (stickerModal.classList.contains('show')) return;
  if (stickerPreviewModal.classList.contains('show')) return;
  if (projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (ctxmenu.classList.contains('show')) return;
  e.preventDefault();
  selectAll();
});

// Ctrl(Cmd)+D：取消选中（清空当前字幕选择）。浏览器默认是「添加书签」，这里接管；
// 与 Ctrl(Cmd)+A 同样仅在非编辑字幕状态下生效。ESC 清除选中的行为保持不变。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'd' && e.key !== 'D') return;
  if (!e.ctrlKey && !e.metaKey) return;
  if (e.altKey || e.shiftKey) return;
  if (editingState) return;
  if (e.target === cuePanelText) return;
  const a = document.activeElement;
  if (a && (
    a.tagName === 'INPUT'
    || a.tagName === 'TEXTAREA'
    || a.tagName === 'SELECT'
    || a.isContentEditable
  )) return;
  if (replaceModal.classList.contains('show')) return;
  if (stickerModal.classList.contains('show')) return;
  if (stickerPreviewModal.classList.contains('show')) return;
  if (projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (ctxmenu.classList.contains('show')) return;
  if (selectedIdxs.size === 0) return;
  e.preventDefault();
  clearSelection();
});

// T：给选中字幕分配表情包。单选直接分配本条，多选统一分配（与右键菜单一致）。
document.addEventListener('keydown', (e) => {
  if (e.key !== 't' && e.key !== 'T') return;
  if (editingState || e.repeat) return;
  const a = document.activeElement;
  if (a && (
    a.tagName === 'INPUT'
    || a.tagName === 'TEXTAREA'
    || a.tagName === 'SELECT'
    || a.isContentEditable
  )) return;
  if (replaceModal.classList.contains('show')) return;
  if (stickerModal.classList.contains('show')) return;
  if (stickerPreviewModal.classList.contains('show')) return;
  if (projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (ctxmenu.classList.contains('show')) return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  if (selectedIdxs.size === 0) return;
  e.preventDefault();
  const idxs = [...selectedIdxs].sort((x, y) => x - y);
  openStickerPicker(idxs, idxs.length > 1);
});

// 数字键 1~5：给选中字幕标记对应颜色（红黄蓝绿紫）；0：清除颜色。
document.addEventListener('keydown', (e) => {
  if (!/^[0-5]$/.test(e.key)) return;
  if (editingState || e.repeat) return;
  const a = document.activeElement;
  if (a && (
    a.tagName === 'INPUT'
    || a.tagName === 'TEXTAREA'
    || a.tagName === 'SELECT'
    || a.isContentEditable
  )) return;
  if (replaceModal.classList.contains('show')) return;
  if (stickerModal.classList.contains('show')) return;
  if (stickerPreviewModal.classList.contains('show')) return;
  if (projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (ctxmenu.classList.contains('show')) return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  if (selectedIdxs.size === 0) return;
  e.preventDefault();
  const idxs = [...selectedIdxs].sort((x, y) => x - y);
  if (e.key === '0') {
    clearColorOnTargets(idxs);
    return;
  }
  const color = COLOR_PALETTE[Number(e.key) - 1];
  if (color) assignColor(idxs, color.name);
});

// Enter：按「最后激活的编辑区域」分发——最后点击的是字幕列表时，对当前单选
// 字幕直接开始原地编辑（等同双击该行）；否则回到旧行为，聚焦字幕编辑区文本框
// 并把光标置于末尾。内联编辑态、已聚焦编辑区或模态打开时不触发。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (editingState) return;  // 内联编辑态的 Enter 交给 split/commit 处理
  if (e.target === cuePanelText) return;  // 已在字幕编辑区
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;  // 仅响应裸 Enter
  const a = document.activeElement;
  if (a && (
    a.tagName === 'INPUT'
    || a.tagName === 'TEXTAREA'
    || a.tagName === 'SELECT'
    || a.tagName === 'BUTTON'
    || a.isContentEditable
  )) return;
  if (replaceModal.classList.contains('show')) return;
  if (stickerModal.classList.contains('show')) return;
  if (stickerPreviewModal.classList.contains('show')) return;
  if (projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (ctxmenu.classList.contains('show')) return;
  if (selectedIdxs.size !== 1) return;
  if (lastEditRegion === 'cue-list') {
    const context = hoveredSelectedCueContext();
    const idx = context ? context.idx : [...selectedIdxs][0];
    if (!DATA.segments[idx]) return;
    const el = context ? context.el : container.querySelector(`.cue[data-idx="${idx}"]`);
    if (!el) return;
    e.preventDefault();
    // 鼠标仍在行上时按指针位置落光标；否则全选文本，便于直接键入替换。
    if (context) startEdit(context.el, context.idx, context.x, context.y);
    else {
      scrollCueIntoViewIfNeeded(el);
      startEdit(el, idx);
    }
    return;
  }
  const idx = currentCuePanelIdx;
  if (idx < 0 || !DATA.segments[idx]) return;
  e.preventDefault();
  cuePanelText.focus();
  const end = cuePanelText.value.length;
  cuePanelText.setSelectionRange(end, end);
});

// C：合并连续选中的字幕块。少于两条时只提示，不改动工程。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'c' && e.key !== 'C') return;
  if (editingState || e.repeat) return;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return;
  if (replaceModal.classList.contains('show')) return;
  if (stickerModal.classList.contains('show')) return;
  if (stickerPreviewModal.classList.contains('show')) return;
  if (projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (ctxmenu.classList.contains('show')) return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  e.preventDefault();
  e.stopPropagation();
  mergeSegments([...selectedIdxs]);
});


// Ctrl(Cmd)+Z 撤销；Ctrl(Cmd)+Shift+Z 或 Ctrl(Cmd)+Y 重做
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

// 波形工具切换：V=选择（默认），R=剃刀，Esc=切回选择。与 J/K/L 一样只在
// 非输入/非模态/非编辑态下触发，避免抢占文本编辑与弹窗按键。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'v' && e.key !== 'V' && e.key !== 'r' && e.key !== 'R' && e.key !== 'Escape') return;
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

// F：跳转并播放选中字幕（多选跳到第一条）。任意单击行为下都生效；
// 文本编辑、弹窗和修饰键状态下不抢占输入。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'f' && e.key !== 'F') return;
  if (editingState || e.repeat) return;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return;
  if (replaceModal.classList.contains('show')) return;
  if (stickerModal.classList.contains('show')) return;
  if (stickerPreviewModal.classList.contains('show')) return;
  if (projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (ctxmenu.classList.contains('show')) return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  if (!selectedIdxs.size) return;
  const first = Math.min(...selectedIdxs);
  seekFromWaveform(DATA.segments[first].start / 1000);
  if (player.paused) togglePlayback();
});

// B：按指针所在区域分发——
// 1) 鼠标悬停在已单选的字幕列表行上：按指针对应的文字位置拆分；
// 2) 鼠标位于波形上：按指针的音频位置拆分（与波形右键「按音频位置拆分」一致）；
// 3) 其它位置：按红色播放指针位置拆分（B 的原始行为）。
// 文本编辑、弹窗和修饰键状态下不抢占输入。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'b' && e.key !== 'B') return;
  if (editingState || e.repeat) return;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return;
  if (replaceModal.classList.contains('show')) return;
  if (stickerModal.classList.contains('show')) return;
  if (stickerPreviewModal.classList.contains('show')) return;
  if (projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (ctxmenu.classList.contains('show')) return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  const splitAt = (idx, x, y, timeMs) => {
    e.preventDefault();
    e.stopPropagation();
    splitFromContextMenu(idx, x, y, timeMs);
  };
  // 1) 字幕列表：需要单选 + 悬停提供文字位置
  if (selectedIdxs.size === 1) {
    const context = hoveredSelectedCueContext();
    if (context && DATA.segments[context.idx]) {
      splitAt(context.idx, context.x, context.y, null);
      return;
    }
  }
  // 2) 波形：指针音频位置
  if (lastPointerPos) {
    const pointerTimeMs = waveformEditor?.timeMsAtPoint?.(lastPointerPos.x, lastPointerPos.y);
    if (Number.isFinite(pointerTimeMs)) {
      const idx = DATA.segments.findIndex((segment) => pointerTimeMs > segment.start && pointerTimeMs < segment.end);
      if (idx < 0) {
        flashHint('指针位置没有可拆分字幕');
        return;
      }
      splitAt(idx, 0, 0, pointerTimeMs);
      return;
    }
  }
  // 3) 播放头位置
  const timeMs = Math.round(player.currentTime * 1000);
  const idx = DATA.segments.findIndex((segment) => timeMs > segment.start && timeMs < segment.end);
  if (idx < 0) {
    flashHint('播放头位置没有可拆分字幕');
    return;
  }
  splitAt(idx, 0, 0, timeMs);
});

// 点击外部 -> 完成编辑
document.addEventListener('mousedown', (e) => {
  if (!editingState) return;
  if (!editingState.el.contains(e.target)) finishEdit(true);
});

// === 字幕预览几何（preview.subtitle）===
// 归一化 {x,y,width,height} 存于 DATA.preview.subtitle。纯钳制/归一化逻辑在
// AsrEditorUtils（已单测）；这里只负责 DOM 应用、指针/键盘手势、每手势一条撤销、脏标记。
const GEO_UTILS = window.AsrEditorUtils;
let previewGeometryDirty = false;

function getPreviewGeometry() {
  return GEO_UTILS.normalizePreviewGeometry(DATA.preview?.subtitle);
}
function normalizeSubtitleAppearance(value) {
  const result = {};
  const fontSize = value && typeof value.font_size === 'number' && Number.isFinite(value.font_size)
    ? Math.round(value.font_size) : null;
  if (fontSize !== null && fontSize >= SUBTITLE_FONT_SIZE_MIN && fontSize <= SUBTITLE_FONT_SIZE_MAX) {
    result.font_size = fontSize;
  }
  if (value && typeof value.font_family === 'string'
      && Object.prototype.hasOwnProperty.call(SUBTITLE_FONT_FAMILY_CSS, value.font_family)) {
    result.font_family = value.font_family;
  }
  return result;
}
function getSubtitleAppearance(value = DATA.preview?.subtitle) {
  return normalizeSubtitleAppearance(value);
}
function syncSubtitleAppearanceControls(appearance = getSubtitleAppearance()) {
  if (subtitleFontSizeSelect) {
    const size = appearance.font_size ? String(appearance.font_size) : 'auto';
    subtitleFontSizeSelect.querySelectorAll('option[data-generated="true"]').forEach((option) => option.remove());
    if (size !== 'auto' && !Array.from(subtitleFontSizeSelect.options).some((option) => option.value === size)) {
      const option = document.createElement('option');
      option.value = size;
      option.textContent = `${size} px`;
      option.dataset.generated = 'true';
      subtitleFontSizeSelect.append(option);
    }
    subtitleFontSizeSelect.value = size;
  }
  if (subtitleFontFamilySelect) {
    subtitleFontFamilySelect.value = appearance.font_family
      && Object.prototype.hasOwnProperty.call(SUBTITLE_FONT_FAMILY_CSS, appearance.font_family)
      ? appearance.font_family : 'default';
  }
}
function applySubtitleAppearance(value = DATA.preview?.subtitle) {
  const appearance = getSubtitleAppearance(value);
  overlayTextEl.style.fontSize = appearance.font_size ? `${appearance.font_size}px` : '';
  overlayTextEl.style.fontFamily = appearance.font_family
    ? SUBTITLE_FONT_FAMILY_CSS[appearance.font_family] : '';
  syncSubtitleAppearanceControls(appearance);
}
function setSubtitleAppearance(patch, { markDirty = true } = {}) {
  const next = { ...getSubtitleAppearance() };
  if (Object.prototype.hasOwnProperty.call(patch, 'font_size')) {
    if (patch.font_size === null || patch.font_size === 'auto') delete next.font_size;
    else Object.assign(next, normalizeSubtitleAppearance({ font_size: patch.font_size }));
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'font_family')) {
    if (!patch.font_family || patch.font_family === 'default') delete next.font_family;
    else Object.assign(next, normalizeSubtitleAppearance({ font_family: patch.font_family }));
  }
  if (!DATA.preview || typeof DATA.preview !== 'object') DATA.preview = {};
  DATA.preview.subtitle = { ...getPreviewGeometry(), ...next };
  if (markDirty) previewGeometryDirty = true;
  applySubtitleAppearance(DATA.preview.subtitle);
  return next;
}
// 写回 DATA.preview.subtitle 并刷新 DOM。markDirty=false 用于初次加载，不弄脏工程。
function setPreviewGeometry(geo, { markDirty = true } = {}) {
  const clamped = GEO_UTILS.clampPreviewGeometry(GEO_UTILS.normalizePreviewGeometry(geo));
  const appearance = { ...getSubtitleAppearance(), ...getSubtitleAppearance(geo) };
  if (!DATA.preview || typeof DATA.preview !== 'object') DATA.preview = {};
  DATA.preview.subtitle = { ...clamped, ...appearance };
  if (markDirty) previewGeometryDirty = true;
  applyPreviewGeometryToDom(clamped);
  applySubtitleAppearance(DATA.preview.subtitle);
  return clamped;
}
function applyPreviewGeometryToDom(geo) {
  const css = GEO_UTILS.previewGeometryToCss(geo);
  overlayEl.style.left = css.left;
  overlayEl.style.top = css.top;
  overlayEl.style.width = css.width;
  overlayEl.style.height = css.height;
  overlayEl.style.right = 'auto';
  overlayEl.style.bottom = 'auto';
}
// === 表情包预览几何（preview.sticker）===
// 与字幕预览同一套归一化/钳制逻辑，仅默认值不同（右上角小图）。
function getStickerGeometry() {
  return GEO_UTILS.normalizePreviewGeometry(DATA.preview?.sticker, GEO_UTILS.DEFAULT_STICKER_GEOMETRY);
}
// 写回 DATA.preview.sticker 并刷新 DOM。markDirty=false 用于初次加载，不弄脏工程。
function setStickerGeometry(geo, { markDirty = true } = {}) {
  const clamped = GEO_UTILS.clampPreviewGeometry(
    GEO_UTILS.normalizePreviewGeometry(geo, GEO_UTILS.DEFAULT_STICKER_GEOMETRY),
  );
  if (!DATA.preview || typeof DATA.preview !== 'object') DATA.preview = {};
  DATA.preview.sticker = clamped;
  if (markDirty) previewGeometryDirty = true;
  applyStickerGeometryToDom(clamped);
  return clamped;
}
function applyStickerGeometryToDom(geo) {
  const css = GEO_UTILS.previewGeometryToCss(geo);
  stickerOverlayLayer.style.left = css.left;
  stickerOverlayLayer.style.top = css.top;
  stickerOverlayLayer.style.width = css.width;
  stickerOverlayLayer.style.height = css.height;
  stickerOverlayLayer.style.right = 'auto';
  stickerOverlayLayer.style.bottom = 'auto';
}
// 只有当对应预览开关开启时才允许几何编辑（关闭时字幕盒完全隐藏、表情包盒不拦截指针）。
function refreshPreviewGeometryEditable() {
  overlayEl.classList.toggle('geometry-enabled', !!overlayToggle.checked);
  stickerOverlayLayer.classList.toggle('geometry-enabled', !!stickerOverlayToggle?.checked);
}

// --- 指针拖动 / 缩放（Pointer Events），字幕预览与表情包预览共用 ---
let previewGesture = null;  // { pointerId, handle, target, startX, startY, startGeo, rect }
function previewTargetEl(target) { return target === 'sticker' ? stickerOverlayLayer : overlayEl; }
function previewTargetEnabled(target) {
  return target === 'sticker' ? !!stickerOverlayToggle?.checked : !!overlayToggle.checked;
}
function getTargetGeometry(target) { return target === 'sticker' ? getStickerGeometry() : getPreviewGeometry(); }
function setTargetGeometry(target, geo) {
  if (target === 'sticker') setStickerGeometry(geo); else setPreviewGeometry(geo);
}
function playerStageRect() {
  return playerStage.getBoundingClientRect();
}
function beginPreviewGesture(event, handle, target) {
  if (!previewTargetEnabled(target)) return;
  const rect = playerStageRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  event.preventDefault();
  event.stopPropagation();
  const targetLabel = target === 'sticker' ? '表情包预览' : '字幕预览';
  // 一手势一撤销：在手势开始时压入手势前的快照。
  pushPreviewUndo((handle === 'move' ? '移动' : '缩放') + targetLabel, snapshotPreviewState());
  previewGesture = {
    pointerId: event.pointerId,
    handle,
    target,
    startX: event.clientX,
    startY: event.clientY,
    startGeo: getTargetGeometry(target),
    rect,
  };
  previewTargetEl(target).classList.add('dragging', 'editable');
  try { event.target.setPointerCapture?.(event.pointerId); } catch (_) {}
}
function movePreviewGesture(event) {
  if (!previewGesture || event.pointerId !== previewGesture.pointerId) return;
  const { rect, startX, startY, startGeo, handle, target } = previewGesture;
  const dx = (event.clientX - startX) / rect.width;
  const dy = (event.clientY - startY) / rect.height;
  const next = GEO_UTILS.applyPreviewGeometryDelta(startGeo, handle, dx, dy);
  setTargetGeometry(target, next);
}
function endPreviewGesture(event) {
  if (!previewGesture || event.pointerId !== previewGesture.pointerId) return;
  try { event.target.releasePointerCapture?.(event.pointerId); } catch (_) {}
  previewTargetEl(previewGesture.target).classList.remove('dragging');
  previewGesture = null;
}
function bindPreviewBoxPointerEvents(el, target) {
  el.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    // beginPreviewGesture 的 preventDefault 会阻止默认聚焦，显式聚焦让调整框随 :focus 显示
    el.focus();
    const handleEl = event.target.closest?.('.overlay-handle');
    const handle = handleEl ? handleEl.dataset.handle : 'move';
    beginPreviewGesture(event, handle, target);
  });
  el.addEventListener('pointermove', movePreviewGesture);
  el.addEventListener('pointerup', endPreviewGesture);
  el.addEventListener('pointercancel', endPreviewGesture);
}
bindPreviewBoxPointerEvents(overlayEl, 'subtitle');

// --- 键盘操作（聚焦时），字幕预览与表情包预览共用 ---
// 方向键移动 1%；Shift 加速到 10%；Alt+方向缩放；Enter 切换 editable；Esc 失焦。
function handlePreviewBoxKeydown(event, target) {
  if (!previewTargetEnabled(target)) return;
  const el = previewTargetEl(target);
  if (event.key === 'Escape') { el.blur(); return; }
  if (event.key === 'Enter') {
    event.preventDefault();
    el.classList.toggle('editable');
    return;
  }
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const dir = arrows[event.key];
  if (!dir) return;
  event.preventDefault();
  const step = event.shiftKey ? 0.10 : 0.01;
  const resize = event.altKey;  // Alt+方向缩放；否则移动
  const dx = dir[0] * step;
  const dy = dir[1] * step;
  const targetLabel = target === 'sticker' ? '表情包预览' : '字幕预览';
  pushPreviewUndo((resize ? '缩放' : '移动') + targetLabel, snapshotPreviewState());
  const startGeo = getTargetGeometry(target);
  const next = resize
    ? GEO_UTILS.applyPreviewGeometryDelta(startGeo, dir[0] !== 0 ? 'e' : 's', dx, dy)
    : GEO_UTILS.applyPreviewGeometryDelta(startGeo, 'move', dx, dy);
  setTargetGeometry(target, next);
}
overlayEl.addEventListener('keydown', (event) => handlePreviewBoxKeydown(event, 'subtitle'));

// 点击预览框（字幕/表情包）以外的地方：失焦并退出控制点编辑态，调整框随之隐藏。
// 捕获阶段监听，避免其他组件 pointerdown 的 stopPropagation 跳过失焦。
document.addEventListener('pointerdown', (event) => {
  if (previewGesture) return;
  [overlayEl, stickerOverlayLayer].forEach((el) => {
    if (el.contains(event.target)) return;
    el.classList.remove('editable');
    if (document.activeElement === el) el.blur();
  });
}, true);

// 播放器缩放时几何以百分比表达，天然自适应；ResizeObserver 仅在盒子越界后回钳。
if (typeof ResizeObserver === 'function') {
  const previewResizeObserver = new ResizeObserver(() => {
    applyPreviewGeometryToDom(getPreviewGeometry());
  });
  previewResizeObserver.observe(playerStage);
}

// === 当前行高亮 + overlay ===
let lastActive = -1;
// 列表点击关闭自动滚动时，避免这次 seek 的同步 active 更新再次滚动列表。
let suppressCueListAutoScroll = false;
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

function updateActiveCue(idx) {
  if (idx === lastActive) return;
  if (lastActive >= 0) {
    const prev = container.querySelector(`.cue[data-idx="${lastActive}"]`);
    if (prev) prev.classList.remove('active');
  }
  if (idx >= 0) {
    const cur = container.querySelector(`.cue[data-idx="${idx}"]`);
    if (cur) {
      cur.classList.add('active');
      if (!editingState && !suppressCueListAutoScroll) scrollCueIntoViewIfNeeded(cur);
    }
  }
  lastActive = idx;
}

function updateSubtitleOverlay(tMs, idx) {
  // overlay（禁用项不在画面上显示字幕文本）
  if (!overlayToggle.checked) return;
  const seg = idx >= 0 ? DATA.segments[idx] : null;
  if (seg && !seg.disabled && tMs >= seg.start && tMs <= seg.end) {
    overlayEl.classList.remove('hidden');
    if (overlayTextEl.textContent !== seg.text) overlayTextEl.textContent = seg.text;
  } else {
    overlayEl.classList.add('hidden');
  }
}

function updatePlaybackFrame() {
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
  const nowLabel = fmtShort(tMs);
  if (nowEl.textContent !== nowLabel) nowEl.textContent = nowLabel;
  const idx = findActive(tMs);
  updateActiveCue(idx);
  updateSubtitleOverlay(tMs, idx);
  waveformEditor?.updatePlayback();
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
  updateActiveCue(idx);
  updateSubtitleOverlay(tMs, idx);
  renderStickerOverlay(tMs);
}
// === 表情包预览（视频画面内）===
// 层位置/尺寸由 preview.sticker 几何驱动（默认右上角）；点击后可拖动/缩放，与字幕预览同一套交互。
const stickerOverlayLayer = document.createElement('div');
stickerOverlayLayer.id = 'sticker-overlay-layer';
stickerOverlayLayer.className = 'geo-box';
stickerOverlayLayer.tabIndex = 0;
stickerOverlayLayer.setAttribute('role', 'group');
stickerOverlayLayer.setAttribute('aria-label', '表情包预览位置。可拖动调整；方向键移动，按住 Shift 加速，按住 Alt 配合方向键调整大小，Enter 显示控制点，Esc 退出。');
const stickerOverlayContent = document.createElement('div');
stickerOverlayContent.className = 'sticker-overlay-content';
stickerOverlayLayer.appendChild(stickerOverlayContent);
['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach((h) => {
  const handle = document.createElement('span');
  handle.className = 'overlay-handle';
  handle.dataset.handle = h;
  stickerOverlayLayer.appendChild(handle);
});
playerStage.appendChild(stickerOverlayLayer);
bindPreviewBoxPointerEvents(stickerOverlayLayer, 'sticker');
stickerOverlayLayer.addEventListener('keydown', (event) => handlePreviewBoxKeydown(event, 'sticker'));

function activeStickersAt(tMs) {
  const found = new Map();  // 同组 head/ref 去重，按文件名键
  DATA.segments.forEach((seg) => {
    if (seg.disabled) return;
    if (seg.sticker) {
      const start = seg.sticker.start ?? seg.start;
      const end = seg.sticker.end ?? seg.end;
      if (tMs >= start && tMs <= end) found.set(seg.sticker.filename || seg.sticker.name, seg.sticker);
      return;
    }
    const ref = seg.sticker_ref;
    if (!ref) return;
    const headSeg = DATA.segments[ref.headIdx];
    const source = headSeg?.sticker;
    if (source && tMs >= (source.start ?? headSeg.start) && tMs <= (source.end ?? headSeg.end)) {
      found.set(source.filename || source.name, source);
    }
  });
  return [...found.values()];
}

function renderStickerOverlay(tMs) {
  if (!stickerOverlayToggle?.checked) { stickerOverlayContent.replaceChildren(); return; }
  stickerOverlayContent.replaceChildren(...activeStickersAt(tMs).map((sticker) => {
    const img = document.createElement('img');
    img.src = stickerUrl(sticker);
    img.alt = sticker.name;
    img.title = sticker.name;
    return img;
  }));
}

stickerOverlayToggle?.addEventListener('change', () => {
  updateEditorSettings({ stickerOverlayEnabled: stickerOverlayToggle.checked });
  refreshPreviewGeometryEditable();
  update();
});

// 初次应用（不弄脏工程）：字幕与表情包预览几何。必须在 stickerOverlayLayer 创建之后执行（TDZ）。
setPreviewGeometry(getPreviewGeometry(), { markDirty: false });
setStickerGeometry(getStickerGeometry(), { markDirty: false });
refreshPreviewGeometryEditable();

bindPlayerEvents(player);
overlayToggle.addEventListener('change', () => {
  // change 触发时 checked 已是新值；压入改变前的状态（overlay 取反、几何为当前值）作为撤销点
  pushPreviewUndo('切换字幕预览', {
    overlay: !overlayToggle.checked,
    subtitle: { ...getPreviewGeometry() },
  });
  updateEditorSettings({ overlayEnabled: overlayToggle.checked });
  refreshPreviewGeometryEditable();
  if (!overlayToggle.checked) overlayEl.classList.add('hidden');
  else update();
});

// === 下载 ===
// 程序内开关（不暴露 GUI）：导出 SRT 时保留禁用项的时间轴序号但内容替换为空白
let EXPORT_KEEP_DISABLED_PLACEHOLDER = false;

function buildSrt() {
  const parts = [];
  const firstEnabledIndex = window.AsrEditorUtils.getSrtExportFirstIndex(
    DATA.segments,
    EDITOR_SETTINGS.exportStartAtZero,
  );
  const exportTime = (timeMs) => fmtSrtTime(Math.max(0, Math.round(Number(timeMs) || 0)));
  let n = 0;  // 导出序号：跳过禁用项后重新连续编号
  DATA.segments.forEach((seg, index) => {
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
    const start = EDITOR_SETTINGS.exportStartAtZero && index === firstEnabledIndex
      ? fmtSrtTime(0)
      : exportTime(seg.start);
    parts.push(`${start} --> ${exportTime(seg.end)}`);
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
  const firstEnabledIndex = window.AsrEditorUtils.getSrtExportFirstIndex(
    DATA.segments,
    EDITOR_SETTINGS.exportStartAtZero,
  );
  DATA.segments.forEach((segment, index) => {
    if (segment.disabled) return;
    number++;
    const mappedStart = window.AsrEditorUtils.mapGapRemovedTime(segment.start, removed);
    const start = EDITOR_SETTINGS.exportStartAtZero && index === firstEnabledIndex
      ? 0
      : mappedStart;
    const end = window.AsrEditorUtils.mapGapRemovedTime(segment.end, removed);
    parts.push(String(number));
    parts.push(`${fmtSrtTime(start)} --> ${fmtSrtTime(Math.max(start + 1, end))}`);
    parts.push(segment.text);
    parts.push('');
  });
  return parts.join('\n');
}

function usedSubtitleColors() {
  const names = new Set(DATA.segments.filter((segment) => !segment.disabled).map((segment) => (
    window.AsrEditorUtils.effectiveColorName(segment, DATA.segments) || 'default'
  )).filter((name) => name === 'default' || COLOR_BY_NAME[name]));
  return [
    ...COLOR_PALETTE.filter((color) => names.has(color.name)),
    ...(names.has('default') ? [{ name: 'default', label: '默认' }] : []),
  ];
}

function updateSubtitleExportUi() {
  const hasColors = usedSubtitleColors().some((color) => color.name !== 'default');
  if (downloadSrtButton) downloadSrtButton.hidden = hasColors;
  if (subtitleExportDropdown) {
    subtitleExportDropdown.hidden = !hasColors;
    if (!hasColors) subtitleExportDropdown.classList.remove('open');
  }
}

async function downloadColorSrts(gapRemoved = false) {
  if (editingState) finishEdit(true);
  const colors = usedSubtitleColors();
  const removed = gapRemoved ? getRemovedGapRanges() : [];
  if (!colors.length) {
    flashHint('没有可导出的彩色字幕');
    return;
  }
  if (gapRemoved && !removed.length) {
    flashHint('没有已移除的静音空隙；请先使用「移除静音空隙」扫描并移除');
    return;
  }
  const firstEnabledIndex = window.AsrEditorUtils.getSrtExportFirstIndex(
    DATA.segments,
    EDITOR_SETTINGS.exportStartAtZero,
  );
  const gapSuffix = gapRemoved ? '_gap-removed' : '';
  const buildPayload = (color) => window.AsrEditorUtils.buildSrtPayload(DATA.segments, {
    colorName: color.name,
    timeOffset: 0,
    alignFirstStart: EDITOR_SETTINGS.exportStartAtZero,
    firstEnabledIndex,
    mapTime: gapRemoved
      ? (timeMs) => window.AsrEditorUtils.mapGapRemovedTime(timeMs, removed)
      : undefined,
    ensurePositiveDuration: gapRemoved,
    formatTime: fmtSrtTime,
  });
  let filenameBase = `${FILENAME_BASE}${gapSuffix}`;
  // 浏览器不允许从一个文件句柄取得其父目录，因此不再请求文件夹权限。
  // 先让用户选择一个 SRT 文件名，并把该名称（不含 .srt）作为所有颜色文件的前缀。
  if (EDITOR_SETTINGS.exportColorUnified && window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        id: 'maw-color-srt-export-prefix',
        suggestedName: `${filenameBase}.srt`,
        types: [{ description: 'SRT 字幕文件（作为导出前缀）', accept: { 'text/plain': ['.srt'] } }],
      });
      filenameBase = handle.name.replace(/\.srt$/i, '') || filenameBase;
    } catch (e) {
      // 用户取消文件名选择 — 静默退出，不回退
      if (e && e.name === 'AbortError') return;
      // 其他错误（如安全限制）：回退到默认文件名前缀。
    }
  }
  for (const color of colors) {
    const filename = `${filenameBase}_${color.name}.srt`;
    if (EDITOR_SETTINGS.exportColorUnified) {
      const blob = new Blob([buildPayload(color)], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor); anchor.click(); document.body.removeChild(anchor);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } else {
      const saved = await downloadFile(
        buildPayload(color), filename, 'text/plain',
        { desc: `${color.label}色字幕 SRT`, types: { 'text/plain': ['.srt'] } },
      );
      if (!saved) return;
    }
  }
  flashHint(`已按颜色导出 ${colors.length} 份字幕`);
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
  const workspace = buildCurrentWorkspaceData();
  if (workspace) out.workspace = workspace;
  // 预览几何：始终写入归一化后的当前几何，便于跨机/重开保持位置。
  out.preview = { subtitle: { ...getPreviewGeometry(), ...getSubtitleAppearance() } };
  return JSON.stringify(out, null, 2);
}

function buildWorkspaceJson() {
  const workspace = buildCurrentWorkspaceData();
  return JSON.stringify(workspace || {}, null, 2);
}

function buildCurrentWorkspaceData() {
  const workspace = waveformEditor?.getLayoutData?.() || DATA.workspace;
  if (!workspace) return workspace;
  const selectedPreset = currentServerWorkspaceName
    ? `saved:${currentServerWorkspaceName}`
    : currentBuiltinWorkspaceName || workspacePresetSelect?.value || workspace.preset;
  return { ...workspace, selectedPreset, editorDisplay: getEditorDisplaySettings() };
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
  // 传空数组而非 null：函数体内用 removed.length 判断是否走去空隙映射分支，
  // 空数组 .length===0（falsy）正确退化为原始时间线，且避免 null.length 崩溃。
  const collected = collectStickerOtioEntries([]);
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

// === 标题区：媒体名点击复制 / 工程文件名点击复制 ===
function copyText(text, hint) {
  navigator.clipboard.writeText(text).then(
    () => flashHint(hint || `已复制：${text}`),
    () => { /* 降级：exec */ document.execCommand('copy'); flashHint(hint || `已复制：${text}`); }
  );
}

let projectLoadedFromSrt = false;

function serverProjectSavingEnabled() {
  return !!(SERVER_CONFIG && SERVER_CONFIG.saveUrl && SERVER_CONFIG.canSave && !projectLoadedFromSrt);
}

function parseProjectValidationTarget(detail) {
  const match = /^\$\.segments\[(\d+)\](?:\.items\[(\d+)\])?(?:\.[A-Za-z_]\w*)?\s*:/.exec(String(detail || ''));
  if (!match) return null;
  const segmentIndex = Number(match[1]);
  const itemIndex = match[2] === undefined ? null : Number(match[2]);
  const segment = DATA.segments[segmentIndex];
  if (!segment) return null;
  const item = itemIndex === null
    ? null
    : (Array.isArray(segment.items) ? segment.items[itemIndex] : null);
  return {
    segmentIndex,
    itemIndex,
    segment,
    item: item && typeof item === 'object' ? item : null,
  };
}

function validationPreviewText(target) {
  const value = target.item?.text ?? target.segment.text;
  if (typeof value === 'string') return value || '（空）';
  try {
    return JSON.stringify(target.item || target.segment);
  } catch (_) {
    return '（无法预览）';
  }
}

function focusProjectValidationTarget(target) {
  const { segmentIndex, segment } = target || {};
  if (!segment || !DATA.segments[segmentIndex]) return;

  // 校验错误不能因为用户当前的筛选状态而再次变得不可见。
  if (hideDisabled && segment.disabled) {
    hideDisabled = false;
    hideDisabledToggle.checked = false;
    container.classList.remove('hide-disabled');
  }
  const cueBeforeFilter = container.querySelector(`.cue[data-idx="${segmentIndex}"]`);
  if (cueBeforeFilter?.classList.contains('hidden')) {
    searchEl.value = '';
    refreshSearchClearVisibility();
    const filterOver = document.getElementById('filter-over');
    if (filterOver?.classList.contains('active')) filterOver.classList.remove('active');
    applySearch('');
  }

  selectOnly(segmentIndex);
  lastClickedIdx = segmentIndex;
  const cue = container.querySelector(`.cue[data-idx="${segmentIndex}"]`);
  if (cue) {
    cue.classList.remove('validation-target');
    // 重新触发一次短暂的高亮，即使用户连续点击多个错误提示也能看出目标。
    void cue.offsetWidth;
    cue.classList.add('validation-target');
    scrollCueToCenter(cue);
    window.setTimeout(() => cue.classList.remove('validation-target'), 2200);
  }
  waveformEditor?.revealTime(segment.start, true);
  if (hasLoadedMedia()) seekFromWaveform(segment.start / 1000);
}

function showProjectSaveError(detail) {
  const target = parseProjectValidationTarget(detail);
  if (!target) {
    flashHint(`保存失败：${detail}`, 'warning');
    return;
  }

  flashHint('', 'warning', {
    durationMs: 12000,
    contentBuilder: (card) => {
      card.classList.add('hint-project-error');

      const header = document.createElement('div');
      header.className = 'hint-project-header';
      const title = document.createElement('strong');
      title.textContent = '保存失败';
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'hint-close';
      close.setAttribute('aria-label', '关闭提示');
      close.textContent = '×';
      close.addEventListener('click', () => dismissHintCard(card));
      header.append(title, close);

      const detailEl = document.createElement('code');
      detailEl.className = 'hint-project-detail';
      detailEl.textContent = String(detail || '未知校验错误');

      const location = document.createElement('div');
      location.className = 'hint-project-location';
      location.textContent = target.itemIndex === null
        ? `第 ${target.segmentIndex + 1} 条字幕`
        : `第 ${target.segmentIndex + 1} 条字幕 · item ${target.itemIndex + 1}`;

      const previewLabel = document.createElement('div');
      previewLabel.className = 'hint-project-preview-label';
      previewLabel.textContent = target.itemIndex === null ? '字幕内容' : 'item 内容';
      const preview = document.createElement('div');
      preview.className = 'hint-project-preview-value';
      preview.textContent = validationPreviewText(target);

      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'hint-project-action';
      action.textContent = `定位到第 ${target.segmentIndex + 1} 条字幕`;
      action.addEventListener('click', () => {
        focusProjectValidationTarget(target);
        dismissHintCard(card);
      });

      card.append(header, detailEl, location, previewLabel, preview, action);
    },
  });
}

function configureServerSaveControls() {
  const hasServer = !!(SERVER_CONFIG && SERVER_CONFIG.saveUrl);
  if (saveProjectDropdown) saveProjectDropdown.hidden = !hasServer;
  [saveProjectButton, document.getElementById('save-project-menu-btn')].forEach((button) => {
    if (!button) return;
    button.disabled = !serverProjectSavingEnabled();
     if (!serverProjectSavingEnabled()) button.title = '请用带工程文件路径的服务器命令启动，才能直接保存';
  });
  if (saveProjectButton && serverProjectSavingEnabled()) {
    saveProjectButton.title = '保存回当前工程文件（Ctrl(Cmd)+S）';
  }
  // 另存为走系统文件对话框，不依赖服务器绑定，始终可用。
  if (saveProjectAsButton) {
    saveProjectAsButton.title = '另存为工程文件（Ctrl(Cmd)+Shift+S）';
  }
}

let autoSaveTimer = null;
let projectSaveInFlight = false;

function scheduleAutoSave() {
  if (autoSaveTimer !== null) {
    window.clearInterval(autoSaveTimer);
    autoSaveTimer = null;
  }
  if (!serverProjectSavingEnabled() || !EDITOR_SETTINGS.autoSaveProject) return;
  autoSaveTimer = window.setInterval(() => {
    if (hasUnsavedProjectChanges() && !projectSaveInFlight) void saveProjectToServer({ silent: true });
  }, EDITOR_SETTINGS.autoSaveIntervalSeconds * 1000);
}

function configureServerAutoSave() {
  if (!serverAutoSaveSettings || !autoSaveProjectToggle || !autoSaveIntervalField || !autoSaveIntervalInput) return;
  const available = serverProjectSavingEnabled();
  serverAutoSaveSettings.hidden = !available;
  if (!available) return;
  const sync = () => {
    autoSaveProjectToggle.checked = EDITOR_SETTINGS.autoSaveProject;
    autoSaveIntervalInput.value = String(EDITOR_SETTINGS.autoSaveIntervalSeconds);
    autoSaveIntervalField.hidden = !EDITOR_SETTINGS.autoSaveProject;
  };
  sync();
  autoSaveProjectToggle.addEventListener('change', () => {
    updateEditorSettings({ autoSaveProject: autoSaveProjectToggle.checked });
    sync();
    scheduleAutoSave();
  });
  autoSaveIntervalInput.addEventListener('change', () => {
    updateEditorSettings({ autoSaveIntervalSeconds: clampAutoSaveInterval(autoSaveIntervalInput.value) });
    sync();
    scheduleAutoSave();
  });
  scheduleAutoSave();
}

function hasUnsavedProjectChanges() {
  return gapRemoveDirty || previewGeometryDirty || DATA.segments.some((segment) => segment._dirty);
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

// 浏览器文件选择器拿不到工程的真实路径，但 MAW 工程记录的媒体是绝对路径。
// 把工程名与内容交给服务器，由它定位同目录同名工程并接管：
// 成功后整页刷新，由服务器渲染出自动加载媒体且可直接保存的状态。
// 任何失败都静默回退为「手动选择媒体」的便携流程。
async function attachProjectToServer(fileName, projectData) {
  try {
    const response = await fetch(SERVER_CONFIG.attachUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName, project: projectData }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) return false;
    window.location.reload();
    return true;
  } catch {
    return false;
  }
}

function configureRecentProjects() {
  if (!SERVER_CONFIG?.recentProjectsUrl || !recentProjectsEl || !recentProjectsToggle
      || !recentProjectsMenu || !recentProjectsList) {
    return;
  }
  const projects = Array.isArray(SERVER_CONFIG.recentProjects) ? SERVER_CONFIG.recentProjects : [];
  recentProjectsEl.hidden = false;
  recentProjectsList.replaceChildren();
  if (recentProjectsSeparator) recentProjectsSeparator.hidden = !projects.length;
  projects.forEach((project, index) => {
    if (!project || typeof project.path !== 'string' || typeof project.name !== 'string') return;
    const item = document.createElement('div');
    if (project.exists === false) {
      item.className = 'dropdown-item is-missing';
      item.style.cursor = 'not-allowed';
      const label = document.createElement('span');
      label.className = 'recent-project-name';
      label.textContent = project.name;
      item.appendChild(label);
      const badge = document.createElement('span');
      badge.className = 'recent-project-badge is-missing';
      badge.textContent = '已失效';
      item.appendChild(badge);
      item.title = `工程路径失效：${project.path}`;
      item.addEventListener('click', () => {
        recentProjectsEl.classList.remove('open');
        flashHint('工程路径失效，文件可能已被移动或删除', 'warning');
      });
    } else {
      item.className = 'dropdown-item';
      // 工程名与其它项一致占正文；「上次打开」只作为右侧徽标标记，不写进名字
      const label = document.createElement('span');
      label.className = 'recent-project-name';
      label.textContent = project.name;
      item.appendChild(label);
      if (index === 0) {
        const badge = document.createElement('span');
        badge.className = 'recent-project-badge';
        badge.textContent = '上次打开';
        item.appendChild(badge);
      }
      item.title = project.path;
      item.addEventListener('click', () => {
        recentProjectsEl.classList.remove('open');
        openRecentProject(project);
      });
    }
    recentProjectsList.appendChild(item);
  });
  if (recentProjectsEl.dataset.listenersBound !== 'true') {
    recentProjectsToggle.addEventListener('click', (event) => {
      event.stopPropagation();
      recentProjectsEl.classList.toggle('open');
    });
    document.addEventListener('click', (event) => {
      if (!recentProjectsEl.contains(event.target)) recentProjectsEl.classList.remove('open');
    });
    recentProjectsEl.dataset.listenersBound = 'true';
  }
}

function configureServerProjectSettings() {
  if (!SERVER_CONFIG?.settingsUrl || !serverProjectSettingsEl || !autoOpenLastProjectToggle) return;
  serverProjectSettingsEl.hidden = false;
  autoOpenLastProjectToggle.checked = SERVER_CONFIG.autoOpenLastProject !== false;
  if (autoOpenLastProjectToggle.dataset.listenersBound !== 'true') {
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
    autoOpenLastProjectToggle.dataset.listenersBound = 'true';
  }
}

// === 工作区库：服务器版可把工作区（窗口布局 + 显示状态）保存到本机设置，跨工程复用 ===
const BUILTIN_WORKSPACE_IDS = window.AsrWaveform?.builtinWorkspaceIds || ['classic', 'wave-right', 'three-fold', 'cinema'];
let currentServerWorkspaceName = '';
let currentBuiltinWorkspaceName = '';
const workspacePresetSelect = document.getElementById('workspace-preset');
const saveWorkspaceButton = document.getElementById('workspace-save');
const saveWorkspaceAsButton = document.getElementById('workspace-save-as');
const deleteWorkspaceButton = document.getElementById('workspace-delete');

function getSavedServerWorkspaces() {
  return SERVER_CONFIG?.savedWorkspaces && typeof SERVER_CONFIG.savedWorkspaces === 'object'
    ? SERVER_CONFIG.savedWorkspaces : {};
}

function getSavedPresetWorkspaces() {
  return SERVER_CONFIG?.presetWorkspaces && typeof SERVER_CONFIG.presetWorkspaces === 'object'
    ? SERVER_CONFIG.presetWorkspaces : {};
}

function currentWorkspaceDisplayName() {
  const selected = workspacePresetSelect?.selectedOptions?.[0];
  return selected?.textContent?.trim() || currentServerWorkspaceName || currentBuiltinWorkspaceName || '当前工作区';
}

function refreshWorkspaceSelect() {
  if (!workspacePresetSelect) return;
  const workspaces = getSavedServerWorkspaces();
  workspacePresetSelect.querySelector('optgroup[data-saved-workspaces]')?.remove();
  const names = Object.keys(workspaces).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  if (names.length) {
    const group = document.createElement('optgroup');
    group.label = '已保存工作区';
    group.dataset.savedWorkspaces = 'true';
    names.forEach((name) => group.append(new Option(name, `saved:${name}`)));
    workspacePresetSelect.append(group);
  }
  if (currentServerWorkspaceName && workspaces[currentServerWorkspaceName]) {
    workspacePresetSelect.value = `saved:${currentServerWorkspaceName}`;
  }
}

function syncWorkspaceControls() {
  const hasServerLibrary = Boolean(SERVER_CONFIG?.settingsUrl && waveformEditor);
  const isEditing = waveformEditor?.isCustomLayout?.() === true;
  const hasCustomWorkspace = Boolean(currentServerWorkspaceName && getSavedServerWorkspaces()[currentServerWorkspaceName]);
  const hasBuiltinWorkspace = Boolean(currentBuiltinWorkspaceName);
  if (saveWorkspaceButton) saveWorkspaceButton.hidden = !hasServerLibrary || !isEditing || (!hasCustomWorkspace && !hasBuiltinWorkspace);
  if (saveWorkspaceAsButton) saveWorkspaceAsButton.hidden = !hasServerLibrary || !isEditing;
  if (deleteWorkspaceButton) deleteWorkspaceButton.hidden = !hasServerLibrary || !isEditing || !hasCustomWorkspace;
}

function restoreWorkspaceSelection() {
  const selectedPreset = DATA.workspace?.selectedPreset;
  if (typeof selectedPreset !== 'string' || !workspacePresetSelect) return;
  if (selectedPreset.startsWith('saved:')) {
    const name = selectedPreset.slice('saved:'.length);
    if (getSavedServerWorkspaces()[name]) {
      currentServerWorkspaceName = name;
      currentBuiltinWorkspaceName = '';
      refreshWorkspaceSelect();
    }
    return;
  }
  if (BUILTIN_WORKSPACE_IDS.includes(selectedPreset)) {
    currentServerWorkspaceName = '';
    currentBuiltinWorkspaceName = selectedPreset;
    workspacePresetSelect.value = selectedPreset;
  }
}

async function updateServerWorkspaceSettings(payload) {
  const response = await fetch(SERVER_CONFIG.settingsUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.error || `服务器返回 ${response.status}`);
  SERVER_CONFIG.savedWorkspaces = result.savedWorkspaces || {};
  SERVER_CONFIG.presetWorkspaces = result.presetWorkspaces || {};
  SERVER_CONFIG.activeWorkspaceName = result.activeWorkspaceName || '';
  SERVER_CONFIG.autoOpenLastProject = result.autoOpenLastProject !== false;
  return result;
}

async function saveCurrentWorkspace({ saveAs }) {
  if (!waveformEditor || !SERVER_CONFIG?.settingsUrl) return;
  let name = currentServerWorkspaceName;
  if (saveAs) {
    name = prompt('请输入工作区名称：', '我的工作区')?.trim() || '';
    if (!name) return;
  }
  if (!name && !currentBuiltinWorkspaceName) return;
  const displayName = saveAs ? name : currentWorkspaceDisplayName();
  const button = saveAs ? saveWorkspaceAsButton : saveWorkspaceButton;
  if (button) button.disabled = true;
  try {
    const workspace = buildCurrentWorkspaceData();
    if (saveAs) {
      await updateServerWorkspaceSettings({ saveWorkspace: { name, workspace, overwrite: false } });
      SERVER_CONFIG.savedWorkspaces = { ...getSavedServerWorkspaces(), [name]: workspace };
      currentServerWorkspaceName = name;
      currentBuiltinWorkspaceName = '';
    } else if (currentServerWorkspaceName) {
      await updateServerWorkspaceSettings({ saveWorkspace: { name, workspace, overwrite: true } });
      SERVER_CONFIG.savedWorkspaces = { ...getSavedServerWorkspaces(), [name]: workspace };
    } else {
      await updateServerWorkspaceSettings({ savePresetWorkspace: { preset: currentBuiltinWorkspaceName, workspace } });
      SERVER_CONFIG.presetWorkspaces = { ...getSavedPresetWorkspaces(), [currentBuiltinWorkspaceName]: workspace };
    }
    refreshWorkspaceSelect();
    syncWorkspaceControls();
    flashHint(saveAs ? `已另存工作区：${displayName}` : `已保存工作区：${displayName}`);
  } catch (error) {
    flashHint(`保存工作区失败：${error.message || error}`);
  } finally {
    if (button) button.disabled = false;
  }
}

async function deleteCurrentServerWorkspace() {
  const name = currentServerWorkspaceName;
  if (!name || !SERVER_CONFIG?.settingsUrl || !confirm(`确定删除工作区「${name}」吗？`)) return;
  deleteWorkspaceButton.disabled = true;
  try {
    await updateServerWorkspaceSettings({ deleteWorkspaceName: name });
    currentServerWorkspaceName = '';
    refreshWorkspaceSelect();
    syncWorkspaceControls();
    flashHint(`已删除工作区：${name}`);
  } catch (error) {
    flashHint(`删除工作区失败：${error.message || error}`);
  } finally {
    deleteWorkspaceButton.disabled = false;
  }
}

// 应用一次下拉选择：saved:* 从本机库恢复；内置 id 优先用本机覆盖版，否则用默认定义。
// 工作区 = 窗口布局 + 显示状态，切换时同时恢复该工作区保存的显示开关。
function applyWorkspaceSelection(preset) {
  if (preset.startsWith('saved:')) {
    const name = preset.slice('saved:'.length);
    const workspace = getSavedServerWorkspaces()[name];
    if (!workspace) return;
    waveformEditor.setLayoutData({ ...workspace, selectedPreset: `saved:${name}` });
    applyEditorDisplaySettings(workspace.editorDisplay);
    currentServerWorkspaceName = name;
    currentBuiltinWorkspaceName = '';
    refreshWorkspaceSelect();
    syncWorkspaceControls();
    void updateServerWorkspaceSettings({ activeWorkspaceName: name }).catch((error) => {
      flashHint(`记住工作区失败：${error.message || error}`);
    });
    flashHint(`已应用工作区：${name}`);
    return;
  }
  if (!BUILTIN_WORKSPACE_IDS.includes(preset)) return;
  currentServerWorkspaceName = '';
  currentBuiltinWorkspaceName = preset;
  const savedPreset = getSavedPresetWorkspaces()[preset];
  if (savedPreset) waveformEditor.setLayoutData(savedPreset);
  else waveformEditor.setLayout(preset);
  applyEditorDisplaySettings(
    savedPreset?.editorDisplay || window.AsrWaveform?.builtinWorkspaces?.[preset]?.editorDisplay,
  );
  workspacePresetSelect.value = preset;
  refreshWorkspaceSelect();
  syncWorkspaceControls();
  void updateServerWorkspaceSettings({ activeWorkspaceName: '' }).catch((error) => {
    flashHint(`记住工作区失败：${error.message || error}`);
  });
}

function configureServerWorkspaceLibrary() {
  if (!SERVER_CONFIG?.settingsUrl || !waveformEditor) return;
  const savedSelection = DATA.workspace?.selectedPreset;
  currentServerWorkspaceName = typeof savedSelection === 'string' && savedSelection.startsWith('saved:')
    && getSavedServerWorkspaces()[savedSelection.slice('saved:'.length)]
    ? savedSelection.slice('saved:'.length)
    : !savedSelection && getSavedServerWorkspaces()[SERVER_CONFIG.activeWorkspaceName]
      ? SERVER_CONFIG.activeWorkspaceName : '';
  const initialPreset = typeof savedSelection === 'string' && !savedSelection.startsWith('saved:')
    ? savedSelection : DATA.workspace?.preset;
  currentBuiltinWorkspaceName = currentServerWorkspaceName ? ''
    : BUILTIN_WORKSPACE_IDS.includes(initialPreset) ? initialPreset : 'wave-right';
  if (!savedSelection && currentBuiltinWorkspaceName && getSavedPresetWorkspaces()[currentBuiltinWorkspaceName]) {
    waveformEditor.setLayoutData(getSavedPresetWorkspaces()[currentBuiltinWorkspaceName]);
    if (workspacePresetSelect) workspacePresetSelect.value = currentBuiltinWorkspaceName;
  }
  refreshWorkspaceSelect();
  restoreWorkspaceSelection();
  if (workspacePresetSelect?.dataset.listenersBound !== 'true') {
    workspacePresetSelect?.addEventListener('change', () => applyWorkspaceSelection(workspacePresetSelect.value));
    document.getElementById('layout-edit-toggle')?.addEventListener('click', () => {
      // 拖放编辑只改窗口排列，不改变下拉框当前选中的工作区名称。
      if (currentServerWorkspaceName) refreshWorkspaceSelect();
      else if (currentBuiltinWorkspaceName && workspacePresetSelect) workspacePresetSelect.value = currentBuiltinWorkspaceName;
      syncWorkspaceControls();
    });
    document.getElementById('layout-reset')?.addEventListener('click', () => {
      const preset = currentBuiltinWorkspaceName;
      if (preset) {
        waveformEditor.setLayout(preset);
        void updateServerWorkspaceSettings({ resetPresetWorkspace: preset }).then(() => {
          flashHint(`已恢复「${preset}」默认工作区`);
        }).catch((error) => {
          flashHint(`重置工作区失败：${error.message || error}`);
        });
      }
      syncWorkspaceControls();
    });
    saveWorkspaceButton?.addEventListener('click', () => { void saveCurrentWorkspace({ saveAs: false }); });
    saveWorkspaceAsButton?.addEventListener('click', () => { void saveCurrentWorkspace({ saveAs: true }); });
    deleteWorkspaceButton?.addEventListener('click', () => { void deleteCurrentServerWorkspace(); });
    workspacePresetSelect.dataset.listenersBound = 'true';
  }
  syncWorkspaceControls();
}

function configureWorkspaceTransfer() {
  if (!waveformEditor) return;
  // 「工作区配置 ▾」在服务器版与单文件版都可用，便于以文件显式备份/迁移工作区。
  const transferDropdown = document.getElementById('workspace-transfer-dropdown');
  const exportButton = document.getElementById('workspace-export');
  const importButton = document.getElementById('workspace-import');
  const importFile = document.getElementById('workspace-import-file');
  if (transferDropdown) transferDropdown.hidden = false;
  exportButton?.addEventListener('click', async () => {
    await downloadFile(buildWorkspaceJson(), `${FILENAME_BASE}.workspace.json`, 'application/json', {
      desc: '编辑器工作区文件', types: { 'application/json': ['.workspace.json', '.json'] },
    });
  });
  importButton?.addEventListener('click', () => {
    if (!importFile) return;
    importFile.value = '';
    importFile.click();
  });
  importFile?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const workspace = data.workspace || data;
      pushLayoutUndo('导入工作区', waveformEditor.getLayoutHistorySnapshot?.());
      waveformEditor.setLayoutData(workspace);
      applyEditorDisplaySettings(workspace?.editorDisplay);
      DATA.workspace = waveformEditor.getLayoutData();
      flashHint(`已导入工作区：${file.name}`);
    } catch (error) {
      flashHint(`工作区导入失败：${error.message || error}`);
    }
  });
  if (SERVER_CONFIG?.settingsUrl) return;  // 服务器版的下拉选择由工作区库接管
  // 单文件编辑器不承诺 file:// 间的浏览器存储；内置工作区与显式文件迁移最可靠。
  let selectedWorkspaceId = workspacePresetSelect?.value || 'wave-right';
  workspacePresetSelect?.addEventListener('change', () => {
    selectedWorkspaceId = workspacePresetSelect.value;
    if (BUILTIN_WORKSPACE_IDS.includes(selectedWorkspaceId)) {
      waveformEditor.setLayout(selectedWorkspaceId);
      applyEditorDisplaySettings(window.AsrWaveform?.builtinWorkspaces?.[selectedWorkspaceId]?.editorDisplay);
    }
  });
  document.getElementById('layout-edit-toggle')?.addEventListener('click', () => {
    // 拖放编辑只改窗口排列，不改变下拉框当前选中的工作区名称。
    if (workspacePresetSelect) workspacePresetSelect.value = selectedWorkspaceId;
  });
}

function markProjectSaved(filename, backupName, { silent = false } = {}) {
  DATA.segments.forEach((segment) => { delete segment._dirty; });
  gapRemoveDirty = false;
  previewGeometryDirty = false;
  FILENAME_BASE = filename.replace(/\.(json|mosp)$/i, '');
  const jsonEl = document.getElementById('json-name');
  if (jsonEl) {
    jsonEl.textContent = filename;
    jsonEl.title = `点击复制工程文件名：${filename}`;
    jsonEl.classList.remove('empty');
  }
  renderAll();
  if (!silent) flashHint('保存成功！');
}

async function saveProjectToServer({ silent = false } = {}) {
  if (!serverProjectSavingEnabled()) {
    if (!silent) flashHint('此服务器没有绑定可保存的工程；请使用“导出工程”或带工程文件路径重新启动服务器');
    return false;
  }
  if (projectSaveInFlight) return false;
  if (editingState) finishEdit(true);
  const projectJson = buildJson();
  projectSaveInFlight = true;
  try {
    const saveUrl = new URL(SERVER_CONFIG.saveUrl, window.location.href);
    const response = await fetch(saveUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: JSON.parse(projectJson), filename: null }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) {
      throw new Error(result.error || `服务器返回 ${response.status}`);
    }
    markProjectSaved(result.filename, result.backup, { silent });
    return true;
  } catch (error) {
    const detail = error?.message || error;
    showProjectSaveError(detail);
    // A stale browser tab can outlive the localhost process (the browser reports
    // ERR_CONNECTION_REFUSED). Offer a real file save so Ctrl+S never strands
    // completed edits, while making clear that the bound JSON was not overwritten.
    if (error instanceof TypeError
        && confirm('无法连接本地编辑器服务器。是否改为导出工程文件，以免丢失改动？')) {
      const saved = await downloadFile(projectJson, `${FILENAME_BASE}.mosp`, 'application/json', {
        desc: 'MOSE 工程文件', types: { 'application/json': ['.mosp', '.json'] }
      });
      if (saved) flashHint('服务器未连接；工程已另存为工程文件，请重新启动本地编辑器后继续');
    }
    return false;
  } finally {
    projectSaveInFlight = false;
  }
}

// 另存为：打开系统文件浏览对话框把工程文件保存到用户选择的位置。
// 与「导出工程」的区别：保存成功后当前工程名跟随新文件（标题、导出默认名随之更新）。
async function saveProjectAsToFile() {
  if (editingState) finishEdit(true);
  const suggested = `${FILENAME_BASE}.mosp`;
  // 无原生保存对话框的浏览器：退化为普通下载（文件名不可考，标题保持不变）。
  if (!window.showSaveFilePicker) {
    await downloadFile(buildJson(), suggested, 'application/json', {
      desc: 'MOSE 工程文件', types: { 'application/json': ['.mosp', '.json'] }
    });
    return;
  }
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: suggested,
      types: [{ description: 'MOSE 工程文件', accept: { 'application/json': ['.mosp', '.json'] } }],
    });
    const writable = await handle.createWritable();
    await writable.write(new Blob([buildJson()], { type: 'application/json;charset=utf-8' }));
    await writable.close();
    markProjectSaved(handle.name, null);
  } catch (error) {
    if (error && error.name === 'AbortError') return;  // 用户取消保存对话框
    flashHint(`保存失败：${error?.message || error}`);
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
document.getElementById('download-full-srt').addEventListener('click', async () => {
  if (editingState) finishEdit(true);
  await downloadFile(buildSrt(), `${FILENAME_BASE}.srt`, 'text/plain', {
    desc: '完整 SRT 字幕文件', types: { 'text/plain': ['.srt'] }
  });
});
document.getElementById('download-color-srt').addEventListener('click', () => downloadColorSrts(false));
document.getElementById('download-plain-text').addEventListener('click', async () => {
  if (editingState) finishEdit(true);
  await downloadFile(window.AsrEditorUtils.buildPlainTextPayload(DATA.segments), `${FILENAME_BASE}.txt`, 'text/plain', {
    desc: '纯文本字幕文件', types: { 'text/plain': ['.txt'] }
  });
});
document.getElementById('download-json').addEventListener('click', async () => {
  if (editingState) finishEdit(true);
  await downloadFile(buildJson(), `${FILENAME_BASE}.mosp`, 'application/json', {
    desc: 'MOSE 工程文件', types: { 'application/json': ['.mosp', '.json'] }
  });
});
saveProjectButton?.addEventListener('click', () => saveProjectToServer());
saveProjectAsButton?.addEventListener('click', () => saveProjectAsToFile());
// Project-level save shortcuts intentionally override the browser page-save
// command. finishEdit() inside saveProjectToServer commits an active text edit.
document.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 's') return;
  event.preventDefault();
  if (event.shiftKey) {
    void saveProjectAsToFile();
  } else {
    void saveProjectToServer();
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
document.getElementById('download-gap-removed-color-srt').addEventListener('click', () => downloadColorSrts(true));
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
bindToolbarExportDropdown('subtitle-export-dropdown', 'subtitle-export-btn', 'subtitle-export-menu');
bindToolbarExportDropdown('gap-removed-export-dropdown', 'gap-removed-export-btn', 'gap-removed-export-menu');
bindToolbarExportDropdown('extra-export-dropdown', 'extra-export-btn', 'extra-export-menu');
bindToolbarExportDropdown('open-project-dropdown', 'open-project-menu-btn', 'open-project-menu');
bindToolbarExportDropdown('save-project-dropdown', 'save-project-menu-btn', 'save-project-menu');
bindToolbarExportDropdown('workspace-transfer-dropdown', 'workspace-transfer-btn', 'workspace-transfer-menu');

// === 打开工程 ===
const openProjectFileInput = document.getElementById('open-project-file');
const loadMediaFileInput = document.getElementById('load-media-file');
const loadSrtFileInput = document.getElementById('load-srt-file');
let currentMediaBlobUrl = null;  // 跟踪 blob URL，便于切换时 revoke 防泄漏
let pendingProjectMediaSelection = null;

function closeProjectMediaModal(clearPending = false) {
  projectMediaModal.classList.remove('show');
  if (clearPending) pendingProjectMediaSelection = null;
  setTimeout(() => window.MAWE_ONBOARDING?.scheduleStart(), 0);
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
  emptyPlayer.preload = 'metadata';
  emptyPlayer.style.cssText = 'width:100%;display:block;';
  oldPlayer?.parentNode?.replaceChild(emptyPlayer, oldPlayer);
  player = emptyPlayer;
  bindPlayerEvents(player);
  seekWarned = false;
  waveformEditor?.attachPlayer(player);
  syncPlayerPlaceholder();
}

function isMawProject(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.segments)) return false;
  let previousEnd = 0;
  return data.segments.every((segment) => {
    if (!segment || typeof segment !== 'object'
        || !Number.isInteger(segment.start) || !Number.isInteger(segment.end)
        || segment.start < 0 || segment.end <= segment.start || segment.start < previousEnd
        || typeof segment.text !== 'string') return false;
    previousEnd = segment.end;
    if (!Array.isArray(segment.items)) return segment.items === undefined;
    let itemEnd = segment.start;
    return segment.items.every((item) => {
      if (!item || typeof item !== 'object'
          || !Number.isInteger(item.start) || !Number.isInteger(item.end)
          || item.start < segment.start || item.end > segment.end || item.end <= item.start
          || item.start < itemEnd || typeof item.text !== 'string') return false;
      itemEnd = item.end;
      return true;
    });
  });
}

function parseSrtTimestamp(value) {
  const match = /^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const milliseconds = Number(match[4].padEnd(3, '0'));
  if (minutes >= 60 || seconds >= 60) return null;
  return (((hours * 60 + minutes) * 60) + seconds) * 1000 + milliseconds;
}

function parseSrtSegments(text) {
  const blocks = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim().split(/\n{2,}/);
  const segments = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    if (/^\d+$/.test(lines[0]?.trim() || '')) lines.shift();
    const timing = /^\s*(.+?)\s*-->\s*(.+?)(?:\s+.*)?$/.exec(lines.shift() || '');
    if (!timing) throw new Error('缺少有效时间码');
    const start = parseSrtTimestamp(timing[1]);
    const end = parseSrtTimestamp(timing[2]);
    const cueText = lines.join('\n').trim();
    if (start === null || end === null || end <= start || !cueText) throw new Error('包含无效字幕段');
    const previous = segments[segments.length - 1];
    if (previous && start < previous.end) throw new Error('字幕时间重叠');
    segments.push({ start, end, text: cueText });
  }
  if (!segments.length) throw new Error('没有可导入的字幕');
  return segments;
}

async function openSrtFile(file) {
  try {
    const segments = parseSrtSegments(await file.text());
    DATA.segments.length = 0;
    segments.forEach((segment) => DATA.segments.push(segment));
    DATA.gap_remove = null;
    gapRemoveDirty = false;
    projectLoadedFromSrt = true;
    editorHistory.clear();
    updateUndoRedoButtons();
    clearSelection();
    lastActive = -1;
    updateGapRemoveUi();
    renderAll();
    FILENAME_BASE = file.name.replace(/\.srt$/i, '');
    const jsonEl = document.getElementById('json-name');
    if (jsonEl) {
      jsonEl.textContent = `导入字幕：${file.name}`;
      jsonEl.title = 'SRT 字幕只能通过导出下载保存为工程文件';
      jsonEl.classList.add('empty');
    }
    configureServerSaveControls();
    scheduleAutoSave();
    flashHint(`已加载字幕：${file.name}（${segments.length} 条）`);
    return true;
  } catch (error) {
    flashHint(`加载字幕失败：${error.message || error}`);
    return false;
  }
}

async function openProjectFile(file, options = {}) {
  const suppressMediaPrompt = options.suppressMediaPrompt === true;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    // 先兜底修复 0 长/倒挂时间码（保底 100ms），再校验结构，让旧工程仍能打开。
    if (data && Array.isArray(data.segments)) {
      window.AsrEditorUtils.normalizeSegmentTimings(data.segments);
      window.AsrEditorUtils.repairGroupReferenceIndices(data.segments);
    }
    if (!isMawProject(data)) {
      flashHint('打开了错误的文件，请使用 MAW 生成的工程文件。');
      return false;
    }
    // 单独选 JSON 时，浏览器没有授权访问它所在目录；先清理旧媒体，避免旧音轨配上新字幕。
    resetLoadedMedia();
    DATA.media = typeof data.media === 'string' ? data.media : '';
    DATA.language = data.language || '';
    DATA.model = data.model || '';
    DATA.waveform = data.waveform || null;
    DATA.workspace = data.workspace || null;
    DATA.gap_remove = data.gap_remove || null;
    gapRemoveDirty = false;
    // 预览几何：归一化后应用；缺失时回退到 legacy 默认，且不弄脏工程。
    DATA.preview = (data.preview && typeof data.preview === 'object') ? data.preview : null;
    setPreviewGeometry(getPreviewGeometry(), { markDirty: false });
    setStickerGeometry(getStickerGeometry(), { markDirty: false });
    refreshPreviewGeometryEditable();
    if (data.sticker_root) STICKER_ROOT = data.sticker_root;
    DATA.segments.length = 0;
    data.segments.forEach((segment) => DATA.segments.push(segment));
    projectLoadedFromSrt = false;
    configureServerSaveControls();
    scheduleAutoSave();
    editorHistory.clear();
    updateUndoRedoButtons();
    clearSelection();
    lastActive = -1;
    if (waveformEditor) {
      waveformEditor.setLayoutData(DATA.workspace);
      applyEditorDisplaySettings(DATA.workspace?.editorDisplay);
      restoreWorkspaceSelection();
      syncWorkspaceControls();
      waveformLoadedFromProject = waveformEditor.setPayload(DATA.waveform);
    }
    updateGapRemoveUi();
    renderAll();
    updateUnloadedMediaLabel(DATA.media);

    FILENAME_BASE = file.name.replace(/\.(json|mosp)$/i, '');
    const jsonEl = document.getElementById('json-name');
    if (jsonEl) {
      jsonEl.textContent = file.name;
      jsonEl.title = `点击复制工程文件名：${file.name}`;
      jsonEl.classList.remove('empty');
      jsonEl.onclick = () => copyText(file.name, `已复制：${file.name}`);
    }
    const timeEl = document.getElementById('gen-time');
    if (timeEl) {
      const now = new Date();
      const pad = (value) => String(value).padStart(2, '0');
      timeEl.textContent = `打开时间 ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    }

    const expectedName = window.AsrEditorUtils.fileBasename(DATA.media);
    // 服务器版：浏览器拿不到工程真实路径，但工程记录的媒体是绝对路径。
    // 先让服务器按它定位同目录同名工程并接管（自动加载媒体、允许 Ctrl(Cmd)+S 保存）；
    // 接管失败（媒体已移动 / 同名工程缺失 / 内容不一致）再回退为手动选择媒体。
    if (expectedName && SERVER_CONFIG?.attachUrl) {
      if (await attachProjectToServer(file.name, data)) return true;
    }
    if (expectedName && !suppressMediaPrompt) {
      pendingProjectMediaSelection = { projectReady: true };
      showProjectMediaModal();
    }
    flashHint(expectedName
      ? `已加载工程：${file.name}（${suppressMediaPrompt ? '正在加载关联媒体' : `等待选择关联媒体：${expectedName}`}）`
      : `已加载工程：${file.name}（${DATA.segments.length} 条字幕）`);
    return true;
  } catch (error) {
    pendingProjectMediaSelection = null;
    flashHint(error instanceof SyntaxError
      ? '打开了错误的文件，请使用 MAW 生成的工程文件。'
      : `加载失败：${error.message}`);
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
  const file = e.target.files?.[0];
  if (!file || !isJsonFile(file)) {
    flashHint('请选择一个 .mosp 或 .json 工程文件。');
    return;
  }
  await openProjectFile(file);
});

// === 加载媒体 ===
// 通过浏览器文件选择器选本地媒体（视频/音频），用 blob URL 替换播放器源。
// 如果媒体类型与当前播放器标签不一致（video<->audio），会原地替换整个 <video>/<audio> 元素。
document.getElementById('load-media').addEventListener('click', () => {
  pendingProjectMediaSelection = null;
  loadMediaFileInput.value = '';
  loadMediaFileInput.click();
});
document.getElementById('load-srt').addEventListener('click', () => {
  if (hasUnsavedProjectChanges()
      && !confirm('当前有未保存的改动，是否确定加载字幕？将替换当前字幕。')) return;
  loadSrtFileInput.value = '';
  loadSrtFileInput.click();
});

loadSrtFileInput.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (file) await openSrtFile(file);
});

async function loadMediaFile(file) {
  if (!file) return;
  const preserveProjectWaveform = waveformLoadedFromProject
    && Boolean(waveformEditor?.getPayload?.());
  const url = URL.createObjectURL(file);
  const isVideo = file.type.startsWith('video/') ||
    /\.(mp4|mkv|avi|mov|wmv|flv|webm|ts|m4v)$/i.test(file.name);
  const oldPlayer = document.getElementById('player');
  const wantTag = isVideo ? 'VIDEO' : 'AUDIO';
  const oldParent = oldPlayer.parentNode;
  const previousSource = oldPlayer.querySelector('source')?.src || oldPlayer.currentSrc || oldPlayer.src || '';
  let candidatePlayer = oldPlayer;

  if (oldPlayer.tagName === wantTag) {
    // 同类型：直接换 src，最简最安全
    const src = oldPlayer.querySelector('source');
    if (src) src.src = url; else oldPlayer.src = url;
    oldPlayer.load();
  } else {
    // 不同类型：替换整个元素
    const newPlayer = document.createElement(isVideo ? 'video' : 'audio');
    newPlayer.id = 'player';
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
    candidatePlayer = newPlayer;
    // 重新绑定全局引用与事件
    player = newPlayer;
    bindPlayerEvents(player);
    seekWarned = false;  // 新媒体重新探测 seek 能力
  }

  try {
    await waitForMediaMetadata(candidatePlayer, file);
  } catch (error) {
    if (candidatePlayer !== oldPlayer && oldParent) {
      oldParent.replaceChild(oldPlayer, candidatePlayer);
      player = oldPlayer;
      waveformEditor?.attachPlayer(player);
    } else if (previousSource) {
      const previous = oldPlayer.querySelector('source');
      if (previous) previous.src = previousSource; else oldPlayer.src = previousSource;
      oldPlayer.load();
    } else {
      oldPlayer.removeAttribute('src');
      oldPlayer.querySelector('source')?.removeAttribute('src');
    }
    URL.revokeObjectURL(url);
    syncPlayerPlaceholder();
    flashHint(error.message || `媒体加载失败：${file.name}`);
    return false;
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
  if (waveformEditor && !preserveProjectWaveform) {
    try {
      await waveformEditor.processFile(file);
    } catch (error) {
      flashHint(error.message || String(error));
    }
  }
  updateGapRemoveUi();
  return true;
}

function waitForMediaMetadata(mediaElement, file) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = window.setTimeout(() => finish(new Error(mediaLoadErrorMessage(file))), 8000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      mediaElement.removeEventListener('loadedmetadata', onLoaded);
      mediaElement.removeEventListener('error', onError);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve();
    };
    const onLoaded = () => finish();
    const onError = () => finish(new Error(mediaLoadErrorMessage(file)));
    mediaElement.addEventListener('loadedmetadata', onLoaded, { once: true });
    mediaElement.addEventListener('error', onError, { once: true });
    if (mediaElement.readyState >= 1) queueMicrotask(onLoaded);
  });
}

function mediaLoadErrorMessage(file) {
  const name = String(file?.name || '媒体文件');
  if (/\.flv$/i.test(name)) {
    return `无法播放 ${name}：当前浏览器未能解码 FLV，请先用 FFmpeg 转成 MP4。`;
  }
  return `无法播放 ${name}：浏览器不支持该媒体格式或编码。`;
}

loadMediaFileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  pendingProjectMediaSelection = null;
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
  // 浏览器加载模式（[本地] 前缀）下不在输入框显示虚拟标识，避免用户误以为是有效导出路径
  stickerRootInput.value = (STICKER_ROOT && STICKER_ROOT.startsWith('[本地]')) ? '' : (STICKER_ROOT || '');
  updateStickerRootBrowserWarn();
  stickerRootModal.classList.add('show');
  setTimeout(() => stickerRootInput.focus(), 50);
});

// 浏览器加载模式（[本地] 前缀）警告横幅显隐：只在 blob 模式下提示用户需手动填写真实磁盘路径
function updateStickerRootBrowserWarn() {
  const warn = document.getElementById('sticker-root-browser-warn');
  if (warn) warn.style.display = (STICKER_ROOT && STICKER_ROOT.startsWith('[本地]')) ? 'block' : 'none';
}
document.getElementById('sticker-root-cancel').addEventListener('click', () => stickerRootModal.classList.remove('show'));
stickerRootModal.addEventListener('click', (e) => { if (e.target === stickerRootModal) stickerRootModal.classList.remove('show'); });

// 「📁 扫描」按钮：优先用 showDirectoryPicker 选本地文件夹——原生选择器本身就是确认动作，
// 不会再弹浏览器的「是否上传 N 个文件到此站点」提示；不支持时回退 webkitdirectory。
// 浏览器拿不到绝对路径，所以用 blob URL 替换 STICKERS 数组；导出路径需用户手动填写。
const STICKER_IMG_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

function applyStickerFiles(entries, topDir) {
  // entries: [{ file, rel }]，rel 为相对所选文件夹的路径
  if (!entries.length) {
    flashHint('选中的文件夹里没有图片文件');
    return;
  }
  // 释放旧 STICKERS 的 blob URL（如果有）
  STICKERS.forEach(s => {
    if (s._blobUrl) { try { URL.revokeObjectURL(s._blobUrl); } catch (e) {} }
  });
  STICKERS.length = 0;
  for (const { file, rel } of entries) {
    STICKERS.push({
      name: file.name.replace(/\.[^.]+$/, ''),
      filename: file.name,
      rel: rel,
      _blobUrl: URL.createObjectURL(file),
    });
  }
  // 显示一个虚拟根，仅作内部状态标识（stickerAbsPath 据此跳过导出）；浏览器拿不到真实磁盘路径。
  // 不把 [本地] 虚拟标识填入输入框，避免用户误以为是有效导出路径。
  STICKER_ROOT = topDir ? `[本地] ${topDir}` : '[本地]';
  updateStickerRootBrowserWarn();
  renderAll();
  flashHint(`扫描到 ${STICKERS.length} 个表情包；由于浏览器限制，你需要手动填写本地绝对路径，否则无法导出`);
}

async function collectStickerEntries(dirHandle, prefix, out) {
  for await (const entry of dirHandle.values()) {
    if (entry.kind === 'file') {
      if (STICKER_IMG_EXT.test(entry.name)) out.push({ handle: entry, rel: prefix + entry.name });
    } else if (entry.kind === 'directory') {
      await collectStickerEntries(entry, `${prefix}${entry.name}/`, out);
    }
  }
}

document.getElementById('sticker-root-pick').addEventListener('click', async () => {
  if (window.showDirectoryPicker) {
    try {
      const dirHandle = await window.showDirectoryPicker({ id: 'maw-sticker-root' });
      const found = [];
      await collectStickerEntries(dirHandle, '', found);
      const entries = [];
      for (const item of found) entries.push({ file: await item.handle.getFile(), rel: item.rel });
      applyStickerFiles(entries, dirHandle.name);
      return;
    } catch (e) {
      // 用户取消选择 — 静默退出；其他错误（安全限制等）回退到 webkitdirectory
      if (e && e.name === 'AbortError') return;
    }
  }
  stickerRootFolderInput.value = '';
  stickerRootFolderInput.click();
});

stickerRootFolderInput.addEventListener('change', (e) => {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  // 只保留图片文件；取顶层目录名作为提示性 STICKER_ROOT（浏览器拿不到真实磁盘路径）
  const imgs = files.filter(f => STICKER_IMG_EXT.test(f.name));
  const firstRel = imgs[0]?.webkitRelativePath || '';
  const topDir = firstRel.includes('/') ? firstRel.split('/')[0] : '';
  applyStickerFiles(
    imgs.map(f => ({ file: f, rel: (f.webkitRelativePath || f.name).split('/').slice(1).join('/') || f.name })),
    topDir,
  );
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
    flashHint('没有可用的表情包，请先用🦊按钮配置表情包文件夹');
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
  const hadStickers = DATA.segments.some((segment) => segment.sticker || segment.sticker_ref);
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
  if (!hadStickers && !EDITOR_SETTINGS.cueListShowSticker && !EDITOR_SETTINGS.cueEditorShowSticker
      && confirm('Oi！检测到你添加了表情包，是否需要帮你打开「设置」中的字幕列表/编辑区的表情包显示开关？   ヾ(´･ω･｀)ﾉ')) {
    updateEditorSettings({ cueListShowSticker: true, cueEditorShowSticker: true });
    applyCueListDisplaySettings();
    applyCueEditorDisplaySettings();
  }
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
  // 单条修改 lead（其 color_ref 成员仍指向它）或多选统一分配时，视为整组联动修改
  const isUnifiedGroup = sorted.length > 1
    || DATA.segments.some((s) => s.color_ref && s.color_ref.headIdx === sorted[0]);
  renderAll();
  flashHint(isUnifiedGroup
    ? `已将关联字幕统一设为「${def.label}色」`
    : `已将字幕设为「${def.label}色」`);
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
  commitCuePanelEdit();
  pushUndo('新增字幕');
  DATA.segments.splice(index, 0, {
    start: safeStart,
    end: safeEnd,
    text: '',
    items: [],
    _dirty: true,
  });
  window.AsrEditorUtils.shiftGroupReferenceIndices(DATA.segments, index, 1);
  clearSelection({ silent: true });
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
  function addItem(label, kbd, fn, disabled = false) {
    const it = document.createElement('div');
    it.className = `item${disabled ? ' disabled' : ''}`;
    const lbl = document.createElement('span'); lbl.textContent = label;
    it.appendChild(lbl);
    const kb = document.createElement('kbd');
    kb.textContent = kbd || '';
    if (!kbd) kb.style.visibility = 'hidden';
    it.appendChild(kb);
    if (!disabled) {
      it.addEventListener('click', () => { ctxmenu.classList.remove('show'); fn(); });
    }
    ctxmenu.appendChild(it);
  }
  const splitIdx = DATA.segments.findIndex((segment) => (
    timeMs > segment.start && timeMs < segment.end
  ));
  addItem('创建字幕', '', () => addCueAtWaveformTime(timeMs, clickX, clickY));
  addItem(
    '按音频位置拆分当前字幕',
    'B',
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

  // 颜色子菜单：首行「标记颜色 + 1~5 键位提示」，下方一排加大号色块（好辨认也好点击）
  function addColorSubmenu(targets) {
    const row = document.createElement('div');
    row.className = 'item';
    row.style.cssText = 'cursor:default;display:block;';
    row.addEventListener('click', e => e.stopPropagation());
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;';
    const lbl = document.createElement('span');
    lbl.textContent = '标记颜色';
    head.appendChild(lbl);
    const rangeHint = document.createElement('kbd');
    rangeHint.textContent = '1~5';
    rangeHint.style.marginLeft = 'auto';
    head.appendChild(rangeHint);
    row.appendChild(head);
    const swatches = document.createElement('div');
    swatches.style.cssText = 'display:flex;gap:8px;margin-top:8px;';
    COLOR_PALETTE.forEach((c, colorIndex) => {
      const sw = document.createElement('span');
      sw.title = `${c.label}（按 ${colorIndex + 1}）`;
      sw.style.cssText = `width:22px;height:22px;border-radius:50%;background:${c.value};border:1px solid rgba(255,255,255,.25);cursor:pointer;display:inline-block;box-sizing:border-box;flex:0 0 auto;`;
      sw.addEventListener('mouseenter', () => sw.style.transform = 'scale(1.15)');
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
      addItem('清除颜色', '0', () => clearColorOnTargets(targets), { danger: true });
    }
  }

  if (!isMulti) {
    // 组 1：拆分与跳转。拆分是字幕行右键菜单的首要动作。
    const splitLabel = Number.isFinite(waveformTimeMs)
      ? '按音频位置拆分'
      : '按文字位置拆分';
    // 「按音频位置拆分」对应波形上的 B；「按文字位置拆分」对应列表内悬停已选行时的 B。
    const splitKbd = 'B';
    addItem(splitLabel, splitKbd, () => splitFromContextMenu(idx, x, y, waveformTimeMs));
    // 仅「仅选中」模式提供「跳转并播放」——其它两种单击行为本身就会跳转。
    if (EDITOR_SETTINGS.clickBehavior === 'select-only') {
      addItem('跳转并播放', 'F', () => {
        seekFromWaveform(DATA.segments[idx].start / 1000);
        if (player.paused) togglePlayback();
      });
    }
    addSep();
    // 组 2：外观（表情包与颜色）
    addItem('分配表情包…', 'T', () => openStickerPicker([idx], false));
    if (DATA.segments[idx].sticker || DATA.segments[idx].sticker_ref) {
      addItem('删除表情包', '', () => {
        removeStickerCascade(idx);
        renderAll();
        flashHint('已删除');
      }, { danger: true });
    }
    addColorSubmenu(targetIdxs);
    addSep();
    // 组 3：状态与删除
    addItem(
      DATA.segments[idx].disabled ? '启用此条' : '禁用此条',
      'Alt+点击',
      () => toggleDisabled([idx])
    );
    addItem('删除字幕', 'Delete', () => {
      deleteSegments([idx]);
    }, { danger: true });
  } else {
    // 组 1：合并与批量文本操作
    addItem(`合并 ${targetIdxs.length} 条字幕`, 'C', () => mergeSegments(targetIdxs));
    addItem('批量替换选中字幕…', '', () => openReplaceModal(targetIdxs));
    addSep();
    // 组 2：外观（表情包与颜色）；「拓展表情包时长」仅在范围内已有表情包时显示
    const hasStickerInRange = targetIdxs.some(i =>
      DATA.segments[i].sticker || DATA.segments[i].sticker_ref);
    if (hasStickerInRange) {
      addItem('拓展表情包时长', '', () => expandStickerTime(targetIdxs));
    }
    addItem('统一分配表情包…', 'T', () => openStickerPicker(targetIdxs, true));
    addColorSubmenu(targetIdxs);
    addSep();
    // 组 3：状态与删除
    const _disabledInSel = targetIdxs.filter(i => DATA.segments[i].disabled).length;
    addItem(
      _disabledInSel === targetIdxs.length ? '启用选中' : '禁用选中',
      '',
      () => toggleDisabled(targetIdxs)
    );
    addItem(`删除 ${targetIdxs.length} 条字幕`, 'Delete', () => {
      deleteSegments(targetIdxs);
    }, { danger: true });
    addItem('取消选择', `${modKeyLabel()}+D`, () => clearSelection());
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

function showGapContextMenu(x, y, index) {
  const gap = getGapRemoveGaps()[index];
  if (!gap) return;
  ctxmenu.innerHTML = '';
  const addItem = (label, fn, { danger = false } = {}) => {
    const item = document.createElement('div');
    item.className = 'item' + (danger ? ' danger' : '');
    const text = document.createElement('span');
    text.textContent = label;
    item.appendChild(text);
    item.addEventListener('click', () => {
      ctxmenu.classList.remove('show');
      fn();
    });
    ctxmenu.appendChild(item);
  };
  addItem(gap.removed === false ? '移除区段' : '恢复区段', () => toggleGapRemoved(index));
  const separator = document.createElement('div');
  separator.className = 'sep';
  ctxmenu.appendChild(separator);
  addItem('清理该区段', () => clearGap(index), { danger: true });

  ctxmenu.classList.add('show');
  const rect = ctxmenu.getBoundingClientRect();
  ctxmenu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`;
  ctxmenu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`;
}

function closeContextMenuOnOutsidePointerDown(event) {
  if (!ctxmenu.contains(event.target)) ctxmenu.classList.remove('show');
}
// 使用捕获阶段的 pointerdown：波形空白区自己的 pointerdown 可能阻止后续
// click 事件，不能再依赖 mouseup 后才触发的 document.click 来关闭菜单。
document.addEventListener('pointerdown', closeContextMenuOnOutsidePointerDown, true);
// 保留键盘触发 click 的关闭路径；真实鼠标/触控操作已经在 pointerdown 阶段关闭。
document.addEventListener('click', (e) => {
  if (e.detail === 0) closeContextMenuOnOutsidePointerDown(e);
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
// 右上角提示卡片堆栈：样式在 editor.css（#hint-stack / .hint-card）。
// 最多同时显示 3 条，新提示追加在下方。
const HINT_MAX_VISIBLE = 3;
const HINT_DURATION_MS = 1800;
const HINT_FADE_OUT_MS = 200;  // 与 editor.css 的 hint-fade-out 时长一致

function dismissHintCard(card) {
  if (!card || card.dataset.dismissed) return;
  card.dataset.dismissed = '1';
  card.classList.add('hide');
  setTimeout(() => card.remove(), HINT_FADE_OUT_MS);
}

function flashHint(msg, type = 'default', options = {}) {
  let stack = document.getElementById('hint-stack');
  if (!stack) {
    stack = document.createElement('div'); stack.id = 'hint-stack';
    document.body.appendChild(stack);
  }
  // 先挤掉最早的再插入新卡片：溢出项立即移除（不走退场动画），
  // 保证视觉上始终最多 3 条，不会出现第 4 条先闪现再挤出的跳动。
  while (stack.children.length >= HINT_MAX_VISIBLE) {
    const oldest = stack.firstElementChild;
    oldest.dataset.dismissed = '1';  // 让其到期定时器空转
    oldest.remove();
  }
  const card = document.createElement('div');
  // type → 语义类：default 中性 / success 成功 / invalid 不可用提醒 / warning 失败。
  // 仅在有效类型时追加类名，default 维持原 .hint-card 中性外观。
  const typeClass = type === 'success' ? 'hint-success'
    : type === 'invalid' ? 'hint-invalid'
    : type === 'warning' ? 'hint-warning' : '';
  card.className = typeClass ? `hint-card ${typeClass}` : 'hint-card';
  if (typeof options.contentBuilder === 'function') options.contentBuilder(card);
  else card.textContent = msg;
  stack.appendChild(card);
  const durationMs = Number.isFinite(options.durationMs) ? options.durationMs : HINT_DURATION_MS;
  if (durationMs > 0) setTimeout(() => dismissHintCard(card), durationMs);
  return card;
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
    // currentTime 的 seeked/timeupdate 事件是异步触发的；先同步刷新波形，
    // 避免字幕已选中但红色播放头要等下一拍才移动。
    waveformEditor?.updatePlayback();
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
    // 波形 Shift+框选：把命中的一批下标追加进当前多选（追加语义，不改 Shift 锚点）
    addCueSelection: (idxs) => {
      idxs.forEach((idx) => addToSelection(idx));
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
    showGapContextMenu: (x, y, index) => showGapContextMenu(x, y, index),
    showContextMenu: (x, y, idx, timeMs) => showContextMenu(x, y, idx, timeMs),
    showBlankWaveformMenu: (timeMs, x, y) => showWaveformBlankMenu(timeMs, x, y),
    addCueRange: (startMs, endMs, x, y) => addCueRangeFromWaveform(startMs, endMs, x, y),
    // 剃刀工具：在波形指针位置安全拆分字幕。复用右键菜单的波形时间拆分路径，
    // 它会先用 splitCharOffsetAtTime 把指针时间映射到最近的字/词级边界，再
    // 走 splitAtCursor；这样剃刀与右键拆分行为一致，且保留 items 时间码精度。
    splitCueAtTime: (idx, timeMs) => splitFromContextMenu(idx, 0, 0, timeMs),
    getClickBehavior: () => EDITOR_SETTINGS.clickBehavior,
    getClickTarget: () => EDITOR_SETTINGS.clickTarget,
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
    onPayload: (payload) => {
      DATA.waveform = payload;
      waveformLoadedFromProject = false;
    },
  });
  waveformEditor.attachPlayer(player);
  waveformEditor.setLayoutData(DATA.workspace || null);
  applyEditorDisplaySettings(DATA.workspace?.editorDisplay);
  waveformLoadedFromProject = waveformEditor.setPayload(DATA.waveform || null);
}

// === Drag & Drop：拖入视频/音频/JSON/SRT 自动加载 ===
const dragOverlay = document.getElementById('drag-overlay');
function isJsonFile(f) {
  const name = f.name.toLowerCase();
  return f.type === 'application/json' || name.endsWith('.json') || name.endsWith('.mosp');
}
function isSrtFile(f) {
  return f.name.toLowerCase().endsWith('.srt');
}
async function handleDroppedFiles(files) {
  if (!files.length) return;
  const mediaFile = files.find(isMediaFile);
  const jsonFile = files.find(isJsonFile);
  const srtFile = files.find(isSrtFile);
  if (!mediaFile && !jsonFile && !srtFile) {
    flashHint('不支持的文件类型（仅支持视频 / 音频 / JSON / SRT）');
    return;
  }
  // JSON 工程会重置 DATA，先检查未保存改动（与「打开工程」按钮一致）
  if (jsonFile && hasUnsavedProjectChanges()) {
    if (!confirm('当前有未保存的改动，是否确定加载新工程？将丢失未保存内容。')) return;
  }
  if (jsonFile) {
    // 工程与媒体一起拖入时，媒体随工程自动加载，不再弹窗要求重选。
    const opened = await openProjectFile(jsonFile, { suppressMediaPrompt: Boolean(mediaFile) });
    if (opened && mediaFile) await loadMediaFile(mediaFile);
    return;
  }
  if (srtFile && hasUnsavedProjectChanges()
      && !confirm('当前有未保存的改动，是否确定加载字幕？将替换当前字幕。')) return;
  if (mediaFile) await loadMediaFile(mediaFile);
  if (srtFile) await openSrtFile(srtFile);
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
// 兜底：工程可能带有上游写入的 0 长/倒挂段、词时间码（旧版工具或异常识别结果），
// 加载时统一拉齐到至少 100ms，避免拆分后看不见字幕块、工程无法保存。
const repairedGroupReferenceCount = window.AsrEditorUtils.repairGroupReferenceIndices(DATA.segments);
const repairedTimingCount = window.AsrEditorUtils.normalizeSegmentTimings(DATA.segments);
cleanPunctuation();
configureServerSaveControls();
configureServerAutoSave();
configureRecentProjects();
configureServerProjectSettings();
initWaveformEditor();
configureServerWorkspaceLibrary();
configureWorkspaceTransfer();
totalCountEl.textContent = DATA.segments.length;
// 新手引导通过这个窄桥接访问编辑器核心状态；引导本身在 editor-onboarding.js 中按需初始化。
window.MAWE_EDITOR_BRIDGE = Object.freeze({
  get data() { return DATA; },
  get selectedIdxs() { return selectedIdxs; },
  get currentCuePanelIdx() { return currentCuePanelIdx; },
  get container() { return container; },
  get projectMediaModal() { return projectMediaModal; },
  selectOnly,
  performUndo,
  flashHint,
  scrollCueToCenter,
  setEditorSettingsPanelOpen,
  modKeyLabel,
  splitKeyLabel,
  openHelp: () => helpFloatingPanel.open(),
  closeHelp: () => helpFloatingPanel.close(),
});
renderAll();
updateGapRemoveUi();
if (repairedTimingCount > 0) {
  flashHint(`已自动修复 ${repairedTimingCount} 处 0 长时间码（保底 100ms）`);
} else if (repairedGroupReferenceCount > 0) {
  flashHint(`已自动修复 ${repairedGroupReferenceCount} 处分组引用`);
}
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
