const DATA = __DATA_JSON__;
let FILENAME_BASE = __FILENAME_BASE_JSON__;
const STICKERS = __STICKERS_JSON__;
let STICKER_ROOT = __STICKER_ROOT_JSON__;  // 表情包根目录的绝对路径（无尾斜杠）
let STICKER_URL_PREFIX = __STICKER_URL_PREFIX_JSON__;
const SERVER_CONFIG = __SERVER_CONFIG_JSON__;
const NINJA_SFX_BASE_URL = __NINJA_SFX_BASE_URL_JSON__;

const MULTI_SUBTITLE_UTILS = window.AsrEditorUtils;
const MULTI_SUBTITLE_TOLERANCE_MS = MULTI_SUBTITLE_UTILS.MULTI_SUBTITLE_TOLERANCE_MS || 300;
const MULTI_SUBTITLE_MERGE_OVERLAP_TOLERANCE_MS = 500;
const MULTI_SUBTITLE_ROW_HEIGHT_PRESETS = [64, 80, 96, 120, 144, 168];
const DEFAULT_MULTI_SUBTITLE_ROW_HEIGHT = 168;
const SUBTITLE_MIN_DURATION_MS = 100;
const MULTI_SUBTITLE_IMPORT_PROMPT = '是否选择导入第二条字幕以开启多重字幕模式？';
const MULTI_SUBTITLE_TOGGLE_TITLE = '当前工程如果有大于1条字幕，可以开启多重字幕模式，用于双语字幕编辑等。';
let normalizedMultiSubtitleReference = null;
let pendingSrtImportAsExtension = false;

function normalizeMultiSubtitleState() {
  if (normalizedMultiSubtitleReference === DATA.multi_subtitle) return DATA.multi_subtitle;
  MULTI_SUBTITLE_UTILS.normalizeMultiSubtitleProject(DATA);
  normalizedMultiSubtitleReference = DATA.multi_subtitle;
  return DATA.multi_subtitle;
}

function getMultiSubtitleState() {
  return normalizeMultiSubtitleState();
}

function getExtensionTrack(trackId = null) {
  const multi = getMultiSubtitleState();
  return (multi.tracks || []).find((track) => !trackId || track.id === trackId) || null;
}

function getActiveExtensionTrack() {
  return getExtensionTrack();
}

function multiSubtitleVisible() {
  return getMultiSubtitleState().enabled === true && Boolean(getActiveExtensionTrack());
}

function isConfiguredSubtitleSplitMode(value) {
  return MULTI_SUBTITLE_UTILS.MULTI_SUBTITLE_SPLIT_MODES.has(value);
}

function getMainSubtitleSplitMode(segment = null) {
  const multi = getMultiSubtitleState();
  if (multi.enabled === true && isConfiguredSubtitleSplitMode(multi.main_split_mode)) {
    return multi.main_split_mode;
  }
  const text = segment?.text ?? DATA.segments.map((item) => item?.text || '').join('\n');
  return MULTI_SUBTITLE_UTILS.detectSubtitleSplitMode(text);
}

function getExtensionSubtitleSplitMode(track = getActiveExtensionTrack(), segment = null) {
  if (isConfiguredSubtitleSplitMode(track?.split_mode)) return track.split_mode;
  const text = segment?.text ?? (track?.segments || []).map((item) => item?.text || '').join('\n');
  return MULTI_SUBTITLE_UTILS.detectSubtitleSplitMode(text, track?.language);
}

function splitModeLabel(mode) {
  return mode === 'continuous' ? '字符型' : '单词型';
}

function multiSubtitleWaveformStructureKey(state = getMultiSubtitleState()) {
  const trackIds = Array.isArray(state?.tracks)
    ? state.tracks.map((track) => String(track?.id || '')).join('|')
    : '';
  return `${state?.enabled === true ? '1' : '0'}:${trackIds}`;
}

function mainSegmentById(id) {
  const target = String(id || '');
  return DATA.segments.find((segment) => segment?.id === target) || null;
}

function extensionSegmentById(id, track = getActiveExtensionTrack()) {
  const target = String(id || '');
  return track?.segments?.find((segment) => segment?.id === target) || null;
}

function bindingForMainIndex(index) {
  const segment = DATA.segments[index];
  return segment ? MULTI_SUBTITLE_UTILS.bindingForSegment(getMultiSubtitleState(), segment.id, 'main') : null;
}

function bindingForExtensionIndex(index, track = getActiveExtensionTrack()) {
  const segment = track?.segments?.[index];
  return segment ? MULTI_SUBTITLE_UTILS.bindingForSegment(getMultiSubtitleState(), segment.id, 'extension', track.id) : null;
}

function getBindingMarkerTargets() {
  const main = new Set();
  const extension = new Set();
  if (!multiSubtitleVisible()) return { main, extension };
  const track = getActiveExtensionTrack();
  const addBindingTargets = (binding) => {
    if (!binding) return;
    (binding.main_segment_ids || []).forEach((id) => {
      const index = DATA.segments.findIndex((segment) => segment?.id === id);
      if (index >= 0) main.add(index);
    });
    const bindingTrack = getExtensionTrack(binding.track_id) || track;
    (binding.extension_segment_ids || []).forEach((id) => {
      const index = bindingTrack?.segments?.findIndex((segment) => segment?.id === id) ?? -1;
      if (index >= 0 && bindingTrack === track) extension.add(index);
    });
  };
  selectedIdxs.forEach((index) => addBindingTargets(bindingForMainIndex(index)));
  selectedExtensionIdxs.forEach((index) => addBindingTargets(bindingForExtensionIndex(index, track)));
  return { main, extension };
}

function extensionForMainIndex(index) {
  const binding = bindingForMainIndex(index);
  return binding ? extensionSegmentById(binding.extension_segment_ids?.[0], getExtensionTrack(binding.track_id)) : null;
}

function mainIndexForExtensionIndex(index, track = getActiveExtensionTrack()) {
  const segment = track?.segments?.[index];
  if (!segment) return -1;
  const binding = MULTI_SUBTITLE_UTILS.bindingForSegment(getMultiSubtitleState(), segment.id, 'extension', track.id);
  const mainId = binding?.main_segment_ids?.[0];
  return DATA.segments.findIndex((candidate) => candidate.id === mainId);
}

function removeBindingsForSegmentIds(mainIds = [], extensionIds = []) {
  const mainSet = new Set(mainIds.filter(Boolean));
  const extensionSet = new Set(extensionIds.filter(Boolean));
  const multi = getMultiSubtitleState();
  MULTI_SUBTITLE_UTILS.removeSubtitleBindings(multi, (binding) => (
    binding.main_segment_ids?.some((id) => mainSet.has(id))
      || binding.extension_segment_ids?.some((id) => extensionSet.has(id))
  ));
  MULTI_SUBTITLE_UTILS.rebuildBindingOffsets(multi, DATA.segments);
}

function addSubtitleBinding(mainSegment, extensionSegment, track = getActiveExtensionTrack()) {
  if (!mainSegment || !extensionSegment || !track) return null;
  const multi = getMultiSubtitleState();
  removeBindingsForSegmentIds([mainSegment.id], [extensionSegment.id]);
  const binding = MULTI_SUBTITLE_UTILS.buildSubtitleBinding(mainSegment, extensionSegment, track.id);
  multi.bindings.push(binding);
  multi.enabled = true;
  MULTI_SUBTITLE_UTILS.rebuildBindingOffsets(multi, DATA.segments);
  return binding;
}

function markMultiSubtitleDirty() {
  const multi = getMultiSubtitleState();
  if (!multi.enabled && !(multi.tracks || []).length) return;
  multi._dirty = true;
  (multi.tracks || []).forEach((track) => track.segments.forEach((segment) => { segment._dirty = true; }));
}

function markMainSegmentsDirty(segments = DATA.segments) {
  (Array.isArray(segments) ? segments : []).forEach((segment) => {
    if (segment) segment._dirty = true;
  });
}

function normalizeMultiSubtitleRowHeight(value) {
  const next = Number(value);
  return MULTI_SUBTITLE_ROW_HEIGHT_PRESETS.includes(next)
    ? next : DEFAULT_MULTI_SUBTITLE_ROW_HEIGHT;
}

function syncBindingOffsets() {
  MULTI_SUBTITLE_UTILS.rebuildBindingOffsets(getMultiSubtitleState(), DATA.segments);
}

function clampExtensionRange(segment, start, end, duration = waveformEditor?.durationMs || Infinity) {
  const safeStart = Math.max(0, Math.round(Number(start) || 0));
  const safeEnd = Math.max(
    safeStart + SUBTITLE_MIN_DURATION_MS,
    Math.round(Number(end) || safeStart + SUBTITLE_MIN_DURATION_MS),
  );
  const maxEnd = Number.isFinite(duration) && duration > 0 ? duration : safeEnd;
  const nextStart = Math.min(
    safeStart,
    Math.max(0, maxEnd - SUBTITLE_MIN_DURATION_MS),
  );
  const nextEnd = Math.min(
    maxEnd,
    Math.max(nextStart + SUBTITLE_MIN_DURATION_MS, safeEnd),
  );
  if (segment) {
    segment.start = nextStart;
    segment.end = nextEnd;
  }
  return { start: nextStart, end: nextEnd };
}

function clampNumber(value, lower, upper) {
  return Math.min(Math.max(value, lower), upper);
}

function getSubtitleTimelineDuration() {
  const duration = Number(waveformEditor?.durationMs);
  return Number.isFinite(duration) && duration > 0 ? duration : Infinity;
}

function getTrackNeighborBounds(segment, segments, movedSegments = new Set()) {
  const index = Array.isArray(segments) ? segments.indexOf(segment) : -1;
  if (index < 0) return null;
  let previousIndex = index - 1;
  while (previousIndex >= 0 && movedSegments.has(segments[previousIndex])) previousIndex -= 1;
  let nextIndex = index + 1;
  while (nextIndex < segments.length && movedSegments.has(segments[nextIndex])) nextIndex += 1;
  return {
    previousEnd: previousIndex >= 0
      ? Number(segments[previousIndex]?.end) : 0,
    nextStart: nextIndex < segments.length
      ? Number(segments[nextIndex]?.start) : getSubtitleTimelineDuration(),
  };
}

function extensionRangeOverlapsNeighbors(segment, start, end, track, movedSegments = new Set()) {
  return (track?.segments || []).some((candidate) => (
    candidate !== segment
      && !movedSegments.has(candidate)
      && Number(candidate.start) < end
      && Number(candidate.end) > start
  ));
}

function setExtensionSegmentRange(segment, start, end) {
  if (!segment) return { start, end, changed: false };
  const oldStart = Number(segment.start);
  const oldEnd = Number(segment.end);
  const safe = clampExtensionRange(null, start, end);
  segment.start = safe.start;
  segment.end = safe.end;
  segment.items = remapPanelItems(
    segment.items,
    Number.isFinite(oldStart) ? oldStart : safe.start,
    Number.isFinite(oldEnd) ? oldEnd : safe.end,
    safe.start,
    safe.end,
  );
  segment._dirty = true;
  return {
    ...safe,
    changed: oldStart !== safe.start || oldEnd !== safe.end,
  };
}

function extensionTrackSelectionSnapshot(track) {
  if (!track) return null;
  const active = getActiveExtensionTrack()?.id === track.id;
  const selectedIds = active ? new Set([...selectedExtensionIdxs]
    .map((index) => track.segments[index]?.id)
    .filter(Boolean)) : new Set();
  const currentId = active && currentCuePanelKind === 'extension'
    && currentCuePanelTrackId === track.id
    ? track.segments[currentCuePanelIdx]?.id : null;
  const lastClickedId = active ? track.segments[lastClickedExtensionIdx]?.id || null : null;
  return { active, selectedIds, currentId, lastClickedId };
}

function restoreExtensionTrackSelection(track, snapshot) {
  if (!track || !snapshot?.active) return;
  selectedExtensionIdxs.clear();
  snapshot.selectedIds.forEach((id) => {
    const index = track.segments.findIndex((segment) => segment?.id === id);
    if (index >= 0) selectedExtensionIdxs.add(index);
  });
  if (snapshot.currentId && currentCuePanelKind === 'extension'
      && currentCuePanelTrackId === track.id) {
    currentCuePanelIdx = track.segments.findIndex((segment) => segment?.id === snapshot.currentId);
    if (currentCuePanelIdx < 0) {
      currentCuePanelKind = 'main';
      currentCuePanelTrackId = null;
    }
  }
  lastClickedExtensionIdx = snapshot.lastClickedId
    ? track.segments.findIndex((segment) => segment?.id === snapshot.lastClickedId) : -1;
  selCountEl.textContent = String(selectedIdxs.size + selectedExtensionIdxs.size);
}

function sortExtensionTrackSegments(track) {
  if (!track?.segments || track.segments.length < 2) return false;
  const entries = track.segments.map((segment, index) => ({ segment, index }));
  const numberCompare = (left, right) => {
    const leftFinite = Number.isFinite(Number(left));
    const rightFinite = Number.isFinite(Number(right));
    if (leftFinite !== rightFinite) return leftFinite ? -1 : 1;
    if (!leftFinite) return 0;
    return Number(left) - Number(right);
  };
  entries.sort((left, right) => (
    numberCompare(left.segment?.start, right.segment?.start)
      || numberCompare(left.segment?.end, right.segment?.end)
      || left.index - right.index
  ));
  const changed = entries.some((entry, index) => entry.segment !== track.segments[index]);
  if (!changed) return false;
  const snapshot = extensionTrackSelectionSnapshot(track);
  track.segments = entries.map((entry) => entry.segment);
  track._dirty = true;
  restoreExtensionTrackSelection(track, snapshot);
  return true;
}

function reconcileExtensionTrack(track, preferredSegments = [], { sortSegments = true } = {}) {
  const empty = { changed: false, squeezedCount: 0, removedCount: 0, unboundCount: 0 };
  if (!track?.segments?.length) return empty;

  const preferred = preferredSegments.filter((segment) => track.segments.includes(segment));
  const preferredSet = new Set(preferred);
  const removed = new Set();
  const snapshot = extensionTrackSelectionSnapshot(track);
  const result = { ...empty };

  // 优先保护正在对齐/联动的字幕；主字幕轨的时间范围不能被副字幕反向修改。
  const orderedPreferred = preferred.slice().sort((left, right) => (
    Number(left.start) - Number(right.start)
      || Number(left.end) - Number(right.end)
      || track.segments.indexOf(left) - track.segments.indexOf(right)
  ));
  let previousPreferred = null;
  orderedPreferred.forEach((segment) => {
    if (removed.has(segment)) return;
    if (previousPreferred && Number(segment.start) < Number(previousPreferred.end)) {
      const nextStart = Number(previousPreferred.end);
      if (Number(segment.end) - nextStart < SUBTITLE_MIN_DURATION_MS) {
        removed.add(segment);
        return;
      }
      const changed = setExtensionSegmentRange(segment, nextStart, segment.end).changed;
      if (changed) result.changed = true;
    }
    if (!previousPreferred || Number(segment.end) > Number(previousPreferred.end)) {
      previousPreferred = segment;
    }
  });

  const protectedRanges = orderedPreferred
    .filter((segment) => !removed.has(segment))
    .sort((left, right) => Number(left.start) - Number(right.start));

  // 一个旧字幕被目标范围穿过时，保留未被覆盖的最长连续一侧；如果没有达到最短时长，
  // 就删除它并解除绑定。这样既保持副轨不重叠，也不会凭空复制一条相同文本字幕。
  track.segments.forEach((candidate) => {
    if (preferredSet.has(candidate) || removed.has(candidate)) return;
    const candidateStart = Number(candidate.start);
    const candidateEnd = Number(candidate.end);
    if (!Number.isFinite(candidateStart) || !Number.isFinite(candidateEnd)) return;
    const pieces = [];
    let cursor = candidateStart;
    protectedRanges.forEach((range) => {
      const rangeStart = Number(range.start);
      const rangeEnd = Number(range.end);
      if (rangeEnd <= cursor || rangeStart >= candidateEnd) return;
      if (rangeStart > cursor) pieces.push([cursor, Math.min(rangeStart, candidateEnd)]);
      cursor = Math.max(cursor, rangeEnd);
    });
    if (cursor < candidateEnd) pieces.push([cursor, candidateEnd]);
    const viable = pieces.filter(([start, end]) => end - start >= SUBTITLE_MIN_DURATION_MS);
    if (!viable.length) {
      removed.add(candidate);
      return;
    }
    viable.sort((left, right) => (right[1] - right[0]) - (left[1] - left[0]) || left[0] - right[0]);
    const [nextStart, nextEnd] = viable[0];
    if (nextStart !== candidateStart || nextEnd !== candidateEnd) {
      setExtensionSegmentRange(candidate, nextStart, nextEnd);
      result.squeezedCount += 1;
      result.changed = true;
    }
  });

  if (removed.size) {
    const removedIds = new Set([...removed].map((segment) => segment.id).filter(Boolean));
    const multi = getMultiSubtitleState();
    const removedBindings = MULTI_SUBTITLE_UTILS.removeSubtitleBindings(multi, (binding) => (
      binding.extension_segment_ids?.some((id) => removedIds.has(id))
    ));
    track.segments = track.segments.filter((segment) => !removed.has(segment));
    result.removedCount = removed.size;
    result.unboundCount = removedBindings.length;
    result.changed = true;
    restoreExtensionTrackSelection(track, snapshot);
  }
  if (sortSegments && sortExtensionTrackSegments(track)) result.changed = true;
  if (result.changed) {
    track._dirty = true;
    syncBindingOffsets();
  }
  return result;
}

// 主字幕驱动副字幕时，目标范围优先；其它副字幕会被裁剪到目标范围之外，
// 完全被覆盖或无法保留最短时长的字幕会被删除。主字幕时间始终不反向改变。
function resolveExtensionFollowerRange(
  segment,
  start,
  end,
  mode,
  track,
  movedSegments = new Set(),
  { sortSegments = true } = {},
) {
  if (!track?.segments?.includes(segment)) {
    const safe = clampExtensionRange(null, start, end);
    return { ...safe, adjusted: false, conflict: false, squeezedCount: 0, removedCount: 0 };
  }
  const safe = setExtensionSegmentRange(segment, start, end);
  const protectedSegments = movedSegments.size
    ? track.segments.filter((candidate) => movedSegments.has(candidate) && candidate !== segment)
    : [];
  const result = reconcileExtensionTrack(
    track,
    [segment, ...protectedSegments],
    { sortSegments },
  );
  return {
    start: segment.start,
    end: segment.end,
    adjusted: safe.changed,
    conflict: false,
    squeezedCount: result.squeezedCount,
    removedCount: result.removedCount,
    unboundCount: result.unboundCount,
  };
}

function constrainCueRangeToTrack(segment, desiredStart, desiredEnd, segments) {
  const bounds = getTrackNeighborBounds(segment, segments);
  if (!bounds) return { start: segment.start, end: segment.end, blocked: false };
  const gapStart = Math.max(0, bounds.previousEnd);
  const gapEnd = Math.min(getSubtitleTimelineDuration(), bounds.nextStart);
  const gapDuration = gapEnd - gapStart;
  if (gapDuration < SUBTITLE_MIN_DURATION_MS) {
    return { start: segment.start, end: segment.end, blocked: true };
  }
  const duration = Math.min(
    Math.max(SUBTITLE_MIN_DURATION_MS, Number(desiredEnd) - Number(desiredStart)),
    gapDuration,
  );
  const start = clampNumber(
    Number(desiredStart),
    gapStart,
    gapEnd - duration,
  );
  return { start, end: start + duration, blocked: false };
}

function notifyBoundSyncWarning(drag, message) {
  if (!drag || drag.boundSyncWarningShown) return;
  drag.boundSyncWarningShown = true;
  flashHint(message, 'warning');
}

function syncBoundExtensionForMain(mainSegment, patch = {}) {
  if (!mainSegment || patch.independent || !multiSubtitleVisible()) return false;
  const binding = MULTI_SUBTITLE_UTILS.bindingForSegment(getMultiSubtitleState(), mainSegment.id, 'main');
  const extension = binding
    ? extensionSegmentById(binding.extension_segment_ids?.[0], getExtensionTrack(binding.track_id))
    : null;
  if (!extension) return false;
  const oldStart = Number(patch.oldStart ?? mainSegment.start);
  const oldEnd = Number(patch.oldEnd ?? mainSegment.end);
  const deltaStart = Number(mainSegment.start) - oldStart;
  const deltaEnd = Number(mainSegment.end) - oldEnd;
  const mode = patch.mode || (patch.edge
    ? patch.edge
    : deltaStart === deltaEnd ? 'move' : 'range');
  let nextStart = extension.start;
  let nextEnd = extension.end;
  if (patch.mode === 'move' || mode === 'move') {
    nextStart = extension.start + deltaStart;
    nextEnd = extension.end + deltaStart;
  } else {
    nextStart = patch.edge === 'end' ? extension.start : extension.start + deltaStart;
    nextEnd = patch.edge === 'start' ? extension.end : extension.end + deltaEnd;
  }
  const resolved = resolveExtensionFollowerRange(extension, nextStart, nextEnd, mode, getExtensionTrack(binding.track_id));
  patch.syncConflict = resolved.adjusted || resolved.conflict
    || resolved.squeezedCount > 0 || resolved.removedCount > 0;
  patch.syncSqueezedCount = (patch.syncSqueezedCount || 0) + (resolved.squeezedCount || 0);
  patch.syncRemovedCount = (patch.syncRemovedCount || 0) + (resolved.removedCount || 0);
  patch.syncUnboundCount = (patch.syncUnboundCount || 0) + (resolved.unboundCount || 0);
  return true;
}

function constrainBoundExtensionPanelEdit(extension, track, oldStart, oldEnd) {
  if (!extension || !track || !multiSubtitleVisible()) return false;
  const binding = MULTI_SUBTITLE_UTILS.bindingForSegment(
    getMultiSubtitleState(), extension.id, 'extension', track.id,
  );
  const main = binding ? mainSegmentById(binding.main_segment_ids?.[0]) : null;
  if (!main) return false;
  const desiredMainStart = main.start + (extension.start - oldStart);
  const desiredMainEnd = main.end + (extension.end - oldEnd);
  const constrained = constrainCueRangeToTrack(
    main,
    desiredMainStart,
    desiredMainEnd,
    DATA.segments,
  );
  const blocked = constrained.blocked
    || constrained.start !== desiredMainStart
    || constrained.end !== desiredMainEnd;
  const nextStart = oldStart + (constrained.start - main.start);
  const nextEnd = oldEnd + (constrained.end - main.end);
  extension.items = remapPanelItems(extension.items, oldStart, oldEnd, nextStart, nextEnd);
  extension.start = nextStart;
  extension.end = nextEnd;
  main.start = constrained.start;
  main.end = constrained.end;
  main._dirty = true;
  extension._dirty = true;
  return blocked;
}

normalizeMultiSubtitleState();
const EDITOR_SETTINGS_KEY = 'moy.asr.editor.settings.v1';
const CLICK_BEHAVIOR_VALUES = new Set(['select-only', 'select-and-seek', 'select-and-play']);
const CLICK_TARGET_VALUES = new Set(['cue-start', 'pointer']);
const JKL_PLAYBACK_MODE_VALUES = new Set(['speed', 'direction']);
const DEFAULT_JKL_PLAYBACK_MODE = 'direction';
const MEDIA_SEEK_STEP_MIN_MS = 10;
const MEDIA_SEEK_STEP_MAX_MS = 60000;
const MEDIA_SEEK_STEP_FINE_THRESHOLD_MS = 100;
const MEDIA_SEEK_STEP_FINE_MS = 10;
const MEDIA_SEEK_STEP_COARSE_MS = 100;
const DEFAULT_MEDIA_SEEK_STEP_MS = 1000;
const CUE_MOVE_STEP_MIN_MS = 10;
const CUE_MOVE_STEP_MAX_MS = 2000;
const DEFAULT_CUE_MOVE_STEP_MS = 50;
function normalizeClickBehavior(value) {
  return CLICK_BEHAVIOR_VALUES.has(value) ? value : 'select-and-seek';
}
function normalizeClickTarget(value) {
  return CLICK_TARGET_VALUES.has(value) ? value : 'pointer';
}
function normalizeKeyboardOperationReferenceMode(value) {
  return value === 'playhead' ? 'playhead' : 'pointer';
}
function normalizeJklPlaybackMode(value) {
  return JKL_PLAYBACK_MODE_VALUES.has(value) ? value : DEFAULT_JKL_PLAYBACK_MODE;
}

function clampMediaSeekStepMs(value) {
  const rounded = Math.round(Number(value));
  return Math.min(
    MEDIA_SEEK_STEP_MAX_MS,
    Math.max(
      MEDIA_SEEK_STEP_MIN_MS,
      Number.isFinite(rounded) ? rounded : DEFAULT_MEDIA_SEEK_STEP_MS,
    ),
  );
}

function mediaSeekStepForValue(value) {
  return clampMediaSeekStepMs(value) <= MEDIA_SEEK_STEP_FINE_THRESHOLD_MS
    ? MEDIA_SEEK_STEP_FINE_MS
    : MEDIA_SEEK_STEP_COARSE_MS;
}

function nextMediaSeekStepValue(value, direction) {
  const current = clampMediaSeekStepMs(value);
  if (!direction) return current;
  const sign = direction < 0 ? -1 : 1;
  const step = sign < 0
    ? (current <= MEDIA_SEEK_STEP_FINE_THRESHOLD_MS
      ? MEDIA_SEEK_STEP_FINE_MS : MEDIA_SEEK_STEP_COARSE_MS)
    : (current < MEDIA_SEEK_STEP_FINE_THRESHOLD_MS
      ? MEDIA_SEEK_STEP_FINE_MS : MEDIA_SEEK_STEP_COARSE_MS);
  return clampMediaSeekStepMs(current + sign * step);
}

// 原生 number 输入框以 min=10、step=100 计算大于 100 的向下步进时，
// 会把 200 算成 110。把这个浏览器步进结果还原为用户看到的 100ms 档位，
// 同时保留 100ms 向下 90ms、向上 200ms 的边界行为。
function normalizeNativeMediaSeekStepValue(value, previousValue) {
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric)) return null;
  const previous = clampMediaSeekStepMs(previousValue);
  const delta = numeric - previous;
  const step = mediaSeekStepForValue(previous);
  const nativeDownDelta = previous > MEDIA_SEEK_STEP_FINE_THRESHOLD_MS
    ? -(step - MEDIA_SEEK_STEP_MIN_MS)
    : -step;
  if (delta === step || delta === nativeDownDelta) {
    return nextMediaSeekStepValue(previous, delta < 0 ? -1 : 1);
  }
  return clampMediaSeekStepMs(numeric);
}

function clampCueMoveStepMs(value) {
  const rounded = Math.round(Number(value));
  return Math.min(
    CUE_MOVE_STEP_MAX_MS,
    Math.max(CUE_MOVE_STEP_MIN_MS, Number.isFinite(rounded) ? rounded : DEFAULT_CUE_MOVE_STEP_MS),
  );
}
const DEFAULT_EDITOR_SETTINGS = {
  splitKey: 'enter',
  splitUseWordTimestamps: true,
  // 拆分弹窗中选完所有需要确认的断点后自动提交。
  splitAutoSubmit: true,
  overlayEnabled: true,
  // 多重字幕开启时，拓展字幕预览默认自动显示。
  extensionOverlayEnabled: true,
  // 多重字幕开启时使用的波形行高度；关闭多重字幕后恢复「配置」中的高度。
  multiSubtitleRowHeight: DEFAULT_MULTI_SUBTITLE_ROW_HEIGHT,
  exportStartAtZero: false,
  cueListShowIndex: true,
  cueListShowTime: true,
  cueListShowSticker: true,
  cueListShowCharcount: true,
  // 字幕列表普通点击是否把目标字幕滚动到列表中央。
  cueListAutoScrollOnClick: true,
  // “仅看超长”开启时，拆分结果是否暂时保留在列表中，直到焦点离开。
  cueListKeepSplitVisible: true,
  // 字幕列表是否隐藏禁用字幕。
  cueListHideDisabled: false,
  // “仅看超长”与字数标记使用的字符阈值。
  cueListCharcountThreshold: 16,
  cueEditorShowNavigation: false,
  cueEditorShowTimeActions: false,
  cueEditorShowSticker: false,
  // 当前字幕编辑区按 Esc 时，是否放弃文本改动并恢复编辑前内容。
  cueEditorCancelOnEscape: false,
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
  // 表情包 OTIO：保留用户偏好的原始素材引用 / 便携文件夹模式。
  stickerOtioExportMode: 'original',
  // 字幕单击行为：默认选中并跳转；select-and-play 额外在暂停时开始播放。
  clickBehavior: 'select-and-seek',
  // 波形字幕块的跳转目标，默认使用鼠标所在位置；字幕列表点击始终跳转到字幕开头。
  clickTarget: 'pointer',
  keyboardOperationReference: 'pointer',
  // J/K/L 播放控制：direction 为倒放/停止/正放，speed 保留旧的慢速/重置/倍速行为。
  jklPlaybackMode: DEFAULT_JKL_PLAYBACK_MODE,
  // 媒体控制按钮与无选中字幕时左右方向键的跳转幅度。
  mediaSeekStepMs: DEFAULT_MEDIA_SEEK_STEP_MS,
  // 选中字幕后用方向键 / A-D 微调时间的幅度。
  cueMoveStepMs: DEFAULT_CUE_MOVE_STEP_MS,
  // 是否默认让同轨相邻字幕随边界调整一起联动；Alt 始终临时反转该行为。
  autoSnapAdjacentCues: true,
  // 娱乐彩蛋：成功拆分时的音效与刀光反馈，并把分割工具图标换成 🔪。
  ninjaMode: false,
  // 字幕忍者的拆分音效开关；忍者开关开启后才在设置中显示。
  ninjaSound: true,
  // 字幕忍者的可选视觉反馈；忍者开关开启后才在设置中显示。
  ninjaSlashEffect: true,
  // 刀光长度：视口高度百分比（默认 80，范围 20–400）。
  ninjaSlashLengthPercent: 80,
  // 刀光随机旋转幅度：0 度完全垂直，N 度表示在 [-N, N] 内随机倾斜（默认 6，范围 0–60）。
  ninjaSlashRotateAmplitude: 6,
  // 多重字幕拖动时是否把另一条轨道的起止边界加入吸附目标。
  crossTrackSnap: true,
  // 选中主/副字幕时，是否同时选中绑定的另一条字幕。
  selectBoundSubtitlePair: true,
  // G 绑定后是否自动把副字幕时间范围同步到主字幕（等同随后按 H）。
  multiSubtitleAutoSyncDuration: true,
  // 多重字幕波形是否显示主/副轨道编号徽标。
  multiSubtitleShowTrackBadges: false,
  // 界面主题：dark（默认）/ light。写入 <html data-theme>，模板 <head> 内联脚本负责首帧预应用。
  theme: 'dark',
  // 波形形状来源：self（默认，自研 1000Hz 重采样缓存）/ reapeaks（.ReaPeaks 最细 wave 层）。
  waveShapeSource: 'self',
};
const SUBTITLE_FONT_SIZE_MIN = 12;
const SUBTITLE_FONT_SIZE_MAX = 96;
const SUBTITLE_FONT_FAMILY_MAX_LENGTH = 128;
const SUBTITLE_BACKGROUND_COLOR_DEFAULT = '#000000';
const SUBTITLE_BACKGROUND_ALPHA_DEFAULT = 0.65;
const SUBTITLE_BACKGROUND_ALPHA_MIN = 0;
const SUBTITLE_BACKGROUND_ALPHA_MAX = 1;
const SUBTITLE_DEFAULT_FONT_SIZE = 18;
const EXTENSION_SUBTITLE_DEFAULT_FONT_SIZE = 16;
const DEFAULT_SUBTITLE_COLOR = '#ffffff';
const DEFAULT_EXTENSION_SUBTITLE_COLOR = '#ffd34d';
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
    const legacySeekStepSeconds = Number(saved.mediaSeekStepSeconds);
    const savedMediaSeekStepMs = saved.mediaSeekStepMs !== undefined
      ? saved.mediaSeekStepMs
      : Number.isFinite(legacySeekStepSeconds) ? legacySeekStepSeconds * 1000 : undefined;
    return {
      splitKey: saved.splitKey === 'ctrl-enter' ? 'ctrl-enter' : DEFAULT_EDITOR_SETTINGS.splitKey,
      splitUseWordTimestamps: saved.splitUseWordTimestamps !== false,
      splitAutoSubmit: saved.splitAutoSubmit !== false,
      overlayEnabled: saved.overlayEnabled !== false,
      extensionOverlayEnabled: saved.extensionOverlayEnabled !== false,
      multiSubtitleRowHeight: normalizeMultiSubtitleRowHeight(saved.multiSubtitleRowHeight),
      exportStartAtZero: saved.exportStartAtZero === true,
      cueListShowIndex: saved.cueListShowIndex !== false,
      cueListShowTime: saved.cueListShowTime !== false,
      cueListShowSticker: saved.cueListShowSticker !== false,
      cueListShowCharcount: saved.cueListShowCharcount !== false,
      cueListAutoScrollOnClick: saved.cueListAutoScrollOnClick !== false,
      cueListKeepSplitVisible: saved.cueListKeepSplitVisible !== false,
      cueListHideDisabled: saved.cueListHideDisabled === true,
      cueListCharcountThreshold: clampCharcountThreshold(saved.cueListCharcountThreshold),
      cueEditorShowNavigation: saved.cueEditorShowNavigation === true,
      cueEditorShowTimeActions: saved.cueEditorShowTimeActions === true,
      cueEditorShowSticker: saved.cueEditorShowSticker === true,
      cueEditorCancelOnEscape: saved.cueEditorCancelOnEscape === true,
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
      stickerOtioExportMode: saved.stickerOtioExportMode === 'portable' ? 'portable' : 'original',
      clickBehavior: normalizeClickBehavior(saved.clickBehavior),
      clickTarget: normalizeClickTarget(saved.clickTarget),
      keyboardOperationReference: normalizeKeyboardOperationReferenceMode(saved.keyboardOperationReference),
      jklPlaybackMode: normalizeJklPlaybackMode(saved.jklPlaybackMode),
      mediaSeekStepMs: clampMediaSeekStepMs(savedMediaSeekStepMs),
      cueMoveStepMs: clampCueMoveStepMs(saved.cueMoveStepMs),
      autoSnapAdjacentCues: saved.autoSnapAdjacentCues !== false,
      ninjaMode: saved.ninjaMode === true,
      ninjaSound: saved.ninjaSound !== false,
      ninjaSlashEffect: saved.ninjaSlashEffect !== false,
      ninjaSlashLengthPercent: clampNinjaSlashLength(saved.ninjaSlashLengthPercent),
      ninjaSlashRotateAmplitude: clampNinjaSlashRotateAmplitude(saved.ninjaSlashRotateAmplitude),
      crossTrackSnap: saved.crossTrackSnap !== false,
      selectBoundSubtitlePair: saved.selectBoundSubtitlePair !== false,
      multiSubtitleAutoSyncDuration: saved.multiSubtitleAutoSyncDuration !== false,
      multiSubtitleShowTrackBadges: saved.multiSubtitleShowTrackBadges === true,
      theme: saved.theme === 'light' ? 'light' : 'dark',
      waveShapeSource: saved.waveShapeSource === 'self' ? 'self' : 'reapeaks',
    };
  } catch (_) {
    return { ...DEFAULT_EDITOR_SETTINGS };
  }
}

function clampAutoSaveInterval(value) {
  const seconds = Math.round(Number(value));
  return Math.min(3600, Math.max(5, Number.isFinite(seconds) ? seconds : 30));
}

function clampCharcountThreshold(value) {
  const threshold = Math.round(Number(value));
  return Math.min(200, Math.max(1, Number.isFinite(threshold) ? threshold : 16));
}

function clampNinjaSlashLength(value) {
  const percent = Math.round(Number(value));
  return Math.min(400, Math.max(20, Number.isFinite(percent) ? percent : 80));
}

function clampNinjaSlashRotateAmplitude(value) {
  const degrees = Math.round(Number(value));
  return Math.min(60, Math.max(0, Number.isFinite(degrees) ? degrees : 6));
}

function clampAutoMergeGapMs(value) {
  const ms = Math.round(Number(value));  return Math.min(10000, Math.max(0, Number.isFinite(ms) ? ms : DEFAULT_EDITOR_SETTINGS.autoMergeGapMs));
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

let normalizedGapRemoveReference = null;
let normalizedGapRemoveCache = null;
let removedGapRangesCacheState = null;
let removedGapRangesCache = [];

function getGapRemoveData(create = false) {
  const source = DATA.gap_remove;
  if (!source && !create) {
    normalizedGapRemoveReference = null;
    normalizedGapRemoveCache = null;
    removedGapRangesCacheState = null;
    removedGapRangesCache = [];
    return null;
  }
  if (!source && create) return normalizedGapRemoveData(null);
  if (source !== normalizedGapRemoveReference) {
    normalizedGapRemoveReference = source;
    normalizedGapRemoveCache = normalizedGapRemoveData(source);
    removedGapRangesCacheState = null;
    removedGapRangesCache = [];
  }
  return normalizedGapRemoveCache;
}

function getGapRemoveGaps() {
  const state = getGapRemoveData(false);
  return state?.detector === 'audio_gate' ? state.gaps : [];
}

function getRemovedGapRanges() {
  const state = getGapRemoveData(false);
  if (!state) return [];
  if (removedGapRangesCacheState !== state) {
    removedGapRangesCacheState = state;
    removedGapRangesCache = window.AsrEditorUtils.getRemovedGapRanges(state.gaps);
  }
  return removedGapRangesCache;
}

const container = document.getElementById('cues-container');
let player = document.getElementById('player');  // 可被「加载媒体」替换为新 <video>/<audio>
let waveformEditor = null;
let playbackFrameId = 0;
let playbackFramePlayer = null;
let jklPlaybackRate = 1;
let jklReversePlaying = false;
let jklReverseFrameId = 0;
let jklReverseLastTimestamp = 0;
// 工程内波形是可直接使用的缓存；加载关联媒体时不要因为媒体签名不同而覆盖它。
// 媒体生成的波形则不属于工程缓存，切换媒体时仍应重新分析。
let waveformLoadedFromProject = false;
const MEDIA_FILE_RE = /\.(mp4|mkv|avi|mov|wmv|flv|webm|ts|m4v|wav|mp3|m4a|aac|ogg|flac|opus)$/i;
function isMediaFile(file) {
  return Boolean(file) && (file.type.startsWith('video/') || file.type.startsWith('audio/') || MEDIA_FILE_RE.test(file.name));
}
function isReapeaksFile(file) {
  return Boolean(file) && /\.reapeaks$/i.test(file.name);
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
  // _dirty 也保留，恢复后能再次导出"工程文件"时正确标记；多字幕数据与主轨
  // 必须处于同一条记录中，绑定/成对删除/联动拆分才能原子撤销。
  return JSON.parse(JSON.stringify({
    segments: DATA.segments,
    multi_subtitle: getMultiSubtitleState(),
  }));
}
function snapshotEditorSelection() {
  const extensionTrack = getActiveExtensionTrack();
  const panelTrack = currentCuePanelKind === 'extension'
    ? getExtensionTrack(currentCuePanelTrackId) : null;
  return {
    mainIds: [...selectedIdxs]
      .map((index) => DATA.segments[index]?.id)
      .filter(Boolean),
    extensionTrackId: extensionTrack?.id || null,
    extensionIds: extensionTrack
      ? [...selectedExtensionIdxs].map((index) => extensionTrack.segments[index]?.id).filter(Boolean)
      : [],
    panelKind: currentCuePanelKind,
    panelTrackId: panelTrack?.id || currentCuePanelTrackId || null,
    panelId: currentCuePanelKind === 'extension'
      ? panelTrack?.segments?.[currentCuePanelIdx]?.id || null
      : DATA.segments[currentCuePanelIdx]?.id || null,
    lastMainId: DATA.segments[lastClickedIdx]?.id || null,
    lastExtensionId: extensionTrack?.segments?.[lastClickedExtensionIdx]?.id || null,
  };
}
function pushUndo(label, { captureView = false } = {}) {
  const record = {
    kind: 'segments',
    label: label || '编辑',
    segs: snapshotSegments(),
    view: captureView ? snapshotEditorSelection() : null,
  };
  editorHistory.push(record);
  updateUndoRedoButtons();
  return record;
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
    extensionOverlay: !!extensionOverlayToggle?.checked,
    extensionSubtitle: { ...getStoredExtensionSubtitleAppearance() },
    sticker: { ...getStickerGeometry() },
  };
}
function applyPreviewState(state) {
  if (!state || typeof state.overlay !== 'boolean') return;
  overlayToggle.checked = state.overlay;
  updateEditorSettings({ overlayEnabled: state.overlay });
  if (typeof state.extensionOverlay === 'boolean' && extensionOverlayToggle) {
    extensionOverlayToggle.checked = state.extensionOverlay && multiSubtitleVisible();
    updateEditorSettings({ extensionOverlayEnabled: state.extensionOverlay });
  }
  if (state.subtitle) setPreviewGeometry(state.subtitle, { markDirty: true, replaceAppearance: true });
  if (state.extensionSubtitle) restoreExtensionSubtitleAppearance(state.extensionSubtitle, { markDirty: true });
  if (state.sticker) setStickerGeometry(state.sticker, { markDirty: true });
  refreshPreviewGeometryEditable();
  update();
}
// 按记录 kind 拍下当前状态，作为对端栈的镜像（label 沿用原记录）
function snapshotCurrentForKind(kind, label, sourceRecord = null) {
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
  const snapshot = { kind: 'segments', label: label || '编辑', segs: snapshotSegments() };
  if (sourceRecord?.view) snapshot.view = snapshotEditorSelection();
  return snapshot;
}
function restoreEditorSelection(snapshot) {
  if (!snapshot) return;
  selectedIdxs.clear();
  selectedExtensionIdxs.clear();
  const mainIds = new Set(snapshot.mainIds || []);
  DATA.segments.forEach((segment, index) => {
    if (mainIds.has(segment?.id)) selectedIdxs.add(index);
  });
  const extensionTrack = getExtensionTrack(snapshot.extensionTrackId) || getActiveExtensionTrack();
  const extensionIds = new Set(snapshot.extensionIds || []);
  if (extensionTrack) {
    extensionTrack.segments.forEach((segment, index) => {
      if (extensionIds.has(segment?.id)) selectedExtensionIdxs.add(index);
    });
  }
  lastClickedIdx = snapshot.lastMainId
    ? DATA.segments.findIndex((segment) => segment?.id === snapshot.lastMainId) : -1;
  lastClickedExtensionIdx = extensionTrack && snapshot.lastExtensionId
    ? extensionTrack.segments.findIndex((segment) => segment?.id === snapshot.lastExtensionId) : -1;
  const panelTrack = snapshot.panelTrackId ? getExtensionTrack(snapshot.panelTrackId) : null;
  if (snapshot.panelKind === 'extension' && panelTrack && snapshot.panelId) {
    currentCuePanelKind = 'extension';
    currentCuePanelTrackId = panelTrack.id;
    currentCuePanelIdx = panelTrack.segments.findIndex((segment) => segment?.id === snapshot.panelId);
    if (currentCuePanelIdx < 0) {
      currentCuePanelKind = 'main';
      currentCuePanelTrackId = null;
    }
  } else if (snapshot.panelKind === 'main' && snapshot.panelId) {
    currentCuePanelKind = 'main';
    currentCuePanelTrackId = null;
    currentCuePanelIdx = DATA.segments.findIndex((segment) => segment?.id === snapshot.panelId);
  }
  if (currentCuePanelIdx < 0) {
    currentCuePanelKind = 'main';
    currentCuePanelTrackId = null;
  }
  selCountEl.textContent = String(selectedIdxs.size + selectedExtensionIdxs.size);
  selectedIdxs.forEach((index) => {
    container.querySelector(`.cue[data-idx="${index}"]`)?.classList.add('selected');
  });
  updateMultiSelectionClasses();
  waveformEditor?.updateSelection();
  renderCurrentCuePanel();
}
function applyHistoryRecord(record) {
  if (record.kind === 'layout') {
    if (!waveformEditor?.restoreLayoutHistorySnapshot?.(record.layout)) {
      flashHint('工作区恢复失败：波形模块尚未加载', 'warning');
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
  const snapshot = record.segs && Array.isArray(record.segs.segments)
    ? record.segs : { segments: record.segs, multi_subtitle: DATA.multi_subtitle };
  const previousWaveformStructure = multiSubtitleWaveformStructureKey();
  DATA.segments.length = 0;
  (snapshot.segments || []).forEach(s => DATA.segments.push(s));
  DATA.multi_subtitle = snapshot.multi_subtitle || {
    schema: 'moy.asr.multi_subtitle.v1', enabled: false, display_mode: 'both', tracks: [], bindings: [],
  };
  normalizeMultiSubtitleState();
  // 历史恢复会改变下标身份；丢弃旧面板绑定，避免 clearSelection() 把旧面板
  // 内容提交到恢复后占据同一下标的另一条字幕，并因此生成新历史、清空 redo。
  currentCuePanelIdx = -1;
  currentCuePanelKind = 'main';
  currentCuePanelTrackId = null;
  resetCuePanelEditState();
  clearSelection();
  lastActive = -1;
  const structureChanged = previousWaveformStructure
    !== multiSubtitleWaveformStructureKey();
  renderAll({
    waveform: structureChanged ? 'full' : 'overlay',
  });
  if (record.view) restoreEditorSelection(record.view);
  return true;
}
function performUndo() {
  const top = editorHistory.peekUndo();
  if (!top) { flashHint('没有可撤销的操作', 'invalid'); return; }
  if (top.kind === 'layout' && typeof waveformEditor?.restoreLayoutHistorySnapshot !== 'function') {
    flashHint('工作区撤销失败：波形模块尚未加载', 'warning');
    return;
  }
  if (editingState) finishEdit(false);  // 撤销前丢弃当前编辑（保持快照前后一致）
  const current = snapshotCurrentForKind(top.kind, top.label, top);
  const record = editorHistory.popUndo(current);
  if (!record) return;
  applyHistoryRecord(record);
  flashHint(`已撤销：${record.label}（剩 ${editorHistory.undoLength()} 步）`, 'success');
  updateUndoRedoButtons();
}
function performRedo() {
  const top = editorHistory.peekRedo();
  if (!top) { flashHint('没有可重做的操作', 'invalid'); return; }
  if (top.kind === 'layout' && typeof waveformEditor?.restoreLayoutHistorySnapshot !== 'function') {
    flashHint('工作区重做失败：波形模块尚未加载', 'warning');
    return;
  }
  if (editingState) finishEdit(false);
  const current = snapshotCurrentForKind(top.kind, top.label, top);
  const record = editorHistory.popRedo(current);
  if (!record) return;
  applyHistoryRecord(record);
  flashHint(`已重做：${record.label}（剩 ${editorHistory.redoLength()} 步）`, 'success');
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
const overlayTextEl = document.getElementById('overlay-main-text');
const overlayExtensionTextEl = document.getElementById('overlay-extension-text');
const overlayToggle = document.getElementById('overlay-toggle');
const extensionOverlayToggleWrap = document.getElementById('extension-overlay-toggle-wrap');
const extensionOverlayToggle = document.getElementById('extension-overlay-toggle');
const stickerOverlayToggle = document.getElementById('sticker-overlay-toggle');
const subtitleFontSizeSelect = document.getElementById('subtitle-font-size');
const subtitleFontFamilySelect = document.getElementById('subtitle-font-family');
const subtitleFontFamilyScanButton = document.getElementById('subtitle-font-family-scan');
const subtitleFontFamilyStatus = document.getElementById('subtitle-font-family-status');
const subtitleBackgroundColorInput = document.getElementById('subtitle-background-color');
const subtitleBackgroundAlphaInput = document.getElementById('subtitle-background-alpha');
const subtitleBackgroundAlphaValue = document.getElementById('subtitle-background-alpha-value');
const subtitleColorInput = document.getElementById('subtitle-color');
const extensionSubtitlePreviewSettings = document.getElementById('extension-subtitle-preview-settings');
const extensionSubtitleFontSizeSelect = document.getElementById('extension-subtitle-font-size');
const extensionSubtitleFontFamilySelect = document.getElementById('extension-subtitle-font-family');
const extensionSubtitleColorInput = document.getElementById('extension-subtitle-color');
const extensionSubtitleBackgroundColorInput = document.getElementById('extension-subtitle-background-color');
const extensionSubtitleBackgroundAlphaInput = document.getElementById('extension-subtitle-background-alpha');
const extensionSubtitleBackgroundAlphaValue = document.getElementById('extension-subtitle-background-alpha-value');
const playerEmpty = document.getElementById('player-empty');
const playerWrap = document.querySelector('.player-wrap');
const mediaPlayToggle = document.getElementById('media-play-toggle');
const mediaStepBack = document.getElementById('media-step-back');
const mediaStepForward = document.getElementById('media-step-forward');
const mediaSeekStepInput = document.getElementById('media-seek-step');
let mediaSeekInputLastValue = EDITOR_SETTINGS.mediaSeekStepMs;
const mediaCurrentTime = document.getElementById('media-current-time');
const mediaDuration = document.getElementById('media-duration');
const mediaSeek = document.getElementById('media-seek');
const mediaVolume = document.getElementById('media-volume');
const mediaPlaybackRate = document.getElementById('media-playback-rate');
const mediaFullscreen = document.getElementById('media-fullscreen');
// 预览层（字幕/表情包）的定位与几何测量都以 stage 为基准，不含顶部媒体工具栏。
const playerStage = playerWrap?.querySelector('.player-stage') || playerWrap;
const splitKeySel = document.getElementById('split-key');
const splitUseWordTimestampsToggle = document.getElementById('split-use-word-timestamps');
const mergeJoinTextInput = document.getElementById('merge-join-text');
const cueListShowIndexToggle = document.getElementById('cue-list-show-index');
const cueListShowTimeToggle = document.getElementById('cue-list-show-time');
const cueListShowStickerToggle = document.getElementById('cue-list-show-sticker');
const cueListShowCharcountToggle = document.getElementById('cue-list-show-charcount');
const cueListAutoScrollOnClickToggle = document.getElementById('cue-list-auto-scroll-on-click');
const cueListKeepSplitVisibleToggle = document.getElementById('cue-list-keep-split-visible');
const cueListCharcountThresholdInput = document.getElementById('charcount-threshold');
const cueListSettings = document.getElementById('cue-list-settings');
const cueListSettingsToggle = document.getElementById('cue-list-settings-toggle');
const cueListSettingsPanel = document.getElementById('cue-list-settings-panel');
const hideDisabledToggle = document.getElementById('hide-disabled-toggle');
let hideDisabled = false;  // 「隐藏禁用项」开关状态
const cueEditorShowNavigationToggle = document.getElementById('cue-editor-show-navigation');
const cueEditorShowTimeActionsToggle = document.getElementById('cue-editor-show-time-actions');
const cueEditorShowStickerToggle = document.getElementById('cue-editor-show-sticker');
const cueEditorCancelOnEscapeToggle = document.getElementById('cue-editor-cancel-on-escape');
const selectGroupMembersToggle = document.getElementById('select-group-members');
const ninjaModeToggle = document.getElementById('ninja-mode');
const ninjaSoundToggle = document.getElementById('ninja-sound');
const ninjaSoundField = document.getElementById('ninja-sound-field');
const ninjaSlashEffectToggle = document.getElementById('ninja-slash-effect');
const ninjaSlashEffectField = document.getElementById('ninja-slash-effect-field');
const ninjaSlashParamsField = document.getElementById('ninja-slash-params-field');
const ninjaSlashLengthInput = document.getElementById('ninja-slash-length');
const ninjaSlashRotateInput = document.getElementById('ninja-slash-rotate');
const razorToolButton = document.querySelector('[data-waveform-tool="razor"]');
const razorToolSvg = razorToolButton?.querySelector('svg');
const ninjaRazorIcon = razorToolButton?.querySelector('.ninja-razor-icon');
const ninjaSlashFlash = document.getElementById('ninja-slash-flash');
const exportColorUnifiedToggle = document.getElementById('export-color-unified');
const helpToggle = document.getElementById('help-toggle');
const themeToggle = document.getElementById('theme-toggle');
const helpPanel = document.getElementById('help-panel');
const helpDragHandle = document.getElementById('help-drag-handle');
const helpCloseButton = document.getElementById('help-close');
const helpSplitKey = document.getElementById('help-split-key');
const cueEditorSplitKey = document.getElementById('cue-editor-split-key');
const cueEditorConfirmKey = document.getElementById('cue-editor-confirm-key');
const helpTabButtons = Array.from(document.querySelectorAll('[data-help-tab]'));
const helpTabPanels = Array.from(document.querySelectorAll('[data-help-tab-panel]'));
const helpMediaSeekStep = document.getElementById('help-media-seek-step');

const clickBehaviorSelect = document.getElementById('click-behavior');
const clickTargetField = document.getElementById('click-target-field');
const clickTargetSelect = document.getElementById('click-target');
const keyboardOperationReferenceSelect = document.getElementById('keyboard-operation-reference');
const keyboardOperationReferenceHint = document.getElementById('keyboard-operation-reference-hint');
const jklPlaybackModeSelect = document.getElementById('jkl-playback-mode');
const jklPlaybackModeHint = document.getElementById('jkl-playback-mode-hint');
const helpJklMode = document.getElementById('help-jkl-mode');
const cueMoveStepInput = document.getElementById('cue-move-step');
const autoSnapAdjacentCuesToggle = document.getElementById('auto-snap-adjacent-cues');
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
const cuePanelTarget = document.getElementById('cue-panel-target');
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
const downloadMultiSrtButton = document.getElementById('download-multi-srt');
const subtitleExportDropdown = document.getElementById('subtitle-export-dropdown');
const multiSubtitleControls = document.getElementById('multi-subtitle-controls');
const multiSubtitleToggleLabel = document.getElementById('multi-subtitle-toggle-label');
const multiSubtitleSettingsDropdown = document.getElementById('multi-subtitle-settings-dropdown');
const multiSubtitleSwapButton = document.getElementById('multi-subtitle-swap');
const multiSubtitleCrossTrackSnapToggle = document.getElementById('multi-subtitle-cross-track-snap');
const multiSubtitleSelectBoundPairToggle = document.getElementById('multi-subtitle-select-bound-pair');
const multiSubtitleAutoSyncDurationToggle = document.getElementById('multi-subtitle-auto-sync-duration');
const multiSubtitleShowTrackBadgesToggle = document.getElementById('multi-subtitle-show-track-badges');
const multiSubtitleWaveformControls = document.getElementById('multi-subtitle-waveform-controls');
const multiSubtitleToggle = document.getElementById('multi-subtitle-toggle');
const multiSubtitleDisplayMode = document.getElementById('multi-subtitle-display-mode');
const multiSubtitleMainLanguageMode = document.getElementById('multi-subtitle-main-language-mode');
const multiSubtitleExtensionLanguageMode = document.getElementById('multi-subtitle-extension-language-mode');
const multiSubtitleExtensionRowHeightSetting = document.getElementById('multi-subtitle-extension-row-height-setting');
const multiSubtitleExtensionRowHeight = document.getElementById('multi-subtitle-extension-row-height');
const multiSubtitleAlignButton = document.getElementById('multi-subtitle-align');
const multiSubtitleImportModal = document.getElementById('multi-subtitle-import-modal');
const multiSubtitleImportDescription = document.getElementById('multi-subtitle-import-description');
const multiSubtitleImportPreview = document.getElementById('multi-subtitle-import-preview');
const multiSubtitleImportChoiceActions = document.getElementById('multi-subtitle-import-choice-actions');
const multiSubtitleImportResultActions = document.getElementById('multi-subtitle-import-result-actions');
const multiSubtitleImportReplace = document.getElementById('multi-subtitle-import-replace');
const multiSubtitleImportExtension = document.getElementById('multi-subtitle-import-extension');
const multiSubtitleImportResultCancel = document.getElementById('multi-subtitle-import-result-cancel');
const multiSubtitleImportResultConfirm = document.getElementById('multi-subtitle-import-result-confirm');
const multiSubtitleSplitModal = document.getElementById('multi-subtitle-split-modal');
const multiSubtitleSplitTitle = document.getElementById('multi-subtitle-split-title');
const multiSubtitleSplitMeta = document.getElementById('multi-subtitle-split-meta');
const multiSubtitleSplitMainLane = document.getElementById('multi-subtitle-split-main-lane');
const multiSubtitleSplitMainText = document.getElementById('multi-subtitle-split-main-text');
const multiSubtitleSplitExtensionLane = document.getElementById('multi-subtitle-split-extension-lane');
const multiSubtitleSplitText = document.getElementById('multi-subtitle-split-text');
const multiSubtitleSplitTimestampHint = document.getElementById('multi-subtitle-split-timestamp-hint');
const multiSubtitleSplitPreview = document.getElementById('multi-subtitle-split-preview');
const multiSubtitleSplitError = document.getElementById('multi-subtitle-split-error');
const multiSubtitleSplitCancel = document.getElementById('multi-subtitle-split-cancel');
const multiSubtitleSplitConfirm = document.getElementById('multi-subtitle-split-confirm');
const multiSubtitleSplitAutoSubmit = document.getElementById('multi-subtitle-split-auto-submit');
const editorSettingsToggle = document.getElementById('editor-settings-toggle');
const editorSettingsPanel = document.getElementById('editor-settings-panel');
const subtitlePreviewSettings = document.getElementById('subtitle-preview-settings');
const subtitlePreviewSettingsToggle = document.getElementById('subtitle-preview-settings-toggle');
const subtitlePreviewSettingsPanel = document.getElementById('subtitle-preview-settings-panel');
const cueEditorSettings = document.getElementById('cue-editor-settings');
const cueEditorSettingsToggle = document.getElementById('cue-editor-settings-toggle');
const cueEditorSettingsPanel = document.getElementById('cue-editor-settings-panel');
const waveformSettings = document.getElementById('waveform-settings');
const waveformSettingsToggle = document.getElementById('waveform-settings-toggle');
const waveformSettingsPanel = document.getElementById('waveform-settings-panel');
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
const SUBTITLE_EXTEND_PANEL_POSITION_KEY = 'moy.asr.subtitle_extend.panel.v1';
const subtitleExtendPanel = document.getElementById('subtitle-extend-panel');
const subtitleExtendDragHandle = document.getElementById('subtitle-extend-drag-handle');
const subtitleExtendCloseButton = document.getElementById('subtitle-extend-close');
const subtitleExtendManageButton = document.getElementById('subtitle-extend-manage');
const subtitleExtendRunButton = document.getElementById('subtitle-extend-run');
const subtitleExtendForwardInput = document.getElementById('subtitle-extend-forward-ms');
const subtitleExtendBackwardInput = document.getElementById('subtitle-extend-backward-ms');
let gapPreviewRange = null;
let gapRemovePanelDrag = null;
let currentCuePanelIdx = -1;
let currentCuePanelKind = 'main';
let currentCuePanelTrackId = null;
let cuePanelUndoPushed = false;
let cuePanelUndoRecord = null;
let cuePanelTextEditSnapshot = null;
let cuePanelCanceling = false;
let editorSettingsPanelFrame = 0;

function resetCuePanelEditState() {
  cuePanelUndoPushed = false;
  cuePanelUndoRecord = null;
  cuePanelTextEditSnapshot = null;
}

function updateEditorSettings(patch) {
  Object.assign(EDITOR_SETTINGS, patch);
  saveEditorSettings(EDITOR_SETTINGS);
}

const NINJA_SFX_VARIANTS = Object.freeze([
  'sfx_katana_slash_01.opus',
  'sfx_katana_slash_02.opus',
  'sfx_katana_slash_03.opus',
  'sfx_katana_slash_04.opus',
]);
const NINJA_SFX_PLAYERS = new Map();
const NINJA_SFX_HISTORY = [];
let ninjaSlashFlashTimer = 0;

function ninjaSfxUrl(fileName) {
  const baseUrl = NINJA_SFX_BASE_URL || SERVER_CONFIG?.ninjaSfxBaseUrl || 'web/sfx/';
  try {
    return new URL(`${baseUrl}${encodeURIComponent(fileName)}`, document.baseURI).href;
  } catch (_) {
    return `${baseUrl}${encodeURIComponent(fileName)}`;
  }
}

function ninjaSfxType(fileName) {
  return fileName.endsWith('.opus') ? 'audio/ogg; codecs=opus' : 'audio/ogg';
}

function createNinjaSfxPlayer(fileName) {
  if (typeof Audio !== 'function') return null;
  const player = new Audio();
  player.preload = 'auto';
  player.volume = 0.65;
  const source = document.createElement('source');
  source.src = ninjaSfxUrl(fileName);
  source.type = ninjaSfxType(fileName);
  player.appendChild(source);
  return player;
}

function playNinjaSplitSound() {
  if (!EDITOR_SETTINGS.ninjaMode || typeof Audio !== 'function') return;
  const recent = new Set(NINJA_SFX_HISTORY.slice(-2));
  const available = NINJA_SFX_VARIANTS.map((_, index) => index)
    .filter((index) => !recent.has(index));
  const candidates = available.length ? available : NINJA_SFX_VARIANTS.map((_, index) => index);
  const variantIndex = candidates[Math.floor(Math.random() * candidates.length)];
  NINJA_SFX_HISTORY.push(variantIndex);
  if (NINJA_SFX_HISTORY.length > 2) NINJA_SFX_HISTORY.shift();
  let player = NINJA_SFX_PLAYERS.get(variantIndex);
  if (!player) {
    player = createNinjaSfxPlayer(NINJA_SFX_VARIANTS[variantIndex]);
    if (!player) return;
    NINJA_SFX_PLAYERS.set(variantIndex, player);
  }
  try {
    player.currentTime = 0;
  } catch (_) {
    // 尚未完成解码时 currentTime 可能暂时不可写；播放本身仍可继续尝试。
  }
  const playback = player.play();
  if (playback && typeof playback.catch === 'function') playback.catch(() => {});
}

function ninjaSplitPointFromRect(rect) {
  if (!rect) return null;
  const clientX = Number(rect.left) + Number(rect.width || 0) / 2;
  const clientY = Number(rect.top) + Number(rect.height || 0) / 2;
  return Number.isFinite(clientX) && Number.isFinite(clientY) ? { clientX, clientY } : null;
}

function ninjaSplitPointFromRange(range, root, offset = 0, textLength = 1) {
  if (range) {
    try {
      const collapsed = range.cloneRange();
      collapsed.collapse(true);
      const rect = collapsed.getBoundingClientRect();
      if (rect && (rect.width || rect.height)) return ninjaSplitPointFromRect(rect);
      const rects = collapsed.getClientRects();
      if (rects.length) return ninjaSplitPointFromRect(rects[0]);
    } catch (_) {
      // 被重绘或脱离 DOM 的 Range 不能再读取几何信息，继续使用元素回退值。
    }
  }
  const rootRect = root?.getBoundingClientRect?.();
  if (!rootRect) return null;
  const safeLength = Math.max(1, Number(textLength) || 1);
  const ratio = Math.max(0, Math.min(1, (Number(offset) || 0) / safeLength));
  return {
    clientX: rootRect.left + rootRect.width * ratio,
    clientY: rootRect.top + rootRect.height / 2,
  };
}

function ninjaModalSplitPoint(state, finalCutMs, track = 'main') {
  // 字幕列表/编辑区唤起的拆分弹窗：刀光保留在列表原位置（cue 内拆分位置）。
  if (state?.ninjaFromList && state?.feedbackPoint) return state.feedbackPoint;
  // 波形等其余来源唤起的弹窗：刀光优先落在波形区最终切点上；
  // force 钳制后 finalCutMs 才是实际位置，找不到波形行时回退打开时的反馈点。
  if (Number.isFinite(finalCutMs)) {
    const point = waveformEditor?.getSplitPointAtTime?.(finalCutMs, track);
    if (point) return point;
  }
  return state?.feedbackPoint || null;
}

function triggerNinjaSplitFeedback(splitPoint = null) {
  if (!EDITOR_SETTINGS.ninjaMode) return;
  if (EDITOR_SETTINGS.ninjaSound !== false) playNinjaSplitSound();
  if (!EDITOR_SETTINGS.ninjaSlashEffect || !ninjaSlashFlash) return;
  // 旋转幅度 0 度 = 完全垂直；N 度 = 在 [-N, N] 内均匀随机，正负决定倾斜方向。
  const rotateAmplitude = Math.max(0, Math.min(60, Math.round(Number(EDITOR_SETTINGS.ninjaSlashRotateAmplitude) || 0)));
  const slashAngle = rotateAmplitude * (Math.random() * 2 - 1);
  const slashLengthPercent = Math.max(20, Math.min(400, Math.round(Number(EDITOR_SETTINGS.ninjaSlashLengthPercent) || 80)));
  // 每次触发都随机化刀光时长，避免连续拆分看起来一模一样。
  const slashDur = 160 + Math.random() * 70; // 刀光持续时长 [160, 230] ms
  const slashLinger = 100 + Math.random() * 70; // 刀光淡出余韵 [100, 170] ms
  const viewportWidth = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
  const viewportHeight = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
  const point = ninjaSplitPointFromRect({
    left: Number(splitPoint?.clientX),
    top: Number(splitPoint?.clientY),
  }) || { clientX: viewportWidth / 2, clientY: viewportHeight / 2 };
  const slashStyle = ninjaSlashFlash.style;
  slashStyle.setProperty('--slash-angle', `${slashAngle}deg`);
  slashStyle.setProperty('--slash-height', `${slashLengthPercent}%`);
  slashStyle.setProperty('--slash-dur', `${slashDur}ms`);
  slashStyle.setProperty('--slash-linger', `${slashLinger}ms`);
  slashStyle.setProperty('--slash-x', `${Math.max(0, Math.min(100, point.clientX / viewportWidth * 100))}%`);
  slashStyle.setProperty('--slash-y', `${Math.max(0, Math.min(100, point.clientY / viewportHeight * 100))}%`);
  ninjaSlashFlash.classList.remove('show');
  // 强制重排，让连续快速拆分也能重新播放 CSS 动画。
  void ninjaSlashFlash.offsetWidth;
  ninjaSlashFlash.classList.add('show');
  clearTimeout(ninjaSlashFlashTimer);
  // 清理时间必须覆盖刃光扫过与切痕滞留，否则动画放到一半 .show 就被摘掉。
  ninjaSlashFlashTimer = setTimeout(
    () => ninjaSlashFlash.classList.remove('show'),
    slashDur + slashLinger + 120,
  );
}

function applyNinjaSettings() {
  const enabled = EDITOR_SETTINGS.ninjaMode === true;
  const slashEnabled = enabled && EDITOR_SETTINGS.ninjaSlashEffect !== false;
  if (ninjaModeToggle) ninjaModeToggle.checked = enabled;
  if (ninjaSoundToggle) ninjaSoundToggle.checked = EDITOR_SETTINGS.ninjaSound !== false;
  if (ninjaSlashEffectToggle) ninjaSlashEffectToggle.checked = EDITOR_SETTINGS.ninjaSlashEffect !== false;
  if (ninjaSoundField) ninjaSoundField.hidden = !enabled;
  if (ninjaSlashEffectField) ninjaSlashEffectField.hidden = !enabled;
  if (ninjaSlashParamsField) ninjaSlashParamsField.hidden = !slashEnabled;
  if (ninjaSlashLengthInput) ninjaSlashLengthInput.value = String(EDITOR_SETTINGS.ninjaSlashLengthPercent);
  if (ninjaSlashRotateInput) ninjaSlashRotateInput.value = String(EDITOR_SETTINGS.ninjaSlashRotateAmplitude);
  // SVGElement 不一定实现 HTMLElement.hidden；用属性切换才能真正隐藏原剪刀图标。
  if (razorToolSvg) {
    if (enabled) razorToolSvg.setAttribute('hidden', '');
    else razorToolSvg.removeAttribute('hidden');
  }
  if (ninjaRazorIcon) ninjaRazorIcon.hidden = !enabled;
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

function positionAnchoredSettingsPanel(panel, toggle) {
  if (!panel || panel.hidden || !toggle) return;
  const buttonRect = toggle.getBoundingClientRect();
  const panelWidth = panel.offsetWidth;
  const panelHeight = panel.offsetHeight;
  const margin = 8;
  const left = Math.min(
    Math.max(margin, buttonRect.right - panelWidth),
    Math.max(margin, window.innerWidth - panelWidth - margin),
  );
  const belowTop = buttonRect.bottom + 6;
  const aboveTop = buttonRect.top - panelHeight - 6;
  let top = belowTop;
  if (belowTop + panelHeight > window.innerHeight - margin && aboveTop >= margin) {
    top = aboveTop;
  } else if (belowTop + panelHeight > window.innerHeight - margin) {
    top = Math.max(margin, window.innerHeight - panelHeight - margin);
  }
  panel.style.left = String(left) + 'px';
  panel.style.top = String(top) + 'px';
}

function setSettingsPanelOwnerOpen(panel, open) {
  const owner = panel?.closest('.player-wrap, .current-cue-panel, .cues-container, .waveform-pane');
  owner?.classList.toggle('settings-panel-owner-open', open);
}

function positionSubtitlePreviewSettingsPanel() {
  positionAnchoredSettingsPanel(subtitlePreviewSettingsPanel, subtitlePreviewSettingsToggle);
}

function setSubtitlePreviewSettingsPanelOpen(open) {
  if (!subtitlePreviewSettingsPanel || !subtitlePreviewSettingsToggle) return;
  subtitlePreviewSettingsPanel.hidden = !open;
  setSettingsPanelOwnerOpen(subtitlePreviewSettingsPanel, open);
  subtitlePreviewSettingsToggle.classList.toggle('active', open);
  subtitlePreviewSettingsToggle.setAttribute('aria-expanded', String(open));
  if (open) positionSubtitlePreviewSettingsPanel();
}

function positionCueListSettingsPanel() {
  positionAnchoredSettingsPanel(cueListSettingsPanel, cueListSettingsToggle);
}

function setCueListSettingsPanelOpen(open) {
  if (!cueListSettingsPanel || !cueListSettingsToggle) return;
  cueListSettingsPanel.hidden = !open;
  setSettingsPanelOwnerOpen(cueListSettingsPanel, open);
  cueListSettingsToggle.classList.toggle('active', open);
  cueListSettingsToggle.setAttribute('aria-expanded', String(open));
  if (open) positionCueListSettingsPanel();
}

function positionCueEditorSettingsPanel() {
  positionAnchoredSettingsPanel(cueEditorSettingsPanel, cueEditorSettingsToggle);
}

function setCueEditorSettingsPanelOpen(open) {
  if (!cueEditorSettingsPanel || !cueEditorSettingsToggle) return;
  cueEditorSettingsPanel.hidden = !open;
  setSettingsPanelOwnerOpen(cueEditorSettingsPanel, open);
  cueEditorSettingsToggle.classList.toggle('active', open);
  cueEditorSettingsToggle.setAttribute('aria-expanded', String(open));
  if (open) positionCueEditorSettingsPanel();
}

function positionWaveformSettingsPanel() {
  positionAnchoredSettingsPanel(waveformSettingsPanel, waveformSettingsToggle);
}

function setWaveformSettingsPanelOpen(open) {
  if (!waveformSettingsPanel || !waveformSettingsToggle) return;
  waveformSettingsPanel.hidden = !open;
  setSettingsPanelOwnerOpen(waveformSettingsPanel, open);
  waveformSettingsToggle.classList.toggle('active', open);
  waveformSettingsToggle.setAttribute('aria-expanded', String(open));
  if (open) positionWaveformSettingsPanel();
}

function applyCueListDisplaySettings() {
  cueListShowIndexToggle.checked = EDITOR_SETTINGS.cueListShowIndex;
  cueListShowTimeToggle.checked = EDITOR_SETTINGS.cueListShowTime;
  cueListShowStickerToggle.checked = EDITOR_SETTINGS.cueListShowSticker;
  cueListShowCharcountToggle.checked = EDITOR_SETTINGS.cueListShowCharcount;
  cueListAutoScrollOnClickToggle.checked = EDITOR_SETTINGS.cueListAutoScrollOnClick;
  cueListKeepSplitVisibleToggle.checked = EDITOR_SETTINGS.cueListKeepSplitVisible;
  cueListCharcountThresholdInput.value = String(EDITOR_SETTINGS.cueListCharcountThreshold);
  hideDisabled = EDITOR_SETTINGS.cueListHideDisabled;
  hideDisabledToggle.checked = hideDisabled;
  container.classList.toggle('hide-disabled', hideDisabled);
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

let previousMultiSubtitlePreviewEnabled = false;
let waveformRowHeightBeforeMultiSubtitle = null;

function syncMultiSubtitleWaveformRowHeight(enabled, enteringEnabled, leavingEnabled) {
  if (!waveformEditor?.getRowHeight || !waveformEditor?.setRowHeight) return;
  if (enteringEnabled) {
    waveformRowHeightBeforeMultiSubtitle = waveformEditor.getRowHeight();
    waveformEditor.setRowHeight(EDITOR_SETTINGS.multiSubtitleRowHeight);
  } else if (leavingEnabled && Number.isFinite(waveformRowHeightBeforeMultiSubtitle)) {
    const previous = waveformRowHeightBeforeMultiSubtitle;
    waveformRowHeightBeforeMultiSubtitle = null;
    waveformEditor.setRowHeight(previous);
  } else if (!enabled) {
    waveformRowHeightBeforeMultiSubtitle = null;
  }
}

function updateMultiSubtitleUi() {
  const track = getActiveExtensionTrack();
  const hasTrack = Boolean(track && Array.isArray(track.segments));
  const enabled = hasTrack && getMultiSubtitleState().enabled === true;
  const hasMainSubtitle = DATA.segments.length > 0;
  const enteringEnabled = enabled && !previousMultiSubtitlePreviewEnabled;
  const leavingEnabled = !enabled && previousMultiSubtitlePreviewEnabled;
  syncMultiSubtitleWaveformRowHeight(enabled, enteringEnabled, leavingEnabled);
  if (multiSubtitleControls) multiSubtitleControls.hidden = !hasMainSubtitle;
  if (multiSubtitleSettingsDropdown) {
    multiSubtitleSettingsDropdown.hidden = !enabled;
    if (!enabled) {
      multiSubtitleSettingsDropdown.classList.remove('open');
      multiSubtitleSettingsDropdown.querySelector('button[aria-expanded]')
        ?.setAttribute('aria-expanded', 'false');
    }
  }
  if (multiSubtitleToggle) {
    multiSubtitleToggle.checked = enabled;
    // 没有扩展轨时仍允许点击，由 change 处理器询问是否选择导入第二条字幕。
    multiSubtitleToggle.disabled = false;
  }
  if (multiSubtitleToggleLabel) {
    multiSubtitleToggleLabel.classList.remove('disabled');
    multiSubtitleToggleLabel.title = MULTI_SUBTITLE_TOGGLE_TITLE;
  }
  if (multiSubtitleToggle) multiSubtitleToggle.title = MULTI_SUBTITLE_TOGGLE_TITLE;
  if (multiSubtitleDisplayMode) {
    multiSubtitleDisplayMode.value = getMultiSubtitleState().display_mode || 'both';
    multiSubtitleDisplayMode.hidden = !enabled;
  }
  if (multiSubtitleMainLanguageMode) {
    multiSubtitleMainLanguageMode.value = getMainSubtitleSplitMode(DATA.segments[0]);
    multiSubtitleMainLanguageMode.hidden = !enabled;
  }
  if (multiSubtitleExtensionLanguageMode) {
    multiSubtitleExtensionLanguageMode.value = getExtensionSubtitleSplitMode(track, track?.segments?.[0]);
    multiSubtitleExtensionLanguageMode.hidden = !enabled;
  }
  if (multiSubtitleExtensionRowHeight) {
    multiSubtitleExtensionRowHeight.value = String(EDITOR_SETTINGS.multiSubtitleRowHeight);
    multiSubtitleExtensionRowHeight.disabled = !enabled;
  }
  if (multiSubtitleExtensionRowHeightSetting) {
    multiSubtitleExtensionRowHeightSetting.hidden = !enabled;
  }
  if (multiSubtitleCrossTrackSnapToggle) {
    multiSubtitleCrossTrackSnapToggle.checked = EDITOR_SETTINGS.crossTrackSnap;
    multiSubtitleCrossTrackSnapToggle.disabled = !enabled;
  }
  if (multiSubtitleSelectBoundPairToggle) {
    multiSubtitleSelectBoundPairToggle.checked = EDITOR_SETTINGS.selectBoundSubtitlePair;
    multiSubtitleSelectBoundPairToggle.disabled = !enabled;
  }
  if (multiSubtitleAutoSyncDurationToggle) {
    multiSubtitleAutoSyncDurationToggle.checked = EDITOR_SETTINGS.multiSubtitleAutoSyncDuration;
    multiSubtitleAutoSyncDurationToggle.disabled = !enabled;
  }
  if (multiSubtitleShowTrackBadgesToggle) {
    multiSubtitleShowTrackBadgesToggle.checked = EDITOR_SETTINGS.multiSubtitleShowTrackBadges;
    multiSubtitleShowTrackBadgesToggle.disabled = !enabled;
  }
  if (multiSubtitleSwapButton) {
    const canSwap = enabled && (getMultiSubtitleState().tracks || []).length === 1
      && DATA.segments.length > 0 && (track?.segments || []).length > 0;
    multiSubtitleSwapButton.classList.toggle('disabled', !canSwap);
    multiSubtitleSwapButton.setAttribute('aria-disabled', canSwap ? 'false' : 'true');
  }
  if (multiSubtitleWaveformControls) multiSubtitleWaveformControls.hidden = !enabled;
  if (multiSubtitleAlignButton) multiSubtitleAlignButton.hidden = !enabled;
  if (extensionOverlayToggleWrap) extensionOverlayToggleWrap.hidden = !enabled;
  if (extensionSubtitlePreviewSettings) extensionSubtitlePreviewSettings.hidden = !enabled;
  if (extensionOverlayToggle) {
    if (enteringEnabled) updateEditorSettings({ extensionOverlayEnabled: true });
    extensionOverlayToggle.checked = enabled
      ? (enteringEnabled || EDITOR_SETTINGS.extensionOverlayEnabled)
      : false;
  }
  previousMultiSubtitlePreviewEnabled = enabled;
  container.classList.toggle('multi-subtitle-enabled', enabled);
  container.dataset.multiDisplayMode = enabled ? (getMultiSubtitleState().display_mode || 'both') : 'main';
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

function confirmKeyLabel() {
  return splitKeySel.value === 'enter' ? `${modKeyLabel()}+Enter` : 'Enter';
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
  if (cueEditorSplitKey) cueEditorSplitKey.textContent = label;
  if (cueEditorConfirmKey) cueEditorConfirmKey.textContent = confirmKeyLabel();
}

// 切换语言时 i18n 会重置动态文本节点，需重新套用当前拆分按键提示和目标轨道标签。
document.addEventListener('mawe:languagechange', () => {
  refreshSplitKeyHelp();
  renderCurrentCuePanel();
  refreshMediaSeekStepHelp();
  refreshMediaSeekControlLabels();
});

splitKeySel.value = EDITOR_SETTINGS.splitKey;
if (splitUseWordTimestampsToggle) splitUseWordTimestampsToggle.checked = EDITOR_SETTINGS.splitUseWordTimestamps;
if (multiSubtitleSplitAutoSubmit) multiSubtitleSplitAutoSubmit.checked = EDITOR_SETTINGS.splitAutoSubmit;
applyPlatformKeyLabels();
refreshSplitKeyHelp();
if (mergeJoinTextInput) mergeJoinTextInput.value = EDITOR_SETTINGS.mergeJoinText;
syncAutoMergePanelInputs();
overlayToggle.checked = EDITOR_SETTINGS.overlayEnabled;
if (extensionOverlayToggle) extensionOverlayToggle.checked = false;
exportStartAtZeroToggle.checked = EDITOR_SETTINGS.exportStartAtZero;
if (selectGroupMembersToggle) selectGroupMembersToggle.checked = EDITOR_SETTINGS.selectGroupMembers;
if (exportColorUnifiedToggle) exportColorUnifiedToggle.checked = EDITOR_SETTINGS.exportColorUnified;
if (autoSaveProjectToggle) autoSaveProjectToggle.checked = EDITOR_SETTINGS.autoSaveProject;
if (autoSaveIntervalInput) autoSaveIntervalInput.value = String(EDITOR_SETTINGS.autoSaveIntervalSeconds);
if (stickerOverlayToggle) stickerOverlayToggle.checked = EDITOR_SETTINGS.stickerOverlayEnabled;
if (clickBehaviorSelect) clickBehaviorSelect.value = EDITOR_SETTINGS.clickBehavior;
if (clickTargetSelect) clickTargetSelect.value = EDITOR_SETTINGS.clickTarget;
if (keyboardOperationReferenceSelect) {
  keyboardOperationReferenceSelect.value = EDITOR_SETTINGS.keyboardOperationReference;
}
if (jklPlaybackModeSelect) jklPlaybackModeSelect.value = EDITOR_SETTINGS.jklPlaybackMode;
if (mediaSeekStepInput) mediaSeekStepInput.value = String(EDITOR_SETTINGS.mediaSeekStepMs);
if (cueMoveStepInput) cueMoveStepInput.value = String(EDITOR_SETTINGS.cueMoveStepMs);
if (autoSnapAdjacentCuesToggle) {
  autoSnapAdjacentCuesToggle.checked = EDITOR_SETTINGS.autoSnapAdjacentCues;
}
if (cueEditorCancelOnEscapeToggle) {
  cueEditorCancelOnEscapeToggle.checked = EDITOR_SETTINGS.cueEditorCancelOnEscape;
}
refreshMediaSeekStepHelp();
refreshMediaSeekInputStep();
refreshMediaSeekControlLabels();
applyNinjaSettings();
const waveformShapeSourceSelect = document.getElementById('waveform-shape-source');
if (waveformShapeSourceSelect) {
  waveformShapeSourceSelect.value = EDITOR_SETTINGS.waveShapeSource;
  waveformShapeSourceSelect.addEventListener('change', () => {
    EDITOR_SETTINGS.waveShapeSource = waveformShapeSourceSelect.value === 'reapeaks' ? 'reapeaks' : 'self';
    saveEditorSettings(EDITOR_SETTINGS);
    if (waveformEditor) waveformEditor.render();
  });
}
applyCueListDisplaySettings();
applyCueEditorDisplaySettings();
multiSubtitleToggle?.addEventListener('change', () => {
  const multi = getMultiSubtitleState();
  const next = multiSubtitleToggle.checked;
  if (next && !getActiveExtensionTrack()) {
    // 先恢复未选中状态，避免用户取消确认或取消文件选择后留下假开启状态。
    multiSubtitleToggle.checked = false;
    if (!confirm(MULTI_SUBTITLE_IMPORT_PROMPT)) return;
    pendingSrtImportAsExtension = true;
    loadSrtFileInput.value = '';
    loadSrtFileInput.click();
    return;
  }
  multi.enabled = !next;
  pushUndo(next ? '开启多重字幕' : '关闭多重字幕');
  multi.enabled = next;
  multi._dirty = true;
  // 开关会改变波形是否需要拓展 lane，因此这里才执行完整波形重建。
  renderAll({ waveform: 'full' });
});
multiSubtitleDisplayMode?.addEventListener('change', () => {
  const multi = getMultiSubtitleState();
  const next = multiSubtitleDisplayMode.value;
  const previous = multi.display_mode;
  multi.display_mode = previous;
  pushUndo('切换多重字幕列表');
  multi.display_mode = MULTI_SUBTITLE_UTILS.MULTI_SUBTITLE_DISPLAY_MODES.has(next) ? next : 'both';
  multi._dirty = true;
  renderAll({ waveform: 'none' });
});
multiSubtitleMainLanguageMode?.addEventListener('change', () => {
  const multi = getMultiSubtitleState();
  const next = isConfiguredSubtitleSplitMode(multiSubtitleMainLanguageMode.value)
    ? multiSubtitleMainLanguageMode.value : 'word';
  if (multi.main_split_mode === next) return;
  pushUndo('切换主字幕语言类型');
  multi.main_split_mode = next;
  markMultiSubtitleDirty();
  renderAll({ waveform: 'none' });
});
multiSubtitleExtensionLanguageMode?.addEventListener('change', () => {
  const track = getActiveExtensionTrack();
  if (!track) return;
  const next = isConfiguredSubtitleSplitMode(multiSubtitleExtensionLanguageMode.value)
    ? multiSubtitleExtensionLanguageMode.value : 'word';
  if (track.split_mode === next) return;
  pushUndo('切换副字幕语言类型');
  track.split_mode = next;
  markMultiSubtitleDirty();
  renderAll({ waveform: 'none' });
});
multiSubtitleExtensionRowHeight?.addEventListener('change', () => {
  const next = normalizeMultiSubtitleRowHeight(multiSubtitleExtensionRowHeight.value);
  updateEditorSettings({ multiSubtitleRowHeight: next });
  if (multiSubtitleVisible()) waveformEditor?.setRowHeight(next);
});
multiSubtitleCrossTrackSnapToggle?.addEventListener('change', () => {
  updateEditorSettings({ crossTrackSnap: multiSubtitleCrossTrackSnapToggle.checked });
});
multiSubtitleSelectBoundPairToggle?.addEventListener('change', () => {
  updateEditorSettings({ selectBoundSubtitlePair: multiSubtitleSelectBoundPairToggle.checked });
});
multiSubtitleAutoSyncDurationToggle?.addEventListener('change', () => {
  updateEditorSettings({ multiSubtitleAutoSyncDuration: multiSubtitleAutoSyncDurationToggle.checked });
});
multiSubtitleShowTrackBadgesToggle?.addEventListener('change', () => {
  updateEditorSettings({ multiSubtitleShowTrackBadges: multiSubtitleShowTrackBadgesToggle.checked });
  waveformEditor?.render?.();
});
multiSubtitleSwapButton?.addEventListener('click', () => {
  swapMainAndExtensionSubtitles();
});
multiSubtitleAlignButton?.addEventListener('click', () => {
  alignSelectedExtensionSubtitleRanges();
});
applySubtitleAppearance();
applyExtensionSubtitleAppearance();
editorSettingsToggle?.addEventListener('click', () => setEditorSettingsPanelOpen(editorSettingsPanel?.hidden));
subtitlePreviewSettingsToggle?.addEventListener('click', (event) => {
  event.stopPropagation();
  setSubtitlePreviewSettingsPanelOpen(subtitlePreviewSettingsPanel?.hidden);
});
cueListSettingsToggle?.addEventListener('click', (event) => {
  event.stopPropagation();
  setCueListSettingsPanelOpen(cueListSettingsPanel?.hidden);
});
waveformSettingsToggle?.addEventListener('click', (event) => {
  event.stopPropagation();
  setWaveformSettingsPanelOpen(waveformSettingsPanel?.hidden);
});
cueEditorSettingsToggle?.addEventListener('click', (event) => {
  event.stopPropagation();
  setCueEditorSettingsPanelOpen(cueEditorSettingsPanel?.hidden);
});
document.addEventListener('pointerdown', (event) => {
  if (temporaryVisibleSplitCueKeys.size) {
    const targetCue = event.target instanceof Element ? event.target.closest('.cue') : null;
    if (!cueElementHasTemporarySplitVisibility(targetCue)) {
      clearTemporaryVisibleSplitCues();
      applySearch(searchEl.value);
    }
  }
  if (!subtitlePreviewSettingsPanel?.hidden && !subtitlePreviewSettings?.contains(event.target)) {
    setSubtitlePreviewSettingsPanelOpen(false);
  }
  if (!cueListSettingsPanel?.hidden && !cueListSettings?.contains(event.target)) {
    setCueListSettingsPanelOpen(false);
  }
  if (!waveformSettingsPanel?.hidden && !waveformSettings?.contains(event.target)) {
    setWaveformSettingsPanelOpen(false);
  }
  if (!cueEditorSettingsPanel?.hidden && !cueEditorSettings?.contains(event.target)) {
    setCueEditorSettingsPanelOpen(false);
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!subtitlePreviewSettingsPanel?.hidden) {
    setSubtitlePreviewSettingsPanelOpen(false);
    subtitlePreviewSettingsToggle?.focus();
  }
  if (!cueListSettingsPanel?.hidden) {
    setCueListSettingsPanelOpen(false);
    cueListSettingsToggle?.focus();
  }
  if (!waveformSettingsPanel?.hidden) {
    setWaveformSettingsPanelOpen(false);
    waveformSettingsToggle?.focus();
  }
  if (!cueEditorSettingsPanel?.hidden) {
    setCueEditorSettingsPanelOpen(false);
    cueEditorSettingsToggle?.focus();
  }
});
window.addEventListener('resize', positionSubtitlePreviewSettingsPanel);
window.addEventListener('scroll', positionSubtitlePreviewSettingsPanel, true);
window.addEventListener('resize', positionCueListSettingsPanel);
window.addEventListener('scroll', positionCueListSettingsPanel, true);
window.addEventListener('resize', positionWaveformSettingsPanel);
window.addEventListener('scroll', positionWaveformSettingsPanel, true);
window.addEventListener('resize', positionCueEditorSettingsPanel);
window.addEventListener('scroll', positionCueEditorSettingsPanel, true);
subtitlePreviewSettings?.closest('.player-toolbar')?.addEventListener(
  'scroll', positionSubtitlePreviewSettingsPanel,
);
cueListSettings?.closest('.cue-list-toolbar')?.addEventListener(
  'scroll', positionCueListSettingsPanel,
);
waveformSettings?.closest('.waveform-toolbar')?.addEventListener(
  'scroll', positionWaveformSettingsPanel,
);
cueEditorSettings?.closest('.cue-editor-toolbar')?.addEventListener(
  'scroll', positionCueEditorSettingsPanel,
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
// 帮助是非模态浮窗；鼠标点击后的按钮焦点由统一的快捷键焦点处理释放。
helpCloseButton?.addEventListener('click', () => helpFloatingPanel.close());
function selectHelpTab(tabName, { focus = false } = {}) {
  const activeButton = helpTabButtons.find((button) => button.dataset.helpTab === tabName);
  if (!activeButton) return;
  helpTabButtons.forEach((button) => {
    const active = button === activeButton;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  });
  helpTabPanels.forEach((panel) => {
    const active = panel.dataset.helpTabPanel === tabName;
    panel.hidden = !active;
    panel.setAttribute('aria-hidden', String(!active));
  });
  if (focus) activeButton.focus();
}

helpTabButtons.forEach((button) => {
  button.addEventListener('click', () => selectHelpTab(button.dataset.helpTab));
  button.addEventListener('keydown', (event) => {
    const index = helpTabButtons.indexOf(button);
    if (index < 0) return;
    let nextIndex = index;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (index + 1) % helpTabButtons.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (index - 1 + helpTabButtons.length) % helpTabButtons.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = helpTabButtons.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    selectHelpTab(helpTabButtons[nextIndex].dataset.helpTab, { focus: true });
  });
});
if (helpTabButtons.length && helpTabPanels.length) {
  selectHelpTab(helpTabButtons.find((button) => button.getAttribute('aria-selected') === 'true')?.dataset.helpTab || helpTabButtons[0].dataset.helpTab);
}
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
splitUseWordTimestampsToggle?.addEventListener('change', () => {
  updateEditorSettings({ splitUseWordTimestamps: splitUseWordTimestampsToggle.checked });
});
multiSubtitleSplitAutoSubmit?.addEventListener('change', () => {
  updateEditorSettings({ splitAutoSubmit: multiSubtitleSplitAutoSubmit.checked });
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
const subtitleExtendFloatingPanel = createFloatingPanel({
  panel: subtitleExtendPanel,
  dragHandle: subtitleExtendDragHandle,
  manageButton: subtitleExtendManageButton,
  anchorButton: subtitleExtendManageButton,
  positionKey: SUBTITLE_EXTEND_PANEL_POSITION_KEY,
});
subtitleExtendCloseButton?.addEventListener('click', () => subtitleExtendFloatingPanel.close());
subtitleExtendRunButton?.addEventListener('click', extendSubtitleRanges);
subtitleExtendPanel?.querySelectorAll('input[type="number"]').forEach((input) => {
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
  }, { passive: false });
});
bindCueListDisplayToggle(cueListShowIndexToggle, 'cueListShowIndex');
bindCueListDisplayToggle(cueListShowTimeToggle, 'cueListShowTime');
bindCueListDisplayToggle(cueListShowStickerToggle, 'cueListShowSticker');
bindCueListDisplayToggle(cueListShowCharcountToggle, 'cueListShowCharcount');
bindCueListDisplayToggle(cueListAutoScrollOnClickToggle, 'cueListAutoScrollOnClick');
cueListKeepSplitVisibleToggle?.addEventListener('change', () => {
  updateEditorSettings({ cueListKeepSplitVisible: cueListKeepSplitVisibleToggle.checked });
  if (!cueListKeepSplitVisibleToggle.checked) clearTemporaryVisibleSplitCues();
  applySearch(searchEl.value);
});
cueListCharcountThresholdInput?.addEventListener('input', () => {
  const value = Number(cueListCharcountThresholdInput.value);
  if (Number.isFinite(value) && value >= 1 && value <= 200) {
    updateEditorSettings({ cueListCharcountThreshold: clampCharcountThreshold(value) });
  }
  refreshAllCharCounts();
  if (document.getElementById('filter-over').classList.contains('active')) {
    applySearch(searchEl.value);
  }
});
cueListCharcountThresholdInput?.addEventListener('change', () => {
  cueListCharcountThresholdInput.value = String(getCharCountThreshold());
});
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
keyboardOperationReferenceSelect?.addEventListener('change', () => {
  const mode = normalizeKeyboardOperationReferenceMode(keyboardOperationReferenceSelect.value);
  updateEditorSettings({ keyboardOperationReference: mode });
  refreshKeyboardOperationReferenceHint();
});
jklPlaybackModeSelect?.addEventListener('change', () => {
  const wasReversePlaying = jklReversePlaying;
  updateEditorSettings({ jklPlaybackMode: normalizeJklPlaybackMode(jklPlaybackModeSelect.value) });
  stopJklReversePlayback({ render: false });
  jklPlaybackRate = 1;
  player.playbackRate = 1;
  if (wasReversePlaying) update();
  syncMediaControls();
  refreshJklPlaybackModeUi();
});
function refreshMediaSeekInputStep(value = EDITOR_SETTINGS.mediaSeekStepMs) {
  if (mediaSeekStepInput) mediaSeekStepInput.step = String(mediaSeekStepForValue(value));
}

function commitMediaSeekStepInput(value, { rewriteInput = true } = {}) {
  const normalized = clampMediaSeekStepMs(value);
  if (rewriteInput && mediaSeekStepInput) mediaSeekStepInput.value = String(normalized);
  mediaSeekInputLastValue = normalized;
  updateEditorSettings({ mediaSeekStepMs: normalized });
  refreshMediaSeekInputStep(normalized);
  refreshMediaSeekStepHelp();
  refreshMediaSeekControlLabels();
}

function adjustMediaSeekStepInput(direction) {
  if (!mediaSeekStepInput) return;
  const current = clampMediaSeekStepMs(mediaSeekStepInput.value);
  commitMediaSeekStepInput(nextMediaSeekStepValue(current, direction));
}

mediaSeekStepInput?.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  event.preventDefault();
  event.stopPropagation();
  adjustMediaSeekStepInput(event.key === 'ArrowUp' ? 1 : -1);
});
mediaSeekStepInput?.addEventListener('wheel', (event) => {
  if (!event.deltaY) return;
  event.preventDefault();
  event.stopPropagation();
  mediaSeekStepInput.focus({ preventScroll: true });
  adjustMediaSeekStepInput(event.deltaY < 0 ? 1 : -1);
}, { passive: false });
mediaSeekStepInput?.addEventListener('input', () => {
  const raw = mediaSeekStepInput.value.trim();
  if (!raw) return;
  const value = normalizeNativeMediaSeekStepValue(raw, mediaSeekInputLastValue);
  if (value === null) return;
  commitMediaSeekStepInput(value, { rewriteInput: value !== Number(raw) });
});
mediaSeekStepInput?.addEventListener('change', () => {
  commitMediaSeekStepInput(mediaSeekStepInput.value);
});
cueMoveStepInput?.addEventListener('change', () => {
  const value = clampCueMoveStepMs(cueMoveStepInput.value);
  cueMoveStepInput.value = String(value);
  updateEditorSettings({ cueMoveStepMs: value });
});
autoSnapAdjacentCuesToggle?.addEventListener('change', () => {
  updateEditorSettings({ autoSnapAdjacentCues: autoSnapAdjacentCuesToggle.checked });
});
cueEditorCancelOnEscapeToggle?.addEventListener('change', () => {
  updateEditorSettings({ cueEditorCancelOnEscape: cueEditorCancelOnEscapeToggle.checked });
});
ninjaModeToggle?.addEventListener('change', () => {
  updateEditorSettings({ ninjaMode: ninjaModeToggle.checked });
  applyNinjaSettings();
});
ninjaSoundToggle?.addEventListener('change', () => {
  updateEditorSettings({ ninjaSound: ninjaSoundToggle.checked });
});
ninjaSlashEffectToggle?.addEventListener('change', () => {
  updateEditorSettings({ ninjaSlashEffect: ninjaSlashEffectToggle.checked });
  applyNinjaSettings();
});
ninjaSlashLengthInput?.addEventListener('change', () => {
  updateEditorSettings({ ninjaSlashLengthPercent: clampNinjaSlashLength(ninjaSlashLengthInput.value) });
  ninjaSlashLengthInput.value = String(EDITOR_SETTINGS.ninjaSlashLengthPercent);
});
ninjaSlashRotateInput?.addEventListener('change', () => {
  updateEditorSettings({ ninjaSlashRotateAmplitude: clampNinjaSlashRotateAmplitude(ninjaSlashRotateInput.value) });
  ninjaSlashRotateInput.value = String(EDITOR_SETTINGS.ninjaSlashRotateAmplitude);
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
let subtitleBackgroundColorUndoPushed = false;
function applySubtitleBackgroundColorInput({ finalize = false } = {}) {
  if (!subtitleBackgroundColorInput) return;
  if (!subtitleBackgroundColorUndoPushed) {
    pushPreviewUndo('调整字幕背景色', snapshotPreviewState());
    subtitleBackgroundColorUndoPushed = true;
  }
  setSubtitleAppearance({ background_color: subtitleBackgroundColorInput.value });
  if (finalize) subtitleBackgroundColorUndoPushed = false;
}
subtitleBackgroundColorInput?.addEventListener('input', () => applySubtitleBackgroundColorInput());
subtitleBackgroundColorInput?.addEventListener('change', () => applySubtitleBackgroundColorInput({ finalize: true }));
let subtitleBackgroundAlphaUndoPushed = false;
function applySubtitleBackgroundAlphaInput({ finalize = false } = {}) {
  if (!subtitleBackgroundAlphaInput) return;
  if (!subtitleBackgroundAlphaUndoPushed) {
    pushPreviewUndo('调整字幕背景不透明度', snapshotPreviewState());
    subtitleBackgroundAlphaUndoPushed = true;
  }
  const alpha = Number(subtitleBackgroundAlphaInput.value);
  if (subtitleBackgroundAlphaValue && Number.isFinite(alpha)) {
    subtitleBackgroundAlphaValue.textContent = `${Math.round(alpha * 100)}%`;
  }
  setSubtitleAppearance({ background_alpha: alpha });
  if (finalize) subtitleBackgroundAlphaUndoPushed = false;
}
subtitleBackgroundAlphaInput?.addEventListener('input', () => applySubtitleBackgroundAlphaInput());
subtitleBackgroundAlphaInput?.addEventListener('change', () => applySubtitleBackgroundAlphaInput({ finalize: true }));
subtitleFontFamilyScanButton?.addEventListener('click', () => {
  void scanSubtitleLocalFonts();
});
document.addEventListener('mawe:languagechange', () => {
  renderSubtitleFontFamilyStatus();
  relabelSubtitleFontFamilyOptions();
});
subtitleColorInput?.addEventListener('change', () => {
  pushPreviewUndo('调整主字幕颜色', snapshotPreviewState());
  setSubtitleAppearance({ color: subtitleColorInput.value });
  update();
});
extensionSubtitleFontSizeSelect?.addEventListener('change', () => {
  pushPreviewUndo('调整副字幕字号', snapshotPreviewState());
  const value = extensionSubtitleFontSizeSelect.value;
  setExtensionSubtitleAppearance({ font_size: value === 'auto' ? null : Number(value) });
  update();
});
extensionSubtitleFontFamilySelect?.addEventListener('change', () => {
  pushPreviewUndo('调整副字幕字体', snapshotPreviewState());
  setExtensionSubtitleAppearance({ font_family: extensionSubtitleFontFamilySelect.value });
  update();
});
extensionSubtitleColorInput?.addEventListener('change', () => {
  pushPreviewUndo('调整副字幕颜色', snapshotPreviewState());
  setExtensionSubtitleAppearance({ color: extensionSubtitleColorInput.value });
  update();
});
extensionSubtitleBackgroundColorInput?.addEventListener('change', () => {
  pushPreviewUndo('调整副字幕背景色', snapshotPreviewState());
  setExtensionSubtitleAppearance({ background_color: extensionSubtitleBackgroundColorInput.value });
  update();
});
let extensionSubtitleBackgroundAlphaUndoPushed = false;
function applyExtensionSubtitleBackgroundAlphaInput({ finalize = false } = {}) {
  if (!extensionSubtitleBackgroundAlphaInput) return;
  if (!extensionSubtitleBackgroundAlphaUndoPushed) {
    pushPreviewUndo('调整副字幕背景不透明度', snapshotPreviewState());
    extensionSubtitleBackgroundAlphaUndoPushed = true;
  }
  const alpha = Number(extensionSubtitleBackgroundAlphaInput.value);
  if (extensionSubtitleBackgroundAlphaValue && Number.isFinite(alpha)) {
    extensionSubtitleBackgroundAlphaValue.textContent = `${Math.round(alpha * 100)}%`;
  }
  setExtensionSubtitleAppearance({ background_alpha: alpha });
  if (finalize) extensionSubtitleBackgroundAlphaUndoPushed = false;
}
extensionSubtitleBackgroundAlphaInput?.addEventListener('input', () => applyExtensionSubtitleBackgroundAlphaInput());
extensionSubtitleBackgroundAlphaInput?.addEventListener('change', () => applyExtensionSubtitleBackgroundAlphaInput({ finalize: true }));
extensionOverlayToggle?.addEventListener('change', () => {
  const previous = snapshotPreviewState();
  previous.extensionOverlay = !extensionOverlayToggle.checked;
  pushPreviewUndo('切换副字幕预览', previous);
  updateEditorSettings({ extensionOverlayEnabled: extensionOverlayToggle.checked });
  refreshPreviewGeometryEditable();
  update();
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

const KEYBOARD_OPERATION_REFERENCE_HINTS = {
  zh: {
    pointer: 'B/Z/X/N 使用鼠标所在波形位置；波形外不执行时间操作。',
    playhead: 'B/Z/X/N 使用当前播放头位置；无当前字幕目标时使用主轨。',
  },
  en: {
    pointer: 'B/Z/X/N use the mouse position in the waveform; outside it, timing actions do nothing.',
    playhead: 'B/Z/X/N use the current playhead; when no cue target is active, they use the main track.',
  },
};
function refreshKeyboardOperationReferenceHint() {
  const language = window.MAWE_I18N?.language === 'en' ? 'en' : 'zh';
  const mode = normalizeKeyboardOperationReferenceMode(EDITOR_SETTINGS.keyboardOperationReference);
  if (keyboardOperationReferenceSelect) keyboardOperationReferenceSelect.value = mode;
  if (keyboardOperationReferenceHint) {
    keyboardOperationReferenceHint.textContent = KEYBOARD_OPERATION_REFERENCE_HINTS[language][mode];
  }
}
refreshKeyboardOperationReferenceHint();
document.addEventListener('mawe:languagechange', refreshKeyboardOperationReferenceHint);

const JKL_MODE_UI_TEXT = {
  zh: {
    speed: { help: '倍速 ×0.5/重置/×2', hint: 'J 慢放，K 重置 1×，L 加速。' },
    direction: { help: '倒放/停止/1×播放', hint: 'J 倒放，K 停止（重置播放速度），K 播放。多次按 J/K 可以倍增速度。' },
  },
  en: {
    speed: { help: 'Speed ×0.5/reset/×2', hint: 'J slows down, K resets to 1×, and L speeds up.' },
    direction: { help: 'Reverse/stop/1× play', hint: 'J reverses; K stops (resetting playback speed), and K plays. Press J/K repeatedly to multiply the speed.' },
  },
};
function refreshJklPlaybackModeUi() {
  const language = window.MAWE_I18N?.language === 'en' ? 'en' : 'zh';
  const mode = normalizeJklPlaybackMode(EDITOR_SETTINGS.jklPlaybackMode);
  const text = JKL_MODE_UI_TEXT[language][mode];
  if (jklPlaybackModeSelect) jklPlaybackModeSelect.value = mode;
  if (jklPlaybackModeHint) jklPlaybackModeHint.textContent = text.hint;
  if (helpJklMode) helpJklMode.textContent = text.help;
}
refreshJklPlaybackModeUi();
document.addEventListener('mawe:languagechange', refreshJklPlaybackModeUi);

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
    flashHint('波形数据尚不可用，无法按音量判断空隙；请先加载媒体。', 'invalid');
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
  flashHint(
    gaps.length
      ? `已移除 ${gaps.length} 段音量空隙，共 ${formatGapRemoveTotal(gapRemoveTotalMs(gaps))}`
      : '没有达到门限的音量空隙',
    gaps.length ? 'success' : 'invalid',
  );
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
  flashHint(removed ? '已人工移除静音空隙' : '已人工恢复静音空隙', 'success');
}

function clearGap(index) {
  const state = getGapRemoveData(false);
  const gap = state?.gaps?.[index];
  if (!gap) return;
  pushGapRemoveUndo('清理空隙区段');
  state.gaps = state.gaps.filter((_, gapIndex) => gapIndex !== index);
  state.manual_corrections = state.gaps.length > 0;
  setGapRemoveData(state);
  flashHint('已清理空隙区段', 'success');
}

function applyManualGapRange(startMs, endMs, removed) {
  const state = getGapRemoveData(true);
  const sourceGaps = state.detector === 'audio_gate' ? state.gaps : [];
  const nextGaps = window.AsrEditorUtils.applyGapRemoveRange(sourceGaps, startMs, endMs, removed);
  if (JSON.stringify(nextGaps) === JSON.stringify(sourceGaps)) {
    flashHint(removed ? '所选范围已经处于移除状态' : '所选范围内没有已移除的静音空隙', 'invalid');
    return;
  }
  pushGapRemoveUndo(removed ? '人工移除范围' : '人工恢复范围');
  state.detector = 'audio_gate';
  state.gaps = nextGaps;
  state.manual_corrections = true;
  setGapRemoveData(state);
  flashHint(removed ? '已人工移除所选范围' : '已人工恢复所选范围', 'success');
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
  flashHint('已人工调整空隙边界', 'success');
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
  flashHint('已清理全部空隙区段', 'success');
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
let stickerAssetRevision = 0;

//   1) sticker.rel + STICKER_ROOT  - 拼出服务器或 file:// URL
//   2) sticker.path  - 兼容老版工程
function stickerUrl(sticker) {
  if (!sticker) return '';
  if (sticker.rel) {
    if (STICKER_URL_PREFIX) {
      const url = `${STICKER_URL_PREFIX.replace(/\/$/, '')}/${sticker.rel.split('/').map(encodeURIComponent).join('/')}`;
      return stickerAssetRevision ? `${url}?root=${stickerAssetRevision}` : url;
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
function stickerAbsPath(sticker) {
  if (!sticker) return '';
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
const selectedExtensionIdxs = new Set();
let lastClickedIdx = -1;  // 用于 Shift+click 范围选
let lastClickedExtensionIdx = -1;
// “仅看超长”开启时，刚拆出的字幕临时绕过字数过滤；使用稳定 ID，避免 splice 后下标错位。
const temporaryVisibleSplitCueKeys = new Set();
// 右键选择「绑定到主字幕」后的等待状态。使用稳定 ID 而不是数组下标，
// 这样等待期间即使列表重绘，也不会把另一条扩展字幕误绑定过去。
let pendingExtensionBinding = null;
// 隐藏开关开启时，禁用项视为"不可选"（Shift 范围选 / Ctrl 切换都跳过）
function isHiddenDisabled(idx, track = 'main') {
  const segments = track === 'extension'
    ? (getActiveExtensionTrack()?.segments || [])
    : (track?.segments || DATA.segments);
  return hideDisabled && !!(segments[idx] && segments[idx].disabled);
}

function cancelPendingExtensionBinding(message = '已取消绑定扩展字幕') {
  if (!pendingExtensionBinding) return false;
  pendingExtensionBinding = null;
  flashHint(message);
  return true;
}

function clearSelection({ silent = false, commitCuePanel = true } = {}) {
  hideCueSplitPreview();
  cancelPendingExtensionBinding();
  selectedIdxs.forEach(i => {
    const el = container.querySelector(`.cue[data-idx="${i}"]`);
    if (el) el.classList.remove('selected');
  });
  selectedIdxs.clear();
  selectedExtensionIdxs.forEach((index) => {
    container.querySelectorAll(`.multi-cue[data-ext-idx="${index}"], .multi-dual-cue[data-ext-idx="${index}"]`)
      .forEach((el) => el.classList.remove('selected'));
  });
  selectedExtensionIdxs.clear();
  selCountEl.textContent = '0';
  if (silent) {
    // 结构编辑会马上 renderAll() 并重新选中目标；此时不必先刷新旧波形
    // 覆盖层和空面板，避免同一次操作产生两轮视觉更新。
    currentCuePanelIdx = -1;
    resetCuePanelEditState();
    return;
  }
  if (waveformEditor) waveformEditor.updateSelection();
  if (commitCuePanel) {
    setCurrentCuePanelIndex(-1);
  } else {
    currentCuePanelKind = 'main';
    currentCuePanelIdx = -1;
    currentCuePanelTrackId = null;
    resetCuePanelEditState();
    renderCurrentCuePanel();
  }
}

function updateMultiSelectionClasses() {
  container.querySelectorAll('.multi-cue').forEach((element) => {
    const mainIndex = element.dataset.mainIdx == null ? -1 : Number(element.dataset.mainIdx);
    const extensionIndex = element.dataset.extIdx == null ? -1 : Number(element.dataset.extIdx);
    const selected = (Number.isInteger(mainIndex) && selectedIdxs.has(mainIndex))
      || (Number.isInteger(extensionIndex) && selectedExtensionIdxs.has(extensionIndex));
    element.classList.toggle('selected', selected);
  });
}

function addMainIndexToSelection(index) {
  if (!Number.isInteger(index) || !DATA.segments[index] || isHiddenDisabled(index)) return;
  selectedIdxs.add(index);
  const el = container.querySelector(`.cue[data-idx="${index}"]`);
  if (el) el.classList.add('selected');
}

function addExtensionIndexToSelection(index, track = getActiveExtensionTrack()) {
  if (!track?.segments?.[index] || isHiddenDisabled(index, track)) return;
  selectedExtensionIdxs.add(index);
}

// 联动选中只补充另一轨的选中集合，不切换当前字幕编辑区；编辑区焦点仍由用户最后点击的字幕决定。
function syncBoundSelection(kind, index, track = getActiveExtensionTrack()) {
  if (!EDITOR_SETTINGS.selectBoundSubtitlePair || !multiSubtitleVisible()) return;
  if (kind === 'main') {
    const binding = bindingForMainIndex(index);
    const activeTrack = getActiveExtensionTrack();
    const bindingTrack = binding ? (getExtensionTrack(binding.track_id) || activeTrack) : null;
    if (!binding || !activeTrack || bindingTrack?.id !== activeTrack.id) return;
    (binding.extension_segment_ids || []).forEach((id) => {
      const extensionIndex = activeTrack.segments.findIndex((segment) => segment?.id === id);
      if (extensionIndex >= 0) addExtensionIndexToSelection(extensionIndex, activeTrack);
    });
    return;
  }
  const binding = bindingForExtensionIndex(index, track);
  if (!binding) return;
  (binding.main_segment_ids || []).forEach((id) => {
    const mainIndex = DATA.segments.findIndex((segment) => segment?.id === id);
    if (mainIndex >= 0) addMainIndexToSelection(mainIndex);
  });
}

function selectOnlyExtension(
  index,
  track = getActiveExtensionTrack(),
  syncPair = true,
  preserveMainSelection = false,
) {
  if (!track?.segments?.[index] || isHiddenDisabled(index, track)) return;
  releaseTemporaryVisibleSplitCuesUnless('extension', index, track);
  if (
    pendingExtensionBinding
    && track?.id === pendingExtensionBinding.trackId
    && track.segments?.[index]?.id !== pendingExtensionBinding.extensionId
  ) {
    cancelPendingExtensionBinding();
  }
  if (!preserveMainSelection) {
    // 普通点击副字幕后，最后点击的轨道成为当前绑定/编辑对象；
    // 不保留旧主字幕选区，避免 G 被误解为“替换旧主字幕的绑定”。
    commitCuePanelEdit();
    selectedIdxs.clear();
    lastClickedIdx = -1;
  }
  selectedExtensionIdxs.clear();
  selectedExtensionIdxs.add(index);
  if (syncPair) syncBoundSelection('extension', index, track);
  updateMultiSelectionClasses();
  selCountEl.textContent = String(selectedIdxs.size + selectedExtensionIdxs.size);
  lastClickedExtensionIdx = index;
  waveformEditor?.updateSelection();
  setCurrentCuePanelExtensionIndex(index, track);
}

function toggleExtensionSelection(index, track = getActiveExtensionTrack()) {
  if (!track?.segments?.[index] || isHiddenDisabled(index, track)) return;
  releaseTemporaryVisibleSplitCuesUnless('extension', index, track);
  if (selectedExtensionIdxs.has(index)) selectedExtensionIdxs.delete(index);
  else {
    selectedExtensionIdxs.add(index);
    syncBoundSelection('extension', index, track);
  }
  updateMultiSelectionClasses();
  selCountEl.textContent = String(selectedIdxs.size + selectedExtensionIdxs.size);
  lastClickedExtensionIdx = index;
  waveformEditor?.updateSelection();
  setCurrentCuePanelExtensionIndex(index, track);
}

function selectExtensionRange(a, b) {
  const track = getActiveExtensionTrack();
  if (!track) return;
  releaseTemporaryVisibleSplitCuesUnless('extension', b, track);
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  selectedExtensionIdxs.clear();
  let lastSelected = -1;
  for (let index = lo; index <= hi; index++) {
    if (!track.segments[index] || isHiddenDisabled(index, track)) continue;
    selectedExtensionIdxs.add(index);
    syncBoundSelection('extension', index, track);
    lastSelected = index;
  }
  updateMultiSelectionClasses();
  selCountEl.textContent = String(selectedIdxs.size + selectedExtensionIdxs.size);
  if (lastSelected < 0) return;
  lastClickedExtensionIdx = lastSelected;
  waveformEditor?.updateSelection();
  setCurrentCuePanelExtensionIndex(lastSelected, track);
}
function toggleSel(idx) {
  if (isHiddenDisabled(idx)) return;  // 隐藏禁用项不参与选择
  releaseTemporaryVisibleSplitCuesUnless('main', idx);
  hideCueSplitPreview();
  const el = container.querySelector(`.cue[data-idx="${idx}"]`);
  if (selectedIdxs.has(idx)) {
    selectedIdxs.delete(idx);
    if (el) el.classList.remove('selected');
  } else {
    selectedIdxs.add(idx);
    if (el) el.classList.add('selected');
    syncBoundSelection('main', idx);
  }
  selCountEl.textContent = String(selectedIdxs.size + selectedExtensionIdxs.size);
  if (waveformEditor) waveformEditor.updateSelection();
  updateMultiSelectionClasses();
  setCurrentCuePanelIndex(selectedIdxs.has(idx) ? idx : (selectedIdxs.values().next().value ?? -1));
}
function selectRange(a, b) {
  hideCueSplitPreview();
  releaseTemporaryVisibleSplitCuesUnless('main', b);
  const lo = Math.min(a, b), hi = Math.max(a, b);
  for (let i = lo; i <= hi; i++) {
    if (isHiddenDisabled(i)) continue;  // 跳过隐藏禁用项
    if (!selectedIdxs.has(i)) {
      selectedIdxs.add(i);
      const el = container.querySelector(`.cue[data-idx="${i}"]`);
      if (el) el.classList.add('selected');
    }
    syncBoundSelection('main', i);
  }
  selCountEl.textContent = String(selectedIdxs.size + selectedExtensionIdxs.size);
  if (waveformEditor) waveformEditor.updateSelection();
  updateMultiSelectionClasses();
  setCurrentCuePanelIndex(selectedIdxs.has(b) ? b : (selectedIdxs.values().next().value ?? -1));
}
function selectOnly(idx, syncPair = true) {
  hideCueSplitPreview();
  releaseTemporaryVisibleSplitCuesUnless('main', idx);
  // 这是键盘导航的热路径：clearSelection() 会先把面板切到空状态，
  // 再由下面的 setCurrentCuePanelIndex() 切回目标，导致一次按键触发
  // 两次面板刷新和两次波形选区刷新。先提交一次待编辑内容，再批量
  // 更新选区与面板，保持行为不变但只做一次视觉刷新。
  commitCuePanelEdit();
  clearSelection({ silent: true });
  lastClickedExtensionIdx = -1;
  selectedIdxs.add(idx);
  if (syncPair) syncBoundSelection('main', idx);
  const el = container.querySelector(`.cue[data-idx="${idx}"]`);
  if (el) el.classList.add('selected');
  selCountEl.textContent = String(selectedIdxs.size + selectedExtensionIdxs.size);
  if (waveformEditor) waveformEditor.updateSelection();
  updateMultiSelectionClasses();
  setCurrentCuePanelIndex(idx);
}
function addToSelection(idx) {
  if (isHiddenDisabled(idx) || selectedIdxs.has(idx)) return;
  releaseTemporaryVisibleSplitCuesUnless('main', idx);
  hideCueSplitPreview();
  selectedIdxs.add(idx);
  syncBoundSelection('main', idx);
  const el = container.querySelector(`.cue[data-idx="${idx}"]`);
  if (el) el.classList.add('selected');
  selCountEl.textContent = String(selectedIdxs.size + selectedExtensionIdxs.size);
  if (waveformEditor) waveformEditor.updateSelection();
  setCurrentCuePanelIndex(idx);
}
function addExtensionToSelection(index, track = getActiveExtensionTrack()) {
  if (!track?.segments?.[index] || isHiddenDisabled(index, track) || selectedExtensionIdxs.has(index)) return;
  releaseTemporaryVisibleSplitCuesUnless('extension', index, track);
  selectedExtensionIdxs.add(index);
  syncBoundSelection('extension', index, track);
  updateMultiSelectionClasses();
  selCountEl.textContent = String(selectedIdxs.size + selectedExtensionIdxs.size);
  waveformEditor?.updateSelection();
  setCurrentCuePanelExtensionIndex(index, track);
}
// 选中全部字幕（跳过「隐藏禁用项」开启时的禁用条目，与其它选择逻辑一致）。
function selectAll() {
  commitCuePanelEdit();
  clearSelection({ silent: true });
  DATA.segments.forEach((_, idx) => {
    if (isHiddenDisabled(idx)) return;
    selectedIdxs.add(idx);
    syncBoundSelection('main', idx);
    const el = container.querySelector(`.cue[data-idx="${idx}"]`);
    if (el) el.classList.add('selected');
  });
  const extensionTrack = getActiveExtensionTrack();
  extensionTrack?.segments.forEach((_, idx) => {
    if (isHiddenDisabled(idx, extensionTrack)) return;
    selectedExtensionIdxs.add(idx);
    syncBoundSelection('extension', idx, extensionTrack);
  });
  updateMultiSelectionClasses();
  selCountEl.textContent = String(selectedIdxs.size + selectedExtensionIdxs.size);
  if (waveformEditor) waveformEditor.updateSelection();
  const last = DATA.segments.length - 1;
  if (last >= 0 && selectedIdxs.has(last)) {
    setCurrentCuePanelIndex(last);
    return;
  }
  const firstMain = selectedIdxs.values().next().value;
  if (firstMain !== undefined) {
    setCurrentCuePanelIndex(firstMain);
    return;
  }
  if (!extensionTrack) {
    setCurrentCuePanelIndex(-1);
    return;
  }
  const lastExtension = extensionTrack.segments.length - 1;
  if (lastExtension >= 0 && selectedExtensionIdxs.has(lastExtension)) {
    setCurrentCuePanelExtensionIndex(lastExtension, extensionTrack);
    return;
  }
  const firstExtension = selectedExtensionIdxs.values().next().value;
  setCurrentCuePanelExtensionIndex(firstExtension ?? -1, extensionTrack);
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
  releaseTemporaryVisibleSplitCuesUnless('main', idx);
  if (pendingExtensionBinding) {
    const pending = pendingExtensionBinding;
    pendingExtensionBinding = null;
    const track = getExtensionTrack(pending.trackId);
    const extensionIndex = track?.segments?.findIndex(
      (segment) => segment.id === pending.extensionId,
    ) ?? -1;
    if (extensionIndex < 0) {
      flashHint('扩展字幕已不存在，绑定已取消', 'warning');
      return;
    }
    // selectOnly 会清空扩展轨选择，因此先完成主轨选择，再恢复待绑定的扩展轨选择。
    selectOnly(idx, false);
    selectOnlyExtension(extensionIndex, track, false, true);
    bindSelectedSubtitlePair();
    return;
  }
  if (EDITOR_SETTINGS.selectGroupMembers) {
    const members = groupMemberIdxs(idx);
    if (members.length > 1) {
      commitCuePanelEdit();
      clearSelection({ silent: true });
      members.forEach((i) => {
        selectedIdxs.add(i);
        syncBoundSelection('main', i);
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

function overlappingMainIndexesForExtension(extension) {
  const start = Number(extension?.start);
  const end = Number(extension?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  return DATA.segments.map((main, mainIndex) => ({ main, mainIndex }))
    .filter(({ main }) => Number(main?.start) < end && Number(main?.end) > start)
    .map(({ mainIndex }) => mainIndex);
}

function beginPendingExtensionBinding(index, track = getActiveExtensionTrack()) {
  const extension = track?.segments?.[index];
  if (!extension || !track) return;
  const overlapping = overlappingMainIndexesForExtension(extension);
  const unbound = overlapping.filter((mainIndex) => !bindingForMainIndex(mainIndex));
  if (unbound.length) {
    // 有多个候选时仍优先选择时间最早且尚未绑定的主字幕，避免每次绑定都要手动点选。
    const mainIndex = unbound.slice().sort((left, right) => (
      Number(DATA.segments[left]?.start) - Number(DATA.segments[right]?.start) || left - right
    ))[0];
    selectOnly(mainIndex);
    selectOnlyExtension(index, track, true, true);
    bindSelectedSubtitlePair({
      successMessage: overlapping.length > 1
        ? `有多条主字幕与当前副字幕重叠，已自动绑定时间最早的未绑定主字幕（第 ${mainIndex + 1} 条）`
        : null,
    });
    return;
  }
  pendingExtensionBinding = { trackId: track.id, extensionId: extension.id };
  selectOnlyExtension(index, track);
  if (overlapping.length) {
    flashHint('重叠的主字幕已有绑定，请点击主字幕后替换绑定；按 Esc 取消', 'warning');
  } else {
    flashHint('请点击一条主字幕完成绑定；按 Esc 或点击空白处取消');
  }
}

function bindSelectedSubtitlePair({ successMessage = null } = {}) {
  if (!multiSubtitleVisible()) return;
  if (selectedIdxs.size !== 1 || selectedExtensionIdxs.size !== 1) {
    flashHint('请分别选中一条主字幕和一条扩展字幕后再绑定', 'invalid');
    return;
  }
  const mainIndex = [...selectedIdxs][0];
  const extensionIndex = [...selectedExtensionIdxs][0];
  const track = getActiveExtensionTrack();
  const main = DATA.segments[mainIndex];
  const extension = track?.segments?.[extensionIndex];
  if (!main || !extension) return;
  const replacedBinding = bindingForMainIndex(mainIndex);
  pushUndo('绑定多重字幕');
  addSubtitleBinding(main, extension, track);
  const autoSynced = EDITOR_SETTINGS.multiSubtitleAutoSyncDuration
    && alignExtensionToMainTimeRange(extensionIndex, track, { pushHistory: false, showHint: false });
  markMainSegmentsDirty([main]);
  markMultiSubtitleDirty();
  // 绑定会更新波形上的绑定标记；自动同步时也会改变副字幕范围，
  // 因此列表与波形都需要同步刷新。
  renderAll({ waveform: 'overlay' });
  waveformEditor?.updateSelection();
  const bindingMessage = successMessage
    || (replacedBinding
      ? `已替换主字幕 ${mainIndex + 1} 的绑定，改为扩展字幕 ${extensionIndex + 1}`
      : `已绑定主字幕 ${mainIndex + 1} 与扩展字幕 ${extensionIndex + 1}`);
  flashHint(`${bindingMessage}${autoSynced ? '，并同步时长' : ''}`, 'success');
}

function unbindSelectedSubtitlePair() {
  const multi = getMultiSubtitleState();
  const ids = new Set();
  selectedIdxs.forEach((index) => { if (DATA.segments[index]?.id) ids.add(DATA.segments[index].id); });
  const track = getActiveExtensionTrack();
  selectedExtensionIdxs.forEach((index) => { if (track?.segments[index]?.id) ids.add(track.segments[index].id); });
  if (!ids.size) return;
  const removed = MULTI_SUBTITLE_UTILS.removeSubtitleBindings(multi, (binding) => (
    binding.main_segment_ids?.some((id) => ids.has(id))
      || binding.extension_segment_ids?.some((id) => ids.has(id))
  ));
  if (!removed.length) {
    flashHint('当前选中字幕没有绑定关系', 'invalid');
    return;
  }
  // removeSubtitleBindings 已经返回具体关系；快照必须在真正修改前建立。
  // 这里把预览关系恢复后再记录，避免解绑动作无法撤销。
  multi.bindings.push(...removed);
  pushUndo('解绑多重字幕');
  MULTI_SUBTITLE_UTILS.removeSubtitleBindings(multi, (binding) => removed.includes(binding));
  markMultiSubtitleDirty();
  syncBindingOffsets();
  // 解绑会移除波形上的绑定标记，也需要刷新字幕块覆盖层。
  renderAll({ waveform: 'overlay' });
  waveformEditor?.updateSelection();
  flashHint(`已解绑 ${removed.length} 对字幕`, 'success');
}

function alignExtensionToMainTimeRanges(
  indices,
  track = getActiveExtensionTrack(),
  { pushHistory = true, showHint = true, batch = false } = {},
) {
  const uniqueIndices = [...new Set((Array.isArray(indices) ? indices : [indices])
    .map((index) => Number(index)).filter(Number.isInteger))];
  const targets = [];
  let skippedUnbound = 0;
  let skippedInvalid = 0;
  uniqueIndices.forEach((index) => {
    const extension = track?.segments?.[index];
    const binding = bindingForExtensionIndex(index, track);
    const main = binding ? mainSegmentById(binding.main_segment_ids?.[0]) : null;
    if (!extension || !binding || !main) {
      skippedUnbound += 1;
      return;
    }
    const start = Math.round(Number(main.start));
    const end = Math.round(Number(main.end));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      skippedInvalid += 1;
      return;
    }
    const alreadyAligned = Number(extension.start) === start && Number(extension.end) === end;
    const hasOverlap = extensionRangeOverlapsNeighbors(extension, start, end, track);
    if (!alreadyAligned || hasOverlap) targets.push({ extension, start, end });
  });

  if (!targets.length) {
    if (showHint) {
      if (skippedInvalid && !skippedUnbound) flashHint('主字幕时间范围无效，无法对齐', 'warning');
      else if (batch || uniqueIndices.length > 1) {
        flashHint(skippedUnbound
          ? '选中的副字幕中没有可对齐的绑定关系'
          : '选中的副字幕已经与各自主字幕时间范围一致');
      } else if (skippedUnbound) {
        flashHint('请先绑定副字幕，才能对齐主字幕时间范围', 'invalid');
      } else {
        flashHint('副字幕已经与主字幕时间范围一致');
      }
    }
    return false;
  }

  if (pushHistory) pushUndo(batch || targets.length > 1 ? '批量对齐副字幕' : '对齐副字幕时间范围');
  // 先写入全部目标范围，再统一处理其它副字幕的冲突；主字幕范围不会被改写。
  targets.forEach(({ extension, start, end }) => setExtensionSegmentRange(extension, start, end));
  const resolved = reconcileExtensionTrack(track, targets.map(({ extension }) => extension));
  markMultiSubtitleDirty();
  syncBindingOffsets();
  renderAll();
  update();
  const details = [];
  if (resolved.squeezedCount) details.push(`挤压 ${resolved.squeezedCount} 条副字幕`);
  if (resolved.removedCount) details.push(`删除 ${resolved.removedCount} 条副字幕`);
  if (showHint) {
    const prefix = batch || targets.length > 1
      ? `已批量对齐 ${targets.length} 条副字幕`
      : '已将副字幕对齐到主字幕时间范围';
    const suffix = details.length
      ? `，${details.join('，')}${resolved.unboundCount ? '并解除绑定' : ''}`
      : skippedUnbound ? `，跳过 ${skippedUnbound} 条未绑定副字幕` : '';
    flashHint(`${prefix}${suffix}`, details.length ? 'warning' : 'success');
  }
  return true;
}

function alignExtensionToMainTimeRange(
  index,
  track = getActiveExtensionTrack(),
  { pushHistory = true, showHint = true } = {},
) {
  return alignExtensionToMainTimeRanges([index], track, { pushHistory, showHint });
}

function alignSelectedExtensionSubtitleRanges() {
  if (!multiSubtitleVisible()) return false;
  const track = getActiveExtensionTrack();
  const indices = [...selectedExtensionIdxs];
  if (!indices.length) {
    flashHint('请先选中至少一条副字幕', 'invalid');
    return false;
  }
  return alignExtensionToMainTimeRanges(indices, track, {
    batch: indices.length > 1,
  });
}

// === 渲染 ===
function renderAll({ waveform = 'overlay' } = {}) {
  stickerOverlayDataVersion += 1;
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
  const cueFragment = document.createDocumentFragment();
  const multiVisible = multiSubtitleVisible();
  const displayMode = getMultiSubtitleState().display_mode || 'both';
  if (!multiVisible || displayMode === 'main') {
    DATA.segments.forEach((seg, i) => cueFragment.appendChild(buildCueEl(seg, i)));
  } else if (displayMode === 'extension') {
    const track = getActiveExtensionTrack();
    track.segments.forEach((seg, i) => cueFragment.appendChild(buildExtensionCueEl(seg, i, track)));
  } else {
    const track = getActiveExtensionTrack();
    const rows = MULTI_SUBTITLE_UTILS.buildMultiDisplayRows(DATA.segments, track.segments, getMultiSubtitleState().bindings);
    rows.forEach((row) => cueFragment.appendChild(buildDualCueEl(row.mainIndex, row.extensionIndex, track)));
  }
  container.appendChild(cueFragment);
  applyCueListDisplaySettings();
  totalCountEl.textContent = multiVisible && displayMode === 'extension'
    ? getActiveExtensionTrack()?.segments.length || 0
    : DATA.segments.length;
  // buildCueEl/buildMultiCueColumn 已经按当前搜索词生成了文本；这里仅
  // 计算隐藏状态和数量，避免长工程 renderAll() 再逐行重建一遍文本节点。
  applySearch(searchEl.value, { refreshText: false });
  // 重新应用选中样式（idx 不变时还有效；如果有 splice 改了顺序就先 clearSelection）
  selectedIdxs.forEach(i => {
    const el = container.querySelector(`.cue[data-idx="${i}"]`);
    if (el) el.classList.add('selected');
  });
  // 字幕结构变化只需更新波形上的字幕块覆盖层；媒体峰值和行 Canvas
  // 没有变化，避免 B/C/删除等操作重新绘制整组波形。
  updateMultiSelectionClasses();
  if (waveformEditor) {
    if (waveform === 'full') waveformEditor.renderSegments();
    else if (waveform !== 'none') {
      // 字幕块变化不需要重新创建行和 Canvas；兼容旧版波形对象时才回退到
      // 原来的完整刷新路径。
      if (typeof waveformEditor.refreshCueOverlay === 'function') waveformEditor.refreshCueOverlay();
      else waveformEditor.renderSegments();
    }
  }
  renderCurrentCuePanel();
  syncPlayerPlaceholder();
  updateMultiSubtitleUi();
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

function getCurrentCuePanelTarget() {
  const index = currentCuePanelIdx;
  if (!Number.isInteger(index) || index < 0) return null;
  if (currentCuePanelKind === 'extension') {
    const track = getExtensionTrack(currentCuePanelTrackId);
    const segment = track?.segments?.[index];
    return segment
      ? { kind: 'extension', index, trackId: track.id, track, segment }
      : null;
  }
  const segment = DATA.segments[index];
  return segment ? { kind: 'main', index, trackId: null, track: null, segment } : null;
}

function getCuePanelTextElement(target) {
  if (!target) return null;
  if (target.kind === 'extension') {
    return container.querySelector(
      `.multi-dual-cue[data-ext-idx="${target.index}"] .multi-cue-column.extension .text, `
        + `.multi-extension-cue[data-ext-idx="${target.index}"] > .text`,
    );
  }
  return container.querySelector(
    `.multi-dual-cue[data-main-idx="${target.index}"] .multi-cue-column.main .text, `
      + `.cue[data-idx="${target.index}"] > .text`,
  );
}

function setCuePanelTarget(kind, index, trackId = null) {
  const nextKind = kind === 'extension' ? 'extension' : 'main';
  let nextIndex = Number.isInteger(index) ? index : -1;
  let nextTrackId = nextKind === 'extension' ? trackId : null;
  if (nextKind === 'extension') {
    const track = getExtensionTrack(nextTrackId);
    if (!track?.segments?.[nextIndex]) {
      nextIndex = -1;
      nextTrackId = null;
    } else {
      nextTrackId = track.id;
    }
  } else if (!DATA.segments[nextIndex]) {
    nextIndex = -1;
  }
  if (
    currentCuePanelKind === nextKind
    && currentCuePanelIdx === nextIndex
    && currentCuePanelTrackId === nextTrackId
  ) {
    renderCurrentCuePanel();
    return;
  }
  commitCuePanelEdit();
  currentCuePanelKind = nextKind;
  currentCuePanelIdx = nextIndex;
  currentCuePanelTrackId = nextTrackId;
  resetCuePanelEditState();
  renderCurrentCuePanel();
}

function setCurrentCuePanelIndex(index) {
  setCuePanelTarget('main', index);
}

function setCurrentCuePanelExtensionIndex(index, track = getActiveExtensionTrack()) {
  setCuePanelTarget('extension', index, track?.id || null);
}

function ensureCuePanelUndo(label = null) {
  if (!cuePanelUndoPushed) {
    const target = getCurrentCuePanelTarget();
    cuePanelUndoRecord = pushUndo(
      label || (target?.kind === 'extension' ? '编辑副字幕' : '编辑当前字幕'),
    );
    cuePanelUndoPushed = true;
  }
}

function commitCuePanelEdit() {
  const target = getCurrentCuePanelTarget();
  const seg = target?.segment;
  if (!target || !seg) { resetCuePanelEditState(); return false; }
  const segments = target.kind === 'extension' ? target.track.segments : DATA.segments;
  const idx = target.index;
  const nextText = cuePanelText.value.replace(/\r\n?/g, '\n');
  const oldStart = seg.start;
  const oldEnd = seg.end;
  const requestedStart = parsePanelTime(cuePanelStart.value, oldStart);
  const requestedDuration = Math.max(100, parsePanelTime(cuePanelDuration.value, oldEnd - oldStart));
  const previousEnd = idx > 0 ? segments[idx - 1].end : 0;
  const nextStart = idx + 1 < segments.length ? segments[idx + 1].start : (waveformEditor?.durationMs || oldEnd);
  if (nextStart - previousEnd < 100) {
    flashHint('相邻字幕之间不足 100ms，无法调整当前字幕', 'warning');
    renderCurrentCuePanel();
    resetCuePanelEditState();
    return false;
  }
  const newStart = Math.max(previousEnd, Math.min(requestedStart, nextStart - 100));
  const newEnd = Math.min(nextStart, newStart + requestedDuration);
  if (newEnd - newStart < 100) {
    flashHint('字幕时长不能小于 100ms', 'warning');
    renderCurrentCuePanel();
    resetCuePanelEditState();
    return false;
  }
  const changed = nextText !== seg.text || newStart !== oldStart || newEnd !== oldEnd;
  if (!changed) {
    resetCuePanelEditState();
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
  if (target.kind === 'main') {
    seg.items = remapPanelItems(seg.items, oldStart, oldEnd, seg.start, seg.end);
  }
  seg._dirty = true;
  const timingChanged = newStart !== oldStart || newEnd !== oldEnd;
  if (target.kind === 'main') {
    if (timingChanged) {
      const syncPatch = { oldStart, oldEnd, mode: 'range' };
      syncBoundExtensionForMain(seg, syncPatch);
      if (syncPatch.syncConflict) {
        const details = [];
        if (syncPatch.syncSqueezedCount) details.push(`挤压 ${syncPatch.syncSqueezedCount} 条副字幕`);
        if (syncPatch.syncRemovedCount) {
          details.push(`删除 ${syncPatch.syncRemovedCount} 条副字幕`);
        }
        flashHint(
          details.length
            ? `副字幕已联动调整，${details.join('，')}${syncPatch.syncUnboundCount ? '并解除绑定' : ''}`
            : '副字幕已随主字幕联动调整',
          details.length ? 'warning' : 'success',
        );
      }
    }
  } else {
    if (timingChanged) {
      const blocked = constrainBoundExtensionPanelEdit(seg, target.track, oldStart, oldEnd);
      if (blocked) flashHint('主字幕轨道已无可用空间，已限制副字幕时间', 'warning');
    }
  }
  syncBindingOffsets();
  markMultiSubtitleDirty();
  scheduleAutoSaveFlush();
  resetCuePanelEditState();
  renderAll();
  update();
  return true;
}

function renderCurrentCuePanel() {
  if (!cuePanel) return;
  const target = getCurrentCuePanelTarget();
  const idx = target?.index ?? -1;
  const seg = target?.segment || null;
  const empty = !target;
  cuePanel.classList.toggle('empty', empty);
  cuePanel.classList.toggle('extension-target', !empty && target.kind === 'extension');
  if (cuePanelTarget) {
    const label = empty ? '未选择' : target.kind === 'extension' ? '副字幕' : '主字幕';
    cuePanelTarget.textContent = window.MAWE_I18N?.translateText?.(label) || label;
    cuePanelTarget.classList.toggle('extension', !empty && target.kind === 'extension');
  }
  [cuePanelPrev, cuePanelNext, cuePanelStart, cuePanelDuration, cuePanelText, cuePanelAddSticker, cuePanelSplit]
    .forEach((element) => { if (element) element.disabled = empty; });
  const stickersEnabled = !empty && target.kind === 'main';
  if (cuePanelAddSticker) cuePanelAddSticker.disabled = !stickersEnabled;
  if (cuePanelSticker) {
    cuePanelSticker.classList.toggle('disabled', !stickersEnabled);
    cuePanelSticker.setAttribute('aria-disabled', stickersEnabled ? 'false' : 'true');
  }
  if (empty) {
    cuePanelText.value = '';
    cuePanelStart.value = '';
    cuePanelDuration.value = '';
    cuePanelTotalLength.textContent = '0';
    cuePanelCharsPerSecond.textContent = '0.00';
    cuePanelSticker.replaceChildren();
    cuePanelSticker.textContent = window.MAWE_I18N?.translateText?.('未选择') || '未选择';
    return;
  }
  if (document.activeElement !== cuePanelText || !cuePanelUndoPushed) cuePanelText.value = seg.text || '';
  cuePanelStart.value = fmtShort(seg.start);
  cuePanelDuration.value = ((seg.end - seg.start) / 1000).toFixed(3);
  const splitMode = target.kind === 'extension'
    ? getExtensionSubtitleSplitMode(target.track, seg)
    : getMainSubtitleSplitMode(seg);
  const metrics = window.AsrEditorUtils.cueMetrics(
    seg.text || '', seg.start, seg.end, splitMode,
  );
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
    cuePanelSticker.textContent = window.MAWE_I18N?.translateText?.('暂无表情包') || '暂无表情包';
    cuePanelSticker.title = window.MAWE_I18N?.translateText?.('点击添加表情包') || '点击添加表情包';
  }
  const segments = target.kind === 'extension' ? target.track.segments : DATA.segments;
  const previous = window.AsrEditorUtils.findAdjacentCueIndex(segments, idx, -1, hideDisabled);
  const next = window.AsrEditorUtils.findAdjacentCueIndex(segments, idx, 1, hideDisabled);
  cuePanelPrev.disabled = previous < 0;
  cuePanelNext.disabled = next < 0;
}

function focusCuePanelText(idx = currentCuePanelIdx, kind = currentCuePanelKind) {
  const target = getCurrentCuePanelTarget();
  if (!cuePanelText || !target || target.index !== idx || target.kind !== kind) return false;
  cuePanelText.focus();
  const end = cuePanelText.value.length;
  cuePanelText.setSelectionRange(end, end);
  return true;
}

function dirtyFlagSnapshot(value) {
  return value && Object.prototype.hasOwnProperty.call(value, '_dirty') ? value._dirty : null;
}

function restoreDirtyFlag(target, value) {
  if (!target) return;
  if (value === null) delete target._dirty;
  else target._dirty = value;
}

function captureCuePanelTextEditSnapshot() {
  const target = getCurrentCuePanelTarget();
  if (!target || !cuePanelText) {
    cuePanelTextEditSnapshot = null;
    return;
  }
  const multi = getMultiSubtitleState();
  cuePanelTextEditSnapshot = {
    kind: target.kind,
    index: target.index,
    trackId: target.trackId,
    text: target.segment.text || '',
    dirty: dirtyFlagSnapshot(target.segment),
    multiDirty: target.kind === 'extension' ? {
      state: dirtyFlagSnapshot(multi),
      tracks: (multi.tracks || []).map((track) => ({
        state: dirtyFlagSnapshot(track),
        segments: (track.segments || []).map((segment) => dirtyFlagSnapshot(segment)),
      })),
    } : null,
  };
}

function restoreCuePanelTextEditSnapshot() {
  const snapshot = cuePanelTextEditSnapshot;
  const target = getCurrentCuePanelTarget();
  if (!snapshot || !target
      || snapshot.kind !== target.kind
      || snapshot.index !== target.index
      || snapshot.trackId !== target.trackId) return false;
  target.segment.text = snapshot.text;
  restoreDirtyFlag(target.segment, snapshot.dirty);
  if (snapshot.multiDirty) {
    const multi = getMultiSubtitleState();
    restoreDirtyFlag(multi, snapshot.multiDirty.state);
    snapshot.multiDirty.tracks.forEach((trackSnapshot, trackIndex) => {
      const track = multi.tracks?.[trackIndex];
      if (!track) return;
      restoreDirtyFlag(track, trackSnapshot.state);
      trackSnapshot.segments.forEach((dirty, segmentIndex) => {
        restoreDirtyFlag(track.segments?.[segmentIndex], dirty);
      });
    });
  }
  return true;
}

function discardPendingCuePanelUndo() {
  const record = cuePanelUndoRecord;
  if (cuePanelUndoPushed && record && editorHistory.peekUndo() === record) {
    editorHistory.popUndo({
      kind: 'segments',
      label: record.label,
      segs: snapshotSegments(),
    });
    // 这条记录本来就清空了 redo；popUndo 临时生成的镜像也不能留下。
    editorHistory.clearRedo();
    updateUndoRedoButtons();
  }
  resetCuePanelEditState();
}

function cancelCuePanelTextEdit() {
  const restored = restoreCuePanelTextEditSnapshot();
  discardPendingCuePanelUndo();
  if (restored) {
    renderAll();
    update();
  }
  if (document.activeElement === cuePanelText) {
    cuePanelCanceling = true;
    cuePanelText.blur();
    cuePanelCanceling = false;
  }
  return restored;
}

function exitCuePanelEdit() {
  if (!cuePanelText) return false;
  if (document.activeElement === cuePanelText) {
    // blur 事件负责提交，和 Esc 的行为保持一致。
    cuePanelText.blur();
    return true;
  }
  return commitCuePanelEdit();
}
function navigateCuePanel(direction) {
  const target = getCurrentCuePanelTarget();
  if (!target) return;
  commitCuePanelEdit();
  const next = window.AsrEditorUtils.findAdjacentCueIndex(
    target.kind === 'extension' ? target.track.segments : DATA.segments,
    target.index,
    direction,
    hideDisabled,
  );
  if (next < 0) return;
  const segments = target.kind === 'extension' ? target.track.segments : DATA.segments;
  if (target.kind === 'extension') {
    selectOnlyExtension(next);
    lastClickedExtensionIdx = next;
  } else {
    selectOnly(next);
    lastClickedIdx = next;
  }
  const cue = container.querySelector(
    target.kind === 'extension' ? `.cue[data-ext-idx="${next}"]` : `.cue[data-idx="${next}"]`,
  );
  if (cue) scrollCueToCenter(cue);
  waveformEditor?.revealTime(segments[next].start, true);
}

function splitCuePanelAtCursor() {
  const target = getCurrentCuePanelTarget();
  if (!target) return;
  const cursorOffset = cuePanelText.selectionStart;
  if (target.kind === 'extension') {
    const splitTime = splitTimeForTextOffset(target.segment, cursorOffset);
    commitCuePanelEdit();
    const refreshed = getCurrentCuePanelTarget();
    if (!refreshed) return;
    openExtensionSplitModal(
      refreshed.index,
      splitTimeForTextOffset(refreshed.segment, cursorOffset) || splitTime,
      refreshed.track,
    );
    return;
  }
  const idx = target.index;
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
  splitAtCursor(null, { listFeedback: false });
}

cuePanelPrev?.addEventListener('click', () => navigateCuePanel(-1));
cuePanelNext?.addEventListener('click', () => navigateCuePanel(1));
cuePanelText?.addEventListener('focus', captureCuePanelTextEditSnapshot);
cuePanelText?.addEventListener('keydown', (event) => {
  // Esc：按当前字幕编辑区设置决定取消还是提交文本编辑。
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    if (EDITOR_SETTINGS.cueEditorCancelOnEscape) cancelCuePanelTextEdit();
    else exitCuePanelEdit();
    return;
  }
  const action = getConfiguredEnterAction(event);
  if (!action || action === 'newline') return;
  event.preventDefault();
  event.stopPropagation();
  if (action === 'split') splitCuePanelAtCursor();
  else exitCuePanelEdit();
});
cuePanelText?.addEventListener('input', () => {
  const target = getCurrentCuePanelTarget();
  if (!target) return;
  ensureCuePanelUndo(target.kind === 'extension' ? '编辑副字幕' : '编辑当前字幕');
  const seg = target.segment;
  seg.text = cuePanelText.value.replace(/\r\n?/g, '\n');
  seg._dirty = true;
  if (target.kind === 'extension') markMultiSubtitleDirty();
  scheduleAutoSaveFlush();
  const splitMode = target.kind === 'extension'
    ? getExtensionSubtitleSplitMode(target.track, seg)
    : getMainSubtitleSplitMode(seg);
  const metrics = window.AsrEditorUtils.cueMetrics(
    seg.text, seg.start, seg.end, splitMode,
  );
  cuePanelTotalLength.textContent = String(metrics.totalLength);
  cuePanelCharsPerSecond.textContent = metrics.charsPerSecond.toFixed(2);
  const textEl = getCuePanelTextElement(target);
  if (textEl) {
    setTextHtml(textEl, seg.text, searchEl.value);
    applyCharCount(textEl.closest('.cue')?.querySelector('.charcount'), seg.text, splitMode);
  }
  if (target.kind === 'extension') waveformEditor?.refreshExtensionCueLabel(target.index, target.trackId);
  else waveformEditor?.refreshCueLabel(target.index);
  refreshSubtitlePreview();
});
cuePanelText?.addEventListener('blur', () => {
  if (cuePanelCanceling) return;
  commitCuePanelEdit();
});
cuePanelStart?.addEventListener('change', () => commitCuePanelEdit());
cuePanelDuration?.addEventListener('change', () => commitCuePanelEdit());
cuePanelAddSticker?.addEventListener('click', () => {
  const target = getCurrentCuePanelTarget();
  if (target?.kind === 'main') openStickerPicker([target.index], false);
});
cuePanelSticker?.addEventListener('click', () => {
  const target = getCurrentCuePanelTarget();
  if (target?.kind === 'main') openStickerPicker([target.index], false);
});
cuePanelSticker?.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  const target = getCurrentCuePanelTarget();
  if (target?.kind !== 'main') return;
  removeStickerCascade(target.index);
  renderAll();
  flashHint('已删除当前表情包', 'success');
});
cuePanelSplit?.addEventListener('click', splitCuePanelAtCursor);

function buildCueEl(seg, idx, { extensionTrack = null } = {}) {
  const isExtension = Boolean(extensionTrack);
  const el = document.createElement('div');
  el.className = multiSubtitleVisible() ? 'cue multi-cue' : 'cue';
  if (isExtension) {
    el.classList.add('multi-extension-cue');
    el.dataset.extIdx = String(idx);
  } else {
    el.dataset.idx = idx;
    if (multiSubtitleVisible()) el.dataset.mainIdx = String(idx);
  }
  if (seg._dirty) el.classList.add('dirty');
  if (seg.disabled) el.classList.add('disabled');

  const getCueByIndex = (index) => container.querySelector(
    isExtension ? `.cue[data-ext-idx="${index}"]` : `.cue[data-idx="${index}"]`,
  );
  const selectCueByIndex = isExtension ? selectOnlyExtension : selectOnly;

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
      const head = getCueByIndex(seg.color_ref.headIdx);
      if (head) { scrollCueToCenter(head); selectCueByIndex(seg.color_ref.headIdx); }
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
      if (!isExtension) openStickerPreview(idx);
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
      const head = getCueByIndex(seg.sticker_ref.headIdx);
      if (head) { scrollCueToCenter(head); selectCueByIndex(seg.sticker_ref.headIdx); }
    });
    slotEl.appendChild(refEl);
  }

  const textEl = document.createElement('span');
  textEl.className = 'text';
  setTextHtml(textEl, seg.text, searchEl.value);

  const cntEl = document.createElement('span');
  cntEl.className = 'charcount';
  applyCharCount(
    cntEl,
    seg.text,
    isExtension ? getExtensionSubtitleSplitMode(extensionTrack, seg) : getMainSubtitleSplitMode(seg),
  );

  el.appendChild(colorBar);
  el.appendChild(indexEl);
  el.appendChild(timeEl);
  el.appendChild(slotEl);
  el.appendChild(textEl);
  el.appendChild(cntEl);

  if (isExtension) bindExtensionCueEvents(el, idx, extensionTrack);
  else bindCueEvents(el, idx);
  return el;
}

function buildMultiTimeEl(segment) {
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = `${fmtShort(segment.start)} → ${fmtShort(segment.end)}`;
  return time;
}

function buildMultiCueColumn(segment, index, track, kind) {
  const column = document.createElement('div');
  column.className = `multi-cue-column ${kind}`;
  if (!segment) {
    column.classList.add('multi-cue-empty');
    column.textContent = '—';
    return column;
  }
  if (segment.disabled) column.classList.add('disabled');
  const header = document.createElement('div');
  header.className = 'multi-cue-column-header';
  const indexEl = document.createElement('span');
  indexEl.className = 'index';
  indexEl.textContent = `${kind === 'main' ? '主字幕' : '副字幕'} ${index + 1}`;
  header.append(indexEl, buildMultiTimeEl(segment));
  const text = document.createElement('span');
  text.className = 'text';
  setTextHtml(text, segment.text || '', searchEl.value);
  column.append(header, text);
  if (kind === 'extension') {
    const binding = bindingForExtensionIndex(index, track);
    if (!binding) column.classList.add('unbound');
    column.dataset.extIdx = String(index);
  } else {
    column.dataset.mainIdx = String(index);
  }
  column.dataset.start = String(segment.start);
  column.dataset.end = String(segment.end);
  return column;
}

function buildExtensionCueEl(seg, idx, track) {
  return buildCueEl(seg, idx, { extensionTrack: track });
}

function buildDualCueEl(mainIndex, extensionIndex, track) {
  const main = mainIndex == null ? null : DATA.segments[mainIndex];
  const extension = extensionIndex == null ? null : track.segments[extensionIndex];
  const el = document.createElement('div');
  el.className = 'cue multi-cue multi-dual-cue';
  if (mainIndex != null) {
    el.dataset.mainIdx = String(mainIndex);
    el.dataset.idx = String(mainIndex);
  }
  if (extensionIndex != null) el.dataset.extIdx = String(extensionIndex);
  el.append(
    buildMultiCueColumn(main, mainIndex ?? -1, track, 'main'),
    buildMultiCueColumn(extension, extensionIndex ?? -1, track, 'extension'),
  );
  if (main) bindCueEvents(el, mainIndex);
  if (extension) {
    const extensionColumn = el.querySelector('.multi-cue-column.extension');
    bindExtensionCueEvents(extensionColumn, extensionIndex, track, el);
  }
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
function calcCharWidth(text, mode = null) {
  return mode
    ? window.AsrEditorUtils.countSubtitleUnits(text, mode)
    : window.AsrEditorUtils.countTextUnits(text);
}
function getCharCountThreshold() {
  const v = parseInt(cueListCharcountThresholdInput?.value, 10);
  return Number.isFinite(v) && v > 0 ? v : EDITOR_SETTINGS.cueListCharcountThreshold;
}
function applyCharCount(cntEl, text, mode = null) {
  if (!cntEl) return;
  const w = calcCharWidth(text, mode);
  cntEl.textContent = Number.isInteger(w) ? String(w) : w.toFixed(1);
  cntEl.classList.toggle('over', w > getCharCountThreshold());
}

function splitCueVisibilityKey(kind, segment, trackId = null) {
  const id = segment?.id;
  if (!id) return null;
  return kind === 'extension'
    ? `extension:${trackId || ''}:${id}`
    : `main:${id}`;
}

function temporaryVisibleSplitCueKeysForElement(element) {
  if (!element) return [];
  const keys = [];
  const mainIndex = element.dataset.mainIdx != null
    ? Number(element.dataset.mainIdx)
    : (element.dataset.idx != null ? Number(element.dataset.idx) : -1);
  const extensionIndex = element.dataset.extIdx != null ? Number(element.dataset.extIdx) : -1;
  if (Number.isInteger(mainIndex) && mainIndex >= 0) {
    const key = splitCueVisibilityKey('main', DATA.segments[mainIndex]);
    if (key) keys.push(key);
  }
  const extensionTrack = getActiveExtensionTrack();
  if (Number.isInteger(extensionIndex) && extensionIndex >= 0 && extensionTrack) {
    const key = splitCueVisibilityKey(
      'extension', extensionTrack.segments[extensionIndex], extensionTrack.id,
    );
    if (key) keys.push(key);
  }
  return keys;
}

function cueElementHasTemporarySplitVisibility(element) {
  return temporaryVisibleSplitCueKeysForElement(element)
    .some((key) => temporaryVisibleSplitCueKeys.has(key));
}

function clearTemporaryVisibleSplitCues() {
  temporaryVisibleSplitCueKeys.clear();
}

function rememberTemporaryVisibleSplitCues({
  mainSegments = [],
  extensionSegments = [],
  extensionTrackId = null,
} = {}) {
  if (!EDITOR_SETTINGS.cueListKeepSplitVisible) return;
  if (!document.getElementById('filter-over')?.classList.contains('active')) return;
  mainSegments.forEach((segment) => {
    const key = splitCueVisibilityKey('main', segment);
    if (key) temporaryVisibleSplitCueKeys.add(key);
  });
  extensionSegments.forEach((segment) => {
    const key = splitCueVisibilityKey('extension', segment, extensionTrackId);
    if (key) temporaryVisibleSplitCueKeys.add(key);
  });
}

function releaseTemporaryVisibleSplitCuesUnless(kind, index, track = null) {
  if (!temporaryVisibleSplitCueKeys.size) return;
  const segments = kind === 'extension'
    ? (track?.segments || getActiveExtensionTrack()?.segments || [])
    : DATA.segments;
  const segment = segments[index];
  const key = splitCueVisibilityKey(kind, segment, kind === 'extension' ? track?.id : null);
  if (key && temporaryVisibleSplitCueKeys.has(key)) return;
  clearTemporaryVisibleSplitCues();
  applySearch(searchEl.value);
}

function refreshAllCharCounts() {
  const extensionTrack = getActiveExtensionTrack();
  container.querySelectorAll(':scope > .cue').forEach(el => {
    const idx = Number.parseInt(el.dataset.idx, 10);
    const extensionIdx = Number.parseInt(el.dataset.extIdx, 10);
    const cntEl = el.querySelector('.charcount');
    const segment = Number.isInteger(extensionIdx) && extensionTrack
      ? extensionTrack.segments[extensionIdx]
      : (Number.isInteger(idx) ? DATA.segments[idx] : null);
    const mode = Number.isInteger(extensionIdx) && extensionTrack
      ? getExtensionSubtitleSplitMode(extensionTrack, segment)
      : getMainSubtitleSplitMode(segment);
    if (cntEl && segment) applyCharCount(cntEl, segment.text, mode);
  });
}

// === 搜索 ===
function applySearch(query, { refreshText = true } = {}) {
  const trimmed = query.trim();
  let visible = 0;
  const re = buildSearchRegex(trimmed, false);
  const filterOver = document.getElementById('filter-over').classList.contains('active');
  const threshold = getCharCountThreshold();
  const extensionTrack = getActiveExtensionTrack();
  // 容器内还有布局拖拽栏和“加载工程后显示字幕列表”占位层；过滤只作用于真实字幕行。
  const cueElements = container.querySelectorAll(':scope > .cue');
  cueElements.forEach(el => {
    const mainIdx = el.dataset.mainIdx != null
      ? Number(el.dataset.mainIdx)
      : (el.dataset.idx != null ? Number(el.dataset.idx) : -1);
    const extIdx = el.dataset.extIdx != null ? Number(el.dataset.extIdx) : -1;
    const mainSeg = Number.isInteger(mainIdx) && mainIdx >= 0 ? DATA.segments[mainIdx] : null;
    const extensionSeg = Number.isInteger(extIdx) && extIdx >= 0 && extensionTrack
      ? extensionTrack.segments[extIdx] : null;
    const searchableText = [mainSeg?.text, extensionSeg?.text].filter(Boolean).join('\n');
    if (!searchableText) {
      el.classList.add('hidden');
      return;
    }
    let matched = !re || re.test(searchableText);
    if (re) re.lastIndex = 0;
    const keepTemporaryVisible = filterOver
      && EDITOR_SETTINGS.cueListKeepSplitVisible
      && cueElementHasTemporarySplitVisibility(el);
    if (matched && filterOver && !keepTemporaryVisible) {
      const count = (mainSeg ? calcCharWidth(mainSeg.text, getMainSubtitleSplitMode(mainSeg)) : 0)
        + (extensionSeg
          ? calcCharWidth(extensionSeg.text, getExtensionSubtitleSplitMode(extensionTrack, extensionSeg))
          : 0);
      matched = count > threshold;
    }
    el.classList.toggle('hidden', !matched);
    if (matched) visible++;
    if (refreshText && !el.classList.contains('editing')) {
      const mainTextEl = el.querySelector('.multi-cue-column.main .text');
      const extensionTextEl = el.querySelector('.multi-cue-column.extension .text');
      if (mainTextEl && mainSeg) setTextHtml(mainTextEl, mainSeg.text, trimmed);
      if (extensionTextEl && extensionSeg) setTextHtml(extensionTextEl, extensionSeg.text, trimmed);
      if (!mainTextEl && !extensionTextEl) {
        const textEl = el.querySelector('.text');
        if (textEl) setTextHtml(textEl, searchableText, trimmed);
      }
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
let extensionEditingState = null;

function startExtensionEdit(
  el,
  index,
  track = getActiveExtensionTrack(),
  clickX,
  clickY,
  { deferCaret = false } = {},
) {
  if (!el || !track?.segments?.[index]) return;
  hideCueSplitPreview();
  if (editingState) finishEdit(true);
  if (extensionEditingState) finishExtensionEdit(true);
  setCurrentCuePanelExtensionIndex(index, track);
  const textEl = el.querySelector('.text') || el;
  const segment = track.segments[index];
  let caretCharOffset = null;
  if (typeof clickX === 'number' && typeof clickY === 'number') {
    caretCharOffset = caretCharFromPoint(textEl, clickX, clickY);
  }
  extensionEditingState = {
    el, index, trackId: track.id, textEl, original: segment.text || '', caretCharOffset,
  };
  el.classList.add('editing');
  textEl.setAttribute('contenteditable', 'plaintext-only');
  textEl.innerText = segment.text || '';
  textEl.focus();
  const applyCaret = () => {
    if (!extensionEditingState || extensionEditingState.el !== el) return;
    const selection = window.getSelection();
    selection.removeAllRanges();
    if (caretCharOffset !== null && textEl.firstChild) {
      const range = document.createRange();
      const node = textEl.firstChild;
      const pos = Math.max(0, Math.min(caretCharOffset, node.textContent.length));
      range.setStart(node, pos);
      range.setEnd(node, pos);
      selection.addRange(range);
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(textEl);
    selection.addRange(range);
  };
  applyCaret();
  if (deferCaret) setTimeout(applyCaret, 0);
}

function syncCuePanelAfterInlineEdit(kind, index, trackId = null) {
  const target = getCurrentCuePanelTarget();
  if (!target || target.kind !== kind || target.index !== index) return;
  if (kind === 'extension' && target.trackId !== trackId) return;
  if (cuePanelText && document.activeElement !== cuePanelText) {
    cuePanelText.value = target.segment?.text || '';
  }
}

function finishExtensionEdit(save) {
  if (!extensionEditingState) return;
  const { el, index, trackId, textEl, original } = extensionEditingState;
  const track = getExtensionTrack(trackId);
  const segment = track?.segments?.[index];
  textEl.removeAttribute('contenteditable');
  el.classList.remove('editing');
  if (segment && save) {
    const nextText = textEl.innerText.replace(/\r\n?/g, '\n').trimEnd();
    if (nextText !== original) {
      pushUndo('编辑扩展字幕');
      segment.text = nextText;
      segment._dirty = true;
      markMultiSubtitleDirty();
      scheduleAutoSaveFlush();
    }
  }
  if (segment) {
    setTextHtml(textEl, segment.text || '', searchEl.value);
    applyCharCount(
      el.querySelector('.charcount'),
      segment.text || '',
      getExtensionSubtitleSplitMode(track, segment),
    );
  }
  waveformEditor?.refreshExtensionCueLabel(index, trackId);
  syncCuePanelAfterInlineEdit('extension', index, trackId);
  extensionEditingState = null;
  refreshSubtitlePreview();
}

function bindExtensionCueEvents(el, index, track = getActiveExtensionTrack(), dualRow = null) {
  if (!el || !track?.segments?.[index]) return;
  let pointerDown = null;
  el.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || (extensionEditingState?.el === el)) return;
    event.stopPropagation();
    if (event.altKey) {
      event.preventDefault();
      toggleDisabled([index], track);
      pointerDown = null;
      return;
    }
    pointerDown = { x: event.clientX, y: event.clientY };
    if (event.shiftKey && lastClickedExtensionIdx >= 0) selectExtensionRange(lastClickedExtensionIdx, index);
    else if (event.ctrlKey || event.metaKey) toggleExtensionSelection(index);
    else selectOnlyExtension(index);
    lastClickedExtensionIdx = index;
  });
  el.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!pointerDown) return;
    pointerDown = null;
    const segment = track.segments[index];
    const previousSuppress = suppressCueListAutoScroll;
    // 副字幕点击后 seek 会同步刷新主字幕 active 状态；这次刷新不能把
    // 列表从刚点击的副字幕行再次滚到对应的主字幕行。
    suppressCueListAutoScroll = true;
    try {
      waveformEditor?.revealTime(segment.start, true);
      if (EDITOR_SETTINGS.clickBehavior !== 'select-only') seekFromWaveform(segment.start / 1000);
    } finally {
      suppressCueListAutoScroll = previousSuppress;
    }
    if (EDITOR_SETTINGS.cueListAutoScrollOnClick) {
      const currentRow = container.querySelector(
        `.multi-dual-cue[data-ext-idx="${index}"], .multi-extension-cue[data-ext-idx="${index}"]`,
      );
      scrollCueToCenter(currentRow || dualRow || el);
    }
  });
  el.addEventListener('pointermove', (event) => {
    event.stopPropagation();
    if (extensionEditingState?.el === el) {
      hideCueSplitPreview();
      return;
    }
    cueListPointer = {
      kind: 'extension',
      idx: index,
      trackId: track.id,
      x: event.clientX,
      y: event.clientY,
    };
    scheduleCueSplitPreview(index, event.clientX, event.clientY, 'extension', track.id);
  });
  el.addEventListener('pointerleave', () => {
    if (cueListPointer?.kind === 'extension'
        && cueListPointer.idx === index
        && cueListPointer.trackId === track.id) {
      cueListPointer = null;
      hideCueSplitPreview();
    }
  });
  el.addEventListener('dblclick', (event) => {
    event.preventDefault();
    event.stopPropagation();
    startExtensionEdit(el, index, track, event.clientX, event.clientY, { deferCaret: true });
  });
  el.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    showExtensionContextMenu(event.clientX, event.clientY, index, null, track);
  });
}

function startEdit(el, idx, clickX, clickY, { deferCaret = false } = {}) {
  if (editingState) finishEdit(true);
  hideCueSplitPreview();
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

function caretOffsetInText(textEl) {
  if (!textEl) return null;
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!textEl.contains(range.startContainer) && range.startContainer !== textEl) return null;
  const preRange = range.cloneRange();
  preRange.selectNodeContents(textEl);
  preRange.setEnd(range.startContainer, range.startOffset);
  return preRange.toString().length;
}

function caretInfoFromPoint(root, x, y) {
  if (!root) return null;
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
  return { offset: pre.toString().length, rect: range.getBoundingClientRect() };
}

function caretCharFromPoint(root, x, y) {
  return caretInfoFromPoint(root, x, y)?.offset ?? null;
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
      scheduleAutoSaveFlush();
    }
  }
  setTextHtml(textEl, DATA.segments[idx].text, searchEl.value);
  const cntEl = el.querySelector('.charcount');
  if (cntEl) applyCharCount(
    cntEl, DATA.segments[idx].text, getMainSubtitleSplitMode(DATA.segments[idx]),
  );
  waveformEditor?.refreshCueLabel(idx);
  syncCuePanelAfterInlineEdit('main', idx);
  editingState = null;
  refreshSubtitlePreview();
}

// === 拆分 ===
let pendingLinkedSplit = null;

function splitTimeForTextOffset(segment, offset) {
  const timing = splitItemsAtChar(segment, offset);
  if (Number.isFinite(timing.splitMs)) return timing.splitMs;
  const text = String(segment?.text || '');
  const safeOffset = Math.max(0, Math.min(text.length, Number(offset) || 0));
  return Number(segment?.start)
    + ((Number(segment?.end) - Number(segment?.start)) * safeOffset) / Math.max(1, text.length);
}

function shouldUseMainSplitTimestamps(segment) {
  return EDITOR_SETTINGS.splitUseWordTimestamps
    && MULTI_SUBTITLE_UTILS.hasUsableSplitTimestamps(segment);
}

function notifyMainSplitTimestampFallback(segment) {
  if (!EDITOR_SETTINGS.splitUseWordTimestamps
      || MULTI_SUBTITLE_UTILS.hasUsableSplitTimestamps(segment)) return;
  const message = '已勾选“主字幕自动使用时间码拆分”，但当前主字幕没有可用的字词时间码，本次设置不生效，已改用拆分面板。';
  flashHint(window.MAWE_I18N?.translateText?.(message) || message, 'warning');
}

function splitOffsetNearTime(segment, timeMs, splitMode) {
  const legalOffsets = MULTI_SUBTITLE_UTILS.subtitleSplitOffsets(segment?.text || '', splitMode);
  if (!legalOffsets.length) return null;
  const timestampOffset = MULTI_SUBTITLE_UTILS.hasUsableSplitTimestamps(segment)
    ? window.AsrEditorUtils.splitCharOffsetAtTime(segment, timeMs)
    : null;
  if (Number.isInteger(timestampOffset)) {
    return legalOffsets.reduce((best, candidate) => (
      Math.abs(candidate - timestampOffset) < Math.abs(best - timestampOffset) ? candidate : best
    ), legalOffsets[0]);
  }
  return MULTI_SUBTITLE_UTILS.nearestSubtitleSplitOffset(
    segment.text, timeMs, segment.start, segment.end, splitMode,
  );
}

function splitOffsetNearTextPosition(text, offset, splitMode) {
  const legalOffsets = MULTI_SUBTITLE_UTILS.subtitleSplitOffsets(text || '', splitMode);
  if (!legalOffsets.length) return null;
  const requested = Math.max(0, Math.min(String(text || '').length, Math.round(Number(offset) || 0)));
  return legalOffsets.reduce((best, candidate) => (
    Math.abs(candidate - requested) < Math.abs(best - requested) ? candidate : best
  ), legalOffsets[0]);
}

function cleanSplitItems(items, side) {
  const source = Array.isArray(items) ? items : [];
  return source
    .map((item) => ({ ...item, text: String(item?.text || '') }))
    .map((item, index, list) => ({
      ...item,
      text: side === 'left' && index === list.length - 1
        ? item.text.replace(/[，。,.!?！？；;：:\s]+$/u, '')
        : side === 'right' && index === 0
          ? item.text.replace(/^[，。,.!?！？；;：:\s]+/u, '')
          : item.text,
    }))
    .filter((item) => item.text && Number.isFinite(item.start)
      && Number.isFinite(item.end) && item.end > item.start);
}

function forceSplitCutForSegments(segments, requestedCutMs) {
  const ranges = (Array.isArray(segments) ? segments : [segments])
    .map((segment) => ({
      start: Number(segment?.start),
      end: Number(segment?.end),
    }))
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end));
  if (!ranges.length || ranges.some((range) => range.end - range.start < SUBTITLE_MIN_DURATION_MS * 2)) {
    return null;
  }
  const lower = Math.max(...ranges.map((range) => range.start + SUBTITLE_MIN_DURATION_MS));
  const upper = Math.min(...ranges.map((range) => range.end - SUBTITLE_MIN_DURATION_MS));
  if (lower > upper) return null;
  const requested = Number(requestedCutMs);
  const cut = Number.isFinite(requested) ? Math.round(requested) : lower;
  return Math.min(upper, Math.max(lower, cut));
}

function forcedSplitRetryHint() {
  return '当前切点会产生不足 100ms 的一侧；请再次按 B 或 Enter 强制拆分，切点将调整为两侧各至少 100ms';
}

function armForcedSplit(state) {
  if (!state) return false;
  if (!Number.isFinite(state.forceCutMs)) {
    flashHint('字幕总时长不足 200ms，无法让拆分后的两侧都达到 100ms', 'warning');
    return false;
  }
  if (state.forceSplitArmed) return true;
  state.forceSplitArmed = true;
  flashHint(forcedSplitRetryHint(), 'warning');
  return false;
}

function splitItemsAtChar(
  segment,
  cursorChar,
  requestedCutMs = null,
  { preserveCutMs = false, forceCut = false } = {},
) {
  const text = String(segment?.text || '');
  const safeOffset = Math.max(0, Math.min(text.length, Math.round(Number(cursorChar) || 0)));
  const segmentStart = Number(segment?.start);
  const segmentEnd = Number(segment?.end);
  const safeSegmentStart = Number.isFinite(segmentStart) ? segmentStart : 0;
  const safeSegmentEnd = Number.isFinite(segmentEnd) && segmentEnd >= safeSegmentStart
    ? segmentEnd : safeSegmentStart;
  const items = Array.isArray(segment?.items) ? segment.items : [];
  const hasItems = items.some((item) => String(item?.text || ''));

  // 用原文查找 item 文本，处理 item 不包含词间空格的常见工程格式。
  // 如果上游 item 文本无法和字幕原文对齐，则退回旧的顺序长度映射，
  // 但后面的时间钳制和副本分组仍然保持一致。
  let searchFrom = 0;
  let aligned = true;
  const records = [];
  for (const item of items) {
    const itemText = String(item?.text || '');
    if (!itemText) continue;
    const textStart = text.indexOf(itemText, searchFrom);
    if (textStart < 0) {
      aligned = false;
      break;
    }
    records.push({ item, textStart, textEnd: textStart + itemText.length, itemText });
    searchFrom = textStart + itemText.length;
  }
  if (!aligned) {
    records.length = 0;
    let textStart = 0;
    for (const item of items) {
      const itemText = String(item?.text || '');
      if (!itemText) continue;
      records.push({ item, textStart, textEnd: textStart + itemText.length, itemText });
      textStart += itemText.length;
    }
  }

  const timeRangeFor = (item) => {
    const rawStart = Number(item?.start);
    const rawEnd = Number(item?.end);
    const start = Math.max(
      safeSegmentStart,
      Number.isFinite(rawStart) ? rawStart : safeSegmentStart,
    );
    const end = Math.min(
      safeSegmentEnd,
      Number.isFinite(rawEnd) ? rawEnd : safeSegmentEnd,
    );
    if (end > start) return { start, end };
    // item 时间完全落在段范围之外（上游工程的病态时间码）：钳制后区间
    // 倒置。丢弃会让词文本从 items 里消失，这里压到越界最近一侧的
    // 最小可表达区间，保留词数据；分配循环仍按文本对齐决定归属侧。
    return Number.isFinite(rawStart) && rawStart >= safeSegmentEnd
      ? { start: Math.max(safeSegmentStart, safeSegmentEnd - 1), end: safeSegmentEnd }
      : { start: safeSegmentStart, end: Math.min(safeSegmentEnd, safeSegmentStart + 1) };
  };
  const previous = [...records].reverse().find((record) => record.textEnd <= safeOffset);
  const next = records.find((record) => record.textStart >= safeOffset);
  const inside = records.find((record) => (
    safeOffset > record.textStart && safeOffset < record.textEnd
  ));
  const requested = Number(requestedCutMs);
  let splitMs = Number.isFinite(requested) ? Math.round(requested) : null;

  if (inside) {
    const range = timeRangeFor(inside.item);
    const fraction = (safeOffset - inside.textStart) / Math.max(1, inside.textEnd - inside.textStart);
    const interpolated = Math.round(range.start + (range.end - range.start) * fraction);
    if (!preserveCutMs || !Number.isFinite(splitMs)
        || (!forceCut && (splitMs < range.start || splitMs > range.end))) {
      splitMs = interpolated;
    }
  } else {
    if (!records.length && Number.isFinite(splitMs)) {
      splitMs = Math.round(splitMs);
    }
    // 文字切点在 item 边界或词间空白时，优先落在对应 item 的真实边界。
    // 这会把“模型”后的手工切点从 26526 吸附到“模型”的 end 26680，
    // 避免左字幕范围先于完整 item 结束。
    const previousRange = previous ? timeRangeFor(previous.item) : null;
    const nextRange = next ? timeRangeFor(next.item) : null;
    const lower = previousRange?.end ?? safeSegmentStart;
    const upper = nextRange?.start ?? safeSegmentEnd;
    if (records.length && (!preserveCutMs || !Number.isFinite(splitMs))) {
      splitMs = nextRange?.start ?? previousRange?.end ?? null;
    }
  }

  if (!Number.isFinite(splitMs)) {
    const ratio = safeOffset / Math.max(1, text.length);
    splitMs = Math.round(safeSegmentStart + (safeSegmentEnd - safeSegmentStart) * ratio);
  }
  splitMs = Math.max(safeSegmentStart, Math.min(safeSegmentEnd, Math.round(splitMs)));

  const leftItems = [];
  const rightItems = [];
  for (const record of records) {
    const range = timeRangeFor(record.item);
    if (range.end <= range.start) continue;
    const { itemText, textStart, textEnd } = record;
    if (inside === record) {
      const localOffset = Math.max(0, Math.min(itemText.length, safeOffset - textStart));
      const leftText = itemText.slice(0, localOffset);
      const rightText = itemText.slice(localOffset);
      const itemSplitMs = preserveCutMs
        && (forceCut || (splitMs >= range.start && splitMs <= range.end))
        ? splitMs
        : Math.round(range.start + (range.end - range.start)
          * localOffset / Math.max(1, itemText.length));
      if (leftText && rightText && itemSplitMs > range.start && itemSplitMs < range.end) {
        leftItems.push({ ...record.item, text: leftText, start: range.start, end: itemSplitMs });
        rightItems.push({ ...record.item, text: rightText, start: itemSplitMs, end: range.end });
      } else if (leftText && rightText) {
        // 取整后不足以给两侧各留出一个毫秒时，保留完整 item 到更接近
        // 光标的一侧，避免为了制造 0 长 item 而丢失词文本。
        const keepLeft = splitMs >= range.end || localOffset >= itemText.length / 2;
        if (keepLeft) {
          leftItems.push({ ...record.item, text: itemText, start: range.start, end: range.end });
        } else {
          rightItems.push({ ...record.item, text: itemText, start: range.start, end: range.end });
        }
      } else if (leftText && itemSplitMs > range.start) {
        leftItems.push({ ...record.item, text: leftText, start: range.start, end: itemSplitMs });
      } else if (rightText && range.end > itemSplitMs) {
        rightItems.push({ ...record.item, text: rightText, start: itemSplitMs, end: range.end });
      }
      continue;
    }
    if (textEnd <= safeOffset) {
      const end = Math.min(range.end, splitMs);
      if (end > range.start) leftItems.push({ ...record.item, start: range.start, end });
    } else if (textStart >= safeOffset) {
      const start = Math.max(range.start, splitMs);
      if (range.end > start) rightItems.push({ ...record.item, start, end: range.end });
    } else if (splitMs >= range.start && splitMs <= range.end) {
      // 退回顺序映射或异常 item 文本对齐时，仍不得让 item 穿过字幕边界。
      const end = Math.min(range.end, splitMs);
      if (end > range.start) leftItems.push({ ...record.item, start: range.start, end });
    }
  }
  // 病态时间码被钳制到段尾/段头时，可能与相邻 item 挤占同一毫秒槽。
  // 从后往前把前一项的 end 压到后一项的 start，保证 items 递增不重叠；
  // 压到 0 长度的极端病态保留原样，交由保存前的校验暴露问题。
  for (const items of [leftItems, rightItems]) {
    for (let i = items.length - 1; i > 0; i--) {
      if (items[i - 1].end > items[i].start && items[i - 1].start < items[i].start) {
        items[i - 1].end = items[i].start;
      }
    }
  }
  return { leftItems, rightItems, splitMs, hasItems };
}

function buildSplitPair(
  segment,
  offset,
  cutMs,
  idBase,
  includeItems = true,
  splitMode = null,
  { preserveCutMs = false, forceCut = false } = {},
) {
  const text = String(segment?.text || '');
  const mode = MULTI_SUBTITLE_UTILS.MULTI_SUBTITLE_SPLIT_MODES.has(splitMode)
    ? splitMode : MULTI_SUBTITLE_UTILS.detectSubtitleSplitMode(text);
  const parts = MULTI_SUBTITLE_UTILS.splitSubtitleText(text, offset, mode);
  if (!parts) return null;
  const itemParts = splitItemsAtChar(
    includeItems ? segment : { ...segment, items: [] },
    parts.offset,
    cutMs,
    { preserveCutMs, forceCut },
  );
  const leftItems = cleanSplitItems(itemParts.leftItems, 'left');
  const rightItems = cleanSplitItems(itemParts.rightItems, 'right');
  const splitMs = Number.isFinite(itemParts.splitMs) ? itemParts.splitMs : Math.round(cutMs);
  const segmentStart = Number(segment?.start);
  const segmentEnd = Number(segment?.end);
  if (!Number.isFinite(splitMs)
      || !Number.isFinite(segmentStart)
      || !Number.isFinite(segmentEnd)
      || segmentEnd - segmentStart < SUBTITLE_MIN_DURATION_MS * 2
      || splitMs - segmentStart < SUBTITLE_MIN_DURATION_MS
      || segmentEnd - splitMs < SUBTITLE_MIN_DURATION_MS) return null;
  const left = {
    ...segment,
    id: MULTI_SUBTITLE_UTILS.uniqueStableSegmentId([segment], `${idBase}-a`, 'segment'),
    start: segment.start,
    end: splitMs,
    text: parts.left,
    items: leftItems.length ? leftItems : null,
    _dirty: true,
  };
  const right = {
    ...segment,
    id: MULTI_SUBTITLE_UTILS.uniqueStableSegmentId([segment, left], `${idBase}-b`, 'segment'),
    start: splitMs,
    end: segment.end,
    text: parts.right,
    items: rightItems.length ? rightItems : null,
    _dirty: true,
  };
  if (segment.sticker) {
    right.sticker = null;
    right.sticker_ref = { name: segment.sticker.name, headIdx: 0 };
  }
  if (segment.color) {
    right.color = null;
    right.color_ref = { name: segment.color.name, headIdx: 0 };
  }
  return { left, right, parts, splitMs };
}

 function linkedSplitState(mainIndex, initial = {}) {
  const main = DATA.segments[mainIndex];
  const binding = bindingForMainIndex(mainIndex);
  const track = binding ? getExtensionTrack(binding.track_id) : null;
  const extension = binding ? extensionSegmentById(binding.extension_segment_ids?.[0], track) : null;
  if (!main || !binding || !track || !extension) return null;
  // 联动拆分要求主副两侧在共同切点的两边各保留最小时长。副字幕总时长不足、
  // 或两段重叠区间放不下合法切点时，不再直接拒绝：弹窗内会走「只拆主字幕并
  // 解除绑定」的降级路径（仅在主字幕自身可拆时启用）；只有主字幕总时长不足
  // （降级也无从谈起）才提前给出原因。
  const linkedMinSpanMs = SUBTITLE_MIN_DURATION_MS * 2;
  if (main.end - main.start < linkedMinSpanMs) {
    flashHint('主字幕总时长不足 200ms，无法联动拆分', 'warning');
    return null;
  }
  const mainMode = getMainSubtitleSplitMode(main);
  const extensionMode = getExtensionSubtitleSplitMode(track, extension);
  const hasMainWordTimestamps = MULTI_SUBTITLE_UTILS.hasUsableSplitTimestamps(main);
  const initialTime = Number.isFinite(initial.timeMs)
    ? initial.timeMs
    : splitTimeForTextOffset(main, initial.mainOffset ?? Math.floor(String(main.text || '').length / 2));
  const useMainWordTimestamps = shouldUseMainSplitTimestamps(main);
  // 关闭自动时间码拆分后，波形入口传入的时间仍是绝对切点；没有波形指针时，
  // 有可用时间码就把初始断点定位到最近的字词边界，但之后仍允许用户自由调整。
  const fixedCutMs = !useMainWordTimestamps && Number.isFinite(initial.timeMs)
    ? Math.round(initial.timeMs) : null;
  // 字幕列表传入的是用户实际指向的文字位置；即使工程有字词时间码，
  // 也不能再用时间反推一次文字位置，否则「就是｜这颗」可能漂移成「就是这｜颗」。
  // 没有列表文字位置时（例如波形/播放头入口）才按时间寻找最近合法断点。
  const hasInitialTextPosition = Number.isFinite(initial.mainOffset);
  const initialMainOffset = hasInitialTextPosition
    ? splitOffsetNearTextPosition(main.text, initial.mainOffset, mainMode)
    : splitOffsetNearTime(main, initialTime, mainMode);
  const initialMainCutMs = fixedCutMs ?? (hasMainWordTimestamps
    ? splitTimeForTextOffset(main, initialMainOffset)
    : splitCutTime(main, initialMainOffset, false));
  const initialOffset = MULTI_SUBTITLE_UTILS.nearestSubtitleSplitOffset(
    extension.text, initialMainCutMs, extension.start, extension.end, extensionMode,
  );
  return {
    kind: 'linked',
    mainIndex,
    mainId: main.id,
    extensionId: extension.id,
    trackId: track.id,
    mainMode,
    mainInteractive: !useMainWordTimestamps,
    mainTimestampLocked: useMainWordTimestamps,
    mainOffset: initialMainOffset,
    mainCutMs: initialMainCutMs,
    offset: initialOffset,
    // 联动拆分只有一个绝对切点；拓展轨的 offset 只负责选择文字边界。
    cutMs: initialMainCutMs,
    extensionCutMs: initialMainCutMs,
    extensionMode,
    fixedCutMs,
    feedbackPoint: initial.feedbackPoint || null,
    // 列表/编辑区唤起的弹窗提交后，刀光保留在列表原位置而不是波形切点。
    ninjaFromList: initial.ninjaFromList === true,
    cutSource: fixedCutMs != null
      ? 'pointer'
      : useMainWordTimestamps
        ? 'word-timestamps'
        : hasMainWordTimestamps ? 'word-timestamps-default' : 'text-estimate',
    initialLane: hasInitialTextPosition ? 'main' : null,
    locked: false,
  };
}

function mainWaveformSplitState(mainIndex, initial = {}) {
  const main = DATA.segments[mainIndex];
  if (!main) return null;
  const mainMode = getMainSubtitleSplitMode(main);
  const hasMainWordTimestamps = MULTI_SUBTITLE_UTILS.hasUsableSplitTimestamps(main);
  const initialTime = Number.isFinite(initial.timeMs)
    ? initial.timeMs
    : splitTimeForTextOffset(main, initial.mainOffset ?? Math.floor(String(main.text || '').length / 2));
  const fixedCutMs = Number.isFinite(initial.timeMs) ? Math.round(initial.timeMs) : null;
  const initialOffset = splitOffsetNearTime(main, initialTime, mainMode);
  if (initialOffset == null) return null;
  return {
    kind: 'main',
    mainIndex,
    mainId: main.id,
    offset: initialOffset,
    mainOffset: initialOffset,
    mainCutMs: fixedCutMs ?? (hasMainWordTimestamps
      ? splitTimeForTextOffset(main, initialOffset)
      : splitCutTime(main, initialOffset, false)),
    feedbackPoint: initial.feedbackPoint || null,
    mainMode,
    fixedCutMs,
    cutSource: fixedCutMs != null
      ? 'pointer'
      : hasMainWordTimestamps ? 'word-timestamps-default' : 'text-estimate',
    locked: false,
  };
}

function extensionOnlySplitState(extensionIndex, track, initial = {}) {
  const extension = track?.segments?.[extensionIndex];
  if (!extension || !track) return null;
  // 副字幕独立拆分同样要求总时长能容纳两侧各 100ms；不足时提交必然失败，
  // 直接提示原因，不再打开只会静默失败的弹窗。
  if (extension.end - extension.start < SUBTITLE_MIN_DURATION_MS * 2) {
    flashHint('副字幕总时长不足 200ms，无法拆分', 'warning');
    return null;
  }
  const extensionMode = getExtensionSubtitleSplitMode(track, extension);
  const hasInitialTextPosition = Number.isFinite(initial.extensionOffset);
  const initialTime = Number.isFinite(initial.timeMs)
    ? initial.timeMs
    : splitTimeForTextOffset(extension, initial.extensionOffset ?? Math.floor(String(extension.text || '').length / 2));
  const fixedCutMs = Number.isFinite(initial.timeMs) ? Math.round(initial.timeMs) : null;
  const initialOffset = hasInitialTextPosition
    ? splitOffsetNearTextPosition(extension.text, initial.extensionOffset, extensionMode)
    : MULTI_SUBTITLE_UTILS.nearestSubtitleSplitOffset(
      extension.text, initialTime, extension.start, extension.end, extensionMode,
    );
  if (!Number.isInteger(initialOffset)) return null;
  return {
    kind: 'extension',
    mainIndex: -1,
    extensionIndex,
    extensionId: extension.id,
    trackId: track.id,
    offset: initialOffset,
    extensionCutMs: fixedCutMs ?? splitTimeForTextOffset(extension, initialOffset),
    feedbackPoint: initial.feedbackPoint || null,
    // 列表/编辑区唤起的弹窗提交后，刀光保留在列表原位置而不是波形切点。
    ninjaFromList: initial.ninjaFromList === true,
    extensionMode,
    fixedCutMs,
    cutSource: fixedCutMs != null ? 'pointer' : 'text-estimate',
    locked: false,
  };
}

function splitLaneElements(lane) {
  return lane === 'main'
    ? { laneEl: multiSubtitleSplitMainLane, textEl: multiSubtitleSplitMainText }
    : { laneEl: multiSubtitleSplitExtensionLane, textEl: multiSubtitleSplitText };
}

function splitLaneLocked(state, lane) {
  return state?.lockedLanes?.[lane] === true;
}

function splitLaneUsesMainTimestamp(state, lane) {
  return lane === 'main' && state?.kind === 'linked' && state.mainTimestampLocked === true;
}

// 键盘可交互：⌚️ 时间码锚定的主轨和已用 Space/点击锁定的 lane 不响应移动键。
function splitLaneKeyboardInteractive(state, lane) {
  return !splitLaneUsesMainTimestamp(state, lane) && !splitLaneLocked(state, lane);
}

function splitLaneSegment(state, lane) {
  if (lane === 'main') return state?.mainIndex >= 0 ? DATA.segments[state.mainIndex] : null;
  return extensionSegmentById(state?.extensionId, getExtensionTrack(state?.trackId));
}

// 左右移动：在当前 lane 的合法断点序列中前进/后退一步。
function stepSplitLaneOffset(state, lane, direction) {
  const segment = splitLaneSegment(state, lane);
  const mode = lane === 'main' ? state?.mainMode : state?.extensionMode;
  const current = lane === 'main' ? state?.mainOffset : state?.offset;
  const offsets = MULTI_SUBTITLE_UTILS.subtitleSplitOffsets(segment?.text || '', mode);
  if (!offsets.length) return null;
  if (direction < 0) {
    for (let index = offsets.length - 1; index >= 0; index -= 1) {
      if (offsets[index] < current) return offsets[index];
    }
    return null;
  }
  return offsets.find((offset) => offset > current) ?? null;
}

// 上下移动：按渲染后的视觉行定位。gap 元素样式一致，同一行的 top 相同；
// 行距约等于 line-height（36px），用远小于行距的容差聚类即可。
const SPLIT_LANE_LINE_TOLERANCE_PX = 10;

function splitLaneGapLines(textEl) {
  return Array.from(textEl.querySelectorAll('.multi-subtitle-split-gap'))
    .map((gap) => {
      const rect = gap.getBoundingClientRect();
      return { gap, midX: rect.left + rect.width / 2, midY: rect.top + rect.height / 2 };
    })
    .sort((left, right) => left.midY - right.midY || left.midX - right.midX)
    .reduce((lines, entry) => {
      const current = lines[lines.length - 1];
      if (current && Math.abs(entry.midY - current.midY) <= SPLIT_LANE_LINE_TOLERANCE_PX) {
        current.entries.push(entry);
        return lines;
      }
      lines.push({ midY: entry.midY, entries: [entry] });
      return lines;
    }, []);
}

// 上下移动：目标行上取与当前断点水平距离最近的 gap；单行或越界时返回 null。
function verticalSplitLaneOffset(state, lane, direction) {
  const { textEl } = splitLaneElements(lane);
  if (!textEl) return null;
  const lines = splitLaneGapLines(textEl);
  if (lines.length < 2) return null;
  const currentOffset = lane === 'main' ? state?.mainOffset : state?.offset;
  let anchor = lines.flatMap((line) => line.entries)
    .find((entry) => Number(entry.gap.dataset.offset) === currentOffset);
  if (!anchor) {
    // 当前断点没有 gap 元素（如文字开头）时退回字符锚点，用行中点估算所在行。
    const charRect = Array.from(textEl.querySelectorAll('.multi-subtitle-split-char'))
      .find((char) => Number(char.dataset.offset) === currentOffset)
      ?.getBoundingClientRect();
    if (!charRect) return null;
    const anchorMidY = charRect.top + charRect.height / 2;
    const nearestLine = lines.reduce((best, line) => (
      Math.abs(line.midY - anchorMidY) < Math.abs(best.midY - anchorMidY) ? line : best
    ), lines[0]);
    const target = lines[lines.indexOf(nearestLine) + direction];
    if (!target) return null;
    const anchorMidX = charRect.left + charRect.width / 2;
    const picked = target.entries.reduce((best, entry) => (
      Math.abs(entry.midX - anchorMidX) < Math.abs(best.midX - anchorMidX) ? entry : best
    ), target.entries[0]);
    return picked ? Number(picked.gap.dataset.offset) : null;
  }
  const target = lines[lines.findIndex(
    (line) => line.entries.includes(anchor),
  ) + direction];
  if (!target) return null;
  const picked = target.entries.reduce((best, entry) => (
    Math.abs(entry.midX - anchor.midX) < Math.abs(best.midX - anchor.midX) ? entry : best
  ), target.entries[0]);
  return picked ? Number(picked.gap.dataset.offset) : null;
}

// 键盘操作的 lane：优先看真实焦点，失焦（如点到复选框）时回退到上次记录。
function splitKeyboardActiveLane(state) {
  if (document.activeElement === multiSubtitleSplitMainText) return 'main';
  if (document.activeElement === multiSubtitleSplitText) return 'extension';
  return state?.keyboardLane || null;
}

function splitLaneVisible(lane) {
  const { laneEl } = splitLaneElements(lane);
  return Boolean(laneEl && !laneEl.hidden);
}

function focusSplitLane(state, lane) {
  const { textEl } = splitLaneElements(lane);
  if (!textEl || !splitLaneVisible(lane)) return false;
  textEl.focus({ preventScroll: true });
  if (state) state.keyboardLane = lane;
  return true;
}

// Tab 在主/副 lane 间切换：仅在联动模式且主轨可交互时可用。
function splitKeyboardSwitchLane(state, current) {
  if (state?.kind !== 'linked') return null;
  if (splitLaneUsesMainTimestamp(state, 'main')) return null;
  if (current === 'main') return 'extension';
  if (current === 'extension') return 'main';
  return 'main';
}

// Space 与鼠标点击同语义：锁定当前断点；再按一次解锁以便继续移动。
function toggleSplitLaneKeyboardLock(state, lane) {
  if (state !== pendingLinkedSplit || !state.lockedLanes) return;
  if (splitLaneUsesMainTimestamp(state, lane)) return;
  state.lockedLanes[lane] = !splitLaneLocked(state, lane);
  updateLinkedSplitLockVisual();
  if (!splitLaneLocked(state, lane)) return;
  const submitted = maybeAutoSubmitLinkedSplit(state);
  // 键盘锁定后自动聚焦下一条未锁定的 lane（若有），WASD/空格 可连续操作；
  // 自动提交已接管或弹窗已关闭（提交成功）时不再移动焦点。
  if (submitted || state !== pendingLinkedSplit) return;
  const nextLane = splitKeyboardSwitchLane(state, lane);
  if (nextLane && !splitLaneLocked(state, nextLane)) focusSplitLane(state, nextLane);
}

// 已锁定的 lane 上按移动键：闪烁边缘并提示先解锁再移动。
function flashSplitLaneBlockedFeedback(lane) {
  const { textEl } = splitLaneElements(lane);
  if (textEl) {
    textEl.classList.remove('lane-move-blocked');
    void textEl.offsetWidth; // 强制重排，让动画可以重新触发
    textEl.classList.add('lane-move-blocked');
    textEl.addEventListener('animationend', () => {
      textEl.classList.remove('lane-move-blocked');
    }, { once: true });
  }
  flashHint('请先按空格解除锁定，然后再进行移动', 'invalid');
}

function syncLinkedSplitTime(state, activeLane, main, extension) {
  if (state?.kind !== 'linked' || !main || !extension) return;

  // 默认的主轨字词时间码是固定锚点；关闭该设置后，未锁定的当前 lane
  // 才能推动共享切点。另一条 lane 的文字 offset 随共享时间吸附到最近合法边界。
  const absoluteFixed = Number.isFinite(state.fixedCutMs);
  const mainFixed = !state.mainInteractive || splitLaneLocked(state, 'main');
  const extensionFixed = splitLaneLocked(state, 'extension');
  let cutMs = state.cutMs;
  if (absoluteFixed) {
    cutMs = state.fixedCutMs;
  } else if (mainFixed) {
    cutMs = state.mainCutMs;
  } else if (extensionFixed) {
    cutMs = state.extensionCutMs;
  } else {
    const source = activeLane === 'main' ? main : extension;
    const sourceOffset = activeLane === 'main' ? state.mainOffset : state.offset;
    cutMs = activeLane === 'main'
      && MULTI_SUBTITLE_UTILS.hasUsableSplitTimestamps(main)
      ? splitTimeForTextOffset(main, sourceOffset)
      : splitCutTime(source, sourceOffset, false);
  }
  if (!Number.isFinite(cutMs)) return;

  const sharedCutMs = Math.round(cutMs);
  state.cutMs = sharedCutMs;
  state.mainCutMs = sharedCutMs;
  state.extensionCutMs = sharedCutMs;

  if (!absoluteFixed && activeLane === 'main' && !extensionFixed) {
    const extensionOffset = MULTI_SUBTITLE_UTILS.nearestSubtitleSplitOffset(
      extension.text, sharedCutMs, extension.start, extension.end, state.extensionMode,
    );
    if (Number.isInteger(extensionOffset)) state.offset = extensionOffset;
  } else if (!absoluteFixed && activeLane === 'extension' && !mainFixed) {
    const mainOffset = MULTI_SUBTITLE_UTILS.nearestSubtitleSplitOffset(
      main.text, sharedCutMs, main.start, main.end, state.mainMode,
    );
    if (Number.isInteger(mainOffset)) state.mainOffset = mainOffset;
  }
}

function splitCutTime(segment, offset, useWordTimestamps = false) {
  if (useWordTimestamps) return Math.round(splitTimeForTextOffset(segment, offset));
  const textLength = Math.max(1, String(segment?.text || '').length);
  return Math.round(Number(segment?.start || 0)
    + ((Number(segment?.end || 0) - Number(segment?.start || 0)) * Number(offset || 0)) / textLength);
}

function setSplitPreviewLine(label, parts) {
  const row = document.createElement('div');
  row.className = 'multi-subtitle-split-preview-line';
  const labelEl = document.createElement('span');
  labelEl.className = 'multi-subtitle-split-preview-label';
  labelEl.textContent = `${label}：`;
  const left = document.createElement('span');
  left.className = 'multi-subtitle-split-preview-left';
  left.textContent = parts.left;
  const separator = document.createElement('span');
  separator.className = 'multi-subtitle-split-preview-separator';
  separator.textContent = ' / ';
  const right = document.createElement('span');
  right.className = 'multi-subtitle-split-preview-right';
  right.textContent = parts.right;
  row.append(labelEl, left, separator, right);
  multiSubtitleSplitPreview.appendChild(row);
}

function updateSplitLaneVisual(state, lane) {
  const { textEl } = splitLaneElements(lane);
  if (!textEl) return;
  const offset = lane === 'main' ? state?.mainOffset : state?.offset;
  const timestampLocked = splitLaneUsesMainTimestamp(state, lane);
  textEl.classList.toggle('timestamp-locked', timestampLocked);
  textEl.querySelectorAll('.multi-subtitle-split-char').forEach((character) => {
    const charOffset = Number(character.dataset.offset || 0);
    character.classList.toggle('split-left', charOffset <= offset);
    character.classList.toggle('split-right', charOffset > offset);
  });
  textEl.querySelectorAll('.multi-subtitle-split-gap').forEach((gap) => {
    gap.classList.toggle('active', Number(gap.dataset.offset) === offset);
    gap.classList.toggle('timestamp-locked', timestampLocked);
  });
}

function renderSplitLane(state, lane) {
  const { laneEl, textEl } = splitLaneElements(lane);
  if (!laneEl || !textEl) return;
  const main = DATA.segments[state?.mainIndex];
  const track = getExtensionTrack(state?.trackId);
  const extension = extensionSegmentById(state?.extensionId, track);
  const isMain = lane === 'main';
  const displaySegment = isMain ? main : extension;
  const displayMode = isMain ? state?.mainMode : state?.extensionMode;
  const timestampLocked = splitLaneUsesMainTimestamp(state, lane);
  const heading = laneEl.querySelector('h4');
  if (heading) {
    const headingText = timestampLocked
      ? '⌚️ 主字幕按时间码会拆在这里'
      : isMain ? '主字幕拆分' : '副字幕拆分';
    heading.textContent = window.MAWE_I18N?.translateText?.(headingText) || headingText;
  }
  laneEl.classList.toggle('timestamp-locked-lane', timestampLocked);
  const visible = Boolean(displaySegment) && (isMain
    ? state?.kind === 'main' || state?.mainInteractive || timestampLocked
    : state?.kind !== 'main');
  laneEl.hidden = !visible;
  if (!visible) return;
  textEl.replaceChildren();
  textEl.classList.toggle('timestamp-locked', timestampLocked);
  const legalOffsets = new Set(MULTI_SUBTITLE_UTILS.subtitleSplitOffsets(displaySegment.text, displayMode));
  const characters = Array.from(displaySegment.text || '');
  let offset = 0;
  const appendCharacter = (character, characterOffset) => {
    const characterSpan = document.createElement('span');
    characterSpan.className = 'multi-subtitle-split-char';
    characterSpan.dataset.offset = String(characterOffset);
    characterSpan.textContent = character;
    textEl.appendChild(characterSpan);
  };
  const appendGap = (splitOffset, whitespace = '', extraClass = '') => {
    const gap = document.createElement('span');
    gap.className = 'multi-subtitle-split-gap';
    if (extraClass) gap.classList.add(extraClass);
    gap.dataset.offset = String(splitOffset);
    if (timestampLocked) {
      gap.setAttribute('aria-disabled', 'true');
    } else {
      gap.setAttribute('role', 'button');
      gap.setAttribute('aria-label', `在第 ${splitOffset} 个字符后拆分`);
    }
    // 保留原始空白；只有当前选中的断点通过 CSS 将这个空白替换成剪刀。
    gap.textContent = whitespace;
    textEl.appendChild(gap);
  };
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (/\s/u.test(character)) {
      let runEnd = index;
      let runOffset = offset + character.length;
      while (runEnd + 1 < characters.length && /\s/u.test(characters[runEnd + 1])) {
        runEnd += 1;
        runOffset += characters[runEnd].length;
      }
      if (legalOffsets.has(runOffset)) {
        appendGap(runOffset, characters.slice(index, runEnd + 1).join(''));
      }
      else {
        for (let whitespaceIndex = index; whitespaceIndex <= runEnd; whitespaceIndex += 1) {
          offset += characters[whitespaceIndex].length;
          appendCharacter(characters[whitespaceIndex], offset);
        }
      }
      if (legalOffsets.has(runOffset)) offset = runOffset;
      else offset = runOffset;
      index = runEnd;
      continue;
    }
    if (displayMode === 'word' && MULTI_SUBTITLE_UTILS.isWordSplitConnector(character)) {
      let runEnd = index;
      let runOffset = offset + character.length;
      while (
        runEnd + 1 < characters.length
        && MULTI_SUBTITLE_UTILS.isWordSplitConnector(characters[runEnd + 1])
      ) {
        runEnd += 1;
          runOffset += characters[runEnd].length;
      }
      if (!legalOffsets.has(offset) && !legalOffsets.has(runOffset)) {
        for (let connectorIndex = index; connectorIndex <= runEnd; connectorIndex += 1) {
          offset += characters[connectorIndex].length;
          appendCharacter(characters[connectorIndex], offset);
        }
      } else {
        // 符号本身是独立 token；前一个普通字符后的 gap 已由上方逻辑插入，
        // 这里保留符号，并在符号之后插入另一个零宽断点。
        for (let connectorIndex = index; connectorIndex <= runEnd; connectorIndex += 1) {
          offset += characters[connectorIndex].length;
          appendCharacter(characters[connectorIndex], offset);
        }
        if (legalOffsets.has(runOffset)) appendGap(runOffset, '', 'connector-gap');
      }
      offset = runOffset;
      index = runEnd;
      continue;
    }
    offset += character.length;
    appendCharacter(character, offset);
    if (legalOffsets.has(offset)) {
      const nextCharacter = characters[index + 1];
      const connectorGap = displayMode === 'word'
        && MULTI_SUBTITLE_UTILS.isWordSplitConnector(nextCharacter);
      appendGap(offset, '', connectorGap ? 'connector-gap' : '');
    }
  }
  if (timestampLocked) {
    textEl.setAttribute('aria-label', '主字幕按时间码拆分位置，不可交互');
    textEl.setAttribute('aria-readonly', 'true');
    textEl.setAttribute('aria-disabled', 'true');
    textEl.setAttribute('tabindex', '-1');
    textEl.title = '主字幕按时间码拆分于此处，不可交互';
    textEl.onmousemove = null;
    textEl.onclick = null;
  } else {
    textEl.removeAttribute('aria-readonly');
    textEl.removeAttribute('aria-disabled');
    textEl.setAttribute('tabindex', '0');
    textEl.setAttribute('aria-label', isMain ? '选择主字幕拆分点' : '选择副字幕断点');
    textEl.title = '鼠标移动选择拆分点，左键点击锁定；也可用 WASD/方向键移动，空格确认或取消';
    textEl.onmousemove = (event) => {
      if (splitLaneLocked(pendingLinkedSplit, lane)) return;
      const target = event.target;
      const gap = target?.closest?.('.multi-subtitle-split-gap');
      if (gap && textEl.contains(gap)) {
        updateLinkedSplitPreview(Number(gap.dataset.offset), lane);
        return;
      }
      const rawOffset = caretCharFromPoint(textEl, event.clientX, event.clientY);
      if (rawOffset != null) updateLinkedSplitPreview(rawOffset, lane);
    };
    textEl.onclick = (event) => {
      const current = pendingLinkedSplit;
      if (!current) return;
      if (splitLaneLocked(current, lane)) {
        current.lockedLanes[lane] = false;
        updateLinkedSplitLockVisual();
        return;
      }
      const target = event.target;
      const gap = target?.closest?.('.multi-subtitle-split-gap');
      const rawOffset = gap && textEl.contains(gap)
        ? Number(gap.dataset.offset)
        : caretCharFromPoint(textEl, event.clientX, event.clientY);
      if (rawOffset != null) updateLinkedSplitPreview(rawOffset, lane);
      current.lockedLanes[lane] = true;
      updateLinkedSplitLockVisual();
      maybeAutoSubmitLinkedSplit(current);
    };
  }
  updateSplitLaneVisual(state, lane);
}

function renderLinkedSplitText(state) {
  if (!state) return;
  state.lockedLanes = { main: false, extension: false };
  if (multiSubtitleSplitTimestampHint) {
    multiSubtitleSplitTimestampHint.hidden = state.mainTimestampLocked !== true;
  }
  if (multiSubtitleSplitTitle) {
    multiSubtitleSplitTitle.textContent = state.kind === 'main'
      ? '选择主字幕拆分点'
      : state.kind === 'extension'
        ? '选择副字幕拆分点'
        : state.mainInteractive
          ? '分别选择主字幕和副字幕拆分点'
          : '主字幕按时间码定位，选择副字幕拆分点';
  }
  renderSplitLane(state, 'main');
  renderSplitLane(state, 'extension');
  const initialLane = state.initialLane || (state.kind === 'main'
    ? 'main'
    : state.kind === 'extension'
      ? 'extension'
      : state.mainInteractive ? 'main' : 'extension');
  updateLinkedSplitPreview(
    state.kind === 'main' ? state.mainOffset
      : state.kind === 'extension' ? state.offset : state.mainOffset,
    initialLane,
  );
  // 弹窗打开即聚焦初始 lane，让 WASD/方向键/Space 直接可用；
  // ⌚️ 时间码锚定的主轨不可交互，回落到副轨。
  state.keyboardLane = splitLaneUsesMainTimestamp(state, initialLane) ? 'extension' : initialLane;
  focusSplitLane(state, state.keyboardLane);
}

function updateLinkedSplitLockVisual() {
  const state = pendingLinkedSplit;
  const mainLocked = splitLaneLocked(state, 'main');
  const extensionLocked = splitLaneLocked(state, 'extension');
  multiSubtitleSplitMainText?.classList.toggle('locked', mainLocked);
  multiSubtitleSplitText?.classList.toggle('locked', extensionLocked);
  [
    ['main', multiSubtitleSplitMainText],
    ['extension', multiSubtitleSplitText],
  ].forEach(([lane, textEl]) => {
    if (!textEl) return;
    const timestampLocked = splitLaneUsesMainTimestamp(state, lane);
    textEl.classList.toggle('locked', !timestampLocked && splitLaneLocked(state, lane));
    textEl.title = timestampLocked
      ? '主字幕按时间码拆分于此处，不可交互'
      : splitLaneLocked(state, lane)
        ? '拆分点已锁定，点击或按空格解锁'
        : '鼠标移动选择拆分点，左键点击锁定；也可用 WASD/方向键移动，空格确认或取消';
    textEl.querySelectorAll('.multi-subtitle-split-gap').forEach((gap) => {
      gap.classList.toggle(
        'locked',
        !timestampLocked && splitLaneLocked(state, lane) && gap.classList.contains('active'),
      );
    });
  });
  multiSubtitleSplitPreview?.classList.toggle('locked', mainLocked || extensionLocked);
}

function isSplitAutoSubmitEnabled() {
  return multiSubtitleSplitAutoSubmit
    ? multiSubtitleSplitAutoSubmit.checked
    : EDITOR_SETTINGS.splitAutoSubmit;
}

function splitAutoSubmitReady(state) {
  if (!state?.valid) return false;
  if (state.kind === 'main') return splitLaneLocked(state, 'main');
  if (state.kind === 'extension') return splitLaneLocked(state, 'extension');
  // 字词时间码已固定主轨切点时，主轨没有可交互的确认步骤。
  const mainReady = !state.mainInteractive || splitLaneLocked(state, 'main');
  return mainReady && splitLaneLocked(state, 'extension');
}

function maybeAutoSubmitLinkedSplit(state) {
  if (state !== pendingLinkedSplit || !isSplitAutoSubmitEnabled() || !splitAutoSubmitReady(state)) {
    return false;
  }
  confirmLinkedSplit();
  return true;
}

function splitCutSourceHint(state) {
  if (state?.cutSource === 'pointer') return '当前切分位置固定为波形指针位置';
  if (state?.cutSource === 'word-timestamps') return '当前切分位置由字词时间码推定';
  if (state?.cutSource === 'word-timestamps-default') return '默认位置参考主字幕字词时间码，可继续调整';
  return '';
}

function renderSplitMeta(text, state) {
  if (!multiSubtitleSplitMeta) return;
  multiSubtitleSplitMeta.replaceChildren();
  multiSubtitleSplitMeta.appendChild(document.createTextNode(text));
  const hint = splitCutSourceHint(state);
  if (!hint) return;
  const hintEl = document.createElement('span');
  hintEl.className = 'multi-subtitle-split-cut-hint';
  const translatedHint = window.MAWE_I18N?.translateText?.(hint) || hint;
  hintEl.textContent = `（${translatedHint}）`;
  multiSubtitleSplitMeta.appendChild(hintEl);
}

function updateLinkedSplitPreview(offset, lane = 'extension') {
  const state = pendingLinkedSplit;
  if (!state) return false;
  const track = getExtensionTrack(state.trackId);
  const main = state.mainIndex >= 0 ? DATA.segments[state.mainIndex] : null;
  const extension = extensionSegmentById(state.extensionId, track);
  const mainOnly = state.kind === 'main';
  const extensionOnly = state.kind === 'extension';
  if ((!mainOnly && !extensionOnly && !main) || (!mainOnly && !extension)) return false;

  if (lane === 'main' && main) {
    const requestedOffset = Math.max(0, Math.min(String(main.text || '').length, Math.round(Number(offset) || 0)));
    const legalOffsets = MULTI_SUBTITLE_UTILS.subtitleSplitOffsets(main.text, state.mainMode);
    if (!legalOffsets.length) return false;
    state.mainOffset = legalOffsets.reduce((best, candidate) => (
      Math.abs(candidate - requestedOffset) < Math.abs(best - requestedOffset) ? candidate : best
    ), legalOffsets[0]);
    const mainHasWordTimestamps = MULTI_SUBTITLE_UTILS.hasUsableSplitTimestamps(main);
    state.mainCutMs = Number.isFinite(state.fixedCutMs)
      ? state.fixedCutMs
      : mainHasWordTimestamps
        ? splitTimeForTextOffset(main, state.mainOffset)
        : splitCutTime(main, state.mainOffset, false);
  } else if (extension) {
    const requestedOffset = Math.max(
      0,
      Math.min(String(extension.text || '').length, Math.round(Number(offset) || 0)),
    );
    const legalOffsets = MULTI_SUBTITLE_UTILS.subtitleSplitOffsets(extension.text, state.extensionMode);
    if (!legalOffsets.length) return false;
    state.offset = legalOffsets.reduce((best, candidate) => (
      Math.abs(candidate - requestedOffset) < Math.abs(best - requestedOffset) ? candidate : best
    ), legalOffsets[0]);
    state.extensionCutMs = Number.isFinite(state.fixedCutMs)
      ? state.fixedCutMs : splitCutTime(extension, state.offset, false);
  }

  if (state.kind === 'linked') syncLinkedSplitTime(state, lane, main, extension);

  const mainMode = state.mainMode || (main && getMainSubtitleSplitMode(main));
  const mainParts = main
    ? MULTI_SUBTITLE_UTILS.splitSubtitleText(main.text, state.mainOffset, mainMode)
    : null;
  const extensionParts = extension
    ? MULTI_SUBTITLE_UTILS.splitSubtitleText(extension.text, state.offset, state.extensionMode)
    : null;
  const mainTextValid = !main || Boolean(mainParts);
  const extensionTextValid = !extension || Boolean(extensionParts);
  const mainTimingValid = !main || Boolean(mainParts
    && state.mainCutMs - main.start >= SUBTITLE_MIN_DURATION_MS
    && main.end - state.mainCutMs >= SUBTITLE_MIN_DURATION_MS);
  const extensionTimingValid = !extension || Boolean(extensionParts
    && state.extensionCutMs - extension.start >= SUBTITLE_MIN_DURATION_MS
    && extension.end - state.extensionCutMs >= SUBTITLE_MIN_DURATION_MS);
  const mainValid = mainTextValid && mainTimingValid;
  const extensionValid = extensionTextValid && extensionTimingValid;
  const valid = mainValid && extensionValid;
  const textValid = mainTextValid && extensionTextValid;
  const forceSegments = [main, extension].filter(Boolean);
  state.cutMs = extensionOnly ? state.extensionCutMs : state.mainCutMs;
  state.textValid = textValid;
  state.timingValid = mainTimingValid && extensionTimingValid;
  state.mainTimingValid = Boolean(mainTimingValid);
  state.forceCutMs = textValid
    ? forceSplitCutForSegments(forceSegments, state.cutMs)
    : null;
  state.forceEligible = textValid && !state.timingValid && Number.isFinite(state.forceCutMs);
  // 联动模式下，拓展轨无法形成合法拆分（文本断点非法，或最短 100ms 钳制也救不回来）、
  // 而主轨自身仍可拆时，允许降级为「只拆主轨并解除绑定」，避免主轨被拓展轨阻塞。
  state.mainOnlyFallbackEligible = false;
  if (state.kind === 'linked' && main && extension && mainTextValid && !valid && !state.forceEligible) {
    const mainRescuable = mainTimingValid
      || Number.isFinite(forceSplitCutForSegments([main], state.mainCutMs));
    const extensionRescuable = extensionTextValid && (extensionTimingValid
      || Number.isFinite(forceSplitCutForSegments([extension], state.extensionCutMs)));
    state.mainOnlyFallbackEligible = mainRescuable && !extensionRescuable;
  }
  if (valid) state.forceSplitArmed = false;
  state.valid = valid;
  updateSplitLaneVisual(state, 'main');
  updateSplitLaneVisual(state, 'extension');
  if (multiSubtitleSplitMeta) {
    if (mainOnly) {
      renderSplitMeta(`主轨：${splitModeLabel(state.mainMode)} · 切点 ${fmtShort(state.mainCutMs)} · 字符位置 ${state.mainOffset ?? '—'}`, state);
    } else if (extensionOnly) {
      renderSplitMeta(`拓展轨：${splitModeLabel(state.extensionMode)} · 切点 ${fmtShort(state.extensionCutMs)}`, state);
    } else {
      const mainLabel = state.mainTimestampLocked
        ? `⌚️主轨时间码锚点 ${fmtShort(state.mainCutMs)}`
        : state.mainInteractive
          ? `主轨文字断点 ${state.mainOffset ?? '—'}`
          : `主轨字词锚点 ${fmtShort(state.mainCutMs)}`;
      renderSplitMeta(`${mainLabel} · 拓展轨文字断点 ${state.offset ?? '—'} · 共用绝对切点 ${fmtShort(state.cutMs)}`, state);
    }
  }
  if (multiSubtitleSplitPreview) {
    multiSubtitleSplitPreview.replaceChildren();
    if (mainParts && !extensionOnly) setSplitPreviewLine('主', mainParts);
    if (extensionParts && !mainOnly) setSplitPreviewLine('副', extensionParts);
    if (!mainValid || !extensionValid) {
      const error = document.createElement('div');
      error.textContent = '当前断点无法形成两段合法文本';
      multiSubtitleSplitPreview.appendChild(error);
    }
  }
  if (multiSubtitleSplitError) {
    multiSubtitleSplitError.textContent = valid ? '' : (state.mainOnlyFallbackEligible
      ? '副字幕无法在当前切点形成合法拆分；确认后只拆分主字幕，并解除与副字幕的绑定。'
      : extensionOnly
        ? '拓展字幕切点必须为两侧各留至少 100ms。'
        : '主字幕和拓展字幕切点都必须为两侧各留至少 100ms。');
  }
  if (multiSubtitleSplitConfirm) {
    multiSubtitleSplitConfirm.disabled = !valid && !state.mainOnlyFallbackEligible;
  }
  updateLinkedSplitLockVisual();
  return valid;
}

function closeLinkedSplitModal() {
  multiSubtitleSplitModal?.classList.remove('show');
  [multiSubtitleSplitMainText, multiSubtitleSplitText].forEach((textEl) => {
    textEl?.classList.remove('locked');
    textEl?.removeAttribute('title');
  });
  multiSubtitleSplitPreview?.classList.remove('locked');
  pendingLinkedSplit = null;
}

function openMainWaveformSplitModal(mainIndex, timeMs) {
  const state = mainWaveformSplitState(mainIndex, { timeMs });
  if (!state) {
    flashHint('这条字幕没有可用的文字边界', 'invalid');
    return false;
  }
  state.feedbackPoint = waveformEditor?.getSplitPointAtTime?.(timeMs, 'main') || null;
  pendingLinkedSplit = state;
  multiSubtitleSplitModal?.classList.add('show');
  renderLinkedSplitText(state);
  return true;
}

function openExtensionSplitModal(
  extensionIndex,
  timeMs,
  track = getActiveExtensionTrack(),
  initial = {},
) {
  const state = extensionOnlySplitState(extensionIndex, track, { timeMs, ...initial });
  if (!state) {
    flashHint('这条副字幕没有可用的文字边界', 'invalid');
    return false;
  }
  state.feedbackPoint = state.feedbackPoint
    || waveformEditor?.getSplitPointAtTime?.(timeMs, 'extension') || null;
  pendingLinkedSplit = state;
  multiSubtitleSplitModal?.classList.add('show');
  renderLinkedSplitText(state);
  return true;
}

function commitMainWaveformSplit(state, { force = false, successMessage = '已按选择的断点拆分主字幕' } = {}) {
  // 波形入口可能是在当前字幕面板仍有未提交编辑时触发；先完成面板编辑，
  // 再为“拆分”建立快照，确保一次撤销能回到拆分前的完整字幕状态。
  commitCuePanelEdit();
  const mainIndex = state.mainIndex;
  const main = DATA.segments[mainIndex];
  if (!main) return false;
  const splitMs = force
    ? forceSplitCutForSegments([main], state.cutMs)
    : state.cutMs;
  if (!Number.isFinite(splitMs)) {
    flashHint('字幕总时长不足 200ms，无法让拆分后的两侧都达到 100ms', 'warning');
    return false;
  }
  const pair = buildSplitPair(
    main,
    state.mainOffset,
    splitMs,
    main.id || `main-${mainIndex}`,
    true,
    state.mainMode,
    {
      preserveCutMs: force || Number.isFinite(state.fixedCutMs),
      forceCut: force,
    },
  );
  if (!pair) return false;
  const oldMainId = main.id;
  pushUndo('拆分字幕', { captureView: true });
  clearSelection({ commitCuePanel: false });
  removeBindingsForSegmentIds([oldMainId], []);
  DATA.segments.splice(mainIndex, 1, pair.left, pair.right);
  for (let index = mainIndex + 2; index < DATA.segments.length; index++) {
    const segment = DATA.segments[index];
    if (segment.sticker_ref?.headIdx > mainIndex) segment.sticker_ref.headIdx += 1;
    if (segment.color_ref?.headIdx > mainIndex) segment.color_ref.headIdx += 1;
  }
  if (pair.left.sticker) pair.right.sticker_ref = { name: pair.left.sticker.name, headIdx: mainIndex };
  if (pair.left.color) pair.right.color_ref = { name: pair.left.color.name, headIdx: mainIndex };
  markMainSegmentsDirty([pair.left, pair.right]);
  rememberTemporaryVisibleSplitCues({ mainSegments: [pair.left, pair.right] });
  closeLinkedSplitModal();
  renderAll();
  selectOnly(mainIndex + 1);
  lastClickedIdx = mainIndex + 1;
  updateWithoutCueListAutoScroll();
  flashSplitFeedback({
    index: mainIndex,
    track: 'main',
    splitMs,
    feedbackPoint: null,
    listFeedback: false,
  });

  // 弹窗提交的刀光位置由唤起来源决定：列表唤起留在列表，其余落在波形最终切点。
  triggerNinjaSplitFeedback(ninjaModalSplitPoint(state, splitMs, 'main'));
  if (successMessage) flashHint(successMessage, 'success');
  return true;
}

// 降级路径：拓展轨无法形成合法拆分时，只拆主轨并解除与副字幕的绑定。
function commitLinkedSplitMainOnly(state) {
  const main = DATA.segments[state.mainIndex];
  if (!main) return false;
  let force = false;
  if (!state.mainTimingValid) {
    const mainForceCutMs = forceSplitCutForSegments([main], state.mainCutMs);
    if (!Number.isFinite(mainForceCutMs)) {
      flashHint('字幕总时长不足 200ms，无法让拆分后的两侧都达到 100ms', 'warning');
      return false;
    }
    if (!state.forceSplitArmed) {
      state.forceSplitArmed = true;
      flashHint(forcedSplitRetryHint(), 'warning');
      return false;
    }
    force = true;
    state.cutMs = mainForceCutMs;
    state.mainCutMs = mainForceCutMs;
  }
  const committed = commitMainWaveformSplit(state, { force, successMessage: null });
  if (!committed) return false;
  markMultiSubtitleDirty();
  flashHint('由于副字幕无法在当前切点形成合法拆分，为了拆分主字幕，已解除绑定', 'warning');
  return true;
}

function commitExtensionSplit(state, { force = false } = {}) {
  const track = getExtensionTrack(state.trackId);
  const extensionIndex = track?.segments?.findIndex((segment) => segment.id === state.extensionId) ?? -1;
  const extension = track?.segments?.[extensionIndex];
  if (!track || extensionIndex < 0 || !extension) return false;
  const splitMs = force
    ? forceSplitCutForSegments([extension], state.extensionCutMs)
    : state.extensionCutMs;
  if (!Number.isFinite(splitMs)) {
    flashHint('字幕总时长不足 200ms，无法让拆分后的两侧都达到 100ms', 'warning');
    return false;
  }
  const pair = buildSplitPair(
    extension,
    state.offset,
    splitMs,
    extension.id || `${track.id}-segment-${extensionIndex}`,
    true,
    state.extensionMode,
    {
      preserveCutMs: force || Number.isFinite(state.fixedCutMs),
      forceCut: force,
    },
  );
  if (!pair) return false;

  const oldExtensionId = extension.id;
  const wasBound = Boolean(bindingForExtensionIndex(extensionIndex, track));
  pushUndo('拆分拓展字幕', { captureView: true });
  // 一对一绑定无法让一个主段同时指向拆出的两条拓展段；独立拆分后
  // 保留两条拓展字幕，但解除旧关系，等待用户按需要重新绑定。
  removeBindingsForSegmentIds([], [oldExtensionId]);
  track.segments.splice(extensionIndex, 1, pair.left, pair.right);
  markMultiSubtitleDirty();
  rememberTemporaryVisibleSplitCues({
    extensionSegments: [pair.left, pair.right],
    extensionTrackId: track.id,
  });
  closeLinkedSplitModal();
  clearSelection({ commitCuePanel: false });
  renderAll();
  selectOnlyExtension(extensionIndex + 1);
  lastClickedExtensionIdx = extensionIndex + 1;
  updateWithoutCueListAutoScroll();
  flashSplitFeedback({
    index: extensionIndex,
    track: 'extension',
    splitMs,
    feedbackPoint: null,
    listFeedback: false,
  });
  // 弹窗提交的刀光位置由唤起来源决定：列表唤起留在列表，其余落在波形最终切点。
  triggerNinjaSplitFeedback(ninjaModalSplitPoint(state, splitMs, 'extension'));
  flashHint(
    wasBound
      ? '已独立拆分拓展字幕并解除原绑定'
      : '已按选择的断点拆分拓展字幕',
    'success',
  );
  return true;
}

function confirmLinkedSplit() {
  const state = pendingLinkedSplit;
  if (!state) return;
  const previewLane = state.kind === 'main' ? 'main' : 'extension';
  const previewOffset = state.kind === 'main' ? state.mainOffset : state.offset;
  const previewValid = updateLinkedSplitPreview(previewOffset, previewLane);
  let force = false;
  if (!previewValid) {
    // 拓展轨救不回来而主轨可拆：降级为只拆主轨并解除绑定，主轨不被拓展轨阻塞。
    if (state.kind === 'linked' && state.mainOnlyFallbackEligible) {
      commitLinkedSplitMainOnly(state);
      return;
    }
    if (!state.textValid) {
      flashHint('当前断点无法把主副字幕文本各拆成两段', 'warning');
      return;
    }
    if (!state.forceEligible) {
      flashHint('字幕总时长不足 200ms，无法让拆分后的两侧都达到 100ms', 'warning');
      return;
    }
    if (!state.forceSplitArmed) {
      armForcedSplit(state);
      return;
    }
    force = true;
    state.cutMs = state.forceCutMs;
    state.mainCutMs = state.forceCutMs;
    state.extensionCutMs = state.forceCutMs;
  }
  if (state.kind === 'main') {
    commitMainWaveformSplit(state, { force });
    return;
  }
  if (state.kind === 'extension') {
    commitExtensionSplit(state, { force });
    return;
  }
  const track = getExtensionTrack(state.trackId);
  const mainIndex = state.mainIndex;
  const extensionIndex = track?.segments?.findIndex((segment) => segment.id === state.extensionId) ?? -1;
  const main = DATA.segments[mainIndex];
  const extension = track?.segments?.[extensionIndex];
  const sharedCutMs = Number(state.cutMs);
  if (!Number.isFinite(sharedCutMs)
      || sharedCutMs !== Number(state.mainCutMs)
      || sharedCutMs !== Number(state.extensionCutMs)) {
    flashHint('主字幕和拓展字幕必须使用同一个绝对切点', 'warning');
    return;
  }
  const mainPair = buildSplitPair(
    main,
    state.mainOffset,
    sharedCutMs,
    main.id || `main-${mainIndex}`,
    true,
    state.mainMode,
    { preserveCutMs: true, forceCut: force },
  );
  const extensionPair = buildSplitPair(
    extension,
    state.offset,
    sharedCutMs,
    extension.id || `extension-${extensionIndex}`,
    true,
    state.extensionMode,
    { preserveCutMs: true, forceCut: force },
  );
  if (!mainPair || !extensionPair || extensionIndex < 0) {
    // 前置时长检查已拦截常见不可拆场景；这里兜底提示，避免弹窗内按键完全无反应。
    flashHint('当前切点无法同时拆分主副字幕，请调整断点位置', 'warning');
    return;
  }
  const oldMainId = main.id;
  const oldExtensionId = extension.id;
  pushUndo('联动拆分字幕', { captureView: true });
  removeBindingsForSegmentIds([oldMainId], [oldExtensionId]);
  DATA.segments.splice(mainIndex, 1, mainPair.left, mainPair.right);
  if (track) track.segments.splice(extensionIndex, 1, extensionPair.left, extensionPair.right);
  // 主轨数组增加了一项，沿用原有表情包/颜色 headIdx 维护规则。
  for (let index = mainIndex + 2; index < DATA.segments.length; index++) {
    const segment = DATA.segments[index];
    if (segment.sticker_ref?.headIdx > mainIndex) segment.sticker_ref.headIdx += 1;
    if (segment.color_ref?.headIdx > mainIndex) segment.color_ref.headIdx += 1;
  }
  if (mainPair.left.sticker) mainPair.right.sticker_ref.headIdx = mainIndex;
  if (mainPair.left.color) mainPair.right.color_ref.headIdx = mainIndex;
  const multi = getMultiSubtitleState();
  multi.bindings.push(
    MULTI_SUBTITLE_UTILS.buildSubtitleBinding(mainPair.left, extensionPair.left, track.id),
    MULTI_SUBTITLE_UTILS.buildSubtitleBinding(mainPair.right, extensionPair.right, track.id),
  );
  multi.enabled = true;
  markMainSegmentsDirty([mainPair.left, mainPair.right]);
  markMultiSubtitleDirty();
  rememberTemporaryVisibleSplitCues({
    mainSegments: [mainPair.left, mainPair.right],
    extensionSegments: [extensionPair.left, extensionPair.right],
    extensionTrackId: track.id,
  });
  closeLinkedSplitModal();
  clearSelection({ commitCuePanel: false });
  renderAll();
  selectOnly(mainIndex);
  lastClickedIdx = mainIndex;
  updateWithoutCueListAutoScroll();
  flashSplitFeedback({
    index: mainIndex,
    track: 'main',
    splitMs: sharedCutMs,
    feedbackPoint: null,
    listFeedback: false,
  });
  flashSplitFeedback({
    index: extensionIndex,
    track: 'extension',
    splitMs: sharedCutMs,
    feedbackPoint: null,
    listFeedback: false,
  });
  // 联动拆分刀光位置由唤起来源决定：列表唤起留在列表，其余落在主轨波形切点。
  triggerNinjaSplitFeedback(ninjaModalSplitPoint(state, sharedCutMs, 'main'));
  flashHint('已按同一绝对时间切点联动拆分', 'success');
}

function splitAtCursor(feedbackPoint = null, { listFeedback = true } = {}) {
  if (!editingState) return false;
  const force = editingState.forceSplitArmed === true;
  const { el, idx, textEl } = editingState;
  const sel = window.getSelection();
  if (!sel.rangeCount) {
    finishEdit(false);
    return false;
  }
  const range = sel.getRangeAt(0);
  const preRange = range.cloneRange();
  preRange.selectNodeContents(textEl);
  preRange.setEnd(range.startContainer, range.startOffset);
  const cursorOffset = preRange.toString().length;
  const fullText = textEl.innerText.replace(/\r\n?/g, '\n');
  const ninjaFeedbackPoint = feedbackPoint || ninjaSplitPointFromRange(
    range, textEl, cursorOffset, fullText.length,
  );
  const seg = DATA.segments[idx];

  if (multiSubtitleVisible() && bindingForMainIndex(idx)) {
    finishEdit(false);
    pendingLinkedSplit = linkedSplitState(idx, {
      mainOffset: cursorOffset,
      feedbackPoint: ninjaFeedbackPoint,
      ninjaFromList: true,
    });
    if (!pendingLinkedSplit) return;
    multiSubtitleSplitModal?.classList.add('show');
    renderLinkedSplitText(pendingLinkedSplit);
    return;
  }

  if (cursorOffset <= 0 || cursorOffset >= fullText.length) {
    finishEdit(false);
    flashHint('光标必须在词与词之间才能拆分', 'invalid');
    return false;
  }

  let leftText = fullText.slice(0, cursorOffset)
    .replace(/[，。,. \t]+$/, '').replace(/^[ \t]+/, '');
  let rightText = fullText.slice(cursorOffset)
    .replace(/^[，。,. \t]+/, '').replace(/[ \t]+$/, '');
  if (!leftText || !rightText) {
    finishEdit(false);
    flashHint('拆分后任一段为空，已取消', 'warning');
    return false;
  }

  // 原字幕总时长不足 200ms 时，无法在原时间范围内让两侧都达到 100ms；
  // 这和“切点靠边、可通过再次按键强制钳制”的情况不同。
  if (seg.end - seg.start < 200) {
    finishEdit(false);
    flashHint('字幕时长不足 200ms，无法拆分', 'warning');
    return false;
  }

  let itemSplit = splitItemsAtChar(seg, cursorOffset);
  let splitMs = itemSplit.splitMs;
  if (!itemSplit.hasItems || !Number.isFinite(splitMs)) {
    const ratio = cursorOffset / fullText.length;
    const t = seg.start + (seg.end - seg.start) * ratio;
    // 无词级时间码时按光标位置拆分；第一次按键仍保留原始切点，
    // 只有第二次强制拆分才把它钳制到两侧各 100ms 的安全范围。
    splitMs = Math.round(t);
  }
  const timingValid = Number.isFinite(splitMs)
    && splitMs - seg.start >= SUBTITLE_MIN_DURATION_MS
    && seg.end - splitMs >= SUBTITLE_MIN_DURATION_MS;
  if (!timingValid && !force) {
    editingState.forceSplitArmed = true;
    flashHint(forcedSplitRetryHint(), 'warning');
    return false;
  }
  if (force) {
    const forcedCut = forceSplitCutForSegments([seg], splitMs);
    if (!Number.isFinite(forcedCut)) {
      finishEdit(false);
      flashHint('字幕时长不足 200ms，无法让拆分后的两侧都达到 100ms', 'warning');
      return false;
    }
    splitMs = forcedCut;
    itemSplit = splitItemsAtChar(
      seg,
      cursorOffset,
      splitMs,
      { preserveCutMs: true, forceCut: true },
    );
  }
  // 字幕列表手工拆分允许用户指定任意字符位置，但时间码必须落在实际 item
  // 的安全范围内；当切点在 item 内时，splitItemsAtChar 已为两侧生成 item 副本。
  const leftItemsClean = cleanSplitItems(itemSplit.leftItems, 'left');
  const rightItemsClean = cleanSplitItems(itemSplit.rightItems, 'right');
  const leftEnd = splitMs;
  const rightStart = splitMs;

  const leftSeg = {
    id: MULTI_SUBTITLE_UTILS.uniqueStableSegmentId([seg], `${seg.id || `main-${idx}`}-a`, 'main'),
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
    id: MULTI_SUBTITLE_UTILS.uniqueStableSegmentId([seg], `${seg.id || `main-${idx}`}-b`, 'main'),
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

  // 拆分会改变 idx；先在任何写入前保存完整快照，再静默清选中，等列表
  // 和波形块覆盖层一次性更新后再选中后半段。这样撤销会恢复原 item 时间。
  pushUndo('拆分字幕', { captureView: true });
  clearSelection({ silent: true });
  // 关闭多字幕模式时，绑定关系仍保存在工程中；拆分主轨后旧 ID 不再存在，
  // 只移除这条关系，保留隐藏的扩展字幕供用户重新绑定。
  removeBindingsForSegmentIds([seg.id], []);
  DATA.segments.splice(idx, 1, leftSeg, rightSeg);

  // 修正所有 *_ref.headIdx：在 idx 之后的引用都右移 1
  // 但 leftSeg 在 idx 位置仍是 head（如果它有 sticker/color），rightSeg 的 ref.headIdx=idx 正好对应 leftSeg
  for (let i = idx + 2; i < DATA.segments.length; i++) {
    const sref = DATA.segments[i].sticker_ref;
    if (sref && sref.headIdx > idx) sref.headIdx += 1;
    const cref = DATA.segments[i].color_ref;
    if (cref && cref.headIdx > idx) cref.headIdx += 1;
  }

  rememberTemporaryVisibleSplitCues({ mainSegments: [leftSeg, rightSeg] });
  renderAll();
  // 列表来源的拆分（B 键悬停行、列表右键拆分、行内编辑拆分）都发生在当前
  // 可见的字幕行上，拆分后保持列表原滚动位置，不再把右半段滚到列表中央。
  // 波形 / 编辑面板等其它来源的拆分结果可能不在列表视口内，仍滚动到新右半段，
  // 便于在列表中看到拆分结果。
  if (!listFeedback) {
    const rightEl = container.querySelector(`.cue[data-idx="${idx + 1}"]`);
    if (rightEl) scrollCueToCenter(rightEl);
  }
  selectOnly(idx + 1);
  // 拆分后后半段是新的视觉选中项，也必须成为 Shift+点击的范围锚点。
  lastClickedIdx = idx + 1;
  // 列表来源（B 键悬停等）沿用列表光标坐标；编辑区 Ctrl+Enter 等其余来源
  // 统一回退到波形区实际切点位置，波形上找不到时才用编辑区文字坐标。
  triggerNinjaSplitFeedback(
    (listFeedback ? (feedbackPoint || ninjaFeedbackPoint) : null)
      || waveformEditor?.getSplitPointAtTime?.(splitMs, 'main')
      || ninjaFeedbackPoint,
  );
  updateWithoutCueListAutoScroll();
  flashSplitFeedback({
    index: idx,
    track: 'main',
    splitMs,
    feedbackPoint: listFeedback ? (feedbackPoint || ninjaFeedbackPoint) : null,
    listFeedback,
  });
  return true;
}

function flashCueSplitAt(idx, clientX, track = 'main') {
  if (!Number.isFinite(clientX)) return false;
  const cue = track === 'extension'
    ? container.querySelector(
      `.multi-cue-column.extension[data-ext-idx="${idx}"], .cue[data-ext-idx="${idx}"]`,
    )
    : container.querySelector(
      `.multi-cue-column.main[data-main-idx="${idx}"], .cue[data-idx="${idx}"]`,
    );
  if (!cue) return false;
  const rect = cue.getBoundingClientRect();
  const marker = document.createElement('span');
  marker.className = 'cue-split-flash';
  // .cue 的绝对定位子元素以 padding box 为坐标原点；rect.left 是 border box，
  // 还要扣掉左边的 3px 状态边框，否则光条会向右压进字形。
  marker.style.left = `${Math.max(0, Math.min(rect.width, clientX - rect.left - cue.clientLeft))}px`;
  cue.appendChild(marker);
  // 先触发布局，再加动画类，确保连续拆分时每个光条都能独立播放。
  void marker.offsetWidth;
  marker.classList.add('is-active');
  let removed = false;
  let timer = 0;
  const cleanup = () => {
    if (removed) return;
    removed = true;
    if (timer) window.clearTimeout(timer);
    marker.remove();
  };
  marker.addEventListener('animationend', cleanup, { once: true });
  timer = window.setTimeout(cleanup, 800);
  return true;
}

// 拆分来源可能是字幕列表、当前编辑区或弹窗；只有列表来源有可靠的列表坐标，
// 其它来源统一回退到波形时间位置。波形反馈只创建一个短暂标记，不参与播放帧刷新。
function flashSplitFeedback({ index, track = 'main', splitMs, feedbackPoint = null, listFeedback = false } = {}) {
  const timeMs = Number(splitMs);
  const hasListMarker = listFeedback
    && Number.isFinite(feedbackPoint?.clientX)
    && flashCueSplitAt(index, feedbackPoint.clientX, track);
  if (!hasListMarker && Number.isFinite(timeMs)) {
    waveformEditor?.flashSplitAtTime?.(timeMs, track);
  }
}

function splitFromContextMenu(idx, x, y, waveformTimeMs = null) {
  const el = container.querySelector(`.cue[data-idx="${idx}"]`);
  if (!el) return false;
  const waveformFeedbackPoint = Number.isFinite(waveformTimeMs)
    ? waveformEditor?.getSplitPointAtTime?.(waveformTimeMs, 'main') || null
    : null;
  const listCaretInfo = Number.isFinite(waveformTimeMs)
    ? null : caretInfoFromPoint(el.querySelector('.text'), x, y);
  if (multiSubtitleVisible() && bindingForMainIndex(idx)) {
    notifyMainSplitTimestampFallback(DATA.segments[idx]);
    const initial = Number.isFinite(waveformTimeMs)
      ? { timeMs: waveformTimeMs }
      : Number.isFinite(listCaretInfo?.offset)
        ? {
          mainOffset: listCaretInfo.offset,
          feedbackPoint: ninjaSplitPointFromRect(listCaretInfo.rect),
          ninjaFromList: true,
        }
        : {};
    if (waveformFeedbackPoint) initial.feedbackPoint = waveformFeedbackPoint;
    pendingLinkedSplit = linkedSplitState(idx, initial);
    if (!pendingLinkedSplit) return false;
    multiSubtitleSplitModal?.classList.add('show');
    renderLinkedSplitText(pendingLinkedSplit);
    return false;
  }
  if (Number.isFinite(waveformTimeMs)) {
    if (!shouldUseMainSplitTimestamps(DATA.segments[idx])) {
      notifyMainSplitTimestampFallback(DATA.segments[idx]);
      openMainWaveformSplitModal(idx, waveformTimeMs);
      return false;
    }
    const segment = DATA.segments[idx];
    const cursorOffset = splitOffsetNearTime(
      segment,
      waveformTimeMs,
      getMainSubtitleSplitMode(segment),
    );
    if (!Number.isInteger(cursorOffset)) {
      flashHint('这条字幕没有可拆分的文字边界', 'invalid');
      return false;
    }
    startEdit(el, idx);
    if (!setEditingCaretOffset(cursorOffset)) {
      finishEdit(false);
      flashHint('无法定位波形中的拆分位置', 'warning');
      return false;
    }
    const didSplit = splitAtCursor(waveformFeedbackPoint, { listFeedback: false });
    return didSplit;
  }
  // 字幕列表：在指定位置进入编辑，光标定位到 (x,y) 后立即拆分
  const caretInfo = listCaretInfo || caretInfoFromPoint(el.querySelector('.text'), x, y);
  const markerX = Number.isFinite(caretInfo?.rect?.left) ? caretInfo.rect.left : x;
  // 先在非编辑态记录文字偏移；进入 contenteditable 后字体/边界可能变化，
  // 再次用同一坐标命中会把「就是｜这颗」漂移到下一个字符。
  startEdit(el, idx);
  if (Number.isFinite(caretInfo?.offset)) setEditingCaretOffset(caretInfo.offset);
  return splitAtCursor(
    { clientX: markerX, clientY: caretInfo?.rect?.top ?? y },
    { listFeedback: true },
  );
}

// === 合并 ===
// 把 DATA.segments 中连续下标 sorted 合并为一条，并维护 group 引用与组时间范围。
// 不做参数校验、撤销与渲染，由调用方负责（mergeSegments / autoMergeSegments 共用）。
function mergeContiguousIndices(sorted) {
  const segs = sorted.map(i => DATA.segments[i]);
  const mergeStart = segs[0]?.start;
  const mergeEnd = segs[segs.length - 1]?.end;
  const multi = getMultiSubtitleState();
  const extensionTrack = multiSubtitleVisible() ? getActiveExtensionTrack() : null;
  const oldMainIds = segs.map((segment) => segment.id).filter(Boolean);
  const boundExtensionIds = new Set();
  if (extensionTrack) {
    oldMainIds.forEach((mainId) => {
      const binding = MULTI_SUBTITLE_UTILS.bindingForSegment(multi, mainId, 'main');
      (binding?.extension_segment_ids || []).forEach((extensionId) => boundExtensionIds.add(extensionId));
    });
  }
  const hasMeaningfulExtensionOverlap = (segment) => {
    const overlapStart = Math.max(Number(segment.start), Number(mergeStart));
    const overlapEnd = Math.min(Number(segment.end), Number(mergeEnd));
    return Number.isFinite(overlapStart) && Number.isFinite(overlapEnd)
      && overlapEnd - overlapStart >= MULTI_SUBTITLE_MERGE_OVERLAP_TOLERANCE_MS;
  };
  const extensionMergeIndices = extensionTrack
    ? extensionTrack.segments.map((segment, index) => ({ segment, index }))
      .filter(({ segment }) => boundExtensionIds.has(segment.id)
        || hasMeaningfulExtensionOverlap(segment))
      .map(({ index }) => index)
    : [];
  const extensionMergeSegments = extensionMergeIndices.map((index) => extensionTrack.segments[index]);
  const oldExtensionIds = extensionMergeSegments.map((segment) => segment.id).filter(Boolean);
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
    id: MULTI_SUBTITLE_UTILS.uniqueStableSegmentId(
      DATA.segments, `${segs[0].id || 'main'}-merged`, 'main',
    ),
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

  let mergedExtension = null;
  if (extensionTrack && extensionMergeSegments.length) {
    mergedExtension = {
      id: MULTI_SUBTITLE_UTILS.uniqueStableSegmentId(
        extensionTrack.segments, `${extensionMergeSegments[0].id || extensionTrack.id}-merged`, `${extensionTrack.id}-segment`,
      ),
      start: Math.min(...extensionMergeSegments.map((segment) => segment.start)),
      end: Math.max(...extensionMergeSegments.map((segment) => segment.end)),
      text: window.AsrEditorUtils.joinSegmentTexts(extensionMergeSegments, EDITOR_SETTINGS.mergeJoinText),
      _dirty: true,
    };
    if (extensionMergeSegments.some((segment) => Array.isArray(segment.items))) {
      mergedExtension.items = extensionMergeSegments.flatMap((segment) => segment.items || []);
    }
  }

  removeBindingsForSegmentIds(oldMainIds, oldExtensionIds);

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
  if (extensionTrack && extensionMergeIndices.length) {
    for (let i = extensionMergeIndices.length - 1; i >= 0; i--) {
      extensionTrack.segments.splice(extensionMergeIndices[i], 1);
    }
    if (mergedExtension) extensionTrack.segments.splice(extensionMergeIndices[0], 0, mergedExtension);
    if (mergedExtension) {
      multi.bindings.push(MULTI_SUBTITLE_UTILS.buildSubtitleBinding(merged, mergedExtension, extensionTrack.id));
      if (EDITOR_SETTINGS.multiSubtitleAutoSyncDuration) {
        // C 合并会重新创建一对绑定字幕；与手动绑定保持一致，按开关
        // 将新副字幕的时间范围同步到合并后的主字幕，并整理副轨冲突。
        setExtensionSegmentRange(mergedExtension, merged.start, merged.end);
        reconcileExtensionTrack(extensionTrack, [mergedExtension]);
        syncBindingOffsets();
      }
    }
    markMultiSubtitleDirty();
  }
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
  if (idxs.length < 2) { flashHint('请选择至少两个字幕块！', 'invalid'); return; }
  const sorted = [...new Set(idxs)].sort((a, b) => a - b);
  if (sorted.length < 2) { flashHint('请选择至少两个字幕块！', 'invalid'); return; }
  // 确保连续
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] !== sorted[i - 1] + 1) {
      flashHint('选中的字幕必须连续', 'invalid');
      return;
    }
  }
  commitCuePanelEdit();
  clearSelection({ silent: true });
  pushUndo('合并字幕');
  mergeContiguousIndices(sorted);
  renderAll();
  update();
  // 合并完成后选中合并结果，方便继续对这句新字幕操作
  selectOnly(sorted[0]);
  const el = container.querySelector(`.cue[data-idx="${sorted[0]}"]`);
  if (el) scrollCueToCenter(el);
  flashHint(`已合并 ${sorted.length} 条`, 'success');
}

// 只合并扩展轨连续字幕。扩展字幕没有主轨的 group 引用和 items，
// 因此这里保留独立轨的文本/时间合并语义；如果被合并段存在一对一绑定，
// 合并后无法同时指向多个主字幕，旧绑定会被移除并提示用户重新绑定。
function mergeExtensionSegments(idxs, track = getActiveExtensionTrack()) {
  if (!track || !idxs?.length) return false;
  const sorted = [...new Set(idxs)].sort((a, b) => a - b);
  if (sorted.length < 2) {
    flashHint('请选择至少两个扩展字幕块！', 'invalid');
    return false;
  }
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] !== sorted[i - 1] + 1) {
      flashHint('选中的扩展字幕必须连续', 'invalid');
      return false;
    }
  }
  const segments = sorted.map((index) => track.segments[index]).filter(Boolean);
  if (segments.length !== sorted.length) return false;

  const oldIds = segments.map((segment) => segment.id).filter(Boolean);
  const merged = {
    id: MULTI_SUBTITLE_UTILS.uniqueStableSegmentId(
      track.segments,
      `${segments[0].id || track.id}-merged`,
      `${track.id}-segment`,
    ),
    start: segments[0].start,
    end: segments[segments.length - 1].end,
    text: window.AsrEditorUtils.joinSegmentTexts(segments, EDITOR_SETTINGS.mergeJoinText),
    _dirty: true,
  };
  const hadBindings = oldIds.some((id) => MULTI_SUBTITLE_UTILS.bindingForSegment(
    getMultiSubtitleState(), id, 'extension', track.id,
  ));

  clearSelection();
  pushUndo('合并扩展字幕');
  removeBindingsForSegmentIds([], oldIds);
  track.segments.splice(sorted[0], sorted.length, merged);
  markMultiSubtitleDirty();
  renderAll();
  update();
  selectOnlyExtension(sorted[0]);
  lastClickedExtensionIdx = sorted[0];
  flashHint(
    hadBindings
      ? `已合并 ${sorted.length} 条扩展字幕，原绑定已解除`
      : `已合并 ${sorted.length} 条扩展字幕`,
    'success',
  );
  return true;
}

function parseSubtitleExtendMs(input) {
  const raw = String(input?.value ?? '').trim();
  const value = Number(raw);
  if (!raw || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

function extendSubtitleRanges() {
  const forwardMs = parseSubtitleExtendMs(subtitleExtendForwardInput);
  if (forwardMs === null) {
    flashHint('向前延长时长必须是大于等于 0 的数字', 'invalid');
    return;
  }
  const backwardMs = parseSubtitleExtendMs(subtitleExtendBackwardInput);
  if (backwardMs === null) {
    flashHint('向后延长时长必须是大于等于 0 的数字', 'invalid');
    return;
  }

  const hasSelection = selectedIdxs.size > 0;
  const indices = hasSelection ? [...selectedIdxs] : [];
  if (editingState) finishEdit(false);
  commitCuePanelEdit();
  const plan = window.AsrEditorUtils.planSubtitleExtension(DATA.segments, indices, {
    forwardMs,
    backwardMs,
    durationMs: getSubtitleTimelineDuration(),
  });
  if (plan.changedIndices.length) {
    pushUndo('延长字幕');
    let linkedChanged = false;
    const changedSegments = [];
    plan.changes.forEach((change) => {
      const segment = DATA.segments[change.index];
      if (!segment || !change.changed) return;
      const syncPatch = { oldStart: segment.start, oldEnd: segment.end, mode: 'range' };
      // 这里的 items 绝对时间码保持原样，延长只改变字幕段的外壳范围。
      segment.start = change.start;
      segment.end = change.end;
      segment._dirty = true;
      changedSegments.push(segment);
      linkedChanged = syncBoundExtensionForMain(segment, syncPatch) || linkedChanged;
    });
    markMainSegmentsDirty(changedSegments);
    syncTimelineGroupRanges();
    if (linkedChanged || multiSubtitleVisible()) markMultiSubtitleDirty();
    syncBindingOffsets();
    scheduleAutoSaveFlush();
    renderAll();
    update();
  }
  const scope = hasSelection ? `已处理 ${plan.indices.length} 个选中字幕` : `已处理 ${plan.indices.length} 个字幕`;
  flashHint(
    `${scope}：完整延长 ${plan.fullCount} 条，部分延长 ${plan.partialCount} 条，未延长 ${plan.unchangedCount} 条`,
    plan.changedIndices.length ? 'success' : 'warning',
  );
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

// 一键处理整段工程：相邻间隔不超过 autoMergeGapMs 时按吸附方向拼接；
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
    flashHint('没有需要拼接/合并的间隔或过短字幕', 'invalid');
    return;
  }
  if (editingState) finishEdit(false);
  commitCuePanelEdit();
  clearSelection({ silent: true });
  pushUndo('拼接/合并字幕');
  const snappedCount = applyAutoMergeSnapsWithBindings(plan.snaps);
  // 合并从后往前进行，保持靠前组的下标仍然有效
  for (let i = plan.groups.length - 1; i >= 0; i--) {
    mergeContiguousIndices(plan.groups[i]);
  }
  renderAll();
  update();
  const mergedCount = plan.groups.reduce((sum, group) => sum + group.length - 1, 0);
  const parts = [];
  if (snappedCount) parts.push(`吸附 ${snappedCount} 处间隔`);
  if (mergedCount) parts.push(`吸收 ${mergedCount} 条短字幕`);
  flashHint(`已拼接/合并字幕：${parts.join('，')}`, 'success');
}

// 「拼合字幕」的自动延展直接修改主轨边界，不能绕过普通时间编辑使用的
// 绑定同步路径。每个 snap 单独记录旧边界，确保连续间隔同时调整时，副字幕
// 仍按对应的 start/end offset 跟随；Alt 独立拖动不会进入这里。
function applyAutoMergeSnapsWithBindings(snaps) {
  let changed = 0;
  let linkedChanged = false;
  (Array.isArray(snaps) ? snaps : []).forEach((snap) => {
    const segment = DATA.segments[snap?.index];
    if (!segment || !Number.isFinite(snap?.time)) return;
    const oldStart = segment.start;
    const oldEnd = segment.end;
    const snapChanged = window.AsrEditorUtils.applyAutoMergeSnaps(DATA.segments, [snap]);
    if (!snapChanged) return;
    changed += snapChanged;
    linkedChanged = syncBoundExtensionForMain(segment, {
      oldStart,
      oldEnd,
      edge: snap.edge === 'end' ? 'end' : 'start',
    }) || linkedChanged;
  });
  if (linkedChanged) {
    markMultiSubtitleDirty();
    syncBindingOffsets();
  }
  return changed;
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
    flashHint('不能删除全部字幕', 'warning');
    return;
  }
  // Commit any pending cue-panel edit and reset panel state BEFORE splicing.
  // Without this, clearSelection() → setCurrentCuePanelIndex(-1) → commitCuePanelEdit()
  // would write the stale panel text to whatever segment now occupies the old index
  // after splice shifts the array — causing wrong-adjacent text overwrites.
  commitCuePanelEdit();
  currentCuePanelIdx = -1;
  currentCuePanelKind = 'main';
  currentCuePanelTrackId = null;
  resetCuePanelEditState();
  pushUndo(`删除 ${sorted.length} 条字幕`);
  const pairedExtensionIndices = new Set();
  const pairedMainIds = sorted.map((index) => DATA.segments[index]?.id).filter(Boolean);
  const multi = getMultiSubtitleState();
  const extensionTrack = multiSubtitleVisible() ? getActiveExtensionTrack() : null;
  (multi.bindings || []).forEach((binding) => {
    if (!binding.main_segment_ids?.some((id) => pairedMainIds.includes(id))) return;
    const extensionId = binding.extension_segment_ids?.[0];
    const extensionIndex = extensionTrack?.segments?.findIndex((segment) => segment.id === extensionId);
    if (extensionIndex >= 0) pairedExtensionIndices.add(extensionIndex);
  });
  // 关闭多字幕时仍清理已失效的主轨绑定，但不删除隐藏的扩展字幕。
  removeBindingsForSegmentIds(
    pairedMainIds,
    multiSubtitleVisible()
      ? [...pairedExtensionIndices].map((index) => extensionTrack?.segments[index]?.id)
      : [],
  );
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
  if (extensionTrack && pairedExtensionIndices.size) {
    [...pairedExtensionIndices].sort((a, b) => b - a).forEach((index) => extensionTrack.segments.splice(index, 1));
  }
  if (pairedExtensionIndices.size) markMultiSubtitleDirty();
  // 同样修正"刚被晋升为新 head 的段中"指向它的 ref：
  // splitGroups 写入的 refField.headIdx 是删除前的 idx，需要同样位移
  // 上面 shiftHeadIdx 已经覆盖（它扫所有 segments 的所有 ref）
  clearSelection({ silent: true });
  lastActive = -1;
  renderAll();
  flashHint(`已删除 ${sorted.length} 条`, 'success');
}

function deleteExtensionSegments(indices, track = getActiveExtensionTrack()) {
  if (!track || !indices?.length) return;
  const sorted = [...new Set(indices)].filter((index) => Number.isInteger(index)
    && index >= 0 && index < track.segments.length).sort((a, b) => a - b);
  if (!sorted.length) return;
  // 先提交并解除编辑区对旧副字幕下标的引用，避免删除前面的段后，
  // 编辑区下标漂移到另一条副字幕。
  commitCuePanelEdit();
  currentCuePanelIdx = -1;
  currentCuePanelKind = 'main';
  currentCuePanelTrackId = null;
  resetCuePanelEditState();
  const ids = sorted.map((index) => track.segments[index]?.id).filter(Boolean);

  // 删除绑定扩展字幕时沿用主轨删除语义：绑定关系和另一侧字幕一起删除，
  // 这样从任意 lane 删除都能用同一条撤销记录完整恢复。未绑定的扩展段
  // 仍允许单独删除；混合选择时两类操作会分别使用各自的历史记录。
  const pairedMainIndices = new Set();
  const unboundIds = new Set(ids);
  ids.forEach((id) => {
    const binding = MULTI_SUBTITLE_UTILS.bindingForSegment(
      getMultiSubtitleState(), id, 'extension', track.id,
    );
    if (!binding) return;
    const mainId = binding.main_segment_ids?.[0];
    const mainIndex = DATA.segments.findIndex((segment) => segment.id === mainId);
    if (mainIndex >= 0) pairedMainIndices.add(mainIndex);
    unboundIds.delete(id);
  });
  if (pairedMainIndices.size) {
    deleteSegments([...pairedMainIndices]);
  }

  const remainingIndices = track.segments
    .map((segment, index) => unboundIds.has(segment.id) ? index : -1)
    .filter((index) => index >= 0);
  if (!remainingIndices.length) return;

  pushUndo(`删除 ${sorted.length} 条扩展字幕`);
  removeBindingsForSegmentIds([], [...unboundIds]);
  remainingIndices.reverse().forEach((index) => track.segments.splice(index, 1));
  markMultiSubtitleDirty();
  selectedExtensionIdxs.clear();
  renderAll();
  flashHint(`已删除 ${remainingIndices.length} 条扩展字幕`, 'success');
}

// === 滚动 ===
function cueListVisibleBounds() {
  const containerRect = container.getBoundingClientRect();
  const toolbar = container.querySelector(':scope > .cue-list-toolbar');
  const toolbarRect = toolbar?.getBoundingClientRect();
  const top = toolbarRect
    ? Math.min(containerRect.bottom, Math.max(containerRect.top, toolbarRect.bottom))
    : containerRect.top;
  return { containerRect, top, bottom: containerRect.bottom };
}

function scrollCueToCenter(cueEl, { behavior = 'smooth' } = {}) {
  if (!cueEl || cueEl.classList.contains('hidden')) return;
  const { containerRect: cRect, top: visibleTop, bottom: visibleBottom } = cueListVisibleBounds();
  const eRect = cueEl.getBoundingClientRect();
  const visibleHeight = Math.max(1, visibleBottom - visibleTop);
  const comfortInset = Math.min(120, Math.max(48, visibleHeight * 0.2));
  // 目标已经处于列表中间的舒适区域时，不再制造一次多余的滚动动画。
  // 顶部从 sticky 工具栏底部开始计算，避免把字幕滚到工具栏下面。
  const containerComfortTop = cRect.top + comfortInset;
  const containerComfortBottom = cRect.bottom - comfortInset;
  if (
    eRect.top >= containerComfortTop
    && eRect.bottom <= containerComfortBottom
  ) return;
  const offsetTop = (eRect.top - cRect.top) + container.scrollTop;
  const visibleTopOffset = visibleTop - cRect.top;
  const target = offsetTop + eRect.height / 2 - visibleTopOffset - visibleHeight / 2;
  container.scrollTo({ top: Math.max(0, target), behavior });
}
function scrollCueIntoViewIfNeeded(cueEl, options) {
  if (!cueEl || cueEl.classList.contains('hidden')) return;
  const { top, bottom } = cueListVisibleBounds();
  const eRect = cueEl.getBoundingClientRect();
  if (eRect.top < top || eRect.bottom > bottom) scrollCueToCenter(cueEl, options);
}

// === seek ===
let seekWarned = false;
let cueListPointer = null;
// 最后一次指针按下所在的编辑区域：cue-list / waveform。
// Enter（原地编辑 vs 聚焦字幕编辑区）据此分发；指针坐标由 cueListPointer /
// lastPointerPos 提供，两者独立更新、互不替代。
let lastEditRegion = null;
let navigationOwner = null;
let lastPointerPos = null;
let cueSplitPreviewEl = null;
let cueSplitPreviewFrame = 0;
let cueSplitPreviewRequest = null;

// 等待绑定时，点击主/扩展字幕本身交给各自的选择事件处理；其它空白或
// 非字幕区域视为取消，避免用户进入等待状态后无从退出。
document.addEventListener('pointerdown', (event) => {
  if (!pendingExtensionBinding) return;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('.cue, .waveform-cue-block, #ctxmenu')) return;
  cancelPendingExtensionBinding();
}, true);

document.addEventListener('pointerdown', (e) => {
  if (e.target instanceof Element && e.target.closest('.cue')) lastEditRegion = 'cue-list';
  else if (e.target instanceof Element && e.target.closest('#waveform-pane')) lastEditRegion = 'waveform';
}, true);
function navigationOwnerForTarget(target) {
  if (!(target instanceof Element)) return null;
  if (target.closest('.cue')) return 'cue-list';
  if (target.closest('.player-stage, #media-controls, .waveform-row, #waveform-scroll')) {
    return 'waveform/player';
  }
  return null;
}
function updateNavigationOwner(event) {
  const owner = navigationOwnerForTarget(event.target);
  if (owner) navigationOwner = owner;
}
document.addEventListener('pointerdown', updateNavigationOwner, true);
document.addEventListener('focusin', updateNavigationOwner, true);
document.addEventListener('pointermove', (e) => {
  lastPointerPos = { x: e.clientX, y: e.clientY };
}, true);

function hideCueSplitPreview() {
  if (cueSplitPreviewFrame) {
    cancelAnimationFrame(cueSplitPreviewFrame);
    cueSplitPreviewFrame = 0;
  }
  cueSplitPreviewRequest = null;
  cueSplitPreviewEl?.remove();
  cueSplitPreviewEl = null;
}

function scheduleCueSplitPreview(idx, clientX, clientY, kind = 'main', trackId = null) {
  cueSplitPreviewRequest = { idx, clientX, clientY, kind, trackId };
  if (cueSplitPreviewFrame) return;
  cueSplitPreviewFrame = requestAnimationFrame(() => {
    cueSplitPreviewFrame = 0;
    const request = cueSplitPreviewRequest;
    cueSplitPreviewRequest = null;
    const isExtension = request?.kind === 'extension';
    const selected = isExtension ? selectedExtensionIdxs : selectedIdxs;
    if (!request || selected.size !== 1 || !selected.has(request.idx)) {
      hideCueSplitPreview();
      return;
    }
    const track = isExtension ? getExtensionTrack(request.trackId) : null;
    const cue = isExtension
      ? container.querySelector(
        `.multi-cue-column.extension[data-ext-idx="${request.idx}"], `
          + `.multi-extension-cue[data-ext-idx="${request.idx}"]`,
      )
      : container.querySelector(`.cue[data-idx="${request.idx}"]`);
    const segment = isExtension ? track?.segments?.[request.idx] : DATA.segments[request.idx];
    const textEl = cue?.querySelector('.text');
    const text = String(segment?.text || '');
    if (!cue || !segment || !textEl || text.length < 2 || segment.end - segment.start < 200) {
      hideCueSplitPreview();
      return;
    }
    const info = caretInfoFromPoint(textEl, request.clientX, request.clientY);
    if (!info || info.offset <= 0 || info.offset >= text.length) {
      hideCueSplitPreview();
      return;
    }
    const cueRect = cue.getBoundingClientRect();
    // 光条挂在 .cue 上，而 caret 的坐标是 viewport 坐标；扣除 .cue 的左边框，
    // 才能把 marker 的中心放回真正的字符边界。
    const left = Math.max(0, Math.min(cueRect.width, info.rect.left - cueRect.left - cue.clientLeft));
    if (!cueSplitPreviewEl || cueSplitPreviewEl.parentElement !== cue) {
      cueSplitPreviewEl?.remove();
      cueSplitPreviewEl = document.createElement('span');
      cueSplitPreviewEl.className = 'cue-split-preview';
      cueSplitPreviewEl.setAttribute('aria-hidden', 'true');
      cue.appendChild(cueSplitPreviewEl);
    }
    cueSplitPreviewEl.style.left = `${left}px`;
  });
}

function waveformPointerContext() {
  if (!lastPointerPos) return null;
  const timeMs = waveformEditor?.timeMsAtPoint?.(lastPointerPos.x, lastPointerPos.y);
  if (!Number.isFinite(timeMs)) return null;
  const track = waveformEditor?.trackAtPoint?.(lastPointerPos.x, lastPointerPos.y) || 'main';
  return {
    ...lastPointerPos,
    timeMs,
    track,
    trackId: track === 'extension' ? getActiveExtensionTrack()?.id || null : null,
  };
}

function keyboardOperationReference() {
  const pointer = waveformPointerContext();
  const target = getCurrentCuePanelTarget();
  return GEO_UTILS.resolveKeyboardOperationReference(
    EDITOR_SETTINGS.keyboardOperationReference,
    {
      pointer,
      playheadTarget: {
        ...(target || { kind: 'main', trackId: null }),
        timeMs: Math.round(Number(player.currentTime) * 1000),
      },
    },
  );
}

// Z/X 只接受一个“逻辑字幕”作为目标：点击主字幕时，绑定副字幕是它的
// 联动对象；点击副字幕时，即使界面同时选中了主字幕，也仍只改副字幕。
// 其它多选或来自不同绑定组的混合选择直接不处理。
function getPointerBoundaryEditTarget(context) {
  if (!context) return null;
  const mainIndices = [...selectedIdxs];
  const extensionIndices = [...selectedExtensionIdxs];

  if (!mainIndices.length && !extensionIndices.length) {
    const extension = context.track === 'extension' && multiSubtitleVisible();
    const track = extension ? getExtensionTrack(context.trackId) : null;
    const segments = extension ? track?.segments : DATA.segments;
    const index = findWaveformCueAtTime(context.timeMs, segments);
    if (index < 0 || !segments?.[index]) return null;
    return {
      kind: extension ? 'extension' : 'main',
      index,
      trackId: track?.id || null,
      track,
      segment: segments[index],
    };
  }

  const panelTarget = getCurrentCuePanelTarget();
  if (!panelTarget) return null;
  if (panelTarget.kind === 'main') {
    if (mainIndices.length !== 1 || mainIndices[0] !== panelTarget.index) return null;
    const binding = bindingForMainIndex(panelTarget.index);
    const bindingTrack = binding ? getExtensionTrack(binding.track_id) : null;
    const boundExtensionIndices = (binding?.extension_segment_ids || [])
      .map((id) => bindingTrack?.segments?.findIndex((segment) => segment?.id === id) ?? -1)
      .filter((index) => index >= 0);
    const extensionMatchesBinding = extensionIndices.length === 0
      || (boundExtensionIndices.length === 1
        && extensionIndices.length === 1
        && extensionIndices[0] === boundExtensionIndices[0]);
    if (!extensionMatchesBinding) return null;
    return panelTarget;
  }

  if (extensionIndices.length !== 1 || extensionIndices[0] !== panelTarget.index) return null;
  const binding = bindingForExtensionIndex(panelTarget.index, panelTarget.track);
  const boundMainIndices = (binding?.main_segment_ids || [])
    .map((id) => DATA.segments.findIndex((segment) => segment?.id === id))
    .filter((index) => index >= 0);
  const mainMatchesBinding = mainIndices.length === 0
    || (boundMainIndices.length === 1
      && mainIndices.length === 1
      && mainIndices[0] === boundMainIndices[0]);
  return mainMatchesBinding ? panelTarget : null;
}

// Z：起点定位；X：终点定位。无选中时使用波形指针命中的字幕；有选中时
// 只允许一个逻辑字幕，避免把多选误当成批量边界调整。
function handlePointerBoundaryShortcut(event, edge) {
  if (event.key !== (edge === 'start' ? 'z' : 'x')
      && event.key !== (edge === 'start' ? 'Z' : 'X')) return;
  if (event.repeat || editingState || extensionEditingState || isTextEditingTarget(event)) return;
  const active = document.activeElement;
  if (active && (
    active.tagName === 'INPUT' || active.tagName === 'TEXTAREA'
      || active.tagName === 'SELECT' || active.isContentEditable
  )) return;
  if (replaceModal.classList.contains('show') || stickerModal.classList.contains('show')
      || stickerPreviewModal.classList.contains('show') || projectMediaModal.classList.contains('show')
      || multiSubtitleSplitModal?.classList.contains('show')
      || multiSubtitleImportModal?.classList.contains('show')
      || document.getElementById('sticker-root-modal').classList.contains('show')
      || ctxmenu.classList.contains('show')) return;
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;

  const reference = keyboardOperationReference();
  const context = reference ? { ...reference } : null;
  const target = getPointerBoundaryEditTarget(context);
  if (!reference || !target || !waveformEditor?.setCueBoundaryToTime) {
    if (!reference) flashHint('无有效的快捷键时间基准', 'invalid');
    return;
  }
  const track = target.kind === 'extension' ? 'extension' : 'main';
  if (!waveformEditor.setCueBoundaryToTime(context.timeMs, edge, track, target.index)) return;
  event.preventDefault();
  event.stopPropagation();
}

document.addEventListener('keydown', (event) => handlePointerBoundaryShortcut(event, 'start'));
document.addEventListener('keydown', (event) => handlePointerBoundaryShortcut(event, 'end'));

function hoveredSelectedCueContext() {
  if (!cueListPointer) return null;
  const isExtension = cueListPointer.kind === 'extension';
  const selected = isExtension ? selectedExtensionIdxs : selectedIdxs;
  if (!selected.has(cueListPointer.idx)) return null;
  const track = isExtension ? getExtensionTrack(cueListPointer.trackId) : null;
  const el = isExtension
    ? container.querySelector(
      `.multi-cue-column.extension[data-ext-idx="${cueListPointer.idx}"], `
        + `.multi-extension-cue[data-ext-idx="${cueListPointer.idx}"]`,
    )
    : container.querySelector(`.cue[data-idx="${cueListPointer.idx}"]`);
  if (!el || !el.matches(':hover')) return null;
  const caret = caretInfoFromPoint(el.querySelector('.text'), cueListPointer.x, cueListPointer.y);
  return { ...cueListPointer, el, track, offset: caret?.offset ?? null, caretRect: caret?.rect ?? null };
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
    cueListPointer = { kind: 'main', idx, x: e.clientX, y: e.clientY };

    // 这些子控件有自己的 click 行为；不要在父 cue 的 pointerdown 阶段抢先选中。
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest('.color-bar.is-ref, .sticker-slot img, .sticker-slot .sref')) {
      // 避免这次不会冒泡到父 cue 的 click 参与下一次普通双击判定。
      lastPrimaryPointerDownAt = 0;
      pointerDownState = { handled: false, time: performance.now() };
      return;
    }

    const now = performance.now();
    const listScrollBeforeClick = container.scrollTop;
    const listCenterScroll = Math.max(
      0,
      el.offsetTop - container.clientHeight / 2 + el.offsetHeight / 2,
    );
    const isSecondDoubleClick = e.detail > 1
      || (lastPrimaryPointerDownAt > 0 && now - lastPrimaryPointerDownAt < 500);
    lastPrimaryPointerDownAt = now;
    if (isSecondDoubleClick) {
      // 第一次 pointerdown 已经完成选中；双击的第二次按下不要再次刷新波形布局。
      // 但仍要更新当前编辑焦点：主副字幕可以同时保持选中，且前一次主轨点击
      // 可能与扩展轨点击被隔开，此时不能因为本次字幕仍处于 selected 就停留在副字幕面板。
      setCurrentCuePanelIndex(idx);
      pointerDownState = { handled: true, suppressClick: true, time: now };
      return;
    }

    const action = selectFromCuePointer(e);
    pointerDownState = {
      handled: true,
      suppressClick: action !== 'select',
      time: now,
      preserveListScroll: listScrollBeforeClick > 0 && el.offsetTop < listScrollBeforeClick,
      listScrollBeforeClick,
    };
  });
  el.addEventListener('pointermove', (e) => {
    if (editingState?.el === el) {
      hideCueSplitPreview();
      return;
    }
    cueListPointer = { kind: 'main', idx, x: e.clientX, y: e.clientY };
    scheduleCueSplitPreview(idx, e.clientX, e.clientY, 'main');
  });
  el.addEventListener('pointerleave', () => {
    if (cueListPointer?.idx === idx) {
      cueListPointer = null;
      hideCueSplitPreview();
    }
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
    if (EDITOR_SETTINGS.cueListAutoScrollOnClick && !state?.preserveListScroll) {
      scrollCueToCenter(el);
    }
    waveformEditor?.revealTime(DATA.segments[idx].start, true);
    if (EDITOR_SETTINGS.clickBehavior !== 'select-only') {
      // 默认只跳转不改动播放状态；“选中并跳转（自动播放）”会在暂停时启动播放。
      const previousSuppress = suppressCueListAutoScroll;
      suppressCueListAutoScroll = state?.preserveListScroll
        ? true : !EDITOR_SETTINGS.cueListAutoScrollOnClick;
      try {
        seekFromWaveform(DATA.segments[idx].start / 1000);
      } finally {
        suppressCueListAutoScroll = state?.preserveListScroll
          ? true : previousSuppress;
      }
      if (state?.preserveListScroll) container.scrollTop = state.listScrollBeforeClick;
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
  // 拆分会在当前 keydown 事件内打开弹窗；阻止同一 document 上后注册的
  // 弹窗快捷键监听器继续处理这次 Enter，否则它会立刻把新弹窗再次提交。
  e.stopImmediatePropagation();
  if (action === 'split') splitAtCursor();
  else finishEdit(true);
}, true);

document.addEventListener('keydown', (event) => {
  if (!extensionEditingState) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    finishExtensionEdit(false);
    return;
  }
  const action = getConfiguredEnterAction(event);
  if (!action || action === 'newline') return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (action === 'save') {
    finishExtensionEdit(true);
    return;
  }
  const state = extensionEditingState;
  const offset = caretOffsetInText(state.textEl);
  const track = getExtensionTrack(state.trackId);
  if (!Number.isFinite(offset) || !track?.segments?.[state.index]) {
    flashHint('无法定位副字幕的文字光标', 'warning');
    return;
  }
  finishExtensionEdit(true);
  openExtensionSplitModal(state.index, null, track, { extensionOffset: offset });
}, true);

// Esc：非字幕文本编辑状态下清除当前字幕选择；输入框和内联编辑继续保留原生/编辑行为。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (pendingExtensionBinding) {
    e.preventDefault();
    e.stopPropagation();
    cancelPendingExtensionBinding();
    return;
  }
  if (editingState || (selectedIdxs.size === 0 && selectedExtensionIdxs.size === 0)) return;
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
  if (waveformEditor?.hasCueDrag?.()) {
    // 拖动中的 Esc 不取消拖动，也不清空选区；拖动仍由 pointerup 正常完成。
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  clearSelection();
});

function isJklDirectionMode() {
  return EDITOR_SETTINGS.jklPlaybackMode === 'direction';
}

function stopJklReversePlayback({ render = true } = {}) {
  if (jklReverseFrameId) cancelAnimationFrame(jklReverseFrameId);
  jklReverseFrameId = 0;
  jklReverseLastTimestamp = 0;
  const wasPlaying = jklReversePlaying;
  jklReversePlaying = false;
  if (render && wasPlaying) {
    update();
    waveformEditor?.updatePlayback();
  }
  if (render) syncMediaControls();
}

function stepJklReversePlayback(timestamp) {
  jklReverseFrameId = 0;
  if (!jklReversePlaying || !player) return;
  if (!jklReverseLastTimestamp) jklReverseLastTimestamp = timestamp;
  const elapsed = Math.min(
    0.1,
    Math.max(0, (timestamp - jklReverseLastTimestamp) / 1000),
  );
  jklReverseLastTimestamp = timestamp;
  const current = Number(player.currentTime);
  const rate = Math.max(0.0625, Math.abs(jklPlaybackRate));
  const next = Number.isFinite(current) ? current - elapsed * rate : 0;
  if (!Number.isFinite(current) || next <= 0) {
    player.currentTime = 0;
    jklReversePlaying = false;
    jklReverseLastTimestamp = 0;
    update();
    waveformEditor?.updatePlayback();
    syncMediaControls();
    return;
  }
  player.currentTime = next;
  updatePlaybackFrame();
  renderStickerOverlay(next * 1000);
  syncMediaControls();
  if (jklReversePlaying) jklReverseFrameId = requestAnimationFrame(stepJklReversePlayback);
}

function startJklReversePlayback() {
  if (!hasLoadedMedia()) {
    flashHint('请先加载媒体，然后才能预览', 'invalid');
    return false;
  }
  jklReversePlaying = true;
  jklReverseLastTimestamp = 0;
  player.playbackRate = Math.max(0.0625, Math.abs(jklPlaybackRate));
  if (!player.paused) player.pause();
  if (!jklReverseFrameId) jklReverseFrameId = requestAnimationFrame(stepJklReversePlayback);
  syncMediaControls();
  return true;
}

function playJklForward() {
  if (!hasLoadedMedia()) {
    flashHint('请先加载媒体，然后才能预览', 'invalid');
    return false;
  }
  stopJklReversePlayback({ render: false });
  player.playbackRate = Math.max(0.0625, Math.abs(jklPlaybackRate));
  const promise = player.play();
  if (promise && promise.catch) promise.catch(() => {});
  syncMediaControls();
  return true;
}

function togglePlayback() {
  if (!hasLoadedMedia()) {
    flashHint('请先加载媒体，然后才能预览', 'invalid');
    return;
  }
  if (jklReversePlaying) {
    stopJklReversePlayback();
    return;
  }
  if (isJklDirectionMode() && jklPlaybackRate < 0) {
    startJklReversePlayback();
    return;
  }
  if (player.paused) {
    if (isJklDirectionMode()) player.playbackRate = Math.max(0.0625, Math.abs(jklPlaybackRate));
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

function mediaSeekStepLabel(milliseconds) {
  return `${milliseconds}ms`;
}

function refreshMediaSeekStepHelp() {
  if (helpMediaSeekStep) helpMediaSeekStep.textContent = mediaSeekStepLabel(EDITOR_SETTINGS.mediaSeekStepMs);
}

function refreshMediaSeekControlLabels() {
  const milliseconds = EDITOR_SETTINGS.mediaSeekStepMs;
  const language = window.MAWE_I18N?.language === 'en' ? 'en' : 'zh';
  const backLabel = language === 'en' ? `Back ${milliseconds}ms` : `后退 ${milliseconds}ms`;
  const forwardLabel = language === 'en' ? `Forward ${milliseconds}ms` : `前进 ${milliseconds}ms`;
  if (mediaStepBack) {
    mediaStepBack.setAttribute('aria-label', backLabel);
    mediaStepBack.title = backLabel;
  }
  if (mediaStepForward) {
    mediaStepForward.setAttribute('aria-label', forwardLabel);
    mediaStepForward.title = forwardLabel;
  }
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
  playerWrap?.classList.toggle('fullscreen-preview', document.fullscreenElement === playerWrap);
  refreshMediaSeekControlLabels();
  if (!mediaPlayToggle || !player) return;
  const hasMedia = hasLoadedMedia();
  const duration = Number.isFinite(player.duration) && player.duration > 0 ? player.duration : 0;
  const current = Number.isFinite(player.currentTime) ? Math.max(0, player.currentTime) : 0;
  const active = hasMedia && (jklReversePlaying || !player.paused);
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
    const displayedRate = isJklDirectionMode() && jklPlaybackRate < 0
      ? jklPlaybackRate
      : player.playbackRate;
    syncPlaybackRateOption(displayedRate);
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

function seekMediaTo(timeSeconds) {
  if (!hasLoadedMedia()) return false;
  const duration = Number.isFinite(player.duration) && player.duration > 0
    ? player.duration : null;
  if (!Number.isFinite(duration)) return false;
  stopJklReversePlayback({ render: false });
  const targetSeconds = Math.max(0, Math.min(duration, Number(timeSeconds) || 0));
  player.currentTime = targetSeconds;
  update();
  waveformEditor?.revealTime(targetSeconds * 1000, true);
  waveformEditor?.updatePlayback();
  syncMediaControls();
  return true;
}

mediaPlayToggle?.addEventListener('click', togglePlayback);
mediaStepBack?.addEventListener('click', () => seekMediaBy(-EDITOR_SETTINGS.mediaSeekStepMs / 1000));
mediaStepForward?.addEventListener('click', () => seekMediaBy(EDITOR_SETTINGS.mediaSeekStepMs / 1000));
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
  const selectedRate = Number(mediaPlaybackRate.value) || 1;
  const rate = Math.max(0.0625, Math.abs(selectedRate));
  player.playbackRate = rate;
  if (isJklDirectionMode()) {
    const direction = selectedRate < 0 || jklPlaybackRate < 0 ? -1 : 1;
    jklPlaybackRate = direction * rate;
  }
  syncMediaControls();
});
mediaFullscreen?.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await playerWrap?.requestFullscreen?.();
  } catch (error) {
    flashHint(`无法切换全屏：${error.message || error}`, 'warning');
  }
  syncMediaControls();
});
document.addEventListener('fullscreenchange', syncMediaControls);

// ←/→：无选中字幕时复用媒体控制条的跳转时长；选中字幕时改为按设置的
// 微调幅度调整时间。Shift+方向键贴合前后边界；Ctrl(Cmd)+方向键调整左边界，
// Ctrl(Cmd)+Shift+方向键调整右边界。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  if (editingState || isTextEditingTarget(e)) return;
  // 拆分弹窗内方向键用于移动 ✂️ 断点，不再 seek 媒体或微调字幕时间。
  if (multiSubtitleSplitModal?.classList.contains('show')) return;
  const target = e.target instanceof Element ? e.target : document.activeElement;
  if (target?.closest?.('.geo-box, input, select, textarea')) return;
  if (!isPlaybackKeyboardTarget(e) && isNativeKeyboardControl(e)) return;
  if (isPlayerKeyboardTarget(e)) return;
  const commandKey = e.ctrlKey || e.metaKey;
  const direction = e.key === 'ArrowLeft' ? -1 : 1;
  const panelTarget = getCurrentCuePanelTarget();
  const extensionTarget = panelTarget?.kind === 'extension';
  const activeTrack = extensionTarget ? 'extension' : 'main';
  const selected = extensionTarget ? selectedExtensionIdxs : selectedIdxs;
  if (e.shiftKey && !commandKey) {
    // Shift 是显式的边界贴合命令，不受自动吸附默认值影响；Alt 只反转
    // 普通移动/边界微调的自动联动模式。
    if (selected.size > 0
        && waveformEditor?.snapSelectedCueBoundaryByKeyboard?.(direction, activeTrack)) {
      e.preventDefault();
      e.stopPropagation();
    }
    return;
  }
  if (selected.size > 0 && waveformEditor) {
    const deltaMs = direction * EDITOR_SETTINGS.cueMoveStepMs;
    if (commandKey) {
      if (e.shiftKey) {
        waveformEditor.adjustSelectedBoundaryByKeyboard(deltaMs, 'end', e.altKey, activeTrack);
      } else {
        waveformEditor.adjustSelectedBoundaryByKeyboard(deltaMs, 'start', e.altKey, activeTrack);
      }
    } else {
      waveformEditor.adjustSelectedByKeyboard(deltaMs, e.altKey, activeTrack);
    }
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (commandKey || e.altKey) return;
  if (!hasLoadedMedia()) return;
  e.preventDefault();
  e.stopPropagation();
  seekMediaBy(direction * EDITOR_SETTINGS.mediaSeekStepMs / 1000);
}, true);

function renderedCueBoundaryTarget(target, boundary) {
  const selector = target?.kind === 'extension'
    ? '.multi-dual-cue[data-ext-idx], .multi-extension-cue[data-ext-idx]'
    : '.cue[data-idx], .multi-dual-cue[data-main-idx]';
  const track = target?.kind === 'extension' ? target.track : 'main';
  const indexes = [...container.querySelectorAll(selector)]
    .filter((cue) => !cue.classList.contains('hidden'))
    .map((cue) => Number(target?.kind === 'extension'
      ? cue.dataset.extIdx
      : cue.dataset.idx ?? cue.dataset.mainIdx))
    .filter((index, position, values) => (
      Number.isInteger(index)
      && !isHiddenDisabled(index, track)
      && values.indexOf(index) === position
    ));
  const index = boundary === 'first' ? indexes[0] : indexes[indexes.length - 1];
  if (!Number.isInteger(index)) return null;
  const cue = container.querySelector(
    target?.kind === 'extension'
      ? `.multi-dual-cue[data-ext-idx="${index}"], .multi-extension-cue[data-ext-idx="${index}"]`
      : `.cue[data-idx="${index}"], .multi-dual-cue[data-main-idx="${index}"]`,
  );
  return cue ? { cue, index } : null;
}

function navigateCueListBoundary(key) {
  const target = getCurrentCuePanelTarget();
  if (!target) return false;
  const boundary = renderedCueBoundaryTarget(target, key === 'Home' ? 'first' : 'last');
  if (!boundary) return false;
  if (target.kind === 'extension') {
    selectOnlyExtension(boundary.index, target.track);
    lastClickedExtensionIdx = boundary.index;
  } else {
    selectOnly(boundary.index);
    lastClickedIdx = boundary.index;
  }
  scrollCueToCenter(boundary.cue);
  return true;
}

// Home/End：字幕列表最近拥有导航时选择当前轨道首尾；波形、播放器或尚未
// 确定区域时跳转媒体首尾。文本输入、普通按钮和模态窗口保留原生行为。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Home' && e.key !== 'End') return;
  if (editingState || extensionEditingState || isTextEditingTarget(e)) return;
  if (!isPlaybackKeyboardTarget(e) && isNativeKeyboardControl(e)) return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  if (replaceModal.classList.contains('show') || stickerModal.classList.contains('show')
      || stickerPreviewModal.classList.contains('show') || projectMediaModal.classList.contains('show')
      || multiSubtitleSplitModal?.classList.contains('show')
      || multiSubtitleImportModal?.classList.contains('show')
      || document.getElementById('sticker-root-modal').classList.contains('show')
      || ctxmenu.classList.contains('show')) return;
  if (navigationOwner === 'cue-list' && navigateCueListBoundary(e.key)) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  const duration = Number(player?.duration);
  if (!hasLoadedMedia() || !Number.isFinite(duration) || duration <= 0) return;
  e.preventDefault();
  e.stopPropagation();
  seekMediaTo(e.key === 'Home' ? 0 : duration);
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

function subtitleTemporalOverlap(left, right) {
  if (!left || !right) return 0;
  return Math.max(0, Math.min(Number(left.end), Number(right.end))
    - Math.max(Number(left.start), Number(right.start)));
}

function nearestSubtitleIndex(segments, source, track = 'main') {
  const candidates = (segments || [])
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment, index }) => segment && !isHiddenDisabled(index, track));
  candidates.sort((left, right) => {
    const leftOverlap = subtitleTemporalOverlap(left.segment, source);
    const rightOverlap = subtitleTemporalOverlap(right.segment, source);
    const leftHasOverlap = leftOverlap > 0 ? 0 : 1;
    const rightHasOverlap = rightOverlap > 0 ? 0 : 1;
    if (leftHasOverlap !== rightHasOverlap) return leftHasOverlap - rightHasOverlap;
    if (leftOverlap !== rightOverlap) return rightOverlap - leftOverlap;
    const leftDistance = Math.abs(Number(left.segment.start) - Number(source.start));
    const rightDistance = Math.abs(Number(right.segment.start) - Number(source.start));
    return leftDistance - rightDistance || left.index - right.index;
  });
  return candidates[0]?.index ?? -1;
}

function boundSegmentIndex(binding, ids, segments) {
  for (const id of ids || []) {
    const index = (segments || []).findIndex((segment) => segment?.id === id);
    if (index >= 0) return index;
  }
  return -1;
}

function switchMultiSubtitleTrack(direction) {
  if (!multiSubtitleVisible()) return false;
  const current = getCurrentCuePanelTarget();
  if (!current) return false;
  const wantMain = direction < 0;
  if ((wantMain && current.kind === 'main') || (!wantMain && current.kind === 'extension')) return false;

  const extensionTrack = getActiveExtensionTrack();
  let nextIndex = -1;
  if (wantMain) {
    const binding = bindingForExtensionIndex(current.index, current.track);
    nextIndex = boundSegmentIndex(binding, binding?.main_segment_ids, DATA.segments);
    if (nextIndex < 0) nextIndex = nearestSubtitleIndex(DATA.segments, current.segment, 'main');
  } else {
    const binding = bindingForMainIndex(current.index);
    const bindingTrack = binding ? getExtensionTrack(binding.track_id) : null;
    if (bindingTrack?.id === extensionTrack?.id) {
      nextIndex = boundSegmentIndex(binding, binding?.extension_segment_ids, extensionTrack.segments);
    }
    if (nextIndex < 0) {
      nextIndex = nearestSubtitleIndex(extensionTrack?.segments, current.segment, 'extension');
    }
  }
  if (nextIndex < 0) return false;

  if (wantMain) {
    selectOnly(nextIndex);
    lastClickedIdx = nextIndex;
  } else {
    selectOnlyExtension(nextIndex, extensionTrack);
    lastClickedExtensionIdx = nextIndex;
  }
  const cue = container.querySelector(
    wantMain
      ? `.cue[data-idx="${nextIndex}"], .multi-dual-cue[data-main-idx="${nextIndex}"]`
      : `.multi-dual-cue[data-ext-idx="${nextIndex}"], .multi-extension-cue[data-ext-idx="${nextIndex}"]`,
  );
  if (cue) scrollCueIntoViewIfNeeded(cue);
  return true;
}

// 多重字幕下，上/下只切换当前操作轨道；优先使用绑定关系，没有绑定时
// 选择时间范围重叠最多、否则距离最近的另一轨字幕，不改变播放头位置。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  if (editingState || extensionEditingState || isTextEditingTarget(e)) return;
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  if (isNativeKeyboardControl(e) || isPlayerKeyboardTarget(e)) return;
  if (replaceModal.classList.contains('show') || stickerModal.classList.contains('show')
      || stickerPreviewModal.classList.contains('show') || projectMediaModal.classList.contains('show')
      || multiSubtitleSplitModal?.classList.contains('show')
      || document.getElementById('sticker-root-modal').classList.contains('show')
      || ctxmenu.classList.contains('show')) return;
  if (!switchMultiSubtitleTrack(e.key === 'ArrowUp' ? -1 : 1)) return;
  e.preventDefault();
  e.stopPropagation();
}, true);

// 鼠标点击按钮后不保留按钮焦点，否则下一次空格会触发按钮自身的 click。
// 键盘触发的 click detail 为 0，保留焦点以维持原生键盘可访问性。
document.addEventListener('click', (event) => {
  if (event.detail === 0) return;
  const target = event.target instanceof Element ? event.target : null;
  target?.closest('button')?.blur();
}, true);

function showShortcutBlocked(message) {
  flashHint(message, 'invalid');
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
  // 拆分弹窗内空格用于确认/取消断点，交给弹窗自己的键盘处理。
  if (multiSubtitleSplitModal?.classList.contains('show')) return;
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

// J/K/L 播放控制的两种模式：旧模式是慢速/重置/倍速；新模式是倒放/停止/1×播放。
// HTML5 playbackRate 多数浏览器钳在 [0.0625, 16]，反向播放由时间轴驱动。
const PLAYBACK_RATE_MIN = 0.0625;
const PLAYBACK_RATE_MAX = 16;
const JKL_PLAYBACK_RATE_STEPS = [1, 2, 4, 8, 16];
function fmtRate(r) {
  // 保留必要小数位：0.5/2/4 不带小数；0.25/0.0625 带
  if (Number.isInteger(r)) return r + '×';
  // 去掉尾部 0
  return r.toFixed(4).replace(/0+$/, '').replace(/\.$/, '') + '×';
}
function nextJklDirectionRate(current, direction) {
  const rate = Number.isFinite(current) && current !== 0 ? current : 1;
  const magnitude = Math.abs(rate);
  let stepIndex = 0;
  let smallestDistance = Infinity;
  JKL_PLAYBACK_RATE_STEPS.forEach((step, index) => {
    const distance = Math.abs(step - magnitude);
    if (distance < smallestDistance) {
      smallestDistance = distance;
      stepIndex = index;
    }
  });
  if (direction < 0) {
    if (rate < 0) return -JKL_PLAYBACK_RATE_STEPS[Math.min(stepIndex + 1, JKL_PLAYBACK_RATE_STEPS.length - 1)];
    if (stepIndex === 0) return -1;
    return JKL_PLAYBACK_RATE_STEPS[stepIndex - 1];
  }
  if (rate < 0) {
    if (stepIndex === 0) return 1;
    return -JKL_PLAYBACK_RATE_STEPS[stepIndex - 1];
  }
  return JKL_PLAYBACK_RATE_STEPS[Math.min(stepIndex + 1, JKL_PLAYBACK_RATE_STEPS.length - 1)];
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
  const k = e.key.toLowerCase();
  if (isJklDirectionMode()) {
    if (k === 'k') {
      const wasPlaying = jklReversePlaying || !player.paused;
      if (!wasPlaying) {
        jklPlaybackRate = 1;
        player.playbackRate = 1;
        if (playJklForward()) flashHint('正放: 1×');
        return;
      }
      stopJklReversePlayback({ render: false });
      jklPlaybackRate = 1;
      player.playbackRate = 1;
      player.pause();
      update();
      waveformEditor?.updatePlayback();
      syncMediaControls();
      flashHint('已停止');
      return;
    }
    if (!hasLoadedMedia()) {
      flashHint('请先加载媒体，然后才能预览', 'invalid');
      return;
    }
    jklPlaybackRate = nextJklDirectionRate(jklPlaybackRate, k === 'j' ? -1 : 1);
    if (jklPlaybackRate < 0) startJklReversePlayback();
    else playJklForward();
    flashHint(`${jklPlaybackRate < 0 ? '倒放' : '正放'}: ${fmtRate(jklPlaybackRate)}`);
    return;
  }
  let r = player.playbackRate;
  if (k === 'k') r = 1;
  else if (k === 'j') r = Math.max(PLAYBACK_RATE_MIN, r * 0.5);
  else if (k === 'l') r = Math.min(PLAYBACK_RATE_MAX, r * 2);
  player.playbackRate = r;
  syncMediaControls();
  flashHint(`倍速: ${fmtRate(r)}`);
});

// A/D（或 W/S）：跳转到上一条/下一条字幕的句首并单选。W/S 与 A/D 等价，对应上下方向。
// Shift+A/D（或 Shift+W/S）：保留当前选择，并向前/后追加选择一条字幕。
// 播放中以播放头所在字幕为基准；播放头处于空隙时，按方向选择其前方/后方字幕。
// 暂停时仍以当前选中字幕为基准。跳转本身不改变播放状态。
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
  if (multiSubtitleSplitModal?.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (ctxmenu.classList.contains('show')) return;
  if (e.ctrlKey || e.metaKey) return;
  const direction = (key === 'a' || key === 'w') ? -1 : 1;
  const panelTarget = getCurrentCuePanelTarget();
  const extensionTarget = panelTarget?.kind === 'extension';
  const extensionTrack = extensionTarget ? panelTarget.track : null;
  const segments = extensionTarget ? extensionTrack.segments : DATA.segments;
  const wasPlaying = !player.paused;
  const heldCueKey = (!e.shiftKey || key === 'a' || key === 'd')
    && waveformEditor?.handleHeldCueKey?.(
      direction,
      direction * EDITOR_SETTINGS.cueMoveStepMs,
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
    : (extensionTarget ? panelTarget?.index ?? -1 : currentCuePanelIdx);
  let next = e.shiftKey
    ? window.AsrEditorUtils.findCueSelectionExtensionTarget(
      segments,
      extensionTarget ? selectedExtensionIdxs : selectedIdxs,
      navigationIndex,
      Math.round(player.currentTime * 1000),
      direction,
      hideDisabled,
    )
    : window.AsrEditorUtils.findCueNavigationTarget(
      segments,
      navigationIndex,
      Math.round(player.currentTime * 1000),
      direction,
      hideDisabled,
    );
  if (next < 0) {
    const eligible = segments
      .map((segment, index) => ({ segment, index }))
      .filter(({ segment }) => segment && (!hideDisabled || !segment.disabled));
    next = direction < 0
      ? (eligible[0]?.index ?? -1)
      : (eligible[eligible.length - 1]?.index ?? -1);
  }
  if (next < 0) return;

  e.preventDefault();
  e.stopPropagation();
  if (extensionTarget) {
    if (e.shiftKey) addExtensionToSelection(next, extensionTrack);
    else selectOnlyExtension(next);
    lastClickedExtensionIdx = next;
  } else {
    if (e.shiftKey) addToSelection(next);
    else selectOnly(next);
    lastClickedIdx = next;
  }
  const cue = container.querySelector(
    extensionTarget
      ? `.multi-dual-cue[data-ext-idx="${next}"], .multi-extension-cue[data-ext-idx="${next}"]`
      : `.cue[data-idx="${next}"], .multi-dual-cue[data-main-idx="${next}"]`,
  );
  if (cue) scrollCueToCenter(cue);
  waveformEditor?.revealTime(segments[next].start, true);
  seekFromWaveform(segments[next].start / 1000);
  if (wasPlaying && player.paused) {
    const promise = player.play();
    if (promise && promise.catch) promise.catch(() => {});
  }
});

function mergeAdjacentSubtitle(direction) {
  const target = getCurrentCuePanelTarget();
  const extension = target?.kind === 'extension';
  const track = extension ? target.track : null;
  const segments = extension ? track?.segments || [] : DATA.segments;
  let index = Number.isInteger(target?.index) ? target.index : -1;
  if (index < 0) {
    const selected = extension ? selectedExtensionIdxs : selectedIdxs;
    if (selected.size === 1) index = [...selected][0];
    else index = extension ? lastClickedExtensionIdx : lastClickedIdx;
  }
  const neighbor = index + direction;
  if (!segments[index] || !segments[neighbor]) {
    flashHint(direction < 0 ? '前面没有可粘合的字幕' : '后面没有可粘合的字幕', 'warning');
    return false;
  }
  const indices = direction < 0 ? [neighbor, index] : [index, neighbor];
  if (extension) return mergeExtensionSegments(indices, track);
  mergeSegments(indices);
  return true;
}

// Ctrl(Cmd)+Shift+A/D：把当前主/副字幕与前一条/后一条直接粘合。
// 不改变 Ctrl(Cmd)+A/D 的全选与清除选择语义。
document.addEventListener('keydown', (e) => {
  if (!['a', 'A', 'd', 'D'].includes(e.key)) return;
  if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || e.repeat) return;
  if (editingState || e.target === cuePanelText) return;
  const active = document.activeElement;
  if (active && (
    active.tagName === 'INPUT' || active.tagName === 'TEXTAREA'
      || active.tagName === 'SELECT' || active.isContentEditable
  )) return;
  if (replaceModal.classList.contains('show') || stickerModal.classList.contains('show')
      || stickerPreviewModal.classList.contains('show') || projectMediaModal.classList.contains('show')
      || document.getElementById('sticker-root-modal').classList.contains('show')
      || ctxmenu.classList.contains('show')) return;
  e.preventDefault();
  e.stopPropagation();
  mergeAdjacentSubtitle(e.key.toLowerCase() === 'a' ? -1 : 1);
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
  if (selectedIdxs.size === 0 && selectedExtensionIdxs.size === 0) return;
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

// Enter：聚焦最后点击的主/副字幕对应的字幕编辑区，并把光标置于末尾。
// 绑定字幕同时选中时仍以最后点击的一侧为准；内联编辑态、已聚焦编辑区或模态打开时不触发。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (editingState || extensionEditingState) return;  // 内联编辑态的 Enter 交给 split/commit 处理
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
  if (!getCurrentCuePanelTarget()) {
    e.preventDefault();
    e.stopPropagation();
    showShortcutBlocked('请先选中字幕');
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  focusCuePanelText();
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
  const currentTarget = getCurrentCuePanelTarget();
  if (
    selectedExtensionIdxs.size > 0
    && (currentTarget?.kind === 'extension' || selectedIdxs.size === 0)
  ) {
    mergeExtensionSegments(
      [...selectedExtensionIdxs],
      currentTarget?.kind === 'extension' ? currentTarget.track : getActiveExtensionTrack(),
    );
    return;
  }
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
  if (selectedIdxs.size === 0 && selectedExtensionIdxs.size > 0) {
    e.preventDefault();
    e.stopPropagation();
    deleteExtensionSegments([...selectedExtensionIdxs]);
    return;
  }
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
  const target = getCurrentCuePanelTarget();
  const extensionTarget = target?.kind === 'extension';
  const selected = extensionTarget ? selectedExtensionIdxs : selectedIdxs;
  const segments = extensionTarget ? target.track.segments : DATA.segments;
  if (!selected.size) return;
  const first = Math.min(...selected);
  const segment = segments[first];
  if (!segment) return;
  seekFromWaveform(segment.start / 1000);
  if (player.paused) togglePlayback();
});

// N：仅在鼠标位于波形行时，从指针音频位置创建字幕；创建后单选新字幕，
// 切换当前字幕面板并聚焦面板文本框。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'n' && e.key !== 'N') return;
  if (editingState || e.repeat || isTextEditingTarget(e)) return;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return;
  if (replaceModal.classList.contains('show')) return;
  if (stickerModal.classList.contains('show')) return;
  if (stickerPreviewModal.classList.contains('show')) return;
  if (projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (ctxmenu.classList.contains('show')) return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  const reference = keyboardOperationReference();
  if (!reference) {
    flashHint('无有效的快捷键时间基准', 'invalid');
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  lastEditRegion = 'waveform';
  if (reference.track === 'extension' && multiSubtitleVisible()) {
    addExtensionAtWaveformTime(reference.timeMs, lastPointerPos?.x || 0, lastPointerPos?.y || 0, getExtensionTrack(reference.trackId));
  } else {
    addCueAtWaveformTime(reference.timeMs, lastPointerPos?.x || 0, lastPointerPos?.y || 0);
  }
});

// G：绑定当前单选的副字幕。若同时选中一条主字幕则直接绑定，否则沿用
// 右键「绑定到主字幕」的自动匹配/等待选择流程。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'g' && e.key !== 'G') return;
  if (editingState || extensionEditingState || e.repeat) return;
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
  if (!multiSubtitleVisible()) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  if (selectedExtensionIdxs.size !== 1) {
    e.preventDefault();
    e.stopPropagation();
    showShortcutBlocked('请先选中一条副字幕');
    return;
  }
  if (selectedIdxs.size > 1) {
    e.preventDefault();
    e.stopPropagation();
    showShortcutBlocked('绑定最多需要一条主字幕');
    return;
  }
  const extensionIndex = [...selectedExtensionIdxs][0];
  const track = getActiveExtensionTrack();
  const extension = track?.segments?.[extensionIndex];
  const binding = bindingForExtensionIndex(extensionIndex, track);
  if (!extension) {
    e.preventDefault();
    e.stopPropagation();
    showShortcutBlocked('当前副字幕不存在');
    return;
  }
  if (e.shiftKey) {
    e.preventDefault();
    e.stopPropagation();
    if (!binding) {
      flashHint('当前副字幕没有绑定关系', 'invalid');
      return;
    }
    unbindSelectedSubtitlePair();
    return;
  }
  if (e.shiftKey) return;
  if (binding) {
    e.preventDefault();
    e.stopPropagation();
    showShortcutBlocked('当前副字幕已绑定，请先解绑后再绑定');
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  if (selectedIdxs.size === 1) {
    bindSelectedSubtitlePair();
  } else {
    beginPendingExtensionBinding(extensionIndex, track);
  }
});

// H：把当前选中的副字幕批量对齐到各自绑定的主字幕时间轴。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'h' && e.key !== 'H') return;
  if (editingState || extensionEditingState || e.repeat) return;
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
  if (!multiSubtitleVisible()) return;
  if (!selectedExtensionIdxs.size) {
    e.preventDefault();
    e.stopPropagation();
    showShortcutBlocked('请先选中至少一条副字幕');
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  alignSelectedExtensionSubtitleRanges();
});

// B：按指针所在区域分发——
// 1) 鼠标悬停在已单选的字幕列表行上：按指针对应的文字位置拆分；
// 2) 鼠标位于波形上：按指针的音频位置拆分（与波形右键「按音频位置拆分」一致）；
// 3) 其它位置：按红色播放指针位置拆分（B 的原始行为）。
// 文本编辑、弹窗和修饰键状态下不抢占输入。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'b' && e.key !== 'B') return;
  if (e.repeat) return;
  const forceMainEdit = editingState?.forceSplitArmed === true;
  if (extensionEditingState && !forceMainEdit) {
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    const state = extensionEditingState;
    const offset = caretOffsetInText(state.textEl);
    const track = getExtensionTrack(state.trackId);
    if (!Number.isFinite(offset) || !track?.segments?.[state.index]) {
      flashHint('无法定位副字幕的文字光标', 'warning');
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    // 先在编辑 DOM 消失前记录列表内光标位置，弹窗提交后的刀光留在原位。
    const editFeedbackPoint = ninjaSplitPointFromRange(
      null, state.textEl, offset, String(state.textEl.innerText || '').length,
    );
    finishExtensionEdit(true);
    openExtensionSplitModal(state.index, null, track, {
      extensionOffset: offset,
      feedbackPoint: editFeedbackPoint,
      ninjaFromList: true,
    });
    return;
  }
  if (editingState && !forceMainEdit) return;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT'
    || (a.isContentEditable && !forceMainEdit))) return;
  if (replaceModal.classList.contains('show')) return;
  if (stickerModal.classList.contains('show')) return;
  if (stickerPreviewModal.classList.contains('show')) return;
  if (projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (ctxmenu.classList.contains('show')) return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  if (forceMainEdit) {
    e.preventDefault();
    e.stopImmediatePropagation();
    splitAtCursor();
    return;
  }
  const splitAt = (idx, x, y, timeMs) => {
    e.preventDefault();
    // B 打开弹窗后，事件仍会继续传播到后面注册的弹窗快捷键监听器；
    // 立即停止同一事件，避免“按 B 打开”被误当成“按 B 确认”。
    e.stopImmediatePropagation();
    splitFromContextMenu(idx, x, y, timeMs);
  };
  // 多重字幕下，只有副字幕是当前编辑焦点时，B 才直接打开副字幕拆分流程。
  // 绑定关系会让点击主字幕时同时选中副字幕；不能仅凭 selectedExtensionIdxs
  // 判断当前轨道，否则主字幕 active 时会被误判成副字幕单独拆分。
  const activeCuePanel = getCurrentCuePanelTarget();
  const operationReference = keyboardOperationReference();
  const pointerMainIndex = operationReference
    ? findWaveformCueAtTime(operationReference.timeMs, DATA.segments) : -1;
  const activeExtensionTrack = getActiveExtensionTrack();
  const pointerExtensionIndex = operationReference?.track === 'extension'
    ? findWaveformCueAtTime(operationReference.timeMs, getExtensionTrack(operationReference.trackId)?.segments) : -1;
  if (selectedExtensionIdxs.size === 1) {
    const context = hoveredSelectedCueContext();
    if (context?.kind === 'extension' && context.track?.segments?.[context.idx]) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const initial = Number.isFinite(context.offset)
        ? {
          extensionOffset: context.offset,
          feedbackPoint: context.caretRect ? ninjaSplitPointFromRect(context.caretRect) : null,
          ninjaFromList: true,
        } : {};
      openExtensionSplitModal(context.idx, null, context.track, initial);
      return;
    }
  }
  // 波形区点击副字幕后，绑定关系可能同时选中主字幕；但只要当前面板和
  // 波形指针都明确落在这条单选副字幕上，B 就应拆分副字幕，而不是被重叠
  // 的主字幕时间范围抢走目标。主字幕面板仍不会进入这个例外分支。
  const waveformExtensionIsActive = multiSubtitleVisible()
    && activeCuePanel?.kind === 'extension'
    && selectedExtensionIdxs.size === 1
    && selectedExtensionIdxs.has(activeCuePanel.index)
    && operationReference?.track === 'extension'
    && pointerExtensionIndex === activeCuePanel.index;
  const extensionIsActive = multiSubtitleVisible()
    && activeCuePanel?.kind === 'extension'
    && selectedExtensionIdxs.size === 1
    && selectedExtensionIdxs.has(activeCuePanel.index)
    && (!operationReference || pointerMainIndex < 0 || waveformExtensionIsActive);
  if (extensionIsActive) {
    const extensionIndex = [...selectedExtensionIdxs][0];
    const track = activeExtensionTrack;
    const extension = track?.segments?.[extensionIndex];
    if (!extension) return;
    let timeMs = null;
    const pointerElement = lastPointerPos
      ? document.elementFromPoint(lastPointerPos.x, lastPointerPos.y)
      : null;
    if (EDITOR_SETTINGS.keyboardOperationReference === 'pointer'
        && lastPointerPos && (pointerElement?.closest('#waveform-pane') || lastEditRegion === 'waveform')) {
      const pointerTimeMs = waveformEditor?.timeMsAtPoint?.(lastPointerPos.x, lastPointerPos.y);
      if (Number.isFinite(pointerTimeMs) && pointerTimeMs > extension.start && pointerTimeMs < extension.end) {
        timeMs = pointerTimeMs;
      }
    }
    e.preventDefault();
    // 同上：首次 B 只负责打开副字幕拆分弹窗。
    e.stopImmediatePropagation();
    openExtensionSplitModal(
      extensionIndex,
      EDITOR_SETTINGS.keyboardOperationReference === 'playhead'
        ? operationReference?.timeMs ?? null : timeMs,
      track,
    );
    return;
  }
  // 1) 字幕列表：需要单选 + 悬停提供文字位置
  if (selectedIdxs.size === 1) {
    const context = hoveredSelectedCueContext();
    if (context && DATA.segments[context.idx]) {
      splitAt(context.idx, context.x, context.y, null);
      return;
    }
  }
  // 2) 波形：指针音频位置
  if (operationReference?.source === 'pointer' || operationReference?.track === 'extension') {
    const idx = findWaveformCueAtTime(operationReference.timeMs, DATA.segments);
    if (idx >= 0) {
      splitAt(idx, 0, 0, operationReference.timeMs);
      return;
    }
    const extensionTrack = getActiveExtensionTrack();
    const extensionIndex = multiSubtitleVisible() && operationReference.track === 'extension'
      ? findWaveformCueAtTime(operationReference.timeMs, getExtensionTrack(operationReference.trackId)?.segments) : -1;
    if (extensionIndex >= 0) {
      e.preventDefault();
      e.stopImmediatePropagation();
      openExtensionSplitModal(extensionIndex, operationReference.timeMs, getExtensionTrack(operationReference.trackId));
      return;
    }
    flashHint('指针位置没有可拆分字幕', 'invalid');
    return;
  }
  // 3) 播放头位置
  const timeMs = operationReference?.timeMs ?? Math.round(player.currentTime * 1000);
  const idx = DATA.segments.findIndex((segment) => timeMs > segment.start && timeMs < segment.end);
  if (idx >= 0) {
    splitAt(idx, 0, 0, timeMs);
    return;
  }
  const extensionTrack = getActiveExtensionTrack();
  const extensionIndex = multiSubtitleVisible()
    ? findWaveformCueAtTime(timeMs, extensionTrack?.segments) : -1;
  if (extensionIndex >= 0) {
    e.preventDefault();
    e.stopImmediatePropagation();
    openExtensionSplitModal(extensionIndex, timeMs, extensionTrack);
    return;
  }
  flashHint('播放头位置没有可拆分字幕', 'invalid');
});

// 点击输入框外 -> 完成内联编辑。使用 pointerdown 捕获阶段，确保字幕行、
// 波形或其它控件的 pointerdown 处理/重绘发生前，当前文字已经写回 DATA。
// 双列时编辑行的容器同时包含主/副两列，因此只判断当前 contenteditable。
document.addEventListener('pointerdown', (e) => {
  const target = e.target instanceof Node ? e.target : null;
  if (editingState && (!target || !editingState.textEl.contains(target))) finishEdit(true);
  if (extensionEditingState && (
    !target || !extensionEditingState.textEl.contains(target)
  )) finishExtensionEdit(true);
}, true);

// === 字幕预览几何（preview.subtitle）===
// 归一化 {x,y,width,height} 存于 DATA.preview.subtitle。纯钳制/归一化逻辑在
// AsrEditorUtils（已单测）；这里只负责 DOM 应用、指针/键盘手势、每手势一条撤销、脏标记。
const GEO_UTILS = window.AsrEditorUtils;
let previewGeometryDirty = false;

function getPreviewGeometry() {
  return GEO_UTILS.normalizePreviewGeometry(DATA.preview?.subtitle);
}
function normalizeSubtitleFontFamilyName(value) {
  if (typeof value !== 'string') return null;
  const family = value.trim();
  if (!family || family.length > SUBTITLE_FONT_FAMILY_MAX_LENGTH
      || /[\u0000-\u001f\u007f]/u.test(family)) return null;
  return family;
}
function normalizeSubtitleBackgroundColor(value) {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/iu.test(value)) return null;
  return value.toLowerCase();
}
function normalizeSubtitleBackgroundAlpha(value) {
  return typeof value === 'number' && Number.isFinite(value)
    && SUBTITLE_BACKGROUND_ALPHA_MIN <= value && value <= SUBTITLE_BACKGROUND_ALPHA_MAX
    ? value : null;
}
function subtitleBackgroundCss(appearance) {
  const color = appearance.background_color || SUBTITLE_BACKGROUND_COLOR_DEFAULT;
  const channels = [color.slice(1, 3), color.slice(3, 5), color.slice(5, 7)]
    .map((channel) => Number.parseInt(channel, 16)).join(', ');
  const alpha = appearance.background_alpha ?? SUBTITLE_BACKGROUND_ALPHA_DEFAULT;
  return `rgba(${channels}, ${alpha})`;
}
function isBuiltInSubtitleFontFamily(value) {
  return Object.prototype.hasOwnProperty.call(SUBTITLE_FONT_FAMILY_CSS, value);
}
function quoteCssString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
function subtitleFontFamilyCss(value) {
  if (!value || value === 'default') return '';
  if (isBuiltInSubtitleFontFamily(value)) return SUBTITLE_FONT_FAMILY_CSS[value];
  return `${quoteCssString(value)}, var(--font-sans)`;
}
const SUBTITLE_FONT_FAMILY_STATUS_TEXT = Object.freeze({
  zh: Object.freeze({
    idle: '点击读取本机字体（首次需要授权）',
    reading: '正在读取本机字体…',
    success: (count) => `已读取 ${count} 种本机字体`,
    empty: '未读取到可用的本机字体',
    unsupported: '当前环境不支持自动读取本机字体',
    denied: '未获准读取本机字体',
    failed: '读取本机字体失败，请重试',
  }),
  en: Object.freeze({
    idle: 'Click to read local fonts (permission required the first time)',
    reading: 'Reading local fonts…',
    success: (count) => `Read ${count} local font families`,
    empty: 'No usable local fonts were returned',
    unsupported: 'This environment cannot list local fonts automatically',
    denied: 'Permission to read local fonts was not granted',
    failed: 'Could not read local fonts; try again',
  }),
});
let subtitleFontFamilyScanState = 'idle';
let subtitleFontFamilyScanCount = 0;
function renderSubtitleFontFamilyStatus() {
  if (!subtitleFontFamilyStatus) return;
  const language = window.MAWE_I18N?.language === 'en' ? 'en' : 'zh';
  const text = SUBTITLE_FONT_FAMILY_STATUS_TEXT[language][subtitleFontFamilyScanState];
  subtitleFontFamilyStatus.textContent = typeof text === 'function'
    ? text(subtitleFontFamilyScanCount) : text;
}
function setSubtitleFontFamilyScanState(state, count = 0) {
  subtitleFontFamilyScanState = state;
  subtitleFontFamilyScanCount = count;
  renderSubtitleFontFamilyStatus();
}
function subtitleFontFamilyOptionExists(select, value) {
  return !!select && Array.from(select.options).some((option) => option.value === value);
}
function subtitleFontFamilyDisplayName(family) {
  const language = window.MAWE_I18N?.language === 'en' ? 'en' : 'zh';
  return GEO_UTILS.subtitleFontFamilyDisplayName(family, language);
}
function relabelSubtitleFontFamilyOptions() {
  [subtitleFontFamilySelect, extensionSubtitleFontFamilySelect].filter(Boolean).forEach((select) => {
    Array.from(select.querySelectorAll('option[data-local-font="true"], option[data-generated="true"]')).forEach((option) => {
      option.textContent = subtitleFontFamilyDisplayName(option.value);
    });
  });
}
function normalizeSubtitleColor(value) {
  if (typeof value !== 'string') return null;
  const color = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/i.test(color) ? color : null;
}
function normalizeSubtitleAppearance(value) {
  const result = {};
  const fontSize = value && typeof value.font_size === 'number' && Number.isFinite(value.font_size)
    ? Math.round(value.font_size) : null;
  if (fontSize !== null && fontSize >= SUBTITLE_FONT_SIZE_MIN && fontSize <= SUBTITLE_FONT_SIZE_MAX) {
    result.font_size = fontSize;
  }
  const fontFamily = normalizeSubtitleFontFamilyName(value?.font_family);
  if (fontFamily) result.font_family = fontFamily;
  const backgroundColor = normalizeSubtitleBackgroundColor(value?.background_color);
  if (backgroundColor) result.background_color = backgroundColor;
  const backgroundAlpha = normalizeSubtitleBackgroundAlpha(value?.background_alpha);
  if (backgroundAlpha !== null) result.background_alpha = backgroundAlpha;
  const color = normalizeSubtitleColor(value?.color);
  if (color) result.color = color;
  return result;
}
function getSubtitleAppearance(value = DATA.preview?.subtitle) {
  const result = normalizeSubtitleAppearance(value);
  return { ...result, color: result.color || DEFAULT_SUBTITLE_COLOR };
}
function getStoredExtensionSubtitleAppearance(value = DATA.preview?.extension_subtitle) {
  return normalizeSubtitleAppearance(value);
}
function getExtensionSubtitleDefaultFontSize() {
  const mainSize = getSubtitleAppearance().font_size || SUBTITLE_DEFAULT_FONT_SIZE;
  return Math.max(SUBTITLE_FONT_SIZE_MIN, mainSize - 2);
}
function getExtensionSubtitleAppearance(value = DATA.preview?.extension_subtitle) {
  const result = getStoredExtensionSubtitleAppearance(value);
  return {
    ...result,
    font_size: result.font_size || getExtensionSubtitleDefaultFontSize(),
    color: result.color || DEFAULT_EXTENSION_SUBTITLE_COLOR,
  };
}
function syncSubtitleFontSizeSelect(select, sizeValue) {
  if (!select) return;
  const size = Number.isFinite(Number(sizeValue)) ? String(Math.round(Number(sizeValue))) : 'auto';
  select.querySelectorAll('option[data-generated="true"]').forEach((option) => option.remove());
  if (size !== 'auto' && !Array.from(select.options).some((option) => option.value === size)) {
    const option = document.createElement('option');
    option.value = size;
    option.textContent = `${size} px`;
    option.dataset.generated = 'true';
    select.append(option);
  }
  select.value = size;
}
function syncSubtitleAppearanceControls(appearance = getSubtitleAppearance()) {
  syncSubtitleFontSizeSelect(subtitleFontSizeSelect, appearance.font_size);
  if (subtitleFontFamilySelect) {
    subtitleFontFamilySelect.querySelectorAll('option[data-generated="true"]').forEach((option) => option.remove());
    const family = appearance.font_family || 'default';
    if (family !== 'default' && !isBuiltInSubtitleFontFamily(family)
        && !subtitleFontFamilyOptionExists(subtitleFontFamilySelect, family)) {
      const option = document.createElement('option');
      option.value = family;
      option.textContent = subtitleFontFamilyDisplayName(family);
      option.dataset.generated = 'true';
      subtitleFontFamilySelect.append(option);
    }
    subtitleFontFamilySelect.value = family;
    if (subtitleFontFamilySelect.value !== family) subtitleFontFamilySelect.value = 'default';
  }
  if (subtitleBackgroundColorInput) {
    subtitleBackgroundColorInput.value = appearance.background_color
      || SUBTITLE_BACKGROUND_COLOR_DEFAULT;
  }
  if (subtitleBackgroundAlphaInput) {
    const alpha = appearance.background_alpha ?? SUBTITLE_BACKGROUND_ALPHA_DEFAULT;
    subtitleBackgroundAlphaInput.value = String(alpha);
    if (subtitleBackgroundAlphaValue) {
      subtitleBackgroundAlphaValue.textContent = `${Math.round(alpha * 100)}%`;
    }
  }
  if (subtitleColorInput) subtitleColorInput.value = appearance.color || DEFAULT_SUBTITLE_COLOR;
}
function syncExtensionSubtitleAppearanceControls() {
  const stored = getStoredExtensionSubtitleAppearance();
  const appearance = getExtensionSubtitleAppearance();
  syncSubtitleFontSizeSelect(extensionSubtitleFontSizeSelect, stored.font_size);
  if (extensionSubtitleFontFamilySelect) {
    extensionSubtitleFontFamilySelect.querySelectorAll('option[data-generated="true"]')
      .forEach((option) => option.remove());
    const family = stored.font_family || 'default';
    if (family !== 'default' && !isBuiltInSubtitleFontFamily(family)
        && !subtitleFontFamilyOptionExists(extensionSubtitleFontFamilySelect, family)) {
      const option = document.createElement('option');
      option.value = family;
      option.textContent = subtitleFontFamilyDisplayName(family);
      option.dataset.generated = 'true';
      extensionSubtitleFontFamilySelect.append(option);
    }
    extensionSubtitleFontFamilySelect.value = family;
    if (extensionSubtitleFontFamilySelect.value !== family) extensionSubtitleFontFamilySelect.value = 'default';
  }
  if (extensionSubtitleColorInput) {
    extensionSubtitleColorInput.value = appearance.color || DEFAULT_EXTENSION_SUBTITLE_COLOR;
  }
  if (extensionSubtitleBackgroundColorInput) {
    extensionSubtitleBackgroundColorInput.value = appearance.background_color
      || SUBTITLE_BACKGROUND_COLOR_DEFAULT;
  }
  if (extensionSubtitleBackgroundAlphaInput) {
    const alpha = appearance.background_alpha ?? SUBTITLE_BACKGROUND_ALPHA_DEFAULT;
    extensionSubtitleBackgroundAlphaInput.value = String(alpha);
    if (extensionSubtitleBackgroundAlphaValue) {
      extensionSubtitleBackgroundAlphaValue.textContent = `${Math.round(alpha * 100)}%`;
    }
  }
}
function applySubtitleAppearance(value = DATA.preview?.subtitle) {
  const appearance = getSubtitleAppearance(value);
  overlayTextEl.style.setProperty(
    '--subtitle-preview-font-size',
    `${appearance.font_size || SUBTITLE_DEFAULT_FONT_SIZE}px`,
  );
  overlayTextEl.style.fontFamily = subtitleFontFamilyCss(appearance.font_family);
  const hasCustomBackground = Object.prototype.hasOwnProperty.call(appearance, 'background_color')
    || Object.prototype.hasOwnProperty.call(appearance, 'background_alpha');
  overlayTextEl.style.backgroundColor = hasCustomBackground ? subtitleBackgroundCss(appearance) : '';
  overlayTextEl.style.color = appearance.color || DEFAULT_SUBTITLE_COLOR;
  syncSubtitleAppearanceControls(appearance);
}
function applyExtensionSubtitleAppearance(value = DATA.preview?.extension_subtitle) {
  const appearance = getExtensionSubtitleAppearance(value);
  overlayExtensionTextEl.style.setProperty(
    '--subtitle-preview-font-size',
    `${appearance.font_size || EXTENSION_SUBTITLE_DEFAULT_FONT_SIZE}px`,
  );
  overlayExtensionTextEl.style.fontFamily = subtitleFontFamilyCss(appearance.font_family);
  const hasCustomBackground = Object.prototype.hasOwnProperty.call(appearance, 'background_color')
    || Object.prototype.hasOwnProperty.call(appearance, 'background_alpha');
  overlayExtensionTextEl.style.backgroundColor = hasCustomBackground
    ? subtitleBackgroundCss(appearance) : '';
  overlayExtensionTextEl.style.color = appearance.color || DEFAULT_EXTENSION_SUBTITLE_COLOR;
  syncExtensionSubtitleAppearanceControls();
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
  if (Object.prototype.hasOwnProperty.call(patch, 'background_color')) {
    const backgroundColor = normalizeSubtitleBackgroundColor(patch.background_color);
    if (!backgroundColor || backgroundColor === SUBTITLE_BACKGROUND_COLOR_DEFAULT) {
      delete next.background_color;
    } else {
      next.background_color = backgroundColor;
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'background_alpha')) {
    const backgroundAlpha = normalizeSubtitleBackgroundAlpha(patch.background_alpha);
    if (backgroundAlpha === null || backgroundAlpha === SUBTITLE_BACKGROUND_ALPHA_DEFAULT) {
      delete next.background_alpha;
    } else {
      next.background_alpha = backgroundAlpha;
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'color')) {
    const color = normalizeSubtitleColor(patch.color);
    if (color) next.color = color;
  }
  if (!DATA.preview || typeof DATA.preview !== 'object') DATA.preview = {};
  DATA.preview.subtitle = { ...getPreviewGeometry(), ...next };
  if (markDirty) previewGeometryDirty = true;
  applySubtitleAppearance(DATA.preview.subtitle);
  return next;
}
function collectSubtitleLocalFontFamilies(fontData) {
  const families = new Map();
  for (const entry of Array.isArray(fontData) ? fontData : []) {
    const family = normalizeSubtitleFontFamilyName(entry?.family);
    if (!family || isBuiltInSubtitleFontFamily(family)) continue;
    const key = family.toLocaleLowerCase();
    if (!families.has(key)) families.set(key, family);
  }
  return [...families.values()].sort((left, right) => left.localeCompare(right, undefined, {
    sensitivity: 'base',
  }));
}
function replaceSubtitleLocalFontOptions(families) {
  const selects = [subtitleFontFamilySelect, extensionSubtitleFontFamilySelect].filter(Boolean);
  if (!selects.length) return;
  selects.forEach((select) => {
    select.querySelectorAll(
      'option[data-local-font="true"], option[data-generated="true"]',
    ).forEach((option) => option.remove());
    const existing = new Set(Array.from(select.options, (option) => option.value));
    const fragment = document.createDocumentFragment();
    families.forEach((family) => {
      if (existing.has(family)) return;
      const option = document.createElement('option');
      option.value = family;
      option.textContent = subtitleFontFamilyDisplayName(family);
      option.dataset.localFont = 'true';
      fragment.append(option);
      existing.add(family);
    });
    select.append(fragment);
  });
  syncSubtitleAppearanceControls();
  syncExtensionSubtitleAppearanceControls();
  relabelSubtitleFontFamilyOptions();
}
function initializeSubtitleFontFamilyScanner() {
  if (!subtitleFontFamilyScanButton) return;
  if (typeof window.queryLocalFonts !== 'function') {
    subtitleFontFamilyScanButton.disabled = true;
    setSubtitleFontFamilyScanState('unsupported');
    return;
  }
  subtitleFontFamilyScanButton.disabled = false;
  setSubtitleFontFamilyScanState('idle');
  void restoreGrantedSubtitleLocalFonts();
}
async function restoreGrantedSubtitleLocalFonts() {
  if (typeof window.queryLocalFonts !== 'function' || !window.navigator?.permissions?.query) return;
  try {
    const permission = await window.navigator.permissions.query({ name: 'local-fonts' });
    if (permission.state === 'granted') await scanSubtitleLocalFonts({ silent: true });
  } catch (_) {
    // 未知权限名或当前 WebView 不允许静默查询时，保留手动扫描入口。
  }
}
async function scanSubtitleLocalFonts({ silent = false } = {}) {
  if (typeof window.queryLocalFonts !== 'function') {
    setSubtitleFontFamilyScanState('unsupported');
    return;
  }
  if (subtitleFontFamilyScanButton) subtitleFontFamilyScanButton.disabled = true;
  if (!silent) setSubtitleFontFamilyScanState('reading');
  try {
    const fontData = await window.queryLocalFonts();
    const families = collectSubtitleLocalFontFamilies(fontData);
    replaceSubtitleLocalFontOptions(families);
    setSubtitleFontFamilyScanState(families.length ? 'success' : 'empty', families.length);
  } catch (error) {
    if (!silent) {
      setSubtitleFontFamilyScanState(
        error?.name === 'NotAllowedError' || error?.name === 'SecurityError' ? 'denied' : 'failed',
      );
    }
  } finally {
    if (subtitleFontFamilyScanButton) subtitleFontFamilyScanButton.disabled = false;
  }
}
initializeSubtitleFontFamilyScanner();
function setExtensionSubtitleAppearance(patch, { markDirty = true } = {}) {
  const next = { ...getStoredExtensionSubtitleAppearance() };
  if (Object.prototype.hasOwnProperty.call(patch, 'font_size')) {
    if (patch.font_size === null || patch.font_size === 'auto') delete next.font_size;
    else Object.assign(next, normalizeSubtitleAppearance({ font_size: patch.font_size }));
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'font_family')) {
    if (!patch.font_family || patch.font_family === 'default') delete next.font_family;
    else Object.assign(next, normalizeSubtitleAppearance({ font_family: patch.font_family }));
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'background_color')) {
    const backgroundColor = normalizeSubtitleBackgroundColor(patch.background_color);
    if (!backgroundColor || backgroundColor === SUBTITLE_BACKGROUND_COLOR_DEFAULT) {
      delete next.background_color;
    } else {
      next.background_color = backgroundColor;
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'background_alpha')) {
    const backgroundAlpha = normalizeSubtitleBackgroundAlpha(patch.background_alpha);
    if (backgroundAlpha === null || backgroundAlpha === SUBTITLE_BACKGROUND_ALPHA_DEFAULT) {
      delete next.background_alpha;
    } else {
      next.background_alpha = backgroundAlpha;
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'color')) {
    const color = normalizeSubtitleColor(patch.color);
    if (color) next.color = color;
  }
  if (!DATA.preview || typeof DATA.preview !== 'object') DATA.preview = {};
  if (Object.keys(next).length) DATA.preview.extension_subtitle = next;
  else delete DATA.preview.extension_subtitle;
  if (markDirty) previewGeometryDirty = true;
  applyExtensionSubtitleAppearance(DATA.preview.extension_subtitle);
  return next;
}
function restoreExtensionSubtitleAppearance(value, { markDirty = true } = {}) {
  const next = normalizeSubtitleAppearance(value);
  if (!DATA.preview || typeof DATA.preview !== 'object') DATA.preview = {};
  if (Object.keys(next).length) DATA.preview.extension_subtitle = next;
  else delete DATA.preview.extension_subtitle;
  if (markDirty) previewGeometryDirty = true;
  applyExtensionSubtitleAppearance(DATA.preview.extension_subtitle);
}
// 写回 DATA.preview.subtitle 并刷新 DOM。markDirty=false 用于初次加载，不弄脏工程。
function setPreviewGeometry(geo, { markDirty = true, replaceAppearance = false } = {}) {
  const clamped = GEO_UTILS.clampPreviewGeometry(GEO_UTILS.normalizePreviewGeometry(geo));
  const appearance = replaceAppearance
    ? getSubtitleAppearance(geo)
    : { ...getSubtitleAppearance(), ...getSubtitleAppearance(geo) };
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
  overlayEl.classList.toggle('geometry-enabled', !!overlayToggle.checked || !!extensionOverlayToggle?.checked);
  stickerOverlayLayer.classList.toggle('geometry-enabled', !!stickerOverlayToggle?.checked);
}

// --- 指针拖动 / 缩放（Pointer Events），字幕预览与表情包预览共用 ---
let previewGesture = null;  // { pointerId, handle, target, startX, startY, startGeo, rect }
function previewTargetEl(target) { return target === 'sticker' ? stickerOverlayLayer : overlayEl; }
function previewTargetEnabled(target) {
  return target === 'sticker'
    ? !!stickerOverlayToggle?.checked
    : (!!overlayToggle.checked || !!extensionOverlayToggle?.checked);
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
function findActiveSegmentIndex(segments, tMs, skipDisabled = false) {
  if (!Array.isArray(segments) || !segments.length || !Number.isFinite(Number(tMs))) return -1;
  let lo = 0;
  let hi = segments.length;
  const time = Number(tMs);
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const start = Number(segments[mid]?.start);
    if (Number.isFinite(start) && start <= time) lo = mid + 1;
    else hi = mid;
  }
  let index = lo - 1;
  if (skipDisabled) {
    while (index >= 0 && segments[index]?.disabled) index -= 1;
  }
  return index;
}

function findActive(tMs) {
  // 相邻字幕共用边界时，右侧字幕的 start 优先；处于时间间隙时保留
  // 前一条字幕作为当前项，和原有列表高亮语义一致。
  return findActiveSegmentIndex(DATA.segments, tMs);
}

function isSubtitlePreviewActive(segment, tMs) {
  if (!segment || segment.disabled) return false;
  const start = Number(segment.start);
  const end = Number(segment.end);
  return Number.isFinite(start) && Number.isFinite(end) && tMs >= start && tMs < end;
}

function extensionSegmentAtTime(tMs, mainIndex = -1) {
  if (!multiSubtitleVisible()) return null;
  const bound = mainIndex >= 0 ? extensionForMainIndex(mainIndex) : null;
  if (isSubtitlePreviewActive(bound, tMs)) return bound;
  const segments = getActiveExtensionTrack()?.segments || [];
  const index = findActiveSegmentIndex(segments, tMs, true);
  const segment = index >= 0 ? segments[index] : null;
  return isSubtitlePreviewActive(segment, tMs) ? segment : null;
}

function removedGapAt(timeMs) {
  const ranges = getRemovedGapRanges();
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (Number(ranges[middle]?.end) <= timeMs) low = middle + 1;
    else high = middle;
  }
  const gap = ranges[low];
  return gap && timeMs >= gap.start && timeMs < gap.end ? gap : null;
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
      if (!editingState && !suppressCueListAutoScroll) {
        scrollCueIntoViewIfNeeded(cur, { behavior: 'auto' });
      }
    }
  }
  lastActive = idx;
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
  refreshSubtitlePreview(tMs, idx);
  waveformEditor?.updatePlayback();
}

function refreshSubtitlePreview(tMs = player.currentTime * 1000, idx = findActive(tMs)) {
  // 编辑字幕文本时只刷新播放器预览，避免每输入一个字都触发字幕列表的自动滚动。
  const seg = idx >= 0 ? DATA.segments[idx] : null;
  const mainVisible = !!overlayToggle.checked && isSubtitlePreviewActive(seg, tMs);
  const extension = extensionSegmentAtTime(tMs, idx);
  const extensionVisible = !!extensionOverlayToggle?.checked && !!extension;
  // 播放刷新每帧都会经过这里；只在可见状态或文字真的变化时触碰 DOM，
  // 避免连续 textContent/classList 写入触发不必要的样式和绘制工作。
  if (overlayTextEl.classList.contains('hidden') === mainVisible) {
    overlayTextEl.classList.toggle('hidden', !mainVisible);
  }
  if (overlayExtensionTextEl.classList.contains('hidden') === extensionVisible) {
    overlayExtensionTextEl.classList.toggle('hidden', !extensionVisible);
  }
  const mainText = mainVisible ? (seg.text || '') : '';
  const extensionText = extensionVisible ? (extension.text || '') : '';
  if (mainVisible && overlayTextEl.textContent !== mainText) overlayTextEl.textContent = mainText;
  if (extensionVisible && overlayExtensionTextEl.textContent !== extensionText) {
    overlayExtensionTextEl.textContent = extensionText;
  }
  const overlayHidden = !mainVisible && !extensionVisible;
  if (overlayEl.classList.contains('hidden') !== overlayHidden) {
    overlayEl.classList.toggle('hidden', overlayHidden);
  }
  renderStickerOverlay(tMs);
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
  refreshSubtitlePreview(tMs, idx);
}

// 拆分等结构性提交后的 update() 只刷新时间码与激活态，不触发播放跟随滚动。
// renderAll 刚重建列表时，content-visibility 让视口外的行仍处于估算占位
// 高度，updateActiveCue 量到的瞬态几何会把「活动行不在视口」误判成真，
// 再用被污染的 offsetTop 算出错误目标平滑滚走（页面放大倍率越高、真实
// 行高与估算差异越大越容易触发）。拆分后是否滚动、滚到哪里已由拆分
// 来源显式决定（列表来源保持原位，波形来源显式居中新右半段）。
function updateWithoutCueListAutoScroll() {
  const previousSuppress = suppressCueListAutoScroll;
  suppressCueListAutoScroll = true;
  try {
    update();
  } finally {
    suppressCueListAutoScroll = previousSuppress;
  }
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

let stickerOverlayDataVersion = 0;
let stickerIntervalCacheVersion = -1;
let stickerIntervals = [];
let stickerIntervalBoundaries = [];
let activeStickerCacheVersion = -1;
let activeStickerCacheTime = -Infinity;
let activeStickerCacheUntil = -Infinity;
let activeStickerCache = [];
let renderedStickerSignature = null;
let renderedStickerOverlayEnabled = false;

function rebuildStickerIntervals() {
  if (stickerIntervalCacheVersion === stickerOverlayDataVersion) return;
  const intervals = [];
  const boundaries = new Set();
  DATA.segments.forEach((seg) => {
    if (seg.disabled) return;
    const source = seg.sticker || DATA.segments[seg.sticker_ref?.headIdx]?.sticker;
    if (!source) return;
    const head = DATA.segments[seg.sticker_ref?.headIdx] || seg;
    const start = Number(source.start ?? head.start);
    const end = Number(source.end ?? head.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return;
    intervals.push({ start, end, source, key: source.filename || source.name });
    boundaries.add(start);
    boundaries.add(end);
  });
  stickerIntervals = intervals;
  stickerIntervalBoundaries = [...boundaries].sort((a, b) => a - b);
  stickerIntervalCacheVersion = stickerOverlayDataVersion;
  activeStickerCacheVersion = -1;
  activeStickerCacheTime = -Infinity;
  activeStickerCacheUntil = -Infinity;
  activeStickerCache = [];
}

function activeStickersAt(tMs) {
  rebuildStickerIntervals();
  const time = Number(tMs);
  if (
    activeStickerCacheVersion === stickerOverlayDataVersion
    && time >= activeStickerCacheTime
    && time < activeStickerCacheUntil
  ) return activeStickerCache;

  const found = new Map();  // 同组 head/ref 去重，按文件名键
  stickerIntervals.forEach((interval) => {
    if (time >= interval.start && time <= interval.end) found.set(interval.key, interval.source);
  });
  // 播放时间单调前进时，缓存只需保留到下一个边界；二分定位避免每次
  // 表情包切换都再次扫描全部边界。边界采用半开缓存区间，确保切换帧
  // 立刻显示新表情包，而不是多停留一帧旧内容。
  let low = 0;
  let high = stickerIntervalBoundaries.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (stickerIntervalBoundaries[middle] <= time) low = middle + 1;
    else high = middle;
  }
  const nextChange = stickerIntervalBoundaries[low] ?? Infinity;
  activeStickerCacheVersion = stickerOverlayDataVersion;
  activeStickerCacheTime = time;
  activeStickerCacheUntil = nextChange;
  activeStickerCache = [...found.values()];
  return activeStickerCache;
}

function renderStickerOverlay(tMs) {
  const enabled = Boolean(stickerOverlayToggle?.checked);
  if (!enabled) {
    if (renderedStickerOverlayEnabled || stickerOverlayContent.childElementCount) {
      stickerOverlayContent.replaceChildren();
    }
    renderedStickerOverlayEnabled = false;
    renderedStickerSignature = null;
    return;
  }
  const stickers = activeStickersAt(tMs);
  const signature = stickers.map((sticker) => sticker.filename || sticker.name).join('\u0001');
  if (renderedStickerOverlayEnabled && renderedStickerSignature === signature) return;
  stickerOverlayContent.replaceChildren(...stickers.map((sticker) => {
    const img = document.createElement('img');
    img.src = stickerUrl(sticker);
    img.alt = sticker.name;
    img.title = sticker.name;
    return img;
  }));
  renderedStickerOverlayEnabled = true;
  renderedStickerSignature = signature;
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
  // change 触发时 checked 已是新值；其它预览样式和拓展开关仍从当前快照保留。
  const previous = snapshotPreviewState();
  previous.overlay = !overlayToggle.checked;
  pushPreviewUndo('切换字幕预览', previous);
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

function buildExtensionSrt(track = getActiveExtensionTrack()) {
  if (!track) return '';
  const parts = [];
  let number = 0;
  (track.segments || []).forEach((segment) => {
    if (!segment || segment.disabled) return;
    number++;
    parts.push(String(number));
    parts.push(`${fmtSrtTime(segment.start)} --> ${fmtSrtTime(segment.end)}`);
    parts.push(segment.text || '');
    parts.push('');
  });
  return parts.join('\n');
}

function buildGapRemovedSrt() {
  const removed = getRemovedGapRanges();
  if (!removed.length) {
    flashHint('没有已移除的静音空隙；请先使用「移除静音空隙」扫描并移除', 'invalid');
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
  if (downloadMultiSrtButton) {
    downloadMultiSrtButton.hidden = !(multiSubtitleVisible() && getActiveExtensionTrack()?.segments?.length);
  }
}

async function downloadColorSrts(gapRemoved = false) {
  if (editingState) finishEdit(true);
  const colors = usedSubtitleColors();
  const removed = gapRemoved ? getRemovedGapRanges() : [];
  if (!colors.length) {
    flashHint('没有可导出的彩色字幕', 'invalid');
    return;
  }
  if (gapRemoved && !removed.length) {
    flashHint('没有已移除的静音空隙；请先使用「移除静音空隙」扫描并移除', 'invalid');
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
  flashHint(`已按颜色导出 ${colors.length} 份字幕`, 'success');
}

function gapRemovedExportContext() {
  const removed = getRemovedGapRanges();
  if (!removed.length) {
    flashHint('没有已移除的静音空隙；请先使用「移除静音空隙」扫描并移除', 'invalid');
    return null;
  }
  const durationMs = waveformEditor?.durationMs || Math.round(Number(player?.duration) * 1000) || 0;
  if (!durationMs) {
    flashHint('媒体时长尚不可用；请先加载媒体后再导出', 'invalid');
    return null;
  }
  const intervals = window.AsrEditorUtils.buildGapRemovedIntervals(durationMs, removed);
  if (!intervals.length) {
    flashHint('移除静音空隙后没有剩余媒体，无法导出', 'warning');
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
    flashHint('无法获得媒体文件名；请先加载媒体后再导出 FFconcat', 'invalid');
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
  const repairedTimingCount = repairCurrentProjectTimings();
  if (repairedTimingCount > 0) {
    flashHint(`已自动修复 ${repairedTimingCount} 处异常时间码（保底 100ms）`, 'warning');
  }
  const out = {
    media: DATA.media || '',
    language: DATA.language || '',
    model: DATA.model || '',
    sticker_root: STICKER_ROOT || '',
    segments: DATA.segments.map(s => {
      const o = {
        id: s.id,
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
  const multi = getMultiSubtitleState();
  out.multi_subtitle = {
    schema: multi.schema || MULTI_SUBTITLE_UTILS.MULTI_SUBTITLE_SCHEMA,
    enabled: multi.enabled === true,
    display_mode: multi.display_mode || 'both',
    main_split_mode: isConfiguredSubtitleSplitMode(multi.main_split_mode)
      ? multi.main_split_mode : getMainSubtitleSplitMode(DATA.segments[0]),
    tracks: (multi.tracks || []).map((track) => ({
      id: track.id,
      role: 'extension',
      name: track.name || '扩展字幕',
      language: track.language || '',
      split_mode: track.split_mode || 'word',
      source_name: track.source_name || '',
      segments: (track.segments || []).map((segment) => {
        const outSegment = {
          id: segment.id,
          start: segment.start,
          end: segment.end,
          text: segment.text || '',
        };
        if (Array.isArray(segment.items)) outSegment.items = segment.items;
        if (segment._dirty) outSegment._dirty = true;
        if (segment.disabled) outSegment.disabled = true;
        return outSegment;
      }),
    })),
    bindings: (multi.bindings || []).map((binding) => ({
      id: binding.id,
      track_id: binding.track_id,
      main_segment_ids: [...(binding.main_segment_ids || [])],
      extension_segment_ids: [...(binding.extension_segment_ids || [])],
      start_offset_ms: binding.start_offset_ms || 0,
      end_offset_ms: binding.end_offset_ms || 0,
    })),
  };
  if (DATA.waveform) out.waveform = DATA.waveform;
  if (DATA.spectral) out.spectral = DATA.spectral;
  if (DATA.waveform_reapeaks) out.waveform_reapeaks = DATA.waveform_reapeaks;
  if (DATA.gap_remove) out.gap_remove = normalizedGapRemoveData(DATA.gap_remove);
  const workspace = buildCurrentWorkspaceData();
  if (workspace) out.workspace = workspace;
  // 预览几何：始终写入归一化后的当前几何，便于跨机/重开保持位置。
  const preview = { subtitle: { ...getPreviewGeometry(), ...getSubtitleAppearance() } };
  if (getActiveExtensionTrack() || DATA.preview?.extension_subtitle) {
    preview.extension_subtitle = { ...getStoredExtensionSubtitleAppearance() };
  }
  out.preview = preview;
  return JSON.stringify(out, null, 2);
}

// 保存/导出前的最后一道时间码兜底。波形拖动会把词时间码按像素取整，
// 极短词可能因此出现 1ms 的前后重叠；打开工程时的修复不足以覆盖这种
// “打开后编辑、随后保存”的路径。主轨和所有副字幕轨统一使用同一规则。
function normalizeProjectTimings(project, { repairSegmentRanges = true } = {}) {
  if (!project || typeof project !== 'object') return 0;
  const normalize = repairSegmentRanges
    ? window.AsrEditorUtils.normalizeSegmentTimings
    : window.AsrEditorUtils.normalizeItemTimingRanges;
  let fixed = normalize(project.segments);
  const tracks = project.multi_subtitle?.tracks;
  if (Array.isArray(tracks)) {
    tracks.forEach((track) => {
      fixed += normalize(track?.segments);
    });
  }
  return fixed;
}

function repairCurrentProjectTimings() {
  const fixed = normalizeProjectTimings(DATA, { repairSegmentRanges: false });
  if (fixed > 0) {
    markMainSegmentsDirty(DATA.segments);
    markMultiSubtitleDirty();
    syncBindingOffsets();
  }
  return fixed;
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
    flashHint('没有颜色或表情包配置，无法导出 Resolve JSON', 'invalid');
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
    flashHint('没有已移除的静音空隙；请先使用「移除静音空隙」扫描并移除', 'invalid');
    return null;
  }
  const durationMs = waveformEditor?.durationMs || Math.round(Number(player?.duration) * 1000) || 0;
  if (!durationMs) {
    flashHint('媒体时长尚不可用；请先加载媒体后再导出 OTIO', 'invalid');
    return null;
  }
  const targetUrl = mediaTargetUrl();
  if (!targetUrl) {
    flashHint('无法获得媒体绝对路径；请用 edit.py / server-editor 打开工程后再导出 OTIO', 'invalid');
    return null;
  }
  const intervals = window.AsrEditorUtils.buildGapRemovedIntervals(durationMs, removed);
  if (!intervals.length) {
    flashHint('移除静音空隙后没有剩余媒体，无法导出 OTIO', 'warning');
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
    flashHint(collected.error, 'warning');
    return null;
  }
  if (!collected.entries.length) {
    flashHint('没有任何表情包，无法导出 OTIO', 'invalid');
    return null;
  }
  const result = buildStickerOtioTimeline(collected.entries, `${FILENAME_BASE}_表情包`);
  if (result.error) {
    flashHint(result.error, 'warning');
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
      sticker_rel: seg.sticker.rel || '',
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
          sticker_rel: sticker.sticker_rel,
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
    flashHint('没有已移除的静音空隙；请先使用「移除静音空隙」扫描并移除', 'invalid');
    return null;
  }
  const collected = collectStickerOtioEntries(removed);
  if (collected.error) {
    flashHint(collected.error, 'warning');
    return null;
  }
  if (!collected.entries.length) {
    flashHint('没有落在保留区间内的表情包，无法导出去空隙表情包 OTIO', 'invalid');
    return null;
  }
  const result = buildStickerOtioTimeline(collected.entries, `${FILENAME_BASE}_去空隙表情包`);
  if (result.error) {
    flashHint(result.error, 'warning');
    return null;
  }
  return result.json;
}

async function downloadFile(content, filename, mime, accept, { usePicker = true } = {}) {
  const isSrt = filename.toLowerCase().endsWith('.srt');
  const fileContent = isSrt
    ? new Uint8Array([0xEF, 0xBB, 0xBF, ...new TextEncoder().encode(String(content))])
    : content;
  // 优先尝试 File System Access API（弹出保存路径选择对话框）
  if (usePicker && window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: accept ? [{ description: accept.desc, accept: accept.types }] : undefined,
      });
      const w = await handle.createWritable();
      await w.write(new Blob([fileContent], { type: mime + ';charset=utf-8' }));
      await w.close();
      return true;
    } catch (e) {
      // 用户取消保存对话框 — 静默退出，不回退
      if (e && e.name === 'AbortError') return false;
      // 其他错误（如安全限制、unsupported 文件类型）：回退到 anchor 下载
    }
  }
  // 兜底：传统 anchor 下载（不弹路径选择）
  const blob = new Blob([fileContent], { type: mime + ';charset=utf-8' });
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
    () => flashHint(hint || `已复制：${text}`, 'success'),
    () => { /* 降级：exec */ document.execCommand('copy'); flashHint(hint || `已复制：${text}`, 'success'); }
  );
}

let projectImportDirty = false;
let projectCheckpointed = Boolean(SERVER_CONFIG?.canSave)
  || !document.getElementById('json-name')?.classList.contains('empty');
let projectCheckpointInFlight = false;
// 浏览器「新建工程 / 另存为」选择的文件由页面持有 FileSystemFileHandle 持续写回；
// Server 绑定的工程仍由服务器按真实路径原子保存，且优先级高于句柄。
let projectFileHandle = null;

function serverProjectSavingEnabled() {
  return !!(SERVER_CONFIG && SERVER_CONFIG.saveUrl && SERVER_CONFIG.canSave);
}

function projectSaveTargetEnabled() {
  return serverProjectSavingEnabled() || projectFileHandle !== null;
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
  // 浏览器持有工程句柄时同样显示保存控件；服务器绑定优先于句柄。
  if (saveProjectDropdown) saveProjectDropdown.hidden = !(hasServer || projectFileHandle !== null);
  [saveProjectButton, document.getElementById('save-project-menu-btn')].forEach((button) => {
    if (!button) return;
    button.disabled = !projectSaveTargetEnabled();
     if (!projectSaveTargetEnabled()) button.title = '当前服务器未绑定工程；请先导出 .mosp，再重新打开该文件';
  });
  if (saveProjectButton && projectSaveTargetEnabled()) {
    saveProjectButton.title = '保存回当前工程文件（Ctrl(Cmd)+S）';
  }
  // 另存为走系统文件对话框，不依赖服务器绑定，始终可用。
  if (saveProjectAsButton) {
    saveProjectAsButton.title = '另存为工程文件（Ctrl(Cmd)+Shift+S）';
  }
  syncStickerOtioExportMode();
}

let autoSaveTimer = null;
let autoSaveFlushTimer = null;
let projectSaveInFlight = false;
const EDIT_SAVE_DEBOUNCE_MS = 400;

function scheduleAutoSave() {
  if (autoSaveTimer !== null) {
    window.clearInterval(autoSaveTimer);
    autoSaveTimer = null;
  }
  if (!projectSaveTargetEnabled() || !EDITOR_SETTINGS.autoSaveProject) return;
  autoSaveTimer = window.setInterval(() => {
    if (hasUnsavedProjectChanges() && !projectSaveInFlight && !projectCheckpointInFlight) {
      void saveCurrentProject({ silent: true });
    }
  }, EDITOR_SETTINGS.autoSaveIntervalSeconds * 1000);
}

  function configureServerAutoSave() {
    if (!serverAutoSaveSettings || !autoSaveProjectToggle || !autoSaveIntervalField || !autoSaveIntervalInput) return;
    // 服务器绑定工程或浏览器保存对话框（句柄模式）任一可用时都可自动保存。
    const available = Boolean(SERVER_CONFIG?.saveUrl || window.showSaveFilePicker);
    serverAutoSaveSettings.hidden = !available;
    if (!available) return;
  const sync = () => {
    autoSaveProjectToggle.checked = EDITOR_SETTINGS.autoSaveProject;
    autoSaveIntervalInput.value = String(EDITOR_SETTINGS.autoSaveIntervalSeconds);
    autoSaveIntervalField.hidden = !EDITOR_SETTINGS.autoSaveProject;
    autoSaveProjectToggle.disabled = false;
    autoSaveIntervalInput.disabled = !EDITOR_SETTINGS.autoSaveProject;
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
  const multiDirty = Boolean(DATA.multi_subtitle?._dirty)
    || (DATA.multi_subtitle?.tracks || []).some((track) => track.segments?.some((segment) => segment._dirty));
  return projectImportDirty || gapRemoveDirty || previewGeometryDirty
    || DATA.segments.some((segment) => segment._dirty)
    || multiDirty;
}

// 文字编辑先写入页面内存，避免每个按键都请求服务器；失焦后短暂防抖保存，
// 这样点击其它字幕或刷新页面时不会因为 30 秒定时保存尚未到点而丢失刚完成的修改。
function scheduleAutoSaveFlush() {
  if (autoSaveFlushTimer !== null) {
    window.clearTimeout(autoSaveFlushTimer);
    autoSaveFlushTimer = null;
  }
  if (!projectSaveTargetEnabled() || !EDITOR_SETTINGS.autoSaveProject) return;
  autoSaveFlushTimer = window.setTimeout(() => {
    autoSaveFlushTimer = null;
    if (hasUnsavedProjectChanges() && !projectSaveInFlight) {
      void saveCurrentProject({ silent: true });
    }
  }, EDIT_SAVE_DEBOUNCE_MS);
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
      const error = new Error(result.error || `服务器返回 ${response.status}`);
      error.missing = result.missing === true;
      throw error;
    }
    window.location.reload();
  } catch (error) {
    if (error?.missing) {
      project.exists = false;
      markRecentProjectMissing(project);
    }
    flashHint(`打开工程失败：${error.message || error}`, 'warning');
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

function renderMissingRecentProjectItem(item, project) {
  item.className = 'dropdown-item is-missing';
  item.style.cursor = 'not-allowed';
  item.replaceChildren();
  const label = document.createElement('span');
  label.className = 'recent-project-name';
  label.textContent = project.name;
  item.appendChild(label);
  const badge = document.createElement('span');
  badge.className = 'recent-project-badge is-missing';
  badge.textContent = '已失效';
  item.appendChild(badge);
  item.title = `工程路径失效：${project.path}`;
}

function markRecentProjectMissing(project) {
  if (!recentProjectsList || !project || typeof project.path !== 'string') return;
  const item = Array.from(recentProjectsList.children)
    .find((candidate) => candidate.dataset.projectPath === project.path);
  if (item) renderMissingRecentProjectItem(item, project);
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
    item.dataset.projectPath = project.path;
    if (project.exists === false) {
      renderMissingRecentProjectItem(item, project);
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
    }
    item.addEventListener('click', () => {
      recentProjectsEl.classList.remove('open');
      if (item.classList.contains('is-missing')) {
        flashHint('工程路径失效，文件可能已被移动或删除', 'warning');
        return;
      }
      openRecentProject(project);
    });
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
        flashHint(`保存设置失败：${error.message || error}`, 'warning');
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

// 覆盖可能只存导航状态（后端自动创建），没有布局数据；只有含 navigation
// 以外字段的覆盖才能作为布局来源，否则退回内置默认布局。
function presetWorkspaceHasLayout(workspace) {
  return Boolean(workspace) && Object.keys(workspace).some((key) => key !== 'navigation');
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

function currentWorkspaceNavigation() {
  const snapshot = waveformEditor?.getNavigationSnapshot?.();
  const cueListScrollTop = Math.max(0, Math.round(Number(container?.scrollTop) || 0));
  return {
    ...(snapshot || {}),
    cueListScrollTop,
  };
}

async function saveWorkspaceNavigation(target) {
  if (!target || !SERVER_CONFIG?.settingsUrl || !waveformEditor) return;
  const navigation = currentWorkspaceNavigation();
  try {
    const result = await updateServerWorkspaceSettings({
      updateWorkspaceNavigation: { ...target, navigation },
    });
    SERVER_CONFIG.savedWorkspaces = result.savedWorkspaces || {};
    SERVER_CONFIG.presetWorkspaces = result.presetWorkspaces || {};
  } catch (error) {
    flashHint(`记住工作区导航失败：${error.message || error}`, 'warning');
  }
}

function restoreWorkspaceNavigation(workspace) {
  waveformEditor?.restoreNavigation?.(workspace?.navigation);
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
    flashHint(saveAs ? `已另存工作区：${displayName}` : `已保存工作区：${displayName}`, 'success');
  } catch (error) {
    flashHint(`保存工作区失败：${error.message || error}`, 'warning');
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
    flashHint(`已删除工作区：${name}`, 'success');
  } catch (error) {
    flashHint(`删除工作区失败：${error.message || error}`, 'warning');
  } finally {
    deleteWorkspaceButton.disabled = false;
  }
}

// 应用一次下拉选择：saved:* 从本机库恢复；内置 id 优先用本机覆盖版，否则用默认定义。
// 工作区 = 窗口布局 + 显示状态，切换时同时恢复该工作区保存的显示开关。
async function applyWorkspaceSelection(preset) {
  const previousTarget = currentServerWorkspaceName
    ? { name: currentServerWorkspaceName }
    : currentBuiltinWorkspaceName ? { preset: currentBuiltinWorkspaceName } : null;
  if (previousTarget && (preset !== `saved:${currentServerWorkspaceName}`
      && preset !== currentBuiltinWorkspaceName)) {
    await saveWorkspaceNavigation(previousTarget);
  }
  if (preset.startsWith('saved:')) {
    const name = preset.slice('saved:'.length);
    const workspace = getSavedServerWorkspaces()[name];
    if (!workspace) return;
    waveformEditor.setLayoutData({ ...workspace, selectedPreset: `saved:${name}` });
    applyEditorDisplaySettings(workspace.editorDisplay);
    restoreWorkspaceNavigation(workspace);
    currentServerWorkspaceName = name;
    currentBuiltinWorkspaceName = '';
    refreshWorkspaceSelect();
    syncWorkspaceControls();
    void updateServerWorkspaceSettings({ activeWorkspaceName: name }).catch((error) => {
      flashHint(`记住工作区失败：${error.message || error}`, 'warning');
    });
    flashHint(`已应用工作区：${name}`, 'success');
    return;
  }
  if (!BUILTIN_WORKSPACE_IDS.includes(preset)) return;
  currentServerWorkspaceName = '';
  currentBuiltinWorkspaceName = preset;
  const savedPreset = getSavedPresetWorkspaces()[preset];
  const layoutPreset = presetWorkspaceHasLayout(savedPreset) ? savedPreset : null;
  if (layoutPreset) waveformEditor.setLayoutData(layoutPreset);
  else waveformEditor.setLayout(preset);
  applyEditorDisplaySettings(
    savedPreset?.editorDisplay || window.AsrWaveform?.builtinWorkspaces?.[preset]?.editorDisplay,
  );
  workspacePresetSelect.value = preset;
  restoreWorkspaceNavigation(savedPreset);
  refreshWorkspaceSelect();
  syncWorkspaceControls();
  void updateServerWorkspaceSettings({ activeWorkspaceName: '' }).catch((error) => {
    flashHint(`记住工作区失败：${error.message || error}`, 'warning');
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
  if (!savedSelection && currentBuiltinWorkspaceName && presetWorkspaceHasLayout(getSavedPresetWorkspaces()[currentBuiltinWorkspaceName])) {
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
          flashHint(`已恢复「${preset}」默认工作区`, 'success');
        }).catch((error) => {
          flashHint(`重置工作区失败：${error.message || error}`, 'warning');
        });
      }
      syncWorkspaceControls();
    });
    saveWorkspaceButton?.addEventListener('click', () => { void saveCurrentWorkspace({ saveAs: false }); });
    saveWorkspaceAsButton?.addEventListener('click', () => { void saveCurrentWorkspace({ saveAs: true }); });
    deleteWorkspaceButton?.addEventListener('click', () => { void deleteCurrentServerWorkspace(); });
    workspacePresetSelect.dataset.listenersBound = 'true';
   }
   const initialWorkspace = currentServerWorkspaceName
     ? getSavedServerWorkspaces()[currentServerWorkspaceName]
     : getSavedPresetWorkspaces()[currentBuiltinWorkspaceName];
   restoreWorkspaceNavigation(initialWorkspace || DATA.workspace);
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
      flashHint(`已导入工作区：${file.name}`, 'success');
    } catch (error) {
      flashHint(`工作区导入失败：${error.message || error}`, 'warning');
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
  const multi = getMultiSubtitleState();
  delete multi._dirty;
  (multi.tracks || []).forEach((track) => track.segments.forEach((segment) => { delete segment._dirty; }));
  gapRemoveDirty = false;
  previewGeometryDirty = false;
  projectImportDirty = false;
  FILENAME_BASE = filename.replace(/\.(json|mosp)$/i, '');
  const jsonEl = document.getElementById('json-name');
  if (jsonEl) {
    jsonEl.textContent = filename;
    jsonEl.title = `点击复制工程文件名：${filename}`;
    jsonEl.classList.remove('empty');
  }
  renderAll();
  if (!silent) flashHint('保存成功！', 'success');
}

async function saveProjectToServer({ silent = false } = {}) {
  if (!serverProjectSavingEnabled()) {
    if (!silent) flashHint('当前服务器未绑定工程；请先导出 .mosp，再重新打开该文件', 'invalid');
    return false;
  }
  if (projectSaveInFlight || projectCheckpointInFlight) return false;
  if (editingState) finishEdit(true);
  if (extensionEditingState) finishExtensionEdit(true);
  commitCuePanelEdit();
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
      if (saved) flashHint('服务器未连接；工程已导出为 .mosp，请重新打开该文件后继续', 'success');
    }
    return false;
  } finally {
    projectSaveInFlight = false;
  }
}

// 把当前工程写回页面持有的浏览器文件句柄（新建工程 / 另存为选定的目标）。
async function saveProjectToHandle({ silent = false } = {}) {
  if (!projectFileHandle) return false;
  if (projectSaveInFlight || projectCheckpointInFlight) return false;
  if (editingState) finishEdit(true);
  if (extensionEditingState) finishExtensionEdit(true);
  commitCuePanelEdit();
  const projectJson = buildJson();
  projectSaveInFlight = true;
  try {
    const writable = await projectFileHandle.createWritable();
    await writable.write(new Blob([projectJson], { type: 'application/json;charset=utf-8' }));
    await writable.close();
    markProjectSaved(projectFileHandle.name, null, { silent });
    return true;
  } catch (error) {
    flashHint(`保存失败：${error?.message || error}`, 'warning');
    return false;
  } finally {
    projectSaveInFlight = false;
  }
}

// 统一保存入口：句柄目标优先（最近一次新建/另存为选定的文件），否则写回服务器绑定工程。
async function saveCurrentProject({ silent = false } = {}) {
  if (projectFileHandle) return saveProjectToHandle({ silent });
  return saveProjectToServer({ silent });
}

// 另存为：打开系统文件浏览对话框把工程文件保存到用户选择的位置。
// 与「导出工程」的区别：保存成功后当前工程名跟随新文件（标题、导出默认名随之更新），
// 且后续 Ctrl(Cmd)+S / 自动保存都写回这个新选定的文件。
async function saveProjectAsToFile() {
  if (editingState) finishEdit(true);
  if (extensionEditingState) finishExtensionEdit(true);
  commitCuePanelEdit();
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
    projectFileHandle = handle;
    markProjectSaved(handle.name, null);
    configureServerSaveControls();
    scheduleAutoSave();
  } catch (error) {
    if (error && error.name === 'AbortError') return;  // 用户取消保存对话框
    flashHint(`保存失败：${error?.message || error}`, 'warning');
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
downloadMultiSrtButton?.addEventListener('click', async () => {
  if (extensionEditingState) finishExtensionEdit(true);
  const track = getActiveExtensionTrack();
  if (!track) return;
  await downloadFile(buildExtensionSrt(track), `${FILENAME_BASE}_extension.srt`, 'text/plain', {
    desc: '扩展字幕 SRT 文件', types: { 'text/plain': ['.srt'] },
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
saveProjectButton?.addEventListener('click', () => saveCurrentProject());
saveProjectAsButton?.addEventListener('click', () => saveProjectAsToFile());
// Project-level save shortcuts intentionally override the browser page-save
// command. finishEdit() inside saveProjectToServer commits an active text edit.
document.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 's') return;
  event.preventDefault();
  if (event.shiftKey) {
    void saveProjectAsToFile();
  } else {
    void saveCurrentProject();
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
});
const stickerOtioExportMode = document.getElementById('sticker-otio-export-mode');
const portableStickerExportOption = stickerOtioExportMode?.querySelector('option[value="portable"]');

function syncStickerOtioExportMode() {
  const available = Boolean(
    SERVER_CONFIG?.canPortableStickerExport && SERVER_CONFIG?.portableStickerExportUrl
  );
  if (portableStickerExportOption) portableStickerExportOption.disabled = !available;
  if (stickerOtioExportMode) {
    stickerOtioExportMode.value = available
      ? EDITOR_SETTINGS.stickerOtioExportMode
      : 'original';
  }
  return available;
}

stickerOtioExportMode?.addEventListener('change', () => {
  updateEditorSettings({ stickerOtioExportMode: stickerOtioExportMode.value });
});

async function exportStickerOtio(kind, buildTimeline, filename, description) {
  if (editingState) finishEdit(true);
  const payload = buildTimeline();
  if (!payload) return;
  if (stickerOtioExportMode?.value !== 'portable') {
    await downloadFile(payload, filename, 'application/vnd.opentimelineio+json', {
      desc: description, types: { 'application/vnd.opentimelineio+json': ['.otio'] }
    });
    return;
  }
  if (!syncStickerOtioExportMode()) {
    flashHint('当前工程无法导出便携表情包 OTIO 文件夹', 'warning');
    return;
  }
  flashHint('正在生成便携表情包 OTIO 文件夹…');
  try {
    const response = await fetch(new URL(SERVER_CONFIG.portableStickerExportUrl, window.location.href), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestToken: SERVER_CONFIG.requestToken,
        kind,
        timeline: JSON.parse(payload),
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.error || `服务器返回 ${response.status}`);
    flashHint(`已生成 ${result.folderPath}，复制 ${result.stickerCount} 张表情包`, 'success');
  } catch (error) {
    flashHint(`便携表情包 OTIO 导出失败：${error.message || error}`, 'warning');
  }
}

document.getElementById('download-sticker-otio').addEventListener('click', () => exportStickerOtio(
  'stickers', buildStickerOtio, `${FILENAME_BASE}_stickers.otio`, 'OTIO 工程文件'
));
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
  await exportStickerOtio(
    'gap-removed-stickers', buildGapRemovedStickerOtio,
    `${FILENAME_BASE}_gap-removed-stickers.otio`, '去空隙表情包 OTIO 工程'
  );
});

// === 工具栏导出下拉菜单 ===
function bindToolbarExportDropdown(dropdownId, buttonId, menuId) {
  const dd = document.getElementById(dropdownId);
  const btn = document.getElementById(buttonId);
  const menu = document.getElementById(menuId);
  if (!dd || !btn || !menu) return;
  const setOpen = (open) => {
    dd.classList.toggle('open', open);
    if (btn.hasAttribute('aria-expanded')) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.toolbar .dropdown.open').forEach((other) => {
      if (other !== dd) {
        other.classList.remove('open');
        other.querySelector('button[aria-expanded]')?.setAttribute('aria-expanded', 'false');
      }
    });
    setOpen(!dd.classList.contains('open'));
  });
  menu.addEventListener('click', (e) => {
    if (e.target.classList.contains('dropdown-item')) {
      setOpen(false);
    }
  });
  document.addEventListener('click', (e) => {
    if (!dd.contains(e.target)) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setOpen(false);
  });
}
bindToolbarExportDropdown('subtitle-export-dropdown', 'subtitle-export-btn', 'subtitle-export-menu');
bindToolbarExportDropdown('gap-removed-export-dropdown', 'gap-removed-export-btn', 'gap-removed-export-menu');
bindToolbarExportDropdown('extra-export-dropdown', 'extra-export-btn', 'extra-export-menu');
bindToolbarExportDropdown('open-project-dropdown', 'open-project-menu-btn', 'open-project-menu');
bindToolbarExportDropdown('save-project-dropdown', 'save-project-menu-btn', 'save-project-menu');
bindToolbarExportDropdown('workspace-transfer-dropdown', 'workspace-transfer-btn', 'workspace-transfer-menu');
bindToolbarExportDropdown('multi-subtitle-settings-dropdown', 'multi-subtitle-settings-toggle', 'multi-subtitle-settings-menu');

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
  flashHint('可稍后点击“加载媒体”选择关联媒体', 'invalid');
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

function buildBlankProject() {
  return { media: '', language: '', model: '', segments: [] };
}

function suggestedProjectName(file = null) {
  const stem = file?.name?.replace(/\.[^.]+$/i, '').trim();
  return `${stem || 'untitled'}.mosp`;
}

function applyCanonicalProject(data, filename) {
  currentCuePanelIdx = -1;
  currentCuePanelKind = 'main';
  currentCuePanelTrackId = null;
  resetCuePanelEditState();
  resetLoadedMedia();
  DATA.media = typeof data.media === 'string' ? data.media : '';
  DATA.language = data.language || '';
  DATA.model = data.model || '';
  DATA.waveform = data.waveform || null;
  DATA.spectral = data.spectral || null;
  DATA.waveform_reapeaks = data.waveform_reapeaks || null;
  DATA.workspace = data.workspace || null;
  DATA.gap_remove = data.gap_remove || null;
  DATA.preview = (data.preview && typeof data.preview === 'object') ? data.preview : null;
  gapRemoveDirty = false;
  previewGeometryDirty = false;
  projectImportDirty = false;
  // 外部载入的工程没有页面持有的文件句柄；新建/另存为会在载入后重新绑定句柄。
  projectFileHandle = null;
  setPreviewGeometry(getPreviewGeometry(), { markDirty: false });
  applyExtensionSubtitleAppearance(DATA.preview?.extension_subtitle);
  setStickerGeometry(getStickerGeometry(), { markDirty: false });
  refreshPreviewGeometryEditable();
  if (data.sticker_root) STICKER_ROOT = data.sticker_root;
  DATA.segments.length = 0;
  data.segments.forEach((segment) => DATA.segments.push(segment));
  DATA.multi_subtitle = MULTI_SUBTITLE_UTILS.normalizeMultiSubtitle(data.multi_subtitle, DATA.segments);
  editorHistory.clear();
  updateUndoRedoButtons();
  clearSelection();
  lastActive = -1;
  if (waveformEditor) {
    waveformEditor.setLayoutData(DATA.workspace, { render: false });
    applyEditorDisplaySettings(DATA.workspace?.editorDisplay);
    restoreWorkspaceSelection();
    syncWorkspaceControls();
    waveformLoadedFromProject = waveformEditor.setPayload(DATA.waveform, { render: false });
    waveformEditor.setSpectralPayload(DATA.spectral, { render: false });
    waveformEditor.setReapeaksWaveform(DATA.waveform_reapeaks, { render: false });
  }
  updateGapRemoveUi();
  renderAll({ waveform: 'full' });
  updateUnloadedMediaLabel(DATA.media);
  FILENAME_BASE = filename.replace(/\.(json|mosp)$/i, '');
  const jsonEl = document.getElementById('json-name');
  if (jsonEl) {
    jsonEl.textContent = filename;
    jsonEl.title = `点击复制工程文件名：${filename}`;
    jsonEl.classList.remove('empty');
    jsonEl.onclick = () => copyText(filename, `已复制：${filename}`);
  }
  projectCheckpointed = true;
  configureServerSaveControls();
  scheduleAutoSave();
}

// 新建工程：浏览器原生保存对话框选择位置，页面持有句柄持续写回。
// 不再经过服务器 helper；服务器绑定的旧工程在创建成功后解除保存，避免串写。
async function createProjectCheckpoint(project, suggestedName) {
  if (projectCheckpointInFlight || projectSaveInFlight) {
    flashHint('工程正在保存，请稍候再试', 'warning');
    return false;
  }
  projectCheckpointInFlight = true;
  try {
    if (!window.showSaveFilePicker || !navigator.userActivation?.isActive) {
      // 检查点只用于确认后续导入可以继续；无用户手势时不能弹出保存对话框，
      // 直接建立内存工程检查点，后续仍通过显式导出保存。
      applyCanonicalProject(project, suggestedName);
      detachServerProjectSaving();
      return true;
    }
    const handle = await window.showSaveFilePicker({
      suggestedName,
      types: [{ description: 'MOSE 工程文件', accept: { 'application/json': ['.mosp', '.json'] } }],
    });
    const writable = await handle.createWritable();
    await writable.write(new Blob([JSON.stringify(project, null, 2)], { type: 'application/json;charset=utf-8' }));
    await writable.close();
    applyCanonicalProject(project, handle.name);
    projectFileHandle = handle;
    // detachServerProjectSaving 内部会刷新保存控件并重启自动保存。
    detachServerProjectSaving();
    return true;
  } catch (error) {
    if (error && error.name === 'AbortError') return false;  // 用户取消保存对话框
    if (error && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) {
      try {
        const saved = await downloadFile(
          JSON.stringify(project, null, 2),
          suggestedName,
          'application/json',
          { desc: 'MOSE 工程文件', types: { 'application/json': ['.mosp', '.json'] } },
          { usePicker: false },
        );
        if (saved) {
          applyCanonicalProject(project, suggestedName);
          detachServerProjectSaving();
          return true;
        }
      } catch (fallbackError) {
        flashHint(`创建工程失败：${fallbackError.message || fallbackError}`, 'warning');
        return false;
      }
    }
    flashHint(`创建工程失败：${error.message || error}`, 'warning');
    return false;
  } finally {
    projectCheckpointInFlight = false;
  }
}

// 浏览器自行管理的工程（句柄或下载创建）不能再写回服务器绑定的旧工程文件，
// 便携表情包 OTIO 也随之退回引用原始素材（服务器已不跟踪当前工程）。
function detachServerProjectSaving() {
  if (SERVER_CONFIG) {
    SERVER_CONFIG.canSave = false;
    SERVER_CONFIG.canPortableStickerExport = false;
  }
  configureServerSaveControls();
  scheduleAutoSave();
}

async function ensureProjectCheckpointForImport(file, { usePicker = true } = {}) {
  if (projectCheckpointed) return true;
  if (usePicker && window.showSaveFilePicker) {
    return createProjectCheckpoint(buildBlankProject(), suggestedProjectName(file));
  }
  // Drag/drop imports are asynchronous by the time they reach here; do not
  // open a save picker as part of importing a subtitle.
  applyCanonicalProject(buildBlankProject(), suggestedProjectName(file));
  detachServerProjectSaving();
  return true;
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

function replaceMainTrack(segments, displayName = '字幕') {
  // 导入/替换主轨是字幕编辑操作，保留替换前的主轨和多字幕状态，
  // 这样用户可以用 Ctrl(Cmd)+Z 回到替换前，而不影响后续重做。
  // 先提交当前编辑区，再替换 DATA；否则 clearSelection() 在替换后提交旧面板
  // 文本时，会把旧字幕写回新导入的同一下标，表现为“导入后又变回旧值”。
  commitCuePanelEdit();
  currentCuePanelIdx = -1;
  currentCuePanelKind = 'main';
  currentCuePanelTrackId = null;
  resetCuePanelEditState();
  pushUndo('替换字幕');
  DATA.segments.length = 0;
  (segments || []).forEach((segment) => DATA.segments.push({ ...segment }));
  DATA.multi_subtitle = {
    schema: MULTI_SUBTITLE_UTILS.MULTI_SUBTITLE_SCHEMA,
    enabled: false,
    display_mode: 'both',
    tracks: [],
    bindings: [],
  };
  MULTI_SUBTITLE_UTILS.normalizeMultiSubtitleProject(DATA);
  DATA.gap_remove = null;
  gapRemoveDirty = false;
  projectImportDirty = true;
  updateUndoRedoButtons();
  clearSelection({ commitCuePanel: false });
  lastActive = -1;
  updateGapRemoveUi();
  renderAll();
  FILENAME_BASE = displayName.replace(/\.[^.]+$/i, '');
  const jsonEl = document.getElementById('json-name');
  if (jsonEl) {
    jsonEl.textContent = `导入字幕：${displayName}`;
    jsonEl.title = 'SRT 字幕只能通过导出下载保存为工程文件';
    jsonEl.classList.add('empty');
  }
  configureServerSaveControls();
  scheduleAutoSave();
  flashHint(`已加载字幕：${displayName}（${DATA.segments.length} 条）`, 'success');
  return true;
}

const editorLoading = document.getElementById('editor-loading');
const editorLoadingLabel = document.getElementById('editor-loading-label');
const editorLoadingProgress = document.getElementById('editor-loading-progress');
const editorLoadingProgressValue = document.getElementById('editor-loading-progress-value');
let editorLoadingDepth = 0;

function updateEditorLoading(progress, label = null) {
  if (!editorLoading || editorLoadingDepth <= 0) return;
  const value = Math.max(0, Math.min(100, Math.round(Number(progress) || 0)));
  if (label) editorLoadingLabel.textContent = label;
  editorLoadingProgress.value = value;
  editorLoadingProgressValue.textContent = `${value}%`;
}

function beginEditorLoading(label, progress = 0) {
  if (!editorLoading) return () => {};
  editorLoadingDepth += 1;
  editorLoading.hidden = false;
  updateEditorLoading(progress, label);
  return () => {
    editorLoadingDepth = Math.max(0, editorLoadingDepth - 1);
    if (!editorLoadingDepth) editorLoading.hidden = true;
  };
}

async function readFileTextWithProgress(file) {
  updateEditorLoading(20, `正在读取 ${file?.name || '文件'}…`);
  return window.AsrEditorUtils.decodeSubtitleText(await file.arrayBuffer());
}

async function parseSubtitleImportFile(file) {
  const finishLoading = beginEditorLoading(`正在读取字幕 ${file.name}…`, 5);
  try {
    if (isSrtFile(file)) return parseSrtSegments(await readFileTextWithProgress(file));
    const data = JSON.parse(await readFileTextWithProgress(file));
    if (!data || !Array.isArray(data.segments)) throw new Error('缺少有效 segments 数组');
    const sourceSegments = data.segments.map((segment) => {
      const copy = {
        start: segment.start,
        end: segment.end,
        text: typeof segment.text === 'string' ? segment.text : '',
      };
      if (Array.isArray(segment.items)) {
        copy.items = segment.items.map((item) => ({ ...item }));
      }
      return copy;
    });
    window.AsrEditorUtils.normalizeSegmentTimings(sourceSegments);
    const validSegments = sourceSegments.filter((segment) => segment.text.trim());
    if (!validSegments.length) {
      throw new Error('扩展字幕没有可导入的有效文本或时间码');
    }
    return validSegments;
  } finally {
    finishLoading();
  }
}

let pendingMultiImport = null;

function closeMultiSubtitleImportModal() {
  multiSubtitleImportModal?.classList.remove('show');
  pendingMultiImport = null;
  if (multiSubtitleImportChoiceActions) multiSubtitleImportChoiceActions.hidden = false;
  if (multiSubtitleImportResultActions) multiSubtitleImportResultActions.hidden = false;
  if (multiSubtitleImportResultConfirm) multiSubtitleImportResultConfirm.disabled = true;
  [multiSubtitleImportReplace, multiSubtitleImportExtension].forEach((button) => {
    button?.setAttribute('aria-pressed', 'false');
  });
}

function renderMultiImportPreview(match = null, segments = []) {
  if (!multiSubtitleImportPreview) return;
  if (!match) {
    multiSubtitleImportPreview.hidden = true;
    multiSubtitleImportPreview.innerHTML = `<div class="summary">共 ${segments.length} 条待导入字幕</div>`;
    return;
  }
  multiSubtitleImportPreview.hidden = false;
  multiSubtitleImportPreview.innerHTML = [
    `<div class="summary">扩展字幕 ${segments.length} 条 · 自动绑定 ${match.matches.length} 条</div>`,
    `<div>未绑定 ${match.unmatchedExtension.length} 条 · 主轨未绑定 ${match.unmatchedMain.length} 条 · 冲突 ${match.conflicts} 组</div>`,
    `<div class="warning">时间容差：${match.tolerance_ms}ms。未绑定字幕会保留，可稍后手动绑定。</div>`,
  ].join('');
}

function renderMainImportPreview(pending) {
  if (!multiSubtitleImportPreview) return;
  multiSubtitleImportPreview.hidden = false;
  multiSubtitleImportPreview.innerHTML = [
    `<div class="summary">将替换当前主字幕</div>`,
    `<div>${escapeHtml(pending.file.name)} · ${pending.segments.length} 条字幕</div>`,
    '<div>导入后仍可使用撤销恢复当前字幕。</div>',
  ].join('');
}

function renderProjectImportPreview(pending) {
  if (!multiSubtitleImportPreview) return;
  const itemCount = pending.segments.reduce((count, segment) => (
    count + (Array.isArray(segment.items) ? segment.items.length : 0)
  ), 0);
  multiSubtitleImportPreview.hidden = false;
  multiSubtitleImportPreview.innerHTML = [
    `<div class="summary">工程字幕 ${pending.segments.length} 条${itemCount ? ` · 字词时间码 ${itemCount} 项` : ''}</div>`,
    `<div>${escapeHtml(pending.file.name)}</div>`,
    '<div>打开工程会替换当前工程；使用工程字幕作为副字幕只导入字幕和可选字词时间码。</div>',
  ].join('');
}

async function showMultiSubtitleImportChoice(file, segments, options = {}) {
  const existingTrack = getActiveExtensionTrack();
  const projectFile = options.projectFile || null;
  const projectImport = Boolean(projectFile);
  pendingMultiImport = {
    file,
    segments,
    existingTrackId: existingTrack?.id || null,
    match: null,
    choice: null,
    projectFile,
    projectMediaFile: options.projectMediaFile || null,
    projectImport,
  };
  if (multiSubtitleImportDescription) multiSubtitleImportDescription.textContent = '请选择你要执行的行为：';
  if (multiSubtitleImportReplace) {
    multiSubtitleImportReplace.textContent = projectImport
      ? '打开工程' : (existingTrack ? '替换扩展轨' : '替换当前字幕');
  }
  if (multiSubtitleImportExtension) {
    multiSubtitleImportExtension.hidden = projectImport ? false : Boolean(existingTrack);
    multiSubtitleImportExtension.textContent = projectImport
      ? '使用工程字幕作为副字幕' : '作为多重字幕';
  }
  if (multiSubtitleImportChoiceActions) multiSubtitleImportChoiceActions.hidden = false;
  if (multiSubtitleImportResultActions) multiSubtitleImportResultActions.hidden = false;
  if (multiSubtitleImportResultConfirm) multiSubtitleImportResultConfirm.disabled = true;
  [multiSubtitleImportReplace, multiSubtitleImportExtension].forEach((button) => {
    button?.setAttribute('aria-pressed', 'false');
  });
  if (projectImport) renderProjectImportPreview(pendingMultiImport);
  else renderMultiImportPreview(null, segments);
  multiSubtitleImportModal?.classList.add('show');
  // 工程文件必须明确选择“打开”或“作为副字幕”；SRT 保持原有默认导入路径。
  if (!projectImport) prepareMultiSubtitleImport();
  (projectImport ? multiSubtitleImportReplace
    : (existingTrack ? multiSubtitleImportReplace : multiSubtitleImportExtension))?.focus();
}

function prepareMultiSubtitleImport() {
  const pending = pendingMultiImport;
  if (!pending) return;
  pending.choice = pending.existingTrackId ? 'replace-extension' : 'extension';
  const match = MULTI_SUBTITLE_UTILS.matchSubtitleSegments(
    DATA.segments,
    pending.segments,
    MULTI_SUBTITLE_TOLERANCE_MS,
  );
  pending.match = match;
  renderMultiImportPreview(match, pending.segments);
  if (multiSubtitleImportReplace) {
    multiSubtitleImportReplace.setAttribute('aria-pressed', pending.choice === 'replace-extension' ? 'true' : 'false');
  }
  if (multiSubtitleImportExtension) {
    multiSubtitleImportExtension.setAttribute('aria-pressed', pending.choice === 'extension' ? 'true' : 'false');
  }
  if (multiSubtitleImportResultConfirm) multiSubtitleImportResultConfirm.disabled = false;
}

function commitMultiSubtitleImport() {
  const pending = pendingMultiImport;
  if (!pending) return false;
  const match = pending.match || MULTI_SUBTITLE_UTILS.matchSubtitleSegments(
    DATA.segments, pending.segments, MULTI_SUBTITLE_TOLERANCE_MS,
  );
  const multi = getMultiSubtitleState();
  const replacing = Boolean(pending.existingTrackId);
  const oldTrack = replacing ? getExtensionTrack(pending.existingTrackId) : null;
  const trackId = oldTrack?.id || MULTI_SUBTITLE_UTILS.uniqueStableSegmentId(
    multi.tracks || [], 'extension-1', 'extension',
  );
  const extensionSegments = pending.segments.map((segment, index) => ({
    ...segment,
    id: MULTI_SUBTITLE_UTILS.uniqueStableSegmentId(
      pending.segments.slice(0, index), `${trackId}-segment-${String(index + 1).padStart(3, '0')}`, `${trackId}-segment`,
    ),
    _dirty: true,
  }));
  const track = {
    id: trackId,
    role: 'extension',
    name: pending.file.name.replace(/\.[^.]+$/i, '') || '扩展字幕',
    language: '',
    source_name: pending.file.name,
    split_mode: MULTI_SUBTITLE_UTILS.detectSubtitleSplitMode(
      extensionSegments.map((segment) => segment.text).join('\n'),
    ),
    segments: extensionSegments,
  };
  pushUndo(replacing ? '替换扩展字幕' : '导入多重字幕');
  if (replacing) {
    const oldIds = new Set(oldTrack?.segments?.map((segment) => segment.id) || []);
    multi.bindings = (multi.bindings || []).filter((binding) => (
      binding.track_id !== trackId && !binding.extension_segment_ids?.some((id) => oldIds.has(id))
    ));
    const oldIndex = multi.tracks.findIndex((candidate) => candidate.id === trackId);
    if (oldIndex >= 0) multi.tracks.splice(oldIndex, 1, track);
    else multi.tracks.push(track);
  } else {
    multi.tracks = [track, ...(multi.tracks || []).filter((candidate) => candidate.id !== trackId)];
  }
  match.matches.forEach((candidate) => {
    const main = DATA.segments[candidate.mainIndex];
    const extension = extensionSegments[candidate.extensionIndex];
    if (main && extension) multi.bindings.push(
      MULTI_SUBTITLE_UTILS.buildSubtitleBinding(main, extension, trackId),
    );
  });
  multi.enabled = true;
  multi.display_mode = multi.display_mode || 'both';
  markMainSegmentsDirty(DATA.segments.filter((_, index) => match.matches.some((candidate) => candidate.mainIndex === index)));
  markMultiSubtitleDirty();
  closeMultiSubtitleImportModal();
  clearSelection();
  // 导入可能首次创建拓展 lane，必须重建波形行结构。
  renderAll({ waveform: 'full' });
  update();
  flashHint(`已导入扩展字幕：绑定 ${match.matches.length} 条，未绑定 ${match.unmatchedExtension.length} 条`, 'success');
  return true;
}

function swapMainAndExtensionSubtitles() {
  const multi = getMultiSubtitleState();
  const track = getActiveExtensionTrack();
  if (!multi.enabled) {
    flashHint('请先开启多重字幕', 'invalid');
    return false;
  }
  if ((multi.tracks || []).length !== 1) {
    flashHint('当前只支持交换唯一的扩展字幕轨', 'invalid');
    return false;
  }
  if (!track?.segments?.length || !DATA.segments.length) {
    flashHint('主字幕和扩展字幕都不能为空', 'invalid');
    return false;
  }
  pushUndo('交换主副字幕');
  const result = MULTI_SUBTITLE_UTILS.swapMainAndExtensionSubtitle(DATA, track.id);
  if (!result.swapped) {
    flashHint('交换主副字幕失败', 'warning');
    return false;
  }
  markMainSegmentsDirty(DATA.segments);
  markMultiSubtitleDirty();
  clearSelection();
  renderAll({ waveform: 'full' });
  update();
  flashHint(`已交换主副字幕：主轨 ${result.mainCount} 条，副轨 ${result.extensionCount} 条`, 'success');
  return true;
}

async function openSrtFile(file) {
  const finishLoading = beginEditorLoading(`正在读取字幕 ${file.name}…`, 5);
  try {
    const segments = parseSrtSegments(await readFileTextWithProgress(file));
    updateEditorLoading(75, `正在载入字幕 ${file.name}…`);
    if (!await ensureProjectCheckpointForImport(file)) return false;
    const imported = replaceMainTrack(segments, file.name);
    if (imported && projectSaveTargetEnabled()) await saveCurrentProject({ silent: true });
    return imported;
  } catch (error) {
    flashHint(`加载字幕失败：${error.message || error}`, 'warning');
    return false;
  } finally {
    finishLoading();
  }
}

async function openProjectFile(file, options = {}) {
  const suppressMediaPrompt = options.suppressMediaPrompt === true;
  const finishLoading = beginEditorLoading(`正在读取工程 ${file.name}…`, 5);
  try {
    const text = await readFileTextWithProgress(file);
    updateEditorLoading(60, `正在解析工程 ${file.name}…`);
    const data = JSON.parse(text);
    // 先兜底修复 0 长/倒挂时间码（保底 100ms），再校验结构，让旧工程仍能打开。
    if (data && Array.isArray(data.segments)) {
      window.AsrEditorUtils.normalizeSegmentTimings(data.segments);
      window.AsrEditorUtils.repairGroupReferenceIndices(data.segments);
      MULTI_SUBTITLE_UTILS.normalizeMultiSubtitleProject(data);
      normalizeProjectTimings(data);
    }
    if (!isMawProject(data)) {
      flashHint('打开了错误的文件，请使用 MAW 生成的工程文件。', 'warning');
      return false;
    }
    applyCanonicalProject(data, file.name);
    const expectedName = window.AsrEditorUtils.fileBasename(DATA.media);
    // 服务器版：浏览器拿不到工程真实路径，但工程记录的媒体是绝对路径。
    // 先让服务器按它定位同目录同名工程并接管（自动加载媒体、允许 Ctrl(Cmd)+S 保存）；
    // 接管失败（媒体已移动 / 同名工程缺失 / 内容不一致）再回退为手动选择媒体。
    if (expectedName && SERVER_CONFIG?.attachUrl) {
      updateEditorLoading(85, '正在连接本地编辑器服务器…');
      if (await attachProjectToServer(file.name, data)) return true;
    }
    // 工程未被服务器接管（无媒体可定位 / 接管失败）：服务器仍绑定旧工程，
    // 当前内容不能再写回它；后续保存退化为「导出工程」，直到重新经服务器打开。
    if (SERVER_CONFIG?.saveUrl) detachServerProjectSaving();
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
      : `加载失败：${error.message}`, 'warning');
    console.error(error);
    return false;
  } finally {
    finishLoading();
  }
}

document.getElementById('new-project').addEventListener('click', async () => {
  if (hasUnsavedProjectChanges()
      && !confirm('当前有未保存的改动，是否确定新建工程？将丢失未保存内容。')) return;
  await createProjectCheckpoint(buildBlankProject(), suggestedProjectName());
});

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
    flashHint('请选择一个 .mosp 或 .json 工程文件。', 'invalid');
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
  pendingSrtImportAsExtension = false;
  if (hasUnsavedProjectChanges()
      && !confirm('当前有未保存的改动，是否确定加载字幕？将替换当前字幕。')) return;
  loadSrtFileInput.value = '';
  loadSrtFileInput.click();
});

loadSrtFileInput.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  const importAsExtension = pendingSrtImportAsExtension;
  pendingSrtImportAsExtension = false;
  if (!file) return;
  if (importAsExtension) {
    try {
      const segments = await parseSubtitleImportFile(file);
      await showMultiSubtitleImportChoice(file, segments);
    } catch (error) {
      flashHint(`导入字幕失败：${error.message || error}`, 'warning');
    }
    return;
  }
  await openSrtFile(file);
});

multiSubtitleImportResultCancel?.addEventListener('click', closeMultiSubtitleImportModal);
multiSubtitleImportExtension?.addEventListener('click', prepareMultiSubtitleImport);
multiSubtitleImportReplace?.addEventListener('click', () => {
  const pending = pendingMultiImport;
  if (!pending) return;
  if (pending.projectImport) {
    pending.choice = 'open-project';
    pending.match = null;
    multiSubtitleImportReplace?.setAttribute('aria-pressed', 'true');
    multiSubtitleImportExtension?.setAttribute('aria-pressed', 'false');
    renderProjectImportPreview(pending);
    if (multiSubtitleImportResultConfirm) multiSubtitleImportResultConfirm.disabled = false;
    return;
  }
  if (pending.existingTrackId) {
    prepareMultiSubtitleImport();
    return;
  }
  pending.choice = 'replace-main';
  pending.match = null;
  if (multiSubtitleImportReplace) multiSubtitleImportReplace.setAttribute('aria-pressed', 'true');
  if (multiSubtitleImportExtension) multiSubtitleImportExtension.setAttribute('aria-pressed', 'false');
  renderMainImportPreview(pending);
  if (multiSubtitleImportResultConfirm) multiSubtitleImportResultConfirm.disabled = false;
});
multiSubtitleImportResultConfirm?.addEventListener('click', async () => {
  const pending = pendingMultiImport;
  if (!pending?.choice) return;
  if (pending.choice === 'open-project') {
    const { projectFile, projectMediaFile } = pending;
    closeMultiSubtitleImportModal();
    const opened = await openProjectFile(projectFile, { suppressMediaPrompt: Boolean(projectMediaFile) });
    if (opened && projectMediaFile) await loadMediaFile(projectMediaFile);
    return;
  }
  if (pending.choice === 'replace-main') {
    const { segments, file } = pending;
    closeMultiSubtitleImportModal();
    replaceMainTrack(segments, file.name);
    return;
  }
  commitMultiSubtitleImport();
});
multiSubtitleImportModal?.addEventListener('click', (event) => {
  if (event.target === multiSubtitleImportModal) closeMultiSubtitleImportModal();
});
multiSubtitleSplitCancel?.addEventListener('click', closeLinkedSplitModal);
multiSubtitleSplitConfirm?.addEventListener('click', confirmLinkedSplit);
multiSubtitleSplitModal?.addEventListener('click', (event) => {
  if (event.target === multiSubtitleSplitModal) closeLinkedSplitModal();
});
// 鼠标点击 lane 会自然聚焦；这里同步 keyboardLane，供失焦后的 WASD 回退使用。
multiSubtitleSplitMainText?.addEventListener('focus', () => {
  if (pendingLinkedSplit) pendingLinkedSplit.keyboardLane = 'main';
});
multiSubtitleSplitText?.addEventListener('focus', () => {
  if (pendingLinkedSplit) pendingLinkedSplit.keyboardLane = 'extension';
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !multiSubtitleImportModal?.classList.contains('show')) return;
  event.preventDefault();
  event.stopPropagation();
  closeMultiSubtitleImportModal();
}, true);
// 拆分弹窗的键盘流：Tab 切换主/副 lane，WASD 或方向键移动 ✂️，
// Space 确认/取消确认断点；捕获阶段拦截，避免触发全局的选字幕与播放快捷键。
document.addEventListener('keydown', (event) => {
  if (!multiSubtitleSplitModal?.classList.contains('show')) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeLinkedSplitModal();
    return;
  }
  const state = pendingLinkedSplit;
  if (!state) return;
  // 焦点在弹窗内原生控件（复选框/按钮）上时保留其自身键盘行为。
  const target = event.target instanceof Element ? event.target : null;
  const onNativeControl = Boolean(
    target?.closest('button, input, select, textarea, a, [contenteditable]'),
  );
  if (event.key === 'Tab' && !onNativeControl) {
    const current = splitKeyboardActiveLane(state);
    const nextLane = splitKeyboardSwitchLane(state, current);
    if (!nextLane || nextLane === current) return;
    event.preventDefault();
    event.stopPropagation();
    focusSplitLane(state, nextLane);
    return;
  }
  if (!event.repeat
      && (event.key === 'Enter' || event.key === 'b' || event.key === 'B')
      && !(event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)) {
    event.preventDefault();
    event.stopPropagation();
    confirmLinkedSplit();
    return;
  }
  if (isSpaceKey(event)) {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    if (onNativeControl || event.repeat) return;
    const lane = splitKeyboardActiveLane(state);
    if (!lane || !splitLaneVisible(lane)) return;
    event.preventDefault();
    event.stopPropagation();
    toggleSplitLaneKeyboardLock(state, lane);
    return;
  }
  const key = event.key.toLowerCase();
  const horizontal = key === 'a' || event.key === 'ArrowLeft' ? -1
    : key === 'd' || event.key === 'ArrowRight' ? 1 : 0;
  const vertical = key === 'w' || event.key === 'ArrowUp' ? -1
    : key === 's' || event.key === 'ArrowDown' ? 1 : 0;
  if (!horizontal && !vertical) return;
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
  const lane = splitKeyboardActiveLane(state);
  if (!lane) return;
  if (!splitLaneKeyboardInteractive(state, lane)) {
    // ⌚️ 时间码锚定的主轨静默忽略；Space/点击锁定的 lane 闪烁边缘并提示先解锁。
    if (!event.repeat && splitLaneLocked(state, lane)) flashSplitLaneBlockedFeedback(lane);
    return;
  }
  const nextOffset = vertical
    ? verticalSplitLaneOffset(state, lane, vertical)
    : stepSplitLaneOffset(state, lane, horizontal);
  if (!Number.isFinite(nextOffset)) return;
  event.preventDefault();
  event.stopPropagation();
  updateLinkedSplitPreview(nextOffset, lane);
}, true);

async function loadMediaFile(file) {
  if (!file) return;
  const finishLoading = beginEditorLoading(`正在加载媒体 ${file.name}…`, 5);
  try {
  stopJklReversePlayback({ render: false });
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
      newPlayer.style.cssText = 'width:100%;background:#000;display:block;';
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
    updateEditorLoading(45, `正在读取媒体信息 ${file.name}…`);
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
    flashHint(error.message || `媒体加载失败：${file.name}`, 'warning');
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
  flashHint(`已加载媒体：${file.name}`, 'success');
  if (waveformEditor && !preserveProjectWaveform) {
    try {
      DATA.spectral = null;
      DATA.waveform_reapeaks = null;
      waveformEditor.setSpectralPayload(null);
      waveformEditor.setReapeaksWaveform(null);
      updateEditorLoading(75, `正在生成波形 ${file.name}…`);
      await waveformEditor.processFile(file);
    } catch (error) {
      flashHint(error.message || String(error), 'warning');
    }
  }
  updateEditorLoading(100, `媒体加载完成：${file.name}`);
  updateGapRemoveUi();
  return true;
  } finally {
    finishLoading();
  }
}

async function loadReapeaksFile(file) {
  if (!file || !isReapeaksFile(file) || !waveformEditor) return false;
  try {
    const parsed = window.AsrWaveform.testing.decodeReapeaksFile(
      await file.arrayBuffer(),
      { name: file.name, size: file.size, modified_ms: file.lastModified },
    );
    if (!parsed?.waveform) throw new Error('无法解析 .ReaPeaks 文件或文件不包含 wave 层');
    DATA.waveform_reapeaks = parsed.waveform;
    DATA.spectral = parsed.spectral;
    waveformEditor.setReapeaksWaveform(parsed.waveform);
    waveformEditor.setSpectralPayload(parsed.spectral);
    waveformEditor.setMediaAvailable(false);
    flashHint(`已加载 ReaPeaks 缓存：${file.name}`, 'success');
    return true;
  } catch (error) {
    flashHint(`加载 ReaPeaks 失败：${error.message || error}`, 'warning');
    return false;
  }
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
  if (!pendingProjectMediaSelection && !await ensureProjectCheckpointForImport(file)) return;
  pendingProjectMediaSelection = null;
  const imported = await loadMediaFile(file);
  if (imported) {
    projectImportDirty = true;
    if (projectSaveTargetEnabled()) await saveCurrentProject({ silent: true });
  }
});

loadMediaFileInput.addEventListener('cancel', () => {
  pendingProjectMediaSelection = null;
});

// === 表情包根目录配置 ===
const stickerRootModal = document.getElementById('sticker-root-modal');
const stickerRootInput = document.getElementById('sticker-root-input');
const stickerRootRead = document.getElementById('sticker-root-read');
const stickerRootStatus = document.getElementById('sticker-root-status');
const stickerRootServerEnabled = Boolean(SERVER_CONFIG?.stickerRootUrl);
let stickerRootReturnFocus = null;
let stickerRootHintCard = null;

function setStickerRootStatus(message) {
  stickerRootStatus.textContent = message;
}

function setStickerRootModalOpen(open) {
  if (open) {
    stickerRootReturnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement : null;
    stickerRootModal.classList.add('show');
    const initialFocus = stickerRootServerEnabled
      ? stickerRootInput : document.getElementById('sticker-root-cancel');
    setTimeout(() => initialFocus.focus(), 50);
    return;
  }
  stickerRootModal.classList.remove('show');
  stickerRootReturnFocus?.focus();
  stickerRootReturnFocus = null;
}

function flashStickerRootHint(message, type) {
  stickerRootHintCard?.remove();
  stickerRootHintCard = flashHint(message, type);
}

if (!stickerRootServerEnabled) {
  stickerRootInput.disabled = true;
  stickerRootRead.disabled = true;
}

document.getElementById('sticker-root-btn').addEventListener('click', () => {
  stickerRootInput.value = STICKER_ROOT || '';
  setStickerRootStatus(stickerRootServerEnabled
    ? (STICKER_ROOT
      ? `当前路径已读取 ${Number(SERVER_CONFIG.initialStickerCount) || STICKERS.length} 张图片。可输入 Windows、macOS 或 Linux 绝对路径。`
      : '请输入绝对路径，例如 C:\\Media\\Stickers、/Users/name/Stickers 或 /home/name/Stickers。')
    : '仅 Server 编辑器可以读取和验证表情包绝对路径。');
  setStickerRootModalOpen(true);
});

document.getElementById('sticker-root-cancel').addEventListener('click', () => setStickerRootModalOpen(false));
stickerRootModal.addEventListener('click', (event) => {
  if (event.target === stickerRootModal) setStickerRootModalOpen(false);
});
stickerRootModal.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    setStickerRootModalOpen(false);
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = [...stickerRootModal.querySelectorAll('input:not(:disabled), button:not(:disabled)')];
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

stickerRootRead.addEventListener('click', async () => {
  if (!stickerRootServerEnabled || stickerRootRead.disabled) return;
  const path = stickerRootInput.value.trim();
  stickerRootHintCard?.remove();
  stickerRootHintCard = null;
  stickerRootRead.disabled = true;
  stickerRootInput.disabled = true;
  setStickerRootStatus('正在读取并验证表情包目录…');
  try {
    const response = await fetch(new URL(SERVER_CONFIG.stickerRootUrl, window.location.href), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestToken: SERVER_CONFIG.requestToken, path }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.error || `服务器返回 ${response.status}`);
    STICKERS.splice(0, STICKERS.length, ...result.stickers);
    STICKER_ROOT = result.root;
    SERVER_CONFIG.initialStickerCount = result.count;
    stickerRootInput.value = result.root;
    stickerAssetRevision += 1;
    projectImportDirty = true;
    renderAll();
    setStickerRootStatus(`路径有效，已读取 ${result.count} 张图片。`);
    flashStickerRootHint(`表情包根目录已更新，读取 ${result.count} 张图片`, 'success');
  } catch (error) {
    setStickerRootStatus(`读取失败：${error.message || error}。当前有效根目录和表情包保持不变。`);
    flashStickerRootHint(`表情包根目录读取失败：${error.message || error}`, 'warning');
  } finally {
    stickerRootRead.disabled = false;
    stickerRootInput.disabled = false;
    stickerRootInput.focus();
  }
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
    flashHint('没有匹配的内容', 'invalid');
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
  flashHint(`已修改 ${changedRows} 行`, 'success');
});

// === 表情包 ===
let stickerTargetMode = null;  // 'single' | 'multi'
let stickerTargetIdxs = [];     // 要分配的 segment indexes

function openStickerPicker(idxs, isMulti) {
  if (!STICKERS.length) {
    flashHint('没有可用的表情包，请先用🦊按钮配置表情包文件夹', 'invalid');
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
  flashHint(`已分配「${sticker.name}」`, 'success');
}

function clearStickerOnTargets() {
  pushUndo('清除表情包');
  // 一次性切除所有目标 idx，触发组拆分
  splitGroupsAtCutPoints(new Set(stickerTargetIdxs), 'sticker', 'sticker_ref');
  stickerModal.classList.remove('show');
  renderAll();
  flashHint('已清除', 'success');
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
  flashHint('已删除', 'success');
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
    flashHint('选中范围内没有表情包', 'invalid');
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
  flashHint(`已拓展到 ${sorted.length} 条`, 'success');
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
    : `已将字幕设为「${def.label}色」`, 'success');
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
  flashHint('已清除颜色', 'success');
}

// === 禁用/启用 ===
// 统一切换语义：目标全部禁用 → 全部启用；否则全部禁用
// 单条时即"切换这一条的状态"（Alt+点击 / 右键菜单均走这里）
function toggleDisabled(idxs, track = 'main') {
  const extensionTrack = track === 'extension'
    ? getActiveExtensionTrack()
    : (track?.segments ? track : null);
  const isExtension = Boolean(extensionTrack);
  const segments = isExtension ? extensionTrack.segments : DATA.segments;
  const validIdxs = [...new Set(idxs.filter((index) => Number.isInteger(index) && segments[index]))];
  if (!validIdxs.length) return;
  pushUndo('切换禁用');
  const allDisabled = validIdxs.every((index) => segments[index].disabled);
  const nextDisabled = !allDisabled;
  const boundExtensionTargets = new Map();
  validIdxs.forEach((index) => {
    segments[index].disabled = nextDisabled;
    segments[index]._dirty = true;
  });
  if (!isExtension) {
    // 主字幕是绑定关系的控制端：禁用/启用时同步同一绑定的副字幕；
    // 副字幕自身的操作不反向修改主字幕，保持它可以单独禁用。
    validIdxs.forEach((index) => {
      const binding = bindingForMainIndex(index);
      const boundTrack = binding ? getExtensionTrack(binding.track_id) : null;
      if (!boundTrack) return;
      const targets = boundExtensionTargets.get(boundTrack) || new Set();
      (binding.extension_segment_ids || []).forEach((id) => {
        const extensionIndex = boundTrack.segments.findIndex((segment) => segment?.id === id);
        if (extensionIndex < 0) return;
        const extension = boundTrack.segments[extensionIndex];
        extension.disabled = nextDisabled;
        extension._dirty = true;
        targets.add(extensionIndex);
      });
      if (targets.size) boundExtensionTargets.set(boundTrack, targets);
    });
  }
  if (isExtension || boundExtensionTargets.size) markMultiSubtitleDirty();
  renderAll();
  // 隐藏开关开启时，刚禁用的项需从选中集移除（保持状态一致）
  if (hideDisabled && !allDisabled) {
    const mainDisabled = isExtension ? new Set() : new Set(validIdxs);
    const extensionDisabled = isExtension
      ? new Map([[extensionTrack, new Set(validIdxs)]])
      : boundExtensionTargets;
    mainDisabled.forEach((index) => {
      selectedIdxs.delete(index);
      container.querySelector(`.cue[data-idx="${index}"]`)?.classList.remove('selected');
    });
    extensionDisabled.forEach((indexes) => indexes.forEach((index) => {
      selectedExtensionIdxs.delete(index);
      container.querySelectorAll(
        `.multi-cue[data-ext-idx="${index}"], .multi-extension-cue[data-ext-idx="${index}"]`,
      ).forEach((el) => el.classList.remove('selected'));
    }));
    updateMultiSelectionClasses();
    selCountEl.textContent = String(selectedIdxs.size + selectedExtensionIdxs.size);
  }
  const action = allDisabled ? '启用' : '禁用';
  const extensionCount = [...boundExtensionTargets.values()]
    .reduce((total, indexes) => total + indexes.size, 0);
  const detail = !isExtension && extensionCount
    ? `主字幕 ${validIdxs.length} 条及副字幕 ${extensionCount} 条`
    : `${validIdxs.length} 条`;
  flashHint(`已${action} ${detail}`, 'success');
  // 禁用状态同时决定当前时间的预览可见性；列表重绘不会自动触发播放头刷新。
  update();
}

// === 从波形空白处新增字幕 ===
function addExtensionRangeFromWaveform(
  requestedStart,
  requestedEnd,
  clickX,
  clickY,
  track = getActiveExtensionTrack(),
) {
  const duration = waveformEditor?.durationMs || (Number.isFinite(player.duration) ? player.duration * 1000 : 0);
  if (!duration) { flashHint('媒体时长尚未加载', 'invalid'); return; }
  if (!track?.segments) { flashHint('当前没有可用的副字幕轨', 'invalid'); return; }
  const start = Math.min(requestedStart, requestedEnd);
  const end = Math.max(requestedStart, requestedEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return;
  if (track.segments.some((segment) => start < segment.end && end > segment.start)) {
    flashHint('拖动范围包含已有副字幕，无法新增副字幕', 'warning');
    return;
  }
  const insertAt = track.segments.findIndex((segment) => segment.start > start);
  const index = insertAt < 0 ? track.segments.length : insertAt;
  const previousEnd = index > 0 ? Number(track.segments[index - 1].end) : 0;
  const nextStart = index < track.segments.length ? Number(track.segments[index].start) : duration;
  const safeStart = Math.max(previousEnd, Math.min(duration, Math.round(start / 10) * 10));
  const safeEnd = Math.min(nextStart, Math.max(safeStart, Math.round(end / 10) * 10));
  if (safeEnd - safeStart < SUBTITLE_MIN_DURATION_MS) {
    flashHint('该空白区域不足 100ms，无法新增副字幕', 'warning');
    return;
  }
  commitCuePanelEdit();
  pushUndo('新增副字幕');
  track.segments.splice(index, 0, {
    id: MULTI_SUBTITLE_UTILS.uniqueStableSegmentId(track.segments, `${track.id}-${index + 1}`, 'extension'),
    start: safeStart,
    end: safeEnd,
    text: '',
    items: [],
    _dirty: true,
  });
  markMultiSubtitleDirty();
  clearSelection({ silent: true });
  renderAll();
  selectOnlyExtension(index, track);
  const extensionText = container.querySelector(
    `.multi-extension-cue[data-ext-idx="${index}"] .multi-cue-column.extension, `
      + `.multi-dual-cue[data-ext-idx="${index}"] .multi-cue-column.extension`,
  );
  if (extensionText) {
    const cue = extensionText.closest('.cue');
    if (cue) scrollCueToCenter(cue);
    setTimeout(() => startExtensionEdit(extensionText, index, track), 0);
  }
  waveformEditor?.revealTime(safeStart, true);
  flashHint(`已新增第 ${index + 1} 条副字幕`, 'success');
}

function addCueRangeFromWaveform(requestedStart, requestedEnd, clickX, clickY, track = 'main') {
  if (track === 'extension') {
    addExtensionRangeFromWaveform(requestedStart, requestedEnd, clickX, clickY);
    return;
  }
  const duration = waveformEditor?.durationMs || (Number.isFinite(player.duration) ? player.duration * 1000 : 0);
  if (!duration) { flashHint('媒体时长尚未加载', 'invalid'); return; }
  const start = Math.min(requestedStart, requestedEnd);
  const end = Math.max(requestedStart, requestedEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return;
  if (DATA.segments.some((segment) => start < segment.end && end > segment.start)) {
    flashHint('拖动范围包含已有字幕，无法新增字幕', 'warning');
    return;
  }
  const insertAt = DATA.segments.findIndex((segment) => segment.start > start);
  const index = insertAt < 0 ? DATA.segments.length : insertAt;
  const previousEnd = index > 0 ? DATA.segments[index - 1].end : 0;
  const nextStart = index < DATA.segments.length ? DATA.segments[index].start : duration;
  const safeStart = Math.max(previousEnd, Math.min(duration, Math.round(start / 10) * 10));
  const safeEnd = Math.min(nextStart, Math.max(safeStart, Math.round(end / 10) * 10));
  if (safeEnd - safeStart < 100) {
    flashHint('该空白区域不足 100ms，无法新增字幕', 'warning');
    return;
  }
  commitCuePanelEdit();
  pushUndo('新增字幕');
  DATA.segments.splice(index, 0, {
    id: MULTI_SUBTITLE_UTILS.uniqueStableSegmentId(DATA.segments, `main-${index + 1}`, 'main'),
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
  }
  setTimeout(() => focusCuePanelText(index), 0);
  waveformEditor?.revealTime(safeStart, true);
  flashHint(`已新增第 ${index + 1} 条字幕`, 'success');
}

function addCueAtWaveformTime(timeMs, clickX, clickY) {
  const duration = waveformEditor?.durationMs || (Number.isFinite(player.duration) ? player.duration * 1000 : 0);
  if (!duration) { flashHint('媒体时长尚未加载', 'invalid'); return; }
  if (findWaveformCueAtTime(timeMs) >= 0) {
    flashHint('当前位置已有字幕，请使用“按音频位置拆分当前字幕”', 'invalid');
    return;
  }
  const insertAt = DATA.segments.findIndex((segment) => segment.start > timeMs);
  const index = insertAt < 0 ? DATA.segments.length : insertAt;
  const previousEnd = index > 0 ? DATA.segments[index - 1].end : 0;
  const nextStart = index < DATA.segments.length ? DATA.segments[index].start : duration;
  if (timeMs < previousEnd) {
    flashHint('当前位置已有字幕，请使用“按音频位置拆分当前字幕”', 'invalid');
    return;
  }
  const gap = nextStart - previousEnd;
  if (gap < 100) {
    flashHint('这里没有足够的空白区域', 'warning');
    return;
  }
  const start = Math.max(previousEnd, Math.min(Math.round(timeMs / 10) * 10, nextStart - 100));
  const end = Math.min(nextStart, start + 1000);
  const adjustedStart = end - start >= 100 ? start : Math.max(previousEnd, nextStart - 1000);
  addCueRangeFromWaveform(adjustedStart, end, clickX, clickY);
}

function addExtensionAtWaveformTime(timeMs, clickX, clickY, track = getActiveExtensionTrack()) {
  const duration = waveformEditor?.durationMs || (Number.isFinite(player.duration) ? player.duration * 1000 : 0);
  if (!duration) { flashHint('媒体时长尚未加载', 'invalid'); return; }
  if (!track || !Array.isArray(track.segments)) {
    flashHint('当前没有可用的扩展字幕轨', 'invalid');
    return;
  }
  const insertAt = track.segments.findIndex((segment) => Number(segment.start) > timeMs);
  const index = insertAt < 0 ? track.segments.length : insertAt;
  const previousEnd = index > 0 ? Number(track.segments[index - 1].end) : 0;
  const nextStart = index < track.segments.length ? Number(track.segments[index].start) : duration;
  if (timeMs < previousEnd || timeMs > nextStart) {
    flashHint('当前位置已有拓展字幕，请先调整相邻字幕时间', 'invalid');
    return;
  }
  const gap = nextStart - previousEnd;
  if (gap < 100) {
    flashHint('这里没有足够的空白区域', 'warning');
    return;
  }
  const start = Math.max(previousEnd, Math.min(Math.round(timeMs / 10) * 10, nextStart - 100));
  const end = Math.min(nextStart, start + 1000);
  const adjustedStart = end - start >= 100 ? start : Math.max(previousEnd, nextStart - 1000);
  if (end - adjustedStart < 100) {
    flashHint('这里没有足够的空白区域', 'warning');
    return;
  }
  pushUndo('新增拓展字幕');
  const segment = {
    id: MULTI_SUBTITLE_UTILS.uniqueStableSegmentId(
      track.segments,
      `${track.id}-segment-${index + 1}`,
      'extension',
    ),
    start: adjustedStart,
    end,
    text: '',
    _dirty: true,
  };
  track.segments.splice(index, 0, segment);
  markMultiSubtitleDirty();
  clearSelection();
  renderAll();
  selectOnlyExtension(index);
  const extensionText = container.querySelector(
    `.multi-extension-cue[data-ext-idx="${index}"] .multi-cue-column.extension, `
      + `.multi-dual-cue[data-ext-idx="${index}"] .multi-cue-column.extension`,
  );
  if (extensionText) {
    const cue = extensionText.closest('.cue');
    if (cue) scrollCueToCenter(cue);
    setTimeout(() => startExtensionEdit(extensionText, index, track), 0);
  }
  waveformEditor?.revealTime(adjustedStart, true);
  flashHint(`已新增第 ${index + 1} 条拓展字幕`, 'success');
}

function getBoundDragTarget(index, sourceSegments) {
  const source = sourceSegments[index];
  if (!source) return null;
  const binding = bindingForMainIndex(index);
  if (!binding) return null;
  const target = extensionSegmentById(binding.extension_segment_ids?.[0], getExtensionTrack(binding.track_id));
  return target ? { target, binding } : null;
}

function ensureBoundDragOriginal(drag, index, target) {
  if (!drag.boundOriginals) drag.boundOriginals = new Map();
  if (!drag.boundOriginals.has(index)) {
    drag.boundOriginals.set(index, {
      target,
      start: target.start,
      end: target.end,
      items: Array.isArray(target.items)
        ? target.items.map((item) => ({ ...item })) : target.items,
    });
  }
  return drag.boundOriginals.get(index);
}

function snapshotBoundDragTrack(track) {
  return {
    track,
    segments: (track?.segments || []).map((segment) => ({
      segment,
      start: segment.start,
      end: segment.end,
      items: Array.isArray(segment.items)
        ? segment.items.map((item) => ({ ...item })) : segment.items,
    })),
    dirty: track?._dirty,
  };
}

// Alt 主字幕拖动中的副字幕挤压是临时预览：同一次拖动把主字幕拉回去时，
// 副字幕轨也必须从拖动开始时的完整快照恢复，而不能只恢复当前绑定的跟随字幕。
function ensureBoundDragTimelineOriginals(drag) {
  if (drag?.track !== 'main' || drag.boundDragTimelineOriginals) return;
  const multi = getMultiSubtitleState();
  drag.boundDragTimelineOriginals = {
    tracks: (multi.tracks || []).map((track) => snapshotBoundDragTrack(track)),
    bindings: JSON.parse(JSON.stringify(multi.bindings || [])),
  };
}

function restoreBoundDragTimelineOriginals(drag) {
  const snapshot = drag?.boundDragTimelineOriginals;
  if (!snapshot) return;
  snapshot.tracks.forEach(({ track, segments, dirty }) => {
    if (!track) return;
    track.segments = segments.map((entry) => {
      entry.segment.start = entry.start;
      entry.segment.end = entry.end;
      entry.segment.items = Array.isArray(entry.items)
        ? entry.items.map((item) => ({ ...item })) : entry.items;
      return entry.segment;
    });
    track._dirty = track._dirty || dirty;
  });
  const multi = getMultiSubtitleState();
  multi.bindings = JSON.parse(JSON.stringify(snapshot.bindings));
  syncBindingOffsets();
}

function getBoundDragEdge(drag, index) {
  if (drag.kind === 'move') return { mode: 'move', edge: null };
  if (drag.kind === 'resize-left') return { mode: 'edge', edge: 'start' };
  if (drag.kind === 'resize-right') return { mode: 'edge', edge: 'end' };
  if (drag.kind === 'resize-boundary') {
    return { mode: 'edge', edge: index === drag.index ? 'end' : 'start' };
  }
  if (drag.kind === 'resize-boundary-independent') {
    return { mode: 'edge', edge: drag.edge };
  }
  return null;
}

function syncBoundCueDrag(drag) {
  // 副字幕拖动只调整副字幕自身；绑定关系保留，但新的时间范围通过
  // binding offset 记录，不再反向改动主字幕或被主字幕轨道边界限制。
  // 主字幕即使因为“自动吸附调整相邻字幕”关闭而走
  // resize-boundary-independent，也仍需带着绑定副字幕一起调整。
  if (!drag || drag.track !== 'main' || !multiSubtitleVisible()) return;
  ensureBoundDragTimelineOriginals(drag);
  if (drag.allowSqueeze) restoreBoundDragTimelineOriginals(drag);
  const sourceSegments = DATA.segments;
  if (!drag.boundOriginals) drag.boundOriginals = new Map();

  const boundEntries = drag.indices.map((index) => ({
    index,
    bound: getBoundDragTarget(index, sourceSegments),
    sourceOriginal: drag.originals.get(index),
  })).filter((entry) => entry.bound && entry.sourceOriginal);
  const movedFollowerSegments = new Set(boundEntries.map((entry) => entry.bound.target));
  boundEntries.forEach(({ index, bound, sourceOriginal }) => {
    const { target, binding } = bound;
    const targetOriginal = ensureBoundDragOriginal(drag, index, target);
    const source = sourceSegments[index];
    let nextStart = targetOriginal.start;
    let nextEnd = targetOriginal.end;
    if (drag.kind === 'move') {
      const delta = source.start - sourceOriginal.start;
      nextStart = targetOriginal.start + delta;
      nextEnd = targetOriginal.end + delta;
    } else if (drag.kind === 'resize-left') {
      nextStart = targetOriginal.start + (source.start - sourceOriginal.start);
    } else if (drag.kind === 'resize-right') {
      nextEnd = targetOriginal.end + (source.end - sourceOriginal.end);
    } else if (drag.kind === 'resize-boundary') {
      if (index === drag.index) nextEnd = targetOriginal.end + (source.end - sourceOriginal.end);
      else nextStart = targetOriginal.start + (source.start - sourceOriginal.start);
    } else if (drag.kind === 'resize-boundary-independent') {
      if (drag.edge === 'start') nextStart = targetOriginal.start + (source.start - sourceOriginal.start);
      else nextEnd = targetOriginal.end + (source.end - sourceOriginal.end);
    }
    if (nextEnd <= nextStart) nextEnd = nextStart + SUBTITLE_MIN_DURATION_MS;

    const targetTrack = getExtensionTrack(binding.track_id);
    const dragEdge = getBoundDragEdge(drag, index);
    const resolved = resolveExtensionFollowerRange(
      target,
      nextStart,
      nextEnd,
      dragEdge?.mode === 'edge' ? dragEdge.edge : dragEdge?.mode,
      targetTrack,
      movedFollowerSegments,
      { sortSegments: false },
    );
    if (resolved.squeezedCount > 0 || resolved.removedCount > 0) {
      const details = [];
      if (resolved.squeezedCount) details.push(`挤压 ${resolved.squeezedCount} 条副字幕`);
      if (resolved.removedCount) details.push(`删除 ${resolved.removedCount} 条副字幕`);
      notifyBoundSyncWarning(
        drag,
        `副字幕发生冲突，已${details.join('，')}${resolved.unboundCount ? '并解除绑定' : ''}`,
      );
    }
    target.start = resolved.start;
    target.end = resolved.end;
    target.items = remapPanelItems(
      targetOriginal.items,
      targetOriginal.start,
      targetOriginal.end,
      target.start,
      target.end,
    );
    target._dirty = true;
  });
  syncBindingOffsets();
}

function findWaveformCueAtTime(timeMs, segments = DATA.segments) {
  const time = Number(timeMs);
  if (!Number.isFinite(time)) return -1;
  const list = Array.isArray(segments) ? segments : DATA.segments;
  return list.findIndex((segment) => {
    const start = Number(segment?.start);
    const end = Number(segment?.end);
    return Number.isFinite(start) && Number.isFinite(end) && start < time && time < end;
  });
}

// 右键波形背景：创建字幕，或按右键对应的音频位置拆分命中的字幕。
function showWaveformBlankMenu(timeMs, clickX, clickY, track = 'main') {
  ctxmenu.innerHTML = '';
  // 空白波形按鼠标实际落入的 lane 决定创建轨道；但拆分动作按时间点上
  // 实际存在的两条轨道分别展示，避免用户为了拆副字幕必须先点到副轨空白。
  const effectiveTrack = track === 'extension' ? 'extension' : 'main';
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
  const mainIdx = findWaveformCueAtTime(timeMs, DATA.segments);
  const extensionTrack = getActiveExtensionTrack();
  const extensionIdx = findWaveformCueAtTime(timeMs, extensionTrack?.segments);
  if (effectiveTrack === 'extension') {
    addItem(
      '创建副字幕',
      '',
      () => addExtensionAtWaveformTime(timeMs, clickX, clickY, extensionTrack),
      extensionIdx >= 0,
    );
  } else {
    addItem(
      '创建字幕',
      '',
      () => addCueAtWaveformTime(timeMs, clickX, clickY),
      mainIdx >= 0,
    );
  }
  if (Array.isArray(DATA.segments) && DATA.segments.length) {
    addItem(
      '按音频位置拆分主字幕',
      'B',
      () => splitFromContextMenu(mainIdx, clickX, clickY, timeMs),
      mainIdx < 0,
    );
  }
  if (Array.isArray(extensionTrack?.segments) && extensionTrack.segments.length) {
    addItem(
      '按音频位置拆分副字幕',
      '',
      () => openExtensionSplitModal(extensionIdx, timeMs, extensionTrack),
      extensionIdx < 0,
    );
  }

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
        flashHint('已删除', 'success');
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
    if (bindingForMainIndex(idx)) {
      addItem('解绑', 'Shift+G', () => {
        selectOnly(idx);
        unbindSelectedSubtitlePair();
      });
    }
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

function showExtensionContextMenu(x, y, index, timeMs = null, track = getActiveExtensionTrack()) {
  const segment = track?.segments?.[index];
  if (!segment) return;
  ctxmenu.innerHTML = '';
  const addItem = (label, fn, danger = false, disabled = false, kbd = '') => {
    const item = document.createElement('div');
    item.className = `item${danger ? ' danger' : ''}${disabled ? ' disabled' : ''}`;
    const text = document.createElement('span');
    text.textContent = label;
    item.appendChild(text);
    const key = document.createElement('kbd');
    key.textContent = kbd;
    if (!kbd) key.style.visibility = 'hidden';
    item.appendChild(key);
    if (disabled) {
      item.setAttribute('aria-disabled', 'true');
      item.title = '请先解绑当前扩展字幕';
    } else item.addEventListener('click', () => {
      ctxmenu.classList.remove('show');
      fn();
    });
    ctxmenu.appendChild(item);
  };
  const binding = bindingForExtensionIndex(index, track);
  addItem('在鼠标位置拆分', () => openExtensionSplitModal(index, timeMs, track), false, false, 'B');
  const extensionSelectionOnly = selectedExtensionIdxs.size > 1
    && selectedExtensionIdxs.has(index);
  addItem(
    '合并副字幕块',
    () => mergeExtensionSegments([...selectedExtensionIdxs], track),
    false,
    !extensionSelectionOnly,
    'C',
  );
  addItem(
    segment.disabled ? '启用副字幕' : '禁用副字幕',
    () => toggleDisabled([index], track),
    false,
    false,
    'Alt+点击',
  );
  addItem('删除扩展字幕', () => deleteExtensionSegments([index]), true);
  if (binding) addItem('对齐主字幕时间范围', () => alignExtensionToMainTimeRange(index, track), false, false, 'H');
  if (binding) addItem('解绑', () => {
    selectOnlyExtension(index);
    unbindSelectedSubtitlePair();
  }, false, false, 'Shift+G');
  if (binding) {
    // 一对一关系已经存在时，必须先解绑，避免用户误以为点击后会静默换绑。
    addItem('重新绑定需先解绑', null, false, true);
  } else {
    if (selectedIdxs.size === 1) {
      addItem('与选中的主字幕绑定', () => {
        // 右键不会触发扩展字幕的普通 pointerdown；先补上扩展选择，
        // 再复用顶部「绑定」操作。这里是用户明确保留主字幕后发起的绑定，
        // 因此保留主字幕选区，作为有意的直接绑定/替换入口。
        selectOnlyExtension(index, track, true, true);
        bindSelectedSubtitlePair();
      }, false, false, 'G');
    }
    // 即使当前还保留着一条主字幕选区，也保留自动匹配入口，方便按时间
    // 选择最早的未绑定主字幕；明确绑定选中项则使用上面的入口。
    addItem('绑定到主字幕', () => beginPendingExtensionBinding(index, track), false, false, 'G');
  }
  ctxmenu.classList.add('show');
  const rect = ctxmenu.getBoundingClientRect();
  ctxmenu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`;
  ctxmenu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`;
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
    flashHint('媒体尚不可 seek；请等待加载完成或用 file:// 直接打开 HTML', 'warning');
  }
  try {
    player.currentTime = Math.max(0, timeSec);
    update();
    // currentTime 的 seeked/timeupdate 事件是异步触发的；先同步刷新波形，
    // 避免字幕已选中但红色播放头要等下一拍才移动。
    waveformEditor?.updatePlayback();
  } catch (error) {
    flashHint(`跳转失败：${error.message}`, 'warning');
  }
}

function initWaveformEditor() {
  if (!window.AsrWaveform) {
    flashHint('波形模块加载失败，字幕编辑仍可使用', 'warning');
    return;
  }
  waveformEditor = window.AsrWaveform.create({
    getSegments: (track = 'main') => track === 'extension'
      ? (getActiveExtensionTrack()?.segments || []) : DATA.segments,
    getExtensionSegments: (trackId = null) => getExtensionTrack(trackId)?.segments || [],
    getCrossTrackSnapTargets: (track = 'main') => {
      if (!multiSubtitleVisible() || !EDITOR_SETTINGS.crossTrackSnap) return [];
      const otherSegments = track === 'extension'
        ? DATA.segments : (getActiveExtensionTrack()?.segments || []);
      return otherSegments.flatMap((segment) => [segment?.start, segment?.end])
        .filter((timeMs) => Number.isFinite(Number(timeMs)))
        .map((timeMs) => Number(timeMs));
    },
    getSelection: (track = 'main') => track === 'extension' ? selectedExtensionIdxs : selectedIdxs,
    getExtensionSelection: () => selectedExtensionIdxs,
    getBindingMarkerTargets,
    multiSubtitleVisible: () => multiSubtitleVisible(),
    // 波形上已经选中的块不会再次调用 selectCue；单独提供激活回调，
    // 避免联动选中主副字幕后点击另一条字幕时编辑区不切换。
    activateCue: (idx) => setCurrentCuePanelIndex(idx),
    enterCueEditor: (idx) => {
      setCurrentCuePanelIndex(idx);
      focusCuePanelText(idx, 'main');
    },
    activateExtensionCue: (idx) => {
      setCurrentCuePanelExtensionIndex(idx, getActiveExtensionTrack());
    },
    enterExtensionCueEditor: (idx) => {
      setCurrentCuePanelExtensionIndex(idx, getActiveExtensionTrack());
      focusCuePanelText(idx, 'extension');
    },
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
    selectExtensionCue: (idx) => {
      selectOnlyExtension(idx);
      lastClickedExtensionIdx = idx;
    },
    toggleExtensionSelection: (idx) => {
      toggleExtensionSelection(idx, getActiveExtensionTrack());
      lastClickedExtensionIdx = idx;
    },
    selectExtensionRange: (idx) => {
      if (lastClickedExtensionIdx >= 0) selectExtensionRange(lastClickedExtensionIdx, idx);
      else selectOnlyExtension(idx);
      lastClickedExtensionIdx = idx;
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
    addExtensionSelection: (idxs) => {
      const track = getActiveExtensionTrack();
      idxs.forEach((idx) => addExtensionToSelection(idx, track));
    },
    seek: seekFromWaveform,
    togglePlayback,
    toggleDisabled: (idxs, track = 'main') => toggleDisabled(idxs, track),
    getHideDisabled: () => hideDisabled,
    getGapRemoveGaps,
    getGapOperationMode: getGapRemoveOperationMode,
    toggleGapRemoved,
    applyGapRange: applyManualGapRange,
    resizeGapBoundary: resizeManualGapBoundary,
    previewGapAt,
    showGapContextMenu: (x, y, index) => showGapContextMenu(x, y, index),
    showContextMenu: (x, y, idx, timeMs) => showContextMenu(x, y, idx, timeMs),
    showExtensionContextMenu: (x, y, idx, timeMs) => showExtensionContextMenu(x, y, idx, timeMs),
    showBlankWaveformMenu: (timeMs, x, y, track) => showWaveformBlankMenu(timeMs, x, y, track),
    addCueRange: (startMs, endMs, x, y, track = 'main') => (
      addCueRangeFromWaveform(startMs, endMs, x, y, track)
    ),
    onCueCreateRejected: (reason) => {
      if (reason === 'too-short') flashHint('该空白区域不足 100ms，无法新增字幕', 'warning');
      if (reason === 'occupied') flashHint('该位置已有字幕，无法新增字幕', 'warning');
    },
    // 剃刀工具：在波形指针位置安全拆分字幕。复用右键菜单的波形时间拆分路径；
    // 有可靠主轨字词时间码时沿用字词锚点，否则在弹窗中保留指针的绝对切点。
    splitCueAtTime: (idx, timeMs) => splitFromContextMenu(idx, 0, 0, timeMs),
    getClickBehavior: () => EDITOR_SETTINGS.clickBehavior,
    getClickTarget: () => EDITOR_SETTINGS.clickTarget,
    getAutoSnapAdjacentCues: () => EDITOR_SETTINGS.autoSnapAdjacentCues,
    getWaveShapeSource: () => EDITOR_SETTINGS.waveShapeSource,
    showTrackBadges: () => EDITOR_SETTINGS.multiSubtitleShowTrackBadges,
    onBeginEdit: (label) => pushUndo(label),
    syncBoundCueDrag,
    onLayoutUndo: (label, snapshot) => pushLayoutUndo(label, snapshot),
    onCommitEdit: (idxs, kind, track = 'main', independent = false, details = null) => {
      let linkedChanged = false;
      if (kind === 'resize-boundary-pointer' && track === 'main' && !independent) {
        const targetIndex = Number.isInteger(details?.targetIndex) ? details.targetIndex : idxs[0];
        const main = DATA.segments[targetIndex];
        const original = details?.original;
        if (main && original) {
          linkedChanged = syncBoundExtensionForMain(main, {
            oldStart: original.start,
            oldEnd: original.end,
            edge: details.edge,
            mode: 'range',
          });
        }
      }
      syncTimelineGroupRanges();
      // 拖动预览期间保持下标稳定；提交时再整理副轨数组，避免冲突裁剪后
      // 原本位于目标前面的字幕保留右侧区间而落到目标之后，保存时违反顺序契约。
      if (multiSubtitleVisible()) sortExtensionTrackSegments(getActiveExtensionTrack());
      syncBindingOffsets();
      markMainSegmentsDirty(track === 'main' ? idxs.map((idx) => DATA.segments[idx]).filter(Boolean) : []);
      if (linkedChanged || multiSubtitleVisible() || track === 'extension') markMultiSubtitleDirty();
      renderAll();
      update();
      flashHint(kind === 'move'
        ? track === 'extension'
          ? `已移动 ${idxs.length} 条副字幕`
          : `已${independent ? '独立' : '联动'}移动 ${idxs.length} 条字幕`
        : kind === 'resize-boundary-pointer'
          ? `已将${track === 'extension' ? '副字幕' : '字幕'}${details?.edge === 'start' ? '起点' : '终点'}定位到鼠标位置`
        : kind === 'resize-boundary'
          ? `已${independent ? '独立' : '联动'}调整第 ${idxs[0] + 1} / ${idxs[1] + 1} 条边界`
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
  waveformEditor.setLayoutData(DATA.workspace || null, { render: false });
  applyEditorDisplaySettings(DATA.workspace?.editorDisplay);
  waveformEditor.setSpectralPayload(DATA.spectral || null, { render: false });
  waveformEditor.setReapeaksWaveform(DATA.waveform_reapeaks || null, { render: false });
  waveformLoadedFromProject = waveformEditor.setPayload(DATA.waveform || null, { render: false });
}

async function loadDeferredReapeaks() {
  const url = SERVER_CONFIG?.waveformUrl;
  if (!url || !waveformEditor) return;
  try {
    const response = await fetch(url, { cache: 'no-store' });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok !== true) throw new Error(result.error || `服务器返回 ${response.status}`);
    if (result.status === 'loading' || result.status === 'pending') {
      window.setTimeout(() => { void loadDeferredReapeaks(); }, 500);
      return;
    }
    if (result.status !== 'ready') return;
    const hasPayload = Boolean(result.spectral || result.waveform_reapeaks);
    if (!hasPayload) return;
    DATA.spectral = result.spectral || null;
    DATA.waveform_reapeaks = result.waveform_reapeaks || null;
    waveformEditor.setSpectralPayload(DATA.spectral, { render: false });
    waveformEditor.setReapeaksWaveform(DATA.waveform_reapeaks, { render: false });
    renderAll({ waveform: 'full' });
  } catch (_error) {
    window.setTimeout(() => { void loadDeferredReapeaks(); }, 1000);
  }
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
  const finishLoading = beginEditorLoading('正在处理拖入文件…', 2);
  try {
  const mediaFile = files.find(isMediaFile);
  const reapeaksFile = files.find(isReapeaksFile);
  const jsonFile = files.find(isJsonFile);
  const srtFile = files.find(isSrtFile);
  let stagedSrtSegments = null;
  if (!mediaFile && !reapeaksFile && !jsonFile && !srtFile) {
    flashHint('不支持的文件类型（仅支持视频 / 音频 / JSON / SRT / ReaPeaks）', 'warning');
    return;
  }
  if (jsonFile) {
    if (DATA.segments.length > 0) {
      if (hasUnsavedProjectChanges()
          && !confirm('当前有未保存的改动，是否继续处理此工程文件？选择“打开工程”仍会替换当前工程。')) return;
      try {
        const segments = await parseSubtitleImportFile(jsonFile);
        await showMultiSubtitleImportChoice(jsonFile, segments, {
          projectFile: jsonFile,
          projectMediaFile: mediaFile,
        });
      } catch (error) {
        flashHint(`导入工程字幕失败：${error.message || error}`, 'warning');
      }
      return;
    }
    // 工程与媒体一起拖入时，媒体随工程自动加载，不再弹窗要求重选。
    const opened = await openProjectFile(jsonFile, { suppressMediaPrompt: Boolean(mediaFile) });
    if (opened && mediaFile) await loadMediaFile(mediaFile);
    return;
  }
  if (reapeaksFile && !mediaFile && !srtFile) {
    await loadReapeaksFile(reapeaksFile);
    return;
  }
  if (srtFile && DATA.segments.length === 0) {
    try {
      stagedSrtSegments = parseSrtSegments(await readFileTextWithProgress(srtFile));
    } catch (error) {
      flashHint(`导入字幕失败：${error.message || error}`, 'warning');
      return;
    }
  }
  if ((mediaFile || srtFile) && !await ensureProjectCheckpointForImport(mediaFile || srtFile, { usePicker: false })) return;
  if (mediaFile) {
    const imported = await loadMediaFile(mediaFile);
    if (imported) projectImportDirty = true;
  }
  if (reapeaksFile) await loadReapeaksFile(reapeaksFile);
  if (srtFile) {
    if (DATA.segments.length > 0) {
      try {
        const segments = await parseSubtitleImportFile(srtFile);
        await showMultiSubtitleImportChoice(srtFile, segments);
      } catch (error) {
        flashHint(`导入字幕失败：${error.message || error}`, 'warning');
      }
    } else {
      replaceMainTrack(stagedSrtSegments, srtFile.name);
    }
  }
  if ((mediaFile || srtFile) && projectSaveTargetEnabled()) await saveCurrentProject({ silent: true });
  updateEditorLoading(100, '文件加载完成');
  } finally {
    finishLoading();
  }
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
const repairedTimingCount = normalizeProjectTimings(DATA);
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
window.MAWE?.register('editor-bridge', () => window.MAWE_EDITOR_BRIDGE);
renderAll({ waveform: 'full' });
updateGapRemoveUi();
if (repairedTimingCount > 0) {
  flashHint(`已自动修复 ${repairedTimingCount} 处异常时间码（保底 100ms）`, 'warning');
} else if (repairedGroupReferenceCount > 0) {
  flashHint(`已自动修复 ${repairedGroupReferenceCount} 处分组引用`, 'warning');
}
if (SERVER_CONFIG?.autoLoadedMediaName) {
  flashHint(`已自动加载媒体：${SERVER_CONFIG.autoLoadedMediaName}`, 'success');
}
void loadDeferredReapeaks();

document.getElementById('filter-over').addEventListener('click', (e) => {
  e.currentTarget.classList.toggle('active');
  if (!e.currentTarget.classList.contains('active')) {
    clearTemporaryVisibleSplitCues();
  }
  applySearch(searchEl.value);
});

// 「隐藏禁用项」开关：开启后禁用项 display:none，并从选中集移除
hideDisabledToggle.addEventListener('change', () => {
  hideDisabled = hideDisabledToggle.checked;
  updateEditorSettings({ cueListHideDisabled: hideDisabled });
  container.classList.toggle('hide-disabled', hideDisabled);
  if (hideDisabled) {
    // 清理选中集中的禁用项（隐藏了但还留在选中集会造成状态不一致）
    [...selectedIdxs].forEach(i => {
      if (DATA.segments[i]?.disabled) {
        selectedIdxs.delete(i);
        const el = container.querySelector(`.cue[data-idx="${i}"]`);
        if (el) el.classList.remove('selected');
      }
    });
    const extensionTrack = getActiveExtensionTrack();
    [...selectedExtensionIdxs].forEach((index) => {
      if (extensionTrack?.segments[index]?.disabled) selectedExtensionIdxs.delete(index);
    });
    updateMultiSelectionClasses();
    selCountEl.textContent = String(selectedIdxs.size + selectedExtensionIdxs.size);
    if (waveformEditor) waveformEditor.updateSelection();
  }
  if (waveformEditor) waveformEditor.updateDisabledVisibility();
});

// 离开提示
window.addEventListener('beforeunload', (e) => {
  if (hasUnsavedProjectChanges()) { e.preventDefault(); e.returnValue = ''; }
});
