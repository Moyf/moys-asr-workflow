import { freezeFacade } from '../state/editor-facade-utils.js';
// 真 ESM：模块顶层定义与发布（原转换体 phase-2 语义 = import 求值）。
// window.<Name> 与导出的 <Name> 是同一对象；消费者逐簇改 import 后移除 window 发布。
'use strict';

import { MaweBoot } from '../boot/editor-boot.js';
import { AsrEditorUtils } from '../../shared/editor-utils.js';


const normalizeTimelineTimebase = AsrEditorUtils.normalizeTimelineTimebase;

const normalizeTimelineFps = AsrEditorUtils.normalizeTimelineFps;

const normalizeTimelineTimecodeSeparator = AsrEditorUtils.normalizeTimelineTimecodeSeparator;

const normalizeMediaMetadata = AsrEditorUtils.normalizeMediaMetadata;

const DEFAULT_TIMELINE_FPS = AsrEditorUtils.DEFAULT_TIMELINE_FPS;

const frameNumberFromMilliseconds = AsrEditorUtils.frameNumberFromMilliseconds;

const millisecondsFromFrameNumber = AsrEditorUtils.millisecondsFromFrameNumber;

const formatFrameTimecode = AsrEditorUtils.formatFrameTimecode;

const formatTimelineTimecode = AsrEditorUtils.formatTimelineTimecode;

const parseFrameTimecode = AsrEditorUtils.parseFrameTimecode;

const MIN_TIMELINE_FPS = AsrEditorUtils.MIN_TIMELINE_FPS;

const MAX_TIMELINE_FPS = AsrEditorUtils.MAX_TIMELINE_FPS;

const TIMELINE_ROUND_MS = 10;


import { MaweHint } from "../ui/editor-hint.js";
import { MaweCoreState } from "../state/editor-core-state.js";
import { MaweDom } from "../ui/editor-dom.js";
import { MaweMultiSubtitleCore } from "../state/editor-multi-subtitle-core.js";
import { MaweSettings } from "../state/editor-settings.js";
import { MaweServerSave } from "../io/editor-server-save.js";
import { MaweMediaPlayback } from "../media/editor-media-playback.js";
import { MaweCuePanel } from "./editor-cue-panel.js";function roundTimelineMilliseconds(value) {
  return Math.round(Number(value) / TIMELINE_ROUND_MS) * TIMELINE_ROUND_MS;
}

function hasValidFramePair(value) {
  return !!value
    && Number.isInteger(value.start_frame)
    && Number.isInteger(value.end_frame)
    && value.start_frame >= 0
    && value.end_frame > value.start_frame;
}

function syncTimeRangeObjectTimebase(value, timebase, { preferFrames = false, frameBounds = null } = {}) {
  if (!value || typeof value !== 'object') return null;
  const frameMode = timebase.unit === 'frames';
  const hasFrames = hasValidFramePair(value);
  const rawStartMs = Number(value.start);
  const rawEndMs = Number(value.end);
  let startFrame = hasFrames && preferFrames
    ? value.start_frame : frameNumberFromMilliseconds(rawStartMs, timebase.fps);
  let endFrame = hasFrames && preferFrames
    ? value.end_frame : frameNumberFromMilliseconds(rawEndMs, timebase.fps);
  if (!Number.isInteger(startFrame) || startFrame < 0) startFrame = 0;
  if (!Number.isInteger(endFrame) || endFrame <= startFrame) endFrame = startFrame + 1;

  if (frameMode) {
    if (frameBounds && Number.isInteger(frameBounds.start) && Number.isInteger(frameBounds.end)) {
      const lower = Math.max(0, frameBounds.start);
      const upper = Math.max(lower + 1, frameBounds.end);
      startFrame = Math.min(Math.max(startFrame, lower), upper - 1);
      endFrame = Math.min(Math.max(endFrame, startFrame + 1), upper);
      if (endFrame <= startFrame) {
        startFrame = Math.max(lower, upper - 1);
        endFrame = upper;
      }
    }
    value.start_frame = startFrame;
    value.end_frame = endFrame;
    value.start = millisecondsFromFrameNumber(startFrame, timebase.fps);
    value.end = millisecondsFromFrameNumber(endFrame, timebase.fps);
  } else {
    const startMs = Number.isFinite(rawStartMs)
      ? Math.max(0, Math.round(rawStartMs)) : millisecondsFromFrameNumber(startFrame, timebase.fps);
    const endMs = Number.isFinite(rawEndMs)
      ? Math.max(startMs + 1, Math.round(rawEndMs)) : millisecondsFromFrameNumber(endFrame, timebase.fps);
    value.start = startMs;
    value.end = Math.max(startMs + 1, endMs);
    value.start_frame = frameNumberFromMilliseconds(value.start, timebase.fps);
    value.end_frame = Math.max(
      value.start_frame + 1,
      frameNumberFromMilliseconds(value.end, timebase.fps),
    );
  }
  return { startFrame: value.start_frame, endFrame: value.end_frame };
}

function syncSegmentTimebase(segment, timebase, { preferFrames = false, minimumStartFrame = 0 } = {}) {
  if (!segment || typeof segment !== 'object') return;
  const range = syncTimeRangeObjectTimebase(segment, timebase, { preferFrames });
  if (timebase.unit === 'frames') {
    const startFrame = Math.max(minimumStartFrame, segment.start_frame);
    const endFrame = Math.max(startFrame + 1, segment.end_frame);
    segment.start_frame = startFrame;
    segment.end_frame = endFrame;
    segment.start = millisecondsFromFrameNumber(startFrame, timebase.fps);
    segment.end = millisecondsFromFrameNumber(endFrame, timebase.fps);
  }
  if (!Array.isArray(segment.items)) return range;
  const frameBounds = timebase.unit === 'frames'
    ? { start: segment.start_frame, end: segment.end_frame } : null;
  segment.items.forEach((item) => {
    syncTimeRangeObjectTimebase(item, timebase, { preferFrames, frameBounds });
  });
  if (timebase.unit === 'frames') {
    AsrEditorUtils.normalizeFrameItemTimingRanges(segment);
  }
  return range;
}

function syncTrackTimebase(segments, timebase, { preferFrames = false } = {}) {
  if (!Array.isArray(segments)) return;
  let previousEndFrame = 0;
  segments.forEach((segment) => {
    syncSegmentTimebase(segment, timebase, {
      preferFrames,
      minimumStartFrame: timebase.unit === 'frames' ? previousEndFrame : 0,
    });
    if (timebase.unit === 'frames' && Number.isInteger(segment?.end_frame)) {
      previousEndFrame = segment.end_frame;
    }
  });
}

function projectTimebase(project = MaweBoot.DATA) {
  return normalizeTimelineTimebase(project?.timebase);
}

function hasExplicitTimelineFps(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const fps = Number(value.fps);
  if (!Number.isFinite(fps) || fps < MIN_TIMELINE_FPS || fps > MAX_TIMELINE_FPS) return false;
  // A non-default FPS or an already-frame-based project represents an
  // explicit choice.  A saved millisecond project with the historical 30 FPS
  // default can still adopt the source media FPS on its first frame switch.
  return value.unit === 'frames' || fps !== DEFAULT_TIMELINE_FPS;
}

function projectMediaVideoFps(project = MaweBoot.DATA) {
  return normalizeMediaMetadata(project?.media_metadata)?.video_fps ?? null;
}

let timelineFpsManuallySet = hasExplicitTimelineFps(MaweBoot.DATA.timebase);

function captureProjectVideoDimensions(mediaElement) {
  if (!mediaElement || mediaElement !== MaweCoreState.player || mediaElement.tagName !== 'VIDEO') return false;
  const width = Number(mediaElement.videoWidth);
  const height = Number(mediaElement.videoHeight);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) return false;
  const current = normalizeMediaMetadata(MaweBoot.DATA.media_metadata) || {};
  if (current.video_width === width && current.video_height === height) return false;
  MaweBoot.DATA.media_metadata = { ...current, video_width: width, video_height: height };
  MaweServerSave.projectImportDirty = true;
  MaweServerSave.scheduleAutoSaveFlush();
  return true;
}

function clearProjectVideoDimensions() {
  const current = normalizeMediaMetadata(MaweBoot.DATA.media_metadata);
  if (!current || (current.video_width === undefined && current.video_height === undefined)) return false;
  const next = { ...current };
  delete next.video_width;
  delete next.video_height;
  MaweBoot.DATA.media_metadata = Object.keys(next).length ? next : null;
  MaweServerSave.projectImportDirty = true;
  MaweServerSave.scheduleAutoSaveFlush();
  return true;
}

function syncProjectTimebase(project = MaweBoot.DATA, { preferFrames = false } = {}) {
if (!project || typeof project !== 'object') return normalizeTimelineTimebase();
const timebase = projectTimebase(project);
project.timebase = { ...timebase };
syncTrackTimebase(project.segments, timebase, { preferFrames });
const tracks = project.multi_subtitle?.tracks;
if (Array.isArray(tracks)) {
  tracks.forEach((track) => syncTrackTimebase(track?.segments, timebase, { preferFrames }));
}
syncTrackTimebase(project.overlay_track?.segments, timebase, { preferFrames });
return timebase;
}

function syncProjectTimebaseAndBindingOffsets(project = MaweBoot.DATA, options = {}) {
  const timebase = syncProjectTimebase(project, options);
  if (project && typeof project === 'object') {
    AsrEditorUtils.rebuildBindingOffsets(project.multi_subtitle, project.segments);
  }
  return timebase;
}

function timelineIsFrameMode() {
  return projectTimebase().unit === 'frames';
}

function timelineMinimumDurationMs() {
  const timebase = projectTimebase();
  if (timebase.unit !== 'frames') return MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS;
  const minimumFrames = Math.max(1, Math.ceil(MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS * timebase.fps / 1000));
  return millisecondsFromFrameNumber(minimumFrames, timebase.fps);
}

function timelineMinimumDurationValue() {
  const timebase = projectTimebase();
  return timebase.unit === 'frames'
    ? Math.max(1, Math.ceil(MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS * timebase.fps / 1000))
    : MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS;
}

function timelineTimingAdapter() {
  const timebase = projectTimebase();
  const frameMode = timebase.unit === 'frames';
  const minimumDuration = timelineMinimumDurationValue();
  const snapThreshold = frameMode
    ? Math.max(1, Math.round(80 * timebase.fps / 1000)) : 80;
  if (!frameMode) {
    return {
      unit: 'milliseconds',
      fps: timebase.fps,
      minDuration: minimumDuration,
      snapThreshold,
      round: roundTimelineMilliseconds,
      getStart: (segment) => Number(segment?.start),
      getEnd: (segment) => Number(segment?.end),
      setStart: (segment, value) => { segment.start = roundTimelineMilliseconds(value); },
      setEnd: (segment, value) => { segment.end = roundTimelineMilliseconds(value); },
      getItemStart: (item) => Number(item?.start),
      getItemEnd: (item) => Number(item?.end),
      setItemStart: (item, value) => { item.start = roundTimelineMilliseconds(value); },
      setItemEnd: (item, value) => { item.end = roundTimelineMilliseconds(value); },
      fromMs: (value) => Number(value),
      toMs: (value) => Number(value),
      format: formatTimelineMilliseconds,
    };
  }
  const readFrame = (value, frameField, msField) => Number.isInteger(value?.[frameField])
    ? value[frameField] : frameNumberFromMilliseconds(value?.[msField], timebase.fps);
  const writeFrame = (value, frameField, msField, frame) => {
    const next = Math.max(0, Math.round(Number(frame)));
    value[frameField] = next;
    value[msField] = millisecondsFromFrameNumber(next, timebase.fps);
  };
  return {
    unit: 'frames',
    fps: timebase.fps,
    minDuration: minimumDuration,
    snapThreshold,
    round: (value) => Math.round(Number(value)),
    getStart: (segment) => readFrame(segment, 'start_frame', 'start'),
    getEnd: (segment) => readFrame(segment, 'end_frame', 'end'),
    setStart: (segment, value) => writeFrame(segment, 'start_frame', 'start', value),
    setEnd: (segment, value) => writeFrame(segment, 'end_frame', 'end', value),
    getItemStart: (item) => readFrame(item, 'start_frame', 'start'),
    getItemEnd: (item) => readFrame(item, 'end_frame', 'end'),
    setItemStart: (item, value) => writeFrame(item, 'start_frame', 'start', value),
    setItemEnd: (item, value) => writeFrame(item, 'end_frame', 'end', value),
    fromMs: (value) => frameNumberFromMilliseconds(value, timebase.fps),
    toMs: (value) => millisecondsFromFrameNumber(value, timebase.fps),
    format: (value) => formatFrameTimecode(
      value,
      timebase.fps,
      MaweSettings.EDITOR_SETTINGS.timelineTimecodeSeparator,
    ),
  };
}

function formatTimelineMilliseconds(ms) {
  const safe = Math.max(0, Math.round(Number(ms) || 0));
  const s = safe / 1000;
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(3).padStart(6, '0')}`;
}

function timelineMediaSeekStepValue() {
  return timelineIsFrameMode()
    ? MaweSettings.EDITOR_SETTINGS.mediaSeekStepFrames : MaweSettings.EDITOR_SETTINGS.mediaSeekStepMs;
}

function timelineCueMoveStepValue() {
  return timelineIsFrameMode()
    ? MaweSettings.EDITOR_SETTINGS.cueMoveStepFrames : MaweSettings.EDITOR_SETTINGS.cueMoveStepMs;
}

function timelineValueToMilliseconds(value) {
  const timebase = projectTimebase();
  return timebase.unit === 'frames'
    ? millisecondsFromFrameNumber(value, timebase.fps) : Number(value);
}

function timelineFrameAlignedMilliseconds(valueMs) {
  const numeric = Number(valueMs);
  if (!Number.isFinite(numeric) || !timelineIsFrameMode()) return numeric;
  const timebase = projectTimebase();
  return millisecondsFromFrameNumber(
    frameNumberFromMilliseconds(numeric, timebase.fps),
    timebase.fps,
  );
}

function timelineUiText(zh, en) {
  return window.MAWE_I18N?.language === 'en' ? en : zh;
}

function timelineMediaSeekStepMilliseconds() {
  return timelineValueToMilliseconds(timelineMediaSeekStepValue());
}

function timelineHasSubtitleData() {
  return (Array.isArray(MaweBoot.DATA?.segments) && MaweBoot.DATA.segments.length > 0)
    || (Array.isArray(MaweBoot.DATA?.multi_subtitle?.tracks)
      && MaweBoot.DATA.multi_subtitle.tracks.some((track) => Array.isArray(track?.segments)
        && track.segments.length > 0));
}

function confirmTimelineFrameRemap(current, nextUnit, nextFps) {
  const enteringFrames = current.unit !== 'frames' && nextUnit === 'frames';
  const changingFrameRate = current.unit === 'frames' && current.fps !== nextFps;
  if ((!enteringFrames && !changingFrameRate) || !timelineHasSubtitleData()) return true;
  const message = enteringFrames
    ? timelineUiText(
      `切换到帧时间基准（${nextFps} FPS）会批量将当前工程的所有字幕段、字词和副字幕时间映射到最近帧，并重写毫秒兼容值。原始的非帧对齐毫秒值无法在切回毫秒时恢复。是否继续？`,
      `Switching to the frame timebase (${nextFps} FPS) will remap all subtitle segments, word timings, and secondary subtitle timings to frame boundaries and rewrite the compatible millisecond values. Original non-frame-aligned millisecond values cannot be restored when switching back. Continue?`,
    )
    : timelineUiText(
      `将 FPS 从 ${current.fps} 改为 ${nextFps} 会批量重新映射当前工程的所有字幕段、字词和副字幕时间，并重写毫秒兼容值。原始的非帧对齐毫秒值无法恢复。是否继续？`,
      `Changing FPS from ${current.fps} to ${nextFps} will remap all subtitle segments, word timings, and secondary subtitle timings and rewrite the compatible millisecond values. Original non-frame-aligned millisecond values cannot be restored. Continue?`,
    );
  return window.confirm(message);
}

function refreshTimelineSettingsUi() {
  const timebase = projectTimebase();
  const frameMode = timebase.unit === 'frames';
  const separator = normalizeTimelineTimecodeSeparator(MaweSettings.EDITOR_SETTINGS.timelineTimecodeSeparator);
  if (MaweDom.timelineTimebaseSelect) MaweDom.timelineTimebaseSelect.value = timebase.unit;
  if (MaweDom.timelineFpsInput) MaweDom.timelineFpsInput.value = String(timebase.fps);
  if (MaweDom.timelineSnapToFrameToggle) {
    MaweDom.timelineSnapToFrameToggle.checked = frameMode && MaweSettings.EDITOR_SETTINGS.timelineSnapToFrame;
    MaweDom.timelineSnapToFrameToggle.disabled = !frameMode;
  }
  if (MaweDom.timelineTimecodeSeparatorInput) MaweDom.timelineTimecodeSeparatorInput.value = separator;
  if (MaweDom.mediaSeekStepInput) {
    MaweDom.mediaSeekStepInput.min = frameMode ? '1' : String(MaweSettings.MEDIA_SEEK_STEP_MIN_MS);
    MaweDom.mediaSeekStepInput.max = frameMode ? '240' : String(MaweSettings.MEDIA_SEEK_STEP_MAX_MS);
    MaweDom.mediaSeekStepInput.step = frameMode ? '1' : String(MaweSettings.mediaSeekStepForValue(MaweSettings.EDITOR_SETTINGS.mediaSeekStepMs));
    MaweDom.mediaSeekStepInput.value = String(timelineMediaSeekStepValue());
  }
  if (MaweDom.cueMoveStepInput) {
    MaweDom.cueMoveStepInput.min = frameMode ? '1' : String(MaweSettings.CUE_MOVE_STEP_MIN_MS);
    MaweDom.cueMoveStepInput.max = frameMode ? '240' : String(MaweSettings.CUE_MOVE_STEP_MAX_MS);
    MaweDom.cueMoveStepInput.step = frameMode ? '1' : '10';
    MaweDom.cueMoveStepInput.value = String(timelineCueMoveStepValue());
  }
  if (MaweDom.mediaSeekStepUnit) MaweDom.mediaSeekStepUnit.textContent = frameMode ? 'F' : 'ms';
  if (MaweDom.cueMoveStepUnit) MaweDom.cueMoveStepUnit.textContent = frameMode ? 'F' : 'ms';
  if (MaweDom.mediaSeekStepHint) {
    MaweDom.mediaSeekStepHint.textContent = frameMode
      ? timelineUiText(
        `控制按钮和左右方向键的每次跳转帧数（当前 FPS：${timebase.fps}）。`,
        `Number of frames jumped by the controls and left/right arrow keys (current FPS: ${timebase.fps}).`,
      )
      : timelineUiText(
        '控制按钮和左右方向键的跳转步长（单位：ms）。',
        'Duration for each jump from the controls and left/right arrow keys (unit: ms).',
      );
  }
  if (MaweDom.cueMoveStepHint) {
    MaweDom.cueMoveStepHint.textContent = frameMode
      ? timelineUiText(
        '方向键和按住字幕块/边界时按帧微调；具体用法详见帮助的「微调字幕」区。',
        'Arrow keys and A/D fine-tune frame by frame while holding a cue/block or boundary; see the “Subtitle fine-tuning” section in Help for details.',
      )
      : timelineUiText(
        '具体用法详见帮助的「微调字幕」区。',
        'See the “Subtitle fine-tuning” section in Help for details.',
      );
  }
  if (MaweDom.timelineTimebaseHint) {
    MaweDom.timelineTimebaseHint.textContent = frameMode
      ? timelineUiText(
        `帧模式使用 HH:MM:SS${separator}FF 显示，FF 为当前秒内的帧号；当前 FPS：${timebase.fps}。`,
        `Frame mode uses HH:MM:SS${separator}FF, where FF is the frame number within the current second; current FPS: ${timebase.fps}.`,
      )
      : timelineUiText(
        '毫秒模式保持原有时间编辑方式。切换为帧模式后，拖动、方向键和 A/D 微调都会按帧执行。',
        'Millisecond mode keeps the existing timing behavior. Switching to frame mode makes dragging, arrow keys, and A/D fine-tuning operate frame by frame.',
      );
  }
  if (MaweDom.timelineSnapToFrameHint) {
    MaweDom.timelineSnapToFrameHint.textContent = frameMode
      ? timelineUiText(
        '启用后，波形鼠标指针会吸附到最近的帧位置。',
        'When enabled, the waveform pointer snaps to the nearest frame.',
      )
      : timelineUiText(
        '仅帧模式生效；切换到帧模式后可启用。',
        'Only active in frame mode; switch to frame mode to enable it.',
      );
  }
  if (MaweDom.timelineTimecodeSeparatorHint) {
    MaweDom.timelineTimecodeSeparatorHint.textContent = timelineUiText(
      `帧时间码示例：HH:MM:SS${separator}FF；只替换秒与帧之间的分隔符。`,
      `Frame timecode example: HH:MM:SS${separator}FF; only the separator between seconds and frames changes.`,
    );
  }
  MaweDom.mediaSeekInputLastValue = timelineMediaSeekStepValue();
  MaweMediaPlayback.refreshMediaSeekStepHelp();
  MaweMediaPlayback.refreshMediaSeekControlLabels();
}

function setTimelineTimebase(patch = {}) {
  const current = projectTimebase();
  const nextUnit = patch.unit === 'frames' || patch.unit === 'milliseconds'
    ? patch.unit : current.unit;
  const hasFpsPatch = Object.prototype.hasOwnProperty.call(patch, 'fps');
  const mediaDefaultFps = !timelineFpsManuallySet
    && !hasFpsPatch
    && current.unit !== 'frames'
    && nextUnit === 'frames'
    ? projectMediaVideoFps()
    : null;
  const nextFps = mediaDefaultFps ?? normalizeTimelineFps(patch.fps, current.fps);
  if (current.unit === nextUnit && current.fps === nextFps) {
    if (hasFpsPatch) timelineFpsManuallySet = true;
    refreshTimelineSettingsUi();
    return;
  }
  if (!confirmTimelineFrameRemap(current, nextUnit, nextFps)) {
    refreshTimelineSettingsUi();
    return;
  }
  if (hasFpsPatch) timelineFpsManuallySet = true;
  // 先按旧时间基准把当前工程的双份时间值同步，再决定新 FPS 下是否保留帧号。
  syncProjectTimebaseAndBindingOffsets(MaweBoot.DATA, { preferFrames: current.unit === 'frames' });
  MaweBoot.DATA.timebase = { unit: nextUnit, fps: nextFps };
  // 变更 FPS 时保持媒体中的实际时间位置，再按新 FPS 重算独立帧字段；
  // 否则同一个帧号会因 FPS 改变而把字幕整体提前或推后。
  syncProjectTimebaseAndBindingOffsets(MaweBoot.DATA, { preferFrames: false });
  MaweServerSave.projectImportDirty = true;
  refreshTimelineSettingsUi();
  MaweCuePanel.renderAll({ waveform: 'full' });
  MaweServerSave.scheduleAutoSaveFlush();
  const description = nextUnit === 'frames'
    ? timelineUiText(`已切换到帧时间基准（${nextFps} FPS）`, `Switched to frame timebase (${nextFps} FPS)`)
    : timelineUiText('已切换到毫秒时间基准', 'Switched to millisecond timebase');
  MaweHint.flashHint(description, 'success');
}

// 贴合字幕边界模式：dual（中缝联动，新默认）/ classic（自动吸附开关 + Alt 反转）。
// classic 下保留“自动吸附调整相邻字幕”开关；dual 下该开关只影响键盘微调，
// 鼠标手柄始终独立，联动交给波形上的中缝拖动区，因此隐藏开关行避免误解。
function refreshAdjacentBoundaryModeUi() {
  const isDual = MaweSettings.EDITOR_SETTINGS.adjacentBoundaryMode === 'dual';
  // 用内联 display 切换：.editor-settings-item 的 display:inline-flex
  // 会覆盖 hidden 属性的 UA 样式。
  if (MaweDom.autoSnapAdjacentCuesRow) MaweDom.autoSnapAdjacentCuesRow.style.display = isDual ? 'none' : '';
  if (MaweDom.autoSnapAdjacentCuesHint) MaweDom.autoSnapAdjacentCuesHint.style.display = isDual ? 'none' : '';
  if (MaweDom.adjacentBoundaryModeHintDual) MaweDom.adjacentBoundaryModeHintDual.style.display = isDual ? '' : 'none';
}

window.MaweTimeline = Object.freeze({
  normalizeTimelineTimebase,
  normalizeTimelineFps,
  normalizeTimelineTimecodeSeparator,
  normalizeMediaMetadata,
  DEFAULT_TIMELINE_FPS,
  frameNumberFromMilliseconds,
  millisecondsFromFrameNumber,
  formatFrameTimecode,
  formatTimelineTimecode,
  parseFrameTimecode,
  MIN_TIMELINE_FPS,
  MAX_TIMELINE_FPS,
  TIMELINE_ROUND_MS,
  roundTimelineMilliseconds,
  hasValidFramePair,
  syncTimeRangeObjectTimebase,
  syncSegmentTimebase,
  syncTrackTimebase,
  projectTimebase,
  hasExplicitTimelineFps,
  projectMediaVideoFps,
  get timelineFpsManuallySet() { return timelineFpsManuallySet; },
  set timelineFpsManuallySet(v) { timelineFpsManuallySet = v; },
  captureProjectVideoDimensions,
  clearProjectVideoDimensions,
  syncProjectTimebase,
  syncProjectTimebaseAndBindingOffsets,
  timelineIsFrameMode,
  timelineMinimumDurationMs,
  timelineMinimumDurationValue,
  timelineTimingAdapter,
  formatTimelineMilliseconds,
  timelineMediaSeekStepValue,
  timelineCueMoveStepValue,
  timelineValueToMilliseconds,
  timelineFrameAlignedMilliseconds,
  timelineUiText,
  timelineMediaSeekStepMilliseconds,
  timelineHasSubtitleData,
  confirmTimelineFrameRemap,
  refreshTimelineSettingsUi,
  setTimelineTimebase,
  refreshAdjacentBoundaryModeUi
});

export const MaweTimeline = freezeFacade({
    normalizeTimelineTimebase,
    normalizeTimelineFps,
    normalizeTimelineTimecodeSeparator,
    normalizeMediaMetadata,
    DEFAULT_TIMELINE_FPS,
    frameNumberFromMilliseconds,
    millisecondsFromFrameNumber,
    formatFrameTimecode,
    formatTimelineTimecode,
    parseFrameTimecode,
    MIN_TIMELINE_FPS,
    MAX_TIMELINE_FPS,
    TIMELINE_ROUND_MS,
    roundTimelineMilliseconds,
    hasValidFramePair,
    syncTimeRangeObjectTimebase,
    syncSegmentTimebase,
    syncTrackTimebase,
    projectTimebase,
    hasExplicitTimelineFps,
    projectMediaVideoFps,
    get timelineFpsManuallySet() { return timelineFpsManuallySet; },
    set timelineFpsManuallySet(v) { timelineFpsManuallySet = v; },
    captureProjectVideoDimensions,
    clearProjectVideoDimensions,
    syncProjectTimebase,
    syncProjectTimebaseAndBindingOffsets,
    timelineIsFrameMode,
    timelineMinimumDurationMs,
    timelineMinimumDurationValue,
    timelineTimingAdapter,
    formatTimelineMilliseconds,
    timelineMediaSeekStepValue,
    timelineCueMoveStepValue,
    timelineValueToMilliseconds,
    timelineFrameAlignedMilliseconds,
    timelineUiText,
    timelineMediaSeekStepMilliseconds,
    timelineHasSubtitleData,
    confirmTimelineFrameRemap,
    refreshTimelineSettingsUi,
    setTimelineTimebase,
    refreshAdjacentBoundaryModeUi
  }, ["timelineFpsManuallySet"]);
window.MaweTimeline = MaweTimeline;
