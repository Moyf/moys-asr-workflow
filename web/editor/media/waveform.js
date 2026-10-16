

// 真 ESM：compose facade 直连工厂实例化（原 MAWE.resolve 组装 = import 求值）。
'use strict';

import { AsrGapRemoveCore } from '../../shared/gap-remove-core.js';
import { getMaweHost } from '../boot/editor-host.js';
import { createThumbnailModule } from './editor-thumbnails.js';

import { createWaveformModule as wf_constants } from "./waveform/constants.js";
import { createWaveformModule as wf_labels } from "./waveform/labels.js";
import { createWaveformModule as wf_scale } from "./waveform/scale.js";
import { createWaveformModule as wf_layout } from "./waveform/layout.js";
import { createWaveformModule as wf_settings } from "./waveform/settings.js";
import { createWaveformModule as wf_payload } from "./waveform/payload.js";
import { createWaveformModule as wf_colors } from "./waveform/colors.js";
import { createWaveformModule as wf_timing } from "./waveform/timing.js";
import { createWaveformModule as wf_visibility } from "./waveform/visibility.js";
import { createWaveformModule as wf_controls } from "./waveform/controls.js";
import { createWaveformModule as wf_pointer } from "./waveform/pointer.js";
import { createWaveformModule as wf_workspace } from "./waveform/workspace.js";
import { createWaveformModule as wf_scale_controls } from "./waveform/scale-controls.js";
import { createWaveformModule as wf_media } from "./waveform/media.js";
import { createWaveformModule as wf_render } from "./waveform/render.js";
import { createWaveformModule as wf_cue_blocks } from "./waveform/cue-blocks.js";
import { createWaveformModule as wf_canvas } from "./waveform/canvas.js";
import { createWaveformModule as wf_input } from "./waveform/input.js";
import { createWaveformModule as wf_cue_drag } from "./waveform/cue-drag.js";
import { createWaveformModule as wf_cue_commands } from "./waveform/cue-commands.js";
import { createWaveformModule as wf_gap_drag } from "./waveform/gap-drag.js";
import { createWaveformModule as wf_markers } from "./waveform/markers.js";
import { createWaveformModule as wf_cue_drag_update } from "./waveform/cue-drag-update.js";
import { createWaveformModule as wf_playback } from "./waveform/playback.js";
import { createWordBlocks as wf_word_blocks } from "./waveform/word-blocks.js";
import { createWaveformModule as wf_thumbnails } from "./waveform/thumbnails.js";

const thumbnailCore = createThumbnailModule({
  browser: window,
  getConfig: () => window.MaweBoot?.SERVER_CONFIG,
  storage: getMaweHost().storage,
});
const helpers = {
  thumbnailCore,
  storage: getMaweHost().storage,
  gapRemoveCore: AsrGapRemoveCore,
  getLanguage: () => window.MAWE_I18N?.language,
};
Object.assign(helpers, wf_constants(helpers));
Object.assign(helpers, wf_labels(helpers));
Object.assign(helpers, wf_scale(helpers));
Object.assign(helpers, wf_layout(helpers));
Object.assign(helpers, wf_settings(helpers));
Object.assign(helpers, wf_payload(helpers));
Object.assign(helpers, wf_colors(helpers));
Object.assign(helpers, wf_timing(helpers));
Object.assign(helpers, wf_visibility(helpers));
const {
  BUILTIN_WORKSPACES,
  BUILTIN_WORKSPACE_IDS,
  LOUDNESS_SCHEMA,
  applyBoundaryStep,
  applyIndependentEdge,
  applyMoveStep,
  applySharedBoundary,
  buildWaveformEnvelope,
  clampWaveformScale,
  collectLayoutModules,
  computeGroupBadges,
  cueBlockContinuationEdges,
  decodePayload,
  decodeReapeaksFile,
  decodeSpectralPayload,
  findActiveCueIndex,
  firstCueIndexOverlapping,
  freqColor,
  insertLayoutModuleAtEdge,
  insertLayoutModuleAtRootEdge,
  isMultiRowInComfortZone,
  layoutDropIntent,
  layoutDropPreviewRect,
  layoutRootDropIntent,
  normalizeLayoutData,
  normalizeLayoutTree,
  normalizeNewCueRange,
  peaksRateOf,
  publishPeakRate,
  readSettings,
  remapItems,
  resolveTiming,
  restoreWaveformTopEdgeMs,
  roundMs,
  sampleInterpolatedPeak,
  setColorPalette,
  shouldAdjustAdjacentCuesIndependently,
  shouldAdjustSharedBoundaryHandleIndependently,
  snapPointerTimeToTimingGrid,
  sourceForFile,
  splitSegmentAtTime,
  swapLayoutModuleOrder,
  swapLayoutTreeModules,
  syncSpectralColorToggle,
  waveformAmplitude,
  waveformGridStepMs,
  waveformScaleAfterStep,
  waveformScaleFromLoudness,
  waveformTopEdgeMs,
  wheelScrollDelta,
} = helpers;

class WaveformEditor {
constructor(options) {
    this.options = options;
    this.settings = readSettings();
    this.payload = null;
    this.peaks = null;
    this.spectral = null;
    this.reapeaksPayload = null;
    this.loudnessStats = null;
    this.reapeaksPeaks = null;
    this.player = null;
    this.mediaAvailable = false;
    this.spectralColorBusy = false;
    this.spectralColorRenderToken = 0;
    this.basicWindowStartMs = 0;
    this.manualFollowUntil = 0;
    this.multiRange = [-1, -1];
  this.activeIndex = -1;
  this.activeExtensionIndex = -1;
  // active 轮廓的视觉命中状态：空隙中 activeIndex 不变，但轮廓需要熄灭，
  // 因此单独跟踪“上次是否严格命中”以触发 class 刷新。
  this.activeVisualHit = false;
  this.activeExtensionVisualHit = false;
    this.drag = null;
    this.createCueDrag = null;
    this.gapRangeDrag = null;
    this.gapBoundaryDrag = null;
    this.gapMoveDrag = null;
    this.gapMovePreviewFrame = 0;
    this.suppressGapClickUntil = 0;
    this.autoScrolling = false;
    this.autoScrollTarget = null;
    this.navigationRestoring = false;
    this.multiFollowRowIndex = -1;
    this.multiFollowCheckPending = true;
    this.resizeFrame = 0;
    // 字幕快捷键会在很短时间内连续请求定位；复用滚动事件已有的
    // rAF 合并，避免每个按键都强制重建可视行和 Canvas。
    this.multiVisibleFrame = 0;
    // 「鼠标位置自动预览」：高回报率 pointermove 用 rAF 合并，每帧最多按
    // 最新事件 seek 一次；pointerleave 时取消尚未执行的待办。
    this.hoverSeekPreviewFrame = 0;
    this.hoverSeekPreviewLastEvent = null;
    this.hoverSeekPreviewRow = null;
    // 帧吸附开关切换时，重新用当前鼠标坐标计算可见指针线位置。
    this.pointerLineEvent = null;
    this.pointerLineRow = null;
    this.pointerLineMarker = null;
    this.pointerLineOverrideActive = false;
    this.playheadDragActive = false;
    // Shift+滚轮调振幅的 debounce：滚动期间只累计净步数，停止后一次性重绘
    this.pendingScaleDirection = 0;
    this.scaleDebounceTimer = 0;
    // 行高预设也可能由高回报率滚轮连续触发；等待滚动停止后一次性重排，
    // 避免每个 wheel 事件都重绘整组可视行。
    this.pendingRowHeightDirection = 0;
    this.rowHeightDebounceTimer = 0;
    this.renderedRows = [];
    // 波形交互工具：'select'（默认，保留 Ctrl/Shift/分组多选与拖动）或
    // 'razor'（左键点击字幕块即在指针位置安全拆分）。Alt 行为不随工具变化。
    this.tool = 'select';

    this.workspace = document.getElementById('editor-workspace');
    this.panel = document.getElementById('current-cue-panel');
    this.playerWrap = this.workspace.querySelector('.player-wrap');
    this.cues = document.getElementById('cues-container');
    this.pane = document.getElementById('waveform-pane');
    this.scroll = document.getElementById('waveform-scroll');
    this.content = document.getElementById('waveform-content');
    this.empty = document.getElementById('waveform-empty');
    this.status = document.getElementById('waveform-status');
    this.spectralColorStatus = document.getElementById('waveform-spectral-status');
    this.divider = document.getElementById('workspace-divider');
    this.secondaryDivider = document.getElementById('workspace-divider-secondary');
    this.windowLabel = document.getElementById('waveform-window-label');
    this.waveformScaleLabel = document.getElementById('waveform-scale-label');
    this.waveformScaleDownButton = document.getElementById('waveform-scale-down');
    this.waveformScaleUpButton = document.getElementById('waveform-scale-up');
    this.waveformScaleFitButton = document.getElementById('waveform-scale-fit');
    this.secondsPerRowSelect = document.getElementById('waveform-seconds-per-row');
    this.rowHeightSelect = document.getElementById('waveform-row-height');
    this.showGroupBadgesToggle = document.getElementById('waveform-show-group-badges');
    this.dragPlayheadToggle = document.getElementById('waveform-drag-playhead');
    this.spectralColorToggle = document.getElementById('waveform-spectral-color');
    this.sideSelect = document.getElementById('waveform-side');
    this.disabledDisplaySelect = document.getElementById('waveform-disabled-display');
    this.layoutEditToggle = document.getElementById('layout-edit-toggle');
    this.layoutResetButton = document.getElementById('layout-reset');
    this.layoutPreview = document.getElementById('layout-drop-preview');
    this.layoutResizers = {
      column: document.getElementById('layout-resizer-v'),
      rowTop: document.getElementById('layout-resizer-h1'),
      rowMiddle: document.getElementById('layout-resizer-h2'),
    };
    const composed = /** @type {any} */ (this);
    this._onPlayerTime = () => composed.updatePlayback();
    this._onResize = () => composed.scheduleRender();
    composed.initThumbnails();
    composed.bindControls();
    composed.bindDockHandles();
    composed.applyLayout();

    if (window.ResizeObserver) {
      this.resizeObserver = new ResizeObserver(this._onResize);
      this.resizeObserver.observe(this.pane);
    } else {
      window.addEventListener('resize', this._onResize);
    }
  }
}

// Preserve class method/getter descriptors, including non-enumerability.
function installMethods(prototype, descriptors) {
  for (const key of Reflect.ownKeys(descriptors)) {
    if (Object.prototype.hasOwnProperty.call(prototype, key)) {
      throw new Error('Duplicate waveform method: ' + String(key));
    }
    Object.defineProperty(prototype, key, descriptors[key]);
  }
}
installMethods(WaveformEditor.prototype, wf_thumbnails(helpers));
installMethods(WaveformEditor.prototype, wf_controls(helpers));
installMethods(WaveformEditor.prototype, wf_pointer(helpers));
installMethods(WaveformEditor.prototype, wf_workspace(helpers));
installMethods(WaveformEditor.prototype, wf_scale_controls(helpers));
installMethods(WaveformEditor.prototype, wf_media(helpers));
installMethods(WaveformEditor.prototype, wf_render(helpers));
installMethods(WaveformEditor.prototype, wf_cue_blocks(helpers));
installMethods(WaveformEditor.prototype, wf_word_blocks(helpers));
installMethods(WaveformEditor.prototype, wf_canvas(helpers));
installMethods(WaveformEditor.prototype, wf_input(helpers));
installMethods(WaveformEditor.prototype, wf_cue_drag(helpers));
installMethods(WaveformEditor.prototype, wf_cue_commands(helpers));
installMethods(WaveformEditor.prototype, wf_gap_drag(helpers));
const markerDescriptors = wf_markers(helpers);
installMethods(WaveformEditor.prototype, markerDescriptors);
installMethods(WaveformEditor.prototype, wf_cue_drag_update(helpers));
installMethods(WaveformEditor.prototype, wf_playback(helpers));

export const AsrWaveform = {
  create(options) {
    return new WaveformEditor(options);
  },
  setColorPalette,
  builtinWorkspaceIds: BUILTIN_WORKSPACE_IDS,
  builtinWorkspaces: BUILTIN_WORKSPACES,
  testing: {
    decodePayload,
    decodeReapeaksFile,
    decodeSpectralPayload,
    peaksRateOf,
    publishPeakRate,
    // 只做选取逻辑的单测入口：用 stub 的 this 调用，无需构造 DOM。
    activeWaveShape: /** @type {any} */ (WaveformEditor.prototype).activeWaveShape,
    syncSpectralColorToggle,
    freqColor,
    resolveTiming,
    waveformGridStepMs,
    snapPointerTimeToTimingGrid,
    remapItems,
    roundMs,
    sourceForFile,
    shouldAdjustAdjacentCuesIndependently,
    shouldAdjustSharedBoundaryHandleIndependently,
    findActiveCueIndex,
    firstCueIndexOverlapping,
    applySharedBoundary,
    applyIndependentEdge,
    applyMoveStep,
    applyBoundaryStep,
    splitSegmentAtTime,
    normalizeNewCueRange,
    clampWaveformScale,
    wheelScrollDelta,
    waveformScaleAfterStep,
    waveformAmplitude,
    waveformScaleFromLoudness,
    loudnessSchema: LOUDNESS_SCHEMA,
    // 只做状态机逻辑的单测入口：用 stub 的 this 调用，无需构造 DOM。
    setLoudnessStats: /** @type {any} */ (WaveformEditor.prototype).setLoudnessStats,
    fitWaveformScaleToLoudness: /** @type {any} */ (WaveformEditor.prototype).fitWaveformScaleToLoudness,
    renderWaveformScaleLabel: /** @type {any} */ (WaveformEditor.prototype).renderWaveformScaleLabel,
    setRowHeight: /** @type {any} */ (WaveformEditor.prototype).setRowHeight,
    setSecondsPerRow: /** @type {any} */ (WaveformEditor.prototype).setSecondsPerRow,
    buildWaveformEnvelope,
    sampleInterpolatedPeak,
    normalizeLayoutData,
    swapLayoutModuleOrder,
    normalizeLayoutTree,
    collectLayoutModules,
    swapLayoutTreeModules,
    insertLayoutModuleAtEdge,
    insertLayoutModuleAtRootEdge,
    layoutDropIntent,
    layoutRootDropIntent,
    layoutDropPreviewRect,
    isMultiRowInComfortZone,
    waveformTopEdgeMs,
    restoreWaveformTopEdgeMs,
    computeGroupBadges,
    cueBlockContinuationEdges,
    // waveform-markers 的纯函数单测入口：跨行挑选与行内时间换算。
    pickMarkerRow: markerDescriptors.pickMarkerRow.value,
    markerRowTimeMs: markerDescriptors.markerRowTimeMs.value,
  },
};
window.AsrWaveform = AsrWaveform;
